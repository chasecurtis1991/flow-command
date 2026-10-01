//! Edit an order's note and tags.
//!
//! Tags go through `tagsAdd` / `tagsRemove`, so tags nobody touched (or that another app added meanwhile) are never
//! dropped. The note is a whole-field replace (`orderUpdate`), so Rust re-reads it first and refuses if it no longer
//! matches what the user reviewed. Every write is idempotent, so retrying after a network error is safe. The order is
//! re-read at the end and Shopify's values are returned.

use serde::{Deserialize, Serialize};

const MAX_NOTE: usize = 5_000;
const MAX_TAG: usize = 255;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagsRequest {
    pub store_id: String,
    pub order_id: String,
    /// Some = replace the note with this (empty clears it); None = leave the note alone.
    pub note: Option<String>,
    /// The note the user was editing from (None = no note); the write is refused if Shopify's differs.
    pub expected_note: Option<String>,
    #[serde(default)]
    pub add_tags: Vec<String>,
    #[serde(default)]
    pub remove_tags: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteTags {
    pub note: Option<String>,
    pub tags: Vec<String>,
}

fn clean_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        if t.contains(',') {
            return Err(format!("Tag \"{t}\" contains a comma — add tags one at a time."));
        }
        if t.chars().count() > MAX_TAG {
            return Err(format!("Tag is over {MAX_TAG} characters."));
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

/// Shopify returns "" for a cleared note; treat blank and missing as the same.
fn norm(note: Option<&str>) -> Option<String> {
    note.map(str::trim_end).filter(|s| !s.trim().is_empty()).map(String::from)
}

fn validate(r: &NoteTagsRequest) -> Result<(Vec<String>, Vec<String>), String> {
    if !r.order_id.starts_with("gid://shopify/Order/") {
        return Err("Missing order id.".into());
    }
    if r.note.as_deref().is_some_and(|n| n.chars().count() > MAX_NOTE) {
        return Err(format!("Note is over {MAX_NOTE} characters."));
    }
    let add = clean_tags(&r.add_tags)?;
    let remove = clean_tags(&r.remove_tags)?;
    if add.iter().any(|a| remove.iter().any(|b| a.eq_ignore_ascii_case(b))) {
        return Err("The same tag can't be added and removed at once.".into());
    }
    if r.note.is_none() && add.is_empty() && remove.is_empty() {
        return Err("Nothing to change.".into());
    }
    Ok((add, remove))
}

fn user_error(resp: &serde_json::Value, op: &str) -> Option<String> {
    let first = resp["data"][op]["userErrors"].as_array()?.first()?;
    Some(first["message"].as_str().unwrap_or("Shopify rejected the change").to_string())
}

fn parse_note_tags(resp: &serde_json::Value) -> Option<NoteTags> {
    let o = &resp["data"]["order"];
    if o.is_null() {
        return None;
    }
    Some(NoteTags {
        note: norm(o["note"].as_str()),
        tags: o["tags"].as_array()?.iter().filter_map(|t| t.as_str().map(String::from)).collect(),
    })
}

const READ: &str = "query O($id: ID!) { order(id: $id) { id note tags } }";
const NOTE: &str = "mutation Note($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }";
const ADD: &str = "mutation Add($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }";
const REMOVE: &str = "mutation Rm($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } } }";

async fn read(domain: &str, id: &str) -> Result<NoteTags, String> {
    let resp = crate::graphql_request(domain, READ, Some(serde_json::json!({ "id": id }))).await?;
    parse_note_tags(&resp).ok_or_else(|| "Order not found.".to_string())
}

async fn write(domain: &str, query: &str, op: &str, vars: serde_json::Value) -> Result<(), String> {
    let resp = crate::graphql_request(domain, query, Some(vars))
        .await
        .map_err(|e| crate::scope_denied(e, domain, "write_orders", "order write"))?;
    match user_error(&resp, op) {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn update_order_note_tags(request: NoteTagsRequest) -> Result<NoteTags, String> {
    let (add, remove) = validate(&request)?;
    let domain = crate::store_by_id(&request.store_id)?.domain;
    let id = request.order_id.as_str();

    if let Some(note) = &request.note {
        // ponytail: read-then-write leaves a sub-second race; Shopify has no compare-and-swap for order notes.
        let current = read(&domain, id).await?;
        if current.note != norm(request.expected_note.as_deref()) {
            return Err("The note changed in Shopify since this order was loaded — reload the order and review again.".into());
        }
        if current.note != norm(Some(note)) {
            write(&domain, NOTE, "orderUpdate", serde_json::json!({ "input": { "id": id, "note": note.trim_end() } })).await?;
        }
    }
    if !add.is_empty() {
        write(&domain, ADD, "tagsAdd", serde_json::json!({ "id": id, "tags": add })).await?;
    }
    if !remove.is_empty() {
        write(&domain, REMOVE, "tagsRemove", serde_json::json!({ "id": id, "tags": remove })).await?;
    }
    read(&domain, id)
        .await
        .map_err(|e| format!("Saved, but re-reading the order failed — reload it to see the result. ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> NoteTagsRequest {
        NoteTagsRequest {
            store_id: "retail".into(),
            order_id: "gid://shopify/Order/1".into(),
            note: None,
            expected_note: None,
            add_tags: vec![],
            remove_tags: vec![],
        }
    }

    #[test]
    fn validate_and_clean() {
        assert!(validate(&req()).is_err()); // nothing to change
        let (add, _) = validate(&NoteTagsRequest { add_tags: vec![" Flagged ".into(), "flagged".into(), "".into()], ..req() }).unwrap();
        assert_eq!(add, vec!["Flagged"]);
        assert!(validate(&NoteTagsRequest { add_tags: vec!["a,b".into()], ..req() }).is_err());
        assert!(validate(&NoteTagsRequest { add_tags: vec!["x".into()], remove_tags: vec!["X".into()], ..req() }).is_err());
        assert!(validate(&NoteTagsRequest { note: Some("x".repeat(MAX_NOTE + 1)), ..req() }).is_err());
        assert!(validate(&NoteTagsRequest { note: Some(String::new()), ..req() }).is_ok()); // clearing is a change
        assert!(validate(&NoteTagsRequest { order_id: "1".into(), add_tags: vec!["x".into()], ..req() }).is_err());
    }

    #[test]
    fn parses_order_and_errors() {
        let r = serde_json::json!({"data": {"order": {"id": "x", "note": "  ", "tags": ["vip", "wholesale"]}}});
        assert_eq!(parse_note_tags(&r), Some(NoteTags { note: None, tags: vec!["vip".into(), "wholesale".into()] }));
        assert_eq!(norm(Some("check slip\n")), Some("check slip".into()));
        let e = serde_json::json!({"data": {"tagsAdd": {"node": null, "userErrors": [{"field": ["tags"], "message": "Tag too long"}]}}});
        assert_eq!(user_error(&e, "tagsAdd").as_deref(), Some("Tag too long"));
        assert_eq!(user_error(&serde_json::json!({"data": {"tagsAdd": {"userErrors": []}}}), "tagsAdd"), None);
    }
}

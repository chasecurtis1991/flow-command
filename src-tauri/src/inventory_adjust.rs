//! Relative stock changes (`inventoryAdjustQuantities` on `available`): one-line Adjust, multi-line Receive, and
//! Transfer (a −N at the source and +N at the destination for each item). All lines of a request go in ONE mutation,
//! so Shopify applies all of them or none.
//!
//! Safety rails: the store is explicit (never the mutable active store), the reason is whitelisted, each line carries
//! the caller's last-seen quantity as `changeFromQuantity` (Shopify rejects the write if a count moved), and the
//! caller-supplied idempotency key makes a retry after an uncertain network failure a no-op instead of a second
//! change. After the write the levels are re-read so the UI shows Shopify's counts, not our arithmetic.

use serde::{Deserialize, Serialize};

/// Shopify's adjustment reasons that make sense for a manual stock change.
const REASONS: &[&str] = &[
    "correction",
    "cycle_count_available",
    "damaged",
    "shrinkage",
    "received",
    "restock",
    "promotion",
    "other",
];
/// ponytail: sanity caps on one manual request; raise if someone legitimately needs more in one go.
const MAX_DELTA: i64 = 100_000;
const MAX_CHANGES: usize = 100;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub inventory_item_id: String,
    pub location_id: String,
    pub delta: i64,
    /// The `available` count the user saw; Shopify refuses the change if it no longer matches.
    pub change_from: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustRequest {
    pub store_id: String,
    pub reason: String,
    pub changes: Vec<Change>,
    /// "adjust" | "receive" | "transfer" — with `reference` it becomes Shopify's referenceDocumentUri for the audit trail.
    #[serde(default)]
    pub kind: Option<String>,
    /// Free text (lot, PO, supplier…); slugged into the URI.
    #[serde(default)]
    pub reference: Option<String>,
    /// One key per reviewed proposal; reuse it on retry.
    pub idempotency_key: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LevelAfter {
    pub inventory_item_id: String,
    pub location_id: String,
    pub available: i64,
    pub on_hand: i64,
}

fn validate(r: &AdjustRequest) -> Result<(), String> {
    if r.changes.is_empty() {
        return Err("Nothing to change.".into());
    }
    if r.changes.len() > MAX_CHANGES {
        return Err(format!("At most {MAX_CHANGES} lines per request."));
    }
    if !REASONS.contains(&r.reason.as_str()) {
        return Err(format!("Unsupported reason: {}", r.reason));
    }
    if r.idempotency_key.trim().len() < 8 {
        return Err("Missing idempotency key.".into());
    }
    for (i, c) in r.changes.iter().enumerate() {
        if c.delta == 0 {
            return Err("A line has a quantity of 0 — remove it or enter a number.".into());
        }
        if c.delta.abs() > MAX_DELTA {
            return Err(format!("A change of {} is over the {MAX_DELTA}-unit limit.", c.delta));
        }
        if !c.inventory_item_id.starts_with("gid://shopify/InventoryItem/") || !c.location_id.starts_with("gid://shopify/Location/") {
            return Err("Missing inventory item or location id — sync inventory and try again.".into());
        }
        if r.changes[..i].iter().any(|p| p.inventory_item_id == c.inventory_item_id && p.location_id == c.location_id) {
            return Err("The same item appears twice at one location — combine the lines.".into());
        }
    }
    Ok(())
}

/// `flowcommand://receive/LOT-0918` — letters, digits, `-_.` only, so it's always a valid URI.
fn reference_uri(kind: Option<&str>, reference: Option<&str>) -> Option<String> {
    let kind = kind.filter(|k| matches!(*k, "adjust" | "receive" | "transfer"))?;
    let slug: String = reference?
        .trim()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    (!slug.is_empty()).then(|| format!("flowcommand://{kind}/{slug}"))
}

const MUTATION: &str = "mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }";
const LEVELS_QUERY: &str = "query Levels($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id inventoryLevels(first: 10) { edges { node { location { id } quantities(names: [\"available\", \"on_hand\"]) { name quantity } } } } } } }";

fn user_error(resp: &serde_json::Value) -> Option<String> {
    let errs = resp["data"]["inventoryAdjustQuantities"]["userErrors"].as_array()?;
    let first = errs.first()?;
    let msg = first["message"].as_str().unwrap_or("Shopify rejected the change");
    let code = first["code"].as_str().unwrap_or("");
    let l = msg.to_lowercase();
    Some(if code.contains("CHANGE_FROM") || l.contains("compare") || l.contains("changefrom") || l.contains("change_from") {
        format!("The count changed in Shopify since it was loaded — sync and review again. ({msg})")
    } else if l.contains("not stocked") || l.contains("not active") {
        format!("An item isn't stocked at that location in Shopify — stock it there first. ({msg})")
    } else {
        msg.to_string()
    })
}

fn levels_after(resp: &serde_json::Value, changes: &[Change]) -> Option<Vec<LevelAfter>> {
    let nodes = resp["data"]["nodes"].as_array()?;
    changes
        .iter()
        .map(|c| {
            let item = nodes.iter().find(|n| n["id"] == c.inventory_item_id.as_str())?;
            let level = item["inventoryLevels"]["edges"]
                .as_array()?
                .iter()
                .find(|e| e["node"]["location"]["id"] == c.location_id.as_str())?;
            let qs = level["node"]["quantities"].as_array()?;
            let get = |n: &str| qs.iter().find(|q| q["name"] == n).and_then(|q| q["quantity"].as_i64());
            Some(LevelAfter {
                inventory_item_id: c.inventory_item_id.clone(),
                location_id: c.location_id.clone(),
                available: get("available")?,
                on_hand: get("on_hand")?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn adjust_inventory(request: AdjustRequest) -> Result<Vec<LevelAfter>, String> {
    validate(&request)?;
    let domain = crate::store_by_id(&request.store_id)?.domain;
    let changes: Vec<serde_json::Value> = request
        .changes
        .iter()
        .map(|c| {
            serde_json::json!({
                "inventoryItemId": c.inventory_item_id,
                "locationId": c.location_id,
                "delta": c.delta,
                "changeFromQuantity": c.change_from,
            })
        })
        .collect();
    let mut input = serde_json::json!({ "name": "available", "reason": request.reason, "changes": changes });
    if let Some(uri) = reference_uri(request.kind.as_deref(), request.reference.as_deref()) {
        input["referenceDocumentUri"] = uri.into();
    }
    let resp = crate::graphql_request(&domain, MUTATION, Some(serde_json::json!({ "key": request.idempotency_key, "input": input })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "write_inventory", "inventory write"))?;
    if let Some(e) = user_error(&resp) {
        return Err(e);
    }
    if resp["data"]["inventoryAdjustQuantities"]["inventoryAdjustmentGroup"].is_null() {
        return Err("Shopify returned no adjustment record — sync to check whether the change applied before retrying.".into());
    }
    read_levels(&domain, &request.changes).await
}

/// Shopify's current available / on-hand for each change's item at its location (also used after a transfer).
pub async fn read_levels(domain: &str, changes: &[Change]) -> Result<Vec<LevelAfter>, String> {
    let mut ids: Vec<&str> = changes.iter().map(|c| c.inventory_item_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    let levels = crate::graphql_request(domain, LEVELS_QUERY, Some(serde_json::json!({ "ids": ids })))
        .await
        .map_err(|e| format!("Change applied, but re-reading the counts failed — sync to see them. ({e})"))?;
    levels_after(&levels, changes).ok_or_else(|| "Change applied, but Shopify returned no counts — sync to see them.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(item: u32, loc: u32, delta: i64) -> Change {
        Change {
            inventory_item_id: format!("gid://shopify/InventoryItem/{item}"),
            location_id: format!("gid://shopify/Location/{loc}"),
            delta,
            change_from: 9,
        }
    }

    fn req(changes: Vec<Change>) -> AdjustRequest {
        AdjustRequest {
            store_id: "retail".into(),
            reason: "damaged".into(),
            changes,
            kind: None,
            reference: None,
            idempotency_key: "4f5b6ebf-143c-4da5".into(),
        }
    }

    #[test]
    fn validate_guards_inputs() {
        assert!(validate(&req(vec![change(1, 2, -2)])).is_ok());
        assert!(validate(&req(vec![change(1, 2, -2), change(1, 3, 2)])).is_ok()); // a transfer pair
        assert!(validate(&req(vec![])).is_err());
        assert!(validate(&req(vec![change(1, 2, 0)])).is_err());
        assert!(validate(&req(vec![change(1, 2, MAX_DELTA + 1)])).is_err());
        assert!(validate(&req(vec![change(1, 2, 1), change(1, 2, 3)])).is_err()); // duplicate item+location
        assert!(validate(&AdjustRequest { reason: "movement_created".into(), ..req(vec![change(1, 2, 1)]) }).is_err());
        assert!(validate(&AdjustRequest { idempotency_key: "".into(), ..req(vec![change(1, 2, 1)]) }).is_err());
        let mut bad = change(1, 2, 1);
        bad.location_id = String::new();
        assert!(validate(&req(vec![bad])).is_err());
    }

    #[test]
    fn reference_uri_is_slugged() {
        assert_eq!(reference_uri(Some("receive"), Some(" Lot 24/0918 #2 ")).as_deref(), Some("flowcommand://receive/Lot-240918-2"));
        assert_eq!(reference_uri(Some("receive"), Some("  ")), None);
        assert_eq!(reference_uri(Some("bogus"), Some("x")), None);
        assert_eq!(reference_uri(Some("transfer"), None), None);
    }

    #[test]
    fn parses_user_errors_and_levels() {
        let stale = serde_json::json!({"data": {"inventoryAdjustQuantities": {"inventoryAdjustmentGroup": null,
            "userErrors": [{"field": ["input"], "message": "The specified compare quantity does not match", "code": "CHANGE_FROM_QUANTITY_STALE"}]}}});
        assert!(user_error(&stale).unwrap().starts_with("The count changed"));
        let ok = serde_json::json!({"data": {"inventoryAdjustQuantities": {"inventoryAdjustmentGroup": {"id": "x"}, "userErrors": []}}});
        assert_eq!(user_error(&ok), None);
        let level = |loc: u32, a: i64, h: i64| serde_json::json!({"node": {"location": {"id": format!("gid://shopify/Location/{loc}")},
            "quantities": [{"name": "available", "quantity": a}, {"name": "on_hand", "quantity": h}]}});
        let resp = serde_json::json!({"data": {"nodes": [{"id": "gid://shopify/InventoryItem/1",
            "inventoryLevels": {"edges": [level(2, 7, 9), level(3, 4, 4)]}}]}});
        let after = levels_after(&resp, &[change(1, 2, -2), change(1, 3, 2)]).unwrap();
        assert_eq!((after[0].available, after[0].on_hand, after[1].available), (7, 9, 4));
        assert!(levels_after(&resp, &[change(1, 5, 1)]).is_none()); // location not returned
    }
}

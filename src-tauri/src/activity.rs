//! Home's "Recent activity": Shopify's own event log for a store (orders placed / paid / fulfilled / refunded,
//! products created or published, …), newest first, as plain text.

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub created_at: String,
    /// Shopify's message with its HTML links stripped.
    pub message: String,
    /// BasicEvent action: placed, fulfillment_success, refund_success, create, published, …
    pub action: Option<String>,
    /// ORDER | PRODUCT | COLLECTION | …
    pub subject_type: Option<String>,
    /// gid of the order / product the event is about.
    pub subject_id: Option<String>,
}

const QUERY: &str = "query A($first: Int!) { events(first: $first, sortKey: CREATED_AT, reverse: true) { nodes { id createdAt message ... on BasicEvent { action subjectType subjectId } } } }";
/// One order logs ~8 events (placed, confirmed, emails, fraud check, tax, payment, confirmation number), so keep an
/// allow-list of (subject type, action) worth a glance; staff comments (no action) are always kept.
/// ponytail: fixed list; add actions here when someone misses one in the feed.
const KEEP: &[(&str, &str)] = &[
    ("ORDER", "confirmed"), // "Received new order R94244 by …"
    ("ORDER", "fulfillment_success"),
    ("ORDER", "fulfillment_cancelled"),
    ("ORDER", "refund_success"),
    ("ORDER", "refund_failure"),
    ("ORDER", "cancelled"),
    ("ORDER", "restock_line_items"),
    ("ORDER", "sale_failure"),
    ("ORDER", "capture_failure"),
    ("ORDER", "authorization_failure"),
    ("PRODUCT", "create"),
    ("PRODUCT", "destroy"),
    ("PRODUCT", "published"),
    ("PRODUCT", "unpublished"),
    ("CUSTOMER", "create"),
];
/// Events fetched before filtering; enough for ~25 kept rows on a busy day.
const FETCH: u32 = 100;

/// "Received new order <a href=\"/orders/1\">#1001</a> by Bob &amp; Co." → "Received new order #1001 by Bob & Co."
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out.replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse(resp: &serde_json::Value) -> Option<Vec<Activity>> {
    let s = |v: &serde_json::Value| v.as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from);
    Some(
        resp["data"]["events"]["nodes"]
            .as_array()?
            .iter()
            .filter_map(|e| {
                let action = s(&e["action"]);
                let subject_type = s(&e["subjectType"]);
                if let Some(a) = action.as_deref() {
                    if !KEEP.iter().any(|(t, k)| *k == a && subject_type.as_deref() == Some(*t)) {
                        return None;
                    }
                }
                let message = plain(e["message"].as_str().unwrap_or(""));
                if message.is_empty() {
                    return None;
                }
                Some(Activity { id: s(&e["id"])?, created_at: s(&e["createdAt"])?, message, action, subject_type, subject_id: s(&e["subjectId"]) })
            })
            .collect(),
    )
}

#[tauri::command]
pub async fn list_activity(store_id: String, first: Option<u32>) -> Result<Vec<Activity>, String> {
    let domain = crate::store_by_id(&store_id)?.domain;
    let keep = first.unwrap_or(25).clamp(1, 100) as usize;
    let resp = crate::graphql_request(&domain, QUERY, Some(serde_json::json!({ "first": FETCH }))).await?;
    let mut a = parse(&resp).ok_or_else(|| "Shopify returned no events.".to_string())?;
    a.truncate(keep);
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_and_entities() {
        assert_eq!(plain("Received new order <a href=\"/admin/orders/1\">#1001</a> by Bob &amp; Co."), "Received new order #1001 by Bob & Co.");
        assert_eq!(plain("  a\n  b  "), "a b");
        assert_eq!(plain("5 &lt; 6 &quot;ok&quot;"), "5 < 6 \"ok\"");
    }

    #[test]
    fn keeps_allow_listed_events_and_comments() {
        let r = serde_json::json!({"data": {"events": {"nodes": [
            {"id": "gid://shopify/BasicEvent/1", "createdAt": "2026-10-01T12:00:00Z", "message": "Received new order <a href=\"x\">R94244</a> by Erick Pinon.", "action": "confirmed", "subjectType": "ORDER", "subjectId": "gid://shopify/Order/9"},
            {"id": "gid://shopify/BasicEvent/5", "createdAt": "2026-10-01T12:00:00Z", "message": "Erick Pinon placed this order.", "action": "placed", "subjectType": "ORDER", "subjectId": "gid://shopify/Order/9"},
            {"id": "gid://shopify/BasicEvent/6", "createdAt": "2026-10-01T12:00:00Z", "message": "Order confirmation email was sent.", "action": "mail_sent", "subjectType": "ORDER", "subjectId": "gid://shopify/Order/9"},
            {"id": "gid://shopify/BasicEvent/7", "createdAt": "2026-10-01T12:00:00Z", "message": "This customer placed order R94244.", "action": "order_placed", "subjectType": "CUSTOMER", "subjectId": "gid://shopify/Customer/2"},
            {"id": "gid://shopify/BasicEvent/2", "createdAt": "2026-10-01T11:00:00Z", "message": "Confirmation #ABC generated", "action": "confirmation_number_generated", "subjectType": "ORDER", "subjectId": "gid://shopify/Order/9"},
            {"id": "gid://shopify/BasicEvent/3", "createdAt": "2026-10-01T10:00:00Z", "message": "", "action": "create", "subjectType": "PRODUCT", "subjectId": null},
            {"id": "gid://shopify/CommentEvent/4", "createdAt": "2026-10-01T09:00:00Z", "message": "<p>Called the customer</p>"}
        ]}}});
        let a = parse(&r).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].message.as_str(), a[0].subject_id.as_deref()), ("Received new order R94244 by Erick Pinon.", Some("gid://shopify/Order/9")));
        assert_eq!((a[1].message.as_str(), a[1].action.as_deref()), ("Called the customer", None));
    }
}

//! Refund items (and optionally shipping) on one order, back to the original payment method(s).
//!
//! Money safety: the UI only ever sends WHAT to refund (line quantities, shipping yes/no) plus the amount the user
//! confirmed. Right before writing, Rust asks Shopify for the suggested refund again and refuses if the total differs
//! from the confirmed amount; the transactions (gateway, parent, amount) come from that fresh suggestion, never from the
//! UI. `refundCreate` carries an idempotency key, so a retry after a network error can't refund twice.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefundLine {
    pub id: String,
    pub title: String,
    pub sku: Option<String>,
    pub quantity: i64,
    /// What's left to refund on this line.
    pub refundable: i64,
    pub unfulfilled: i64,
    /// "42.00 USD"
    pub unit_price: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefundInfo {
    pub name: String,
    pub currency: String,
    /// Already refunded on this order, "0.00 USD".
    pub refunded: String,
    pub lines: Vec<RefundLine>,
    pub locations: Vec<Location>,
    /// Where the order shipped from; the default restock location.
    pub default_location_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineQty {
    pub line_item_id: String,
    pub quantity: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefundPreview {
    /// Total that would go back to the customer, "54.18".
    pub amount: String,
    pub subtotal: String,
    pub tax: String,
    pub shipping: String,
    pub currency: String,
    /// Payment methods the money goes back to (shopify_payments, paypal, …).
    pub gateways: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundRequest {
    pub store_id: String,
    pub order_id: String,
    pub lines: Vec<LineQty>,
    pub refund_shipping: bool,
    pub restock: bool,
    #[serde(default)]
    pub location_id: Option<String>,
    pub notify: bool,
    #[serde(default)]
    pub note: Option<String>,
    /// The total the user saw and confirmed; the write is refused if Shopify now computes something else.
    pub expected_amount: String,
    pub idempotency_key: String,
}

const INFO: &str = "query R($id: ID!) { order(id: $id) { id name currencyCode totalRefundedSet { shopMoney { amount currencyCode } } lineItems(first: 100) { nodes { id title sku quantity refundableQuantity unfulfilledQuantity originalUnitPriceSet { shopMoney { amount currencyCode } } } } fulfillmentOrders(first: 10) { nodes { assignedLocation { location { id } } } } } locations(first: 20) { nodes { id name isActive } } }";
const SUGGEST: &str = "query S($id: ID!, $lines: [RefundLineItemInput!], $ship: Boolean) { order(id: $id) { suggestedRefund(refundLineItems: $lines, refundShipping: $ship) { amountSet { shopMoney { amount currencyCode } } subtotalSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } shipping { amountSet { shopMoney { amount } } } suggestedTransactions { gateway kind parentTransaction { id } amountSet { shopMoney { amount currencyCode } } } } } }";
const CREATE: &str = "mutation Refund($input: RefundInput!, $key: String!) { refundCreate(input: $input) @idempotent(key: $key) { refund { id totalRefundedSet { shopMoney { amount currencyCode } } } userErrors { field message } } }";

fn s(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from)
}

/// Money strings to cents, so "54.1" and "54.10" compare equal.
fn cents(amount: &str) -> Option<i64> {
    amount.trim().parse::<f64>().ok().map(|a| (a * 100.0).round() as i64)
}

fn parse_info(resp: &serde_json::Value) -> Option<RefundInfo> {
    let o = &resp["data"]["order"];
    if o.is_null() {
        return None;
    }
    let refunded = &o["totalRefundedSet"]["shopMoney"];
    Some(RefundInfo {
        name: s(&o["name"])?,
        currency: s(&o["currencyCode"])?,
        refunded: format!("{} {}", s(&refunded["amount"]).unwrap_or_else(|| "0.00".into()), s(&refunded["currencyCode"]).unwrap_or_default()),
        lines: o["lineItems"]["nodes"]
            .as_array()?
            .iter()
            .filter_map(|l| {
                let p = &l["originalUnitPriceSet"]["shopMoney"];
                Some(RefundLine {
                    id: s(&l["id"])?,
                    title: s(&l["title"])?,
                    sku: s(&l["sku"]),
                    quantity: l["quantity"].as_i64()?,
                    refundable: l["refundableQuantity"].as_i64()?,
                    unfulfilled: l["unfulfilledQuantity"].as_i64().unwrap_or(0),
                    unit_price: format!("{} {}", s(&p["amount"])?, s(&p["currencyCode"])?),
                })
            })
            .collect(),
        locations: resp["data"]["locations"]["nodes"]
            .as_array()
            .map(|ls| {
                ls.iter()
                    .filter(|l| l["isActive"].as_bool().unwrap_or(true))
                    .filter_map(|l| Some(Location { id: s(&l["id"])?, name: s(&l["name"])? }))
                    .collect()
            })
            .unwrap_or_default(),
        default_location_id: o["fulfillmentOrders"]["nodes"]
            .as_array()
            .and_then(|fos| fos.iter().find_map(|f| s(&f["assignedLocation"]["location"]["id"]))),
    })
}

struct Suggestion {
    preview: RefundPreview,
    /// (gateway, parent transaction id, amount) — what refundCreate's transactions need.
    transactions: Vec<(String, Option<String>, String)>,
}

fn parse_suggestion(resp: &serde_json::Value) -> Option<Suggestion> {
    let r = &resp["data"]["order"]["suggestedRefund"];
    if r.is_null() {
        return None;
    }
    let amt = |v: &serde_json::Value| s(&v["shopMoney"]["amount"]).unwrap_or_else(|| "0.00".into());
    let transactions: Vec<(String, Option<String>, String)> = r["suggestedTransactions"]
        .as_array()?
        .iter()
        .filter_map(|t| Some((s(&t["gateway"])?, s(&t["parentTransaction"]["id"]), s(&t["amountSet"]["shopMoney"]["amount"])?)))
        .filter(|(_, _, a)| cents(a).unwrap_or(0) > 0)
        .collect();
    let mut gateways: Vec<String> = transactions.iter().map(|t| t.0.clone()).collect();
    gateways.dedup();
    Some(Suggestion {
        preview: RefundPreview {
            amount: amt(&r["amountSet"]),
            subtotal: amt(&r["subtotalSet"]),
            tax: amt(&r["totalTaxSet"]),
            shipping: amt(&r["shipping"]["amountSet"]),
            currency: s(&r["amountSet"]["shopMoney"]["currencyCode"]).unwrap_or_default(),
            gateways,
        },
        transactions,
    })
}

fn validate_lines(order_id: &str, lines: &[LineQty], refund_shipping: bool) -> Result<(), String> {
    if !order_id.starts_with("gid://shopify/Order/") {
        return Err("Missing order id — reload the order.".into());
    }
    if lines.is_empty() && !refund_shipping {
        return Err("Pick items or shipping to refund.".into());
    }
    for (i, l) in lines.iter().enumerate() {
        if l.quantity <= 0 {
            return Err("Quantities must be at least 1 — leave out items you're not refunding.".into());
        }
        if lines[..i].iter().any(|p| p.line_item_id == l.line_item_id) {
            return Err("The same item is listed twice.".into());
        }
    }
    Ok(())
}

/// RETURN for fulfilled units, CANCEL for never-shipped ones (Shopify's rule), NO_RESTOCK when not restocking.
/// ponytail: a line that's part shipped, part not is restocked as RETURN in one entry; split it if that ever matters.
fn restock_type(restock: bool, qty: i64, unfulfilled: i64) -> &'static str {
    match (restock, qty <= unfulfilled) {
        (false, _) => "NO_RESTOCK",
        (true, true) => "CANCEL",
        (true, false) => "RETURN",
    }
}

async fn suggest(domain: &str, order_id: &str, lines: &[LineQty], refund_shipping: bool) -> Result<Suggestion, String> {
    let vars = serde_json::json!({
        "id": order_id,
        "ship": refund_shipping,
        "lines": lines.iter().map(|l| serde_json::json!({ "lineItemId": l.line_item_id, "quantity": l.quantity })).collect::<Vec<_>>(),
    });
    let resp = crate::graphql_request(domain, SUGGEST, Some(vars)).await?;
    parse_suggestion(&resp).ok_or_else(|| "Shopify couldn't calculate this refund — reload the order.".to_string())
}

#[tauri::command]
pub async fn get_refund_info(store_id: String, order_id: String) -> Result<RefundInfo, String> {
    let domain = crate::store_by_id(&store_id)?.domain;
    let resp = crate::graphql_request(&domain, INFO, Some(serde_json::json!({ "id": order_id }))).await?;
    parse_info(&resp).ok_or_else(|| "Order not found.".to_string())
}

#[tauri::command]
pub async fn preview_refund(store_id: String, order_id: String, lines: Vec<LineQty>, refund_shipping: bool) -> Result<RefundPreview, String> {
    validate_lines(&order_id, &lines, refund_shipping)?;
    let domain = crate::store_by_id(&store_id)?.domain;
    Ok(suggest(&domain, &order_id, &lines, refund_shipping).await?.preview)
}

#[tauri::command]
pub async fn create_refund(request: RefundRequest) -> Result<RefundPreview, String> {
    validate_lines(&request.order_id, &request.lines, request.refund_shipping)?;
    if request.idempotency_key.trim().len() < 8 {
        return Err("Missing idempotency key.".into());
    }
    if request.note.as_deref().is_some_and(|n| n.chars().count() > 1000) {
        return Err("Refund note is over 1,000 characters.".into());
    }
    let location = request.location_id.as_deref().filter(|l| l.starts_with("gid://shopify/Location/"));
    if request.restock && !request.lines.is_empty() && location.is_none() {
        return Err("Pick a location to restock to, or turn restocking off.".into());
    }
    let domain = crate::store_by_id(&request.store_id)?.domain;

    // Fresh numbers from Shopify: line quantities still refundable, and the exact money that would move.
    let info_resp = crate::graphql_request(&domain, INFO, Some(serde_json::json!({ "id": request.order_id }))).await?;
    let info = parse_info(&info_resp).ok_or("Order not found.")?;
    for l in &request.lines {
        let line = info.lines.iter().find(|x| x.id == l.line_item_id).ok_or("An item is no longer on this order — reload it.")?;
        if l.quantity > line.refundable {
            return Err(format!("Only {} of \"{}\" can still be refunded — it may have just been refunded. Reload the order.", line.refundable, line.title));
        }
    }
    let fresh = suggest(&domain, &request.order_id, &request.lines, request.refund_shipping).await?;
    if cents(&fresh.preview.amount) != cents(&request.expected_amount) {
        return Err(format!(
            "The refund total changed to {} {} since you reviewed it (was {}). Review the new amount and confirm again.",
            fresh.preview.amount, fresh.preview.currency, request.expected_amount
        ));
    }
    if fresh.transactions.is_empty() {
        return Err("Nothing was paid that can be refunded on this order (unpaid or already refunded). Use Shopify admin to cancel it instead.".into());
    }

    let mut input = serde_json::json!({
        "orderId": request.order_id,
        "notify": request.notify,
        "refundLineItems": request.lines.iter().map(|l| {
            let unfulfilled = info.lines.iter().find(|x| x.id == l.line_item_id).map_or(0, |x| x.unfulfilled);
            let kind = restock_type(request.restock, l.quantity, unfulfilled);
            let mut v = serde_json::json!({ "lineItemId": l.line_item_id, "quantity": l.quantity, "restockType": kind });
            if kind != "NO_RESTOCK" {
                v["locationId"] = location.into();
            }
            v
        }).collect::<Vec<_>>(),
        "transactions": fresh.transactions.iter().map(|(gateway, parent, amount)| {
            let mut t = serde_json::json!({ "orderId": request.order_id, "gateway": gateway, "kind": "REFUND", "amount": amount });
            if let Some(p) = parent {
                t["parentId"] = p.as_str().into();
            }
            t
        }).collect::<Vec<_>>(),
    });
    if request.refund_shipping {
        input["shipping"] = serde_json::json!({ "fullRefund": true });
    }
    if let Some(note) = request.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        input["note"] = note.into();
    }
    let resp = crate::graphql_request(&domain, CREATE, Some(serde_json::json!({ "input": input, "key": request.idempotency_key })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "write_orders", "refund"))?;
    if let Some(e) = resp["data"]["refundCreate"]["userErrors"].as_array().and_then(|es| es.first()) {
        return Err(e["message"].as_str().unwrap_or("Shopify rejected the refund").to_string());
    }
    if resp["data"]["refundCreate"]["refund"].is_null() {
        return Err("Shopify returned no refund — reload the order to check before retrying (a retry is safe either way).".into());
    }
    Ok(fresh.preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_info_and_suggestion() {
        let info = serde_json::json!({"data": {"order": {"id": "gid://shopify/Order/1", "name": "#R-1", "currencyCode": "USD",
            "totalRefundedSet": {"shopMoney": {"amount": "0.0", "currencyCode": "USD"}},
            "lineItems": {"nodes": [{"id": "gid://shopify/LineItem/5", "title": "Lifter · 7g", "sku": "FG-LFT-7G", "quantity": 2, "refundableQuantity": 2,
                "unfulfilledQuantity": 0, "originalUnitPriceSet": {"shopMoney": {"amount": "42.0", "currencyCode": "USD"}}}]},
            "fulfillmentOrders": {"nodes": [{"assignedLocation": {"location": {"id": "gid://shopify/Location/9"}}}]}},
            "locations": {"nodes": [{"id": "gid://shopify/Location/9", "name": "Flow NC", "isActive": true}, {"id": "gid://shopify/Location/8", "name": "Old", "isActive": false}]}}});
        let i = parse_info(&info).unwrap();
        assert_eq!((i.lines[0].refundable, i.lines[0].unit_price.as_str(), i.locations.len()), (2, "42.0 USD", 1));
        assert_eq!(i.default_location_id.as_deref(), Some("gid://shopify/Location/9"));

        let sug = serde_json::json!({"data": {"order": {"suggestedRefund": {"amountSet": {"shopMoney": {"amount": "44.94", "currencyCode": "USD"}},
            "subtotalSet": {"shopMoney": {"amount": "42.0"}}, "totalTaxSet": {"shopMoney": {"amount": "2.94"}}, "shipping": {"amountSet": {"shopMoney": {"amount": "0.0"}}},
            "suggestedTransactions": [{"gateway": "shopify_payments", "kind": "SUGGESTED_REFUND", "parentTransaction": {"id": "gid://shopify/OrderTransaction/3"},
                "amountSet": {"shopMoney": {"amount": "44.94", "currencyCode": "USD"}}}]}}}});
        let s = parse_suggestion(&sug).unwrap();
        assert_eq!((s.preview.amount.as_str(), s.preview.gateways[0].as_str()), ("44.94", "shopify_payments"));
        assert_eq!(s.transactions[0].1.as_deref(), Some("gid://shopify/OrderTransaction/3"));
    }

    #[test]
    fn money_and_restock_rules() {
        assert_eq!(cents("54.1"), cents("54.10"));
        assert_ne!(cents("54.10"), cents("54.11"));
        assert_eq!(cents("abc"), None);
        assert_eq!(restock_type(false, 1, 5), "NO_RESTOCK");
        assert_eq!(restock_type(true, 1, 1), "CANCEL");
        assert_eq!(restock_type(true, 2, 1), "RETURN");
        let l = |q| LineQty { line_item_id: "gid://shopify/LineItem/5".into(), quantity: q };
        assert!(validate_lines("gid://shopify/Order/1", &[l(1)], false).is_ok());
        assert!(validate_lines("gid://shopify/Order/1", &[], true).is_ok()); // shipping only
        assert!(validate_lines("gid://shopify/Order/1", &[], false).is_err());
        assert!(validate_lines("gid://shopify/Order/1", &[l(0)], false).is_err());
        assert!(validate_lines("gid://shopify/Order/1", &[l(1), l(1)], false).is_err());
        assert!(validate_lines("1", &[l(1)], false).is_err());
    }
}

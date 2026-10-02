//! Shipments and manual fulfillment for one order.
//!
//! ShipStation normally fulfills Flow Gardens orders; this is for the odd order shipped outside it. Before writing,
//! the fulfillment order is re-read and every requested quantity is checked against what's still unfulfilled, so a
//! line ShipStation (or anyone) already fulfilled is refused instead of fulfilled twice. Shopify itself also rejects
//! over-fulfillment, which makes a retry after a network error safe.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoLine {
    pub id: String,
    pub title: String,
    pub sku: Option<String>,
    pub remaining: i64,
    pub total: i64,
}

/// One fulfillment order = the items of an order assigned to one location.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FulfillmentOrder {
    pub id: String,
    /// OPEN | IN_PROGRESS | SCHEDULED | ON_HOLD | CLOSED | CANCELLED | INCOMPLETE
    pub status: String,
    pub location: Option<String>,
    pub can_fulfill: bool,
    pub lines: Vec<FoLine>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub company: Option<String>,
    pub number: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shipment {
    pub id: String,
    /// displayStatus when Shopify has one (IN_TRANSIT, DELIVERED, …), else status (SUCCESS, CANCELLED, …).
    pub status: String,
    pub created_at: String,
    pub tracking: Vec<Tracking>,
    /// "2 × Lifter · 7g"
    pub items: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FulfillmentInfo {
    pub fulfillment_orders: Vec<FulfillmentOrder>,
    pub shipments: Vec<Shipment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FulfillLine {
    pub id: String,
    pub quantity: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FulfillRequest {
    pub store_id: String,
    pub order_id: String,
    pub fulfillment_order_id: String,
    pub lines: Vec<FulfillLine>,
    #[serde(default)]
    pub tracking_company: Option<String>,
    #[serde(default)]
    pub tracking_number: Option<String>,
    #[serde(default)]
    pub tracking_url: Option<String>,
    pub notify_customer: bool,
}

const INFO: &str = "query FO($id: ID!) { order(id: $id) { id fulfillmentOrders(first: 20) { nodes { id status assignedLocation { name } supportedActions { action } lineItems(first: 100) { nodes { id remainingQuantity totalQuantity lineItem { title sku } } } } } fulfillments(first: 20) { id status displayStatus createdAt trackingInfo(first: 5) { company number url } fulfillmentLineItems(first: 50) { nodes { quantity lineItem { title } } } } } }";
const CREATE: &str = "mutation Fulfill($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }";

fn s(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from)
}

fn parse_info(resp: &serde_json::Value) -> Option<FulfillmentInfo> {
    let o = &resp["data"]["order"];
    if o.is_null() {
        return None;
    }
    let fulfillment_orders = o["fulfillmentOrders"]["nodes"]
        .as_array()?
        .iter()
        .filter_map(|fo| {
            Some(FulfillmentOrder {
                id: s(&fo["id"])?,
                status: s(&fo["status"])?,
                location: s(&fo["assignedLocation"]["name"]),
                can_fulfill: fo["supportedActions"].as_array()?.iter().any(|a| a["action"] == "CREATE_FULFILLMENT"),
                lines: fo["lineItems"]["nodes"]
                    .as_array()?
                    .iter()
                    .filter_map(|l| {
                        Some(FoLine {
                            id: s(&l["id"])?,
                            title: s(&l["lineItem"]["title"])?,
                            sku: s(&l["lineItem"]["sku"]),
                            remaining: l["remainingQuantity"].as_i64()?,
                            total: l["totalQuantity"].as_i64()?,
                        })
                    })
                    .collect(),
            })
        })
        .collect();
    let shipments = o["fulfillments"]
        .as_array()?
        .iter()
        .filter_map(|f| {
            Some(Shipment {
                id: s(&f["id"])?,
                status: s(&f["displayStatus"]).or_else(|| s(&f["status"]))?,
                created_at: s(&f["createdAt"])?,
                tracking: f["trackingInfo"]
                    .as_array()
                    .map(|ts| ts.iter().map(|t| Tracking { company: s(&t["company"]), number: s(&t["number"]), url: s(&t["url"]) }).collect())
                    .unwrap_or_default(),
                items: f["fulfillmentLineItems"]["nodes"]
                    .as_array()
                    .map(|ls| {
                        ls.iter()
                            .filter_map(|l| Some(format!("{} × {}", l["quantity"].as_i64()?, l["lineItem"]["title"].as_str()?)))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect();
    Some(FulfillmentInfo { fulfillment_orders, shipments })
}

fn validate(r: &FulfillRequest) -> Result<(), String> {
    if !r.order_id.starts_with("gid://shopify/Order/") || !r.fulfillment_order_id.starts_with("gid://shopify/FulfillmentOrder/") {
        return Err("Missing order or fulfillment order id — reload the order.".into());
    }
    if r.lines.is_empty() {
        return Err("Pick at least one item to fulfill.".into());
    }
    for (i, l) in r.lines.iter().enumerate() {
        if l.quantity <= 0 {
            return Err("Quantities must be at least 1 — remove items you're not shipping.".into());
        }
        if r.lines[..i].iter().any(|p| p.id == l.id) {
            return Err("The same item is listed twice.".into());
        }
    }
    if r.tracking_number.as_deref().is_some_and(|n| n.trim().chars().count() > 100) {
        return Err("Tracking number is over 100 characters.".into());
    }
    if r.tracking_url.as_deref().map(str::trim).is_some_and(|u| !u.is_empty() && !u.starts_with("https://") && !u.starts_with("http://")) {
        return Err("Tracking URL must start with https://".into());
    }
    Ok(())
}

/// Refuse anything Shopify would fulfill twice or can't fulfill: closed orders, unsupported action, short quantities.
fn check_against(fo: &FulfillmentOrder, lines: &[FulfillLine]) -> Result<(), String> {
    if !fo.can_fulfill {
        return Err(format!(
            "These items can't be fulfilled from here (status {}). They may already be fulfilled — probably by ShipStation — or on hold. Reload the order.",
            fo.status
        ));
    }
    for l in lines {
        let line = fo.lines.iter().find(|x| x.id == l.id).ok_or("An item no longer belongs to this fulfillment — reload the order.")?;
        if l.quantity > line.remaining {
            return Err(format!(
                "Only {} of \"{}\" left to fulfill — it may have just been fulfilled (e.g. by ShipStation). Reload the order.",
                line.remaining, line.title
            ));
        }
    }
    Ok(())
}

async fn read(domain: &str, order_id: &str) -> Result<FulfillmentInfo, String> {
    let resp = crate::graphql_request(domain, INFO, Some(serde_json::json!({ "id": order_id })))
        .await
        .map_err(|e| crate::scope_denied(e, domain, "read_merchant_managed_fulfillment_orders", "fulfillment"))?;
    parse_info(&resp).ok_or_else(|| "Order not found.".to_string())
}

#[tauri::command]
pub async fn get_fulfillment(store_id: String, order_id: String) -> Result<FulfillmentInfo, String> {
    let domain = crate::store_by_id(&store_id)?.domain;
    read(&domain, &order_id).await
}

#[tauri::command]
pub async fn fulfill_order(request: FulfillRequest) -> Result<FulfillmentInfo, String> {
    validate(&request)?;
    let domain = crate::store_by_id(&request.store_id)?.domain;
    let current = read(&domain, &request.order_id).await?;
    let fo = current
        .fulfillment_orders
        .iter()
        .find(|f| f.id == request.fulfillment_order_id)
        .ok_or("That fulfillment no longer exists on this order — reload the order.")?;
    check_against(fo, &request.lines)?;

    let mut f = serde_json::json!({
        "notifyCustomer": request.notify_customer,
        "lineItemsByFulfillmentOrder": [{
            "fulfillmentOrderId": request.fulfillment_order_id,
            "fulfillmentOrderLineItems": request.lines.iter().map(|l| serde_json::json!({ "id": l.id, "quantity": l.quantity })).collect::<Vec<_>>(),
        }],
    });
    let number = request.tracking_number.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if let Some(number) = number {
        let mut t = serde_json::json!({ "number": number });
        if let Some(c) = request.tracking_company.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            t["company"] = c.into(); // Shopify builds the tracking URL for carriers it knows (USPS, UPS, FedEx, DHL…)
        }
        if let Some(u) = request.tracking_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            t["url"] = u.into();
        }
        f["trackingInfo"] = t;
    }
    let resp = crate::graphql_request(&domain, CREATE, Some(serde_json::json!({ "f": f })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "write_merchant_managed_fulfillment_orders", "fulfillment write"))?;
    if let Some(e) = resp["data"]["fulfillmentCreate"]["userErrors"].as_array().and_then(|es| es.first()) {
        return Err(e["message"].as_str().unwrap_or("Shopify rejected the fulfillment").to_string());
    }
    if resp["data"]["fulfillmentCreate"]["fulfillment"].is_null() {
        return Err("Shopify returned no fulfillment — reload the order to check before retrying.".into());
    }
    read(&domain, &request.order_id)
        .await
        .map_err(|e| format!("Fulfilled, but re-reading the order failed — reload it to see the shipment. ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::json!({"data": {"order": {"id": "gid://shopify/Order/1",
            "fulfillmentOrders": {"nodes": [{"id": "gid://shopify/FulfillmentOrder/7", "status": "OPEN", "assignedLocation": {"name": "Flow NC"},
                "supportedActions": [{"action": "CREATE_FULFILLMENT"}, {"action": "HOLD"}],
                "lineItems": {"nodes": [
                    {"id": "gid://shopify/FulfillmentOrderLineItem/70", "remainingQuantity": 2, "totalQuantity": 3, "lineItem": {"title": "Lifter · 7g", "sku": "FG-LFT-7G"}},
                    {"id": "gid://shopify/FulfillmentOrderLineItem/71", "remainingQuantity": 0, "totalQuantity": 1, "lineItem": {"title": "Pre-roll", "sku": ""}}]}}]},
            "fulfillments": [{"id": "gid://shopify/Fulfillment/9", "status": "SUCCESS", "displayStatus": "IN_TRANSIT", "createdAt": "2026-10-01T12:00:00Z",
                "trackingInfo": [{"company": "USPS", "number": "9400", "url": "https://tools.usps.com/x"}],
                "fulfillmentLineItems": {"nodes": [{"quantity": 1, "lineItem": {"title": "Lifter · 7g"}}]}}]}}})
    }

    fn req(lines: Vec<(u32, i64)>) -> FulfillRequest {
        FulfillRequest {
            store_id: "retail".into(),
            order_id: "gid://shopify/Order/1".into(),
            fulfillment_order_id: "gid://shopify/FulfillmentOrder/7".into(),
            lines: lines.into_iter().map(|(id, quantity)| FulfillLine { id: format!("gid://shopify/FulfillmentOrderLineItem/{id}"), quantity }).collect(),
            tracking_company: None,
            tracking_number: None,
            tracking_url: None,
            notify_customer: true,
        }
    }

    #[test]
    fn parses_fulfillment_orders_and_shipments() {
        let info = parse_info(&fixture()).unwrap();
        let fo = &info.fulfillment_orders[0];
        assert!(fo.can_fulfill);
        assert_eq!((fo.location.as_deref(), fo.lines.len(), fo.lines[0].remaining, fo.lines[1].sku.as_deref()), (Some("Flow NC"), 2, 2, None));
        let sh = &info.shipments[0];
        assert_eq!((sh.status.as_str(), sh.tracking[0].number.as_deref(), sh.items[0].as_str()), ("IN_TRANSIT", Some("9400"), "1 × Lifter · 7g"));
    }

    #[test]
    fn validates_and_blocks_double_fulfillment() {
        let info = parse_info(&fixture()).unwrap();
        let fo = &info.fulfillment_orders[0];
        assert!(validate(&req(vec![(70, 2)])).is_ok());
        assert!(validate(&req(vec![])).is_err());
        assert!(validate(&req(vec![(70, 0)])).is_err());
        assert!(validate(&req(vec![(70, 1), (70, 1)])).is_err());
        assert!(validate(&FulfillRequest { tracking_url: Some("ftp://x".into()), ..req(vec![(70, 1)]) }).is_err());
        assert!(check_against(fo, &req(vec![(70, 2)]).lines).is_ok());
        assert!(check_against(fo, &req(vec![(70, 3)]).lines).unwrap_err().starts_with("Only 2"));
        assert!(check_against(fo, &req(vec![(71, 1)]).lines).is_err()); // already fulfilled
        assert!(check_against(fo, &req(vec![(99, 1)]).lines).is_err()); // unknown line
        let closed = FulfillmentOrder { can_fulfill: false, status: "CLOSED".into(), id: fo.id.clone(), location: None, lines: vec![] };
        assert!(check_against(&closed, &req(vec![(70, 1)]).lines).is_err());
    }
}

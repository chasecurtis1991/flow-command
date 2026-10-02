//! Transfers between locations using Shopify's own Transfers (admin → Products → Transfers), so each move has a
//! transfer record, a shipment and a receiving history instead of two anonymous "Correction" adjustments.
//!
//! Three steps: create the transfer as ready to ship → ship it (in transit) → receive it at the destination
//! ("Move now" does all three; "In transit" stops after shipping and the destination receives it later in Shopify).
//! Every step carries a key derived from the caller's idempotency key, and steps 2–3 first look at what already
//! exists, so retrying after a failure resumes where it stopped instead of creating a second transfer or shipment.

use crate::inventory_adjust::{read_levels, Change, LevelAfter};
use serde::{Deserialize, Serialize};

const MAX_LINES: usize = 100;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferLine {
    pub inventory_item_id: String,
    pub quantity: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub store_id: String,
    pub origin_location_id: String,
    pub destination_location_id: String,
    pub lines: Vec<TransferLine>,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// true = "Move now" (receive immediately); false = leave it in transit.
    pub receive_now: bool,
    #[serde(default)]
    pub tracking_company: Option<String>,
    #[serde(default)]
    pub tracking_number: Option<String>,
    pub idempotency_key: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub transfer_id: String,
    /// Shopify's transfer name, e.g. "#T0012".
    pub name: String,
    /// READY_TO_SHIP | IN_PROGRESS | TRANSFERRED | …
    pub status: String,
    pub received: bool,
    /// Counts re-read at origin and destination for every item.
    pub levels: Vec<LevelAfter>,
}

fn validate(r: &TransferRequest) -> Result<(), String> {
    if !r.origin_location_id.starts_with("gid://shopify/Location/") || !r.destination_location_id.starts_with("gid://shopify/Location/") {
        return Err("Pick both locations.".into());
    }
    if r.origin_location_id == r.destination_location_id {
        return Err("Pick two different locations.".into());
    }
    if r.lines.is_empty() {
        return Err("Add at least one item.".into());
    }
    if r.lines.len() > MAX_LINES {
        return Err(format!("At most {MAX_LINES} items per transfer."));
    }
    if r.idempotency_key.trim().len() < 8 {
        return Err("Missing idempotency key.".into());
    }
    for (i, l) in r.lines.iter().enumerate() {
        if !l.inventory_item_id.starts_with("gid://shopify/InventoryItem/") {
            return Err("Missing inventory item id — sync inventory and try again.".into());
        }
        if l.quantity <= 0 || l.quantity > 100_000 {
            return Err("Quantities must be between 1 and 100,000.".into());
        }
        if r.lines[..i].iter().any(|p| p.inventory_item_id == l.inventory_item_id) {
            return Err("The same item is listed twice — combine the lines.".into());
        }
    }
    Ok(())
}

const CREATE: &str = "mutation T($input: InventoryTransferCreateAsReadyToShipInput!, $key: String!) { inventoryTransferCreateAsReadyToShip(input: $input) @idempotent(key: $key) { inventoryTransfer { id name status } userErrors { field message code } } }";
const SHIP: &str = "mutation S($input: InventoryShipmentCreateInput!, $key: String!) { inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $key) { inventoryShipment { id status } userErrors { field message code } } }";
const RECEIVE: &str = "mutation R($id: ID!, $items: [InventoryShipmentReceiveItemInput!], $key: String!) { inventoryShipmentReceive(id: $id, lineItems: $items) @idempotent(key: $key) { inventoryShipment { id status } userErrors { field message code } } }";
const READ: &str = "query Q($id: ID!) { inventoryTransfer(id: $id) { id name status shipments(first: 5) { nodes { id status lineItems(first: 100) { nodes { id quantity unreceivedQuantity inventoryItem { id } } } } } } }";

fn user_error(resp: &serde_json::Value, op: &str) -> Option<String> {
    let e = resp["data"][op]["userErrors"].as_array()?.first()?;
    let msg = e["message"].as_str().unwrap_or("Shopify rejected the transfer");
    Some(match e["code"].as_str().unwrap_or("") {
        "INVENTORY_STATE_NOT_ACTIVE" => format!("An item isn't stocked at one of the locations — stock it there in Shopify first. ({msg})"),
        "UNTRACKED_ITEM" => format!("An item doesn't track inventory. ({msg})"),
        _ => msg.to_string(),
    })
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    name: String,
    status: String,
    /// (shipment id, status, [(shipment line id, unreceived)])
    shipment: Option<(String, String, Vec<(String, i64)>)>,
}

fn parse_snapshot(resp: &serde_json::Value) -> Option<Snapshot> {
    let t = &resp["data"]["inventoryTransfer"];
    let shipment = t["shipments"]["nodes"].as_array()?.first().and_then(|s| {
        Some((
            s["id"].as_str()?.to_string(),
            s["status"].as_str().unwrap_or("").to_string(),
            s["lineItems"]["nodes"]
                .as_array()?
                .iter()
                .filter_map(|l| Some((l["id"].as_str()?.to_string(), l["unreceivedQuantity"].as_i64()?)))
                .collect(),
        ))
    });
    Some(Snapshot { name: t["name"].as_str()?.to_string(), status: t["status"].as_str()?.to_string(), shipment })
}

async fn snapshot(domain: &str, id: &str) -> Result<Snapshot, String> {
    let resp = crate::graphql_request(domain, READ, Some(serde_json::json!({ "id": id }))).await?;
    parse_snapshot(&resp).ok_or_else(|| "Transfer not found in Shopify.".to_string())
}

#[tauri::command]
pub async fn transfer_inventory(request: TransferRequest) -> Result<TransferResult, String> {
    validate(&request)?;
    let domain = crate::store_by_id(&request.store_id)?.domain;
    let key = request.idempotency_key.trim();
    let items: Vec<serde_json::Value> = request
        .lines
        .iter()
        .map(|l| serde_json::json!({ "inventoryItemId": l.inventory_item_id, "quantity": l.quantity }))
        .collect();

    // 1 · Create (reserves the units at the origin). Same key → Shopify returns the same transfer on a retry.
    let mut input = serde_json::json!({
        "originLocationId": request.origin_location_id,
        "destinationLocationId": request.destination_location_id,
        "lineItems": items,
    });
    if let Some(r) = request.reference.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        input["referenceName"] = r.into();
    }
    if let Some(n) = request.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        input["note"] = n.into();
    }
    let resp = crate::graphql_request(&domain, CREATE, Some(serde_json::json!({ "input": input, "key": key })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "write_inventory_transfers", "transfer"))?;
    if let Some(e) = user_error(&resp, "inventoryTransferCreateAsReadyToShip") {
        return Err(e);
    }
    let transfer_id = resp["data"]["inventoryTransferCreateAsReadyToShip"]["inventoryTransfer"]["id"]
        .as_str()
        .ok_or("Shopify returned no transfer — check Products → Transfers before retrying (a retry won't duplicate it).")?
        .to_string();
    let partial = |step: &str, e: String| format!("The transfer was created in Shopify but {step} failed: {e} — Retry finishes it (nothing is duplicated), or finish it in Shopify → Products → Transfers.");

    // 2 · Ship (units leave the origin), unless a shipment already exists from an earlier attempt.
    let mut snap = snapshot(&domain, &transfer_id).await.map_err(|e| partial("reading it back", e))?;
    if snap.shipment.is_none() {
        let mut ship = serde_json::json!({ "movementId": transfer_id, "lineItems": items });
        if let Some(n) = request.tracking_number.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            let mut t = serde_json::json!({ "trackingNumber": n });
            if let Some(c) = request.tracking_company.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                t["company"] = c.into();
            }
            ship["trackingInput"] = t;
        }
        let resp = crate::graphql_request(&domain, SHIP, Some(serde_json::json!({ "input": ship, "key": format!("{key}-ship") })))
            .await
            .map_err(|e| partial("shipping it", crate::scope_denied(e, &domain, "write_inventory_shipments", "transfer shipment")))?;
        if let Some(e) = user_error(&resp, "inventoryShipmentCreateInTransit") {
            return Err(partial("shipping it", e));
        }
        snap = snapshot(&domain, &transfer_id).await.map_err(|e| partial("reading it back", e))?;
    }

    // 3 · Receive everything still unreceived at the destination ("Move now" only).
    let mut received = false;
    if request.receive_now {
        let (shipment_id, _, lines) = snap.shipment.clone().ok_or_else(|| partial("shipping it", "no shipment was returned".into()))?;
        let open: Vec<serde_json::Value> = lines
            .iter()
            .filter(|(_, unreceived)| *unreceived > 0)
            .map(|(id, q)| serde_json::json!({ "shipmentLineItemId": id, "quantity": q, "reason": "ACCEPTED" }))
            .collect();
        if !open.is_empty() {
            let resp = crate::graphql_request(&domain, RECEIVE, Some(serde_json::json!({ "id": shipment_id, "items": open, "key": format!("{key}-recv") })))
                .await
                .map_err(|e| partial("receiving it", crate::scope_denied(e, &domain, "write_inventory_shipments_received_items", "transfer receiving")))?;
            if let Some(e) = user_error(&resp, "inventoryShipmentReceive") {
                return Err(partial("receiving it", e));
            }
            snap = snapshot(&domain, &transfer_id).await.map_err(|e| partial("reading it back", e))?;
        }
        received = true;
    }

    let checks: Vec<Change> = request
        .lines
        .iter()
        .flat_map(|l| {
            [&request.origin_location_id, &request.destination_location_id].map(|loc| Change {
                inventory_item_id: l.inventory_item_id.clone(),
                location_id: loc.clone(),
                delta: 0,
                change_from: 0,
            })
        })
        .collect();
    let levels = read_levels(&domain, &checks).await?;
    Ok(TransferResult { transfer_id, name: snap.name, status: snap.status, received, levels })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(lines: Vec<(u32, i64)>) -> TransferRequest {
        TransferRequest {
            store_id: "b2b".into(),
            origin_location_id: "gid://shopify/Location/1".into(),
            destination_location_id: "gid://shopify/Location/2".into(),
            lines: lines.into_iter().map(|(i, q)| TransferLine { inventory_item_id: format!("gid://shopify/InventoryItem/{i}"), quantity: q }).collect(),
            reference: None,
            note: None,
            receive_now: true,
            tracking_company: None,
            tracking_number: None,
            idempotency_key: "550e8400-e29b-41d4".into(),
        }
    }

    #[test]
    fn validates() {
        assert!(validate(&req(vec![(1, 4)])).is_ok());
        assert!(validate(&req(vec![])).is_err());
        assert!(validate(&req(vec![(1, 0)])).is_err());
        assert!(validate(&req(vec![(1, 1), (1, 2)])).is_err());
        assert!(validate(&TransferRequest { destination_location_id: "gid://shopify/Location/1".into(), ..req(vec![(1, 1)]) }).is_err());
        assert!(validate(&TransferRequest { idempotency_key: "x".into(), ..req(vec![(1, 1)]) }).is_err());
    }

    #[test]
    fn parses_snapshot_and_errors() {
        let r = serde_json::json!({"data": {"inventoryTransfer": {"id": "gid://shopify/InventoryTransfer/9", "name": "#T0012", "status": "IN_PROGRESS",
            "shipments": {"nodes": [{"id": "gid://shopify/InventoryShipment/5", "status": "IN_TRANSIT", "lineItems": {"nodes": [
                {"id": "gid://shopify/InventoryShipmentLineItem/50", "quantity": 4, "unreceivedQuantity": 4, "inventoryItem": {"id": "gid://shopify/InventoryItem/1"}}]}}]}}}});
        let s = parse_snapshot(&r).unwrap();
        assert_eq!((s.name.as_str(), s.shipment.as_ref().unwrap().2[0].1), ("#T0012", 4));
        let none = serde_json::json!({"data": {"inventoryTransfer": {"id": "x", "name": "#T1", "status": "READY_TO_SHIP", "shipments": {"nodes": []}}}});
        assert_eq!(parse_snapshot(&none).unwrap().shipment, None);
        let e = serde_json::json!({"data": {"inventoryTransferCreateAsReadyToShip": {"userErrors": [{"field": ["input"], "message": "nope", "code": "INVENTORY_STATE_NOT_ACTIVE"}]}}});
        assert!(user_error(&e, "inventoryTransferCreateAsReadyToShip").unwrap().starts_with("An item isn't stocked"));
    }
}

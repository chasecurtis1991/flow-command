//! Relative stock adjustments on one inventory item at one location (`inventoryAdjustQuantities`).
//!
//! Safety rails: the store is explicit (never the mutable active store), the reason is whitelisted, the caller's
//! last-seen quantity is sent as `changeFromQuantity` (Shopify rejects the write if the count moved), and the
//! caller-supplied idempotency key makes a retry after an uncertain network failure a no-op instead of a second
//! adjustment. After the write the level is re-read so the UI shows Shopify's count, not our arithmetic.

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
/// ponytail: sanity cap on one manual adjustment; raise if someone legitimately receives more in one go.
const MAX_DELTA: i64 = 100_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustRequest {
    pub store_id: String,
    pub inventory_item_id: String,
    pub location_id: String,
    pub delta: i64,
    pub reason: String,
    /// The `available` count the user saw; Shopify refuses the change if it no longer matches.
    pub change_from: i64,
    /// One key per reviewed proposal; reuse it on retry.
    pub idempotency_key: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdjustResult {
    pub delta: i64,
    pub available: i64,
    pub on_hand: i64,
}

fn validate(r: &AdjustRequest) -> Result<(), String> {
    if r.delta == 0 {
        return Err("Adjustment is 0 — nothing to change.".into());
    }
    if r.delta.abs() > MAX_DELTA {
        return Err(format!("Adjustment of {} is over the {MAX_DELTA}-unit limit.", r.delta));
    }
    if !REASONS.contains(&r.reason.as_str()) {
        return Err(format!("Unsupported reason: {}", r.reason));
    }
    if !r.inventory_item_id.starts_with("gid://shopify/InventoryItem/") || !r.location_id.starts_with("gid://shopify/Location/") {
        return Err("Missing inventory item or location id — sync inventory and try again.".into());
    }
    if r.idempotency_key.trim().len() < 8 {
        return Err("Missing idempotency key.".into());
    }
    Ok(())
}

const MUTATION: &str = "mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }";
const LEVEL_QUERY: &str = "query Level($item: ID!, $loc: ID!) { inventoryItem(id: $item) { inventoryLevel(locationId: $loc) { quantities(names: [\"available\", \"on_hand\"]) { name quantity } } } }";

fn user_error(resp: &serde_json::Value) -> Option<String> {
    let errs = resp["data"]["inventoryAdjustQuantities"]["userErrors"].as_array()?;
    let first = errs.first()?;
    let msg = first["message"].as_str().unwrap_or("Shopify rejected the adjustment");
    let code = first["code"].as_str().unwrap_or("");
    let l = msg.to_lowercase();
    Some(if code.contains("CHANGE_FROM") || l.contains("compare") || l.contains("changefrom") || l.contains("change_from") {
        format!("The count changed in Shopify since it was loaded — sync and review again. ({msg})")
    } else {
        msg.to_string()
    })
}

fn level_quantities(resp: &serde_json::Value) -> Option<(i64, i64)> {
    let qs = resp["data"]["inventoryItem"]["inventoryLevel"]["quantities"].as_array()?;
    let get = |n: &str| qs.iter().find(|q| q["name"] == n).and_then(|q| q["quantity"].as_i64());
    Some((get("available")?, get("on_hand")?))
}

#[tauri::command]
pub async fn adjust_inventory(request: AdjustRequest) -> Result<AdjustResult, String> {
    validate(&request)?;
    let domain = crate::store_by_id(&request.store_id)?.domain;
    let vars = serde_json::json!({
        "key": request.idempotency_key,
        "input": {
            "name": "available",
            "reason": request.reason,
            "changes": [{
                "inventoryItemId": request.inventory_item_id,
                "locationId": request.location_id,
                "delta": request.delta,
                "changeFromQuantity": request.change_from,
            }],
        },
    });
    let resp = crate::graphql_request(&domain, MUTATION, Some(vars))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "write_inventory", "inventory write"))?;
    if let Some(e) = user_error(&resp) {
        return Err(e);
    }
    if resp["data"]["inventoryAdjustQuantities"]["inventoryAdjustmentGroup"].is_null() {
        return Err("Shopify returned no adjustment record — sync to check whether the change applied before retrying.".into());
    }
    let level = crate::graphql_request(
        &domain,
        LEVEL_QUERY,
        Some(serde_json::json!({ "item": request.inventory_item_id, "loc": request.location_id })),
    )
    .await
    .map_err(|e| format!("Adjustment applied, but re-reading the count failed — sync to see it. ({e})"))?;
    let (available, on_hand) = level_quantities(&level)
        .ok_or("Adjustment applied, but Shopify returned no count — sync to see it.")?;
    Ok(AdjustResult { delta: request.delta, available, on_hand })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> AdjustRequest {
        AdjustRequest {
            store_id: "retail".into(),
            inventory_item_id: "gid://shopify/InventoryItem/1".into(),
            location_id: "gid://shopify/Location/2".into(),
            delta: -2,
            reason: "damaged".into(),
            change_from: 9,
            idempotency_key: "4f5b6ebf-143c-4da5".into(),
        }
    }

    #[test]
    fn validate_guards_inputs() {
        assert!(validate(&req()).is_ok());
        assert!(validate(&AdjustRequest { delta: 0, ..req() }).is_err());
        assert!(validate(&AdjustRequest { delta: MAX_DELTA + 1, ..req() }).is_err());
        assert!(validate(&AdjustRequest { reason: "movement_created".into(), ..req() }).is_err());
        assert!(validate(&AdjustRequest { location_id: "".into(), ..req() }).is_err());
        assert!(validate(&AdjustRequest { idempotency_key: "".into(), ..req() }).is_err());
    }

    #[test]
    fn parses_user_errors_and_levels() {
        let stale = serde_json::json!({"data": {"inventoryAdjustQuantities": {"inventoryAdjustmentGroup": null,
            "userErrors": [{"field": ["input"], "message": "The specified compare quantity does not match", "code": "CHANGE_FROM_QUANTITY_STALE"}]}}});
        assert!(user_error(&stale).unwrap().starts_with("The count changed"));
        let ok = serde_json::json!({"data": {"inventoryAdjustQuantities": {"inventoryAdjustmentGroup": {"id": "x"}, "userErrors": []}}});
        assert_eq!(user_error(&ok), None);
        let level = serde_json::json!({"data": {"inventoryItem": {"inventoryLevel": {"quantities": [
            {"name": "available", "quantity": 7}, {"name": "on_hand", "quantity": 9}]}}}});
        assert_eq!(level_quantities(&level), Some((7, 9)));
    }
}

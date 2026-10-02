//! One customer for the Customers detail panel: contact, address, marketing consent, B2B company, note, tags and the
//! 10 most recent orders.
//!
//! Uses `email` / `phone` / `emailMarketingConsent` (deprecated in newer API versions, current on the pinned 2026-01).

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerOrder {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub financial_status: Option<String>,
    pub fulfillment_status: Option<String>,
    pub cancelled: bool,
    /// "128.00 USD"
    pub total: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDetail {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub created_at: String,
    pub note: Option<String>,
    pub tags: Vec<String>,
    /// ENABLED (has an account) | DISABLED | INVITED | DECLINED
    pub state: Option<String>,
    pub verified_email: bool,
    pub tax_exempt: bool,
    pub orders_count: i64,
    /// "612.00 USD"
    pub amount_spent: String,
    /// Default address lines joined with "\n".
    pub address: Option<String>,
    /// SUBSCRIBED | NOT_SUBSCRIBED | UNSUBSCRIBED | PENDING | …
    pub email_marketing: Option<String>,
    pub sms_marketing: Option<String>,
    /// B2B companies this customer is a contact for (falls back to the address company).
    pub companies: Vec<String>,
    pub recent_orders: Vec<CustomerOrder>,
}

const QUERY: &str = "query C($id: ID!) { customer(id: $id) { id displayName email phone createdAt note tags state verifiedEmail taxExempt numberOfOrders amountSpent { amount currencyCode } defaultAddress { formatted(withName: false) company } emailMarketingConsent { marketingState } smsMarketingConsent { marketingState } companyContactProfiles { company { name } } orders(first: 10, sortKey: CREATED_AT, reverse: true) { nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt currentTotalPriceSet { shopMoney { amount currencyCode } } } } } }";

fn s(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from)
}
fn money(v: &serde_json::Value) -> String {
    match (s(&v["amount"]), s(&v["currencyCode"])) {
        (Some(a), Some(c)) => format!("{a} {c}"),
        _ => String::new(),
    }
}

fn parse(resp: &serde_json::Value) -> Option<CustomerDetail> {
    let c = &resp["data"]["customer"];
    if c.is_null() {
        return None;
    }
    let mut companies: Vec<String> = c["companyContactProfiles"]
        .as_array()
        .map(|ps| ps.iter().filter_map(|p| s(&p["company"]["name"])).collect())
        .unwrap_or_default();
    if companies.is_empty() {
        companies.extend(s(&c["defaultAddress"]["company"]));
    }
    Some(CustomerDetail {
        id: s(&c["id"])?,
        display_name: s(&c["displayName"]).unwrap_or_else(|| "(no name)".into()),
        email: s(&c["email"]),
        phone: s(&c["phone"]),
        created_at: s(&c["createdAt"])?,
        note: s(&c["note"]),
        tags: c["tags"].as_array().map(|ts| ts.iter().filter_map(s).collect()).unwrap_or_default(),
        state: s(&c["state"]),
        verified_email: c["verifiedEmail"].as_bool().unwrap_or(false),
        tax_exempt: c["taxExempt"].as_bool().unwrap_or(false),
        // numberOfOrders is an UnsignedInt64 serialised as a string
        orders_count: c["numberOfOrders"].as_str().and_then(|n| n.parse().ok()).or_else(|| c["numberOfOrders"].as_i64()).unwrap_or(0),
        amount_spent: money(&c["amountSpent"]),
        address: c["defaultAddress"]["formatted"]
            .as_array()
            .map(|ls| ls.iter().filter_map(|l| l.as_str()).collect::<Vec<_>>().join("\n"))
            .filter(|a| !a.trim().is_empty()),
        email_marketing: s(&c["emailMarketingConsent"]["marketingState"]),
        sms_marketing: s(&c["smsMarketingConsent"]["marketingState"]),
        companies,
        recent_orders: c["orders"]["nodes"]
            .as_array()
            .map(|os| {
                os.iter()
                    .filter_map(|o| {
                        Some(CustomerOrder {
                            id: s(&o["id"])?,
                            name: s(&o["name"])?,
                            created_at: s(&o["createdAt"])?,
                            financial_status: s(&o["displayFinancialStatus"]),
                            fulfillment_status: s(&o["displayFulfillmentStatus"]),
                            cancelled: !o["cancelledAt"].is_null(),
                            total: money(&o["currentTotalPriceSet"]["shopMoney"]),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn get_customer(store_id: String, customer_id: String) -> Result<CustomerDetail, String> {
    if !customer_id.starts_with("gid://shopify/Customer/") {
        return Err("Missing customer id.".into());
    }
    let domain = crate::store_by_id(&store_id)?.domain;
    let resp = crate::graphql_request(&domain, QUERY, Some(serde_json::json!({ "id": customer_id })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "read_customers", "customer"))?;
    parse(&resp).ok_or_else(|| "Customer not found.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_customer() {
        let r = serde_json::json!({"data": {"customer": {"id": "gid://shopify/Customer/1", "displayName": "Marisol Ortega", "email": "m@x.com", "phone": null,
            "createdAt": "2025-01-01T00:00:00Z", "note": " ", "tags": ["vip"], "state": "ENABLED", "verifiedEmail": true, "taxExempt": false,
            "numberOfOrders": "8", "amountSpent": {"amount": "612.0", "currencyCode": "USD"},
            "defaultAddress": {"formatted": ["2214 Alder St", "Portland OR 97214", "United States"], "company": "Ortega Botanicals"},
            "emailMarketingConsent": {"marketingState": "SUBSCRIBED"}, "smsMarketingConsent": null, "companyContactProfiles": [],
            "orders": {"nodes": [{"id": "gid://shopify/Order/9", "name": "#R-10482", "createdAt": "2026-10-01T00:00:00Z", "displayFinancialStatus": "PAID",
                "displayFulfillmentStatus": "UNFULFILLED", "cancelledAt": null, "currentTotalPriceSet": {"shopMoney": {"amount": "128.0", "currencyCode": "USD"}}}]}}}});
        let c = parse(&r).unwrap();
        assert_eq!((c.orders_count, c.amount_spent.as_str(), c.note.as_deref()), (8, "612.0 USD", None));
        assert_eq!(c.address.as_deref(), Some("2214 Alder St\nPortland OR 97214\nUnited States"));
        assert_eq!((c.companies[0].as_str(), c.email_marketing.as_deref(), c.sms_marketing.as_deref()), ("Ortega Botanicals", Some("SUBSCRIBED"), None));
        assert_eq!((c.recent_orders[0].name.as_str(), c.recent_orders[0].total.as_str()), ("#R-10482", "128.0 USD"));
        assert!(parse(&serde_json::json!({"data": {"customer": null}})).is_none());
    }
}

use serde::{Deserialize, Serialize};
use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const KEYCHAIN_SERVICE: &str = "com.flowgardens.command";
const KEY_CLIENT_ID: &str = "shopify_client_id";
const KEY_CLIENT_SECRET: &str = "shopify_client_secret";
const KEY_ACTIVE_SHOP: &str = "shopify_active_shop";

/// Real Plus store myshopify domains (not the vanity names in some docs).
const SHOP_RETAIL: &str = "3wvfyr-1i.myshopify.com";
const SHOP_B2B: &str = "b8h8vg-ij.myshopify.com";
const SHOP_BULK: &str = "fg-craft-flower.myshopify.com";

// Token cache
struct TokenCache {
    tokens: HashMap<String, CachedToken>,
}

struct CachedToken {
    token: String,
    expires_at: SystemTime,
}

fn token_cache() -> &'static Mutex<TokenCache> {
    static CACHE: OnceLock<Mutex<TokenCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(TokenCache {
        tokens: HashMap::new(),
    }))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShopifyCredentials {
    client_id: String,
    client_secret: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreInfo {
    id: String,
    label: String,
    domain: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    scope: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShopInfo {
    shop_name: Option<String>,
    products_count: Option<i32>,
    status: String,
    shop_domain: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub display_financial_status: Option<String>,
    pub display_fulfillment_status: Option<String>,
    pub total_price: String,
    pub customer_name: Option<String>,
    pub customer_email: Option<String>,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub cancelled: bool,
}

/// One page of the orders connection plus the (cheap) filtered count, so the UI can page honestly.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdersPage {
    pub orders: Vec<Order>,
    pub has_next_page: bool,
    pub has_previous_page: bool,
    /// Cursor of the last edge; pass back as `after` to fetch the next page.
    pub end_cursor: Option<String>,
    /// `ordersCount(query, limit: 10000)`; None when Shopify did not return it.
    pub total_count: Option<i64>,
    /// EXACT, or AT_LEAST once the count hits the 10,000 limit.
    pub total_precision: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDetail {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub display_financial_status: Option<String>,
    pub display_fulfillment_status: Option<String>,
    pub total_price: String,
    pub subtotal_price: String,
    pub total_tax: String,
    pub customer_name: Option<String>,
    pub customer_email: Option<String>,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub cancelled: bool,
    pub total_shipping: Option<String>,
    pub note: Option<String>,
    /// Formatted shipping address lines joined with "\n".
    pub shipping_address: Option<String>,
    pub customer_orders_count: Option<u64>,
    /// Shopify `sourceName` (web, pos, shopify_draft_order, …).
    pub channel: Option<String>,
    pub line_items: Vec<LineItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LineItem {
    pub title: String,
    pub sku: Option<String>,
    pub quantity: i32,
    pub price: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryLevel {
    pub location: String,
    pub available: i64,
    pub on_hand: i64,
    pub committed: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryVariant {
    pub id: String,
    pub product_title: String,
    /// None when Shopify's title is "Default Title".
    pub variant_title: Option<String>,
    pub sku: Option<String>,
    /// ACTIVE | DRAFT | ARCHIVED
    pub product_status: String,
    pub tracked: bool,
    /// inventoryQuantity across all locations.
    pub available: i64,
    /// Empty when the products-only fallback was used.
    pub levels: Vec<InventoryLevel>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryResult {
    pub variants: Vec<InventoryVariant>,
    /// Unique location names, first-seen order.
    pub locations: Vec<String>,
    /// Set when the full query was denied (scope) and the products-only fallback was used.
    pub levels_error: Option<String>,
    /// True when the 15-page cap was hit with more pages remaining.
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductOption {
    pub name: String,
    pub values: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProduct {
    pub id: String,
    pub title: String,
    pub handle: String,
    /// ACTIVE | DRAFT | ARCHIVED
    pub status: String,
    /// None when the merchant left the type blank.
    pub product_type: Option<String>,
    pub vendor: Option<String>,
    pub tags: Vec<String>,
    pub variant_count: i64,
    /// priceRangeV2.minVariantPrice as "24.00 USD" (same shape as Order.total_price); empty if missing.
    pub min_price: String,
    pub max_price: String,
    pub total_inventory: i64,
    pub tracks_inventory: bool,
    /// Featured media preview scaled to ≤480px (crisp on Retina swatches and grid cards); None when the product has no media.
    pub image_url: Option<String>,
    /// Empty when the product only has the default variant.
    pub options: Vec<ProductOption>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResult {
    pub products: Vec<CatalogProduct>,
    /// True when the page cap was hit with more pages remaining.
    pub truncated: bool,
}

fn keychain_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| format!("Keychain error: {e}"))
}

fn known_stores() -> Vec<StoreInfo> {
    vec![
        StoreInfo {
            id: "retail".into(),
            label: "Retail".into(),
            domain: SHOP_RETAIL.into(),
        },
        StoreInfo {
            id: "b2b".into(),
            label: "B2B / Wholesale".into(),
            domain: SHOP_B2B.into(),
        },
        StoreInfo {
            id: "bulk".into(),
            label: "Bulk / Craft Flower".into(),
            domain: SHOP_BULK.into(),
        },
    ]
}

#[tauri::command]
fn ping() -> String {
    "Flow Command is running ✓".to_string()
}

#[tauri::command]
fn list_stores() -> Vec<StoreInfo> {
    known_stores()
}

#[tauri::command]
fn get_active_store() -> Result<StoreInfo, String> {
    let stores = known_stores();
    let id = keychain_entry(KEY_ACTIVE_SHOP)
        .and_then(|e| e.get_password().map_err(|err| err.to_string()))
        .unwrap_or_else(|_| "retail".to_string());
    stores
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Active store not found".to_string())
}

#[tauri::command]
fn set_active_store(store_id: String) -> Result<StoreInfo, String> {
    let store = known_stores()
        .into_iter()
        .find(|s| s.id == store_id)
        .ok_or_else(|| format!("Unknown store id: {store_id}"))?;
    keychain_entry(KEY_ACTIVE_SHOP)?
        .set_password(&store.id)
        .map_err(|e| format!("Failed to save active store: {e}"))?;
    Ok(store)
}

#[tauri::command]
fn save_shopify_credentials(client_id: String, client_secret: String) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Client ID and secret are required".to_string());
    }

    keychain_entry(KEY_CLIENT_ID)?
        .set_password(&client_id)
        .map_err(|e| format!("Failed to save client_id: {e}"))?;
    keychain_entry(KEY_CLIENT_SECRET)?
        .set_password(&client_secret)
        .map_err(|e| format!("Failed to save client_secret: {e}"))?;

    let saved = get_shopify_credentials()?;
    if saved.client_id != client_id {
        return Err("Keychain write did not stick — check apple-native keyring feature".to_string());
    }

    Ok("Credentials saved and verified in Keychain".to_string())
}

#[tauri::command]
fn get_shopify_credentials() -> Result<ShopifyCredentials, String> {
    let client_id = keychain_entry(KEY_CLIENT_ID)?
        .get_password()
        .map_err(|e| {
            format!(
                "Client ID not found in Keychain ({e}). Open Settings and Save to Keychain again."
            )
        })?;
    let client_secret = keychain_entry(KEY_CLIENT_SECRET)?
        .get_password()
        .map_err(|e| {
            format!(
                "Client secret not found in Keychain ({e}). Open Settings and Save to Keychain again."
            )
        })?;

    Ok(ShopifyCredentials {
        client_id,
        client_secret,
    })
}

// Get cached token or fetch new one
async fn get_cached_token(shop_domain: &str) -> Result<String, String> {
    // Check cache first
    {
        let cache = token_cache().lock().unwrap();
        if let Some(cached) = cache.tokens.get(shop_domain) {
            if SystemTime::now() < cached.expires_at {
                return Ok(cached.token.clone());
            }
        }
    }

    // Fetch new token
    let token = fetch_new_token(shop_domain).await?;
    
    // Cache it (23 hours expiry)
    let expires_at = SystemTime::now() + Duration::from_secs(23 * 3600);
    {
        let mut cache = token_cache().lock().unwrap();
        cache.tokens.insert(
            shop_domain.to_string(),
            CachedToken {
                token: token.clone(),
                expires_at,
            },
        );
    }

    Ok(token)
}

// Fetch new token from Shopify
async fn fetch_new_token(shop_domain: &str) -> Result<String, String> {
    let creds = get_shopify_credentials()?;
    let client = reqwest::Client::new();
    let token_url = format!("https://{shop_domain}/admin/oauth/access_token");

    let params = [
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("grant_type", "client_credentials"),
    ];

    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read response".to_string());
        let truncated = if body.len() > 200 {
            format!("{}...", &body[..200])
        } else {
            body
        };
        return Err(format!("Token failed ({}): {}", status, truncated));
    }

    let token_data: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token: {e}"))?;

    Ok(token_data.access_token)
}

// Legacy public command (for Settings test)
#[tauri::command]
async fn fetch_shopify_token(shop_domain: String) -> Result<String, String> {
    fetch_new_token(&shop_domain).await
}

// GraphQL helper (no variables)
async fn graphql_query(shop_domain: &str, query: &str) -> Result<serde_json::Value, String> {
    graphql_request(shop_domain, query, None).await
}

// GraphQL helper; `variables` lets user-supplied strings (search text, cursors) travel as JSON
// instead of being spliced into the query document.
async fn graphql_request(
    shop_domain: &str,
    query: &str,
    variables: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let token = get_cached_token(shop_domain).await?;
    let client = reqwest::Client::new();
    let graphql_url = format!("https://{}/admin/api/2026-01/graphql.json", shop_domain);

    let body = match variables {
        Some(vars) => serde_json::json!({ "query": query, "variables": vars }),
        None => serde_json::json!({ "query": query }),
    };

    let response = client
        .post(&graphql_url)
        .header("X-Shopify-Access-Token", &token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GraphQL request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read response".to_string());
        let truncated = if body.len() > 200 {
            format!("{}...", &body[..200])
        } else {
            body
        };
        return Err(format!("GraphQL failed ({}): {}", status, truncated));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(errors) = result.get("errors") {
        let err_str = errors.to_string();
        let truncated = if err_str.len() > 200 {
            format!("{}...", &err_str[..200])
        } else {
            err_str
        };
        return Err(format!("GraphQL errors: {}", truncated));
    }

    Ok(result)
}

#[tauri::command]
async fn fetch_shop_info(store_id: Option<String>) -> Result<ShopInfo, String> {
    // Optional store_id lets Home check every store's connection, not just the active one.
    let store = match store_id {
        Some(id) => known_stores()
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("Unknown store id: {id}"))?,
        None => get_active_store().unwrap_or(StoreInfo {
            id: "retail".into(),
            label: "Retail".into(),
            domain: SHOP_RETAIL.into(),
        }),
    };
    let shop_domain = store.domain;

    let query = r#"
        {
            shop {
                name
            }
        }
    "#;

    let result = graphql_query(&shop_domain, query).await?;

    let shop_name = result["data"]["shop"]["name"]
        .as_str()
        .map(|s| s.to_string());

    Ok(ShopInfo {
        shop_name,
        products_count: None,
        status: "Connected ✓".to_string(),
        shop_domain,
    })
}

// Each order node costs 4 points (Order + MoneyBag + MoneyV2 + Customer), so a 200-row page is
// 2 + 200×4 + 1 (ordersCount) = 803 — under Shopify's 1,000-point single-query cap. 250 would not be.
const ORDERS_MAX_PAGE_SIZE: i32 = 200;
const ORDERS_DEFAULT_PAGE_SIZE: i32 = 50;
/// `ordersCount` refuses to count past this; the UI shows "10,000+" when precision is AT_LEAST.
const ORDERS_COUNT_LIMIT: i32 = 10_000;
/// Subset of `OrderSortKeys` the Orders table exposes; anything else is rejected before it reaches Shopify.
const ORDER_SORT_KEYS: [&str; 8] = [
    "CREATED_AT",
    "UPDATED_AT",
    "PROCESSED_AT",
    "ORDER_NUMBER",
    "CUSTOMER_NAME",
    "TOTAL_PRICE",
    "FINANCIAL_STATUS",
    "FULFILLMENT_STATUS",
];

const ORDERS_PAGE_QUERY: &str = r#"
query OrdersPage($first: Int!, $after: String, $sortKey: OrderSortKeys, $reverse: Boolean, $query: String, $countLimit: Int) {
    orders(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, query: $query) {
        pageInfo { hasNextPage hasPreviousPage endCursor }
        edges {
            node {
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                closed
                cancelledAt
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { displayName email }
            }
        }
    }
    ordersCount(query: $query, limit: $countLimit) { count precision }
}
"#;

fn parse_orders(result: &serde_json::Value) -> Vec<Order> {
    result["data"]["orders"]["edges"]
        .as_array()
        .map(|edges| {
            edges
                .iter()
                .filter_map(|edge| {
                    let node = &edge["node"];
                    Some(Order {
                        id: node["id"].as_str()?.to_string(),
                        name: node["name"].as_str()?.to_string(),
                        created_at: node["createdAt"].as_str()?.to_string(),
                        display_financial_status: node["displayFinancialStatus"]
                            .as_str()
                            .map(|s| s.to_string()),
                        display_fulfillment_status: node["displayFulfillmentStatus"]
                            .as_str()
                            .map(|s| s.to_string()),
                        total_price: format!(
                            "{} {}",
                            node["totalPriceSet"]["shopMoney"]["amount"].as_str()?,
                            node["totalPriceSet"]["shopMoney"]["currencyCode"].as_str()?
                        ),
                        customer_name: node["customer"]["displayName"]
                            .as_str()
                            .map(|s| s.to_string()),
                        customer_email: node["customer"]["email"].as_str().map(|s| s.to_string()),
                        closed: node["closed"].as_bool().unwrap_or(false),
                        cancelled: !node["cancelledAt"].is_null(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_orders_page(result: &serde_json::Value) -> Result<OrdersPage, String> {
    if !result["data"]["orders"]["edges"].is_array() {
        return Err("Invalid orders response".to_string());
    }
    let info = &result["data"]["orders"]["pageInfo"];
    let count = &result["data"]["ordersCount"];
    Ok(OrdersPage {
        orders: parse_orders(result),
        has_next_page: info["hasNextPage"].as_bool().unwrap_or(false),
        has_previous_page: info["hasPreviousPage"].as_bool().unwrap_or(false),
        end_cursor: info["endCursor"].as_str().map(String::from),
        total_count: count["count"].as_i64(),
        total_precision: count["precision"].as_str().map(String::from),
    })
}

/// Normalises the page-size / sort arguments shared by both orders commands.
fn orders_page_args(
    first: Option<i32>,
    sort_key: Option<&str>,
    reverse: Option<bool>,
) -> Result<(i32, String, bool), String> {
    let first = first.unwrap_or(ORDERS_DEFAULT_PAGE_SIZE).clamp(1, ORDERS_MAX_PAGE_SIZE);
    let sort_key = sort_key.unwrap_or("CREATED_AT");
    if !ORDER_SORT_KEYS.contains(&sort_key) {
        return Err(format!("Unsupported order sort key: {sort_key}"));
    }
    Ok((first, sort_key.to_string(), reverse.unwrap_or(true)))
}

async fn fetch_orders_page(
    shop_domain: &str,
    first: i32,
    after: Option<&str>,
    sort_key: &str,
    reverse: bool,
    query: Option<&str>,
) -> Result<OrdersPage, String> {
    let query = query.map(str::trim).filter(|q| !q.is_empty());
    let variables = serde_json::json!({
        "first": first,
        "after": after,
        "sortKey": sort_key,
        "reverse": reverse,
        "query": query,
        "countLimit": ORDERS_COUNT_LIMIT,
    });
    let result = graphql_request(shop_domain, ORDERS_PAGE_QUERY, Some(variables)).await?;
    parse_orders_page(&result)
}

// Most recent orders for the active store (Home KPIs, sidebar badge, ⌘K search).
#[tauri::command]
async fn list_orders(first: Option<i32>) -> Result<Vec<Order>, String> {
    let shop_domain = get_active_store()?.domain;
    let (first, sort_key, reverse) = orders_page_args(first, None, None)?;
    Ok(fetch_orders_page(&shop_domain, first, None, &sort_key, reverse, None)
        .await?
        .orders)
}

// One page of orders for the Orders table: cursor pagination, page size (≤200), Shopify sort key
// and search-syntax `query` (e.g. "status:open fulfillment_status:unfulfilled Ortega").
#[tauri::command]
async fn list_orders_page(
    first: Option<i32>,
    after: Option<String>,
    sort_key: Option<String>,
    reverse: Option<bool>,
    query: Option<String>,
) -> Result<OrdersPage, String> {
    let shop_domain = get_active_store()?.domain;
    let (first, sort_key, reverse) = orders_page_args(first, sort_key.as_deref(), reverse)?;
    fetch_orders_page(
        &shop_domain,
        first,
        after.as_deref().filter(|c| !c.is_empty()),
        &sort_key,
        reverse,
        query.as_deref(),
    )
    .await
}

// Get single order with line items (using GID)
#[tauri::command]
async fn get_order(order_id: String) -> Result<OrderDetail, String> {
    let active = get_active_store()?;
    let shop_domain = active.domain;

    let query = format!(
        r#"
        {{
            order(id: "{}") {{
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet {{
                    shopMoney {{
                        amount
                        currencyCode
                    }}
                }}
                subtotalPriceSet {{
                    shopMoney {{
                        amount
                        currencyCode
                    }}
                }}
                totalTaxSet {{
                    shopMoney {{
                        amount
                        currencyCode
                    }}
                }}
                closed
                cancelledAt
                note
                sourceName
                totalShippingPriceSet {{
                    shopMoney {{
                        amount
                        currencyCode
                    }}
                }}
                shippingAddress {{
                    formatted(withName: true)
                }}
                customer {{
                    displayName
                    email
                    numberOfOrders
                }}
                lineItems(first: 100) {{
                    edges {{
                        node {{
                            title
                            sku
                            quantity
                            originalUnitPriceSet {{
                                shopMoney {{
                                    amount
                                    currencyCode
                                }}
                            }}
                        }}
                    }}
                }}
            }}
        }}
        "#,
        order_id
    );

    let result = graphql_query(&shop_domain, &query).await?;

    let order = &result["data"]["order"];
    if order.is_null() {
        return Err("Order not found".to_string());
    }

    let line_items: Vec<LineItem> = order["lineItems"]["edges"]
        .as_array()
        .ok_or("Invalid line items response")?
        .iter()
        .filter_map(|edge| {
            let node = &edge["node"];
            Some(LineItem {
                title: node["title"].as_str()?.to_string(),
                sku: node["sku"].as_str().map(|s| s.to_string()),
                quantity: node["quantity"].as_i64()? as i32,
                price: format!(
                    "{} {}",
                    node["originalUnitPriceSet"]["shopMoney"]["amount"].as_str()?,
                    node["originalUnitPriceSet"]["shopMoney"]["currencyCode"].as_str()?
                ),
            })
        })
        .collect();

    Ok(OrderDetail {
        id: order["id"].as_str().ok_or("Missing id")?.to_string(),
        name: order["name"].as_str().ok_or("Missing name")?.to_string(),
        created_at: order["createdAt"]
            .as_str()
            .ok_or("Missing createdAt")?
            .to_string(),
        display_financial_status: order["displayFinancialStatus"]
            .as_str()
            .map(|s| s.to_string()),
        display_fulfillment_status: order["displayFulfillmentStatus"]
            .as_str()
            .map(|s| s.to_string()),
        total_price: format!(
            "{} {}",
            order["totalPriceSet"]["shopMoney"]["amount"]
                .as_str()
                .ok_or("Missing total")?,
            order["totalPriceSet"]["shopMoney"]["currencyCode"]
                .as_str()
                .ok_or("Missing currency")?
        ),
        subtotal_price: format!(
            "{} {}",
            order["subtotalPriceSet"]["shopMoney"]["amount"]
                .as_str()
                .ok_or("Missing subtotal")?,
            order["subtotalPriceSet"]["shopMoney"]["currencyCode"]
                .as_str()
                .ok_or("Missing currency")?
        ),
        total_tax: format!(
            "{} {}",
            order["totalTaxSet"]["shopMoney"]["amount"]
                .as_str()
                .ok_or("Missing tax")?,
            order["totalTaxSet"]["shopMoney"]["currencyCode"]
                .as_str()
                .ok_or("Missing currency")?
        ),
        customer_name: order["customer"]["displayName"]
            .as_str()
            .map(|s| s.to_string()),
        customer_email: order["customer"]["email"].as_str().map(|s| s.to_string()),
        closed: order["closed"].as_bool().unwrap_or(false),
        cancelled: !order["cancelledAt"].is_null(),
        total_shipping: match (
            order["totalShippingPriceSet"]["shopMoney"]["amount"].as_str(),
            order["totalShippingPriceSet"]["shopMoney"]["currencyCode"].as_str(),
        ) {
            (Some(a), Some(c)) => Some(format!("{a} {c}")),
            _ => None,
        },
        note: order["note"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string()),
        shipping_address: order["shippingAddress"]["formatted"].as_array().map(|lines| {
            lines
                .iter()
                .filter_map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        }),
        customer_orders_count: order["customer"]["numberOfOrders"]
            .as_str()
            .and_then(|s| s.parse().ok()),
        channel: order["sourceName"].as_str().map(|s| s.to_string()),
        line_items,
    })
}

const INVENTORY_PAGE_CAP: usize = 15;

fn inventory_query(after: Option<&str>, with_levels: bool) -> String {
    let after = after.map_or("null".to_string(), |c| format!("\"{c}\""));
    let levels = if with_levels {
        r#"inventoryItem { tracked inventoryLevels(first: 3) { edges { node { location { name } quantities(names: ["available", "on_hand", "committed"]) { name quantity } } } } }"#
    } else {
        ""
    };
    format!(
        "query {{ productVariants(first: 100, after: {after}, sortKey: ID) {{ pageInfo {{ hasNextPage endCursor }} edges {{ node {{ id title sku inventoryQuantity product {{ title status }} {levels} }} }} }} }}"
    )
}

fn parse_variants(page: &serde_json::Value) -> Vec<InventoryVariant> {
    page["data"]["productVariants"]["edges"]
        .as_array()
        .map(|edges| {
            edges
                .iter()
                .filter_map(|edge| {
                    let node = &edge["node"];
                    let item = &node["inventoryItem"];
                    let levels = item["inventoryLevels"]["edges"]
                        .as_array()
                        .map(|ls| {
                            ls.iter()
                                .filter_map(|l| {
                                    let n = &l["node"];
                                    let qty = |name: &str| {
                                        n["quantities"]
                                            .as_array()
                                            .and_then(|qs| qs.iter().find(|q| q["name"] == name))
                                            .and_then(|q| q["quantity"].as_i64())
                                            .unwrap_or(0)
                                    };
                                    Some(InventoryLevel {
                                        location: n["location"]["name"].as_str()?.to_string(),
                                        available: qty("available"),
                                        on_hand: qty("on_hand"),
                                        committed: qty("committed"),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(InventoryVariant {
                        id: node["id"].as_str()?.to_string(),
                        product_title: node["product"]["title"].as_str()?.to_string(),
                        variant_title: node["title"]
                            .as_str()
                            .filter(|t| *t != "Default Title")
                            .map(String::from),
                        sku: node["sku"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                        product_status: node["product"]["status"].as_str()?.to_string(),
                        tracked: item["tracked"].as_bool().unwrap_or(true),
                        available: node["inventoryQuantity"].as_i64().unwrap_or(0),
                        levels,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Returns (variants, truncated). Err carries the 0-based page index that failed.
async fn fetch_inventory_pages(
    shop_domain: &str,
    with_levels: bool,
) -> Result<(Vec<InventoryVariant>, bool), (usize, String)> {
    let mut variants = Vec::new();
    let mut after: Option<String> = None;
    for page in 0..INVENTORY_PAGE_CAP {
        let result = graphql_query(shop_domain, &inventory_query(after.as_deref(), with_levels))
            .await
            .map_err(|e| (page, e))?;
        variants.extend(parse_variants(&result));
        let info = &result["data"]["productVariants"]["pageInfo"];
        match info["endCursor"].as_str() {
            Some(c) if info["hasNextPage"].as_bool().unwrap_or(false) => after = Some(c.to_string()),
            _ => return Ok((variants, false)),
        }
    }
    Ok((variants, true))
}

// List all variants with per-location inventory for active store
#[tauri::command]
async fn list_inventory() -> Result<InventoryResult, String> {
    let shop_domain = get_active_store()?.domain;

    let (mut variants, truncated, levels_error) = match fetch_inventory_pages(&shop_domain, true).await {
        Ok((v, t)) => (v, t, None),
        // Scope denial surfaces on the first page; fall back to products-only (read_products).
        Err((0, e)) if {
            let l = e.to_lowercase();
            l.contains("access") || l.contains("scope")
        } => {
            let (v, t) = fetch_inventory_pages(&shop_domain, false)
                .await
                .map_err(|(_, e)| e)?;
            (v, t, Some(e))
        }
        Err((_, e)) => return Err(e),
    };

    let mut locations: Vec<String> = Vec::new();
    for l in variants.iter().flat_map(|v| &v.levels) {
        if !locations.contains(&l.location) {
            locations.push(l.location.clone());
        }
    }

    variants.sort_by_cached_key(|v| {
        (
            v.product_title.to_lowercase(),
            v.variant_title.as_deref().unwrap_or("").to_lowercase(),
        )
    });

    Ok(InventoryResult {
        variants,
        locations,
        levels_error,
        truncated,
    })
}

// Each product node costs ~11 points (node + variantsCount + priceRangeV2×3 + featuredMedia×3 + options×3),
// so 50 per page stays well under Shopify's 1,000-point single-query cap.
const CATALOG_PAGE_SIZE: usize = 50;
const CATALOG_PAGE_CAP: usize = 20;

fn catalog_query(after: Option<&str>) -> String {
    let after = after.map_or("null".to_string(), |c| format!("\"{c}\""));
    format!(
        "query {{ products(first: {CATALOG_PAGE_SIZE}, after: {after}, sortKey: TITLE) {{ pageInfo {{ hasNextPage endCursor }} edges {{ node {{ id title handle status productType vendor tags totalInventory tracksInventory hasOnlyDefaultVariant updatedAt variantsCount {{ count }} priceRangeV2 {{ minVariantPrice {{ amount currencyCode }} maxVariantPrice {{ amount currencyCode }} }} featuredMedia {{ preview {{ image {{ url(transform: {{maxWidth: 480, maxHeight: 480}}) }} }} }} options(first: 3) {{ name values }} }} }} }} }}"
    )
}

fn parse_products(page: &serde_json::Value) -> Vec<CatalogProduct> {
    let money = |m: &serde_json::Value| match (m["amount"].as_str(), m["currencyCode"].as_str()) {
        (Some(a), Some(c)) => format!("{a} {c}"),
        _ => String::new(),
    };
    let non_empty = |v: &serde_json::Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let strings = |v: &serde_json::Value| -> Vec<String> {
        v.as_array()
            .map(|xs| xs.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    page["data"]["products"]["edges"]
        .as_array()
        .map(|edges| {
            edges
                .iter()
                .filter_map(|edge| {
                    let node = &edge["node"];
                    let options = if node["hasOnlyDefaultVariant"].as_bool().unwrap_or(false) {
                        Vec::new()
                    } else {
                        node["options"]
                            .as_array()
                            .map(|os| {
                                os.iter()
                                    .filter_map(|o| {
                                        Some(ProductOption {
                                            name: o["name"].as_str()?.to_string(),
                                            values: strings(&o["values"]),
                                        })
                                    })
                                    // Defensive: the placeholder option Shopify gives single-variant products.
                                    .filter(|o| !(o.name == "Title" && o.values == ["Default Title"]))
                                    .collect()
                            })
                            .unwrap_or_default()
                    };
                    Some(CatalogProduct {
                        id: node["id"].as_str()?.to_string(),
                        title: node["title"].as_str()?.to_string(),
                        handle: node["handle"].as_str().unwrap_or_default().to_string(),
                        status: node["status"].as_str()?.to_string(),
                        product_type: non_empty(&node["productType"]),
                        vendor: non_empty(&node["vendor"]),
                        tags: strings(&node["tags"]),
                        variant_count: node["variantsCount"]["count"].as_i64().unwrap_or(1),
                        min_price: money(&node["priceRangeV2"]["minVariantPrice"]),
                        max_price: money(&node["priceRangeV2"]["maxVariantPrice"]),
                        total_inventory: node["totalInventory"].as_i64().unwrap_or(0),
                        tracks_inventory: node["tracksInventory"].as_bool().unwrap_or(true),
                        image_url: non_empty(&node["featuredMedia"]["preview"]["image"]["url"]),
                        options,
                        updated_at: node["updatedAt"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Returns (products, truncated).
async fn fetch_catalog_pages(shop_domain: &str) -> Result<(Vec<CatalogProduct>, bool), String> {
    let mut products = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..CATALOG_PAGE_CAP {
        let result = graphql_query(shop_domain, &catalog_query(after.as_deref())).await?;
        products.extend(parse_products(&result));
        let info = &result["data"]["products"]["pageInfo"];
        match info["endCursor"].as_str() {
            Some(c) if info["hasNextPage"].as_bool().unwrap_or(false) => after = Some(c.to_string()),
            _ => return Ok((products, false)),
        }
    }
    Ok((products, true))
}

// List every product in the active store's catalog (title-sorted; needs read_products)
#[tauri::command]
async fn list_products() -> Result<CatalogResult, String> {
    let shop_domain = get_active_store()?.domain;

    let (mut products, truncated) = fetch_catalog_pages(&shop_domain).await.map_err(|e| {
        let l = e.to_lowercase();
        if l.contains("access denied") || l.contains("read_products") {
            format!("Shopify denied product access for {shop_domain}: the app needs the read_products scope. {e}")
        } else {
            e
        }
    })?;

    products.sort_by_cached_key(|p| p.title.to_lowercase());

    Ok(CatalogResult { products, truncated })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            list_stores,
            get_active_store,
            set_active_store,
            save_shopify_credentials,
            get_shopify_credentials,
            fetch_shopify_token,
            fetch_shop_info,
            list_orders,
            list_orders_page,
            get_order,
            list_inventory,
            list_products
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_variants_maps_fixture() {
        let page = serde_json::json!({"data": {"productVariants": {"edges": [
            {"node": {
                "id": "gid://shopify/ProductVariant/1", "title": "Large", "sku": "FG-1", "inventoryQuantity": 7,
                "product": {"title": "Rose", "status": "ACTIVE"},
                "inventoryItem": {"tracked": true, "inventoryLevels": {"edges": [{"node": {
                    "location": {"name": "Flow NC"},
                    "quantities": [
                        {"name": "available", "quantity": 7},
                        {"name": "on_hand", "quantity": 9},
                        {"name": "committed", "quantity": 2}
                    ]
                }}]}}
            }},
            {"node": {
                "id": "gid://shopify/ProductVariant/2", "title": "Default Title", "sku": null, "inventoryQuantity": 0,
                "product": {"title": "Tulip", "status": "DRAFT"}
            }}
        ]}}});

        let v = parse_variants(&page);
        assert_eq!(v.len(), 2);

        assert_eq!(v[0].product_title, "Rose");
        assert_eq!(v[0].variant_title.as_deref(), Some("Large"));
        assert_eq!(v[0].sku.as_deref(), Some("FG-1"));
        assert_eq!(v[0].product_status, "ACTIVE");
        assert!(v[0].tracked);
        assert_eq!(v[0].available, 7);
        assert_eq!(v[0].levels.len(), 1);
        assert_eq!(v[0].levels[0].location, "Flow NC");
        assert_eq!(
            (v[0].levels[0].available, v[0].levels[0].on_hand, v[0].levels[0].committed),
            (7, 9, 2)
        );

        assert_eq!(v[1].product_title, "Tulip");
        assert_eq!(v[1].variant_title, None);
        assert_eq!(v[1].sku, None);
        assert_eq!(v[1].product_status, "DRAFT");
        assert!(v[1].tracked);
        assert!(v[1].levels.is_empty());
    }

    #[test]
    fn parse_products_maps_fixture() {
        let page = serde_json::json!({"data": {"products": {"edges": [
            {"node": {
                "id": "gid://shopify/Product/1", "title": "Lifter", "handle": "lifter", "status": "ACTIVE",
                "productType": "Flower", "vendor": "Flow Gardens", "tags": ["hybrid", "cbd"],
                "totalInventory": 364, "tracksInventory": true, "hasOnlyDefaultVariant": false, "updatedAt": "2026-09-10T12:00:00Z",
                "variantsCount": {"count": 7},
                "priceRangeV2": {"minVariantPrice": {"amount": "22.0", "currencyCode": "USD"}, "maxVariantPrice": {"amount": "520.0", "currencyCode": "USD"}},
                "featuredMedia": {"preview": {"image": {"url": "https://cdn.shopify.com/lifter.jpg"}}},
                "options": [{"name": "Size", "values": ["7g", "14g", "1 lb"]}]
            }},
            {"node": {
                "id": "gid://shopify/Product/2", "title": "Bubba Kush biomass", "handle": "bubba-kush-biomass", "status": "DRAFT",
                "productType": "", "vendor": "", "tags": [],
                "totalInventory": 0, "tracksInventory": false, "hasOnlyDefaultVariant": true, "updatedAt": "2026-09-01T00:00:00Z",
                "variantsCount": {"count": 1},
                "priceRangeV2": {"minVariantPrice": {"amount": "3100.0", "currencyCode": "USD"}, "maxVariantPrice": {"amount": "3100.0", "currencyCode": "USD"}},
                "featuredMedia": null,
                "options": [{"name": "Title", "values": ["Default Title"]}]
            }}
        ]}}});

        let p = parse_products(&page);
        assert_eq!(p.len(), 2);

        assert_eq!(p[0].title, "Lifter");
        assert_eq!(p[0].status, "ACTIVE");
        assert_eq!(p[0].product_type.as_deref(), Some("Flower"));
        assert_eq!(p[0].vendor.as_deref(), Some("Flow Gardens"));
        assert_eq!(p[0].tags, ["hybrid", "cbd"]);
        assert_eq!(p[0].variant_count, 7);
        assert_eq!(p[0].min_price, "22.0 USD");
        assert_eq!(p[0].max_price, "520.0 USD");
        assert_eq!(p[0].total_inventory, 364);
        assert!(p[0].tracks_inventory);
        assert_eq!(p[0].image_url.as_deref(), Some("https://cdn.shopify.com/lifter.jpg"));
        assert_eq!(p[0].options.len(), 1);
        assert_eq!(p[0].options[0].name, "Size");
        assert_eq!(p[0].options[0].values, ["7g", "14g", "1 lb"]);

        assert_eq!(p[1].status, "DRAFT");
        assert_eq!(p[1].product_type, None);
        assert_eq!(p[1].vendor, None);
        assert!(p[1].tags.is_empty());
        assert_eq!(p[1].variant_count, 1);
        assert!(!p[1].tracks_inventory);
        assert_eq!(p[1].image_url, None);
        assert!(p[1].options.is_empty());
    }

    #[test]
    fn catalog_query_pages_by_cursor() {
        assert!(catalog_query(None).contains("after: null"));
        assert!(catalog_query(Some("abc")).contains("after: \"abc\""));
        assert!(catalog_query(None).contains("options(first: 3)"));
    }

    #[test]
    fn parse_orders_page_maps_fixture() {
        let page = serde_json::json!({"data": {
            "orders": {
                "pageInfo": {"hasNextPage": true, "hasPreviousPage": false, "endCursor": "eyJsYXN0X2lkIjoxfQ=="},
                "edges": [
                    {"cursor": "a", "node": {
                        "id": "gid://shopify/Order/1", "name": "#R-10482", "createdAt": "2026-09-12T09:41:00Z",
                        "displayFinancialStatus": "PAID", "displayFulfillmentStatus": "UNFULFILLED",
                        "closed": false, "cancelledAt": null,
                        "totalPriceSet": {"shopMoney": {"amount": "128.0", "currencyCode": "USD"}},
                        "customer": {"displayName": "Marisol Ortega", "email": "marisol.o@gmail.com"}
                    }},
                    {"cursor": "b", "node": {
                        "id": "gid://shopify/Order/2", "name": "#R-10479", "createdAt": "2026-09-11T06:00:00Z",
                        "displayFinancialStatus": "REFUNDED", "displayFulfillmentStatus": "UNFULFILLED",
                        "closed": true, "cancelledAt": "2026-09-11T07:00:00Z",
                        "totalPriceSet": {"shopMoney": {"amount": "42.0", "currencyCode": "USD"}},
                        "customer": null
                    }}
                ]
            },
            "ordersCount": {"count": 312, "precision": "EXACT"}
        }});

        let p = parse_orders_page(&page).expect("page parses");
        assert_eq!(p.orders.len(), 2);
        assert!(p.has_next_page);
        assert!(!p.has_previous_page);
        assert_eq!(p.end_cursor.as_deref(), Some("eyJsYXN0X2lkIjoxfQ=="));
        assert_eq!(p.total_count, Some(312));
        assert_eq!(p.total_precision.as_deref(), Some("EXACT"));

        assert_eq!(p.orders[0].name, "#R-10482");
        assert_eq!(p.orders[0].total_price, "128.0 USD");
        assert_eq!(p.orders[0].customer_name.as_deref(), Some("Marisol Ortega"));
        assert!(!p.orders[0].closed && !p.orders[0].cancelled);

        assert_eq!(p.orders[1].customer_name, None);
        assert_eq!(p.orders[1].customer_email, None);
        assert!(p.orders[1].closed && p.orders[1].cancelled);
    }

    #[test]
    fn parse_orders_page_tolerates_missing_count_and_rejects_bad_shape() {
        let page = serde_json::json!({"data": {"orders": {"pageInfo": {"hasNextPage": false}, "edges": []}}});
        let p = parse_orders_page(&page).expect("page parses");
        assert!(p.orders.is_empty());
        assert!(!p.has_next_page);
        assert_eq!(p.end_cursor, None);
        assert_eq!(p.total_count, None);

        assert!(parse_orders_page(&serde_json::json!({"data": {"orders": null}})).is_err());
    }

    #[test]
    fn orders_page_args_clamp_and_validate() {
        assert_eq!(orders_page_args(None, None, None).unwrap(), (ORDERS_DEFAULT_PAGE_SIZE, "CREATED_AT".to_string(), true));
        assert_eq!(orders_page_args(Some(0), None, None).unwrap().0, 1);
        assert_eq!(orders_page_args(Some(9_999), None, None).unwrap().0, ORDERS_MAX_PAGE_SIZE);
        assert_eq!(
            orders_page_args(Some(25), Some("TOTAL_PRICE"), Some(false)).unwrap(),
            (25, "TOTAL_PRICE".to_string(), false)
        );
        assert!(orders_page_args(None, Some("RELEVANCE"), None).is_err());
        assert!(orders_page_args(None, Some("id) { x"), None).is_err());
    }
}

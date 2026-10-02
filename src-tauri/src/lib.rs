use serde::{Deserialize, Serialize};
use keyring::Entry;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
mod inventory_adjust;
mod inventory_transfer;
mod order_fulfill;
mod order_notes;
mod order_refund;
mod variant_split;

const KEYCHAIN_SERVICE: &str = "com.flowgardens.command";
const KEY_CLIENT_ID: &str = "shopify_client_id";
const KEY_CLIENT_SECRET: &str = "shopify_client_secret";
const KEY_ACTIVE_SHOP: &str = "shopify_active_shop";
const KEY_OPENROUTER: &str = "openrouter_api_key";

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
    #[serde(default)]
    pub tags: Vec<String>,
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
    /// gid://shopify/Location/123 — the write target for adjust_inventory.
    pub location_id: String,
    pub available: i64,
    pub on_hand: i64,
    pub committed: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryVariant {
    pub id: String,
    /// gid://shopify/Product/123 — the Inventory tree groups variants under it.
    pub product_id: String,
    pub product_title: String,
    /// None when Shopify's title is "Default Title".
    pub variant_title: Option<String>,
    pub sku: Option<String>,
    /// ACTIVE | DRAFT | ARCHIVED
    pub product_status: String,
    pub tracked: bool,
    /// gid://shopify/InventoryItem/123; None when the products-only fallback ran.
    pub inventory_item_id: Option<String>,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub company: Option<String>,
    /// defaultAddress city + provinceCode joined ", " (blanks skipped); None when both are blank.
    pub location: Option<String>,
    /// numberOfOrders is an UnsignedInt64, which Shopify serialises as a JSON string; 0 when unparsable.
    pub orders_count: i64,
    /// amountSpent as "612.00 USD" (same shape as Order.total_price); empty if missing.
    pub amount_spent: String,
    pub last_order_name: Option<String>,
    pub last_order_at: Option<String>,
    pub created_at: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomersResult {
    pub customers: Vec<Customer>,
    pub has_next_page: bool,
    /// `customersCount(query, limit: 10000)`; None when Shopify did not return it.
    pub total_count: Option<i64>,
    /// EXACT, or AT_LEAST once the count hits the 10,000 limit.
    pub total_precision: Option<String>,
}

/// Just enough of a product to tell whether it is listed in another store.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPresence {
    pub id: String,
    pub handle: String,
    pub title: String,
    /// ACTIVE | DRAFT | ARCHIVED
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceResult {
    pub products: Vec<ProductPresence>,
    /// True when the page cap was hit with more pages remaining.
    pub truncated: bool,
}

/// Minimal order for Analytics day buckets; test orders are dropped before this is built.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStub {
    pub created_at: String,
    /// currentTotalPriceSet.shopMoney as "128.00 USD" (same shape as Order.total_price); empty if missing.
    pub total: String,
    pub cancelled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdersSinceResult {
    pub orders: Vec<OrderStub>,
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

fn store_by_id(store_id: &str) -> Result<StoreInfo, String> {
    known_stores()
        .into_iter()
        .find(|s| s.id == store_id)
        .ok_or_else(|| format!("Unknown store id: {store_id}"))
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
        Some(id) => store_by_id(&id)?,
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
                tags
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
        tags: order["tags"]
            .as_array()
            .map(|ts| ts.iter().filter_map(|t| t.as_str().map(String::from)).collect())
            .unwrap_or_default(),
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
        r#"inventoryItem { id tracked inventoryLevels(first: 3) { edges { node { location { id name } quantities(names: ["available", "on_hand", "committed"]) { name quantity } } } } }"#
    } else {
        ""
    };
    format!(
        "query {{ productVariants(first: 100, after: {after}, sortKey: ID) {{ pageInfo {{ hasNextPage endCursor }} edges {{ node {{ id title sku inventoryQuantity product {{ id title status }} {levels} }} }} }} }}"
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
                                        location_id: n["location"]["id"].as_str().unwrap_or_default().to_string(),
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
                        product_id: node["product"]["id"].as_str()?.to_string(),
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
                        inventory_item_id: item["id"].as_str().map(String::from),
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

/// MoneyV2 as "24.00 USD"; empty when either half is missing.
fn money(m: &serde_json::Value) -> String {
    match (m["amount"].as_str(), m["currencyCode"].as_str()) {
        (Some(a), Some(c)) => format!("{a} {c}"),
        _ => String::new(),
    }
}

/// Trimmed string, or None when missing/blank.
fn non_empty(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn strings(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .map(|xs| xs.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn parse_products(page: &serde_json::Value) -> Vec<CatalogProduct> {
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

/// Rewrites Shopify's terse access-denied error into one that names the missing scope and the store.
fn scope_denied(e: String, shop_domain: &str, scope: &str, what: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("access denied") || l.contains(scope) {
        format!("Shopify denied {what} access for {shop_domain}: the app needs the {scope} scope. {e}")
    } else {
        e
    }
}

// List every product in the active store's catalog (title-sorted; needs read_products)
#[tauri::command]
async fn list_products() -> Result<CatalogResult, String> {
    let shop_domain = get_active_store()?.domain;

    let (mut products, truncated) = fetch_catalog_pages(&shop_domain)
        .await
        .map_err(|e| scope_denied(e, &shop_domain, "read_products", "product"))?;

    products.sort_by_cached_key(|p| p.title.to_lowercase());

    Ok(CatalogResult { products, truncated })
}

// Each customer node costs ~6 points (Customer + amountSpent + email + phone + address + lastOrder),
// so a 100-row page is 2 + 100×6 + 1 (customersCount) ≈ 603 — under Shopify's 1,000-point single-query cap.
const CUSTOMERS_MAX_PAGE_SIZE: i32 = 100;

const CUSTOMERS_QUERY: &str = r#"
query Customers($first: Int!, $query: String, $sortKey: CustomerSortKeys, $reverse: Boolean) {
    customers(first: $first, query: $query, sortKey: $sortKey, reverse: $reverse) {
        pageInfo { hasNextPage }
        edges {
            node {
                id
                displayName
                createdAt
                updatedAt
                tags
                numberOfOrders
                amountSpent { amount currencyCode }
                defaultEmailAddress { emailAddress }
                defaultPhoneNumber { phoneNumber }
                defaultAddress { company city provinceCode countryCodeV2 }
                lastOrder { id name createdAt }
            }
        }
    }
    customersCount(query: $query, limit: 10000) { count precision }
}
"#;

fn parse_customers(result: &serde_json::Value) -> Result<CustomersResult, String> {
    let edges = result["data"]["customers"]["edges"]
        .as_array()
        .ok_or_else(|| "Invalid customers response".to_string())?;
    let customers = edges
        .iter()
        .filter_map(|edge| {
            let node = &edge["node"];
            let addr = &node["defaultAddress"];
            let location: Vec<String> = [non_empty(&addr["city"]), non_empty(&addr["provinceCode"])]
                .into_iter()
                .flatten()
                .collect();
            Some(Customer {
                id: node["id"].as_str()?.to_string(),
                display_name: node["displayName"].as_str()?.to_string(),
                email: non_empty(&node["defaultEmailAddress"]["emailAddress"]),
                phone: non_empty(&node["defaultPhoneNumber"]["phoneNumber"]),
                company: non_empty(&addr["company"]),
                location: (!location.is_empty()).then(|| location.join(", ")),
                orders_count: node["numberOfOrders"].as_str().and_then(|n| n.parse().ok()).unwrap_or(0),
                amount_spent: money(&node["amountSpent"]),
                last_order_name: non_empty(&node["lastOrder"]["name"]),
                last_order_at: non_empty(&node["lastOrder"]["createdAt"]),
                created_at: node["createdAt"].as_str().unwrap_or_default().to_string(),
                tags: strings(&node["tags"]),
            })
        })
        .collect();
    let info = &result["data"]["customers"]["pageInfo"];
    let count = &result["data"]["customersCount"];
    Ok(CustomersResult {
        customers,
        has_next_page: info["hasNextPage"].as_bool().unwrap_or(false),
        total_count: count["count"].as_i64(),
        total_precision: count["precision"].as_str().map(String::from),
    })
}

// One page (≤100) of customers on the active store plus the filtered count (needs read_customers).
// `query` is Shopify search syntax; with a search we sort by relevance, otherwise newest activity first.
// ponytail: no cursor paging — the UI says "search to narrow" past 100; add `after` if someone needs page 2.
#[tauri::command]
async fn list_customers(query: Option<String>, first: Option<i32>) -> Result<CustomersResult, String> {
    let shop_domain = get_active_store()?.domain;
    let query = query.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let variables = serde_json::json!({
        "first": first.unwrap_or(CUSTOMERS_MAX_PAGE_SIZE).clamp(1, CUSTOMERS_MAX_PAGE_SIZE),
        "query": query,
        "sortKey": if query.is_some() { "RELEVANCE" } else { "UPDATED_AT" },
        "reverse": query.is_none(),
    });
    let result = graphql_request(&shop_domain, CUSTOMERS_QUERY, Some(variables))
        .await
        .map_err(|e| scope_denied(e, &shop_domain, "read_customers", "customer"))?;
    parse_customers(&result)
}

// Each presence node is 1 point, so 250/page is cheap; 8 pages = 2,000 products before `truncated`.
const PRESENCE_PAGE_CAP: usize = 8;

const PRESENCE_QUERY: &str = r#"
query Presence($after: String) {
    products(first: 250, after: $after, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        edges { node { id handle title status } }
    }
}
"#;

fn parse_presence(page: &serde_json::Value) -> Vec<ProductPresence> {
    page["data"]["products"]["edges"]
        .as_array()
        .map(|edges| {
            edges
                .iter()
                .filter_map(|edge| {
                    let node = &edge["node"];
                    Some(ProductPresence {
                        id: node["id"].as_str()?.to_string(),
                        handle: node["handle"].as_str().unwrap_or_default().to_string(),
                        title: node["title"].as_str()?.to_string(),
                        status: node["status"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// Handle/title/status of every product in *any* store (not just the active one) so Catalog can show
// which stores a product is visible in. Needs read_products on that store.
#[tauri::command]
async fn list_product_presence(store_id: String) -> Result<PresenceResult, String> {
    let shop_domain = store_by_id(&store_id)?.domain;
    let mut products = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..PRESENCE_PAGE_CAP {
        let variables = serde_json::json!({ "after": after });
        let result = graphql_request(&shop_domain, PRESENCE_QUERY, Some(variables))
            .await
            .map_err(|e| scope_denied(e, &shop_domain, "read_products", "product"))?;
        products.extend(parse_presence(&result));
        let info = &result["data"]["products"]["pageInfo"];
        match info["endCursor"].as_str() {
            Some(c) if info["hasNextPage"].as_bool().unwrap_or(false) => after = Some(c.to_string()),
            _ => return Ok(PresenceResult { products, truncated: false }),
        }
    }
    Ok(PresenceResult { products, truncated: true })
}

// Each stub node is ~3 points (Order + MoneyBag + MoneyV2), so a 200-row page is 2 + 200×3 = 602 —
// under the 1,000-point cap; 10 pages = 2,000 orders before `truncated`.
const ORDERS_SINCE_PAGE_CAP: usize = 10;

const ORDERS_SINCE_QUERY: &str = r#"
query OrdersSince($after: String, $query: String) {
    orders(first: 200, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges {
            node {
                id
                createdAt
                cancelledAt
                test
                currentTotalPriceSet { shopMoney { amount currencyCode } }
            }
        }
    }
}
"#;

/// Drops test orders (Bogus Gateway etc.) so Analytics never counts them.
fn parse_order_stubs(page: &serde_json::Value) -> Vec<OrderStub> {
    page["data"]["orders"]["edges"]
        .as_array()
        .map(|edges| {
            edges
                .iter()
                .filter_map(|edge| {
                    let node = &edge["node"];
                    if node["test"].as_bool().unwrap_or(false) {
                        return None;
                    }
                    Some(OrderStub {
                        created_at: node["createdAt"].as_str()?.to_string(),
                        total: money(&node["currentTotalPriceSet"]["shopMoney"]),
                        cancelled: !node["cancelledAt"].is_null(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Exactly "YYYY-MM-DD": ten ASCII chars, digits everywhere but the two dashes.
fn is_ymd(s: &str) -> bool {
    s.len() == 10
        && s.bytes()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}

// Every non-test order created on or after `since` (YYYY-MM-DD) in the given store. Analytics buckets
// these by day client-side rather than via ShopifyQL, which would need a read_reports scope.
#[tauri::command]
async fn list_orders_since(store_id: String, since: String) -> Result<OrdersSinceResult, String> {
    if !is_ymd(&since) {
        return Err("since must be YYYY-MM-DD".to_string());
    }
    let shop_domain = store_by_id(&store_id)?.domain;
    let query = format!("created_at:>={since}");
    let mut orders = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..ORDERS_SINCE_PAGE_CAP {
        let variables = serde_json::json!({ "after": after, "query": query });
        let result = graphql_request(&shop_domain, ORDERS_SINCE_QUERY, Some(variables))
            .await
            .map_err(|e| scope_denied(e, &shop_domain, "read_orders", "order"))?;
        orders.extend(parse_order_stubs(&result));
        let info = &result["data"]["orders"]["pageInfo"];
        match info["endCursor"].as_str() {
            Some(c) if info["hasNextPage"].as_bool().unwrap_or(false) => after = Some(c.to_string()),
            _ => return Ok(OrdersSinceResult { orders, truncated: false }),
        }
    }
    Ok(OrdersSinceResult { orders, truncated: true })
}

// ---- COAs (retail store only) ----------------------------------------------------------------
// Joins retail PDF files → products (filename → title heuristics) → product metafields → coa_record
// metaobjects → the local cache (LLM-parsed fields, manual links, field overrides) → the public
// /pages/coa scrape. Ported from the old dashboard's GET /api/coas: same tiers, same precedence.

const COA_PAGE_URL: &str = "https://flowgardens.com/pages/coa";
// 250/page everywhere; the caps (10k files, 2.5k records, 5k products) are far above real volume.
const COA_FILES_PAGE_CAP: usize = 40;
const COA_RECORDS_PAGE_CAP: usize = 10;
const COA_PRODUCTS_PAGE_CAP: usize = 20;
const COA_VALID_DAYS: i64 = 365;

/// Filename suffixes appended to a strain name in the Files library, in the order we strip them.
/// Normalised (no separators, lowercase).
const FILENAME_NOISE_SUFFIXES: [&str; 13] = [
    "thcaliveresin",
    "thcliveresin",
    "liveresinvape",
    "liveresin",
    "liverosin",
    "livehash",
    "bubblehash",
    "rosinvape",
    "distillate",
    "prerolls",
    "preroll",
    "vape",
    "coa",
];

// Newest first so a partial failure still shows recent uploads.
const COA_FILES_QUERY: &str = r#"
query CoaFiles($after: String) {
    files(first: 250, after: $after, query: "media_type:GENERIC_FILE", sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on GenericFile { id url createdAt mimeType } }
    }
}
"#;

const COA_RECORDS_QUERY: &str = r#"
query CoaRecords($after: String) {
    metaobjects(type: "coa_record", first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
            id
            handle
            capabilities { publishable { status } }
            fields { key value reference { ... on GenericFile { id url } } }
        }
    }
}
"#;

const COA_PRODUCTS_QUERY: &str = r#"
query CoaProducts($after: String) {
    products(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
            id title handle status publishedAt onlineStoreUrl
            thca: metafield(namespace: "custom", key: "total_thca") { value }
            cbd: metafield(namespace: "custom", key: "total_cbd") { value }
            cbg: metafield(namespace: "custom", key: "total_cbg") { value }
            strainType: metafield(namespace: "custom", key: "strain_type") { value }
            flowerType: metafield(namespace: "custom", key: "flower_type") { value }
            terpenes: metafield(namespace: "custom", key: "top_terpenes") {
                references(first: 10) {
                    nodes { ... on Metaobject { id nameField: field(key: "name") { value } } }
                }
            }
        }
    }
}
"#;

const PRODUCT_SEARCH_QUERY: &str = r#"
query ProductSearch($q: String!) {
    products(first: 10, query: $q) {
        nodes { id title handle status }
    }
}
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoaTerpene {
    pub name: String,
    pub pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coa {
    /// coa_record gid when one references this file, else the file gid.
    pub id: String,
    pub file_id: String,
    /// URL-decoded basename including any UUID suffix.
    pub file_name: String,
    pub file_url: String,
    pub file_created_at: String,
    pub batch: Option<String>,
    pub lab: Option<String>,
    pub producer: Option<String>,
    pub display_title: Option<String>,
    /// "manual" | match tier tag | None.
    pub match_via: Option<String>,
    /// A parsed cache entry exists for this file (stale ones included).
    pub parsed: bool,
    /// Cache entry `parsedAt` / `model`.
    pub parsed_at: Option<String>,
    pub parsed_model: Option<String>,
    /// The entry predates the current prompt (lacks `producer`) and needs a re-parse.
    pub parse_stale: bool,
    pub qr_present: Option<bool>,
    pub product_id: Option<String>,
    /// Product title, else the Title-Cased filename stem.
    pub product_name: String,
    pub product_handle: Option<String>,
    pub product_status: Option<String>,
    pub product_published: bool,
    pub product_online_store_url: Option<String>,
    pub has_coa_record: bool,
    pub coa_record_id: Option<String>,
    /// ACTIVE | DRAFT (capabilities.publishable.status).
    pub coa_record_status: Option<String>,
    /// "posted" | "unposted"
    pub posted_status: String,
    pub posted_reason: String,
    /// "page" | "product" | "metaobject"
    pub posted_source: Option<String>,
    pub on_coa_page: bool,
    pub strain: Option<String>,
    /// product flower_type ?? strain_type
    #[serde(rename = "type")]
    pub r#type: Option<String>,
    /// YYYY-MM-DD
    pub issued: String,
    /// YYYY-MM-DD
    pub expires: String,
    pub days_to_expire: i64,
    /// "valid" | "expiring" | "expired"
    pub state: String,
    pub thca: Option<f64>,
    pub cbd: Option<f64>,
    pub cbg: Option<f64>,
    pub total_cannabinoids: Option<f64>,
    pub terpenes: Vec<CoaTerpene>,
    pub notes: Option<String>,
    /// A field-override entry exists for this file.
    pub edited: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedPage {
    pub url: String,
    pub urls_found: usize,
    /// UTC "YYYY-MM-DDTHH:MM:SSZ"
    pub checked_at: String,
    /// Set when the storefront scrape failed; the posted set is then empty.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoaList {
    pub coas: Vec<Coa>,
    pub count: usize,
    pub posted_page: PostedPage,
    /// True when any of the files / records / products page caps was hit.
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductHit {
    pub id: String,
    pub title: String,
    pub handle: String,
    pub status: String,
}

#[derive(Debug, Clone)]
struct CoaFile {
    id: String,
    url: String,
    created_at: String,
}

#[derive(Debug, Clone, Default)]
struct CoaProduct {
    id: String,
    title: String,
    handle: String,
    status: String,
    published: bool,
    online_store_url: Option<String>,
    thca: Option<String>,
    cbd: Option<String>,
    cbg: Option<String>,
    strain_type: Option<String>,
    flower_type: Option<String>,
    /// top_terpenes metaobject names.
    terpenes: Vec<String>,
}

#[derive(Debug, Clone)]
struct CoaRecord {
    id: String,
    /// capabilities.publishable.status
    status: Option<String>,
    /// pdf_file reference id
    file_id: Option<String>,
    /// Non-blank field values by key.
    fields: HashMap<String, String>,
}

fn parse_coa_files(nodes: &[serde_json::Value]) -> Vec<CoaFile> {
    nodes
        .iter()
        .filter(|n| n["mimeType"] == "application/pdf")
        .filter_map(|n| {
            Some(CoaFile {
                id: n["id"].as_str()?.to_string(),
                url: n["url"].as_str()?.to_string(),
                created_at: n["createdAt"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

fn parse_coa_records(nodes: &[serde_json::Value]) -> Vec<CoaRecord> {
    nodes
        .iter()
        .filter_map(|n| {
            let mut fields = HashMap::new();
            let mut file_id = None;
            for f in n["fields"].as_array()? {
                let Some(key) = f["key"].as_str() else { continue };
                if key == "pdf_file" {
                    file_id = non_empty(&f["reference"]["id"]).or_else(|| non_empty(&f["value"]));
                }
                if let Some(v) = non_empty(&f["value"]) {
                    fields.insert(key.to_string(), v);
                }
            }
            Some(CoaRecord {
                id: n["id"].as_str()?.to_string(),
                status: non_empty(&n["capabilities"]["publishable"]["status"]),
                file_id,
                fields,
            })
        })
        .collect()
}

fn parse_coa_products(nodes: &[serde_json::Value]) -> Vec<CoaProduct> {
    nodes
        .iter()
        .filter_map(|n| {
            Some(CoaProduct {
                id: n["id"].as_str()?.to_string(),
                title: n["title"].as_str()?.to_string(),
                handle: n["handle"].as_str().unwrap_or_default().to_string(),
                status: n["status"].as_str().unwrap_or_default().to_string(),
                published: !n["publishedAt"].is_null(),
                online_store_url: non_empty(&n["onlineStoreUrl"]),
                thca: non_empty(&n["thca"]["value"]),
                cbd: non_empty(&n["cbd"]["value"]),
                cbg: non_empty(&n["cbg"]["value"]),
                strain_type: non_empty(&n["strainType"]["value"]),
                flower_type: non_empty(&n["flowerType"]["value"]),
                terpenes: n["terpenes"]["references"]["nodes"]
                    .as_array()
                    .map(|ts| {
                        ts.iter()
                            .filter_map(|t| non_empty(&t["nameField"]["value"]).or_else(|| non_empty(&t["id"])))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_product_hits(result: &serde_json::Value) -> Vec<ProductHit> {
    result["data"]["products"]["nodes"]
        .as_array()
        .map(|ns| {
            ns.iter()
                .filter_map(|n| {
                    Some(ProductHit {
                        id: n["id"].as_str()?.to_string(),
                        title: n["title"].as_str()?.to_string(),
                        handle: n["handle"].as_str().unwrap_or_default().to_string(),
                        status: n["status"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Pages a `nodes { … } pageInfo { hasNextPage endCursor }` connection at data.<root> on the retail
/// store; returns (nodes, truncated).
async fn fetch_all_nodes(query: &str, root: &str, cap: usize) -> Result<(Vec<serde_json::Value>, bool), String> {
    let mut nodes = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..cap {
        let result = graphql_request(SHOP_RETAIL, query, Some(serde_json::json!({ "after": after }))).await?;
        let conn = &result["data"][root];
        nodes.extend(conn["nodes"].as_array().cloned().unwrap_or_default());
        match conn["pageInfo"]["endCursor"].as_str() {
            Some(c) if conn["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) => after = Some(c.to_string()),
            _ => return Ok((nodes, false)),
        }
    }
    Ok((nodes, true))
}

// -- filename → product matching ---------------------------------------------------------------

/// Letters + digits only, lowercase. Used on both sides of every match.
fn norm_key(s: &str) -> String {
    s.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

/// Decodes %XX sequences (invalid ones are kept as-is); `+` is left alone like decodeURIComponent.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Stable identity for a CDN URL: the URL-decoded basename, query/fragment stripped, so re-uploads
/// with the same name and `?v=` cache-busters still match. Empty when there is no basename.
fn file_key_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    percent_decode(path.rsplit('/').next().unwrap_or(""))
}

/// Strips a trailing `_<uuid>` (36 chars, dashes at 8/13/18/23) that Shopify appends to duplicate uploads.
fn strip_uuid_suffix(stem: &str) -> &str {
    let b = stem.as_bytes();
    if b.len() < 37 {
        return stem;
    }
    let tail = &b[b.len() - 37..];
    let is_uuid = tail[0] == b'_'
        && tail[1..].iter().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() }
        });
    if is_uuid { &stem[..stem.len() - 37] } else { stem }
}

/// (display, key): the basename without `.pdf`/UUID suffix, `_` → space for display, norm_key'd for matching.
fn filename_key(url: &str) -> (String, String) {
    let raw = file_key_from_url(url);
    let no_ext = if raw.to_ascii_lowercase().ends_with(".pdf") { &raw[..raw.len() - 4] } else { raw.as_str() };
    let stem = strip_uuid_suffix(no_ext);
    (stem.replace('_', " "), norm_key(stem))
}

/// JS `s.replace(/\b\w/g, c => c.toUpperCase())`: uppercase every ASCII word char that starts a word.
fn title_case(s: &str) -> String {
    let mut prev_word = false;
    s.chars()
        .map(|c| {
            let is_word = c.is_ascii_alphanumeric() || c == '_';
            let out = if is_word && !prev_word { c.to_ascii_uppercase() } else { c };
            prev_word = is_word;
            out
        })
        .collect()
}

struct ProductIndex<'a> {
    by_key: HashMap<String, &'a CoaProduct>,
    by_handle: HashMap<String, &'a CoaProduct>,
    /// (norm_key(title), product) by key length descending; ties keep catalog order.
    pairs: Vec<(String, &'a CoaProduct)>,
}

fn product_index(products: &[CoaProduct]) -> ProductIndex<'_> {
    let mut by_key: HashMap<String, &CoaProduct> = HashMap::new();
    let mut by_handle = HashMap::new();
    for p in products {
        by_key.insert(norm_key(&p.title), p);
        by_handle.insert(norm_key(&p.handle), p);
    }
    let mut seen = HashSet::new();
    let mut pairs: Vec<(String, &CoaProduct)> = products
        .iter()
        .map(|p| norm_key(&p.title))
        .filter(|k| seen.insert(k.clone()))
        .map(|k| {
            let p = by_key[&k];
            (k, p)
        })
        .collect();
    pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    ProductIndex { by_key, by_handle, pairs }
}

fn try_tiers<'a>(key: &str, index: &ProductIndex<'a>, tag: &str) -> Option<(&'a CoaProduct, String)> {
    if let Some(p) = index.by_key.get(key) {
        return Some((p, format!("{tag}exact-title")));
    }
    if let Some(p) = index.by_handle.get(key) {
        return Some((p, format!("{tag}exact-handle")));
    }
    if key.len() >= 6 {
        // Longest product title that is a prefix of the filename key.
        for (k, p) in &index.pairs {
            if k.len() < 6 {
                break;
            }
            if k.len() > key.len() {
                continue;
            }
            if key.starts_with(k.as_str()) {
                return Some((p, format!("{tag}product-is-prefix")));
            }
        }
        // Filename key is a prefix of some product title (Cakeberry → Cakeberry Brûlée).
        for (k, p) in &index.pairs {
            if k.len() <= key.len() {
                break;
            }
            if k.starts_with(key) {
                return Some((p, format!("{tag}filename-is-prefix")));
            }
        }
    }
    None
}

fn match_product<'a>(file_key: &str, index: &ProductIndex<'a>) -> (Option<&'a CoaProduct>, Option<String>) {
    if let Some((p, via)) = try_tiers(file_key, index, "") {
        return (Some(p), Some(via));
    }
    for sfx in FILENAME_NOISE_SUFFIXES {
        if file_key.ends_with(sfx) && file_key.len() > sfx.len() + 3 {
            if let Some((p, via)) = try_tiers(&file_key[..file_key.len() - sfx.len()], index, "strip-") {
                return (Some(p), Some(via));
            }
        }
    }
    (None, None)
}

// -- posted status / dates ---------------------------------------------------------------------

/// Is this COA visible to customers? Signals in priority order: on /pages/coa (authoritative),
/// linked to an ACTIVE published product, referenced by a coa_record metaobject.
fn derive_posted_status(
    product: Option<&CoaProduct>,
    has_record: bool,
    posted_keys: &HashSet<String>,
    file_url: &str,
) -> (&'static str, String, Option<&'static str>) {
    let key = file_key_from_url(file_url);
    if !key.is_empty() && posted_keys.contains(&key) {
        return ("posted", "Listed on /pages/coa".into(), Some("page"));
    }
    let Some(product) = product else {
        return if has_record {
            ("posted", "Referenced by coa_record metaobject".into(), Some("metaobject"))
        } else {
            ("unposted", "Not on /pages/coa, no product link, no metaobject".into(), None)
        };
    };
    let status = product.status.to_uppercase();
    match status.as_str() {
        "ACTIVE" if product.published => ("posted", "Linked to active, published product".into(), Some("product")),
        "ACTIVE" if has_record => (
            "posted",
            "Active product + coa_record metaobject (not yet published)".into(),
            Some("metaobject"),
        ),
        "ACTIVE" => (
            "unposted",
            "Linked to active product, but it is not published to the online store".into(),
            None,
        ),
        "DRAFT" => ("unposted", "Linked product is in DRAFT".into(), None),
        "ARCHIVED" => ("unposted", "Linked product is ARCHIVED".into(), None),
        other => {
            let label = if other.is_empty() { "unknown" } else { other };
            if has_record {
                ("posted", format!("Referenced by coa_record (product status {label})"), Some("metaobject"))
            } else {
                ("unposted", format!("Linked product status {label}"), None)
            }
        }
    }
}

fn derive_state(days_to_expire: i64) -> &'static str {
    if days_to_expire < 0 {
        "expired"
    } else if days_to_expire < 30 {
        "expiring"
    } else {
        "valid"
    }
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// The leading "YYYY-MM-DD" of a date or ISO timestamp with its day number; None when absent/malformed.
fn ymd(s: &str) -> Option<(&str, i64)> {
    let p = s.get(..10).filter(|p| is_ymd(p))?;
    let (y, m, d): (i64, u32, u32) = (p[..4].parse().ok()?, p[5..7].parse().ok()?, p[8..].parse().ok()?);
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| (p, days_from_civil(y, m, d)))
}

fn ymd_string(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn today_days() -> i64 {
    now_secs().div_euclid(86400)
}

/// UTC "YYYY-MM-DDTHH:MM:SSZ".
fn utc_now_iso() -> String {
    let secs = now_secs();
    let t = secs.rem_euclid(86400);
    format!("{}T{:02}:{:02}:{:02}Z", ymd_string(secs.div_euclid(86400)), t / 3600, t % 3600 / 60, t % 60)
}

// -- /pages/coa scrape -------------------------------------------------------------------------

/// Every `(https?:)?//cdn.shopify.com/…` and `/cdn/shop/(t/N/)?files/…` URL in the rendered page
/// (case-insensitive match, original text kept), each run ending at a quote, whitespace, `)`, `<` or `>`.
fn extract_cdn_urls(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let is_delim = |b: &u8| matches!(b, b'"' | b'\'' | b')' | b'<' | b'>') || b.is_ascii_whitespace();
    let run_end = |start: usize| start + lower.as_bytes()[start..].iter().position(is_delim).unwrap_or(lower.len() - start);
    let mut urls = Vec::new();

    let mut pos = 0;
    while let Some(i) = lower[pos..].find("//cdn.shopify.com/") {
        let i = pos + i;
        let start = if lower[..i].ends_with("https:") {
            i - 6
        } else if lower[..i].ends_with("http:") {
            i - 5
        } else {
            i
        };
        let end = run_end(i);
        urls.push(html[start..end].to_string());
        pos = end;
    }

    pos = 0;
    while let Some(i) = lower[pos..].find("/cdn/shop/") {
        let i = pos + i;
        let rest = &lower[i + 10..];
        let is_files = rest.starts_with("files/")
            || rest.strip_prefix("t/").is_some_and(|r| {
                let digits = r.bytes().take_while(u8::is_ascii_digit).count();
                digits > 0 && r[digits..].starts_with("/files/")
            });
        if is_files {
            let end = run_end(i);
            urls.push(html[i..end].to_string());
            pos = end;
        } else {
            pos = i + 10;
        }
    }
    urls
}

struct PostedPageResult {
    keys: HashSet<String>,
    info: PostedPage,
}

/// Fetches the rendered storefront page (Admin API returns Page.body empty) and collects the file
/// keys it links. Never fails: on error the set is empty and `info.error` says why.
async fn fetch_posted_page() -> PostedPageResult {
    let checked_at = utc_now_iso();
    let fetched = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .get(COA_PAGE_URL)
            // Some storefronts serve bots a different/empty body; mimic a browser.
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
            )
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("storefront {}", res.status().as_u16()));
        }
        res.text().await.map_err(|e| e.to_string())
    }
    .await;
    let (keys, urls_found, error) = match fetched {
        Ok(html) => {
            let keys: Vec<String> = extract_cdn_urls(&html)
                .iter()
                .map(|u| file_key_from_url(u))
                .filter(|k| !k.is_empty())
                .collect();
            let n = keys.len();
            (keys.into_iter().collect(), n, None)
        }
        Err(e) => (HashSet::new(), 0, Some(e)),
    };
    PostedPageResult {
        keys,
        info: PostedPage { url: COA_PAGE_URL.into(), urls_found, checked_at, error },
    }
}

// -- local cache (parsed PDFs, manual links, field overrides) ----------------------------------

fn coa_cache() -> &'static Mutex<Option<serde_json::Value>> {
    static CACHE: OnceLock<Mutex<Option<serde_json::Value>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn coa_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?.join("coa-cache.json"))
}

fn read_coa_cache_file(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        // ponytail: one-time seed from the old dashboard; delete once the old repo is gone.
        let seed = std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Documents/Dev/Projects/flow gardens dashboard/.coa-cache.json"))
            .filter(|p| p.exists());
        if let Some(seed) = seed {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::copy(&seed, path);
        }
    }
    let value = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    Ok(if value.is_object() { value } else { serde_json::json!({}) })
}

/// Runs `f` on the in-memory cache (loaded from disk on first use); `persist` writes it back after.
fn with_coa_cache<R>(
    app: &tauri::AppHandle,
    persist: bool,
    f: impl FnOnce(&mut serde_json::Value) -> R,
) -> Result<R, String> {
    let path = coa_cache_path(app)?;
    let mut guard = coa_cache().lock().map_err(|_| "COA cache lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(read_coa_cache_file(&path)?);
    }
    let cache = guard.as_mut().expect("loaded above");
    let out = f(cache);
    if persist {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        let bytes = serde_json::to_vec_pretty(cache).map_err(|e| e.to_string())?;
        fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    }
    Ok(out)
}

/// `cache[key]` as an object map, creating it when missing or malformed.
fn cache_section<'a>(cache: &'a mut serde_json::Value, key: &str) -> &'a mut serde_json::Map<String, serde_json::Value> {
    if !cache.is_object() {
        *cache = serde_json::json!({});
    }
    let section = cache.as_object_mut().expect("object").entry(key).or_insert_with(|| serde_json::json!({}));
    if !section.is_object() {
        *section = serde_json::json!({});
    }
    section.as_object_mut().expect("object")
}

// -- row model ---------------------------------------------------------------------------------

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse().ok()
}

/// JSON number, or a numeric string; anything else is None.
fn num_of(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(parse_f64))
}

fn parse_terpenes(v: &serde_json::Value, pct_key: &str) -> Vec<CoaTerpene> {
    v.as_array()
        .map(|ts| {
            ts.iter()
                .filter_map(|t| Some(CoaTerpene { name: non_empty(&t["name"])?, pct: num_of(&t[pct_key]) }))
                .collect()
        })
        .unwrap_or_default()
}

/// One row per PDF, exactly like the old GET /api/coas. Precedence everywhere is
/// override > parsed cache > coa_record > product metafield; dates fall back to the file's createdAt.
fn build_coas(
    files: &[CoaFile],
    records: &[CoaRecord],
    products: &[CoaProduct],
    cache: &serde_json::Value,
    posted_keys: &HashSet<String>,
    today: i64,
) -> Vec<Coa> {
    let index = product_index(products);
    let by_id: HashMap<&str, &CoaProduct> = products.iter().map(|p| (p.id.as_str(), p)).collect();
    let rec_by_file: HashMap<&str, &CoaRecord> = records.iter().filter_map(|r| Some((r.file_id.as_deref()?, r))).collect();
    let links = &cache["__manualLinks"];
    let overrides = &cache["__fieldOverrides"];

    let mut coas: Vec<Coa> = files
        .iter()
        .map(|f| {
            let (display, key) = filename_key(&f.url);
            let manual = &links[f.id.as_str()];
            let (auto_product, auto_via) = match_product(&key, &index);
            let product = if manual.is_object() {
                non_empty(&manual["productId"])
                    .and_then(|id| by_id.get(id.as_str()).copied())
                    .or_else(|| non_empty(&manual["productTitle"]).and_then(|t| index.by_key.get(&norm_key(&t)).copied()))
                    .or(auto_product)
            } else {
                auto_product
            };
            let match_via = if manual.is_object() { Some("manual".to_string()) } else { auto_via };

            let rec = rec_by_file.get(f.id.as_str()).copied();
            let rf = |k: &str| rec.and_then(|r| r.fields.get(k)).cloned();
            let entry = &cache[f.id.as_str()];
            let parsed = &entry["fields"];
            let ps = |k: &str| non_empty(&parsed[k]);
            let ov = &overrides[f.id.as_str()];
            let ovs = |k: &str| non_empty(&ov[k]);

            let (issued, issued_days) = [ovs("issued"), ps("issue_date"), rf("report_date"), Some(f.created_at.clone())]
                .into_iter()
                .flatten()
                .find_map(|s| ymd(&s).map(|(p, d)| (p.to_string(), d)))
                .unwrap_or_else(|| (ymd_string(today), today));
            let (expires, expires_days) = [ovs("expires"), rf("expiry_date")]
                .into_iter()
                .flatten()
                .find_map(|s| ymd(&s).map(|(p, d)| (p.to_string(), d)))
                .unwrap_or_else(|| (ymd_string(issued_days + COA_VALID_DAYS), issued_days + COA_VALID_DAYS));
            let days_to_expire = expires_days - today;

            let rec_num = |k: &str| rf(k).and_then(|s| parse_f64(&s));
            let prod_num = |g: fn(&CoaProduct) -> Option<&str>| product.and_then(g).and_then(parse_f64);
            let thca = num_of(&ov["thca"])
                .or_else(|| num_of(&parsed["thca_percent"]))
                .or_else(|| rec_num("thca_percent"))
                .or_else(|| prod_num(|p| p.thca.as_deref()));
            let cbd = num_of(&ov["cbd"])
                .or_else(|| num_of(&parsed["cbda_percent"]))
                .or_else(|| rec_num("cbd_percent"))
                .or_else(|| prod_num(|p| p.cbd.as_deref()));
            let cbg = num_of(&ov["cbg"])
                .or_else(|| num_of(&parsed["cbg_percent"]))
                .or_else(|| rec_num("cbg_percent"))
                .or_else(|| prod_num(|p| p.cbg.as_deref()));
            let total_cannabinoids = num_of(&ov["totalCannabinoids"])
                .or_else(|| num_of(&parsed["total_cannabinoids_percent"]))
                .or_else(|| rec_num("total_cannabinoids"));

            let terpenes = if ov["terpenes"].is_array() {
                parse_terpenes(&ov["terpenes"], "pct")
            } else {
                let from_parsed = parse_terpenes(&parsed["terpenes"], "percent");
                if !from_parsed.is_empty() {
                    from_parsed
                } else {
                    product
                        .map(|p| p.terpenes.iter().map(|n| CoaTerpene { name: n.clone(), pct: None }).collect())
                        .unwrap_or_default()
                }
            };

            let (posted_status, posted_reason, posted_source) =
                derive_posted_status(product, rec.is_some(), posted_keys, &f.url);

            Coa {
                id: rec.map_or_else(|| f.id.clone(), |r| r.id.clone()),
                file_id: f.id.clone(),
                file_name: file_key_from_url(&f.url),
                file_url: f.url.clone(),
                file_created_at: f.created_at.clone(),
                batch: ovs("batch").or_else(|| ps("batch_id")).or_else(|| rf("batch_id")),
                lab: ovs("lab").or_else(|| ps("lab")).or_else(|| rf("lab_name")),
                producer: ovs("producer").or_else(|| ps("producer")),
                display_title: rf("display_title"),
                match_via,
                parsed: parsed.is_object(),
                parsed_at: non_empty(&entry["parsedAt"]),
                parsed_model: non_empty(&entry["model"]),
                parse_stale: entry.is_object() && !is_fully_parsed(entry),
                qr_present: parsed["qr_present"].as_bool(),
                product_id: product.map(|p| p.id.clone()),
                product_name: ovs("productName")
                    .or_else(|| product.map(|p| p.title.clone()))
                    .unwrap_or_else(|| title_case(&display)),
                product_handle: product.map(|p| p.handle.clone()),
                product_status: product.map(|p| p.status.clone()),
                product_published: product.is_some_and(|p| p.published),
                product_online_store_url: product.and_then(|p| p.online_store_url.clone()),
                has_coa_record: rec.is_some(),
                coa_record_id: rec.map(|r| r.id.clone()),
                coa_record_status: rec.and_then(|r| r.status.clone()),
                posted_status: posted_status.to_string(),
                posted_reason,
                posted_source: posted_source.map(String::from),
                on_coa_page: posted_keys.contains(&file_key_from_url(&f.url)),
                strain: ovs("strain").or_else(|| product.and_then(|p| p.strain_type.clone())),
                r#type: ovs("type").or_else(|| product.and_then(|p| p.flower_type.clone().or_else(|| p.strain_type.clone()))),
                issued,
                expires,
                days_to_expire,
                state: derive_state(days_to_expire).to_string(),
                thca,
                cbd,
                cbg,
                total_cannabinoids,
                terpenes,
                notes: ovs("notes").or_else(|| rf("notes")),
                edited: ov.is_object(),
            }
        })
        .collect();

    coas.sort_by_key(|c| c.days_to_expire);
    coas
}

// -- commands ----------------------------------------------------------------------------------

// Every retail PDF as one COA row (needs read_files, read_metaobjects, read_products on retail).
#[tauri::command]
async fn list_coas(app: tauri::AppHandle) -> Result<CoaList, String> {
    let (files, records, products, page) = tokio::join!(
        fetch_all_nodes(COA_FILES_QUERY, "files", COA_FILES_PAGE_CAP),
        fetch_all_nodes(COA_RECORDS_QUERY, "metaobjects", COA_RECORDS_PAGE_CAP),
        fetch_all_nodes(COA_PRODUCTS_QUERY, "products", COA_PRODUCTS_PAGE_CAP),
        fetch_posted_page(),
    );
    let (files, files_truncated) = files.map_err(|e| scope_denied(e, SHOP_RETAIL, "read_files", "file"))?;
    let (records, records_truncated) =
        records.map_err(|e| scope_denied(e, SHOP_RETAIL, "read_metaobjects", "metaobject"))?;
    let (products, products_truncated) =
        products.map_err(|e| scope_denied(e, SHOP_RETAIL, "read_products", "product"))?;
    let files = parse_coa_files(&files);
    let records = parse_coa_records(&records);
    let products = parse_coa_products(&products);
    let today = today_days();
    let coas = with_coa_cache(&app, false, |cache| build_coas(&files, &records, &products, cache, &page.keys, today))?;
    Ok(CoaList {
        count: coas.len(),
        coas,
        posted_page: page.info,
        truncated: files_truncated || records_truncated || products_truncated,
    })
}

// Set (both given) or clear a manual file → product link.
#[tauri::command]
async fn save_coa_link(
    app: tauri::AppHandle,
    file_id: String,
    product_id: Option<String>,
    product_title: Option<String>,
) -> Result<(), String> {
    let product_id = product_id.filter(|s| !s.trim().is_empty());
    let product_title = product_title.filter(|s| !s.trim().is_empty());
    with_coa_cache(&app, true, |cache| {
        let links = cache_section(cache, "__manualLinks");
        match (product_id, product_title) {
            (Some(id), Some(title)) => {
                links.insert(
                    file_id,
                    serde_json::json!({ "productId": id, "productTitle": title, "linkedAt": utc_now_iso() }),
                );
            }
            _ => {
                links.remove(&file_id);
            }
        }
    })
}

// Merge `fields` into the file's overrides (or `clear` them); returns the resulting overrides or null.
#[tauri::command]
async fn save_coa_fields(
    app: tauri::AppHandle,
    file_id: String,
    fields: Option<serde_json::Value>,
    clear: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_coa_cache(&app, true, |cache| {
        let overrides = cache_section(cache, "__fieldOverrides");
        if clear.unwrap_or(false) {
            overrides.remove(&file_id);
        } else if let Some(serde_json::Value::Object(fields)) = fields {
            let entry = overrides.entry(file_id.clone()).or_insert_with(|| serde_json::json!({}));
            if !entry.is_object() {
                *entry = serde_json::json!({});
            }
            let map = entry.as_object_mut().expect("object");
            map.extend(fields);
            map.insert("updatedAt".into(), serde_json::json!(utc_now_iso()));
        }
        overrides.get(&file_id).cloned().unwrap_or(serde_json::Value::Null)
    })
}

/// `title:*<q>*` with Shopify search-syntax specials stripped so free text cannot change the query.
fn product_search_term(q: &str) -> Option<String> {
    let q: String = q.chars().filter(|c| !matches!(c, '"' | '\\' | ':' | '(' | ')' | '*')).collect();
    let q = q.trim();
    (!q.is_empty()).then(|| format!("title:*{q}*"))
}

// Up to 10 retail products whose title contains `q` (for the manual-link picker).
#[tauri::command]
async fn search_products(q: String) -> Result<Vec<ProductHit>, String> {
    let Some(term) = product_search_term(&q) else { return Ok(Vec::new()) };
    let result = graphql_request(SHOP_RETAIL, PRODUCT_SEARCH_QUERY, Some(serde_json::json!({ "q": term })))
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "read_products", "product"))?;
    Ok(parse_product_hits(&result))
}

/// Basename only, must end in .csv.
fn csv_export_name(filename: &str) -> Result<String, String> {
    let name = Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or("filename is required")?;
    if !name.to_ascii_lowercase().ends_with(".csv") {
        return Err("filename must end with .csv".to_string());
    }
    Ok(name.to_string())
}

// Writes the UI-built CSV to ~/Downloads/<filename> and returns the absolute path.
#[tauri::command]
async fn export_coas_csv(filename: String, csv: String) -> Result<String, String> {
    let name = csv_export_name(&filename)?;
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let path = PathBuf::from(home).join("Downloads").join(name);
    fs::write(&path, csv).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

// -- LLM parse via OpenRouter ------------------------------------------------------------------
// Ported from the old dashboard's parsePdfViaOpenRouter / POST /api/coas/parse. Each PDF is fetched,
// base64'd into a data URL and sent to OpenRouter as a file part; the JSON answer lands in the
// cache as `cache[fileGid] = { parsedAt, model, fields }` (same shape the seed file uses).

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL_DEFAULT: &str = "anthropic/claude-haiku-4.5";
const PARSE_CONCURRENCY: usize = 4;
/// A cache entry counts as fully parsed only if `fields` has every key the current prompt asks for;
/// older entries (missing e.g. `producer`) are stale and get re-parsed without a manual reset.
const REQUIRED_PARSED_FIELDS: [&str; 1] = ["producer"];

const EXTRACTION_PROMPT: &str = r#"You are extracting data from a cannabis Certificate of Analysis (COA) PDF. Labs use many different label formats — read carefully before returning null.

Return ONLY a single JSON object matching this exact shape, no prose before or after:

{
  "issue_date": "YYYY-MM-DD",
  "lab": "lab name",
  "producer": "brand or company that owns the product",
  "batch_id": "batch or lot ID as shown",
  "thca_percent": 0.0,
  "cbda_percent": 0.0,
  "cbg_percent": 0.0,
  "total_cannabinoids_percent": 0.0,
  "terpenes": [{ "name": "Myrcene", "percent": 0.0 }],
  "qr_present": false
}

Field-by-field rules:

producer:
  The company / brand / license holder that owns the flower — NOT the testing lab.
  Labels include: "Producer", "Client", "Customer", "Distributor", "Brand", "License Holder", "Licensee",
  "Manufacturer", "Grower", "Cultivator", "Company", "Sample Submitted By", "Submitted By", "Sold To".
  Prefer the most business-facing name (e.g. "Flow Gardens", "RJR Services"). If only an address block
  is shown, use the company name from it. Return null if truly not stated.

issue_date:
  Labels include: "Report Date", "Date Issued", "Analysis Date", "Sample Date", "Date Tested", "Tested", "Report Created", etc.
  Prefer the report/analysis date. Format YYYY-MM-DD.

thca_percent:
  Look for rows labeled: THCa, THCA, Δ9-THCa, Δ9-THCA, Tetrahydrocannabinolic Acid, THC-A.
  Do NOT use "Total THC" or "Δ9-THC" — those are different compounds.

cbda_percent:
  Look for rows labeled: CBDa, CBDA, CBD-A, Cannabidiolic Acid, CBD Acid.
  If the table has a row simply labeled "CBD" (not "Total CBD") in a list of individual cannabinoids alongside THCa, CBDa etc., use that value — many labs omit the "a" suffix.
  Do NOT use "Total CBD" (a calculated sum) for this field.

cbg_percent:
  Look for rows labeled: CBGa, CBGA, CBG-A, Cannabigerolic Acid, CBG Acid.
  If the table has a row simply labeled "CBG" (not "Total CBG") in a list of individual cannabinoids, use that value.
  Do NOT use "Total CBG".

total_cannabinoids_percent:
  Look for "Total Cannabinoids", "Total Active Cannabinoids", or a clearly labelled sum row.

General rules:
  - A value of "ND", "nd", "<LOQ", "<LOD", "BQL", "--", or blank means the compound was not detected; use null.
  - If a field is genuinely absent from the document, use null. Do not guess or fabricate.
  - terpenes: list every terpene row with its percentage. If no percentage is given, set percent to null. If no terpene panel exists, return [].
  - qr_present: true if a QR code is visible anywhere on the page.
  - Output MUST be valid JSON. No markdown fences, no extra commentary."#;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterStatus {
    pub has_key: bool,
    /// Last 4 characters of the key, e.g. "…a1b2".
    pub key_hint: Option<String>,
    pub default_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseTarget {
    pub file_id: String,
    pub file_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseOutcome {
    pub file_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub parsed: usize,
    pub failed: usize,
    /// Already fully parsed and `force` not set.
    pub skipped: usize,
    pub elapsed_ms: u128,
    /// First 5 failures as "<filename or fileId>: <message>".
    pub errors: Vec<String>,
    pub results: Vec<ParseOutcome>,
}

/// Standard base64 (RFC 4648, `+/`, `=` padding). Hand-rolled to avoid a crate for one call site.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, &b)| acc | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { TABLE[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

fn is_fully_parsed(entry: &serde_json::Value) -> bool {
    entry["fields"].as_object().is_some_and(|f| REQUIRED_PARSED_FIELDS.iter().all(|k| f.contains_key(*k)))
}

/// The model's reply as a JSON object; ```json fences (which some models add anyway) are stripped.
fn extract_json_object(raw: &str) -> Result<serde_json::Value, String> {
    let s = raw.trim();
    let s = s.strip_prefix("```json").or_else(|| s.strip_prefix("```")).unwrap_or(s).trim_start();
    let s = s.strip_suffix("```").unwrap_or(s).trim_end();
    let v: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("model returned invalid JSON: {e}"))?;
    if v.is_object() {
        Ok(v)
    } else {
        Err("model returned non-object JSON".to_string())
    }
}

fn openrouter_body(model: &str, filename: &str, data_url: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": EXTRACTION_PROMPT },
                { "type": "file", "file": { "filename": filename, "file_data": data_url } }
            ]
        }],
        "response_format": { "type": "json_object" }
    })
}

/// Fetches the PDF and asks OpenRouter for the extracted fields.
async fn parse_pdf_via_openrouter(
    client: &reqwest::Client,
    key: &str,
    model: &str,
    file_url: &str,
) -> Result<serde_json::Value, String> {
    let pdf = client
        .get(file_url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("fetch pdf: {e}"))?;
    if !pdf.status().is_success() {
        return Err(format!("fetch pdf: {}", pdf.status().as_u16()));
    }
    let bytes = pdf.bytes().await.map_err(|e| format!("fetch pdf: {e}"))?;
    let data_url = format!("data:application/pdf;base64,{}", base64_encode(&bytes));

    let res = client
        .post(OPENROUTER_URL)
        .timeout(Duration::from_secs(120))
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .header("x-title", "Flow Command COA parser")
        .json(&openrouter_body(model, &file_key_from_url(file_url), &data_url))
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let txt = res.text().await.unwrap_or_default();
        return Err(format!("OpenRouter {}: {}", status.as_u16(), txt.chars().take(300).collect::<String>()));
    }
    let data: serde_json::Value = res.json().await.map_err(|e| format!("OpenRouter response: {e}"))?;
    let raw = data["choices"][0]["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("Empty OpenRouter response")?;
    extract_json_object(raw)
}

fn openrouter_key() -> Result<Option<String>, String> {
    match keychain_entry(KEY_OPENROUTER)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

#[tauri::command]
fn get_openrouter_status() -> Result<OpenRouterStatus, String> {
    let key = openrouter_key()?;
    Ok(OpenRouterStatus {
        has_key: key.is_some(),
        key_hint: key.map(|k| format!("…{}", k.char_indices().nth_back(3).map_or(k.as_str(), |(i, _)| &k[i..]))),
        default_model: OPENROUTER_MODEL_DEFAULT.to_string(),
    })
}

// Empty key removes the Keychain entry.
#[tauri::command]
fn save_openrouter_key(key: String) -> Result<String, String> {
    let key = key.trim().to_string();
    let entry = keychain_entry(KEY_OPENROUTER)?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => return Ok("OpenRouter key removed".to_string()),
            Err(e) => return Err(format!("Failed to remove OpenRouter key: {e}")),
        }
    }
    entry.set_password(&key).map_err(|e| format!("Failed to save OpenRouter key: {e}"))?;
    if openrouter_key()?.as_deref() != Some(key.as_str()) {
        return Err("Keychain write did not stick — check apple-native keyring feature".to_string());
    }
    Ok("OpenRouter key saved to Keychain".to_string())
}

// Parses the given PDFs through OpenRouter (4 at a time) and caches the fields per file gid.
// Fully parsed files are skipped unless `force`; stale entries (older prompt) are dropped and re-parsed.
#[tauri::command]
async fn parse_coas(
    app: tauri::AppHandle,
    files: Vec<ParseTarget>,
    model: Option<String>,
    force: Option<bool>,
) -> Result<ParseResult, String> {
    let key = openrouter_key()?.ok_or("OpenRouter key not set — add it in Settings")?;
    let model = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| OPENROUTER_MODEL_DEFAULT.to_string());
    let force = force.unwrap_or(false);
    let started = Instant::now();

    let (targets, stale, skipped) = with_coa_cache(&app, false, |cache| {
        let mut targets = Vec::new();
        let mut stale = Vec::new();
        let mut skipped = 0;
        for t in files {
            let entry = &cache[t.file_id.as_str()];
            if entry.is_object() && !is_fully_parsed(entry) {
                stale.push(t.file_id.clone());
            } else if entry.is_object() && !force {
                skipped += 1;
                continue;
            }
            targets.push(t);
        }
        (targets, stale, skipped)
    })?;
    if !stale.is_empty() {
        with_coa_cache(&app, true, |cache| {
            if let Some(map) = cache.as_object_mut() {
                for id in &stale {
                    map.remove(id);
                }
            }
        })?;
    }

    let client = reqwest::Client::new();
    let sem = Arc::new(tokio::sync::Semaphore::new(PARSE_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for t in targets {
        let (app, client, key, model, sem) = (app.clone(), client.clone(), key.clone(), model.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let outcome = parse_pdf_via_openrouter(&client, &key, &model, &t.file_url).await.and_then(|fields| {
                // Lock only around the insert; never held across an await.
                with_coa_cache(&app, true, |cache| {
                    cache[t.file_id.as_str()] =
                        serde_json::json!({ "parsedAt": utc_now_iso(), "model": model, "fields": fields });
                })
            });
            (t, outcome)
        });
    }

    let mut results = Vec::new();
    let mut errors = Vec::new();
    while let Some(joined) = set.join_next().await {
        let (t, outcome) = joined.map_err(|e| format!("parse task failed: {e}"))?;
        if let Err(msg) = &outcome {
            if errors.len() < 5 {
                let name = file_key_from_url(&t.file_url);
                errors.push(format!("{}: {msg}", if name.is_empty() { &t.file_id } else { &name }));
            }
        }
        results.push(ParseOutcome { file_id: t.file_id, ok: outcome.is_ok(), error: outcome.err() });
    }
    Ok(ParseResult {
        parsed: results.iter().filter(|r| r.ok).count(),
        failed: results.iter().filter(|r| !r.ok).count(),
        skipped,
        elapsed_ms: started.elapsed().as_millis(),
        errors,
        results,
    })
}

// ---- COA import pipeline (retail store) -------------------------------------------------------
// Ported from the old dashboard's POST /api/coas/{upload,import,repost}: PDF → Shopify Files via a
// staged upload, coa_record metaobject upsert, product custom.coa_records append, and the
// /pages/coa theme-template block upsert (see docs/storefront-coa.md for why the page stays
// block-driven). Every write goes to SHOP_RETAIL; the Google Drive/Sheet legs are gone.

const COA_TEMPLATE_FILENAME: &str = "templates/page.certificate-of-analysis.json";
/// fileCreate is async: poll node(id) once a second, this many times, for READY + a CDN url.
const FILE_STATUS_POLLS: usize = 20;
/// Plus mutation budget is ~50 points/s at ~10 per mutation; the old dashboard slept 250/300 ms.
const IMPORT_MUTATION_GAP: Duration = Duration::from_millis(250);
const REPOST_GAP: Duration = Duration::from_millis(300);

const STAGED_UPLOAD_MUTATION: &str = r#"
mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
    }
}
"#;

const FILE_CREATE_MUTATION: &str = r#"
mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
        files { id fileStatus ... on GenericFile { url } }
        userErrors { field message code }
    }
}
"#;

const FILE_STATUS_QUERY: &str = r#"
query FileStatus($id: ID!) {
    node(id: $id) { ... on GenericFile { id url fileStatus } }
}
"#;

const TERPENES_QUERY: &str = r#"
query TerpeneLibrary {
    metaobjects(type: "terpene", first: 100) {
        nodes { id handle nameField: field(key: "name") { value } }
    }
}
"#;

const METAOBJECT_UPSERT_MUTATION: &str = r#"
mutation MetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle capabilities { publishable { status } } }
        userErrors { field message code }
    }
}
"#;

const PRODUCT_COA_RECORDS_QUERY: &str = r#"
query ProductCoaRecords($id: ID!) {
    product(id: $id) {
        id
        metafield(namespace: "custom", key: "coa_records") { id value }
        flowerType: metafield(namespace: "custom", key: "flower_type") { value }
        strainType: metafield(namespace: "custom", key: "strain_type") { value }
        category: metafield(namespace: "custom", key: "product_category") { value }
    }
}
"#;

const METAFIELDS_SET_MUTATION: &str = r#"
mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
        metafields { id namespace key type value }
        userErrors { field message code }
    }
}
"#;

const MAIN_THEME_QUERY: &str = r#"
query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id name } } }
"#;

const THEME_FILE_QUERY: &str = r#"
query ThemeFile($id: ID!, $names: [String!]!) {
    node(id: $id) { ... on OnlineStoreTheme {
        files(filenames: $names, first: 5) {
            nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
        }
    } }
}
"#;

const THEME_FILES_UPSERT_MUTATION: &str = r#"
mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
        upsertedThemeFiles { filename }
        userErrors { field message code }
    }
}
"#;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// READY with a CDN url. False means the id is real but the url is still propagating.
    pub ok: bool,
    pub file_id: String,
    pub url: Option<String>,
    pub file_status: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoaTerpeneIn {
    pub name: String,
    #[serde(default)]
    pub percent: Option<f64>,
}

/// The reviewed fields from the import wizard; every key optional so a partial form still deserialises.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportFields {
    pub batch_id: Option<String>,
    pub issue_date: Option<String>,
    pub expiry_date: Option<String>,
    pub lab: Option<String>,
    pub producer: Option<String>,
    pub thca_percent: Option<f64>,
    pub cbd_percent: Option<f64>,
    pub cbg_percent: Option<f64>,
    pub total_cannabinoids_percent: Option<f64>,
    pub terpenes: Vec<CoaTerpeneIn>,
    pub notes: Option<String>,
    pub qr_present: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub file_id: String,
    pub file_url: Option<String>,
    pub file_name: Option<String>,
    #[serde(default)]
    pub fields: ImportFields,
    pub product_id: Option<String>,
    pub product_title: Option<String>,
    /// Name on /pages/coa and coa_record.display_title; falls back to the product title, then the file stem.
    pub page_name: Option<String>,
    /// true: ACTIVE metaobject + /pages/coa block. false: DRAFT metaobject, page untouched.
    pub post: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStep {
    pub step: String,
    pub ok: bool,
    pub critical: bool,
    pub error: Option<String>,
    pub detail: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaobjectRef {
    pub id: String,
    pub handle: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// No critical step failed.
    pub ok: bool,
    pub steps: Vec<ImportStep>,
    pub metaobject: Option<MetaobjectRef>,
    pub unknown_terpenes: Vec<String>,
    pub posted: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepostTarget {
    pub file_id: String,
    pub file_url: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepostOutcome {
    pub file_id: String,
    pub ok: bool,
    pub name: String,
    /// "updated" | "added"
    pub action: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepostResult {
    pub posted: usize,
    pub failed: usize,
    pub results: Vec<RepostOutcome>,
}

// -- small helpers -----------------------------------------------------------------------------

/// Trimmed copy of an optional string; None when missing or blank.
fn opt_text(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// `name` without a trailing `.pdf` (any case).
fn pdf_stem(name: &str) -> &str {
    match name.len().checked_sub(4).and_then(|i| name.get(i..)).filter(|t| t.eq_ignore_ascii_case(".pdf")) {
        Some(_) => &name[..name.len() - 4],
        None => name,
    }
}

/// Err listing every `userErrors[].message` when Shopify returned any.
fn check_user_errors(errs: &serde_json::Value, what: &str) -> Result<(), String> {
    match errs.as_array() {
        Some(a) if !a.is_empty() => Err(format!(
            "{what}: {}",
            a.iter().map(|e| e["message"].as_str().unwrap_or("unknown error")).collect::<Vec<_>>().join("; ")
        )),
        _ => Ok(()),
    }
}

/// Inverse of `base64_encode`: standard alphabet, padding optional, ASCII whitespace ignored, and a
/// `data:…;base64,` prefix (what FileReader.readAsDataURL yields) skipped.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = if s.starts_with("data:") { s.split_once(',').map_or("", |(_, b)| b) } else { s };
    let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body: &[u8] = &bytes;
    let body = body.strip_suffix(b"==").or_else(|| body.strip_suffix(b"=")).unwrap_or(body);
    if body.len() % 4 == 1 {
        return Err("invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity(body.len() / 4 * 3 + 2);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in body {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("invalid base64 character {:?}", c as char)),
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Metaobject handle = the dedupe key: lowercase, non-alphanumeric runs → `-`, trimmed, ≤80 chars;
/// nothing usable → `coa-<unix secs>` (mirrors the backfill script's convention).
fn slugify_handle(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.chars().take(80).collect();
    let out = out.trim_end_matches('-');
    if out.is_empty() { format!("coa-{}", now_secs()) } else { out.to_string() }
}

/// Block-name identity on /pages/coa: trimmed, lowercased, inner whitespace runs collapsed.
fn norm_name(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// `certificate_<6 alnum>`; a tiny LCG seeded from the clock — uniqueness within one template is all it needs.
fn new_block_id() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) | 1;
    let id: String = (0..6)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            CHARS[(x >> 33) as usize % CHARS.len()] as char
        })
        .collect();
    format!("certificate_{id}")
}

// -- upload ------------------------------------------------------------------------------------

fn staged_upload_vars(filename: &str, size: usize) -> serde_json::Value {
    serde_json::json!({ "input": [{
        "filename": filename,
        "mimeType": "application/pdf",
        "resource": "FILE",
        "httpMethod": "POST",
        "fileSize": size.to_string(),
    }] })
}

// Uploads a COA PDF into the retail Files library (needs write_files): stagedUploadsCreate →
// multipart POST to the staged target → fileCreate → poll until READY. Files are async, so after
// 20 s without a url we still return ok=false with the id rather than failing.
#[tauri::command]
async fn upload_coa_pdf(filename: String, data_base64: String) -> Result<UploadResult, String> {
    let filename = filename.trim().to_string();
    if !filename.to_ascii_lowercase().ends_with(".pdf") {
        return Err("COA uploads must be PDFs".to_string());
    }
    let bytes = base64_decode(&data_base64)?;
    if bytes.is_empty() {
        return Err("Empty file".to_string());
    }

    let staged = graphql_request(SHOP_RETAIL, STAGED_UPLOAD_MUTATION, Some(staged_upload_vars(&filename, bytes.len())))
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "write_files", "file upload"))?;
    let staged = &staged["data"]["stagedUploadsCreate"];
    check_user_errors(&staged["userErrors"], "stagedUploadsCreate")?;
    let target = &staged["stagedTargets"][0];
    let (url, resource_url) = match (target["url"].as_str(), target["resourceUrl"].as_str()) {
        (Some(u), Some(r)) => (u, r),
        _ => return Err("No staged target returned".to_string()),
    };

    // Every returned parameter first, the file part last (the signed-POST contract).
    let mut form = reqwest::multipart::Form::new();
    for p in target["parameters"].as_array().into_iter().flatten() {
        if let (Some(n), Some(v)) = (p["name"].as_str(), p["value"].as_str()) {
            form = form.text(n.to_string(), v.to_string());
        }
    }
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str("application/pdf")
        .map_err(|e| e.to_string())?;
    let up = reqwest::Client::new()
        .post(url)
        .multipart(form.part("file", part))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("Staged upload failed: {e}"))?;
    if !up.status().is_success() {
        let status = up.status().as_u16();
        let txt = up.text().await.unwrap_or_default();
        return Err(format!("Staged upload failed: {status} {}", txt.chars().take(300).collect::<String>()));
    }

    let created = graphql_request(
        SHOP_RETAIL,
        FILE_CREATE_MUTATION,
        Some(serde_json::json!({ "files": [{ "originalSource": resource_url, "contentType": "FILE", "alt": pdf_stem(&filename) }] })),
    )
    .await?;
    let created = &created["data"]["fileCreate"];
    check_user_errors(&created["userErrors"], "fileCreate")?;
    let mut file = created["files"][0].clone();
    let file_id = file["id"].as_str().ok_or("fileCreate returned no file")?.to_string();

    for _ in 0..FILE_STATUS_POLLS {
        if file["fileStatus"] == "READY" && non_empty(&file["url"]).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Ok(r) = graphql_request(SHOP_RETAIL, FILE_STATUS_QUERY, Some(serde_json::json!({ "id": file_id }))).await {
            let node = &r["data"]["node"];
            if node["fileStatus"] == "FAILED" {
                return Err(format!("Shopify reported the file upload FAILED ({file_id})"));
            }
            if node["id"].is_string() {
                file = node.clone();
            }
        }
    }
    let url = non_empty(&file["url"]);
    Ok(UploadResult {
        ok: file["fileStatus"] == "READY" && url.is_some(),
        file_id,
        url,
        file_status: file["fileStatus"].as_str().unwrap_or("UNKNOWN").to_string(),
        filename,
    })
}

// -- terpenes ----------------------------------------------------------------------------------

/// norm_key(name | handle) → metaobject gid for every `terpene` metaobject on retail.
fn terpene_library(nodes: &[serde_json::Value]) -> HashMap<String, String> {
    let mut lib = HashMap::new();
    for n in nodes {
        let Some(id) = n["id"].as_str() else { continue };
        for key in [&n["nameField"]["value"], &n["handle"]].into_iter().filter_map(non_empty) {
            lib.insert(norm_key(&key), id.to_string());
        }
    }
    lib
}

async fn fetch_terpene_library() -> Result<HashMap<String, String>, String> {
    let r = graphql_request(SHOP_RETAIL, TERPENES_QUERY, None)
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "read_metaobjects", "terpene library"))?;
    Ok(terpene_library(r["data"]["metaobjects"]["nodes"].as_array().map(Vec::as_slice).unwrap_or_default()))
}

/// Lab reports decorate names ("beta-Caryophyllene", "β-Myrcene", "trans-Ocimene") while the library
/// keys are bare, so drop one leading greek letter / isomer prefix before normalising.
fn terpene_lookup_key(name: &str) -> String {
    const PREFIXES: [&str; 13] =
        ["alpha", "beta", "gamma", "delta", "cis", "trans", "endo", "exo", "iso", "α", "β", "γ", "δ"];
    let lower = name.to_lowercase();
    let mut rest = lower.as_str();
    if let Some(p) = PREFIXES.iter().find(|p| rest.starts_with(*p)) {
        rest = rest[p.len()..].trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '_' | '-'));
    }
    if let Some(p) = ["α", "β", "γ", "δ"].iter().find(|p| rest.starts_with(*p)) {
        rest = &rest[p.len()..];
    }
    norm_key(rest)
}

/// (terpene_profile entries, unknown names): parsed names → canonical `terpene` metaobject gids.
fn map_terpenes(terpenes: &[CoaTerpeneIn], lib: &HashMap<String, String>) -> (Vec<serde_json::Value>, Vec<String>) {
    let (mut profile, mut unknown) = (Vec::new(), Vec::new());
    for t in terpenes.iter().filter(|t| !t.name.trim().is_empty()) {
        match lib.get(&norm_key(&t.name)).or_else(|| lib.get(&terpene_lookup_key(&t.name))) {
            Some(gid) => profile.push(serde_json::json!({ "terpene_id": gid, "pct": t.percent })),
            None => unknown.push(t.name.clone()),
        }
    }
    (profile, unknown)
}

// -- coa_record metaobject ---------------------------------------------------------------------

/// coa_record fields for metaobjectUpsert: strings only (Shopify's rule), blank/absent values dropped.
fn coa_record_fields(
    req: &ImportRequest,
    batch_id: &str,
    issued: &str,
    expiry: &str,
    terpene_profile: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let f = &req.fields;
    let num = |v: Option<f64>| v.map(|n| n.to_string());
    let pairs = [
        ("batch_id", Some(batch_id.to_string())),
        ("report_date", Some(issued.to_string())),
        ("expiry_date", Some(expiry.to_string())),
        ("lab_name", opt_text(&f.lab)),
        ("pdf_file", Some(req.file_id.clone())),
        ("thca_percent", num(f.thca_percent)),
        ("cbd_percent", num(f.cbd_percent)),
        ("cbg_percent", num(f.cbg_percent)),
        ("total_cannabinoids", num(f.total_cannabinoids_percent)),
        (
            "terpene_profile",
            (!terpene_profile.is_empty()).then(|| serde_json::Value::Array(terpene_profile.to_vec()).to_string()),
        ),
        ("notes", opt_text(&f.notes)),
        ("display_title", opt_text(&req.page_name)),
    ];
    pairs.into_iter().filter_map(|(key, value)| Some(serde_json::json!({ "key": key, "value": value? }))).collect()
}

fn metaobject_upsert_vars(handle: &str, fields: &[serde_json::Value], post: bool) -> serde_json::Value {
    serde_json::json!({
        "handle": { "type": "coa_record", "handle": handle },
        "metaobject": {
            "fields": fields,
            "capabilities": { "publishable": { "status": if post { "ACTIVE" } else { "DRAFT" } } }
        }
    })
}

/// Field keys Shopify rejected (code — or message when there is no code — mentions field/key): the
/// last `field` path segment, never the `fields` container itself.
fn bad_field_keys(errors: &serde_json::Value) -> Vec<String> {
    errors
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| {
            let t = non_empty(&e["code"]).or_else(|| non_empty(&e["message"])).unwrap_or_default().to_lowercase();
            t.contains("field") || t.contains("key")
        })
        .filter_map(|e| e["field"].as_array()?.last()?.as_str().map(String::from))
        .filter(|k| k != "fields")
        .collect()
}

async fn run_metaobject_upsert(handle: &str, fields: &[serde_json::Value], post: bool) -> Result<serde_json::Value, String> {
    graphql_request(SHOP_RETAIL, METAOBJECT_UPSERT_MUTATION, Some(metaobject_upsert_vars(handle, fields, post))).await
}

/// metaobjectUpsert with one retry: when Shopify names keys the definition lacks (the optional
/// expiry_date / terpene_profile / display_title additions) they are dropped so the core record
/// still lands. Returns (ref, dropped keys).
async fn upsert_coa_record(
    handle: &str,
    fields: Vec<serde_json::Value>,
    post: bool,
) -> Result<(MetaobjectRef, Vec<String>), String> {
    let mut data = run_metaobject_upsert(handle, &fields, post)
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "write_metaobjects", "metaobject"))?;
    let dropped = bad_field_keys(&data["data"]["metaobjectUpsert"]["userErrors"]);
    if !dropped.is_empty() {
        let retry: Vec<_> = fields.into_iter().filter(|f| !dropped.iter().any(|k| f["key"] == k.as_str())).collect();
        data = run_metaobject_upsert(handle, &retry, post).await?;
    }
    let upsert = &data["data"]["metaobjectUpsert"];
    check_user_errors(&upsert["userErrors"], "metaobjectUpsert")?;
    let mo = &upsert["metaobject"];
    match (mo["id"].as_str(), mo["handle"].as_str()) {
        (Some(id), Some(h)) => Ok((MetaobjectRef { id: id.to_string(), handle: h.to_string() }, dropped)),
        _ => Err("metaobjectUpsert returned no metaobject".to_string()),
    }
}

// -- product link ------------------------------------------------------------------------------

/// The Master COA Sheet's "Flower Type" dropdown has exactly four options; Shopify's
/// custom.flower_type words them differently ("Type 1 - High THCa"), so normalise by Type number
/// first, cannabinoid keywords second. Anything else (Hybrid/Indica/Sativa from strain_type) is
/// None — better a blank cell than a value the dropdown rejects.
fn canonical_flower_type(v: &str) -> Option<&'static str> {
    let s = v.to_lowercase();
    if s.is_empty() {
        return None;
    }
    // /type\s*-?\s*[1-4]/, lowest type number first like the old regex chain.
    let type_no = s
        .match_indices("type")
        .filter_map(|(i, _)| {
            let rest = s[i + 4..].trim_start();
            rest.strip_prefix('-').unwrap_or(rest).trim_start().chars().next().filter(|c| ('1'..='4').contains(c))
        })
        .min();
    let has_thca = s.contains("thca") || s.contains("thc-a");
    // /\bcbd\b/
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let has_cbd_word = s.match_indices("cbd").any(|(i, _)| !word(s[..i].chars().next_back()) && !word(s[i + 3..].chars().next()));
    Some(match type_no {
        Some('1') => "Type 1 (THCa)",
        Some('2') => "Type 2 (THCa & CBD)",
        Some('3') => "Type 3 (CBD)",
        Some('4') => "Type 4 (CBG)",
        _ if s.contains("cbg") => "Type 4 (CBG)",
        _ if has_thca && s.contains("cbd") => "Type 2 (THCa & CBD)",
        _ if has_cbd_word => "Type 3 (CBD)",
        _ if has_thca => "Type 1 (THCa)",
        _ => return None,
    })
}

/// Appends the metaobject to the product's custom.coa_records (read-modify-write: products
/// accumulate COAs over time). Returns (list length afterwards, canonical flower type, category);
/// the last two feed the Google Sheet row.
async fn link_product_coa(product_id: &str, metaobject_id: &str) -> Result<(usize, Option<&'static str>, Option<String>), String> {
    let r = graphql_request(SHOP_RETAIL, PRODUCT_COA_RECORDS_QUERY, Some(serde_json::json!({ "id": product_id }))).await?;
    let product = &r["data"]["product"];
    if !product.is_object() {
        return Err("product not found".to_string());
    }
    let flower_type = non_empty(&product["flowerType"]["value"])
        .or_else(|| non_empty(&product["strainType"]["value"]))
        .and_then(|v| canonical_flower_type(&v));
    let category = non_empty(&product["category"]["value"]);
    let mut current: Vec<String> =
        product["metafield"]["value"].as_str().and_then(|v| serde_json::from_str(v).ok()).unwrap_or_default();
    if !current.iter().any(|id| id == metaobject_id) {
        current.push(metaobject_id.to_string());
    }
    let vars = serde_json::json!({ "metafields": [{
        "ownerId": product_id,
        "namespace": "custom",
        "key": "coa_records",
        "type": "list.metaobject_reference",
        "value": serde_json::json!(current).to_string(),
    }] });
    let r = graphql_request(SHOP_RETAIL, METAFIELDS_SET_MUTATION, Some(vars))
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "write_products", "product metafield"))?;
    check_user_errors(&r["data"]["metafieldsSet"]["userErrors"], "metafieldsSet")?;
    Ok((current.len(), flower_type, category))
}

// -- /pages/coa template -----------------------------------------------------------------------

/// The template JSON after the `/* … */` comment Shopify prepends (first `{` onward).
fn parse_theme_template(raw: &str) -> Result<serde_json::Value, String> {
    let start = raw.find('{').ok_or("template file is not JSON")?;
    let v: serde_json::Value = serde_json::from_str(&raw[start..]).map_err(|e| format!("template JSON: {e}"))?;
    if v["sections"].is_object() { Ok(v) } else { Err("template has no sections".to_string()) }
}

/// Raw template copy under <app data>/theme-backups/ so a bad merge can be pasted back into the theme editor.
fn backup_theme_template(app: &tauri::AppHandle, raw: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?.join("theme-backups");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_millis()).unwrap_or(0);
    let path = dir.join(format!("page.certificate-of-analysis.{}-{ms:03}.json", utc_now_iso().replace(':', "-")));
    fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path)
}

/// Updates `certificate_file` on the block named `name` (case/whitespace-insensitive, in ANY
/// certificate-of-analysis section — disabled ones too, so a re-enable can't resurrect a stale PDF);
/// otherwise inserts a new block alphabetically into the largest enabled section, keeping
/// `block_order` in step. Returns the step detail `{action, sectionId, blockId, position?}`.
fn upsert_certificate_block(
    template: &mut serde_json::Value,
    name: &str,
    file_url: &str,
    new_block_id: &str,
) -> Result<serde_json::Value, String> {
    let want = norm_name(name);
    let sections = template["sections"].as_object_mut().ok_or("template has no sections")?;
    let is_coa = |sec: &serde_json::Value| sec["type"] == "certificate-of-analysis";

    for (sid, sec) in sections.iter_mut().filter(|(_, s)| is_coa(s)) {
        let Some(blocks) = sec.get_mut("blocks").and_then(serde_json::Value::as_object_mut) else { continue };
        for (bid, block) in blocks.iter_mut() {
            if block["settings"]["certificate_name"].as_str().is_some_and(|n| norm_name(n) == want) {
                block["settings"]["certificate_file"] = serde_json::json!(file_url);
                return Ok(serde_json::json!({ "action": "updated", "sectionId": sid, "blockId": bid }));
            }
        }
    }

    let block_count = |s: &serde_json::Value| s["blocks"].as_object().map_or(0, serde_json::Map::len);
    let (sid, sec) = sections
        .iter_mut()
        .filter(|(_, s)| is_coa(s) && !s["disabled"].as_bool().unwrap_or(false))
        .min_by_key(|(_, s)| std::cmp::Reverse(block_count(s)))
        .ok_or("No enabled certificate-of-analysis section in template")?;
    if !sec["blocks"].is_object() {
        sec["blocks"] = serde_json::json!({});
    }
    let mut order: Vec<String> =
        sec["block_order"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
    let blocks = sec["blocks"].as_object_mut().expect("object");
    let key = name.to_lowercase();
    let position = order
        .iter()
        .position(|bid| {
            blocks.get(bid).and_then(|b| b["settings"]["certificate_name"].as_str()).unwrap_or("").to_lowercase() > key
        })
        .unwrap_or(order.len());
    blocks.insert(
        new_block_id.to_string(),
        serde_json::json!({
            "type": "certificate",
            "name": name,
            "settings": { "certificate_name": name, "certificate_file": file_url }
        }),
    );
    order.insert(position, new_block_id.to_string());
    sec["block_order"] = serde_json::json!(order);
    Ok(serde_json::json!({ "action": "added", "sectionId": sid, "blockId": new_block_id, "position": position }))
}

/// Upserts one certificate block on /pages/coa (see `upsert_certificate_block`) and writes the
/// template back through themeFilesUpsert (needs write_themes), backing the raw file up locally first.
async fn post_coa_to_page(app: &tauri::AppHandle, name: &str, file_url: &str) -> Result<serde_json::Value, String> {
    if name.trim().is_empty() || file_url.trim().is_empty() {
        return Err("post_coa_to_page needs name + fileUrl".to_string());
    }
    let themes = graphql_request(SHOP_RETAIL, MAIN_THEME_QUERY, None)
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "read_themes", "theme"))?;
    let theme = &themes["data"]["themes"]["nodes"][0];
    let (theme_id, theme_name) = match (theme["id"].as_str(), theme["name"].as_str()) {
        (Some(id), Some(n)) => (id.to_string(), n.to_string()),
        _ => return Err("No MAIN theme found".to_string()),
    };
    let file = graphql_request(
        SHOP_RETAIL,
        THEME_FILE_QUERY,
        Some(serde_json::json!({ "id": theme_id, "names": [COA_TEMPLATE_FILENAME] })),
    )
    .await?;
    let raw = file["data"]["node"]["files"]["nodes"][0]["body"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{COA_TEMPLATE_FILENAME} not found on theme \"{theme_name}\""))?;
    let mut template = parse_theme_template(raw)?;
    if let Err(e) = backup_theme_template(app, raw) {
        eprintln!("theme backup failed (continuing): {e}");
    }
    let mut detail = upsert_certificate_block(&mut template, name, file_url, &new_block_id())?;

    let body = serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?;
    let vars = serde_json::json!({
        "themeId": theme_id,
        "files": [{ "filename": COA_TEMPLATE_FILENAME, "body": { "type": "TEXT", "value": body } }]
    });
    let written = graphql_request(SHOP_RETAIL, THEME_FILES_UPSERT_MUTATION, Some(vars))
        .await
        .map_err(|e| scope_denied(e, SHOP_RETAIL, "write_themes", "theme file"))?;
    check_user_errors(&written["data"]["themeFilesUpsert"]["userErrors"], "themeFilesUpsert")?;
    detail["themeName"] = serde_json::json!(theme_name);
    Ok(detail)
}

// -- import / repost commands ------------------------------------------------------------------

fn record_step(steps: &mut Vec<ImportStep>, step: &str, critical: bool, outcome: Result<serde_json::Value, String>) {
    let (detail, error) = match outcome {
        Ok(d) => (Some(d), None),
        Err(e) => (None, Some(e)),
    };
    steps.push(ImportStep { step: step.to_string(), ok: error.is_none(), critical, error, detail });
}

// Orchestrated import (the old POST /api/coas/import minus the Google legs). Every step is recorded
// so the wizard can show ✓/✗ per leg and retry one; only `metaobject` is critical and stops the run.
#[tauri::command]
async fn import_coa(app: tauri::AppHandle, req: ImportRequest) -> Result<ImportResult, String> {
    if req.file_id.trim().is_empty() {
        return Err("fileId is required".to_string());
    }
    let f = &req.fields;
    let batch_id = opt_text(&f.batch_id)
        .or_else(|| req.file_name.as_deref().map(pdf_stem).map(str::trim).filter(|s| !s.is_empty()).map(String::from))
        .unwrap_or_else(|| req.file_id.rsplit('/').next().unwrap_or_default().to_string());
    let handle = slugify_handle(&batch_id);
    let (issued, issued_days) = match opt_text(&f.issue_date) {
        Some(s) => ymd(&s).map(|(p, d)| (p.to_string(), d)).ok_or_else(|| format!("issueDate must be YYYY-MM-DD, got {s:?}"))?,
        None => (ymd_string(today_days()), today_days()),
    };
    let expiry = match opt_text(&f.expiry_date) {
        Some(s) => ymd(&s).map(|(p, _)| p.to_string()).ok_or_else(|| format!("expiryDate must be YYYY-MM-DD, got {s:?}"))?,
        None => ymd_string(issued_days + COA_VALID_DAYS),
    };
    let mut steps = Vec::new();

    // 1. Terpene names → canonical metaobject gids (unknown names are reported, never fatal).
    let (mut profile, mut unknown) = (Vec::new(), Vec::new());
    let outcome = fetch_terpene_library().await.map(|lib| {
        let (p, u) = map_terpenes(&f.terpenes, &lib);
        let detail = serde_json::json!({ "matched": p.len(), "unknown": u });
        (profile, unknown) = (p, u);
        detail
    });
    record_step(&mut steps, "terpenes", false, outcome);

    // 2. coa_record metaobject — critical; nothing downstream makes sense without it.
    let fields = coa_record_fields(&req, &batch_id, &issued, &expiry, &profile);
    let (metaobject, outcome) = match upsert_coa_record(&handle, fields, req.post).await {
        Ok((mo, dropped)) => {
            let mut d = serde_json::json!({ "id": mo.id, "handle": mo.handle, "posted": req.post });
            if !dropped.is_empty() {
                d["droppedFields"] = serde_json::json!(dropped);
            }
            (Some(mo), Ok(d))
        }
        Err(e) => (None, Err(e)),
    };
    record_step(&mut steps, "metaobject", true, outcome);
    let Some(metaobject) = metaobject else {
        return Ok(ImportResult { ok: false, steps, metaobject: None, unknown_terpenes: unknown, posted: req.post });
    };
    tokio::time::sleep(IMPORT_MUTATION_GAP).await;

    // 3. Product link, mirrored into __manualLinks so list_coas joins the file immediately.
    if let Some(pid) = opt_text(&req.product_id) {
        let outcome = async {
            let (total, flower_type, category) = link_product_coa(&pid, &metaobject.id).await?;
            let title = opt_text(&req.product_title).unwrap_or_else(|| pid.clone());
            save_coa_link(app.clone(), req.file_id.clone(), Some(pid.clone()), Some(title)).await?;
            // flowerType/category ride along so the wizard can carry them into the Google Sheet row.
            Ok::<_, String>(serde_json::json!({ "linked": pid, "totalRecords": total, "flowerType": flower_type, "category": category }))
        }
        .await;
        record_step(&mut steps, "productLink", false, outcome);
        tokio::time::sleep(IMPORT_MUTATION_GAP).await;
    }

    // 4. /pages/coa block — what customers actually see; the metaobject is the structured truth.
    if req.post {
        let page_name = opt_text(&req.page_name)
            .or_else(|| opt_text(&req.product_title))
            .or_else(|| req.file_name.as_deref().map(|n| pdf_stem(n).replace('_', " ").trim().to_string()))
            .unwrap_or_default();
        let outcome = match opt_text(&req.file_url) {
            Some(url) => post_coa_to_page(&app, &page_name, &url).await,
            None => Err("no fileUrl yet — file may still be propagating; retry from the COAs page".to_string()),
        };
        record_step(&mut steps, "coaPage", false, outcome);
        tokio::time::sleep(IMPORT_MUTATION_GAP).await;
    }

    // 5. The reviewed fields are authoritative now: cache them so list_coas shows them without a re-parse.
    let outcome = with_coa_cache(&app, true, |cache| {
        cache[req.file_id.as_str()] = serde_json::json!({
            "parsedAt": utc_now_iso(),
            "model": "import:reviewed",
            "fields": {
                "issue_date": issued,
                "lab": f.lab,
                "producer": f.producer,
                "batch_id": batch_id,
                "thca_percent": f.thca_percent,
                "cbda_percent": f.cbd_percent,
                "cbg_percent": f.cbg_percent,
                "total_cannabinoids_percent": f.total_cannabinoids_percent,
                "terpenes": f.terpenes.iter().map(|t| serde_json::json!({ "name": t.name, "percent": t.percent })).collect::<Vec<_>>(),
                "qr_present": f.qr_present,
            }
        });
    })
    .map(|()| serde_json::json!({}));
    record_step(&mut steps, "cacheFields", false, outcome);

    Ok(ImportResult {
        ok: !steps.iter().any(|s| s.critical && !s.ok),
        steps,
        metaobject: Some(metaobject),
        unknown_terpenes: unknown,
        posted: req.post,
    })
}

/// Explicit name > cache __manualLinks[file].productTitle > cleaned filename (no .pdf / `_<uuid>`, `_` → space).
fn repost_name(t: &RepostTarget, manual_links: &serde_json::Value) -> String {
    opt_text(&t.name)
        .or_else(|| non_empty(&manual_links[t.file_id.as_str()]["productTitle"]))
        .unwrap_or_else(|| filename_key(&t.file_url).0)
        .trim()
        .to_string()
}

// Re-posts existing PDFs to /pages/coa one at a time (each is a full template read + write).
#[tauri::command]
async fn repost_coas(app: tauri::AppHandle, targets: Vec<RepostTarget>) -> Result<RepostResult, String> {
    if targets.is_empty() {
        return Err("targets required".to_string());
    }
    let manual_links = with_coa_cache(&app, false, |cache| cache["__manualLinks"].clone())?;
    let mut results = Vec::with_capacity(targets.len());
    for (i, t) in targets.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(REPOST_GAP).await;
        }
        let name = repost_name(t, &manual_links);
        let outcome = if t.file_url.trim().is_empty() {
            Err("file has no URL yet (still propagating?)".to_string())
        } else {
            post_coa_to_page(&app, &name, &t.file_url).await
        };
        results.push(RepostOutcome {
            file_id: t.file_id.clone(),
            ok: outcome.is_ok(),
            name,
            action: outcome.as_ref().ok().and_then(|d| d["action"].as_str().map(String::from)),
            error: outcome.err(),
        });
    }
    Ok(RepostResult {
        posted: results.iter().filter(|r| r.ok).count(),
        failed: results.iter().filter(|r| !r.ok).count(),
        results,
    })
}

// ---- Google Drive + Sheet mirror --------------------------------------------------------------
// Ported from the old dashboard's lib/google.mjs (getStatus, uploadPdfToDrive, upsertCoaRow):
// service-account auth (RS256 JWT via ring → one-hour access token), Drive upload with same-name
// dedupe, and a header-driven Sheet upsert keyed by batch, else product name. Config arrives from
// the TS side on every call; nothing Google-related is persisted in Rust.

const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES: &str = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";
const SHEETS_API: &str = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// Google tokens last 60 min; refresh a little early.
const GOOGLE_TOKEN_TTL: Duration = Duration::from_secs(55 * 60);
const GOOGLE_HTTP_TIMEOUT: Duration = Duration::from_secs(60);
const SHEET_META_FIELDS: &str = "properties.title,sheets.properties(title,sheetId)";
/// The window the sheet writer reads and keys on (same as the old dashboard).
const SHEET_GRID_RANGE: &str = "A1:Z2000";
/// Header written only when the tab is empty; every label maps back through `header_field`.
const DEFAULT_COLUMNS: [&str; 14] = [
    "Batch", "Product / Strain", "Lab", "Issued", "Expires", "THCa %", "CBD %", "CBG %",
    "Total Cannabinoids %", "Shopify PDF", "Drive Link", "Posted", "Imported At", "Notes",
];
/// Cells the live sheet keeps as M/D/YYYY.
const SHEET_DATE_FIELDS: [&str; 3] = ["issued", "expires", "importedAt"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GoogleConfig {
    /// Path to the service-account JSON key.
    pub key_file: String,
    pub sheet_id: Option<String>,
    /// Tab name; the first tab when unset.
    pub sheet_tab: Option<String>,
    pub folder_id: Option<String>,
}

impl GoogleConfig {
    fn sheet_id(&self) -> Option<String> {
        opt_text(&self.sheet_id)
    }
    fn folder_id(&self) -> Option<String> {
        opt_text(&self.folder_id)
    }
    fn configured(&self) -> bool {
        !self.key_file.trim().is_empty() && (self.sheet_id().is_some() || self.folder_id().is_some())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    pub configured: bool,
    pub service_account_email: Option<String>,
    pub sheet_reachable: bool,
    pub sheet_title: Option<String>,
    pub tabs: Vec<String>,
    pub drive_reachable: bool,
    pub drive_folder_name: Option<String>,
    /// Bad key file, unshared Sheet/folder, network — never an Err from the command.
    pub error: Option<String>,
}

/// One COA row as the wizard reviewed it; numbers arrive already formatted by the TS side.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SheetRow {
    pub batch: Option<String>,
    pub product_name: Option<String>,
    pub flower_type: Option<String>,
    pub category: Option<String>,
    pub lab: Option<String>,
    pub issued: Option<String>,
    pub expires: Option<String>,
    pub thca: Option<String>,
    pub cbd: Option<String>,
    pub cbg: Option<String>,
    pub total_cannabinoids: Option<String>,
    pub shopify_url: Option<String>,
    /// "Yes" | "No" (the sheet's convention).
    pub posted: Option<String>,
    /// Defaults to now (UTC) when unset.
    pub imported_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRequest {
    /// Shopify CDN url of the PDF; without it the Drive leg is skipped.
    pub file_url: Option<String>,
    /// Drive filename, "<page name>.pdf" — re-tests overwrite the same file.
    pub pdf_name: String,
    #[serde(default)]
    pub row: SheetRow,
}

/// `ok` only when the upload happened; a skipped leg has `skipped` set and no `error`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveOutcome {
    pub ok: bool,
    pub skipped: Option<String>,
    pub web_view_link: Option<String>,
    pub file_id: Option<String>,
    /// An existing same-name file was overwritten instead of creating a sibling.
    pub deduped: bool,
    pub error: Option<String>,
}

/// `ok` only when the row landed; a skipped leg has `skipped` set and no `error`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetOutcome {
    pub ok: bool,
    pub skipped: Option<String>,
    /// "updated" | "appended"
    pub action: Option<String>,
    pub row_number: Option<u32>,
    pub tab: Option<String>,
    /// Canonical fields the tab's header row exposes.
    pub matched_fields: Vec<String>,
    /// "chip" | "hyperlink-fallback (…)" | "skipped" | "failed (…)"
    pub chip: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorResult {
    pub drive: DriveOutcome,
    pub sheet: SheetOutcome,
}

/// The parts of a service-account key file we use. No Debug on purpose: the key never gets logged.
#[derive(Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    #[serde(default)]
    token_uri: Option<String>,
}

// -- auth --------------------------------------------------------------------------------------

/// base64 with the URL alphabet and no padding (JWT segments).
fn base64url_encode(bytes: &[u8]) -> String {
    base64_encode(bytes).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

/// PEM → DER: drop the `-----BEGIN/END …-----` lines and decode the rest.
fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    let body: String = pem.lines().filter(|l| !l.trim_start().starts_with("-----")).collect();
    base64_decode(&body).map_err(|e| format!("private_key is not valid PEM: {e}"))
}

/// `<header>.<claims>` of the service-account assertion (RFC 7523), both base64url.
fn jwt_signing_input(client_email: &str, iat: i64) -> String {
    let claims = serde_json::json!({
        "iss": client_email,
        "scope": GOOGLE_SCOPES,
        "aud": GOOGLE_TOKEN_URL,
        "iat": iat,
        "exp": iat + 3600,
    });
    format!("{}.{}", base64url_encode(br#"{"alg":"RS256","typ":"JWT"}"#), base64url_encode(claims.to_string().as_bytes()))
}

/// RS256 over `signing_input` with the PKCS#8 key; returns the full three-segment JWT.
fn sign_jwt(pkcs8_der: &[u8], signing_input: &str) -> Result<String, String> {
    let key = ring::signature::RsaKeyPair::from_pkcs8(pkcs8_der).map_err(|e| format!("private_key rejected: {e}"))?;
    let mut sig = vec![0u8; key.public().modulus_len()];
    key.sign(&ring::signature::RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), signing_input.as_bytes(), &mut sig)
        .map_err(|e| format!("JWT signing failed: {e}"))?;
    Ok(format!("{signing_input}.{}", base64url_encode(&sig)))
}

fn load_service_account(key_file: &str) -> Result<ServiceAccount, String> {
    let raw = fs::read_to_string(key_file).map_err(|e| format!("cannot read key file {key_file}: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("key file is not a service-account JSON: {e}"))
}

/// Sends a Google API request; non-2xx becomes Err carrying `error.message` (or the truncated body).
async fn google_call(req: reqwest::RequestBuilder, what: &str) -> Result<serde_json::Value, String> {
    let resp = req.send().await.map_err(|e| format!("{what}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("{what}: {e}"))?;
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| non_empty(&v["error"]["message"]))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("{what} failed ({}): {msg}", status.as_u16()));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("{what}: bad JSON: {e}"))
}

/// Access token for the service account (cached 55 min in the shared token cache) plus its email.
async fn google_access_token(key_file: &str) -> Result<(String, String), String> {
    let sa = load_service_account(key_file)?;
    let cache_key = format!("google:{}", sa.client_email);
    let cached = token_cache().lock().unwrap().tokens.get(&cache_key).filter(|c| SystemTime::now() < c.expires_at).map(|c| c.token.clone());
    if let Some(token) = cached {
        return Ok((token, sa.client_email));
    }
    let jwt = sign_jwt(&pem_to_der(&sa.private_key)?, &jwt_signing_input(&sa.client_email, now_secs()))?;
    let token_uri = sa.token_uri.as_deref().map(str::trim).filter(|u| !u.is_empty()).unwrap_or(GOOGLE_TOKEN_URL);
    let req = reqwest::Client::new()
        .post(token_uri)
        .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", jwt.as_str())])
        .timeout(GOOGLE_HTTP_TIMEOUT);
    let body = google_call(req, "Google token").await?;
    let token = non_empty(&body["access_token"]).ok_or("Google token response had no access_token")?;
    token_cache()
        .lock()
        .unwrap()
        .tokens
        .insert(cache_key, CachedToken { token: token.clone(), expires_at: SystemTime::now() + GOOGLE_TOKEN_TTL });
    Ok((token, sa.client_email))
}

/// Client with the bearer token as a default header. Never use it for non-Google urls.
fn google_client(token: &str) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    let value = format!("Bearer {token}").parse().map_err(|_| "access token is not header-safe".to_string())?;
    headers.insert(reqwest::header::AUTHORIZATION, value);
    reqwest::Client::builder().default_headers(headers).timeout(GOOGLE_HTTP_TIMEOUT).build().map_err(|e| e.to_string())
}

/// encodeURIComponent: everything but unreserved characters percent-encoded (for path segments).
fn url_encode(s: &str) -> String {
    s.bytes().fold(String::with_capacity(s.len()), |mut out, b| {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
        out
    })
}

// -- Drive -------------------------------------------------------------------------------------

/// The PDF bytes from the Shopify CDN (plain client: the Google bearer must never go there).
async fn download_pdf(url: &str) -> Result<Vec<u8>, String> {
    let resp = reqwest::Client::new().get(url).timeout(GOOGLE_HTTP_TIMEOUT).send().await.map_err(|e| format!("fetch pdf: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch pdf {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("fetch pdf: {e}"))?;
    if bytes.is_empty() {
        return Err("fetch pdf: empty body".to_string());
    }
    Ok(bytes.to_vec())
}

/// `multipart/related` body for Drive's uploadType=multipart: the JSON metadata part, then the file.
fn multipart_related(meta_json: &str, mime: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("flow_command_{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut body =
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta_json}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n")
            .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/related; boundary={boundary}"), body)
}

/// Uploads `bytes` as `name` into the folder; a same-name file there is overwritten (files.list
/// dedupe) so re-tests don't pile up hashed duplicates.
async fn drive_upload(client: &reqwest::Client, folder: &str, name: &str, bytes: Vec<u8>) -> Result<DriveOutcome, String> {
    let q = format!("name = '{}' and '{folder}' in parents and trashed = false", name.replace('\\', "\\\\").replace('\'', "\\'"));
    let found = google_call(
        client.get(DRIVE_API).query(&[
            ("q", q.as_str()),
            ("fields", "files(id,name,webViewLink)"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ]),
        "Drive search",
    )
    .await?;
    if let Some(existing) = found["files"].as_array().and_then(|f| f.first()) {
        let id = non_empty(&existing["id"]).ok_or("Drive search returned a file without an id")?;
        google_call(
            client
                .patch(format!("{DRIVE_UPLOAD_API}/{id}"))
                .query(&[("uploadType", "media"), ("supportsAllDrives", "true")])
                .header(reqwest::header::CONTENT_TYPE, "application/pdf")
                .body(bytes),
            "Drive update",
        )
        .await?;
        return Ok(DriveOutcome { ok: true, web_view_link: non_empty(&existing["webViewLink"]), file_id: Some(id), deduped: true, ..Default::default() });
    }
    let meta = serde_json::json!({ "name": name, "parents": [folder], "mimeType": "application/pdf" });
    let (content_type, body) = multipart_related(&meta.to_string(), "application/pdf", &bytes);
    let created = google_call(
        client
            .post(DRIVE_UPLOAD_API)
            .query(&[("uploadType", "multipart"), ("supportsAllDrives", "true"), ("fields", "id,webViewLink")])
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body),
        "Drive upload",
    )
    .await?;
    Ok(DriveOutcome { ok: true, web_view_link: non_empty(&created["webViewLink"]), file_id: non_empty(&created["id"]), deduped: false, ..Default::default() })
}

// -- Sheets ------------------------------------------------------------------------------------

/// Normalised sheet header (see `norm_key`) → canonical COA field; None for columns we never write.
/// Extend as the real sheet's headers are discovered. "Column 5" is the unnamed expiry column in the
/// live Master COA Sheet (right after Report Date, issued + 1 year).
fn header_field(norm: &str) -> Option<&'static str> {
    Some(match norm {
        "batch" | "batchid" | "batchnumber" | "lot" | "lotnumber" | "sampleid" => "batch",
        "strain" | "strainname" | "product" | "productname" | "productstrain" | "sample" | "samplename" | "name" => "productName",
        "lab" | "labname" | "laboratory" | "testinglab" => "lab",
        "issued" | "issuedate" | "reportdate" | "dateissued" | "testdate" | "datetested" | "coadate" => "issued",
        "expires" | "expiry" | "expirydate" | "expirationdate" | "expiration" | "column5" => "expires",
        "thca" | "thcapercent" | "totalthca" => "thca",
        "cbd" | "cbda" | "cbdpercent" => "cbd",
        "cbg" | "cbga" | "cbgpercent" => "cbg",
        "totalcannabinoids" | "total" => "totalCannabinoids",
        "shopify" | "shopifyurl" | "shopifylink" | "shopifypdf" | "pdf" | "pdfurl" | "pdflink" | "coaurl" | "coalink" | "fileurl" => "shopifyUrl",
        "drive" | "driveurl" | "drivelink" | "googledrive" | "googledrivelink" | "backup" | "googledrivecoaurl" => "driveUrl",
        "googledrivecoalink" => "driveFileName",
        "posted" | "postedstatus" | "onwebsite" | "website" | "live" | "published" | "postedonretail" => "posted",
        "flowertype" | "straintype" | "type" => "flowerType",
        "category" | "productcategory" => "category",
        "productlink" | "producturl" | "productpage" => "productUrl",
        "imported" | "importedat" | "lastupdated" | "updated" => "importedAt",
        "notes" | "note" | "comments" => "notes",
        _ => return None,
    })
}

/// ISO "YYYY-MM-DD…" → "M/D/YYYY" (the live sheet's date format); anything else untouched.
fn to_sheet_date(v: &str) -> String {
    match v.get(..10).filter(|p| is_ymd(p)) {
        Some(p) => format!("{}/{}/{}", p[5..7].parse::<u32>().unwrap_or(0), p[8..10].parse::<u32>().unwrap_or(0), &p[..4]),
        None => v.to_string(),
    }
}

/// 0 → A, 25 → Z, 26 → AA.
fn col_letter(i: usize) -> String {
    let (mut n, mut out) = (i + 1, String::new());
    while n > 0 {
        out.insert(0, (b'A' + ((n - 1) % 26) as u8) as char);
        n = (n - 1) / 26;
    }
    out
}

/// A cell as JS `String(v ?? '')` would show it: numbers/bools stringified, null → "".
fn cell_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Row number from an append reply's updatedRange (`'Tab'!A335:I335` → 335).
fn appended_row_number(updated_range: &str) -> Option<u32> {
    let cell = updated_range.rsplit('!').next()?;
    cell.trim_start_matches(|c: char| c.is_ascii_uppercase()).chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
}

/// `…/values/<'Tab'!A1:Z9>` with the range percent-encoded as a path segment (`'` in a title doubles).
fn sheet_values_url(sheet_id: &str, tab: &str, a1: &str) -> String {
    format!("{SHEETS_API}/{sheet_id}/values/{}", url_encode(&format!("'{}'!{a1}", tab.replace('\'', "''"))))
}

struct SheetTab {
    title: String,
    gid: Option<i64>,
}

/// Every tab of a spreadsheets.get reply.
fn sheet_tabs(meta: &serde_json::Value) -> Vec<SheetTab> {
    meta["sheets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| Some(SheetTab { title: s["properties"]["title"].as_str()?.to_string(), gid: s["properties"]["sheetId"].as_i64() }))
        .collect()
}

/// Canonical field → value for the sheet writer; blanks are dropped so they never overwrite a cell.
fn sheet_fields(row: &SheetRow, drive_url: Option<&str>, drive_file_name: &str) -> HashMap<&'static str, String> {
    let imported_at = row.imported_at.clone().or_else(|| Some(utc_now_iso()));
    [
        ("batch", &row.batch),
        ("productName", &row.product_name),
        ("flowerType", &row.flower_type),
        ("category", &row.category),
        ("lab", &row.lab),
        ("issued", &row.issued),
        ("expires", &row.expires),
        ("thca", &row.thca),
        ("cbd", &row.cbd),
        ("cbg", &row.cbg),
        ("totalCannabinoids", &row.total_cannabinoids),
        ("shopifyUrl", &row.shopify_url),
        ("driveUrl", &drive_url.map(String::from)),
        ("driveFileName", &Some(drive_file_name.to_string())),
        ("posted", &row.posted),
        ("importedAt", &imported_at),
        ("notes", &row.notes),
    ]
    .into_iter()
    .filter_map(|(k, v)| opt_text(v).map(|v| (k, v)))
    .collect()
}

struct SheetMerge {
    /// 0-based index into the grid of the row to update; None → append.
    target: Option<usize>,
    out: Vec<serde_json::Value>,
    matched_fields: Vec<String>,
    /// Column holding the Drive chip (a `driveFileName` header), if any.
    chip_col: Option<usize>,
}

/// upsertCoaRow's row builder: maps `fields` onto the header row, keys on the batch column (else the
/// product-name column, case-insensitive) and keeps unmapped or blank cells of the matched row.
fn merge_sheet_row(grid: &[Vec<serde_json::Value>], fields: &HashMap<&str, String>) -> SheetMerge {
    let headers = grid.first().map(Vec::as_slice).unwrap_or_default();
    let field_by_col: Vec<Option<&'static str>> = headers.iter().map(|h| header_field(&norm_key(&cell_text(h)))).collect();
    let col_of = |f: &str| field_by_col.iter().position(|c| *c == Some(f));
    let (key_col, key_value) = match col_of("batch") {
        Some(c) => (Some(c), fields.get("batch")),
        None => (col_of("productName"), fields.get("productName")),
    };
    let want = key_value.map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty());
    let target = match (key_col, want) {
        (Some(c), Some(want)) => grid
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, r)| r.get(c).map(cell_text).unwrap_or_default().trim().to_lowercase() == want)
            .map(|(i, _)| i),
        _ => None,
    };
    let existing: &[serde_json::Value] = target.and_then(|i| grid.get(i)).map(Vec::as_slice).unwrap_or_default();
    let out = field_by_col
        .iter()
        .enumerate()
        .map(|(c, field)| match field.and_then(|f| fields.get(f).filter(|v| !v.is_empty()).map(|v| (f, v))) {
            Some((f, v)) => serde_json::Value::String(if SHEET_DATE_FIELDS.contains(&f) { to_sheet_date(v) } else { v.clone() }),
            None => existing.get(c).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| serde_json::Value::String(String::new())),
        })
        .collect();
    SheetMerge { target, out, matched_fields: field_by_col.iter().flatten().map(|f| f.to_string()).collect(), chip_col: col_of("driveFileName") }
}

/// Drive smart chip in one cell (updateCells + a rich-link chipRun); if the API rejects chip writes,
/// a =HYPERLINK formula so the cell is at least a named link.
async fn write_drive_chip(client: &reqwest::Client, sheet_id: &str, tab: &SheetTab, row: u32, col: usize, uri: &str, label: &str) -> Result<String, String> {
    let gid = tab.gid.ok_or_else(|| format!("tab {:?} not found", tab.title))?;
    let body = serde_json::json!({ "requests": [{ "updateCells": {
        "range": { "sheetId": gid, "startRowIndex": row.saturating_sub(1), "endRowIndex": row, "startColumnIndex": col, "endColumnIndex": col + 1 },
        "rows": [{ "values": [{
            "userEnteredValue": { "stringValue": "@" },
            "chipRuns": [{ "startIndex": 0, "chip": { "richLinkProperties": { "uri": uri } } }],
        }] }],
        "fields": "userEnteredValue,chipRuns",
    } }] });
    let Err(e) = google_call(client.post(format!("{SHEETS_API}/{sheet_id}:batchUpdate")).json(&body), "chip write").await else {
        return Ok("chip".to_string());
    };
    let formula = format!("=HYPERLINK(\"{uri}\", \"{}\")", label.replace('"', "\"\""));
    google_call(
        client
            .put(sheet_values_url(sheet_id, &tab.title, &format!("{}{row}", col_letter(col))))
            .query(&[("valueInputOption", "USER_ENTERED")])
            .json(&serde_json::json!({ "values": [[formula]] })),
        "hyperlink write",
    )
    .await?;
    Ok(format!("hyperlink-fallback ({e})"))
}

/// upsertCoaRow: header-driven update-or-append of one COA row on the tab, then the Drive chip.
async fn sheet_upsert(client: &reqwest::Client, sheet_id: &str, tab_pref: Option<&str>, fields: &HashMap<&str, String>) -> Result<SheetOutcome, String> {
    let meta = google_call(client.get(format!("{SHEETS_API}/{sheet_id}")).query(&[("fields", SHEET_META_FIELDS)]), "Sheet lookup").await?;
    let tabs = sheet_tabs(&meta);
    let title = match tab_pref {
        Some(t) => t.to_string(),
        None => tabs.first().map_or_else(|| "Sheet1".to_string(), |t| t.title.clone()),
    };
    let tab = SheetTab { gid: tabs.iter().find(|t| t.title == title).and_then(|t| t.gid), title };

    let grid = google_call(
        client.get(sheet_values_url(sheet_id, &tab.title, SHEET_GRID_RANGE)).query(&[("valueRenderOption", "UNFORMATTED_VALUE")]),
        "Sheet read",
    )
    .await?;
    let mut values: Vec<Vec<serde_json::Value>> = serde_json::from_value(grid["values"].clone()).unwrap_or_default();
    if !values.first().is_some_and(|h| h.iter().any(|c| !cell_text(c).trim().is_empty())) {
        let header: Vec<serde_json::Value> = DEFAULT_COLUMNS.iter().map(|c| serde_json::json!(c)).collect();
        google_call(
            client
                .put(sheet_values_url(sheet_id, &tab.title, "A1"))
                .query(&[("valueInputOption", "USER_ENTERED")])
                .json(&serde_json::json!({ "values": [&header] })),
            "Sheet header write",
        )
        .await?;
        values = vec![header];
    }
    let width = values[0].len();
    let merge = merge_sheet_row(&values, fields);
    let (action, row_number) = match merge.target {
        Some(i) => {
            let n = i + 1;
            google_call(
                client
                    .put(sheet_values_url(sheet_id, &tab.title, &format!("A{n}:{}{n}", col_letter(width - 1))))
                    .query(&[("valueInputOption", "USER_ENTERED")])
                    .json(&serde_json::json!({ "values": [&merge.out] })),
                "Sheet update",
            )
            .await?;
            ("updated", Some(n as u32))
        }
        None => {
            let r = google_call(
                client
                    .post(format!("{}:append", sheet_values_url(sheet_id, &tab.title, "A1")))
                    .query(&[("valueInputOption", "USER_ENTERED"), ("insertDataOption", "INSERT_ROWS")])
                    .json(&serde_json::json!({ "values": [&merge.out] })),
                "Sheet append",
            )
            .await?;
            ("appended", r["updates"]["updatedRange"].as_str().and_then(appended_row_number))
        }
    };
    // The driveFileName column holds Drive file chips: swap the plain filename just written for a chip.
    let chip = match (merge.chip_col, fields.get("driveUrl"), row_number) {
        (Some(col), Some(uri), Some(row)) => {
            let label = fields.get("driveFileName").or_else(|| fields.get("productName")).map_or(uri.as_str(), String::as_str);
            write_drive_chip(client, sheet_id, &tab, row, col, uri, label).await.unwrap_or_else(|e| format!("failed ({e})"))
        }
        _ => "skipped".to_string(),
    };
    Ok(SheetOutcome {
        ok: true,
        action: Some(action.to_string()),
        row_number,
        tab: Some(tab.title),
        matched_fields: merge.matched_fields,
        chip: Some(chip),
        ..Default::default()
    })
}

// -- commands ----------------------------------------------------------------------------------

// Is the Sheet / Drive folder reachable as the service account? Unconfigured → no network at all;
// every failure lands in `error` so Settings can show it inline.
#[tauri::command]
async fn google_status(cfg: GoogleConfig) -> Result<GoogleStatus, String> {
    let mut st = GoogleStatus { configured: cfg.configured(), ..Default::default() };
    if !st.configured {
        return Ok(st);
    }
    let outcome = async {
        let (token, email) = google_access_token(&cfg.key_file).await?;
        st.service_account_email = Some(email);
        let client = google_client(&token)?;
        if let Some(id) = cfg.sheet_id() {
            let meta = google_call(client.get(format!("{SHEETS_API}/{id}")).query(&[("fields", SHEET_META_FIELDS)]), "Sheet lookup").await?;
            st.sheet_reachable = true;
            st.sheet_title = non_empty(&meta["properties"]["title"]);
            st.tabs = sheet_tabs(&meta).into_iter().map(|t| t.title).collect();
        }
        if let Some(id) = cfg.folder_id() {
            let folder = google_call(
                client.get(format!("{DRIVE_API}/{id}")).query(&[("fields", "id,name"), ("supportsAllDrives", "true")]),
                "Drive folder lookup",
            )
            .await?;
            st.drive_reachable = true;
            st.drive_folder_name = non_empty(&folder["name"]);
        }
        Ok::<(), String>(())
    }
    .await;
    st.error = outcome.err();
    Ok(st)
}

// Mirrors one imported COA: the PDF into the Drive folder and a row into the Sheet. Both legs run
// even when one fails and each reports separately; only a config/token problem is an Err.
#[tauri::command]
async fn google_mirror_coa(cfg: GoogleConfig, req: MirrorRequest) -> Result<MirrorResult, String> {
    if !cfg.configured() {
        return Err("Google integration not configured (key file plus a Sheet id or Drive folder id)".to_string());
    }
    let (token, _) = google_access_token(&cfg.key_file).await?;
    let client = google_client(&token)?;
    let pdf_name = req.pdf_name.trim().to_string();

    let drive = match (cfg.folder_id(), opt_text(&req.file_url)) {
        (None, _) => DriveOutcome { skipped: Some("no Drive folder configured".to_string()), ..Default::default() },
        (_, None) => DriveOutcome { skipped: Some("no fileUrl yet (file may still be propagating)".to_string()), ..Default::default() },
        (Some(_), Some(_)) if pdf_name.is_empty() => DriveOutcome { error: Some("pdfName is required".to_string()), ..Default::default() },
        (Some(folder), Some(url)) => {
            let run = async { drive_upload(&client, &folder, &pdf_name, download_pdf(&url).await?).await };
            run.await.unwrap_or_else(|e| DriveOutcome { error: Some(e), ..Default::default() })
        }
    };
    let sheet = match cfg.sheet_id() {
        None => SheetOutcome { skipped: Some("no Sheet configured".to_string()), ..Default::default() },
        Some(id) => {
            let fields = sheet_fields(&req.row, drive.web_view_link.as_deref(), &pdf_name);
            sheet_upsert(&client, &id, opt_text(&cfg.sheet_tab).as_deref(), &fields)
                .await
                .unwrap_or_else(|e| SheetOutcome { error: Some(e), ..Default::default() })
        }
    };
    Ok(MirrorResult { drive, sheet })
}

/// The four GOOGLE_* lines of an old-dashboard .env (quotes stripped); None without a key-file line.
fn parse_google_env(text: &str) -> Option<GoogleConfig> {
    let mut cfg = GoogleConfig::default();
    for line in text.lines() {
        let Some((k, v)) = line.trim().split_once('=') else { continue };
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "GOOGLE_SERVICE_ACCOUNT_KEY_FILE" => cfg.key_file = v,
            "GOOGLE_SHEET_ID" => cfg.sheet_id = Some(v),
            "GOOGLE_SHEET_TAB" => cfg.sheet_tab = Some(v),
            "GOOGLE_DRIVE_FOLDER_ID" => cfg.folder_id = Some(v),
            _ => {}
        }
    }
    (!cfg.key_file.is_empty()).then_some(cfg)
}

// ponytail: one-time seed from the old dashboard's .env; delete once the old repo is gone.
// Reads only the four GOOGLE_* keys; nothing else in that file is looked at or returned.
#[tauri::command]
fn seed_google_config_from_old_env() -> Result<Option<GoogleConfig>, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let path = PathBuf::from(home).join("Documents/Dev/Projects/flow gardens dashboard/.env");
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(parse_google_env(&text))
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
            order_notes::update_order_note_tags,
            order_fulfill::get_fulfillment,
            order_fulfill::fulfill_order,
            order_refund::get_refund_info,
            order_refund::preview_refund,
            order_refund::create_refund,
            list_inventory,
            inventory_adjust::adjust_inventory,
            inventory_transfer::transfer_inventory,
            list_products,
            variant_split::prepare_variant_split,
            variant_split::split_product_variant,
            variant_split::release_variant_split,
            list_customers,
            list_product_presence,
            list_orders_since,
            list_coas,
            save_coa_link,
            save_coa_fields,
            search_products,
            export_coas_csv,
            get_openrouter_status,
            save_openrouter_key,
            parse_coas,
            upload_coa_pdf,
            import_coa,
            repost_coas,
            google_status,
            google_mirror_coa,
            seed_google_config_from_old_env
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
                "product": {"id": "gid://shopify/Product/10", "title": "Rose", "status": "ACTIVE"},
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
                "product": {"id": "gid://shopify/Product/20", "title": "Tulip", "status": "DRAFT"}
            }}
        ]}}});

        let v = parse_variants(&page);
        assert_eq!(v.len(), 2);

        assert_eq!(v[0].product_id, "gid://shopify/Product/10");
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

        assert_eq!(v[1].product_id, "gid://shopify/Product/20");
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

    #[test]
    fn parse_customers_maps_fixture() {
        let page = serde_json::json!({"data": {
            "customers": {
                "pageInfo": {"hasNextPage": true},
                "edges": [
                    {"node": {
                        "id": "gid://shopify/Customer/1", "displayName": "Marisol Ortega",
                        "createdAt": "2025-03-01T00:00:00Z", "updatedAt": "2026-09-12T09:41:00Z",
                        "tags": ["vip", "wholesale"], "numberOfOrders": "14",
                        "amountSpent": {"amount": "612.0", "currencyCode": "USD"},
                        "defaultEmailAddress": {"emailAddress": "marisol.o@gmail.com"},
                        "defaultPhoneNumber": {"phoneNumber": "+19195550123"},
                        "defaultAddress": {"company": "Ortega Botanicals", "city": "Asheville", "provinceCode": "NC", "countryCodeV2": "US"},
                        "lastOrder": {"id": "gid://shopify/Order/1", "name": "#R-10482", "createdAt": "2026-09-12T09:41:00Z"}
                    }},
                    {"node": {
                        "id": "gid://shopify/Customer/2", "displayName": "Sam Lee",
                        "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
                        "tags": [], "numberOfOrders": "0",
                        "amountSpent": {"amount": "0.0", "currencyCode": "USD"},
                        "defaultEmailAddress": null, "defaultPhoneNumber": null, "defaultAddress": null, "lastOrder": null
                    }}
                ]
            },
            "customersCount": {"count": 4213, "precision": "EXACT"}
        }});

        let r = parse_customers(&page).expect("customers parse");
        assert_eq!(r.customers.len(), 2);
        assert!(r.has_next_page);
        assert_eq!(r.total_count, Some(4213));
        assert_eq!(r.total_precision.as_deref(), Some("EXACT"));

        let c = &r.customers[0];
        assert_eq!(c.id, "gid://shopify/Customer/1");
        assert_eq!(c.display_name, "Marisol Ortega");
        assert_eq!(c.email.as_deref(), Some("marisol.o@gmail.com"));
        assert_eq!(c.phone.as_deref(), Some("+19195550123"));
        assert_eq!(c.company.as_deref(), Some("Ortega Botanicals"));
        assert_eq!(c.location.as_deref(), Some("Asheville, NC"));
        assert_eq!(c.orders_count, 14);
        assert_eq!(c.amount_spent, "612.0 USD");
        assert_eq!(c.last_order_name.as_deref(), Some("#R-10482"));
        assert_eq!(c.last_order_at.as_deref(), Some("2026-09-12T09:41:00Z"));
        assert_eq!(c.created_at, "2025-03-01T00:00:00Z");
        assert_eq!(c.tags, ["vip", "wholesale"]);

        let c = &r.customers[1];
        assert_eq!(c.email, None);
        assert_eq!(c.phone, None);
        assert_eq!(c.company, None);
        assert_eq!(c.location, None);
        assert_eq!(c.orders_count, 0);
        assert_eq!(c.amount_spent, "0.0 USD");
        assert_eq!(c.last_order_name, None);
        assert_eq!(c.last_order_at, None);
        assert!(c.tags.is_empty());

        assert!(parse_customers(&serde_json::json!({"data": {"customers": null}})).is_err());
    }

    #[test]
    fn parse_presence_maps_fixture() {
        let page = serde_json::json!({"data": {"products": {"edges": [
            {"node": {"id": "gid://shopify/Product/1", "handle": "lifter", "title": "Lifter", "status": "ACTIVE"}},
            {"node": {"id": "gid://shopify/Product/2", "handle": "", "title": "Bubba Kush biomass", "status": "DRAFT"}}
        ]}}});

        let p = parse_presence(&page);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].id, "gid://shopify/Product/1");
        assert_eq!(p[0].handle, "lifter");
        assert_eq!(p[0].status, "ACTIVE");
        assert_eq!(p[1].handle, "");
        assert_eq!(p[1].title, "Bubba Kush biomass");
        assert_eq!(p[1].status, "DRAFT");

        assert!(parse_presence(&serde_json::json!({"data": {"products": null}})).is_empty());
    }

    #[test]
    fn parse_order_stubs_drops_test_orders() {
        let page = serde_json::json!({"data": {"orders": {"pageInfo": {"hasNextPage": false}, "edges": [
            {"node": {"id": "gid://shopify/Order/1", "createdAt": "2026-09-12T09:41:00Z", "cancelledAt": null, "test": false,
                      "currentTotalPriceSet": {"shopMoney": {"amount": "128.0", "currencyCode": "USD"}}}},
            {"node": {"id": "gid://shopify/Order/2", "createdAt": "2026-09-11T06:00:00Z", "cancelledAt": "2026-09-11T07:00:00Z", "test": false,
                      "currentTotalPriceSet": {"shopMoney": {"amount": "0.0", "currencyCode": "USD"}}}},
            {"node": {"id": "gid://shopify/Order/3", "createdAt": "2026-09-10T00:00:00Z", "cancelledAt": null, "test": true,
                      "currentTotalPriceSet": {"shopMoney": {"amount": "999.0", "currencyCode": "USD"}}}}
        ]}}});

        let o = parse_order_stubs(&page);
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].created_at, "2026-09-12T09:41:00Z");
        assert_eq!(o[0].total, "128.0 USD");
        assert!(!o[0].cancelled);
        assert_eq!(o[1].total, "0.0 USD");
        assert!(o[1].cancelled);
    }

    #[test]
    fn is_ymd_accepts_only_dashed_dates() {
        assert!(is_ymd("2026-09-12"));
        assert!(!is_ymd("2026-9-12"));
        assert!(!is_ymd("2026-09-12T"));
        assert!(!is_ymd("2026/09/12"));
        assert!(!is_ymd("abcd-ef-gh"));
        assert!(!is_ymd("2026-09-1\u{e9}"));
    }

    // ---- COAs ----

    fn coa_products_fixture() -> Vec<CoaProduct> {
        let mk = |id: &str, title: &str, handle: &str, status: &str, published: bool| CoaProduct {
            id: id.into(),
            title: title.into(),
            handle: handle.into(),
            status: status.into(),
            published,
            ..Default::default()
        };
        vec![
            mk("gid://shopify/Product/1", "Blueberry Lobster", "blueberry-lobster", "ACTIVE", true),
            mk("gid://shopify/Product/2", "Cakeberry Brûlée", "cakeberry-brulee", "ACTIVE", false),
            mk("gid://shopify/Product/3", "Lifter", "lifter-cbd", "DRAFT", false),
            mk("gid://shopify/Product/4", "Yuzu", "yuzu", "ACTIVE", true),
        ]
    }

    #[test]
    fn filename_key_strips_pdf_uuid_and_normalises() {
        let url = "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/Red_Hotz_ab1f742c-7837-45ca-90dd-16e39bf5a8e4.pdf?v=1787958269";
        assert_eq!(filename_key(url), ("Red Hotz".to_string(), "redhotz".to_string()));
        assert_eq!(file_key_from_url(url), "Red_Hotz_ab1f742c-7837-45ca-90dd-16e39bf5a8e4.pdf");
        assert_eq!(
            filename_key("//cdn.shopify.com/x/Monkey%20Berries.PDF"),
            ("Monkey Berries".to_string(), "monkeyberries".to_string())
        );
        // Dashes in the wrong places → not a UUID suffix, kept.
        assert_eq!(filename_key("/f/Yuzu_ab1f742c7837-45ca-90dd-16e39bf5a8e4x.pdf").1, "yuzuab1f742c783745ca90dd16e39bf5a8e4x");
        assert_eq!(norm_key("Cakeberry Brûlée"), "cakeberrybrle");
        assert_eq!(title_case("blue dream 2"), "Blue Dream 2");
    }

    #[test]
    fn match_product_tiers() {
        let products = coa_products_fixture();
        let index = product_index(&products);
        let hit = |key: &str| {
            let (p, via) = match_product(key, &index);
            (p.map(|p| p.title.as_str()), via)
        };
        assert_eq!(hit("blueberrylobster"), (Some("Blueberry Lobster"), Some("exact-title".into())));
        assert_eq!(hit("liftercbd"), (Some("Lifter"), Some("exact-handle".into())));
        assert_eq!(hit("blueberrylobster2026"), (Some("Blueberry Lobster"), Some("product-is-prefix".into())));
        assert_eq!(hit("cakeberry"), (Some("Cakeberry Brûlée"), Some("filename-is-prefix".into())));
        // Keys under 6 chars never prefix-match, so the noise suffix has to come off first.
        assert_eq!(hit("yuzuvape"), (Some("Yuzu"), Some("strip-exact-title".into())));
        assert_eq!(hit("yuzucoa"), (Some("Yuzu"), Some("strip-exact-title".into())));
        assert_eq!(hit("blueberrylobsterliveresin").0, Some("Blueberry Lobster"));
        assert_eq!(hit("yuzu2"), (None, None));
        assert_eq!(hit("zzzzzzzz"), (None, None));
    }

    #[test]
    fn derive_posted_status_table() {
        let keys: HashSet<String> = ["Red_Hotz.pdf".to_string()].into();
        let on_page = "https://cdn.shopify.com/s/files/1/x/files/Red_Hotz.pdf?v=1";
        let other = "https://cdn.shopify.com/s/files/1/x/files/Other.pdf";
        let p = |status: &str, published: bool| CoaProduct { status: status.into(), published, ..Default::default() };
        let d = |product: Option<&CoaProduct>, rec: bool, url: &str| {
            let (s, _, src) = derive_posted_status(product, rec, &keys, url);
            (s, src)
        };
        assert_eq!(d(None, false, on_page), ("posted", Some("page")));
        assert_eq!(d(None, true, other), ("posted", Some("metaobject")));
        assert_eq!(d(None, false, other), ("unposted", None));
        assert_eq!(d(Some(&p("ACTIVE", true)), false, other), ("posted", Some("product")));
        assert_eq!(d(Some(&p("active", false)), true, other), ("posted", Some("metaobject")));
        assert_eq!(d(Some(&p("ACTIVE", false)), false, other), ("unposted", None));
        assert_eq!(d(Some(&p("DRAFT", true)), true, other), ("unposted", None));
        assert_eq!(d(Some(&p("ARCHIVED", true)), true, other), ("unposted", None));
        assert_eq!(d(Some(&p("", false)), true, other), ("posted", Some("metaobject")));
        assert_eq!(derive_posted_status(Some(&p("", false)), false, &keys, other).1, "Linked product status unknown");
    }

    #[test]
    fn derive_state_boundaries_and_civil_days() {
        assert_eq!(derive_state(-1), "expired");
        assert_eq!(derive_state(0), "expiring");
        assert_eq!(derive_state(29), "expiring");
        assert_eq!(derive_state(30), "valid");

        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
        assert_eq!(days_from_civil(2026, 9, 13), 20709);
        assert_eq!(civil_from_days(20709), (2026, 9, 13));
        assert_eq!(ymd_string(20709 + 365), "2027-09-13");
        assert_eq!(ymd("2026-09-13T10:00:00Z"), Some(("2026-09-13", 20709)));
        assert_eq!(ymd("9/13/2026"), None);
        assert_eq!(ymd("2026-13-01"), None);
        for d in [-1_000_000, -1, 0, 59, 11017, 20709, 2_000_000] {
            let (y, m, day) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, day), d);
        }
    }

    #[test]
    fn extract_cdn_urls_and_file_keys() {
        let html = r#"<a href="https://cdn.shopify.com/s/files/1/0931/files/Red%20Hotz.pdf?v=1">Red</a>
<img src='//CDN.shopify.com/s/files/1/0931/files/logo.png'>
<a href="/cdn/shop/t/12/files/Yuzu_ab1f.pdf?v=2">Yuzu</a> /cdn/shop/files/Blue.pdf) /cdn/shop/products/nope.jpg
<script>var x = "http://cdn.shopify.com/s/files/1/files/Old.pdf#frag";</script> https://cdn.example.com/files/x.pdf"#;
        let urls = extract_cdn_urls(html);
        assert_eq!(
            urls,
            [
                "https://cdn.shopify.com/s/files/1/0931/files/Red%20Hotz.pdf?v=1",
                "//CDN.shopify.com/s/files/1/0931/files/logo.png",
                "http://cdn.shopify.com/s/files/1/files/Old.pdf#frag",
                "/cdn/shop/t/12/files/Yuzu_ab1f.pdf?v=2",
                "/cdn/shop/files/Blue.pdf",
            ]
        );
        let keys: HashSet<String> = urls.iter().map(|u| file_key_from_url(u)).collect();
        assert!(keys.contains("Red Hotz.pdf"));
        assert!(keys.contains("logo.png"));
        assert!(keys.contains("Old.pdf"));
        assert!(keys.contains("Yuzu_ab1f.pdf"));
        assert!(keys.contains("Blue.pdf"));
        assert_eq!(file_key_from_url("https://cdn.shopify.com/files/"), "");
        assert_eq!(percent_decode("a%2Fb%zz+c"), "a/b%zz+c");
    }

    #[test]
    fn parse_coa_records_products_and_files_fixtures() {
        let records = serde_json::json!([{
            "id": "gid://shopify/Metaobject/1", "handle": "monkey-berries-2023-11-22",
            "capabilities": {"publishable": {"status": "DRAFT"}},
            "fields": [
                {"key": "batch_id", "value": "11-16-2023-41765", "reference": null},
                {"key": "report_date", "value": "2023-11-22", "reference": null},
                {"key": "lab_name", "value": "New Bloom Labs", "reference": null},
                {"key": "pdf_file", "value": "gid://shopify/GenericFile/9",
                 "reference": {"id": "gid://shopify/GenericFile/9", "url": "https://cdn.shopify.com/f/Monkey_Berries.pdf"}},
                {"key": "thca_percent", "value": "26.421", "reference": null},
                {"key": "cbd_percent", "value": null, "reference": null},
                {"key": "expiry_date", "value": "2024-11-21", "reference": null},
                {"key": "display_title", "value": "Monkey Berries · 2023-11-22", "reference": null}
            ]
        }]);
        let r = parse_coa_records(records.as_array().unwrap());
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "gid://shopify/Metaobject/1");
        assert_eq!(r[0].status.as_deref(), Some("DRAFT"));
        assert_eq!(r[0].file_id.as_deref(), Some("gid://shopify/GenericFile/9"));
        assert_eq!(r[0].fields.get("thca_percent").map(String::as_str), Some("26.421"));
        assert_eq!(r[0].fields.get("expiry_date").map(String::as_str), Some("2024-11-21"));
        assert!(!r[0].fields.contains_key("cbd_percent"));

        let products = serde_json::json!([{
            "id": "gid://shopify/Product/1", "title": "Monkey Berries", "handle": "monkey-berries", "status": "DRAFT",
            "publishedAt": null, "onlineStoreUrl": null,
            "thca": {"value": "26.42"}, "cbd": null, "cbg": null,
            "strainType": {"value": "Indica"}, "flowerType": {"value": "Type 1 - High THCa"},
            "terpenes": {"references": {"nodes": [
                {"id": "gid://shopify/Metaobject/11", "nameField": {"value": "Limonene"}},
                {"id": "gid://shopify/Metaobject/12", "nameField": null}
            ]}}
        }, {
            "id": "gid://shopify/Product/2", "title": "Lifter", "handle": "lifter", "status": "ACTIVE",
            "publishedAt": "2026-01-01T00:00:00Z", "onlineStoreUrl": "https://flowgardens.com/products/lifter",
            "thca": null, "cbd": {"value": "18.1"}, "cbg": null, "strainType": null, "flowerType": null, "terpenes": null
        }]);
        let p = parse_coa_products(products.as_array().unwrap());
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].thca.as_deref(), Some("26.42"));
        assert!(!p[0].published);
        assert_eq!(p[0].strain_type.as_deref(), Some("Indica"));
        assert_eq!(p[0].flower_type.as_deref(), Some("Type 1 - High THCa"));
        assert_eq!(p[0].terpenes, ["Limonene", "gid://shopify/Metaobject/12"]);
        assert!(p[1].published);
        assert_eq!(p[1].online_store_url.as_deref(), Some("https://flowgardens.com/products/lifter"));
        assert_eq!(p[1].cbd.as_deref(), Some("18.1"));
        assert!(p[1].terpenes.is_empty());

        let files = serde_json::json!([
            {"id": "gid://shopify/GenericFile/9", "url": "https://cdn.shopify.com/f/Monkey_Berries.pdf?v=1",
             "createdAt": "2026-08-28T23:04:27Z", "mimeType": "application/pdf"},
            {"id": "gid://shopify/GenericFile/10", "url": "https://cdn.shopify.com/f/sheet.csv",
             "createdAt": "2026-08-28T23:04:27Z", "mimeType": "text/csv"}
        ]);
        let f = parse_coa_files(files.as_array().unwrap());
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].id, "gid://shopify/GenericFile/9");
        assert_eq!(f[0].created_at, "2026-08-28T23:04:27Z");
    }

    #[test]
    fn build_coas_precedence_and_overrides() {
        let today = days_from_civil(2026, 9, 13);
        let file = |id: &str, url: &str, created: &str| CoaFile { id: id.into(), url: url.into(), created_at: created.into() };
        let files = vec![
            file("gid://shopify/GenericFile/9", "https://cdn.shopify.com/f/Monkey_Berries.pdf?v=1", "2026-08-28T23:04:27Z"),
            file("gid://shopify/GenericFile/10", "https://cdn.shopify.com/f/Yuzu_Vape.pdf", "2026-09-01T00:00:00Z"),
            file("gid://shopify/GenericFile/11", "https://cdn.shopify.com/f/Unknown_Strain.pdf", "2025-01-01T00:00:00Z"),
        ];
        let mut products = coa_products_fixture();
        products[0].thca = Some("22.5".into());
        products[0].strain_type = Some("Hybrid".into());
        products[0].terpenes = vec!["Limonene".into()];
        let records = vec![CoaRecord {
            id: "gid://shopify/Metaobject/1".into(),
            status: Some("ACTIVE".into()),
            file_id: Some("gid://shopify/GenericFile/9".into()),
            fields: HashMap::from([
                ("report_date".to_string(), "2026-03-01".to_string()),
                ("lab_name".to_string(), "New Bloom Labs".to_string()),
                ("cbg_percent".to_string(), "0.117".to_string()),
                ("notes".to_string(), "rec note".to_string()),
                ("display_title".to_string(), "Monkey · 2026".to_string()),
            ]),
        }];
        let cache = serde_json::json!({
            "gid://shopify/GenericFile/9": {"parsedAt": "x", "model": "m", "fields": {
                "issue_date": "2026-03-25", "lab": "FESA Lab", "batch_id": null,
                "thca_percent": 31.5, "cbda_percent": null, "cbg_percent": null, "total_cannabinoids_percent": "32.58",
                "terpenes": [{"name": "E-Caryophyllene", "percent": 1.1}], "qr_present": false
            }},
            "__manualLinks": {"gid://shopify/GenericFile/9": {
                "productId": "gid://shopify/Product/1", "productTitle": "Blueberry Lobster", "linkedAt": "x"
            }},
            "__fieldOverrides": {"gid://shopify/GenericFile/10": {
                "issued": "2026-09-01", "thca": "0.9", "terpenes": [{"name": "Myrcene", "pct": 0.5}], "updatedAt": "x"
            }}
        });
        let posted: HashSet<String> = ["Yuzu_Vape.pdf".to_string()].into();

        let coas = build_coas(&files, &records, &products, &cache, &posted, today);
        assert_eq!(coas.len(), 3);

        // Sorted by daysToExpire ascending: the 2025 upload (createdAt + 365d) is already expired.
        let u = &coas[0];
        assert_eq!(u.file_id, "gid://shopify/GenericFile/11");
        assert_eq!((u.issued.as_str(), u.expires.as_str(), u.state.as_str()), ("2025-01-01", "2026-01-01", "expired"));
        assert_eq!(u.product_name, "Unknown Strain");
        assert_eq!((u.product_id.as_deref(), u.match_via.as_deref()), (None, None));
        assert_eq!((u.posted_status.as_str(), u.posted_source.as_deref()), ("unposted", None));
        assert!(u.terpenes.is_empty() && !u.parsed && !u.edited);

        let m = coas.iter().find(|c| c.file_id == "gid://shopify/GenericFile/9").unwrap();
        assert_eq!(m.id, "gid://shopify/Metaobject/1");
        assert_eq!(m.coa_record_status.as_deref(), Some("ACTIVE"));
        assert_eq!(m.match_via.as_deref(), Some("manual"));
        assert_eq!(m.product_id.as_deref(), Some("gid://shopify/Product/1"));
        assert_eq!(m.product_name, "Blueberry Lobster");
        assert_eq!(m.product_handle.as_deref(), Some("blueberry-lobster"));
        assert!(m.parsed && !m.edited && m.product_published);
        // Fixture entry predates `producer` → stale; parsedAt/model surface from the entry.
        assert_eq!((m.parsed_at.as_deref(), m.parsed_model.as_deref(), m.parse_stale), (Some("x"), Some("m"), true));
        assert!(!u.parse_stale && u.parsed_at.is_none() && u.parsed_model.is_none());
        assert_eq!(m.qr_present, Some(false));
        assert_eq!(m.issued, "2026-03-25"); // parsed beats coa_record.report_date
        assert_eq!(m.expires, "2027-03-25");
        assert_eq!(m.days_to_expire, days_from_civil(2027, 3, 25) - today);
        assert_eq!(m.state, "valid");
        assert_eq!(m.lab.as_deref(), Some("FESA Lab")); // parsed beats coa_record.lab_name
        assert_eq!(m.thca, Some(31.5)); // parsed beats product 22.5
        assert_eq!(m.cbg, Some(0.117)); // parsed null → coa_record
        assert_eq!(m.total_cannabinoids, Some(32.58)); // numeric string
        assert_eq!(m.cbd, None);
        assert_eq!((m.terpenes[0].name.as_str(), m.terpenes[0].pct), ("E-Caryophyllene", Some(1.1)));
        assert_eq!(m.notes.as_deref(), Some("rec note"));
        assert_eq!(m.display_title.as_deref(), Some("Monkey · 2026"));
        assert_eq!((m.strain.as_deref(), m.r#type.as_deref()), (Some("Hybrid"), Some("Hybrid")));
        assert_eq!((m.posted_status.as_str(), m.posted_source.as_deref()), ("posted", Some("product")));
        assert!(!m.on_coa_page);

        let y = coas.iter().find(|c| c.file_id == "gid://shopify/GenericFile/10").unwrap();
        assert_eq!(y.match_via.as_deref(), Some("strip-exact-title"));
        assert_eq!(y.product_name, "Yuzu");
        assert!(y.edited && !y.parsed);
        assert_eq!(y.issued, "2026-09-01"); // override beats createdAt
        assert_eq!(y.expires, "2027-09-01"); // recomputed from the overridden issued
        assert_eq!(y.state, "valid");
        assert_eq!(y.thca, Some(0.9));
        assert_eq!(y.terpenes[0].name, "Myrcene");
        assert!(y.on_coa_page);
        assert_eq!((y.posted_status.as_str(), y.posted_source.as_deref()), ("posted", Some("page")));

        // An expires override recomputes state/daysToExpire on its own.
        let cache2 = serde_json::json!({"__fieldOverrides": {"gid://shopify/GenericFile/10": {"expires": "2026-09-20"}}});
        let coas = build_coas(&files[1..2], &[], &products, &cache2, &posted, today);
        assert_eq!((coas[0].expires.as_str(), coas[0].days_to_expire, coas[0].state.as_str()), ("2026-09-20", 7, "expiring"));

        // coa_record.expiry_date beats issued + 365.
        let rec_exp = vec![CoaRecord {
            id: "gid://shopify/Metaobject/2".into(),
            status: None,
            file_id: Some("gid://shopify/GenericFile/10".into()),
            fields: HashMap::from([("expiry_date".to_string(), "2026-08-01".to_string())]),
        }];
        let coas = build_coas(&files[1..2], &rec_exp, &products, &serde_json::json!({}), &posted, today);
        assert_eq!((coas[0].expires.as_str(), coas[0].state.as_str()), ("2026-08-01", "expired"));

        // A `producer` key (even null) makes the entry current.
        let mut cache3 = cache.clone();
        cache3["gid://shopify/GenericFile/9"]["fields"]["producer"] = serde_json::Value::Null;
        let coas = build_coas(&files[..1], &[], &products, &cache3, &posted, today);
        assert!(coas[0].parsed && !coas[0].parse_stale);
        assert_eq!(coas[0].producer, None);
    }

    #[test]
    fn base64_encode_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0x00, 0xff, 0x10]), "AP8Q");
        assert_eq!(base64_encode(b"%PDF-1.4\n"), "JVBERi0xLjQK");
    }

    #[test]
    fn extract_json_object_strips_fences_and_rejects_non_objects() {
        let want = serde_json::json!({"lab": "FESA", "thca_percent": 31.5});
        assert_eq!(extract_json_object("```json\n{\"lab\": \"FESA\", \"thca_percent\": 31.5}\n```").unwrap(), want);
        assert_eq!(extract_json_object("```\n{\"lab\": \"FESA\", \"thca_percent\": 31.5}```  ").unwrap(), want);
        assert_eq!(extract_json_object("  {\"lab\": \"FESA\", \"thca_percent\": 31.5}  ").unwrap(), want);
        assert!(extract_json_object("[1, 2]").unwrap_err().contains("non-object"));
        assert!(extract_json_object("null").is_err());
        assert!(extract_json_object("not json").unwrap_err().contains("invalid JSON"));
    }

    #[test]
    fn is_fully_parsed_requires_producer_key() {
        assert!(is_fully_parsed(&serde_json::json!({"fields": {"producer": null, "lab": "x"}})));
        assert!(is_fully_parsed(&serde_json::json!({"fields": {"producer": "Flow Gardens"}})));
        assert!(!is_fully_parsed(&serde_json::json!({"fields": {"lab": "x"}})));
        assert!(!is_fully_parsed(&serde_json::json!({"parsedAt": "x"})));
        assert!(!is_fully_parsed(&serde_json::Value::Null));
    }

    #[test]
    fn openrouter_body_shape() {
        let body = openrouter_body("anthropic/claude-haiku-4.5", "Monkey Berries.pdf", "data:application/pdf;base64,JVBERg==");
        assert_eq!(body["model"], "anthropic/claude-haiku-4.5");
        assert_eq!(body["response_format"]["type"], "json_object");
        let content = &body["messages"][0]["content"];
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], EXTRACTION_PROMPT);
        assert_eq!(content[1]["type"], "file");
        assert_eq!(content[1]["file"]["filename"], "Monkey Berries.pdf");
        assert_eq!(content[1]["file"]["file_data"], "data:application/pdf;base64,JVBERg==");
        assert!(EXTRACTION_PROMPT.contains("\"producer\": \"brand or company that owns the product\""));
    }

    #[test]
    fn product_search_term_and_csv_name_are_sanitised() {
        assert_eq!(product_search_term("  Blue \"Dream\" (x):*\\ ").as_deref(), Some("title:*Blue Dream x*"));
        assert_eq!(product_search_term("\"\""), None);
        assert_eq!(csv_export_name("../../etc/coas.csv").unwrap(), "coas.csv");
        assert!(csv_export_name("coas.txt").is_err());
        assert!(csv_export_name("").is_err());
    }

    // ---- COA import pipeline ----

    #[test]
    fn base64_decode_round_trips_and_rejects_bad_input() {
        let all: Vec<u8> = (0..=255).collect();
        let cases: [&[u8]; 7] = [b"", b"f", b"fo", b"foo", b"foobar", b"%PDF-1.4\n", &all];
        for bytes in cases {
            assert_eq!(base64_decode(&base64_encode(bytes)).unwrap(), bytes);
        }
        assert_eq!(base64_decode("Zm9v YmFy\n").unwrap(), b"foobar"); // whitespace ignored
        assert_eq!(base64_decode("Zg").unwrap(), b"f"); // padding optional
        assert_eq!(base64_decode("data:application/pdf;base64,JVBERg==").unwrap(), b"%PDF");
        assert!(base64_decode("Z").unwrap_err().contains("length"));
        assert!(base64_decode("Zm!v").unwrap_err().contains("character"));
        assert!(base64_decode("Zg=x").is_err());
    }

    #[test]
    fn slugify_handle_is_the_dedupe_key() {
        assert_eq!(slugify_handle("FLO-2025-04-001"), "flo-2025-04-001");
        assert_eq!(slugify_handle("  Batch #12 / A  "), "batch-12-a");
        assert_eq!(slugify_handle("Alien_Grape.pdf"), "alien-grape-pdf");
        assert!(slugify_handle("").starts_with("coa-"));
        assert!(slugify_handle("---").starts_with("coa-"));
        assert_eq!(slugify_handle(&"x".repeat(100)).len(), 80);
    }

    #[test]
    fn norm_name_collapses_case_and_whitespace() {
        assert_eq!(norm_name("  Monkey \t Berries "), "monkey berries");
        assert_eq!(norm_name("LOBSTER"), "lobster");
        assert_eq!(norm_name(""), "");
    }

    #[test]
    fn map_terpenes_strips_prefixes_and_reports_unknowns() {
        let lib = terpene_library(&[
            serde_json::json!({ "id": "gid://shopify/Metaobject/1", "handle": "caryophyllene", "nameField": { "value": "Caryophyllene" } }),
            serde_json::json!({ "id": "gid://shopify/Metaobject/2", "handle": "myrcene", "nameField": { "value": "Myrcene" } }),
            serde_json::json!({ "id": "gid://shopify/Metaobject/3", "handle": "alpha-pinene", "nameField": { "value": "α-Pinene" } }),
            serde_json::json!({ "handle": "no-id" }),
        ]);
        assert_eq!(lib.len(), 4); // name and handle collide for two entries; the id-less node is skipped
        let t = |name: &str, percent: Option<f64>| CoaTerpeneIn { name: name.into(), percent };
        let input = [
            t("beta-Caryophyllene", Some(0.5)),
            t("β-Myrcene", Some(0.3)),
            t("trans-β-Myrcene", None),
            t("alpha-Pinene", Some(0.1)),
            t("Ocimene", Some(0.2)),
            t("  ", None),
        ];
        let (profile, unknown) = map_terpenes(&input, &lib);
        assert_eq!(profile.len(), 4);
        assert_eq!(profile[0], serde_json::json!({ "terpene_id": "gid://shopify/Metaobject/1", "pct": 0.5 }));
        assert_eq!(profile[1]["terpene_id"], "gid://shopify/Metaobject/2");
        assert_eq!(profile[2], serde_json::json!({ "terpene_id": "gid://shopify/Metaobject/2", "pct": null }));
        assert_eq!(profile[3]["terpene_id"], "gid://shopify/Metaobject/3");
        assert_eq!(unknown, vec!["Ocimene"]);
    }

    #[test]
    fn coa_record_fields_drop_nulls_and_stringify() {
        // The wizard sends camelCase and may omit anything but fileId/post.
        let partial: ImportRequest = serde_json::from_value(serde_json::json!({
            "fileId": "gid://shopify/GenericFile/9", "post": false,
            "fields": { "batchId": "FLO-1", "thcaPercent": 24.5, "terpenes": [{ "name": "Myrcene" }] }
        }))
        .unwrap();
        assert_eq!((partial.fields.batch_id.as_deref(), partial.fields.thca_percent, partial.fields.lab), (Some("FLO-1"), Some(24.5), None));
        assert_eq!((partial.fields.terpenes[0].name.as_str(), partial.fields.terpenes[0].percent, partial.post), ("Myrcene", None, false));
        let none: ImportRequest = serde_json::from_value(serde_json::json!({ "fileId": "x", "post": true })).unwrap();
        assert!(none.fields.terpenes.is_empty() && none.product_id.is_none());

        let req = ImportRequest {
            file_id: "gid://shopify/GenericFile/9".into(),
            file_url: None,
            file_name: None,
            fields: ImportFields {
                lab: Some(" FESA ".into()),
                thca_percent: Some(24.5),
                cbd_percent: Some(1.0),
                notes: Some("  ".into()),
                ..Default::default()
            },
            product_id: None,
            product_title: None,
            page_name: Some("Lobster".into()),
            post: true,
        };
        let profile = vec![serde_json::json!({ "terpene_id": "gid://shopify/Metaobject/1", "pct": 0.5 })];
        let fields = coa_record_fields(&req, "FLO-1", "2025-04-15", "2026-04-15", &profile);
        let get = |k: &str| fields.iter().find(|f| f["key"] == k).map(|f| f["value"].as_str().unwrap().to_string());
        assert_eq!(get("batch_id").as_deref(), Some("FLO-1"));
        assert_eq!(get("report_date").as_deref(), Some("2025-04-15"));
        assert_eq!(get("expiry_date").as_deref(), Some("2026-04-15"));
        assert_eq!(get("lab_name").as_deref(), Some("FESA"));
        assert_eq!(get("pdf_file").as_deref(), Some("gid://shopify/GenericFile/9"));
        assert_eq!(get("thca_percent").as_deref(), Some("24.5"));
        assert_eq!(get("cbd_percent").as_deref(), Some("1"));
        assert_eq!(get("display_title").as_deref(), Some("Lobster"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&get("terpene_profile").unwrap()).unwrap(),
            serde_json::json!(profile)
        );
        assert!(get("cbg_percent").is_none() && get("total_cannabinoids").is_none() && get("notes").is_none());
        assert_eq!(fields.len(), 9);
        assert!(fields.iter().all(|f| f["value"].is_string()));

        // No terpenes, no page name → those keys are absent too.
        let bare = coa_record_fields(&req, "FLO-1", "2025-04-15", "2026-04-15", &[]);
        assert!(bare.iter().all(|f| f["key"] != "terpene_profile"));

        let vars = metaobject_upsert_vars("flo-1", &fields, true);
        assert_eq!(vars["handle"], serde_json::json!({ "type": "coa_record", "handle": "flo-1" }));
        assert_eq!(vars["metaobject"]["capabilities"]["publishable"]["status"], "ACTIVE");
        assert_eq!(vars["metaobject"]["fields"].as_array().unwrap().len(), 9);
        assert_eq!(metaobject_upsert_vars("flo-1", &fields, false)["metaobject"]["capabilities"]["publishable"]["status"], "DRAFT");

        // Bad-key retry: last `field` segment of field/key errors, never the `fields` container.
        let errs = serde_json::json!([
            { "code": "UNDEFINED_OBJECT_FIELD", "message": "Field 'terpene_profile' does not exist", "field": ["metaobject", "fields", "terpene_profile"] },
            { "code": "INVALID_VALUE", "message": "bad", "field": ["metaobject", "fields"] },
            { "code": "BLANK", "message": "Handle can't be blank", "field": ["handle"] },
            { "code": null, "message": "unknown key expiry_date", "field": ["metaobject", "fields", "expiry_date"] }
        ]);
        assert_eq!(bad_field_keys(&errs), vec!["terpene_profile", "expiry_date"]);
        assert!(bad_field_keys(&serde_json::json!([])).is_empty());
        assert!(check_user_errors(&serde_json::json!([]), "x").is_ok());
        assert_eq!(check_user_errors(&errs, "metaobjectUpsert").unwrap_err(), "metaobjectUpsert: Field 'terpene_profile' does not exist; bad; Handle can't be blank; unknown key expiry_date");
    }

    fn template_fixture() -> serde_json::Value {
        serde_json::json!({
            "sections": {
                "header": { "type": "page-header", "settings": {} },
                "main": {
                    "type": "certificate-of-analysis",
                    "blocks": {
                        "certificate_a": { "type": "certificate", "settings": { "certificate_name": "Alien Grape", "certificate_file": "https://cdn/alien.pdf" } },
                        "certificate_l": { "type": "certificate", "settings": { "certificate_name": "Lobster", "certificate_file": "https://cdn/lobster.pdf" } },
                        "certificate_z": { "type": "certificate", "settings": { "certificate_name": "Zkittlez", "certificate_file": "https://cdn/z.pdf" } }
                    },
                    "block_order": ["certificate_a", "certificate_l", "certificate_z"],
                    "settings": {}
                },
                "overflow": {
                    "type": "certificate-of-analysis",
                    "disabled": true,
                    "blocks": { "certificate_m": { "type": "certificate", "settings": { "certificate_name": "Monkey  Berries", "certificate_file": "https://cdn/old.pdf" } } },
                    "block_order": ["certificate_m"],
                    "settings": {}
                }
            },
            "order": ["header", "main", "overflow"]
        })
    }

    #[test]
    fn certificate_block_upsert_updates_in_place_or_inserts_alphabetically() {
        // Existing name (case/whitespace-insensitive) inside a *disabled* section: file swapped, nothing added.
        let mut t = template_fixture();
        let d = upsert_certificate_block(&mut t, "monkey berries", "https://cdn/new.pdf", "certificate_NEW001").unwrap();
        assert_eq!(d, serde_json::json!({ "action": "updated", "sectionId": "overflow", "blockId": "certificate_m" }));
        let m = &t["sections"]["overflow"]["blocks"]["certificate_m"]["settings"];
        assert_eq!((m["certificate_file"].as_str(), m["certificate_name"].as_str()), (Some("https://cdn/new.pdf"), Some("Monkey  Berries")));
        assert_eq!(t["sections"]["main"]["blocks"].as_object().unwrap().len(), 3);
        assert_eq!(t["sections"]["overflow"]["block_order"], serde_json::json!(["certificate_m"]));

        // New name → the largest enabled section, alphabetical position, block_order updated.
        let mut t = template_fixture();
        t["sections"]["overflow"]["disabled"] = serde_json::json!(false);
        let d = upsert_certificate_block(&mut t, "Blue Dream", "https://cdn/bd.pdf", "certificate_NEW001").unwrap();
        assert_eq!(d, serde_json::json!({ "action": "added", "sectionId": "main", "blockId": "certificate_NEW001", "position": 1 }));
        assert_eq!(t["sections"]["main"]["block_order"], serde_json::json!(["certificate_a", "certificate_NEW001", "certificate_l", "certificate_z"]));
        assert_eq!(
            t["sections"]["main"]["blocks"]["certificate_NEW001"],
            serde_json::json!({ "type": "certificate", "name": "Blue Dream", "settings": { "certificate_name": "Blue Dream", "certificate_file": "https://cdn/bd.pdf" } })
        );
        // Sorts after everything → appended; sorts before everything → first.
        let d = upsert_certificate_block(&mut t, "zz top", "https://cdn/zz.pdf", "certificate_NEW002").unwrap();
        assert_eq!(d["position"], 4);
        let d = upsert_certificate_block(&mut t, "Acapulco Gold", "https://cdn/ag.pdf", "certificate_NEW003").unwrap();
        assert_eq!(d["position"], 0);
        assert_eq!(
            t["sections"]["main"]["block_order"],
            serde_json::json!(["certificate_NEW003", "certificate_a", "certificate_NEW001", "certificate_l", "certificate_z", "certificate_NEW002"])
        );
        assert_eq!(t["sections"]["main"]["blocks"].as_object().unwrap().len(), 6);
        assert_eq!(t["sections"]["overflow"]["block_order"], serde_json::json!(["certificate_m"]));
        assert_eq!(t["order"], serde_json::json!(["header", "main", "overflow"]));
        // Re-posting the strain just added updates it in place.
        let d = upsert_certificate_block(&mut t, "BLUE DREAM", "https://cdn/bd2.pdf", "certificate_NEW004").unwrap();
        assert_eq!(d["action"], "updated");
        assert_eq!(t["sections"]["main"]["blocks"]["certificate_NEW001"]["settings"]["certificate_file"], "https://cdn/bd2.pdf");

        // A section without blocks yet gets both maps created.
        let mut t = serde_json::json!({ "sections": { "main": { "type": "certificate-of-analysis" } }, "order": ["main"] });
        let d = upsert_certificate_block(&mut t, "Lobster", "https://cdn/l.pdf", "certificate_NEW001").unwrap();
        assert_eq!(d["position"], 0);
        assert_eq!(t["sections"]["main"]["block_order"], serde_json::json!(["certificate_NEW001"]));

        // No enabled COA section → error, template untouched.
        let mut t = template_fixture();
        t["sections"]["main"]["disabled"] = serde_json::json!(true);
        let before = t.clone();
        assert!(upsert_certificate_block(&mut t, "Blue Dream", "https://cdn/bd.pdf", "certificate_NEW001").unwrap_err().contains("No enabled"));
        assert_eq!(t, before);

        // The leading Shopify comment is skipped when parsing.
        let raw = format!("/*\n * auto-generated by Shopify\n */\n{}", template_fixture());
        assert_eq!(parse_theme_template(&raw).unwrap(), template_fixture());
        assert!(parse_theme_template("no json here").is_err());
        assert!(parse_theme_template("{\"order\": []}").unwrap_err().contains("sections"));
    }

    #[test]
    fn repost_name_precedence() {
        let manual = serde_json::json!({ "gid://shopify/GenericFile/1": { "productId": "gid://shopify/Product/1", "productTitle": "Lobster" } });
        let t = |file_id: &str, name: Option<&str>| RepostTarget {
            file_id: file_id.into(),
            file_url: "https://cdn.shopify.com/s/files/1/x/files/Alien_Grape_123e4567-e89b-12d3-a456-426614174000.pdf?v=1".into(),
            name: name.map(String::from),
        };
        assert_eq!(repost_name(&t("gid://shopify/GenericFile/1", Some(" Custom ")), &manual), "Custom");
        assert_eq!(repost_name(&t("gid://shopify/GenericFile/1", Some("  ")), &manual), "Lobster");
        assert_eq!(repost_name(&t("gid://shopify/GenericFile/2", None), &manual), "Alien Grape");
    }

    #[test]
    fn staged_upload_vars_and_id_helpers() {
        assert_eq!(
            staged_upload_vars("Alien Grape.pdf", 12345),
            serde_json::json!({ "input": [{ "filename": "Alien Grape.pdf", "mimeType": "application/pdf", "resource": "FILE", "httpMethod": "POST", "fileSize": "12345" }] })
        );
        assert_eq!(pdf_stem("Alien Grape.PDF"), "Alien Grape");
        assert_eq!(pdf_stem("notes.txt"), "notes.txt");
        assert_eq!(pdf_stem("pdf"), "pdf");
        let id = new_block_id();
        assert!(id.starts_with("certificate_") && id.len() == 18 && id[12..].chars().all(|c| c.is_ascii_alphanumeric()), "{id}");
        assert_eq!(opt_text(&Some("  x ".into())).as_deref(), Some("x"));
        assert_eq!(opt_text(&Some("  ".into())), None);
    }

    // -- Google Drive + Sheet mirror -----------------------------------------------------------

    /// Throwaway 2048-bit key made with `openssl genpkey` for this test only; it is used nowhere else.
    const TEST_PKCS8_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCSuZtxZEQ5uc9D\nRigrmtv0tCTSWWJyjbWNg1+s/hKL5dzQGfXu7GlXY3W0KAgy2num/YEXbbpaccW4\nniFpevan8Y4P+a0ikUFjYP0iZAzJ7t47XsRfmBFun51rcXHSWo7LYgco/zf3NS1K\nS6YN6fy23TvdJIr2EvLO+t11xkuL5DNq/VOKNjH5CV/ErosX4dnRQK0CbLd80DRT\nhstLrpvCl7428W7p4ugvQOCbYmK1Gssr+R+N5w+X79bfre1KGs9JntwlKJUaEOui\nO2Ei/l3Eea9xHBsIjz3eMTTKmf1NTKnZ5Fw1aKt76JG8fjL3TSPNvZlLeW4VfxKA\nP6RkYBV3AgMBAAECggEADvF9tga9jBjd1b7cyH7KeBmrcQukIyvw7wC6SybKl2+f\nFZ1kls4tIbas04m1jA2vGkrR+E43SeQx0aOz83I6kiWKj8X2BCyXDvAJ1+l+A/L4\nCe6U7BzTaa4ynNwTo5Y62ivvCWs03/s31EvwFZVcek396CqYnIdBg3hj+w1pvvgk\nqg+sxcntIRcOM3oPcWT5WBAQJFKWyzuxbT9HfdEdnhlylhJkNVj+KRg8sGxMTWRy\nR2H2Gj8qJY8ghAhAR9aFRvvDrcR7kGzsxB+7YrHBCl3pj09eeUs6Z12BMc3UY33D\nboUhn1ZR6sMsvbNjllBtu2ED4dQbJdXAp2kNTsBqQQKBgQDO2ultsGSNK+oVsssY\nqcjb6fmDXeCVVSkPL+CABYPJhLbjrEqu8ES/BqefMWAkNGd5Z5r9G3wZsApkkLJ/\nIWzwAkQctiF62eQ7WHBpA8ikBhpDBhJeGsOwQ32RIUQZbh1Dxt8Jq6uYqgyUVVzO\nHJigoeaJMDOYQj8Ovwb7F5PPKwKBgQC1lYlbXMiiOx1FXsp7TEdsRaA9Am96gPKm\nym/NlZ0JF6mZABRNvcpqIHpZuxOnlDTq1OBT49iJGzDL4m/COjbunSAKcktfaAs/\n2GY+s9N/mClFQAvEKkcqtHqmPrKfZc1A/OhFLEJlHIfv3mF48AeCNP2mWFUwxwtm\nW0mpt3VM5QKBgQCr7JqyxjbsdqFaY34WA5ej4DW3j6EHvP4hV0OaY/sC1MFFPX/d\nImmg86EB2QH1VXDjIM9aqytcFkqtBu60Z02ptdhynJX7C3p8MKdNQQ3T9haBulwt\nxsT6jT2iECoPkMvV90aNPRekDUHjT4eQ74eTiryXLW7Uj8rlMLRWoWQCfQKBgQCL\n8AP8/tI4BCqYrWaKAs0AKeBFZD0ZQYq+8z+aRfTRbwTqvl7nUp5Nj137DOsmuFbX\nqtp+jBbyApxmY8kQ++Adn8Vzh4WCryIMP+7734XczRzxG1x1/sb9qDzlJWhu4vt9\nW+p8dJFubsBsIQspMoH23HOl4Gk2wA6PAUcRniqt6QKBgCX/YsoanyippgUhoeM8\nqdbG8qSaaa8neCoSulXrAjGZAvvpXeYPPLtUEYVKMWpDQSSWwZkvRb13vAc4uv9X\neY4S7tOXnt6e/PcDER9QHFk5LlhdBZWKj7Db8uy+I2t84DBQezgVPcWAvs+Zchhf\nwtB/rPAuLtPqjFNogtLLW6pJ\n-----END PRIVATE KEY-----\n";

    #[test]
    fn base64url_is_unpadded_url_alphabet() {
        assert_eq!(base64url_encode(b""), "");
        assert_eq!(base64url_encode(b"f"), "Zg");
        assert_eq!(base64url_encode(b"fo"), "Zm8");
        assert_eq!(base64url_encode(b"foobar"), "Zm9vYmFy");
        // 0xfb 0xff 0xbf is "+/+/" in the standard alphabet.
        assert_eq!(base64url_encode(&[0xfb, 0xff, 0xbf]), "-_-_");
    }

    fn base64url_decode(s: &str) -> Vec<u8> {
        base64_decode(&s.replace('-', "+").replace('_', "/")).unwrap()
    }

    #[test]
    fn jwt_signing_input_is_two_base64url_segments_with_the_claims() {
        let input = jwt_signing_input("bot@example.iam.gserviceaccount.com", 1_700_000_000);
        let parts: Vec<&str> = input.split('.').collect();
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')), "{input}");
        let decode = |p: &str| serde_json::from_slice::<serde_json::Value>(&base64url_decode(p)).unwrap();
        assert_eq!(decode(parts[0]), serde_json::json!({ "alg": "RS256", "typ": "JWT" }));
        assert_eq!(
            decode(parts[1]),
            serde_json::json!({
                "iss": "bot@example.iam.gserviceaccount.com",
                "scope": "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
                "aud": "https://oauth2.googleapis.com/token",
                "iat": 1_700_000_000,
                "exp": 1_700_003_600,
            })
        );
    }

    #[test]
    fn pem_to_der_strips_armor_and_newlines() {
        let pem = "-----BEGIN PRIVATE KEY-----\nAAEC\nAwQF\n-----END PRIVATE KEY-----\n";
        assert_eq!(pem_to_der(pem).unwrap(), vec![0, 1, 2, 3, 4, 5]);
        assert!(pem_to_der("-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----").is_err());
    }

    #[test]
    fn sign_jwt_with_ring_verifies_under_the_public_key() {
        let der = pem_to_der(TEST_PKCS8_PEM).unwrap();
        let input = jwt_signing_input("bot@example.com", 1);
        let jwt = sign_jwt(&der, &input).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(format!("{}.{}", parts[0], parts[1]), input);
        let sig = base64url_decode(parts[2]);
        assert_eq!(sig.len(), 256);
        let key = ring::signature::RsaKeyPair::from_pkcs8(&der).unwrap();
        let public = ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, key.public().as_ref());
        assert!(public.verify(input.as_bytes(), &sig).is_ok());
        assert!(public.verify(b"tampered", &sig).is_err());
        assert!(sign_jwt(b"not a key", &input).is_err());
    }

    #[test]
    fn header_aliases_map_live_sheet_columns() {
        let f = |h: &str| header_field(&norm_key(h));
        assert_eq!(f("Report Date"), Some("issued"));
        assert_eq!(f("Google Drive COA Link"), Some("driveFileName"));
        assert_eq!(f("Google Drive COA URL"), Some("driveUrl"));
        assert_eq!(f("Column 5"), Some("expires"));
        assert_eq!(f("Posted on Retail"), Some("posted"));
        assert_eq!(f("Batch #"), Some("batch"));
        assert_eq!(f("Name"), Some("productName"));
        assert_eq!(f("Owner"), None);
        // Every default header maps back to a field, so an empty tab round-trips.
        assert!(DEFAULT_COLUMNS.iter().all(|c| f(c).is_some()));
    }

    #[test]
    fn to_sheet_date_and_col_letter() {
        assert_eq!(to_sheet_date("2026-09-14"), "9/14/2026");
        assert_eq!(to_sheet_date("2026-09-14T12:00:00Z"), "9/14/2026");
        assert_eq!(to_sheet_date("9/14/2026"), "9/14/2026");
        assert_eq!(to_sheet_date(""), "");
        assert_eq!(col_letter(0), "A");
        assert_eq!(col_letter(25), "Z");
        assert_eq!(col_letter(26), "AA");
        assert_eq!(col_letter(701), "ZZ");
        assert_eq!(col_letter(702), "AAA");
    }

    fn fields(pairs: &[(&'static str, &str)]) -> HashMap<&'static str, String> {
        pairs.iter().map(|(k, v)| (*k, v.to_string())).collect()
    }

    #[test]
    fn merge_sheet_row_keys_on_batch_and_preserves_unmapped_cells() {
        let grid: Vec<Vec<serde_json::Value>> = serde_json::from_value(serde_json::json!([
            ["Name", "Batch", "Report Date", "Column 5", "THCa", "Owner", "Google Drive COA Link"],
            ["Alien Grape", "AG-001", "1/2/2025", "1/2/2026", 24.1, "Chase", "old.pdf"],
            ["Blue Dream", "bd-7", "", "", 20, "Sam", ""],
        ]))
        .unwrap();
        let m = merge_sheet_row(
            &grid,
            &fields(&[("batch", "BD-7"), ("productName", "Blue Dream"), ("issued", "2026-09-14"), ("expires", "2027-09-14"), ("thca", ""), ("driveFileName", "Blue Dream.pdf"), ("notes", "no column")]),
        );
        assert_eq!(m.target, Some(2), "batch match is case-insensitive");
        assert_eq!(serde_json::Value::Array(m.out), serde_json::json!(["Blue Dream", "BD-7", "9/14/2026", "9/14/2027", 20, "Sam", "Blue Dream.pdf"]));
        assert_eq!(m.matched_fields, ["productName", "batch", "issued", "expires", "thca", "driveFileName"]);
        assert_eq!(m.chip_col, Some(6));

        // No batch column → keyed on the name column; no match → append with blanks for unmapped columns.
        let grid2: Vec<Vec<serde_json::Value>> =
            serde_json::from_value(serde_json::json!([["Strain", "Lab", "Owner"], ["Alien Grape", "ACS", "Chase"]])).unwrap();
        let m2 = merge_sheet_row(&grid2, &fields(&[("batch", "X-1"), ("productName", "alien grape"), ("lab", "SC Labs")]));
        assert_eq!(m2.target, Some(1));
        assert_eq!(serde_json::Value::Array(m2.out), serde_json::json!(["alien grape", "SC Labs", "Chase"]));
        let m3 = merge_sheet_row(&grid2, &fields(&[("productName", "Zkittlez"), ("lab", "ACS")]));
        assert_eq!(m3.target, None);
        assert_eq!(serde_json::Value::Array(m3.out), serde_json::json!(["Zkittlez", "ACS", ""]));
        assert_eq!(m3.chip_col, None);
    }

    #[test]
    fn sheet_fields_drop_blanks_and_stamp_imported_at() {
        let row = SheetRow { batch: Some(" B1 ".into()), lab: Some("".into()), posted: Some("Yes".into()), ..Default::default() };
        let f = sheet_fields(&row, Some("https://drive/x"), "Alien Grape.pdf");
        assert_eq!(f["batch"], "B1");
        assert!(!f.contains_key("lab"));
        assert_eq!(f["driveUrl"], "https://drive/x");
        assert_eq!(f["driveFileName"], "Alien Grape.pdf");
        assert_eq!(f["posted"], "Yes");
        assert!(is_ymd(&f["importedAt"][..10]));
        let f2 = sheet_fields(&SheetRow { imported_at: Some("2026-01-02T00:00:00Z".into()), ..Default::default() }, None, "");
        assert_eq!(f2.len(), 1);
        assert_eq!(f2["importedAt"], "2026-01-02T00:00:00Z");
    }

    #[test]
    fn canonical_flower_type_table() {
        for (input, want) in [
            ("Type 1 - High THCa", Some("Type 1 (THCa)")),
            ("type-2", Some("Type 2 (THCa & CBD)")),
            ("TYPE 3 (CBD)", Some("Type 3 (CBD)")),
            ("Type 4", Some("Type 4 (CBG)")),
            ("CBG flower", Some("Type 4 (CBG)")),
            ("THCa + CBD", Some("Type 2 (THCa & CBD)")),
            ("CBD", Some("Type 3 (CBD)")),
            ("cbda rich", None),
            ("High THC-A", Some("Type 1 (THCa)")),
            ("Hybrid", None),
            ("", None),
        ] {
            assert_eq!(canonical_flower_type(input), want, "{input:?}");
        }
    }

    #[test]
    fn appended_row_number_parses_updated_range() {
        assert_eq!(appended_row_number("'Master COA'!A335:I335"), Some(335));
        assert_eq!(appended_row_number("Sheet1!AB12"), Some(12));
        assert_eq!(appended_row_number("'Odd!Tab'!C7:D7"), Some(7));
        assert_eq!(appended_row_number(""), None);
        assert_eq!(appended_row_number("garbage"), None);
    }

    #[test]
    fn sheet_url_encoding_and_multipart_related() {
        assert_eq!(url_encode("'My Tab'!A1:Z2000"), "%27My%20Tab%27%21A1%3AZ2000");
        assert_eq!(sheet_values_url("SID", "It's", "A1"), format!("{SHEETS_API}/SID/values/%27It%27%27s%27%21A1"));
        let (ctype, body) = multipart_related(r#"{"name":"x.pdf"}"#, "application/pdf", b"%PDF");
        let boundary = ctype.strip_prefix("multipart/related; boundary=").unwrap();
        assert_eq!(
            String::from_utf8(body).unwrap(),
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{{\"name\":\"x.pdf\"}}\r\n--{boundary}\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n--{boundary}--\r\n")
        );
    }

    #[test]
    fn parse_google_env_takes_only_the_four_keys() {
        let env = "SHOPIFY_TOKEN=shh\n# GOOGLE_SHEET_ID=commented\nGOOGLE_SERVICE_ACCOUNT_KEY_FILE=\"/Users/x/key.json\"\nGOOGLE_SHEET_ID='abc123'\n  GOOGLE_DRIVE_FOLDER_ID = folder9 \nOTHER=1\n";
        let cfg = parse_google_env(env).unwrap();
        assert_eq!(cfg.key_file, "/Users/x/key.json");
        assert_eq!(cfg.sheet_id.as_deref(), Some("abc123"));
        assert_eq!(cfg.sheet_tab, None);
        assert_eq!(cfg.folder_id.as_deref(), Some("folder9"));
        assert!(cfg.configured());
        assert_eq!(serde_json::to_value(&cfg).unwrap().as_object().unwrap().len(), 4);
        assert!(parse_google_env("GOOGLE_SHEET_ID=abc\n").is_none());
        assert!(parse_google_env("GOOGLE_SERVICE_ACCOUNT_KEY_FILE=\n").is_none());
        assert!(!GoogleConfig { key_file: "/k.json".into(), ..Default::default() }.configured());
    }
}

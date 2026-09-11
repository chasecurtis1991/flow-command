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
    pub line_items: Vec<LineItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LineItem {
    pub title: String,
    pub sku: Option<String>,
    pub quantity: i32,
    pub price: String,
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

// GraphQL helper
async fn graphql_query(shop_domain: &str, query: &str) -> Result<serde_json::Value, String> {
    let token = get_cached_token(shop_domain).await?;
    let client = reqwest::Client::new();
    let graphql_url = format!("https://{}/admin/api/2026-01/graphql.json", shop_domain);

    let body = serde_json::json!({ "query": query });

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
async fn fetch_shop_info() -> Result<ShopInfo, String> {
    let active = get_active_store().unwrap_or(StoreInfo {
        id: "retail".into(),
        label: "Retail".into(),
        domain: SHOP_RETAIL.into(),
    });
    let shop_domain = active.domain;

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

// List orders for active store
#[tauri::command]
async fn list_orders(first: Option<i32>) -> Result<Vec<Order>, String> {
    let active = get_active_store()?;
    let shop_domain = active.domain;
    let count = first.unwrap_or(25).min(100);

    let query = format!(
        r#"
        {{
            orders(first: {}, sortKey: CREATED_AT, reverse: true) {{
                edges {{
                    node {{
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
                        customer {{
                            displayName
                            email
                        }}
                    }}
                }}
            }}
        }}
        "#,
        count
    );

    let result = graphql_query(&shop_domain, &query).await?;

    let orders: Vec<Order> = result["data"]["orders"]["edges"]
        .as_array()
        .ok_or("Invalid orders response")?
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
            })
        })
        .collect();

    Ok(orders)
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
                customer {{
                    displayName
                    email
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
        line_items,
    })
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
            get_order
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

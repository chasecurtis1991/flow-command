use serde::{Deserialize, Serialize};
use keyring::Entry;

const KEYCHAIN_SERVICE: &str = "com.flowgardens.command";
const KEY_CLIENT_ID: &str = "shopify_client_id";
const KEY_CLIENT_SECRET: &str = "shopify_client_secret";
const KEY_ACTIVE_SHOP: &str = "shopify_active_shop";

/// Real Plus store myshopify domains (not the vanity names in some docs).
const SHOP_RETAIL: &str = "3wvfyr-1i.myshopify.com";
const SHOP_B2B: &str = "b8h8vg-ij.myshopify.com";
const SHOP_BULK: &str = "fg-craft-flower.myshopify.com";

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

#[tauri::command]
async fn fetch_shopify_token(shop_domain: String) -> Result<String, String> {
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
        return Err(format!(
            "Token request failed for {shop_domain} with status {status}: {body}"
        ));
    }

    let token_data: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    Ok(token_data.access_token)
}

#[tauri::command]
async fn fetch_shop_info() -> Result<ShopInfo, String> {
    let active = get_active_store().unwrap_or(StoreInfo {
        id: "retail".into(),
        label: "Retail".into(),
        domain: SHOP_RETAIL.into(),
    });
    let shop_domain = active.domain;
    let token = fetch_shopify_token(shop_domain.clone()).await?;

    let client = reqwest::Client::new();
    let graphql_url = format!("https://{shop_domain}/admin/api/2026-01/graphql.json");

    let query = r#"
        {
            shop {
                name
            }
        }
    "#;

    let body = serde_json::json!({ "query": query });

    let response = client
        .post(&graphql_url)
        .header("X-Shopify-Access-Token", &token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GraphQL request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read response".to_string());
        return Err(format!("GraphQL request failed with status {status}: {body}"));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GraphQL response: {e}"))?;

    if let Some(errors) = result.get("errors") {
        return Err(format!("GraphQL errors: {errors}"));
    }

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
            fetch_shop_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

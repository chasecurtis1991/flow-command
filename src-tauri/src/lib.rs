use serde::{Deserialize, Serialize};
use keyring::Entry;

#[derive(Debug, Serialize, Deserialize)]
struct ShopifyCredentials {
    client_id: String,
    client_secret: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenResponse {
    access_token: String,
    scope: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ShopInfo {
    shop_name: Option<String>,
    products_count: Option<i32>,
    status: String,
}

// Health check command
#[tauri::command]
fn ping() -> String {
    "Flow Command is running ✓".to_string()
}

// Save Shopify credentials to macOS Keychain
#[tauri::command]
fn save_shopify_credentials(client_id: String, client_secret: String) -> Result<String, String> {
    let entry_id = Entry::new("Flow Command", "shopify_client_id")
        .map_err(|e| format!("Keychain error: {}", e))?;
    let entry_secret = Entry::new("Flow Command", "shopify_client_secret")
        .map_err(|e| format!("Keychain error: {}", e))?;

    entry_id
        .set_password(&client_id)
        .map_err(|e| format!("Failed to save client_id: {}", e))?;
    entry_secret
        .set_password(&client_secret)
        .map_err(|e| format!("Failed to save client_secret: {}", e))?;

    Ok("Credentials saved successfully".to_string())
}

// Get Shopify credentials from macOS Keychain
#[tauri::command]
fn get_shopify_credentials() -> Result<ShopifyCredentials, String> {
    let entry_id = Entry::new("Flow Command", "shopify_client_id")
        .map_err(|e| format!("Keychain error: {}", e))?;
    let entry_secret = Entry::new("Flow Command", "shopify_client_secret")
        .map_err(|e| format!("Keychain error: {}", e))?;

    let client_id = entry_id
        .get_password()
        .map_err(|e| format!("Client ID not found in Keychain: {}", e))?;
    let client_secret = entry_secret
        .get_password()
        .map_err(|e| format!("Client secret not found in Keychain: {}", e))?;

    Ok(ShopifyCredentials {
        client_id,
        client_secret,
    })
}

// Fetch Shopify access token using client credentials flow
#[tauri::command]
async fn fetch_shopify_token(shop_domain: String) -> Result<String, String> {
    let creds = get_shopify_credentials()?;

    let client = reqwest::Client::new();
    let token_url = format!("https://{}/admin/oauth/access_token", shop_domain);

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
        .map_err(|e| format!("Token request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read response".to_string());
        return Err(format!("Token request failed with status {}: {}", status, body));
    }

    let token_data: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    Ok(token_data.access_token)
}

// Fetch shop info from Shopify GraphQL API
#[tauri::command]
async fn fetch_shop_info() -> Result<ShopInfo, String> {
    // Default to retail store for demo
    let shop_domain = "flowgardensaz.myshopify.com";
    let token = fetch_shopify_token(shop_domain.to_string()).await?;

    let client = reqwest::Client::new();
    let graphql_url = format!("https://{}/admin/api/2024-01/graphql.json", shop_domain);

    // Simple GraphQL query to get shop name and product count
    let query = r#"
        {
            shop {
                name
            }
            products(first: 1) {
                pageInfo {
                    hasNextPage
                }
            }
        }
    "#;

    let body = serde_json::json!({
        "query": query
    });

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
        return Err(format!("GraphQL request failed with status {}: {}", status, body));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GraphQL response: {}", e))?;

    let shop_name = result["data"]["shop"]["name"]
        .as_str()
        .map(|s| s.to_string());

    Ok(ShopInfo {
        shop_name,
        products_count: None, // Could calculate from pagination
        status: "Connected ✓".to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            save_shopify_credentials,
            get_shopify_credentials,
            fetch_shopify_token,
            fetch_shop_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

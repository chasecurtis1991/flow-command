//! Voice assistant plumbing (ElevenLabs Agents). The API key lives in the Keychain and never reaches the web view:
//! Rust creates/updates the private "Flow Command" agent and its client tools, and hands React a short-lived WebRTC
//! conversation token per session. The tools themselves run in React against the app's existing commands; anything
//! that changes Shopify only becomes a review card the user must Apply (see src/assistant/).
//!
//! Agent / tool / voice ids are not secret and live in `<app data>/voice-config.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::Manager;

const KEY_ELEVENLABS: &str = "elevenlabs_api_key";
const API: &str = "https://api.elevenlabs.io";

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    pub agent_id: Option<String>,
    pub voice_id: Option<String>,
    pub voice_name: Option<String>,
    /// LLM chosen at setup (fastest available from FAST_LLMS); None = ElevenLabs' default.
    #[serde(default)]
    pub llm: Option<String>,
    /// client tool name → ElevenLabs workspace tool id
    #[serde(default)]
    pub tool_ids: BTreeMap<String, String>,
    /// Bumped when the prompt/tools below change, so Settings can say "Update agent".
    #[serde(default)]
    pub setup_version: u32,
}

/// Increment when PROMPT, tool_defs() or the agent's model settings change.
const SETUP_VERSION: u32 = 3;
/// Lowest-latency TTS model for English agents.
const TTS_MODEL: &str = "eleven_flash_v2";
/// Fast tool-capable LLMs, best first; setup uses the first one ElevenLabs lists for this workspace (GET /v1/llm).
/// ponytail: fixed preference list; revisit when ElevenLabs adds faster models.
const FAST_LLMS: &[&str] = &["gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "gpt-4.1-nano", "gemini-2.0-flash", "gpt-4o-mini", "gemini-2.5-flash"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub has_key: bool,
    pub key_hint: Option<String>,
    pub agent_id: Option<String>,
    pub voice_id: Option<String>,
    pub voice_name: Option<String>,
    pub llm: Option<String>,
    /// The agent exists but was set up with an older prompt/tool set.
    pub needs_update: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub id: String,
    pub name: String,
    /// premade | cloned | generated | professional | …
    pub category: Option<String>,
}

fn key() -> Result<Option<String>, String> {
    match crate::keychain_entry(KEY_ELEVENLABS)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}
fn require_key() -> Result<String, String> {
    key()?.ok_or_else(|| "No ElevenLabs API key — add it in Settings → Voice assistant.".to_string())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?.join("voice-config.json"))
}
fn load_config(app: &tauri::AppHandle) -> VoiceConfig {
    config_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn save_config(app: &tauri::AppHandle, c: &VoiceConfig) -> Result<(), String> {
    let p = config_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(&p, serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?).map_err(|e| format!("write {}: {e}", p.display()))
}

async fn call(method: reqwest::Method, path: &str, key: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let mut req = reqwest::Client::new().request(method, format!("{API}{path}")).header("xi-api-key", key);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| format!("ElevenLabs request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail: String = text.chars().take(300).collect();
        return Err(match status.as_u16() {
            401 | 403 => format!("ElevenLabs rejected the API key ({status}). Check it in Settings. {detail}"),
            _ => format!("ElevenLabs error ({status}): {detail}"),
        });
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("ElevenLabs returned unreadable JSON: {e}"))
}

#[tauri::command]
pub fn voice_status(app: tauri::AppHandle) -> Result<VoiceStatus, String> {
    let k = key()?;
    let c = load_config(&app);
    Ok(VoiceStatus {
        has_key: k.is_some(),
        key_hint: k.map(|k| format!("…{}", k.char_indices().nth_back(3).map_or(k.as_str(), |(i, _)| &k[i..]))),
        needs_update: c.agent_id.is_some() && c.setup_version < SETUP_VERSION,
        agent_id: c.agent_id,
        voice_id: c.voice_id,
        voice_name: c.voice_name,
        llm: c.llm,
    })
}

/// Empty key removes the Keychain entry.
#[tauri::command]
pub fn save_elevenlabs_key(key: String) -> Result<String, String> {
    let key = key.trim().to_string();
    let entry = crate::keychain_entry(KEY_ELEVENLABS)?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok("ElevenLabs key removed".into()),
            Err(e) => Err(format!("Failed to remove ElevenLabs key: {e}")),
        };
    }
    entry.set_password(&key).map_err(|e| format!("Failed to save ElevenLabs key: {e}"))?;
    Ok("ElevenLabs key saved to Keychain".into())
}

#[tauri::command]
pub async fn list_voices() -> Result<Vec<Voice>, String> {
    let k = require_key()?;
    let r = call(reqwest::Method::GET, "/v1/voices", &k, None).await?;
    let mut v: Vec<Voice> = r["voices"]
        .as_array()
        .map(|vs| {
            vs.iter()
                .filter_map(|v| Some(Voice { id: v["voice_id"].as_str()?.into(), name: v["name"].as_str()?.into(), category: v["category"].as_str().map(String::from) }))
                .collect()
        })
        .unwrap_or_default();
    // Your own voices (cloned / generated / professional) first, then the library ones.
    v.sort_by_key(|x| (x.category.as_deref() == Some("premade"), x.name.to_lowercase()));
    Ok(v)
}

const PROMPT: &str = r#"You are the voice assistant inside Flow Command, the internal operations app for Flow Gardens (hemp; three Shopify stores: Retail, B2B / Wholesale, Bulk / Craft Flower). You talk with Flow Gardens staff.

Rules:
- Use the tools for every fact about orders, inventory, sales or customers. Never guess numbers or statuses. If a tool returns an error or nothing, say so plainly.
- The current store, screen and selected record arrive as context updates; tools default to the current store unless the user names another one.
- You cannot change anything yourself. For inventory changes call propose_inventory_adjustment; for order notes or tags call propose_order_update. These only show a review card in the app. Then tell the user to check the card and click Apply. Never say a change was made until the app tells you it was applied.
- Navigation is hands-free: when the user asks to go to, open, show, pull up or switch to anything, call the matching tool right away without asking for confirmation (open_screen, switch_store, open_order, open_customer, open_product, open_inventory_item, open_coa, ui_action). Then confirm in a few words ("Here's R94244."). Refund, fulfill, notes, adjust and split actions only open a form; the user confirms in the app.
- If a tool says a request is ambiguous (several matching items, locations or orders), ask a short question to narrow it down.
- Tags are labels only: a tag is never an actual fulfillment hold.
- Keep spoken replies short: lead with the answer, then at most one useful detail. Say money as dollars and cents and quantities as whole numbers. Read order names like "R 9 4 2 4 4"."#;

/// The client tools React implements (src/assistant/tools.ts). Names and parameters must match there.
fn tool_defs() -> Vec<serde_json::Value> {
    let store = serde_json::json!({ "type": "string", "enum": ["retail", "b2b", "bulk"], "description": "Store; omit to use the store the app has open." });
    let tool = |name: &str, description: &str, properties: serde_json::Value, required: &[&str]| {
        serde_json::json!({
            "type": "client",
            "name": name,
            "description": description,
            "expects_response": true,
            "response_timeout_secs": 20,
            "parameters": { "type": "object", "properties": properties, "required": required },
        })
    };
    vec![
        tool("find_inventory", "Look up stock for products, variants or SKUs: available, on hand and committed per location.",
            serde_json::json!({ "query": { "type": "string", "description": "Product name, variant (size) and/or SKU, e.g. 'Lifter 7g' or 'FG-LFT-7G'." }, "store": store }), &["query"]),
        tool("find_orders", "Search orders. Returns up to 8 matches with status, total, customer and date.",
            serde_json::json!({ "query": { "type": "string", "description": "Customer name, email, order number, or Shopify search like 'status:open' or 'fulfillment_status:unfulfilled'." }, "store": store }), &["query"]),
        tool("get_order", "Full detail of one order: items, totals, payment and fulfillment status, note, tags, shipping address.",
            serde_json::json!({ "order": { "type": "string", "description": "Order number, e.g. 'R94244' or '#R-10482'." }, "store": store }), &["order"]),
        tool("sales_summary", "Shopify's sales report: orders, gross, discounts, returns, net and total sales, average order, top products.",
            serde_json::json!({ "days": { "type": "integer", "description": "Number of days ending today (1 = today), up to 90." }, "store": { "type": "string", "enum": ["retail", "b2b", "bulk", "all"], "description": "Store or 'all'; omit for the open store." } }), &["days"]),
        tool("open_screen", "Show a screen, optionally with a view and a search. Views: orders all|unfulfilled; inventory shopify|fginv|low_stock|receive|transfer; catalog table|grid|drafts; lab table|calendar|labs|link|unposted; analytics 7|14|30|90 (days).",
            serde_json::json!({
                "screen": { "type": "string", "enum": ["home", "orders", "inventory", "catalog", "lab", "customers", "analytics", "settings"], "description": "Which screen to show." },
                "view": { "type": "string", "description": "Optional view for that screen (see the tool description)." },
                "search": { "type": "string", "description": "Optional search text (orders, inventory, catalog, lab, customers)." } }), &["screen"]),
        tool("switch_store", "Switch the app to another store.",
            serde_json::json!({ "store": { "type": "string", "enum": ["retail", "b2b", "bulk"], "description": "Store to switch to." } }), &["store"]),
        tool("open_order", "Open one order: its detail panel, or straight into refund / fulfill / notes, its Shopify admin page, or its carrier tracking page.",
            serde_json::json!({
                "order": { "type": "string", "description": "Order number, e.g. 'R94244'." },
                "action": { "type": "string", "enum": ["details", "refund", "fulfill", "notes", "shopify", "tracking"], "description": "What to open; default details." },
                "store": store.clone() }), &["order"]),
        tool("open_customer", "Open one customer: their detail panel, their Shopify admin page, or a new email to them.",
            serde_json::json!({
                "customer": { "type": "string", "description": "Customer name, email or company." },
                "action": { "type": "string", "enum": ["details", "shopify", "email"], "description": "What to open; default details." },
                "store": store.clone() }), &["customer"]),
        tool("open_product", "Open one product: its catalog detail panel, its Shopify admin page, its page on the website, or Split variants.",
            serde_json::json!({
                "product": { "type": "string", "description": "Product title, e.g. 'Lifter'." },
                "action": { "type": "string", "enum": ["details", "shopify", "online_store", "split_variants"], "description": "What to open; default details." },
                "store": store.clone() }), &["product"]),
        tool("open_inventory_item", "Show an item in Inventory, or open the Adjust stock dialog for it.",
            serde_json::json!({
                "item": { "type": "string", "description": "SKU, or product and variant, e.g. 'Lifter 7g'." },
                "action": { "type": "string", "enum": ["show", "adjust"], "description": "Show it in the list, or open Adjust; default show." },
                "store": store.clone() }), &["item"]),
        tool("open_coa", "Open a certificate of analysis (COA) in Lab by batch, product or lab name.",
            serde_json::json!({ "query": { "type": "string", "description": "Batch number, product or lab, e.g. 'FG-24-0918'." } }), &["query"]),
        tool("ui_action", "Control the app itself.",
            serde_json::json!({ "action": { "type": "string", "enum": ["go_back", "go_forward", "close_panel", "collapse_sidebar", "expand_sidebar", "toggle_sidebar", "open_command_palette", "refresh", "hide_assistant"], "description": "close_panel closes the open dialog or detail panel; refresh reloads the screen from Shopify." } }), &["action"]),
        tool("propose_inventory_adjustment", "Prepare (not apply) a stock change for one variant at one location. Shows a review card; the user applies it.",
            serde_json::json!({
                "item": { "type": "string", "description": "SKU, or product and variant, e.g. 'Lifter 7g'." },
                "change": { "type": "integer", "description": "Units to add (positive) or remove (negative)." },
                "reason": { "type": "string", "enum": ["correction", "cycle_count_available", "damaged", "shrinkage", "received", "restock", "promotion", "other"], "description": "Why the stock changes (cycle_count_available = counted stock differs)." },
                "location": { "type": "string", "description": "Location name if the item is stocked in several." },
                "store": store }), &["item", "change", "reason"]),
        tool("propose_order_update", "Prepare (not apply) adding to an order's note and/or adding or removing tags. Existing note text and other tags are kept. Shows a review card; the user applies it.",
            serde_json::json!({
                "order": { "type": "string", "description": "Order number, e.g. 'R94244'." },
                "append_note": { "type": "string", "description": "Text to add on a new line at the end of the note." },
                "add_tags": { "type": "string", "description": "Comma-separated tags to add." },
                "remove_tags": { "type": "string", "description": "Comma-separated tags to remove." },
                "store": store }), &["order"]),
    ]
}

/// Create or update the agent and its tools with the chosen voice; safe to run again (it updates in place).
#[tauri::command]
pub async fn setup_voice_agent(app: tauri::AppHandle, voice_id: String, voice_name: Option<String>) -> Result<VoiceConfig, String> {
    let k = require_key()?;
    if voice_id.trim().is_empty() {
        return Err("Pick a voice first.".into());
    }
    let mut c = load_config(&app);
    // Adopt client tools already in the workspace under our names (e.g. left by an interrupted setup) instead of duplicating them.
    if let Ok(list) = call(reqwest::Method::GET, "/v1/convai/tools", &k, None).await {
        for t in list["tools"].as_array().into_iter().flatten() {
            let (Some(id), Some(name)) = (t["id"].as_str(), t["tool_config"]["name"].as_str()) else { continue };
            if t["tool_config"]["type"] == "client" && tool_defs().iter().any(|d| d["name"] == name) {
                c.tool_ids.entry(name.to_string()).or_insert_with(|| id.to_string());
            }
        }
    }
    for def in tool_defs() {
        let name = def["name"].as_str().unwrap_or_default().to_string();
        let body = serde_json::json!({ "tool_config": def });
        match c.tool_ids.get(&name).cloned() {
            Some(id) => match call(reqwest::Method::PATCH, &format!("/v1/convai/tools/{id}"), &k, Some(body.clone())).await {
                Ok(_) => {}
                // Deleted in the ElevenLabs dashboard → create it again.
                Err(e) if e.contains("404") => {
                    let r = call(reqwest::Method::POST, "/v1/convai/tools", &k, Some(body)).await?;
                    c.tool_ids.insert(name, r["id"].as_str().ok_or("ElevenLabs returned no tool id")?.to_string());
                    save_config(&app, &c)?;
                }
                Err(e) => return Err(e),
            },
            None => {
                let r = call(reqwest::Method::POST, "/v1/convai/tools", &k, Some(body)).await?;
                c.tool_ids.insert(name, r["id"].as_str().ok_or("ElevenLabs returned no tool id")?.to_string());
                // Saved right away: if a later step fails, a retry updates this tool instead of creating a duplicate.
                save_config(&app, &c)?;
            }
        }
    }
    // Pick the fastest model this workspace offers; leave ElevenLabs' default if the list can't be read.
    let llm = call(reqwest::Method::GET, "/v1/llm", &k, None).await.ok().and_then(|r| pick_llm(&r));
    let mut prompt = serde_json::json!({ "prompt": PROMPT, "tool_ids": c.tool_ids.values().collect::<Vec<_>>() });
    if let Some(m) = &llm {
        prompt["llm"] = m.as_str().into();
    }
    let agent = serde_json::json!({
        "name": "Flow Command",
        "conversation_config": {
            "agent": {
                "first_message": "Hi, what do you need?",
                "language": "en",
                "prompt": prompt,
            },
            "tts": { "voice_id": voice_id, "model_id": TTS_MODEL },
        },
        // Lets the app start typed (text-only) sessions without the microphone.
        "platform_settings": { "overrides": { "conversation_config_override": { "conversation": { "text_only": true } } } },
    });
    let agent_id = match c.agent_id.clone() {
        Some(id) => match call(reqwest::Method::PATCH, &format!("/v1/convai/agents/{id}"), &k, Some(agent.clone())).await {
            Ok(_) => id,
            Err(e) if e.contains("404") => create_agent(&k, agent).await?,
            Err(e) => return Err(e),
        },
        None => create_agent(&k, agent).await?,
    };
    c.agent_id = Some(agent_id);
    c.voice_id = Some(voice_id);
    c.voice_name = voice_name;
    c.llm = llm;
    c.setup_version = SETUP_VERSION;
    save_config(&app, &c)?;
    Ok(c)
}

/// First FAST_LLMS entry that GET /v1/llm lists and doesn't mark deprecated.
fn pick_llm(list: &serde_json::Value) -> Option<String> {
    let models = list["models"].as_array()?;
    let available = |id: &str| models.iter().any(|m| m["model_id"] == id && !m["deprecated"].as_bool().unwrap_or(false));
    FAST_LLMS.iter().find(|id| available(id)).map(|s| s.to_string())
}

async fn create_agent(key: &str, agent: serde_json::Value) -> Result<String, String> {
    let r = call(reqwest::Method::POST, "/v1/convai/agents/create", key, Some(agent)).await?;
    r["agent_id"].as_str().map(String::from).ok_or_else(|| "ElevenLabs returned no agent id".to_string())
}

/// Short-lived WebRTC token for one conversation with the private agent.
#[tauri::command]
pub async fn voice_session_token(app: tauri::AppHandle) -> Result<String, String> {
    let k = require_key()?;
    let agent = load_config(&app).agent_id.ok_or("Set up the voice agent in Settings first.")?;
    let r = call(reqwest::Method::GET, &format!("/v1/convai/conversation/token?agent_id={agent}"), &k, None).await?;
    r["token"].as_str().map(String::from).ok_or_else(|| "ElevenLabs returned no conversation token".to_string())
}

/// Signed websocket URL for a typed (text-only) conversation — no microphone involved.
#[tauri::command]
pub async fn voice_text_session_url(app: tauri::AppHandle) -> Result<String, String> {
    let k = require_key()?;
    let agent = load_config(&app).agent_id.ok_or("Set up the voice agent in Settings first.")?;
    let r = call(reqwest::Method::GET, &format!("/v1/convai/conversation/get-signed-url?agent_id={agent}"), &k, None).await?;
    r["signed_url"].as_str().map(String::from).ok_or_else(|| "ElevenLabs returned no signed URL".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_fastest_available_llm() {
        let list = serde_json::json!({"models": [
            {"model_id": "gemini-2.5-flash", "deprecated": false},
            {"model_id": "gpt-4.1-nano", "deprecated": false},
            {"model_id": "gemini-2.5-flash-lite", "deprecated": true}]});
        assert_eq!(pick_llm(&list).as_deref(), Some("gpt-4.1-nano"));
        assert_eq!(pick_llm(&serde_json::json!({"models": []})), None);
    }

    #[test]
    fn tool_defs_are_well_formed() {
        let defs = tool_defs();
        assert_eq!(defs.len(), 14);
        for d in &defs {
            assert_eq!(d["type"], "client");
            assert!(d["expects_response"].as_bool().unwrap());
            // ElevenLabs rejects a parameter without a description (422 "Must set one of: description, …").
            for (p, v) in d["parameters"]["properties"].as_object().unwrap() {
                assert!(v["description"].as_str().is_some_and(|x| !x.is_empty()), "{}.{} has no description", d["name"], p);
            }
            for r in d["parameters"]["required"].as_array().unwrap() {
                assert!(d["parameters"]["properties"].get(r.as_str().unwrap()).is_some(), "{} requires an undefined param", d["name"]);
            }
        }
        let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"propose_inventory_adjustment") && names.contains(&"propose_order_update"));
        assert!(!names.iter().any(|n| n.starts_with("apply")), "the agent must never get an apply tool");
    }
}

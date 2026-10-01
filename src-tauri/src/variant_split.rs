//! Create-only variant splitting. Source IDs never enter a mutation. Plans pin the store
//! and source snapshot; a durable receipt protects retries, including ambiguous timeouts.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

const NS: &str = "flow_command";
const KEY: &str = "variant_split";
const PAGE: &str = "pageInfo { hasNextPage endCursor }";
const MARKER_SELECTION: &str = "id title status variants(first: 2) { nodes { id inventoryItem { id tracked } } } metafield(namespace: \"flow_command\", key: \"variant_split\") { value }";

#[derive(Clone)]
struct Plan {
    domain: String,
    store_id: String,
    product: Value,
    variants: Vec<Value>,
    locations: Vec<Value>,
    files: Vec<Value>,
    collections: Vec<Value>,
    metafields: Vec<Value>,
    warnings: Vec<String>,
}
fn plans() -> &'static Mutex<HashMap<String, Arc<Plan>>> {
    static PLANS: OnceLock<Mutex<HashMap<String, Arc<Plan>>>> = OnceLock::new();
    PLANS.get_or_init(Default::default)
}
fn write_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("Shopify did not return {key}"))
}
fn numeric_id<'a>(id: &'a str, kind: &str) -> Result<&'a str, String> {
    id.strip_prefix(&format!("gid://shopify/{kind}/"))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| format!("Invalid Shopify {kind} ID"))
}
fn fields(v: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for key in keys {
        if !v[key].is_null() {
            out[*key] = v[*key].clone();
        }
    }
    out
}
fn next_cursor(connection: &Value, previous: &Value) -> Result<Option<Value>, String> {
    match connection["pageInfo"]["hasNextPage"].as_bool() {
        Some(false) => Ok(None),
        Some(true) => {
            let next = connection["pageInfo"]["endCursor"].clone();
            if !next.is_string() || &next == previous {
                return Err(
                    "Shopify returned an invalid page cursor; nothing was truncated.".into(),
                );
            }
            Ok(Some(next))
        }
        None => Err("Shopify returned an incomplete page; nothing was truncated.".into()),
    }
}
// Only explicit throttling is retried. A transport failure on a mutation is ambiguous.
async fn request(domain: &str, query: &str, vars: Value) -> Result<Value, String> {
    #[cfg(test)]
    if let Ok(result) =
        tests::TRANSPORT.try_with(|transport| transport.borrow_mut().respond(domain, query, &vars))
    {
        return result;
    }
    for attempt in 0..5 {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(90),
            super::graphql_request(domain, query, Some(vars.clone())),
        )
        .await
        .map_err(|_| "Shopify request timed out. Retry to check the saved result.".to_string())?;
        match result {
            Err(ref e) if (e.contains("THROTTLED") || e.contains("429")) && attempt < 4 => {
                tokio::time::sleep(std::time::Duration::from_secs(2u64.pow(attempt + 1))).await;
            }
            other => return other,
        }
    }
    unreachable!()
}
// Separate connections keep requests below the query-cost limit, and page every list.
async fn connection(
    domain: &str,
    root: &str,
    root_args: Value,
    field: &str,
    selection: &str,
) -> Result<Vec<Value>, String> {
    let query = if root == "locations" {
        format!("query($after: String) {{ locations(first: 100, after: $after, includeInactive: true, includeLegacy: true) {{ nodes {{ {selection} }} {PAGE} }} }}")
    } else {
        format!("query($id: ID!, $after: String) {{ {root}(id: $id) {{ {field}(first: 50, after: $after) {{ nodes {{ {selection} }} {PAGE} }} }} }}")
    };
    let mut vars = root_args;
    vars["after"] = Value::Null;
    let mut all = Vec::new();
    loop {
        let r = request(domain, &query, vars.clone()).await?;
        let c = if root == "locations" {
            &r["data"][root]
        } else {
            &r["data"][root][field]
        };
        all.extend(
            c["nodes"]
                .as_array()
                .ok_or("Shopify returned no connection data")?
                .iter()
                .cloned(),
        );
        match next_cursor(c, &vars["after"])? {
            Some(next) => vars["after"] = next,
            None => return Ok(all),
        }
    }
}
async fn metafields(domain: &str, root: &str, id: &Value) -> Result<Vec<Value>, String> {
    connection(
        domain,
        root,
        json!({"id": id}),
        "metafields",
        "namespace key type value",
    )
    .await
}
fn output_title(product: &Value, variant: &Value) -> String {
    let title = product["title"].as_str().unwrap_or_default();
    match variant["title"].as_str() {
        Some("Default Title") | None | Some("") => title.to_string(),
        Some(v) => format!("{title} — {v}"),
    }
}

#[tauri::command]
pub async fn prepare_variant_split(store_id: String, product_id: String) -> Result<Value, String> {
    numeric_id(&product_id, "Product")?;
    let store = super::store_by_id(&store_id)?;
    let r = request(
        &store.domain,
        r#"query($id: ID!) {
      shop { currencyCode }
      currentAppInstallation { accessScopes { handle } }
      product(id: $id) { id title handle descriptionHtml vendor productType tags templateSuffix
        status isGiftCard requiresSellingPlan seo { title description } category { id }
        sellingPlanGroups(first: 1) { nodes { id } }
      }
    }"#,
        json!({"id": product_id}),
    )
    .await?;
    let product = r["data"]["product"].clone();
    if product.is_null() {
        return Err("This product no longer exists in the selected store.".into());
    }
    if product["isGiftCard"] == true {
        return Err("Gift cards cannot be split into ordinary inventory products.".into());
    }
    let scopes: HashSet<&str> = r["data"]["currentAppInstallation"]["accessScopes"]
        .as_array()
        .ok_or("Could not check Shopify permissions")?
        .iter()
        .filter_map(|v| v["handle"].as_str())
        .collect();
    let missing: Vec<_> = [
        "write_products",
        "read_inventory",
        "write_inventory",
        "read_locations",
        "write_files",
    ]
    .into_iter()
    .filter(|s| {
        !scopes.contains(s) && !(*s == "read_inventory" && scopes.contains("write_inventory"))
    })
    .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Enable these Shopify app permissions for {}: {}. Then reopen the preview.",
            store.label,
            missing.join(", ")
        ));
    }
    let variants = connection(&store.domain, "product", json!({"id": product_id}), "variants", r#"
      id title price compareAtPrice sku barcode taxable taxCode inventoryPolicy requiresComponents showUnitPrice
      selectedOptions { name value }
      unitPriceMeasurement { quantityUnit quantityValue referenceUnit referenceValue }
      media(first: 1) { nodes { id } }
      inventoryItem { id tracked requiresShipping countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode
        unitCost { amount } measurement { weight { unit value } }
      }
    "#).await?;
    if variants.is_empty() {
        return Err("This product has no variants to split.".into());
    }
    if variants.iter().any(|v| v["requiresComponents"] == true) {
        return Err(
            "Bundle variants need their component relationships and cannot be split by this tool."
                .into(),
        );
    }
    let locations = connection(
        &store.domain,
        "locations",
        json!({}),
        "",
        "id name isActive",
    )
    .await?;
    let locations: Vec<_> = locations
        .into_iter()
        .filter(|l| l["isActive"] == true)
        .collect();
    if locations.is_empty() {
        return Err("No active Shopify location is available for zero-stock drafts.".into());
    }
    if locations.len() > 250 {
        return Err(
            "This store exceeds Shopify's 250-location input limit. No products were created."
                .into(),
        );
    }
    let files = connection(
        &store.domain,
        "product",
        json!({"id": product_id}),
        "media",
        "id status mediaContentType preview { image { url } }",
    )
    .await?;
    if files.len() > 250 {
        return Err(
            "This product exceeds Shopify's 250-file input limit. No products were created.".into(),
        );
    }
    if files.iter().any(|f| f["status"] != "READY") {
        return Err(
            "Wait for all source photos and media to finish processing in Shopify, then retry."
                .into(),
        );
    }
    let collections = connection(
        &store.domain,
        "product",
        json!({"id": product_id}),
        "collections",
        "id ruleSet { appliedDisjunctively }",
    )
    .await?;
    let collections: Vec<_> = collections
        .into_iter()
        .filter(|c| c["ruleSet"].is_null())
        .map(|c| c["id"].clone())
        .collect();
    if collections.len() > 250 {
        return Err(
            "This product exceeds Shopify's 250-collection input limit. No products were created."
                .into(),
        );
    }
    let meta = metafields(&store.domain, "product", &product["id"]).await?;
    let mut warnings = Vec::new();
    if !r["data"]["product"]["sellingPlanGroups"]["nodes"]
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        warnings.push(
            "Selling plan memberships are not copied; reconnect subscriptions before publishing."
                .into(),
        );
    }
    if variants
        .iter()
        .any(|v| v["inventoryItem"]["tracked"] != true)
    {
        warnings.push(
            "Inventory tracking will be enabled on every copy so stock can be set to 0.".into(),
        );
    }
    let currency = &r["data"]["shop"]["currencyCode"];
    let rows: Vec<_> = variants.iter().map(|v| {
        let media_id = &v["media"]["nodes"][0]["id"];
        let image = files.iter().find(|f| &f["id"] == media_id).or_else(|| files.first());
        json!({"id": v["id"], "title": output_title(&product, v), "variantTitle": v["title"],
            "sku": v["sku"], "price": v["price"], "compareAtPrice": v["compareAtPrice"], "currency": currency,
            "imageUrl": image.map(|f| &f["preview"]["image"]["url"])})
    }).collect();
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let plan_id = format!(
        "{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let preview = json!({"planId": plan_id, "storeId": store_id, "productTitle": product["title"], "variants": rows,
        "locations": locations.iter().map(|l| l["name"].clone()).collect::<Vec<_>>(), "warnings": warnings});
    let plan = Plan {
        domain: store.domain,
        store_id,
        product,
        variants,
        locations,
        files,
        collections,
        metafields: meta,
        warnings,
    };
    let mut cache = plans()
        .lock()
        .map_err(|_| "Split preview cache unavailable")?;
    // Explicit release from the dialog normally keeps this empty; don't evict an active run.
    if cache.len() >= 32 {
        return Err(
            "Too many open split previews. Close a preview or restart Flow Command.".into(),
        );
    }
    cache.insert(plan_id, Arc::new(plan));
    Ok(preview)
}
#[tauri::command]
pub fn release_variant_split(plan_id: String) {
    if let Ok(mut cache) = plans().lock() {
        cache.remove(&plan_id);
    }
}

fn marker(variant: &Value, complete: bool, warnings: &[String]) -> Value {
    json!({"namespace": NS, "key": KEY, "type": "json", "value":
        json!({"sourceVariantId": variant["id"], "complete": complete, "warnings": warnings}).to_string()})
}
fn create_input(plan: &Plan, variant: &Value, country_codes: Vec<Value>) -> Result<Value, String> {
    let suffix = numeric_id(string(variant, "id")?, "ProductVariant")?;
    let mut input = fields(
        &plan.product,
        &[
            "descriptionHtml",
            "vendor",
            "productType",
            "tags",
            "templateSuffix",
            "requiresSellingPlan",
            "seo",
        ],
    );
    input["title"] = json!(output_title(&plan.product, variant));
    input["handle"] = json!(format!("flow-split-{suffix}"));
    input["status"] = json!("DRAFT");
    if let Some(id) = plan.product["category"]["id"].as_str() {
        input["category"] = json!(id);
    }
    input["collections"] = json!(plan.collections);
    input["metafields"] = json!([marker(variant, false, &[])]);
    let options = variant["selectedOptions"]
        .as_array()
        .ok_or("Variant options are missing")?;
    if options.is_empty() {
        return Err("Variant options are missing".into());
    }
    input["productOptions"] = json!(options
        .iter()
        .enumerate()
        .map(|(i, o)| json!({
            "name": o["name"], "position": i + 1, "values": [{"name": o["value"]}]
        }))
        .collect::<Vec<_>>());
    let mut v = fields(
        variant,
        &[
            "sku",
            "price",
            "compareAtPrice",
            "barcode",
            "taxable",
            "taxCode",
            "inventoryPolicy",
            "showUnitPrice",
            "unitPriceMeasurement",
        ],
    );
    v["optionValues"] = json!(options
        .iter()
        .map(|o| json!({"optionName": o["name"], "name": o["value"]}))
        .collect::<Vec<_>>());
    let mut inventory = fields(
        &variant["inventoryItem"],
        &[
            "requiresShipping",
            "countryCodeOfOrigin",
            "provinceCodeOfOrigin",
            "harmonizedSystemCode",
            "measurement",
        ],
    );
    inventory["tracked"] = json!(true);
    if !variant["inventoryItem"]["unitCost"]["amount"].is_null() {
        inventory["cost"] = variant["inventoryItem"]["unitCost"]["amount"].clone();
    }
    inventory["countryHarmonizedSystemCodes"] = json!(country_codes);
    v["inventoryItem"] = inventory;
    v["inventoryQuantities"] = json!(plan
        .locations
        .iter()
        .map(|l| json!({"locationId": l["id"], "name": "on_hand", "quantity": 0}))
        .collect::<Vec<_>>());
    let featured = &variant["media"]["nodes"][0]["id"];
    let mut files: Vec<_> = plan.files.iter().map(|f| json!({"id": f["id"]})).collect();
    // Make this variant's photo the product's featured photo; retain the whole gallery.
    if let Some(i) = files.iter().position(|f| &f["id"] == featured) {
        let file = files.remove(i);
        v["file"] = file.clone();
        files.insert(0, file);
    }
    input["files"] = json!(files);
    input["variants"] = json!([v]);
    Ok(input)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    product_id: Option<String>,
    pending: bool,
    #[serde(default)]
    create_error: Option<String>,
}
fn save_receipt(path: &std::path::Path, receipt: &Receipt) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("Invalid receipt path")?)
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(receipt).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}
fn read_receipt(path: &std::path::Path) -> Result<Receipt, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Cannot read saved split receipt: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Receipt::default()),
        Err(e) => Err(format!("Cannot read saved split receipt: {e}")),
    }
}
fn check_marker(product: &Value, variant_id: &str) -> Result<Value, String> {
    let marker: Value =
        serde_json::from_str(product["metafield"]["value"].as_str().unwrap_or("null"))
            .map_err(|_| "Split provenance is invalid")?;
    if marker["sourceVariantId"] != variant_id {
        return Err(
            "The destination handle belongs to another product. It was not changed.".into(),
        );
    }
    Ok(marker)
}
const SET_META: &str = "mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message code } } }";
fn check_errors(errors: &Value, label: &str) -> Result<(), String> {
    if !errors.is_array() {
        return Err(format!("{label}: Shopify returned an incomplete response"));
    }
    super::check_user_errors(errors, label)
}
async fn copy_metafields(
    domain: &str,
    owner: &str,
    source: &[Value],
    label: &str,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let values: Vec<_> = source
        .iter()
        .filter(|m| !(m["namespace"] == NS && m["key"] == KEY))
        .map(|m| {
            let mut m = fields(m, &["namespace", "key", "type", "value"]);
            m["ownerId"] = json!(owner);
            m
        })
        .collect();
    for batch in values.chunks(25) {
        let r = request(domain, SET_META, json!({"metafields": batch})).await?;
        if check_errors(&r["data"]["metafieldsSet"]["userErrors"], "Metafields").is_ok() {
            continue;
        }
        // metafieldsSet is atomic: retry individually to preserve every writable field.
        for m in batch {
            let r = request(domain, SET_META, json!({"metafields": [m]})).await?;
            if let Err(e) = check_errors(&r["data"]["metafieldsSet"]["userErrors"], "Metafield") {
                warnings.push(format!(
                    "{label} {}.{}: {e}",
                    m["namespace"].as_str().unwrap_or(""),
                    m["key"].as_str().unwrap_or("")
                ));
            }
        }
    }
    Ok(())
}
fn verify_level(level: &Value) -> Result<(), String> {
    let quantities = level["quantities"]
        .as_array()
        .ok_or("Missing inventory quantities")?;
    if quantities.len() != 3 || quantities.iter().any(|q| q["quantity"].as_i64() != Some(0)) {
        return Err(format!(
            "Stock is not zero at {}. The draft needs review in Shopify.",
            level["location"]["name"].as_str().unwrap_or("a location")
        ));
    }
    Ok(())
}
async fn verify_draft(domain: &str, id: &str, locations: &[Value]) -> Result<(), String> {
    let q = format!("query($id: ID!) {{ product(id: $id) {{ {MARKER_SELECTION} }} }}");
    let r = request(domain, &q, json!({"id": id})).await?;
    let p = &r["data"]["product"];
    let variants = p["variants"]["nodes"]
        .as_array()
        .ok_or("Created product could not be verified")?;
    if p["status"] != "DRAFT"
        || variants.len() != 1
        || variants[0]["inventoryItem"]["tracked"] != true
    {
        return Err("The created product is no longer a tracked, single-variant draft. Review it in Shopify.".into());
    }
    let levels = connection(domain, "inventoryItem", json!({"id": variants[0]["inventoryItem"]["id"]}), "inventoryLevels",
        "location { id name } quantities(names: [\"available\", \"on_hand\", \"committed\"]) { name quantity }").await?;
    for level in &levels {
        verify_level(level)?;
    }
    if locations
        .iter()
        .any(|l| !levels.iter().any(|v| v["location"]["id"] == l["id"]))
    {
        return Err(
            "Not every location has a verified zero-stock level. Review the draft in Shopify."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn split_product_variant(
    app: tauri::AppHandle,
    plan_id: String,
    variant_id: String,
) -> Result<Value, String> {
    let plan = plans()
        .lock()
        .map_err(|_| "Split preview cache unavailable")?
        .get(&plan_id)
        .cloned()
        .ok_or("Preview expired. Reopen Split variants to continue.")?;
    let variant = plan
        .variants
        .iter()
        .find(|v| v["id"] == variant_id)
        .ok_or("Variant is not part of this preview")?;
    let suffix = numeric_id(&variant_id, "ProductVariant")?;
    let _guard = write_lock().lock().await;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("variant-splits")
        .join(format!("{}-{suffix}.json", plan.store_id));
    split_variant(&plan, variant, &path).await
}

async fn split_variant(
    plan: &Plan,
    variant: &Value,
    path: &std::path::Path,
) -> Result<Value, String> {
    let variant_id = string(variant, "id")?;
    let suffix = numeric_id(variant_id, "ProductVariant")?;
    let mut receipt = read_receipt(path)?;
    if let Some(e) = receipt.create_error {
        return Err(format!("The draft needs review after a partial creation error: {e}. No second product was created."));
    }
    let handle = format!("flow-split-{suffix}");
    let (q, vars, key) = if let Some(id) = &receipt.product_id {
        (
            format!("query($id: ID!) {{ product(id: $id) {{ {MARKER_SELECTION} }} }}"),
            json!({"id": id}),
            "product",
        )
    } else {
        (format!("query($handle: String!) {{ productByIdentifier(identifier: {{handle: $handle}}) {{ {MARKER_SELECTION} }} }}"), json!({"handle": handle}), "productByIdentifier")
    };
    let r = request(&plan.domain, &q, vars).await?;
    let mut product = r["data"]
        .get(key)
        .ok_or("Shopify returned an incomplete product lookup")?
        .clone();
    let existed = !product.is_null();
    if existed {
        let m = check_marker(&product, &variant_id)?;
        if product["id"] == plan.product["id"] {
            return Err("Refusing to modify the source product.".into());
        }
        if m["complete"] == true {
            receipt.product_id = Some(string(&product, "id")?.to_string());
            receipt.pending = false;
            save_receipt(path, &receipt)?;
            return Ok(
                json!({"productId": product["id"], "title": product["title"], "existing": true, "warnings": m["warnings"], "status": product["status"]}),
            );
        }
        // Never resume data writes on something the merchant has since published or expanded.
        verify_draft(&plan.domain, string(&product, "id")?, &plan.locations).await?;
    } else {
        if receipt.product_id.is_some() {
            return Err(
                "The previously created product was deleted. No replacement was created.".into(),
            );
        }
        if receipt.pending {
            return Err(format!("An earlier create request has an unknown outcome. No duplicate was created. Wait and retry to look up '{handle}'; if it remains missing, review the saved split receipt before starting again."));
        }
    }
    // Read all remaining source fields before the first write for this variant.
    let source_meta = metafields(&plan.domain, "productVariant", &variant["id"]).await?;
    let codes = connection(
        &plan.domain,
        "inventoryItem",
        json!({"id": variant["inventoryItem"]["id"]}),
        "countryHarmonizedSystemCodes",
        "countryCode harmonizedSystemCode",
    )
    .await?;
    if codes.len() > 250 {
        return Err("Too many country-specific customs codes to copy safely.".into());
    }
    if !existed {
        let input = create_input(&plan, variant, codes)?;
        receipt.pending = true;
        save_receipt(path, &receipt)?;
        let r = request(&plan.domain, "mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) { product { id title status variants(first: 2) { nodes { id } } } userErrors { field message code } } }", json!({"input": input})).await?;
        let result = &r["data"]["productSet"];
        // Store any returned destination ID even when Shopify reports partial errors.
        if let Some(id) = result["product"]["id"].as_str() {
            receipt.product_id = Some(id.into());
            save_receipt(path, &receipt)?;
        }
        if let Err(e) = check_errors(&result["userErrors"], "Create draft") {
            if result["userErrors"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
            {
                if receipt.product_id.is_some() {
                    receipt.create_error = Some(e.clone());
                } else {
                    receipt.pending = false;
                }
                save_receipt(path, &receipt)?;
            }
            return Err(e);
        }
        product = result["product"].clone();
    }
    let id = string(&product, "id")?;
    receipt.product_id = Some(id.to_string());
    save_receipt(path, &receipt)?;
    let variant_nodes = product["variants"]["nodes"]
        .as_array()
        .ok_or("The draft has no returned variants")?;
    if variant_nodes.len() != 1 {
        return Err(format!(
            "Draft {id} needs review: expected exactly one variant."
        ));
    }
    let dest_variant = string(&variant_nodes[0], "id")?;
    let mut warnings = plan.warnings.clone();
    copy_metafields(&plan.domain, id, &plan.metafields, "Product", &mut warnings).await?;
    copy_metafields(
        &plan.domain,
        dest_variant,
        &source_meta,
        "Variant",
        &mut warnings,
    )
    .await?;
    verify_draft(&plan.domain, id, &plan.locations).await?;
    let mut m = marker(variant, true, &warnings);
    m["ownerId"] = json!(id);
    let r = request(&plan.domain, SET_META, json!({"metafields": [m]})).await?;
    check_errors(
        &r["data"]["metafieldsSet"]["userErrors"],
        "Save split result",
    )?;
    receipt.pending = false;
    save_receipt(path, &receipt)?;
    Ok(
        json!({"productId": id, "title": product["title"], "existing": existed, "warnings": warnings, "status": "DRAFT"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    tokio::task_local! { pub static TRANSPORT: RefCell<Transport>; }
    pub struct Transport {
        responses: VecDeque<Result<Value, String>>,
        pub calls: Vec<(String, Value)>,
    }
    impl Transport {
        pub fn respond(
            &mut self,
            domain: &str,
            query: &str,
            vars: &Value,
        ) -> Result<Value, String> {
            assert_eq!(domain, "pinned-store.myshopify.com");
            self.calls.push((query.into(), vars.clone()));
            self.responses
                .pop_front()
                .expect("Unexpected Shopify request")
        }
    }
    async fn mocked<T>(
        responses: Vec<Result<Value, String>>,
        f: impl std::future::Future<Output = T>,
    ) -> (T, Vec<(String, Value)>) {
        TRANSPORT
            .scope(
                RefCell::new(Transport {
                    responses: responses.into(),
                    calls: vec![],
                }),
                async {
                    let result = f.await;
                    TRANSPORT.with(|t| {
                        let t = t.borrow();
                        assert!(
                            t.responses.is_empty(),
                            "Not all Shopify responses were consumed"
                        );
                        (result, t.calls.clone())
                    })
                },
            )
            .await
    }
    fn plan() -> Plan {
        Plan {
            domain: "pinned-store.myshopify.com".into(),
            store_id: "retail".into(),
            product: json!({"id":"gid://shopify/Product/10","title":"Flower","status":"ACTIVE","handle":"original",
                "descriptionHtml":"<p>Full description</p>","tags":["tag"],"vendor":"Flow","productType":"Flower","templateSuffix":"custom",
                "requiresSellingPlan":false,"category":{"id":"gid://shopify/TaxonomyCategory/aa"},"seo":{"title":"SEO title","description":"SEO description"}}),
            variants: vec![
                json!({"id":"gid://shopify/ProductVariant/20","title":"7g / Green","sku":"SKU-Exact","barcode":"00123","price":"42.90","compareAtPrice":"50.00",
                "taxable":true,"taxCode":"P000","inventoryPolicy":"CONTINUE","showUnitPrice":true,
                "selectedOptions":[{"name":"Size","value":"7g"},{"name":"Color","value":"Green"}],
                "unitPriceMeasurement":{"quantityUnit":"G","quantityValue":7,"referenceUnit":"G","referenceValue":1},
                "media":{"nodes":[{"id":"gid://shopify/MediaImage/32"}]},
                "inventoryQuantity":900,"inventoryItem":{"id":"gid://shopify/InventoryItem/40","tracked":false,"requiresShipping":true,
                "countryCodeOfOrigin":"US","provinceCodeOfOrigin":"TN","harmonizedSystemCode":"123456","unitCost":{"amount":"11.12"},"measurement":{"weight":{"unit":"GRAMS","value":7}}}}),
            ],
            locations: vec![
                json!({"id":"gid://shopify/Location/1","name":"Warehouse"}),
                json!({"id":"gid://shopify/Location/2","name":"Retail"}),
            ],
            files: vec![
                json!({"id":"gid://shopify/MediaImage/31"}),
                json!({"id":"gid://shopify/MediaImage/32"}),
            ],
            collections: vec![json!("gid://shopify/Collection/50")],
            metafields: vec![
                json!({"namespace":"custom","key":"coa","type":"file_reference","value":"gid://shopify/GenericFile/90"}),
            ],
            warnings: vec![],
        }
    }
    fn receipt_path(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("flow-split-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("receipt.json")
    }
    fn product(complete: bool) -> Value {
        json!({"id":"gid://shopify/Product/100","title":"Flower — 7g / Green","status":"DRAFT",
            "variants":{"nodes":[{"id":"gid://shopify/ProductVariant/200","inventoryItem":{"id":"gid://shopify/InventoryItem/400","tracked":true}}]},
            "metafield":{"value":json!({"sourceVariantId":"gid://shopify/ProductVariant/20","complete":complete,"warnings":[]}).to_string()}})
    }
    fn page(nodes: Value) -> Value {
        json!({"nodes": nodes,"pageInfo":{"hasNextPage":false,"endCursor":null}})
    }
    fn variant_meta() -> Value {
        json!({"data":{"productVariant":{"metafields":page(json!([{"namespace":"custom","key":"batch","type":"single_line_text_field","value":"Batch 7"}]))}}})
    }
    fn codes() -> Value {
        json!({"data":{"inventoryItem":{"countryHarmonizedSystemCodes":page(json!([]))}}})
    }
    fn created() -> Value {
        json!({"data":{"productSet":{"product":product(false),"userErrors":[]}}})
    }
    fn meta_ok() -> Value {
        json!({"data":{"metafieldsSet":{"userErrors":[]}}})
    }
    fn levels() -> Value {
        json!({"data":{"inventoryItem":{"inventoryLevels":page(json!([1,2].iter().map(|id| json!({"location":{"id":format!("gid://shopify/Location/{id}"),"name":"Stockroom"},
            "quantities":[{"name":"available","quantity":0},{"name":"on_hand","quantity":0},{"name":"committed","quantity":0}]})).collect::<Vec<_>>()))}}})
    }
    #[test]
    fn copy_is_one_draft_with_zero_stock_and_no_source_ids() {
        let p = plan();
        let input = create_input(
            &p,
            &p.variants[0],
            vec![json!({"countryCode":"CA","harmonizedSystemCode":"123456"})],
        )
        .unwrap();
        assert_eq!(input["status"], "DRAFT");
        assert_eq!(input["title"], "Flower — 7g / Green");
        assert_eq!(input["variants"].as_array().unwrap().len(), 1);
        let v = &input["variants"][0];
        for key in [
            "price",
            "compareAtPrice",
            "sku",
            "barcode",
            "taxable",
            "taxCode",
            "inventoryPolicy",
            "showUnitPrice",
            "unitPriceMeasurement",
        ] {
            assert_eq!(v[key], p.variants[0][key]);
        }
        for key in [
            "descriptionHtml",
            "tags",
            "vendor",
            "productType",
            "seo",
            "templateSuffix",
        ] {
            assert_eq!(input[key], p.product[key]);
        }
        assert_eq!(v["inventoryItem"]["cost"], "11.12");
        assert_eq!(v["inventoryItem"]["tracked"], true);
        assert_eq!(
            v["inventoryItem"]["measurement"],
            p.variants[0]["inventoryItem"]["measurement"]
        );
        assert_eq!(v["inventoryQuantities"].as_array().unwrap().len(), 2);
        assert!(v["inventoryQuantities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|q| q["quantity"] == 0 && q["name"] == "on_hand"));
        assert!(
            input.get("id").is_none()
                && v.get("id").is_none()
                && v["inventoryItem"].get("id").is_none()
        );
        assert!(v.get("inventoryQuantity").is_none());
        assert_eq!(input["files"][0]["id"], "gid://shopify/MediaImage/32");
        assert_eq!(v["file"], input["files"][0]);
        assert_eq!(input["files"].as_array().unwrap().len(), 2);
        assert_eq!(input["productOptions"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn default_variant_and_null_fields_are_valid() {
        let mut p = plan();
        p.variants[0]["title"] = json!("Default Title");
        p.variants[0]["compareAtPrice"] = Value::Null;
        p.variants[0]["sku"] = Value::Null;
        p.variants[0]["selectedOptions"] = json!([{"name":"Title","value":"Default Title"}]);
        p.variants[0]["media"] = json!({"nodes":[]});
        p.files.clear();
        let input = create_input(&p, &p.variants[0], vec![]).unwrap();
        assert_eq!(input["title"], "Flower");
        assert!(input["variants"][0].get("compareAtPrice").is_none());
        assert!(input["variants"][0].get("file").is_none());
        assert_eq!(
            input["variants"][0]["optionValues"][0]["name"],
            "Default Title"
        );
    }
    #[test]
    fn rejects_wrong_ids_markers_and_incomplete_responses() {
        assert!(numeric_id("gid://shopify/Product/20", "ProductVariant").is_err());
        assert!(numeric_id("gid://shopify/ProductVariant/../20", "ProductVariant").is_err());
        assert!(check_marker(&product(true), "gid://shopify/ProductVariant/999").is_err());
        assert!(check_errors(&Value::Null, "Create").is_err());
        assert!(next_cursor(&json!({}), &Value::Null).is_err());
        assert!(next_cursor(
            &json!({"pageInfo":{"hasNextPage":true,"endCursor":"same"}}),
            &json!("same")
        )
        .is_err());
    }
    #[tokio::test]
    async fn pages_connections_past_first_page() {
        let responses = vec![
            Ok(
                json!({"data":{"product":{"metafields":{"nodes":[{"key":"one"}],"pageInfo":{"hasNextPage":true,"endCursor":"p2"}}}}}),
            ),
            Ok(json!({"data":{"product":{"metafields":page(json!([{"key":"two"}]))}}})),
        ];
        let (r, calls) = mocked(
            responses,
            metafields(
                "pinned-store.myshopify.com",
                "product",
                &json!("gid://shopify/Product/10"),
            ),
        )
        .await;
        assert_eq!(r.unwrap().len(), 2);
        assert_eq!(calls[1].1["after"], "p2");
    }
    #[tokio::test]
    async fn creates_copies_metafields_and_verifies_all_locations() {
        let p = plan();
        let path = receipt_path("complete");
        let responses = vec![
            Ok(json!({"data":{"productByIdentifier":null}})),
            Ok(variant_meta()),
            Ok(codes()),
            Ok(created()),
            Ok(meta_ok()),
            Ok(meta_ok()),
            Ok(json!({"data":{"product":product(false)}})),
            Ok(levels()),
            Ok(meta_ok()),
        ];
        let (r, calls) = mocked(responses, split_variant(&p, &p.variants[0], &path)).await;
        assert_eq!(r.unwrap()["status"], "DRAFT");
        assert_eq!(calls[3].1["input"]["status"], "DRAFT");
        assert_eq!(
            calls[4].1["metafields"][0]["ownerId"],
            "gid://shopify/Product/100"
        );
        assert_eq!(
            calls[4].1["metafields"][0]["value"],
            "gid://shopify/GenericFile/90"
        );
        assert_eq!(
            calls[5].1["metafields"][0]["ownerId"],
            "gid://shopify/ProductVariant/200"
        );
        assert_eq!(calls[5].1["metafields"][0]["value"], "Batch 7");
        assert!(!read_receipt(&path).unwrap().pending);
        let (again, calls) = mocked(
            vec![Ok(json!({"data":{"product":product(true)}}))],
            split_variant(&p, &p.variants[0], &path),
        )
        .await;
        assert_eq!(again.unwrap()["existing"], true);
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].0.contains("mutation"));
    }
    #[tokio::test]
    async fn timeout_receipt_prevents_second_create() {
        let p = plan();
        let path = receipt_path("timeout");
        let responses = vec![
            Ok(json!({"data":{"productByIdentifier":null}})),
            Ok(variant_meta()),
            Ok(codes()),
            Err("Network timeout".into()),
        ];
        let (r, _) = mocked(responses, split_variant(&p, &p.variants[0], &path)).await;
        assert!(r.is_err());
        assert!(read_receipt(&path).unwrap().pending);
        let (r, calls) = mocked(
            vec![Ok(json!({"data":{"productByIdentifier":null}}))],
            split_variant(&p, &p.variants[0], &path),
        )
        .await;
        assert!(r.unwrap_err().contains("unknown outcome"));
        assert_eq!(calls.len(), 1);
        // A late Shopify response is recovered by handle without another create.
        let (r, _) = mocked(
            vec![Ok(json!({"data":{"productByIdentifier":product(true)}}))],
            split_variant(&p, &p.variants[0], &path),
        )
        .await;
        assert_eq!(r.unwrap()["existing"], true);
    }
    #[tokio::test]
    async fn conflicting_handle_is_never_changed() {
        let p = plan();
        let path = receipt_path("conflict");
        let mut existing = product(true);
        existing["metafield"] = Value::Null;
        let (r, calls) = mocked(
            vec![Ok(json!({"data":{"productByIdentifier":existing}}))],
            split_variant(&p, &p.variants[0], &path),
        )
        .await;
        assert!(r.unwrap_err().contains("another product"));
        assert_eq!(calls.len(), 1);
    }
    #[tokio::test]
    async fn refused_metafield_is_reported_and_other_fields_copy() {
        let fields = vec![
            json!({"namespace":"custom","key":"good","type":"single_line_text_field","value":"same"}),
            json!({"namespace":"app_private","key":"locked","type":"single_line_text_field","value":"private"}),
        ];
        let rejected =
            json!({"data":{"metafieldsSet":{"userErrors":[{"message":"Field is read-only"}]}}});
        let mut warnings = vec![];
        let (r, calls) = mocked(
            vec![Ok(rejected.clone()), Ok(meta_ok()), Ok(rejected)],
            copy_metafields(
                "pinned-store.myshopify.com",
                "new-owner",
                &fields,
                "Product",
                &mut warnings,
            ),
        )
        .await;
        r.unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("app_private.locked"));
    }
    #[tokio::test]
    async fn positive_stock_cannot_be_reported_as_success() {
        let p = plan();
        let mut stock = levels();
        stock["data"]["inventoryItem"]["inventoryLevels"]["nodes"][0]["quantities"][0]
            ["quantity"] = json!(4);
        let (r, _) = mocked(
            vec![Ok(json!({"data":{"product":product(false)}})), Ok(stock)],
            verify_draft(&p.domain, "new-product", &p.locations),
        )
        .await;
        assert!(r.unwrap_err().contains("not zero"));
    }
    #[tokio::test]
    async fn missing_location_cannot_be_reported_as_success() {
        let p = plan();
        let mut stock = levels();
        stock["data"]["inventoryItem"]["inventoryLevels"]["nodes"]
            .as_array_mut()
            .unwrap()
            .pop();
        let (r, _) = mocked(
            vec![Ok(json!({"data":{"product":product(false)}})), Ok(stock)],
            verify_draft(&p.domain, "new-product", &p.locations),
        )
        .await;
        assert!(r.unwrap_err().contains("every location"));
    }
    #[tokio::test]
    async fn interrupted_metafield_copy_resumes_without_recreating() {
        let p = plan();
        let path = receipt_path("resume");
        save_receipt(
            &path,
            &Receipt {
                product_id: Some("gid://shopify/Product/100".into()),
                pending: true,
                create_error: None,
            },
        )
        .unwrap();
        let responses = vec![
            Ok(json!({"data":{"product":product(false)}})),
            Ok(json!({"data":{"product":product(false)}})),
            Ok(levels()),
            Ok(variant_meta()),
            Ok(codes()),
            Ok(meta_ok()),
            Ok(meta_ok()),
            Ok(json!({"data":{"product":product(false)}})),
            Ok(levels()),
            Ok(meta_ok()),
        ];
        let (r, calls) = mocked(responses, split_variant(&p, &p.variants[0], &path)).await;
        assert_eq!(r.unwrap()["existing"], true);
        assert!(calls.iter().all(|(q, _)| !q.contains("productSet(")));
        assert!(!read_receipt(&path).unwrap().pending);
    }
    #[tokio::test]
    async fn partial_creation_error_cannot_be_silently_finished() {
        let p = plan();
        let path = receipt_path("partial-create");
        let mut partial = created();
        partial["data"]["productSet"]["userErrors"] =
            json!([{"message":"Media association failed"}]);
        let responses = vec![
            Ok(json!({"data":{"productByIdentifier":null}})),
            Ok(variant_meta()),
            Ok(codes()),
            Ok(partial),
        ];
        let (r, _) = mocked(responses, split_variant(&p, &p.variants[0], &path)).await;
        assert!(r.unwrap_err().contains("Media association failed"));
        let (r, calls) = mocked(vec![], split_variant(&p, &p.variants[0], &path)).await;
        assert!(r.unwrap_err().contains("partial creation error"));
        assert!(calls.is_empty());
    }
    #[tokio::test]
    async fn deleted_copy_is_not_recreated() {
        let p = plan();
        let path = receipt_path("deleted");
        save_receipt(
            &path,
            &Receipt {
                product_id: Some("gid://shopify/Product/100".into()),
                pending: false,
                create_error: None,
            },
        )
        .unwrap();
        let (r, calls) = mocked(
            vec![Ok(json!({"data":{"product":null}}))],
            split_variant(&p, &p.variants[0], &path),
        )
        .await;
        assert!(r.unwrap_err().contains("deleted"));
        assert_eq!(calls.len(), 1);
    }
    #[tokio::test]
    async fn incomplete_lookup_does_not_create_a_product() {
        let p = plan();
        let path = receipt_path("missing-response");
        let (r, calls) = mocked(
            vec![Ok(json!({"data":{}}))],
            split_variant(&p, &p.variants[0], &path),
        )
        .await;
        assert!(r.unwrap_err().contains("incomplete product lookup"));
        assert_eq!(calls.len(), 1);
        assert!(!path.exists());
    }
}

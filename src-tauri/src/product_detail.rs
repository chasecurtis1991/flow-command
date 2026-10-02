//! One product for the Catalog detail panel, plus the same product in the other two stores so prices can be compared
//! side by side. The other stores are matched by handle, then by exact title (the same heuristic as "Visible in"),
//! because the stores don't share product ids.

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    pub title: String,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    /// "24.00" in the store's currency.
    pub price: String,
    pub compare_at_price: Option<String>,
    pub inventory: i64,
    pub tracked: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProductDetail {
    pub id: String,
    pub title: String,
    pub handle: String,
    pub status: String,
    pub vendor: Option<String>,
    pub product_type: Option<String>,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub online_store_url: Option<String>,
    pub images: Vec<String>,
    pub variants: Vec<Variant>,
}

/// The same product in another store.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreCopy {
    pub store_id: String,
    /// "found" | "missing" | "error"
    pub state: String,
    pub product_id: Option<String>,
    pub status: Option<String>,
    /// How it was matched: "handle" | "title".
    pub matched_by: Option<String>,
    pub variants: Vec<Variant>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProductWithCopies {
    pub product: ProductDetail,
    pub copies: Vec<StoreCopy>,
}

const PRODUCT: &str = "query P($id: ID!) { product(id: $id) { id title handle status vendor productType tags description createdAt updatedAt onlineStoreUrl media(first: 6) { nodes { preview { image { url(transform: {maxWidth: 480, maxHeight: 480}) } } } } variants(first: 100) { nodes { id title sku barcode price compareAtPrice inventoryQuantity inventoryItem { tracked } } } } }";
const FIND: &str = "query F($q: String!) { products(first: 1, query: $q) { nodes { id title handle status variants(first: 100) { nodes { id title sku barcode price compareAtPrice inventoryQuantity inventoryItem { tracked } } } } } }";

fn s(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from)
}

fn variants(v: &serde_json::Value) -> Vec<Variant> {
    v["variants"]["nodes"]
        .as_array()
        .map(|vs| {
            vs.iter()
                .filter_map(|n| {
                    Some(Variant {
                        id: s(&n["id"])?,
                        title: s(&n["title"]).unwrap_or_else(|| "Default Title".into()),
                        sku: s(&n["sku"]),
                        barcode: s(&n["barcode"]),
                        price: s(&n["price"])?,
                        compare_at_price: s(&n["compareAtPrice"]),
                        inventory: n["inventoryQuantity"].as_i64().unwrap_or(0),
                        tracked: n["inventoryItem"]["tracked"].as_bool().unwrap_or(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_product(resp: &serde_json::Value) -> Option<ProductDetail> {
    let p = &resp["data"]["product"];
    if p.is_null() {
        return None;
    }
    Some(ProductDetail {
        id: s(&p["id"])?,
        title: s(&p["title"])?,
        handle: s(&p["handle"])?,
        status: s(&p["status"])?,
        vendor: s(&p["vendor"]),
        product_type: s(&p["productType"]),
        tags: p["tags"].as_array().map(|ts| ts.iter().filter_map(s).collect()).unwrap_or_default(),
        description: s(&p["description"]),
        created_at: s(&p["createdAt"])?,
        updated_at: s(&p["updatedAt"])?,
        online_store_url: s(&p["onlineStoreUrl"]),
        images: p["media"]["nodes"].as_array().map(|ms| ms.iter().filter_map(|m| s(&m["preview"]["image"]["url"])).collect()).unwrap_or_default(),
        variants: variants(p),
    })
}

/// Shopify search syntax with the value quoted and quotes/backslashes escaped.
fn search(field: &str, value: &str) -> String {
    format!("{field}:\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

async fn find_copy(store_id: String, handle: String, title: String) -> StoreCopy {
    let (store_id, handle, title) = (store_id.as_str(), handle.as_str(), title.as_str());
    let empty = |state: &str, error: Option<String>| StoreCopy {
        store_id: store_id.to_string(),
        state: state.to_string(),
        product_id: None,
        status: None,
        matched_by: None,
        variants: vec![],
        error,
    };
    let domain = match crate::store_by_id(store_id) {
        Ok(s) => s.domain,
        Err(e) => return empty("error", Some(e)),
    };
    for (by, q) in [("handle", search("handle", handle)), ("title", search("title", title))] {
        match crate::graphql_request(&domain, FIND, Some(serde_json::json!({ "q": q }))).await {
            Err(e) => return empty("error", Some(e)),
            Ok(resp) => {
                // `title:` is a word search, so insist on an exact (case-insensitive) title match.
                let hit = resp["data"]["products"]["nodes"].as_array().and_then(|ns| ns.first()).filter(|n| {
                    by == "handle" || n["title"].as_str().is_some_and(|t| t.trim().eq_ignore_ascii_case(title.trim()))
                });
                if let Some(n) = hit {
                    return StoreCopy {
                        store_id: store_id.to_string(),
                        state: "found".into(),
                        product_id: s(&n["id"]),
                        status: s(&n["status"]),
                        matched_by: Some(by.into()),
                        variants: variants(n),
                        error: None,
                    };
                }
            }
        }
    }
    empty("missing", None)
}

#[tauri::command]
pub async fn get_product_detail(store_id: String, product_id: String) -> Result<ProductWithCopies, String> {
    if !product_id.starts_with("gid://shopify/Product/") {
        return Err("Missing product id.".into());
    }
    let domain = crate::store_by_id(&store_id)?.domain;
    let resp = crate::graphql_request(&domain, PRODUCT, Some(serde_json::json!({ "id": product_id })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "read_products", "product"))?;
    let product = parse_product(&resp).ok_or("Product not found.")?;
    let others: Vec<String> = crate::known_stores().into_iter().map(|s| s.id).filter(|id| *id != store_id).collect();
    let copies = futures_join(others.into_iter().map(|id| find_copy(id, product.handle.clone(), product.title.clone()))).await;
    Ok(ProductWithCopies { product, copies })
}

/// Run the per-store lookups concurrently (tokio is already a dependency).
async fn futures_join<F: std::future::Future<Output = StoreCopy> + Send + 'static>(futs: impl Iterator<Item = F>) -> Vec<StoreCopy> {
    let handles: Vec<_> = futs.map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.unwrap_or_else(|e| StoreCopy {
            store_id: String::new(),
            state: "error".into(),
            product_id: None,
            status: None,
            matched_by: None,
            variants: vec![],
            error: Some(e.to_string()),
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_product() {
        let r = serde_json::json!({"data": {"product": {"id": "gid://shopify/Product/1", "title": "Lifter", "handle": "lifter", "status": "ACTIVE",
            "vendor": "Flow Gardens", "productType": "Flower", "tags": ["hemp"], "description": "", "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2026-09-01T00:00:00Z", "onlineStoreUrl": null,
            "media": {"nodes": [{"preview": {"image": {"url": "https://cdn/x.jpg"}}}, {"preview": null}]},
            "variants": {"nodes": [{"id": "gid://shopify/ProductVariant/5", "title": "7g", "sku": "FG-LFT-7G", "barcode": null, "price": "35.00",
                "compareAtPrice": null, "inventoryQuantity": 120, "inventoryItem": {"tracked": true}}]}}}});
        let p = parse_product(&r).unwrap();
        assert_eq!((p.images.len(), p.description.as_deref(), p.variants[0].price.as_str(), p.variants[0].inventory), (1, None, "35.00", 120));
    }

    #[test]
    fn quotes_search_values() {
        assert_eq!(search("handle", "lifter"), "handle:\"lifter\"");
        assert_eq!(search("title", "Sour \"Space\" Candy"), "title:\"Sour \\\"Space\\\" Candy\"");
    }
}

//! Analytics straight from Shopify's reports (ShopifyQL over `shopifyqlQuery`, needs read_reports): the same
//! orders / gross / discounts / returns / net / total sales Shopify's Analytics shows, bucketed in the shop's own
//! timezone, plus the top products by net sales. One GraphQL request per store.

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesRow {
    /// YYYY-MM-DD in the shop's timezone ("" on the totals row).
    pub day: String,
    pub orders: i64,
    pub gross_sales: f64,
    pub discounts: f64,
    /// Returns and other sales reversals (negative).
    pub returns: f64,
    pub net_sales: f64,
    pub total_sales: f64,
    pub average_order_value: f64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProductSales {
    pub title: String,
    pub net_sales: f64,
    pub units: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SalesReport {
    pub currency: String,
    pub days: Vec<SalesRow>,
    pub totals: SalesRow,
    pub top_products: Vec<ProductSales>,
}

const QUERY: &str = "query R($daily: String!, $top: String!) { shop { currencyCode } daily: shopifyqlQuery(query: $daily) { tableData { columns { name } rows } parseErrors } top: shopifyqlQuery(query: $top) { tableData { columns { name } rows } parseErrors } }";

fn queries(days: u32) -> (String, String) {
    let since = days - 1; // "last N days" = today and the N−1 days before it
    (
        format!("FROM sales SHOW orders, gross_sales, discounts, sales_reversals, net_sales, total_sales, average_order_value TIMESERIES day WITH TOTALS SINCE -{since}d UNTIL today ORDER BY day ASC"),
        format!("FROM sales SHOW net_sales, net_items_sold GROUP BY product_title SINCE -{since}d UNTIL today ORDER BY net_sales DESC LIMIT 5"),
    )
}

/// One cell by column name; Shopify returns rows as objects keyed by column name (arrays handled too).
fn cell<'a>(row: &'a serde_json::Value, cols: &[String], name: &str) -> Option<&'a serde_json::Value> {
    match row {
        serde_json::Value::Object(m) => m.get(name),
        serde_json::Value::Array(a) => cols.iter().position(|c| c == name).and_then(|i| a.get(i)),
        _ => None,
    }
}
fn num(v: Option<&serde_json::Value>) -> f64 {
    v.and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0)
}

/// (column names, rows) or the ShopifyQL parse error.
fn table<'a>(resp: &'a serde_json::Value, alias: &str) -> Result<(Vec<String>, &'a Vec<serde_json::Value>), String> {
    let q = &resp["data"][alias];
    if let Some(e) = q["parseErrors"].as_array().and_then(|es| es.first()) {
        return Err(format!("ShopifyQL error: {}", e.as_str().unwrap_or("unknown")));
    }
    let t = &q["tableData"];
    let cols = t["columns"].as_array().ok_or("Shopify returned no report data.")?.iter().filter_map(|c| c["name"].as_str().map(String::from)).collect();
    Ok((cols, t["rows"].as_array().ok_or("Shopify returned no report rows.")?))
}

fn row(r: &serde_json::Value, cols: &[String], suffix: &str) -> SalesRow {
    let n = |name: &str| num(cell(r, cols, &format!("{name}{suffix}")));
    SalesRow {
        day: cell(r, cols, "day").and_then(|d| d.as_str()).unwrap_or("").chars().take(10).collect(),
        orders: n("orders").round() as i64,
        gross_sales: n("gross_sales"),
        discounts: n("discounts"),
        returns: n("sales_reversals"),
        net_sales: n("net_sales"),
        total_sales: n("total_sales"),
        average_order_value: n("average_order_value"),
    }
}

fn parse(resp: &serde_json::Value) -> Result<SalesReport, String> {
    let (cols, rows) = table(resp, "daily")?;
    let days: Vec<SalesRow> = rows.iter().map(|r| row(r, &cols, "")).filter(|r| !r.day.is_empty()).collect();
    // WITH TOTALS repeats the window totals on every row as `<metric>__totals`; fall back to summing if absent.
    let totals = match rows.first() {
        Some(r) if cols.iter().any(|c| c.ends_with("__totals")) => SalesRow { day: String::new(), ..row(r, &cols, "__totals") },
        _ => {
            let mut t = days.iter().fold(SalesRow::default(), |mut t, d| {
                t.orders += d.orders;
                t.gross_sales += d.gross_sales;
                t.discounts += d.discounts;
                t.returns += d.returns;
                t.net_sales += d.net_sales;
                t.total_sales += d.total_sales;
                t
            });
            t.average_order_value = if t.orders > 0 { (t.gross_sales + t.discounts) / t.orders as f64 } else { 0.0 };
            t
        }
    };
    let (pcols, prows) = table(resp, "top")?;
    let top_products = prows
        .iter()
        .filter_map(|r| {
            Some(ProductSales {
                title: cell(r, &pcols, "product_title")?.as_str()?.to_string(),
                net_sales: num(cell(r, &pcols, "net_sales")),
                units: num(cell(r, &pcols, "net_items_sold")).round() as i64,
            })
        })
        .collect();
    Ok(SalesReport { currency: resp["data"]["shop"]["currencyCode"].as_str().unwrap_or("USD").to_string(), days, totals, top_products })
}

#[tauri::command]
pub async fn sales_report(store_id: String, days: u32) -> Result<SalesReport, String> {
    if !(1..=366).contains(&days) {
        return Err("Pick a range between 1 and 366 days.".into());
    }
    let domain = crate::store_by_id(&store_id)?.domain;
    let (daily, top) = queries(days);
    let resp = crate::graphql_request(&domain, QUERY, Some(serde_json::json!({ "daily": daily, "top": top })))
        .await
        .map_err(|e| crate::scope_denied(e, &domain, "read_reports", "reports"))?;
    parse(&resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_queries() {
        let (d, t) = queries(7);
        assert!(d.contains("SINCE -6d UNTIL today") && d.contains("TIMESERIES day WITH TOTALS"));
        assert!(t.contains("GROUP BY product_title") && t.contains("LIMIT 5"));
    }

    #[test]
    fn parses_object_rows_with_totals() {
        let r = serde_json::json!({"data": {"shop": {"currencyCode": "USD"},
            "daily": {"parseErrors": [], "tableData": {"columns": [{"name": "day"}, {"name": "orders"}, {"name": "net_sales"}, {"name": "orders__totals"}, {"name": "net_sales__totals"}],
                "rows": [{"day": "2026-09-30", "orders": "115", "net_sales": "16886.37", "orders__totals": "159", "net_sales__totals": "22484.23"},
                         {"day": "2026-10-01", "orders": "44", "net_sales": "5597.86", "orders__totals": "159", "net_sales__totals": "22484.23"}]}},
            "top": {"parseErrors": [], "tableData": {"columns": [{"name": "product_title"}, {"name": "net_sales"}, {"name": "net_items_sold"}],
                "rows": [{"product_title": "Blue Dream", "net_sales": "5254.92", "net_items_sold": "56"}]}}}});
        let rep = parse(&r).unwrap();
        assert_eq!((rep.days.len(), rep.days[0].orders, rep.days[1].net_sales), (2, 115, 5597.86));
        assert_eq!((rep.totals.orders, rep.totals.net_sales, rep.totals.day.as_str()), (159, 22484.23, ""));
        assert_eq!((rep.top_products[0].title.as_str(), rep.top_products[0].units), ("Blue Dream", 56));
    }

    #[test]
    fn parses_array_rows_and_sums_without_totals() {
        let r = serde_json::json!({"data": {"shop": {"currencyCode": "USD"},
            "daily": {"parseErrors": [], "tableData": {"columns": [{"name": "day"}, {"name": "orders"}, {"name": "gross_sales"}, {"name": "discounts"}],
                "rows": [["2026-09-30", "2", "100", "-10"], ["2026-10-01", "1", "50", "0"]]}},
            "top": {"parseErrors": [], "tableData": {"columns": [], "rows": []}}}});
        let rep = parse(&r).unwrap();
        assert_eq!((rep.totals.orders, rep.totals.gross_sales), (3, 150.0));
        assert_eq!(rep.totals.average_order_value, 140.0 / 3.0);
        let bad = serde_json::json!({"data": {"daily": {"parseErrors": ["Column Not Found"], "tableData": null}}});
        assert!(parse(&bad).unwrap_err().contains("Column Not Found"));
    }
}

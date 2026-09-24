mod common;

#[test]
fn every_way_a_dotnet_app_is_entered_is_an_entry() {
    let index = common::read("surfaces");
    let mut entered: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| matches!(entry["kind"].as_str(), Some("http" | "rpc")))
        .map(|entry| {
            format!(
                "{} {} {}",
                entry["kind"].as_str().unwrap(),
                entry["method"].as_str().unwrap_or("-"),
                entry["path"].as_str().unwrap_or("-")
            )
        })
        .collect();
    entered.sort();
    assert_eq!(
        entered,
        vec![
            "http GET /Account/Login",
            "http GET /Account/Profile",
            "http GET /cart",
            "http POST /Account/Login",
            "rpc - /Basket/GetBasket",
        ]
    );
    let cart = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "/cart")
        .unwrap();
    assert_eq!(cart["guards"][0]["name"], "Authorize");
}

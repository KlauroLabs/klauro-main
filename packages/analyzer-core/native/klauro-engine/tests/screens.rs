mod common;

use serde_json::Value;

fn screens(index: &Value) -> Vec<(String, String)> {
    let mut held: Vec<(String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "ui")
        .map(|entry| {
            let handler = entry["handler"].as_str().unwrap();
            let named = handler.split(':').collect::<Vec<_>>();
            let file = named[0].rsplit('/').next().unwrap().to_string();
            (entry["name"].as_str().unwrap().to_string(), format!("{file}#{}", named.get(2).copied().unwrap_or("")))
        })
        .collect();
    held.sort();
    held
}

fn flow_of<'a>(index: &'a Value, name: &str) -> &'a Value {
    index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["kind"] == "ui" && flow["operation"] == name)
        .unwrap_or_else(|| panic!("a flow for {name}"))
}

fn reaches_a_request(index: &Value, flow: &Value, to: &str) -> bool {
    let units: Vec<&str> =
        flow["path"].as_array().unwrap().iter().map(|step| step["unit"].as_str().unwrap()).collect();
    index["exit_points"].as_array().unwrap().iter().any(|exit| {
        exit["kind"] == "api"
            && exit["addressed"].as_str().is_some_and(|address| address.contains(to))
            && units.contains(&exit["source"].as_str().unwrap())
    })
}

#[test]
fn a_routed_component_is_a_screen_and_its_flow_reaches_the_request_a_click_makes() {
    let index = common::read("screens-react-router");
    let held = screens(&index);
    assert_eq!(
        held,
        vec![
            ("/".to_string(), "Home.tsx#Home".to_string()),
            ("/orders/:id".to_string(), "OrderPage.tsx#OrderPage".to_string()),
            ("/settings".to_string(), "Settings.tsx#SettingsPage".to_string()),
        ],
        "{held:?}"
    );
    let order = flow_of(&index, "/orders/:id");
    assert!(reaches_a_request(&index, order, "/api/orders/cancel"), "a handler named in onClick: {order}");
    assert!(reaches_a_request(&index, order, "/api/orders/lines"), "a rendered child's click: {order}");
    let settings = flow_of(&index, "/settings");
    assert!(reaches_a_request(&index, settings, "/api/settings"), "an inline click in a lazily loaded screen: {settings}");
}

#[test]
fn a_component_no_route_renders_and_a_hook_are_not_screens() {
    let index = common::read("screens-react-router");
    let held = screens(&index);
    assert!(!held.iter().any(|(_, handler)| handler.starts_with("Unrouted") || handler.starts_with("useOrders")), "{held:?}");
    assert!(!held.iter().any(|(_, handler)| handler.starts_with("router.tsx")), "a layout route is not a screen: {held:?}");
}

#[test]
fn nested_route_elements_join_their_paths_and_a_parent_with_children_is_a_layout() {
    let index = common::read("screens-jsx-routes");
    let held = screens(&index);
    assert_eq!(
        held,
        vec![
            ("/".to_string(), "About.tsx#About".to_string()),
            ("/account".to_string(), "Account.tsx#Account".to_string()),
        ],
        "{held:?}"
    );
    assert!(reaches_a_request(&index, flow_of(&index, "/account"), "/api/account"));
}

#[test]
fn a_mounted_shell_is_not_a_screen_when_routes_draw_the_screens() {
    let index = common::read("screens-jsx-routes");
    assert!(!screens(&index).iter().any(|(name, _)| name == "App"), "{:?}", screens(&index));
}

#[test]
fn a_route_object_names_its_component_by_import_or_by_loading_it() {
    let index = common::read("screens-vue-router");
    let held = screens(&index);
    assert_eq!(
        held,
        vec![
            ("/".to_string(), "HomeView.ts#HomeView".to_string()),
            ("/reports/:id".to_string(), "ReportView.ts#ReportView".to_string()),
        ],
        "{held:?}"
    );
}

#[test]
fn an_angular_route_names_its_component_class_whether_imported_or_lazily_loaded() {
    let index = common::read("screens-angular");
    let held = screens(&index);
    assert_eq!(
        held,
        vec![
            ("/billing".to_string(), "billing.component.ts#BillingComponent".to_string()),
            ("/dashboard".to_string(), "dashboard.component.ts#DashboardComponent".to_string()),
        ],
        "{held:?}"
    );
}

#[test]
fn what_the_program_mounts_with_no_router_is_a_screen_each() {
    let index = common::read("screens-mounted");
    let held = screens(&index);
    assert_eq!(
        held,
        vec![
            ("App".to_string(), "App.tsx#App".to_string()),
            ("PanelWindow".to_string(), "PanelWindow.tsx#PanelWindow".to_string()),
        ],
        "{held:?}"
    );
    assert!(reaches_a_request(&index, flow_of(&index, "App"), "/api/send"), "a rendered child's click");
}

#[test]
fn a_tanstack_route_names_the_component_it_draws_and_a_helper_beside_it_is_not_a_screen() {
    let index = common::read("screens-tanstack");
    let held = screens(&index);
    assert_eq!(held, vec![("/posts".to_string(), "routes.tsx#PostsPage".to_string())], "{held:?}");
    assert!(reaches_a_request(&index, flow_of(&index, "/posts"), "/api/posts/refresh"));
}

#[test]
fn a_route_table_a_wrapper_a_loader_and_a_table_of_paths_all_name_screens() {
    let index = common::read("screens-route-table");
    let held = screens(&index);
    assert_eq!(
        held,
        vec![
            ("/about".to_string(), "About.tsx#About".to_string()),
            ("/charts".to_string(), "ChartList.tsx#ChartList".to_string()),
            ("/detail".to_string(), "DetailPage.tsx#DetailPage".to_string()),
            ("/lists".to_string(), "ListsPage.tsx#ListsPage".to_string()),
            ("/settings".to_string(), "SettingsPage.tsx#SettingsPage".to_string()),
            ("/welcome".to_string(), "Home.tsx#Home".to_string()),
            ("/wrapped".to_string(), "WrappedPage.tsx#WrappedBody".to_string()),
        ],
        "{held:?}"
    );
    assert!(reaches_a_request(&index, flow_of(&index, "/welcome"), "/api/welcome"));
}

#[test]
fn a_component_that_draws_the_routes_of_others_is_a_shell_and_not_a_screen() {
    let index = common::read("screens-shell");
    let held = screens(&index);
    assert_eq!(held, vec![("/inbox".to_string(), "Inbox.tsx#Inbox".to_string())], "{held:?}");
}

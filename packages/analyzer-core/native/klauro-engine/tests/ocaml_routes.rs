mod common;

#[test]
fn verb_applications_compose_the_scopes_they_sit_in() {
    let index = common::read("ocaml_routes");
    let mut found: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| format!("{} {} {}", entry["method"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap(), entry["handler"].as_str().unwrap()))
        .collect();
    found.sort();
    assert_eq!(
        found,
        vec![
            "DELETE /users/:id app.ml:function:destroy_user",
            "GET / app.ml:function:home",
            "GET /api/health app.ml:function:health",
            "GET /users app.ml:function:list_users",
            "GET /users/:id app.ml:function:show_user",
            "POST /users app.ml:function:create_user",
        ]
    );
}

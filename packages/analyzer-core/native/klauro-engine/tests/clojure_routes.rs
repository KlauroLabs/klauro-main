mod common;

fn served(fixture: &str) -> Vec<(String, String, String)> {
    let index = common::read(fixture);
    let mut found: Vec<(String, String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["file"].as_u64().map(|file| file.to_string()).unwrap_or_default(),
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    found.sort();
    found
}

fn routes(fixture: &str) -> Vec<String> {
    let index = common::read(fixture);
    let mut found: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| format!("{} {} {}", entry["method"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap(), entry["handler"].as_str().unwrap()))
        .collect();
    found.sort();
    found
}

#[test]
fn compojure_verbs_compose_their_context_prefixes_and_serve_any_as_a_read() {
    let found = routes("clojure_routes");
    for expected in [
        "GET / src/compojure.clj:function:home",
        "GET /users/:id src/compojure.clj:function:show",
        "POST /users src/compojure.clj:function:create",
        "PUT /users/:id src/compojure.clj:function:update-user",
        "DELETE /users/:id src/compojure.clj:function:destroy",
        "GET /api/health src/compojure.clj:function:health",
        "POST /api/items src/compojure.clj:function:make-item",
        "GET /api/v2/items src/compojure.clj:function:list-items",
        "GET /ping src/compojure.clj:function:ping",
    ] {
        assert!(found.iter().any(|route| route == expected), "missing {expected} in {found:?}");
    }
}

#[test]
fn reitit_vectors_nest_their_prefixes_and_name_each_methods_handler() {
    let found = routes("clojure_routes");
    for expected in [
        "GET /api/users src/reitit.clj:function:list-users",
        "POST /api/users src/reitit.clj:function:create-user",
        "GET /api/users/:id src/reitit.clj:function:show-user",
        "GET /api/health src/reitit.clj:function:health",
        "GET /api/v2/items src/reitit.clj:function:list-items",
    ] {
        assert!(found.iter().any(|route| route == expected), "missing {expected} in {found:?}");
    }
    assert_eq!(served("clojure_routes").len(), 14);
}

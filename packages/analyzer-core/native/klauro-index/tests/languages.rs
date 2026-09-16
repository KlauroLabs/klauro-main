use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

fn languages() -> &'static serde_json::Value {
    static INDEX: OnceLock<serde_json::Value> = OnceLock::new();
    INDEX.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/languages");
        let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
        let output = Command::new(binary).arg(&root).output().expect("index runs");
        serde_json::from_slice(&output.stdout).expect("index emits json")
    })
}

fn file_of(node: &serde_json::Value) -> String {
    let files = languages()["files"].as_array().unwrap();
    let position = node["file"].as_u64().unwrap() as usize;
    files
        .get(position)
        .and_then(|file| file["path"].as_str())
        .unwrap_or("")
        .to_string()
}

fn nodes_in(file: &str) -> Vec<serde_json::Value> {
    languages()["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| file_of(node) == file)
        .cloned()
        .collect()
}

fn unit_in(file: &str, name: &str) -> serde_json::Value {
    nodes_in(file)
        .into_iter()
        .find(|node| node["name"] == name)
        .unwrap_or_else(|| panic!("{file} declares {name}"))
}

fn edge_targets(source: &str, kind: &str) -> Vec<String> {
    let nodes = languages()["nodes"].as_array().unwrap();
    let mut names: Vec<String> = languages()["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == kind && edge["source"] == source)
        .filter_map(|edge| {
            nodes
                .iter()
                .find(|node| node["id"] == edge["target"])
                .map(|node| node["name"].as_str().unwrap().to_string())
        })
        .collect();
    names.sort();
    names
}

const FILES: &[(&str, &str, &str, &str)] = &[
    ("go", "store.go", "Session", "Close"),
    ("python", "store.py", "Session", "close"),
    ("java", "Store.java", "Session", "close"),
    ("csharp", "Store.cs", "Session", "Close"),
    ("rust", "store.rs", "Session", "close"),
    ("ruby", "store.rb", "Session", "close"),
    ("php", "store.php", "Session", "close"),
    ("swift", "store.swift", "Session", "close"),
    ("kotlin", "Store.kt", "Session", "close"),
];

#[test]
fn every_language_declares_its_type_and_attaches_its_method() {
    for (language, file, type_name, method) in FILES {
        let declared = unit_in(file, type_name);
        assert!(
            ["class", "interface"].contains(&declared["kind"].as_str().unwrap()),
            "{language}: {type_name} is a type"
        );
        let methods = edge_targets(declared["id"].as_str().unwrap(), "has_method");
        assert!(
            methods.iter().any(|name| name == method),
            "{language}: {type_name} reaches {method}, saw {methods:?}"
        );
    }
}

#[test]
fn a_declared_field_is_parented_to_its_type() {
    for (language, file, type_name) in [
        ("go", "store.go", "Session"),
        ("java", "Store.java", "Session"),
        ("csharp", "Store.cs", "Session"),
        ("rust", "store.rs", "Session"),
        ("php", "store.php", "Session"),
        ("swift", "store.swift", "Session"),
        ("kotlin", "Store.kt", "Session"),
        ("c", "store.c", "Session"),
    ] {
        let declared = unit_in(file, type_name);
        let fields = edge_targets(declared["id"].as_str().unwrap(), "has_field");
        assert_eq!(fields.len(), 2, "{language}: two fields, saw {fields:?}");
        for field in &fields {
            let node = unit_in(file, field);
            assert_eq!(node["kind"], "property", "{language}: {field} is a field");
            assert_eq!(
                node["parent"], declared["id"],
                "{language}: {field} is parented to its type"
            );
        }
    }
}

#[test]
fn a_typed_language_carries_parameter_and_return_types() {
    for (language, file, method, parameter, parameter_type, return_type) in [
        ("go", "store.go", "Close", "force", "bool", "error"),
        ("java", "Store.java", "close", "force", "boolean", "boolean"),
        ("csharp", "Store.cs", "Close", "force", "bool", "bool"),
        ("php", "store.php", "close", "force", "bool", "bool"),
        ("swift", "store.swift", "close", "force", "Bool", "Bool"),
        ("kotlin", "Store.kt", "close", "force", "Boolean", "Boolean"),
        ("python", "store.py", "close", "force", "bool", "bool"),
    ] {
        let unit = unit_in(file, method);
        let signature = &unit["signature"];
        let found = signature["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|found| found["name"] == parameter)
            .unwrap_or_else(|| panic!("{language}: {method} takes {parameter}"));
        assert_eq!(
            found["type_annotation"], parameter_type,
            "{language}: {parameter} is typed"
        );
        assert_eq!(
            signature["return_type"], return_type,
            "{language}: {method} returns"
        );
    }
}

#[test]
fn an_untyped_language_still_carries_its_parameters() {
    let close = unit_in("store.rb", "close");
    let parameters = close["signature"]["parameters"].as_array().unwrap();
    assert_eq!(parameters[0]["name"], "force");
    assert!(
        parameters[0]["type_annotation"].is_null(),
        "ruby declares no types, so none are invented"
    );
}

#[test]
fn a_call_is_attributed_to_the_unit_that_makes_it() {
    for (language, file, caller, callee) in [
        ("go", "store.go", "Close", "persist"),
        ("java", "Store.java", "close", "persist"),
        ("csharp", "Store.cs", "Close", "Persist"),
        ("rust", "store.rs", "close", "persist"),
        ("php", "store.php", "close", "persist"),
        ("python", "store.py", "close", "persist"),
        ("c", "store.c", "session_close", "persist"),
    ] {
        let unit = unit_in(file, caller);
        let found = languages()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["caller"] == unit["id"] && call["callee"] == callee);
        assert!(found, "{language}: {caller} calls {callee}");
    }
}

#[test]
fn branches_and_throws_reach_icelot_in_every_language() {
    for (language, file, method, throws) in [
        ("java", "Store.java", "close", Some("IllegalStateException")),
        ("csharp", "Store.cs", "Close", Some("InvalidOperationException")),
        ("php", "store.php", "close", Some("RuntimeException")),
        ("python", "store.py", "close", Some("ValueError")),
        ("go", "store.go", "Close", None),
        ("rust", "store.rs", "close", None),
    ] {
        let unit = unit_in(file, method);
        let icelot = languages()["icelot"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["unit"] == unit["id"])
            .unwrap_or_else(|| panic!("{language}: {method} has icelot"));
        assert!(
            icelot["logic"]["branches"].as_u64().unwrap() >= 1,
            "{language}: the guard is a branch"
        );
        if let Some(thrown) = throws {
            assert_eq!(
                icelot["constraints"]["throws"][0], thrown,
                "{language}: the thrown type is recorded"
            );
        }
    }
}

#[test]
fn a_type_reference_across_languages_becomes_a_heritage_edge() {
    let java = unit_in("Store.java", "Session");
    let references = languages()["type_references"].as_array().unwrap();
    assert!(
        references
            .iter()
            .any(|reference| reference["source"] == java["id"] && reference["name"] == "Base"),
        "java records what it extends"
    );
    let php = unit_in("store.php", "Session");
    assert!(
        references
            .iter()
            .any(|reference| reference["source"] == php["id"] && reference["name"] == "Base"),
        "php records what it extends"
    );
}

#[test]
fn generated_code_is_not_indexed() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/generated");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let names: Vec<&str> = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"authored"), "authored code is indexed");
    assert!(
        !names.contains(&"machineWritten"),
        "a file marked generated is not"
    );
    assert!(
        names.contains(&"detectsAutoGenerated"),
        "prose about generated code is not a generated-file banner"
    );
    assert!(
        !names.contains(&"BannerModel"),
        "a banner naming its generator is, whatever the language"
    );
}

#[test]
fn a_named_handler_registration_is_an_entry_point() {
    let entries = languages()["entry_points"].as_array().unwrap();
    let shown = entries
        .iter()
        .find(|entry| entry["path"] == "/sessions/{id}")
        .expect("the go route is an entry point");
    assert_eq!(shown["kind"], "http");
    assert_eq!(
        shown["method"], "GET",
        "the verb inside the label is the method"
    );
    let handler = languages()["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["id"] == shown["handler"])
        .expect("the handler is a node");
    assert_eq!(
        handler["name"], "showSession",
        "the entry point points at the function it names, not at the registration"
    );
}

#[test]
fn an_annotation_route_composes_the_class_path() {
    let entries = languages()["entry_points"].as_array().unwrap();
    let found = entries
        .iter()
        .find(|entry| entry["path"] == "/owners/{ownerId}")
        .expect("the method path is joined to the class path");
    assert_eq!(found["kind"], "http");
    assert_eq!(found["method"], "GET");

    let created = entries
        .iter()
        .find(|entry| entry["method"] == "POST" && entry["path"] == "/owners")
        .expect("an annotation with no path inherits the class path");
    assert_eq!(created["kind"], "http");
}

#[test]
fn a_repository_query_annotation_is_not_a_graphql_entry_point() {
    let entries = languages()["entry_points"].as_array().unwrap();
    assert!(
        !entries.iter().any(|entry| entry["kind"] == "graphql"),
        "a bare Query annotation is too ambiguous to be a graphql operation"
    );
}

#[test]
fn a_call_through_a_receiver_field_is_an_exit_point_for_its_package() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/receiver");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();

    let exits = index["exit_points"].as_array().unwrap();
    let database = exits
        .iter()
        .find(|exit| exit["kind"] == "database")
        .expect("a query through the receiver field is a database exit");
    assert_eq!(database["target"], "database/sql");
    assert_eq!(database["operation"], "QueryRow");

    assert!(
        !exits.iter().any(|exit| exit["kind"] == "file"),
        "opening a database connection is not a file exit"
    );

    let store = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "Store" && node["kind"] == "class")
        .expect("the struct is indexed");
    let owned: Vec<&serde_json::Value> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "has_method" && edge["source"] == store["id"])
        .collect();
    assert_eq!(
        owned.len(),
        1,
        "a method declared in another file still belongs to its type"
    );
}

#[test]
fn every_breadth_fixture_yields_a_named_declaration() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/breadth");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();

    let files = index["files"].as_array().unwrap();
    let mut declared: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for node in index["nodes"].as_array().unwrap() {
        if node["kind"] == "module" || node["kind"] == "external" {
            continue;
        }
        let Some(position) = node["file"].as_u64() else { continue };
        *declared.entry(position as usize).or_insert(0) += 1;
    }

    let mut silent = Vec::new();
    let mut covered = 0;
    for (position, file) in files.iter().enumerate() {
        if file["kind"] != "source" {
            continue;
        }
        covered += 1;
        if !declared.contains_key(&position) {
            silent.push(file["path"].as_str().unwrap().to_string());
        }
    }
    assert!(covered >= 25, "the breadth fixture covers the languages, saw {covered}");
    assert!(
        silent.is_empty(),
        "every language declares something, these did not: {silent:?}"
    );
}

fn scope_of(fixture: &str) -> serde_json::Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    index["scope"].clone()
}

fn shipped(scope: &serde_json::Value) -> Vec<serde_json::Value> {
    scope["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["shipped"] == true)
        .cloned()
        .collect()
}

#[test]
fn a_compose_service_that_builds_our_code_is_a_deployable_and_one_that_pulls_an_image_is_not() {
    let scope = scope_of("scope");
    let units = shipped(&scope);
    let mut names: Vec<&str> = units
        .iter()
        .map(|unit| unit["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["api", "worker"], "a pulled image ships none of our code");

    let api = units.iter().find(|unit| unit["name"] == "api").unwrap();
    assert_eq!(api["root"], "services/api");
}

#[test]
fn every_node_carries_the_unit_that_ships_it() {
    let scope = scope_of("scope");
    assert_eq!(
        scope["unassigned_nodes"], 0,
        "a node outside every ship unit would have no scope"
    );
    let units = shipped(&scope);
    let api = units.iter().find(|unit| unit["name"] == "api").unwrap();
    assert!(api["units"].as_u64().unwrap() >= 1, "the service owns its own code");
}

#[test]
fn an_installer_makes_one_ship_unit_of_what_it_names() {
    let scope = scope_of("bundle");
    let units = shipped(&scope);
    assert_eq!(units.len(), 1, "the installer is the ship unit");

    let mut members: Vec<&str> = units[0]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    members.sort();
    assert_eq!(members, ["deployable:client", "deployable:service"]);

    let unbundled: Vec<&str> = scope["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["bundled_into"].is_null() && unit["shipped"] == false)
        .map(|unit| unit["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        unbundled, ["tool"],
        "a runnable the installer does not name is never merged into it"
    );
}

#[test]
fn code_shared_by_two_units_belongs_to_both() {
    let scope = scope_of("scope");
    assert_eq!(scope["shared_nodes"], 1, "the library both services import");
    for unit in shipped(&scope) {
        assert_eq!(
            unit["units"], 2,
            "{} counts its own declaration and the one it imports",
            unit["name"]
        );
    }
}

#[test]
fn a_collection_is_counted_rather_than_enumerated() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/data");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let nodes = index["nodes"].as_array().unwrap();

    assert!(
        nodes.len() < 40,
        "a file of records is not a file of declarations, saw {} nodes",
        nodes.len()
    );
    let records = nodes
        .iter()
        .find(|node| node["name"] == "records")
        .expect("the collection is named");
    assert_eq!(records["type_annotation"], "200 entries");

    assert!(
        nodes.iter().any(|node| node["name"] == "version"),
        "configuration beside the collection is still read"
    );
}

fn partition_of(fixture: &str) -> serde_json::Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    index["partition"].clone()
}

#[test]
fn a_declared_module_is_a_sub_project_whether_or_not_it_ships() {
    let partition = partition_of("bundle");
    let projects = partition["sub_projects"].as_array().unwrap();
    let mut names: Vec<&str> = projects
        .iter()
        .map(|project| project["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        ["client", "service", "tool"],
        "three manifests, three projects"
    );
    let projects_that_ship = projects
        .iter()
        .filter(|project| project["ship_backed"] == true)
        .count();
    assert_eq!(
        projects_that_ship, 2,
        "the installer names two of the three, which is a separate question from what they are"
    );
    assert_eq!(partition["sub_cas_nodes"]["promoted"], true);
}

#[test]
fn a_single_module_repository_is_one_project() {
    let partition = partition_of("data");
    assert_eq!(partition["sub_projects"].as_array().unwrap().len(), 1);
    assert_eq!(partition["sub_cas_nodes"]["promoted"], false);
    assert_eq!(
        partition["sub_cas_nodes"]["reason"], "one-project-below-threshold"
    );
}

#[test]
fn every_declaration_belongs_to_a_project() {
    let partition = partition_of("scope");
    assert_eq!(partition["unpartitioned_declarations"], 0);
    let projects = partition["sub_projects"].as_array().unwrap();
    assert!(!projects.is_empty(), "the repository declares at least one");
}

#[test]
fn what_a_project_is_reads_from_facts_rather_than_a_stored_label() {
    let partition = partition_of("scope");
    let projects = partition["sub_projects"].as_array().unwrap();

    let api = projects
        .iter()
        .find(|project| project["name"] == "api")
        .expect("the workspace member is a project");
    assert_eq!(api["declared_by"], "workspace-member");
    assert_eq!(api["ship_backed"], true, "a compose service builds it");

    let shared = projects
        .iter()
        .find(|project| project["name"] == "shared")
        .expect("the library is a project too");
    assert_eq!(shared["ship_backed"], false, "nothing ships it on its own");
    assert_eq!(
        shared["consumed_by"].as_array().unwrap().len(),
        2,
        "both services import it, which is what makes it a library"
    );
}

#[test]
fn a_node_carries_the_project_it_belongs_to() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/scope");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let index: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();

    let serve = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "serve")
        .expect("the declaration is indexed");
    assert_eq!(
        serve["project"], "subproject:services/api",
        "a tier above can read the index one project at a time"
    );

    let shared = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "shared" && node["kind"] == "function")
        .unwrap();
    assert_eq!(shared["project"], "subproject:libs/shared");
}

#[test]
fn a_repository_that_declares_nothing_splits_on_import_cohesion() {
    let partition = partition_of("cohesion");
    let projects = partition["sub_projects"].as_array().unwrap();
    let mut names: Vec<&str> = projects
        .iter()
        .map(|project| project["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["alpha", "beta"]);

    for project in projects {
        assert_eq!(project["declared_by"], "import-cohesion");
        assert_eq!(
            project["imports_crossing"], 0,
            "a tree that imports only itself is its own project"
        );
    }
    assert_eq!(partition["sub_cas_nodes"]["promoted"], true);
}

#[test]
fn a_declaration_outranks_cohesion() {
    let partition = partition_of("scope");
    for project in partition["sub_projects"].as_array().unwrap() {
        assert_ne!(
            project["declared_by"], "import-cohesion",
            "cohesion is only consulted when the repository declares nothing"
        );
    }
}

#[test]
fn an_xml_element_carries_its_text_and_names_the_project() {
    let partition = partition_of("maven");
    let project = partition["sub_projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["root"] == "service")
        .expect("the module is a project");
    assert_eq!(
        project["name"], "billing-service",
        "the name comes from the manifest, not the directory"
    );
    assert_eq!(project["runnable"], true, "a main beside the manifest starts it");
}

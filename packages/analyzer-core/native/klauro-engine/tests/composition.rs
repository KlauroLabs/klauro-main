mod common;

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn child<'a>(composition: &'a Value, root: &str) -> &'a Value {
    composition["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["id"] == format!("subproject:{root}"))
        .unwrap_or_else(|| panic!("{root} is a child"))
}

fn weight(composition: &Value, root: &str) -> f64 {
    child(composition, root)["weight"].as_f64().unwrap()
}

fn copy(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        match entry.file_type().unwrap().is_dir() {
            true => copy(&entry.path(), &target),
            false => {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
}

fn git(directory: &Path, date: &str, arguments: &[&str]) {
    let done = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(arguments)
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(done.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&done.stderr));
}

fn with_history(name: &str, rounds: &[(&str, &[&str])]) -> Value {
    let root = std::env::temp_dir().join(format!("composition-history-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    copy(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/composed"), &root);
    git(&root, "2020-01-01T00:00:00Z", &["init", "-q"]);
    git(&root, "2020-01-01T00:00:00Z", &["add", "."]);
    git(&root, "2020-01-01T00:00:00Z", &["commit", "-q", "-m", "first"]);
    for (round, (date, changed)) in rounds.iter().enumerate() {
        for file in *changed {
            let path = root.join(file);
            let mut text = std::fs::read_to_string(&path).unwrap();
            text.push_str(&format!("// change {round}\n"));
            std::fs::write(path, text).unwrap();
        }
        git(&root, date, &["add", "."]);
        git(&root, date, &["commit", "-q", "-m", &format!("change {round}")]);
    }
    let binary = env!("CARGO_BIN_EXE_klauro-engine");
    let output = Command::new(binary).arg(&root).env("KLAURO_ENRICH", "0").output().unwrap();
    let index = common::rehydrate_stream(&output.stdout);
    let _ = std::fs::remove_dir_all(&root);
    index["composition"].clone()
}

const LEGACY: &str = "packages/legacy-old/src/old.ts";
const ORDERS: &str = "packages/orders/src/server.ts";
const SHARED: &str = "packages/shared/src/format.ts";

#[test]
fn without_history_weights_follow_what_each_child_is() {
    let index = common::read("composed");
    let composition = &index["composition"];
    assert_eq!(composition["mode"], "derived");
    let orders = weight(composition, "packages/orders");
    let worker = weight(composition, "packages/billing-worker");
    let shared = weight(composition, "packages/shared");
    let legacy = weight(composition, "packages/legacy-old");
    assert_eq!(orders, 1.0);
    assert!(orders > worker && worker > shared && shared > legacy, "{orders} {worker} {shared} {legacy}");
    assert_eq!(child(composition, "packages/orders")["weight_basis"]["activity"], 1.0);
    assert_eq!(child(composition, "packages/legacy-old")["status"], "module");
    assert_eq!(weight(composition, "packages/legacy-old"), 0.35);
    assert!(child(composition, "packages/legacy-old")["weight_basis"]["notes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|note| note.as_str().unwrap().contains("no usable history")));
}

#[test]
fn a_library_imported_by_a_shipped_child_is_substrate_and_outweighs_an_unconsumed_module() {
    let index = common::read("composed");
    let composition = &index["composition"];
    let shared = child(composition, "packages/shared");
    assert_eq!(shared["status"], "library");
    assert_eq!(shared["weight_basis"]["consumed_by_shipped"], true);
    assert_eq!(shared["weight_basis"]["ship"], 0.6);
}

#[test]
fn a_module_untouched_for_months_while_the_product_moves_is_legacy() {
    let composition = with_history(
        "quiet",
        &[("2026-01-01T00:00:00Z", &[LEGACY]), ("2026-09-01T00:00:00Z", &[ORDERS]), ("2026-09-20T00:00:00Z", &[ORDERS])],
    );
    let legacy = child(&composition, "packages/legacy-old");
    assert_eq!(legacy["weight_basis"]["activity"], 0.35);
    assert_eq!(legacy["weight"], 0.122);
    assert_eq!(child(&composition, "packages/orders")["weight"], 1.0);
    assert!(legacy["weight"].as_f64().unwrap() < weight(&composition, "packages/shared"));
    assert!(legacy["weight"].as_f64().unwrap() < weight(&composition, "packages/billing-worker"));
}

#[test]
fn an_active_unshipped_module_clearly_outranks_legacy() {
    let active = with_history("active", &[("2026-01-01T00:00:00Z", &[LEGACY]), ("2026-09-20T00:00:00Z", &[LEGACY, ORDERS])]);
    let quiet = with_history("dormant", &[("2026-01-01T00:00:00Z", &[LEGACY]), ("2026-09-20T00:00:00Z", &[ORDERS])]);
    assert_eq!(weight(&active, "packages/legacy-old"), 0.35);
    assert_eq!(weight(&quiet, "packages/legacy-old"), 0.122);
}

#[test]
fn a_stable_shipped_child_stays_high_however_long_it_is_quiet() {
    let composition = with_history("stable", &[("2026-01-01T00:00:00Z", &[SHARED]), ("2026-09-20T00:00:00Z", &[LEGACY])]);
    let orders = child(&composition, "packages/orders");
    assert_eq!(orders["weight_basis"]["activity"], 0.35);
    assert_eq!(orders["weight"], 0.85);
    let shared = child(&composition, "packages/shared");
    assert!(shared["weight"].as_f64().unwrap() >= 0.6 * 0.85 - 0.001, "substrate keeps its factor: {shared}");
}

#[test]
fn the_first_import_is_not_a_change() {
    let composition = with_history("import", &[("2026-09-20T00:00:00Z", &[ORDERS])]);
    let legacy = child(&composition, "packages/legacy-old");
    assert_eq!(legacy["weight_basis"]["days_since_change"].as_i64().unwrap() > 2000, true, "{legacy}");
    assert_eq!(legacy["weight"], 0.122);
}

#[test]
fn a_single_commit_is_no_history_and_changes_nothing() {
    let composition = with_history("single", &[]);
    assert_eq!(child(&composition, "packages/legacy-old")["weight_basis"]["activity"], 1.0);
}

#[test]
fn a_client_call_that_hits_another_childs_route_is_an_http_seam() {
    let index = common::read("composed");
    let seams = index["composition"]["seams"].as_array().unwrap();
    let http: Vec<&Value> = seams.iter().filter(|seam| seam["kind"] == "http" && seam["origin"] == "product").collect();
    assert_eq!(http.len(), 1, "{seams:?}");
    assert_eq!(http[0]["from"], "subproject:packages/web");
    assert_eq!(http[0]["to"], "subproject:packages/orders");
    assert_eq!(http[0]["communication"], "sync");
    assert_eq!(http[0]["count"], 1);
    let evidence = http[0]["evidence"][0].as_str().unwrap();
    assert!(evidence.contains("client.ts") && evidence.contains("server.ts"), "{evidence}");
}

#[test]
fn a_call_made_from_test_code_is_kept_but_marked_as_a_test_seam() {
    let index = common::read("composed");
    let seams = index["composition"]["seams"].as_array().unwrap();
    let marked: Vec<&Value> = seams.iter().filter(|seam| seam["origin"] == "test").collect();
    assert_eq!(marked.len(), 1, "{seams:?}");
    assert_eq!(marked[0]["from"], "subproject:packages/web");
    assert_eq!(marked[0]["to"], "subproject:packages/orders");
    assert!(marked[0]["evidence"][0].as_str().unwrap().contains("orders.test.ts"));
    assert!(seams.iter().all(|seam| seam["origin"] == "test" || !seam["evidence"][0].as_str().unwrap().contains(".test.")));
}

#[test]
fn a_child_starting_another_childs_program_is_a_process_seam() {
    let index = common::read("composed");
    let seams = index["composition"]["seams"].as_array().unwrap();
    let process: Vec<&Value> = seams.iter().filter(|seam| seam["kind"] == "process").collect();
    assert_eq!(process.len(), 1, "{seams:?}");
    assert_eq!(process[0]["from"], "subproject:packages/orders");
    assert_eq!(process[0]["to"], "subproject:packages/billing-worker");
    assert_eq!(process[0]["communication"], "sync");
}

#[test]
fn imports_across_children_are_dependencies_not_seams() {
    let index = common::read("composed");
    let composition = &index["composition"];
    assert!(composition["seams"].as_array().unwrap().iter().all(|seam| seam["kind"] != "imports"));
    let dependencies = composition["dependencies"].as_array().unwrap();
    let onto_shared: Vec<&str> = dependencies
        .iter()
        .filter(|held| held["to"] == "subproject:packages/shared")
        .map(|held| held["from"].as_str().unwrap())
        .collect();
    assert_eq!(onto_shared, vec!["subproject:packages/orders", "subproject:packages/web"]);
    assert_eq!(dependencies[0]["evidence"].as_array().unwrap().len(), 1);
}

#[test]
fn a_single_project_repository_has_no_composition() {
    let index = common::read("clients");
    assert!(index["partition"].is_object());
    assert!(index.get("composition").is_none() || index["composition"].is_null());
}

#[test]
fn the_block_is_deterministic() {
    let first = common::read("composed");
    let second = common::read("composed");
    assert_eq!(first["composition"], second["composition"]);
}

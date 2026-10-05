mod common;

use serde_json::Value;

fn seams(fixture: &str, kind: &str) -> Vec<(String, String, Vec<String>)> {
    let index = common::read(fixture);
    index["composition"]["seams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|seam| seam["kind"] == kind && seam["origin"] == "product")
        .map(|seam| {
            (
                seam["from"].as_str().unwrap().to_string(),
                seam["to"].as_str().unwrap().to_string(),
                seam["evidence"].as_array().unwrap().iter().map(|held: &Value| held.as_str().unwrap().to_string()).collect(),
            )
        })
        .collect()
}

fn mentions(found: &[(String, String, Vec<String>)], from: &str, to: &str, text: &str) -> bool {
    found
        .iter()
        .any(|(source, target, evidence)| source == from && target == to && evidence.iter().any(|line| line.contains(text)))
}

#[test]
fn a_base_url_held_in_a_constant_instance_or_wrapper_still_reaches_the_route_it_names() {
    let found = seams("seam-base-url", "http");
    for text in [
        "GET /api/orders -> ",
        "GET /api/orders/{id} -> ",
        "POST /api/customers -> ",
        "DELETE /api/shipments/${id} -> ",
        "GET /api/invoices/{id}/pay -> ",
    ] {
        let found_it = found.iter().any(|(_, _, evidence)| evidence.iter().any(|line| line.contains(text)))
            || found.iter().any(|(_, _, evidence)| evidence.iter().any(|line| line.contains(&text.replace("GET", "REQUEST"))));
        assert!(found_it, "{text} in {found:?}");
    }
    assert!(found.iter().all(|(from, to, _)| from == "subproject:web" && to == "subproject:server"), "{found:?}");
}

#[test]
fn a_program_started_through_a_resolved_path_constant_is_a_process_seam_to_the_part_that_holds_it() {
    let found = seams("seam-spawn", "process");
    assert!(mentions(&found, "subproject:host", "subproject:native/index-engine", "engine-core"), "{found:?}");
    assert!(mentions(&found, "subproject:host", "subproject:workers/payments", "workers/payments"), "{found:?}");
    assert!(mentions(&found, "subproject:cli", "subproject:native/index-engine", "engine-core"), "{found:?}");
    assert!(mentions(&found, "subproject:pipeline", "subproject:tools/exporter", "exporter"), "{found:?}");
    assert!(mentions(&found, "subproject:gateway", "subproject:workers/payments", "workers/payments"), "{found:?}");
    assert!(found.iter().all(|(_, _, evidence)| evidence.iter().all(|line| !line.contains("logo"))), "{found:?}");
}

#[test]
fn an_invoke_by_name_reaches_the_command_handler_that_answers_to_that_name() {
    let found = seams("seam-ipc", "ipc");
    assert!(mentions(&found, "subproject:ui", "subproject:shell", "read_project"), "{found:?}");
    assert!(mentions(&found, "subproject:ui", "subproject:shell", "write_project"), "{found:?}");
    assert!(found.iter().all(|(_, _, evidence)| evidence.iter().all(|line| !line.contains("no_such_command"))), "{found:?}");
}

#[test]
fn an_ipc_main_handler_is_an_ipc_entry_named_by_its_channel() {
    let index = common::read("seam-ipc");
    let named: Vec<(String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "ipc")
        .map(|entry| (entry["name"].as_str().unwrap().to_string(), entry["registrar"].as_str().unwrap().to_string()))
        .collect();
    assert!(named.contains(&("load-document".to_string(), "ipcMain.handle".to_string())), "{named:?}");
    assert!(named.contains(&("close-document".to_string(), "ipcMain.on".to_string())), "{named:?}");
}

#[test]
fn each_part_reports_the_calls_it_made_and_how_many_were_followed_to_another_part() {
    let index = common::read("seam-base-url");
    let links = index["composition"]["links"].as_array().unwrap();
    let web = links.iter().find(|held| held["project"] == "subproject:web").expect("web makes calls");
    assert_eq!(web["http"]["detected"], 5, "{web}");
    assert_eq!(web["http"]["linked"], 5, "{web}");
    assert!(links.iter().all(|held| held["project"] != "subproject:server"), "{links:?}");
}

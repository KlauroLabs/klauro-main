mod common;

fn index() -> serde_json::Value {
    common::read("precise_shipping_evidence")
}

fn entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().collect()
}

fn handled_at<'a>(entries: &[&'a serde_json::Value], suffix: &str) -> Option<&'a serde_json::Value> {
    entries.iter().copied().find(|entry| {
        entry["handler"].as_str().is_some_and(|handler| handler.contains(suffix))
    })
}

#[test]
fn a_directory_copy_does_not_ship_every_file_beneath_it() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "app/scripts/dev-tool.js").is_none(),
        "a whole-directory COPY is not evidence for a script the image's CMD never names: {entries:#?}"
    );
}

#[test]
fn the_cmd_target_itself_still_ships() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "app/server.js")
        .expect("the file named by the Dockerfile's CMD is the program actually run");
    assert_eq!(found["kind"], "lifecycle");
}

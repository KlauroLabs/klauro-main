mod common;

fn imported(index: &serde_json::Value, source: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "imports" && edge["source"] == source)
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_file_records_the_namespace_it_declares() {
    let index = common::read("namespace");
    let declared: Vec<&str> = index["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|file| file["namespace"].as_str())
        .collect();
    assert!(declared.contains(&"Api.Entities"), "{declared:?}");
    assert!(declared.contains(&"Api.Controllers"), "{declared:?}");
}

#[test]
fn an_imported_namespace_reaches_what_the_importer_names_in_it() {
    let index = common::read("namespace");
    let found = imported(&index, "Api/Controllers/SeriesController.cs");
    assert_eq!(
        found,
        ["Api/Entities/Series.cs"],
        "a namespace is a lookup scope, so the import reaches the declaration it uses"
    );
}

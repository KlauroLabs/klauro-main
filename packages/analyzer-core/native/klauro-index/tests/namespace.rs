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
        [
            "Api/Entities/Catalogue.cs",
            "Api/Entities/Series.cs",
            "Api/Entities/StringExtensions.cs"
        ],
        "a namespace is a lookup scope, so the import reaches the declarations it uses"
    );
}

#[test]
fn a_declaration_is_named_by_the_types_a_file_writes_as_well_as_the_calls_it_makes() {
    let index = common::read("namespace");
    let found = imported(&index, "Api/Controllers/SeriesController.cs");
    assert!(
        found.contains(&"Api/Entities/Catalogue.cs".to_string()),
        "a field and a parameter name their type as surely as a call does: {found:?}"
    );
    assert!(
        !found.iter().any(|target| target.ends_with("Movie.cs")),
        "what the file does not name it does not reach: {found:?}"
    );
}

#[test]
fn an_extension_method_is_named_by_the_call_that_uses_it() {
    let index = common::read("namespace");
    let found = imported(&index, "Api/Controllers/SeriesController.cs");
    assert!(
        found.contains(&"Api/Entities/StringExtensions.cs".to_string()),
        "an extension is called without naming the type that holds it: {found:?}"
    );
}

#[test]
fn a_method_extending_a_type_records_what_it_extends() {
    let index = common::read("namespace");
    let extended = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "Slugify")
        .expect("the extension is declared");
    assert_eq!(extended["signature"]["receiver"], "string");
}

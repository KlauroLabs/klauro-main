mod common;

fn starts(index: &serde_json::Value) -> Vec<String> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "lifecycle")
        .filter_map(|entry| entry["handler"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn a_file_of_top_level_statements_is_where_the_program_starts() {
    let index = common::read("csharp_top_level_program");
    let starts = starts(&index);
    assert!(starts.iter().any(|handler| handler == "AppHost/Program.cs"), "{starts:#?}");
}

#[test]
fn assembly_attributes_and_types_never_start_a_program() {
    let index = common::read("csharp_top_level_program");
    let starts = starts(&index);
    assert!(starts.iter().all(|handler| !handler.starts_with("Events/")), "{starts:#?}");
}

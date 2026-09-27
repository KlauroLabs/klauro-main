mod common;

#[test]
fn a_class_that_mixes_in_a_job_runner_is_background_work() {
    let index = common::read("jobs_ruby");
    let background: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "background")
        .map(|entry| entry["handler"].as_str().unwrap())
        .collect();
    assert!(background.iter().any(|held| held.ends_with("import_worker.rb:function:perform")), "{background:?}");
}

#[test]
fn a_service_object_built_by_its_qualified_name_is_reached() {
    let index = common::read("jobs_ruby");
    assert!(common::calls(&index, "import_worker.rb:function:perform", "import_service.rb:function:call"));
}

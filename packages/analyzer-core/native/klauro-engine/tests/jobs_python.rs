mod common;

#[test]
fn a_task_registered_with_a_job_queue_is_background_work_and_tooling_is_not() {
    let index = common::read("jobs_python");
    let background: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "background")
        .map(|entry| entry["handler"].as_str().unwrap())
        .collect();
    assert!(background.iter().any(|held| held.starts_with("shop/tasks.py") && held.ends_with("expire_carts")), "{background:?}");
    assert!(!background.iter().any(|held| held.starts_with(".lint/")), "{background:?}");
    assert!(!background.iter().any(|held| held.ends_with("plain_helper")), "{background:?}");
}

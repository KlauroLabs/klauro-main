mod common;

#[test]
fn a_scheduled_task_and_a_background_service_run_their_execute_method_in_the_background() {
    let index = common::read("dotnet_background");
    let handlers: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "background")
        .map(|entry| entry["handler"].as_str().unwrap())
        .collect();
    assert!(handlers.iter().any(|handler| handler.ends_with("ExecuteAsync@CleanupTask")), "{handlers:?}");
    assert!(handlers.iter().any(|handler| handler.ends_with("ExecuteAsync@PollingWorker")), "{handlers:?}");
    assert!(!handlers.iter().any(|handler| handler.contains("Describe")), "{handlers:?}");
}

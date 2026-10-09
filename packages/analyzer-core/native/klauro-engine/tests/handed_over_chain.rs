mod common;

#[test]
fn a_long_chain_of_functions_handed_to_threads_is_walked_within_bounds() {
    let index = common::read("handed_over_chain");
    let flow = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["entry_point"].as_str().is_some_and(|entry| entry.contains("main.rs:function:main")))
        .expect("the program is a flow");
    assert_eq!(flow["cut"], true, "a walk stopped by its bound says so");
}

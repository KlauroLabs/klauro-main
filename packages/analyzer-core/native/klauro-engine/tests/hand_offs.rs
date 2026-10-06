mod common;

#[test]
fn a_call_through_a_trait_object_reaches_every_implementer() {
    let index = common::read("hand_offs");
    let reached: Vec<(&str, &str)> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls" && edge["source"].as_str().unwrap().ends_with(":function:emit_all"))
        .filter_map(|edge| Some((edge["target"].as_str()?, edge["via"].as_str()?)))
        .collect();
    assert!(reached.iter().any(|(target, via)| target.ends_with("send@AppSink") && *via == "rule"), "{reached:?}");
    assert!(reached.iter().any(|(target, via)| target.ends_with("send@HostSink") && *via == "rule"), "{reached:?}");
}

#[test]
fn a_job_sent_on_a_channel_reaches_the_loop_that_receives_it() {
    let index = common::read("hand_offs");
    let queues: Vec<(&str, &str, &str)> = index["crossings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|crossing| crossing["kind"] == "queue")
        .map(|crossing| (crossing["channel"].as_str().unwrap(), crossing["from"].as_str().unwrap(), crossing["to"].as_str().unwrap()))
        .collect();
    assert_eq!(queues.len(), 1, "{queues:?}");
    assert_eq!(queues[0].0, "Job");
    assert!(queues[0].1.ends_with(":function:send_job"));
    assert!(queues[0].2.contains(":callback:"));
}

#[test]
fn a_value_taken_out_of_a_keyed_collection_is_the_type_the_collection_holds() {
    let index = common::read("hand_offs");
    let reached = index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && edge["source"].as_str().unwrap().ends_with(":function:handle")
            && edge["target"].as_str().unwrap().ends_with(":function:run")
    });
    assert!(reached);
}

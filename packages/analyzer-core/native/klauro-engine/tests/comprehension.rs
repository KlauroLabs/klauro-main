mod common;

fn index() -> serde_json::Value {
    common::read("verified")
}

#[test]
fn a_served_surface_is_a_flow_with_the_steps_it_runs() {
    let index = index();
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let reading = flows
        .iter()
        .find(|flow| flow["operation"].as_str().unwrap().contains("store"))
        .expect("the route is a flow");
    assert!(reading["units"].as_u64().unwrap() >= 2, "{reading}");
    assert!(!reading["steps"].as_array().unwrap().is_empty(), "{reading}");
}

#[test]
fn a_flow_that_changes_nothing_is_not_terminal() {
    let index = index();
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    assert!(
        flows.iter().all(|flow| flow["standing"] != "terminal"
            || !flow["changes"].as_array().unwrap().is_empty()),
        "a terminal flow names what it changes"
    );
}

#[test]
fn an_entity_is_a_type_the_code_stores_rather_than_any_type_with_fields() {
    let index = index();
    let entities = index["comprehension"]["entities"].as_array().unwrap();
    assert!(
        entities.iter().all(|entity| entity["fields"].as_u64().unwrap() >= 1),
        "{entities:?}"
    );
}

#[test]
fn no_capability_exists_without_a_model_to_form_it() {
    let index = index();
    let capabilities = index["comprehension"]["capabilities"].as_array().unwrap();
    assert!(
        capabilities.is_empty(),
        "capabilities are formed by a model or not at all: {capabilities:?}"
    );
}

#[test]
fn no_member_carries_a_name_or_a_description_without_a_model() {
    let index = index();
    let comprehension = &index["comprehension"];
    let members: Vec<&serde_json::Value> = ["flows", "entities"]
        .into_iter()
        .flat_map(|member| comprehension[member].as_array().unwrap())
        .collect();
    assert!(!members.is_empty(), "the fixture holds members to check");
    let written: Vec<&&serde_json::Value> = members
        .iter()
        .filter(|member| !member["name"].is_null() || !member["description"].is_null())
        .collect();
    assert!(
        written.is_empty(),
        "comprehension is authored or absent, never derived: {written:?}"
    );
}

fn steps_of(index: &serde_json::Value, method: &str, surface: &str) -> Vec<String> {
    index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["method"] == method && flow["surface"] == surface)
        .unwrap_or_else(|| panic!("{method} {surface} is a flow"))["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| step["kind"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn what_a_call_does_to_its_store_is_the_step_it_takes() {
    let index = common::read("effects_basket");
    assert_eq!(steps_of(&index, "DELETE", "/basket/{id}"), vec!["remove", "respond"]);
    assert_eq!(steps_of(&index, "PUT", "/basket/{id}"), vec!["keep", "respond"]);
    assert_eq!(steps_of(&index, "GET", "/basket/{id}"), vec!["read", "respond"]);
    assert_eq!(steps_of(&index, "GET", "/orders/count/{buyer}"), vec!["read", "respond"], "opening a connection and binding a parameter change nothing");
}

#[test]
fn a_flow_ends_where_its_message_lands_in_another_part() {
    let index = common::read("seam_parts");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let paying = flows.iter().find(|flow| flow["surface"] == "/orders/{id}/pay").expect("paying is a flow");
    let kinds: Vec<&str> = paying["steps"].as_array().unwrap().iter().map(|step| step["kind"].as_str().unwrap()).collect();
    assert!(!kinds.iter().any(|kind| matches!(*kind, "change" | "create")), "the shipment is the shipping part's work, not this flow's: {kinds:?}");
    let landing: Vec<&str> = paying["leads_into"].as_array().unwrap().iter().map(|into| into.as_str().unwrap()).collect();
    assert_eq!(landing.len(), 1, "{landing:?}");
    assert!(landing[0].starts_with("entry:Shipping/OrderPaidHandler.cs:function:Handle") && landing[0].contains("OrderPaidHandler:message"), "{landing:?}");
    let shipping = flows.iter().find(|flow| flow["project"] == "subproject:Shipping").expect("receiving is a flow of its own part");
    assert!(shipping["steps"].as_array().unwrap().iter().any(|step| step["object"] == "Shipment"), "{shipping}");
}

#[test]
fn steps_on_different_arms_of_one_decision_are_marked_as_alternatives() {
    let index = common::read("seam_parts");
    let settling = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["surface"] == "/orders/{id}/settle")
        .expect("settling is a flow");
    let arms_of = |object: &str| -> Vec<String> {
        settling["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["object"] == object && step["kind"] == "raise")
            .and_then(|step| step["arms"].as_array())
            .map(|arms| arms.iter().map(|arm| arm.as_str().unwrap().to_string()).collect())
            .unwrap_or_default()
    };
    let paid = arms_of("OrderPaid");
    let refused = arms_of("OrderRefused");
    assert_eq!((paid.len(), refused.len()), (1, 1), "{settling}");
    let decision = |arm: &str| arm.rsplit_once('.').map(|(branch, _)| branch.to_string());
    assert_eq!(decision(&paid[0]), decision(&refused[0]), "both sit under the same decision");
    assert_ne!(paid[0], refused[0], "on different arms of it");
}

#[test]
fn a_call_through_a_shared_base_does_not_reach_every_subclass_override() {
    let index = common::read("dispatch_base");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let units = |surface: &str| -> Vec<String> {
        flows
            .iter()
            .find(|flow| flow["surface"] == surface)
            .unwrap_or_else(|| panic!("{surface} is a flow"))["path"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["unit"].as_str().unwrap().to_string())
            .collect()
    };
    let pulse = units("/pulse");
    assert!(pulse.iter().any(|unit| unit.contains("BaseRepository")), "the base implementation does the work: {pulse:?}");
    assert!(!pulse.iter().any(|unit| unit.contains("OrderRepository") || unit.contains("RefundRepository")), "other repositories' overrides are not this call's: {pulse:?}");
    let close = units("/close");
    assert!(close.iter().any(|unit| unit.contains("NightlyWorker")), "an abstract member still reaches its override: {close:?}");
}

#[test]
fn a_command_sent_through_a_mediator_is_a_step_and_its_handler_acts_on_the_record_its_repository_keeps() {
    let index = common::read("mediated");
    let flow = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["surface"] == "/refunds/{orderId}")
        .expect("issuing a refund is a flow");
    let steps: Vec<(String, String)> = flow["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| (step["kind"].as_str().unwrap().to_string(), step["object"].as_str().unwrap_or_default().to_string()))
        .collect();
    let expected: Vec<(String, String)> = [("send", "IssueRefundCommand"), ("read", "Refund"), ("keep", "Refund"), ("respond", "")]
        .iter()
        .map(|(kind, object)| (kind.to_string(), object.to_string()))
        .collect();
    assert_eq!(steps, expected, "one step per action: the dispatcher, the repository's internals and the commit are not steps");
}

#[test]
fn telling_listeners_through_the_parts_own_code_is_a_step() {
    let index = common::read("mediated");
    let flow = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["surface"] == "/refunds/{orderId}/remind")
        .expect("reminding is a flow");
    let kinds: Vec<&str> = flow["steps"].as_array().unwrap().iter().map(|step| step["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"notify"), "{kinds:?}");
}

#[test]
fn a_repository_call_names_the_record_its_receiver_names_in_full() {
    let index = common::read("mediated");
    let read_of = |surface: &str| -> Vec<String> {
        index["comprehension"]["flows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|flow| flow["surface"] == surface)
            .unwrap_or_else(|| panic!("{surface} is a flow"))["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["kind"] == "read")
            .map(|step| step["object"].as_str().unwrap_or_default().to_string())
            .collect()
    };
    assert_eq!(read_of("/refunds/queued"), vec!["QueuedRefund".to_string()]);
    assert_eq!(read_of("/refunds/audit"), vec!["AuditRefund".to_string()]);
}

#[test]
fn reading_one_record_on_either_arm_of_a_decision_is_one_step() {
    let index = common::read("mediated");
    let flow = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["surface"] == "/refunds/lookup/{orderId}")
        .expect("looking up a refund is a flow");
    let reads = flow["steps"].as_array().unwrap().iter().filter(|step| step["kind"] == "read").count();
    assert_eq!(reads, 1, "{flow}");
}

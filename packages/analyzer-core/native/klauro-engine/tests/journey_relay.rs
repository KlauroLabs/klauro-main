mod common;

#[test]
fn a_message_the_client_library_carries_crosses_the_relay_that_forwards_it() {
    let index = common::read("journey-relay");
    let journeys = index["journeys"].as_array().unwrap();
    let phone: Vec<Vec<&str>> = journeys
        .iter()
        .map(|journey| journey["steps"].as_array().unwrap().iter().map(|step| step["symbol"].as_str().unwrap()).collect::<Vec<_>>())
        .filter(|symbols| symbols.contains(&"sendAsk"))
        .collect();
    assert!(!phone.is_empty(), "{journeys:?}");
    let wanted = ["sendAsk", "sendData", "handleDevice", "onFrame", "chatIntent"];
    assert!(
        phone.iter().any(|symbols| {
            let mut at = 0;
            wanted.iter().all(|name| match symbols[at..].iter().position(|held| held == name) {
                Some(found) => {
                    at += found + 1;
                    true
                }
                None => false,
            })
        }),
        "{phone:?}"
    );
}

#[test]
fn journeys_do_not_repeat_each_other_and_the_representatives_differ() {
    let index = common::read("journey-relay");
    let journeys = index["journeys"].as_array().unwrap();
    let walks: Vec<Vec<&str>> = journeys
        .iter()
        .map(|journey| journey["steps"].as_array().unwrap().iter().map(|step| step["symbol"].as_str().unwrap()).collect::<Vec<_>>())
        .collect();
    for (position, walk) in walks.iter().enumerate() {
        for other in &walks[..position] {
            assert!(walk.len() > other.len() || (!other.starts_with(walk) && !other.ends_with(walk)), "{walk:?} repeats {other:?}");
        }
    }
}

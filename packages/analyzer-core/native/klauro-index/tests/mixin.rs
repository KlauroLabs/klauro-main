mod common;

#[test]
fn a_trait_a_class_uses_is_a_supertype_of_it() {
    let index = common::read("mixin");
    let found: Vec<(&str, &str)> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "extends")
        .map(|edge| {
            (
                edge["source"].as_str().unwrap(),
                edge["target"].as_str().unwrap(),
            )
        })
        .collect();
    assert!(
        found.iter().any(|(source, target)| source.contains("Contact")
            && target.contains("Sluggable")),
        "{found:?}"
    );
}

#[test]
fn a_method_a_trait_carries_answers_a_call_on_the_class_that_uses_it() {
    let index = common::read("mixin");
    let found: Vec<&str> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls" && edge["source"].as_str().unwrap().contains("label"))
        .map(|edge| edge["target"].as_str().unwrap())
        .collect();
    assert!(
        found.iter().any(|target| target.contains("Sluggable") && target.ends_with("slug:7")),
        "the class did not declare the method it calls: {found:?}"
    );
}

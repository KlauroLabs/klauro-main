mod common;

#[test]
fn a_design_pattern_is_recognised_by_its_shape_not_its_name() {
    let index = common::read("design");
    let mut found: Vec<(String, Vec<String>)> = index["patterns"]["found"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|found| found["family"] == "design")
        .map(|found| {
            let examples = found["examples"]
                .as_array()
                .map(|held| held.iter().map(|example| example.as_str().unwrap().rsplit(':').nth(2).unwrap().to_string()).collect())
                .unwrap_or_default();
            (found["pattern"].as_str().unwrap().to_string(), examples)
        })
        .collect();
    found.sort();
    let expected: Vec<(String, Vec<String>)> = vec![
        ("builder", vec!["QueryBuilder"]),
        ("composite", vec!["BroadcastNotifier"]),
        ("decorator", vec!["LoggingNotifier"]),
        ("factory", vec!["NotifierFactory"]),
        ("singleton", vec!["Settings"]),
        ("strategy", vec!["Notifier"]),
    ]
    .into_iter()
    .map(|(pattern, examples)| (pattern.to_string(), examples.into_iter().map(str::to_string).collect()))
    .collect();
    assert_eq!(found, expected);
}

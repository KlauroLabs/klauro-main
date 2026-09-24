mod common;

#[test]
fn a_request_is_read_down_through_every_layer_to_the_service_it_reaches() {
    let index = common::read("layers");
    let paths: Vec<(Vec<String>, u64)> = index["layering"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|layering| layering["paths"].as_array().unwrap().clone())
        .map(|path| {
            let layers = path["layers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|layer| layer.as_str().unwrap().to_string())
                .collect();
            (layers, path["arrivals"].as_u64().unwrap())
        })
        .collect();
    assert_eq!(
        paths,
        vec![(
            vec![
                "http entry".to_string(),
                "controller".to_string(),
                "service".to_string(),
                "repository".to_string(),
                "database: PostgreSQL".to_string(),
            ],
            1
        )]
    );
}

#[test]
fn a_call_through_a_data_context_is_a_call_to_the_database() {
    let index = common::read("layers");
    let kept: Vec<String> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["kind"] == "database")
        .map(|exit| format!("{} {}", exit["operation"].as_str().unwrap(), exit["service"].as_str().unwrap_or("")))
        .collect();
    assert_eq!(kept, vec!["ToListAsync PostgreSQL"]);
}

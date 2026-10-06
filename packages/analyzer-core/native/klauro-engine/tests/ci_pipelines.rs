mod common;

use serde_json::Value;

fn pipeline<'a>(index: &'a Value, provider: &str) -> &'a Value {
    index["ci"]
        .as_array()
        .unwrap()
        .iter()
        .find(|held| held["provider"] == provider)
        .unwrap_or_else(|| panic!("a {provider} pipeline"))
}

fn job<'a>(pipeline: &'a Value, name: &str) -> &'a Value {
    pipeline["jobs"].as_array().unwrap().iter().find(|held| held["name"] == name).unwrap()
}

#[test]
fn a_workflow_reads_as_triggers_jobs_ordered_steps_and_a_deploy_target() {
    let index = common::read("ci-pipelines");
    let release = pipeline(&index, "github-actions");
    let events: Vec<&str> = release["triggers"].as_array().unwrap().iter().map(|held| held["event"].as_str().unwrap()).collect();
    assert_eq!(events, vec!["push", "schedule"]);
    assert_eq!(release["triggers"][1]["schedule"], "0 2 * * *");
    let build = job(release, "build");
    assert_eq!(build["steps"][0]["action"], "actions/checkout@v4");
    assert_eq!(build["steps"][1]["command"], "npm test");
    assert_eq!(build["steps"][1]["purpose"], "test");
    let deploy = job(release, "deploy");
    assert_eq!(deploy["needs"][0], "build");
    assert_eq!(deploy["depends_on"][0]["job"], build["id"]);
    assert_eq!(deploy["steps"][0]["purpose"], "deploy");
    assert_eq!(deploy["steps"][0]["deploy_target"], "production");
}

#[test]
fn a_gitlab_pipeline_orders_jobs_by_stage_and_reads_schedule_rules() {
    let index = common::read("ci-pipelines");
    let gitlab = pipeline(&index, "gitlab-ci");
    let deploy = job(gitlab, "deploy_prod");
    assert_eq!(deploy["depends_on"][0]["reason"], "stage");
    assert_eq!(deploy["steps"][0]["deploy_target"], "prod");
    assert_eq!(deploy["secret_refs"][0], "DEPLOY_TOKEN");
    assert_eq!(gitlab["triggers"][0]["kind"], "schedule");
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("klauro-ci-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".github/workflows")).unwrap();
    dir
}

fn read_directory(dir: &std::path::Path) -> Value {
    let binary = std::path::PathBuf::from(env!("CARGO_BIN_EXE_klauro-engine"));
    let started = std::time::Instant::now();
    let output = std::process::Command::new(binary).arg(dir).output().expect("index runs");
    assert!(output.status.success());
    assert!(started.elapsed().as_secs() < 20);
    common::rehydrate_stream(&output.stdout)
}

fn pipelines(index: &Value) -> usize {
    index["ci"].as_array().map_or(0, Vec::len)
}

#[test]
fn a_reference_outside_the_root_contributes_nothing() {
    let dir = scratch("outside");
    std::fs::write(
        dir.join(".github/workflows/a.yml"),
        "on: push\ninclude: ../../etc/passwd\njobs:\n  build:\n    steps:\n      - uses: ../../../etc/passwd\n      - run: npm test\n",
    )
    .unwrap();
    let index = read_directory(&dir);
    let rendered = serde_json::to_string(&index["ci"]).unwrap();
    assert!(!rendered.contains("root:"));
    assert_eq!(pipelines(&index), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_workflow_that_is_a_symlink_out_of_the_root_is_not_read() {
    let dir = scratch("link");
    let outside = std::env::temp_dir().join(format!("klauro-ci-secret-{}.yml", std::process::id()));
    std::fs::write(&outside, "on: push\njobs:\n  leaked:\n    steps:\n      - run: echo hi\n").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join(".github/workflows/b.yml")).unwrap();
    let index = read_directory(&dir);
    assert_eq!(pipelines(&index), 0);
    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::remove_file(&outside).unwrap();
}

#[test]
fn a_deeply_nested_document_is_unreadable_not_a_crash() {
    let dir = scratch("deep");
    let nested = format!("on: push\njobs:\n  build:\n    steps:\n      - run: x\nx: {}1{}\n", "[".repeat(50_000), "]".repeat(50_000));
    std::fs::write(dir.join(".github/workflows/c.yml"), nested).unwrap();
    let index = read_directory(&dir);
    assert_eq!(pipelines(&index), 0);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_alias_bomb_does_not_expand() {
    let dir = scratch("bomb");
    let mut text = String::from("on: push\nl0: &l0 [x, x, x, x, x, x, x, x, x]\n");
    for level in 1..30 {
        let previous = level - 1;
        text.push_str(&format!("l{level}: &l{level} [*l{previous}, *l{previous}, *l{previous}, *l{previous}, *l{previous}, *l{previous}, *l{previous}, *l{previous}, *l{previous}]\n"));
    }
    text.push_str("jobs:\n  build:\n    steps:\n      - run: npm test\n");
    std::fs::write(dir.join(".github/workflows/d.yml"), text).unwrap();
    let index = read_directory(&dir);
    assert_eq!(pipelines(&index), 1);
    assert_eq!(index["ci"][0]["jobs"][0]["steps"][0]["command"], "npm test");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_oversized_file_is_not_read() {
    let dir = scratch("big");
    let filler = "# padding\n".repeat(200_000);
    std::fs::write(dir.join(".github/workflows/e.yml"), format!("on: push\njobs:\n  build:\n    steps:\n      - run: x\n{filler}")).unwrap();
    let index = read_directory(&dir);
    assert_eq!(pipelines(&index), 0);
    std::fs::remove_dir_all(&dir).unwrap();
}

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

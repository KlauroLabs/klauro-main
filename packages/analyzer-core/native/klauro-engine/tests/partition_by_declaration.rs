mod common;

use serde_json::Value;

fn projects(fixture: &str) -> Vec<Value> {
    let index = common::read(fixture);
    index["partition"]["sub_projects"].as_array().unwrap().clone()
}

fn project<'a>(all: &'a [Value], root: &str) -> &'a Value {
    all.iter()
        .find(|part| part["root"] == root)
        .unwrap_or_else(|| panic!("{root} is a sub-project: {:?}", all.iter().map(|part| &part["root"]).collect::<Vec<_>>()))
}

#[test]
fn a_package_built_into_a_whole_repository_image_is_still_its_own_sub_project() {
    let all = projects("partition_whole");
    for root in ["packages/a", "packages/b", "packages/b/native/crate", "packages/c", "packages/d"] {
        project(&all, root);
    }
    assert!(all.iter().all(|part| part["ship_backed"] == false), "copying everything names no project: {all:?}");
}

#[test]
fn a_nested_crate_is_its_own_sub_project_and_takes_its_own_files() {
    let all = projects("partition_whole");
    let outer = project(&all, "packages/b");
    let inner = project(&all, "packages/b/native/crate");
    assert_eq!(outer["declared_by"], "workspace-member");
    assert_eq!(inner["declared_by"], "module-manifest");
    assert_eq!(outer["files"], 2);
    assert_eq!(inner["files"], 2);
    assert_eq!(inner["declarations"], 1);
}

#[test]
fn packages_the_image_names_one_by_one_are_deployables_and_the_rest_are_not() {
    let all = projects("partition_named");
    for root in ["packages/a", "packages/b"] {
        let part = project(&all, root);
        assert_eq!(part["ship_backed"], true, "{root}");
        assert_eq!(part["status"], "deployable", "{root}");
    }
    for root in ["packages/b/native/crate", "packages/c", "packages/d"] {
        assert_eq!(project(&all, root)["ship_backed"], false, "{root}");
    }
}

#[test]
fn a_dockerfile_that_copies_one_package_makes_only_that_package_a_deployable() {
    let all = projects("partition_per");
    let shipped: Vec<&str> = all
        .iter()
        .filter(|part| part["ship_backed"] == true)
        .map(|part| part["root"].as_str().unwrap())
        .collect();
    assert_eq!(shipped, vec!["packages/c"]);
    assert_eq!(project(&all, "packages/c")["status"], "deployable");
}

#[test]
fn a_project_is_labelled_by_what_it_does_not_by_a_stored_type() {
    let all = projects("partition_whole");
    assert_eq!(project(&all, "packages/c")["status"], "executable", "it starts and nothing ships it");
    assert_eq!(project(&all, "packages/a")["status"], "library", "another project imports into it");
    assert_eq!(project(&all, "packages/d")["status"], "module", "declared, owned, not reached");
    assert_eq!(project(&all, "packages/b")["status"], "module");
}

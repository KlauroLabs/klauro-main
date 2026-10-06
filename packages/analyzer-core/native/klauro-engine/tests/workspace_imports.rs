mod common;

use serde_json::Value;

fn imports(index: &Value, source: &str, target: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "imports" && edge["source"] == source && edge["target"] == target
    })
}

#[test]
fn a_package_named_in_a_sibling_manifest_resolves_to_its_declared_entry() {
    let index = common::read("workspace_imports/js");
    assert!(imports(&index, "apps/a/src/index.ts", "libs/auth/src/index.ts"));
    assert!(imports(&index, "apps/a/src/index.ts", "libs/ui/src/ui.ts"));
}

#[test]
fn a_deep_import_below_a_workspace_package_reaches_the_file_under_its_source_folder() {
    let index = common::read("workspace_imports/js");
    assert!(imports(&index, "apps/a/src/index.ts", "libs/ui/src/deep.ts"));
    assert!(common::calls(&index, "apps/a/src/index.ts:variable:x", "libs/auth/src/index.ts:class:Guard") || {
        index["edges"].as_array().unwrap().iter().any(|edge| {
            edge["kind"] == "instantiates" && edge["target"] == "libs/auth/src/index.ts:class:Guard"
        })
    });
}

#[test]
fn a_python_path_dependency_makes_its_package_importable() {
    let index = common::read("workspace_imports/py");
    assert!(imports(&index, "apps/svc/src/svc/main.py", "libs/auth/src/fixture_auth/__init__.py"));
}

#[test]
fn a_go_replace_directive_points_the_module_at_its_local_directory() {
    let index = common::read("workspace_imports/go");
    assert!(imports(&index, "app/main.go", "lib/lib.go"));
    assert!(common::calls(&index, "app/main.go:function:main", "lib/lib.go:function:Check"));
}

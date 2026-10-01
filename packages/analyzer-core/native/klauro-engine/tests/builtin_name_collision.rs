mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("builtin-name-collision")
}

fn targets_of(index: &serde_json::Value, source: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls" && common::names(edge["source"].as_str().unwrap(), source))
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn an_untyped_standard_call_is_not_captured_by_the_one_hand_written_method_of_that_name() {
    let index = index();
    for caller in ["misc.ts:function:slugify", "misc.ts:function:escapeTitle"] {
        assert!(
            !calls(&index, caller, "asset-edit.repository.ts:method:replaceAll"),
            "{caller} calls replaceAll on a value of unknown type: {:?}",
            targets_of(&index, caller)
        );
        assert!(
            targets_of(&index, caller).iter().any(|target| target == "runtime:String:String.replaceAll"),
            "{caller} should fall back to the runtime member: {:?}",
            targets_of(&index, caller)
        );
    }
}

#[test]
fn a_receiver_that_names_the_declaring_type_still_reaches_the_hand_written_method() {
    let index = index();
    assert!(
        calls(&index, "edits.ts:function:syncEdits", "asset-edit.repository.ts:method:replaceAll"),
        "{:?}",
        targets_of(&index, "edits.ts:function:syncEdits")
    );
}

#[test]
fn a_typed_receiver_still_reaches_the_hand_written_method() {
    let index = index();
    assert!(
        calls(&index, "edits.ts:method:reset", "asset-edit.repository.ts:method:replaceAll"),
        "{:?}",
        targets_of(&index, "edits.ts:method:reset")
    );
}

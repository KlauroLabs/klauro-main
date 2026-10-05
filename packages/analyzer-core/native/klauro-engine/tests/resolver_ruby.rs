mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("resolver_ruby")
}

fn reaches(index: &serde_json::Value, source: &str, fragment: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && common::names(edge["source"].as_str().unwrap(), source)
            && edge["target"].as_str().unwrap().contains(fragment)
    })
}

#[test]
fn a_method_called_on_a_new_instance_reaches_the_method_of_that_class() {
    let index = index();
    assert!(calls(&index, "report.rb:function:chained", "item.rb:function:total"));
    assert!(!calls(&index, "report.rb:function:chained", "other.rb:function:total"));
}

#[test]
fn a_literal_receiver_is_a_standard_type() {
    assert!(reaches(&index(), "report.rb:function:literal", "String.upcase"));
}

#[test]
fn a_class_method_the_class_does_not_declare_is_a_library_call_not_a_guess() {
    let index = index();
    assert!(reaches(&index, "report.rb:function:library", "ruby.where"));
    assert!(!calls(&index, "report.rb:function:library", "item.rb:function:total"));
}

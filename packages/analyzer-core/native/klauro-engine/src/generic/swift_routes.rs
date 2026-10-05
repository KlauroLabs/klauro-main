use tree_sitter::Node;

use super::{Extractor, REQUEST_METHODS, trim_quotes};

impl<'a> Extractor<'a> {
    pub(super) fn swift_arguments<'t>(&self, call: Node<'t>) -> Option<Node<'t>> {
        if self.spec.id != "swift" {
            return None;
        }
        let mut cursor = call.walk();
        let suffix = call.named_children(&mut cursor).find(|child| child.kind() == "call_suffix")?;
        let mut inner = suffix.walk();
        suffix.named_children(&mut inner).find(|child| child.kind() == "value_arguments")
    }

    pub(super) fn swift_trailing_closure<'t>(&self, call: Node<'t>) -> Option<Node<'t>> {
        if self.spec.id != "swift" {
            return None;
        }
        let mut cursor = call.walk();
        let suffix = call.named_children(&mut cursor).find(|child| child.kind() == "call_suffix")?;
        let mut inner = suffix.walk();
        suffix.named_children(&mut inner).find(|child| child.kind() == "lambda_literal")
    }

    pub(super) fn swift_path(&self, arguments: Option<Node>) -> String {
        let mut components: Vec<String> = Vec::new();
        if let Some(arguments) = arguments {
            let mut cursor = arguments.walk();
            for argument in arguments.named_children(&mut cursor) {
                if argument.child_by_field_name("name").is_some() {
                    continue;
                }
                let Some(value) = argument.child_by_field_name("value") else { continue };
                if value.kind().contains("string") {
                    let written = trim_quotes(self.text(value)).trim_matches('/');
                    if !written.is_empty() {
                        components.push(written.to_string());
                    }
                }
            }
        }
        match components.is_empty() {
            true => "/".to_string(),
            false => format!("/{}", components.join("/")),
        }
    }

    pub(super) fn swift_names_a_verb(&self, callee: &str) -> bool {
        self.spec.id == "swift" && REQUEST_METHODS.binary_search(&callee.to_ascii_lowercase().as_str()).is_ok()
    }
}

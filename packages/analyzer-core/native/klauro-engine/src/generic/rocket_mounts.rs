use tree_sitter::Node;

use super::{Extractor, trim_quotes};
use crate::model::RegistrationFact;

fn written_path(item: &str) -> Option<&str> {
    let item = item.trim();
    let spoken = !item.is_empty() && item.chars().all(|held| held.is_alphanumeric() || matches!(held, '_' | ':'));
    spoken.then_some(item)
}

impl<'a> Extractor<'a> {
    pub(super) fn declare_mounted_routes(&mut self, call: Node) {
        if self.spec.id != "rust" {
            return;
        }
        let Some(function) = call.child_by_field_name("function").filter(|function| function.kind() == "field_expression") else {
            return;
        };
        if function.child_by_field_name("field").map(|field| self.text(field)) != Some("mount") {
            return;
        }
        let arguments = self.argument_nodes(call);
        let [base, listed] = arguments.as_slice() else { return };
        if base.kind() != "string_literal" || listed.kind() != "macro_invocation" {
            return;
        }
        let names_routes = listed.child_by_field_name("macro").map(|held| self.text(held).rsplit("::").next().unwrap_or_default()) == Some("routes");
        if !names_routes {
            return;
        }
        let mut cursor = listed.walk();
        let Some(tokens) = listed.named_children(&mut cursor).find(|child| child.kind() == "token_tree") else { return };
        let text = self.text(tokens).trim();
        let Some(inner) = text.strip_prefix(['[', '(', '{']).and_then(|held| held.strip_suffix([']', ')', '}'])) else { return };
        let label = trim_quotes(self.text(*base)).to_string();
        self.attached_routes.insert(call.id());
        for item in inner.split(',').filter_map(written_path) {
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar: "mount".to_string(),
                label: label.clone(),
                handler: item.to_string(),
                line: call.start_position().row as u32 + 1,
                through: Vec::new(),
            });
        }
    }
}

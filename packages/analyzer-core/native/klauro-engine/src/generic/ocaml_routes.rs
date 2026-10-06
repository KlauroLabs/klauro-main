use tree_sitter::Node;

use super::{Extractor, REQUEST_METHODS, trim_quotes};

const SCOPES: &[&str] = &["scope"];

impl<'a> Extractor<'a> {
    pub(super) fn ocaml_route(&mut self, call: Node, receiver: &Option<String>, callee: &str) -> bool {
        if self.spec.id != "ocaml" || REQUEST_METHODS.binary_search(&callee).is_err() {
            return false;
        }
        let arguments = self.applied_to(call);
        let Some(path) = arguments.first().and_then(|argument| self.route_literal(*argument)) else { return false };
        let Some(handler) = arguments.get(1).copied() else { return false };
        let registrar = match receiver {
            Some(receiver) => format!("{receiver}.{callee}"),
            None => callee.to_string(),
        };
        let label = join_paths(&self.dream_scope_prefix(call), &path);
        if let Some(inline) = self.handled_inline(handler) {
            self.labelled.insert(inline.id(), (registrar, label, Vec::new()));
            return true;
        }
        let Some(name) = self.handler_name(handler) else { return false };
        self.facts.registrations.push(crate::model::RegistrationFact {
            file: self.file,
            registrar,
            label,
            handler: name,
            line: call.start_position().row as u32 + 1,
            through: Vec::new(),
        });
        true
    }

    fn handler_name(&self, handler: Node) -> Option<String> {
        match handler.kind() {
            "value_path" => handler.named_child(u32::try_from(handler.named_child_count().checked_sub(1)?).ok()?).map(|last| self.text(last).to_string()),
            _ => self.referenced_names(handler, 0).into_iter().next(),
        }
    }

    fn applied_to<'t>(&self, call: Node<'t>) -> Vec<Node<'t>> {
        let mut cursor = call.walk();
        call.children_by_field_name("argument", &mut cursor).collect()
    }

    fn route_literal(&self, argument: Node) -> Option<String> {
        (argument.kind() == "string")
            .then(|| trim_quotes(self.text(argument)).to_string())
            .filter(|written| written.starts_with('/'))
    }

    fn dream_scope_prefix(&self, call: Node) -> String {
        let mut segments: Vec<String> = Vec::new();
        let mut enclosing = call.parent();
        while let Some(held) = enclosing {
            if held.kind() == "application_expression"
                && held
                    .child_by_field_name("function")
                    .is_some_and(|function| SCOPES.contains(&crate::names::leaf(self.text(function))))
                && let Some(path) = self.applied_to(held).first().and_then(|argument| self.route_literal(*argument))
            {
                segments.push(path);
            }
            enclosing = held.parent();
        }
        segments.reverse();
        segments.iter().fold(String::new(), |base, next| join_paths(&base, next))
    }
}

fn join_paths(prefix: &str, path: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match (prefix.is_empty(), path.is_empty()) {
        (true, _) => format!("/{path}"),
        (false, true) => prefix.to_string(),
        (false, false) => format!("{prefix}/{path}"),
    }
}

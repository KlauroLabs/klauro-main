use tree_sitter::Node;

use super::{Extractor, trim_quotes};
use crate::model::RegistrationFact;

static VERBS: &[&str] = &["delete", "get", "head", "options", "patch", "post", "put"];
static COMPOSES: &[&str] = &["configure", "resource", "scope", "service"];

impl<'a> Extractor<'a> {
    pub(super) fn declare_attached_route(&mut self, call: Node) {
        if self.spec.id != "rust" {
            return;
        }
        let Some(function) = call.child_by_field_name("function").filter(|function| function.kind() == "field_expression") else {
            return;
        };
        if function.child_by_field_name("field").map(|field| self.text(field)) != Some("route") {
            return;
        }
        let arguments = self.argument_nodes(call);
        let (written, served) = match arguments.as_slice() {
            [path, served] if path.kind() == "string_literal" => (Some(trim_quotes(self.text(*path)).to_string()), *served),
            [served] => (None, *served),
            _ => return,
        };
        let Some((verb, handler)) = self.verb_served_by(served) else { return };
        let receiver = function.child_by_field_name("value");
        let path = match written {
            Some(path) => path,
            None => match receiver.and_then(|chain| self.resource_of(chain)) {
                Some(path) => path,
                None => return,
            },
        };
        let prefix = self.scope_prefix(call);
        self.attached_routes.insert(call.id());
        let label = format!("{} {}", verb.to_ascii_uppercase(), join(&prefix, &path));
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: "route".to_string(),
            label,
            handler,
            line: call.start_position().row as u32 + 1,
            through: Vec::new(),
        });
    }

    pub(super) fn composes_routes(&self, call: Node, callee: &str) -> bool {
        self.attached_routes.contains(&call.id())
            || (self.spec.id == "rust" && COMPOSES.contains(&crate::names::leaf(callee)))
    }

    fn argument_nodes<'t>(&self, call: Node<'t>) -> Vec<Node<'t>> {
        let Some(arguments) = call.child_by_field_name("arguments") else { return Vec::new() };
        let mut cursor = arguments.walk();
        arguments.named_children(&mut cursor).collect()
    }

    fn verb_served_by(&self, served: Node) -> Option<(String, String)> {
        let attached = served.child_by_field_name("function").filter(|function| function.kind() == "field_expression")?;
        if !matches!(attached.child_by_field_name("field").map(|field| self.text(field)), Some("to" | "to_async")) {
            return None;
        }
        let verb_call = attached.child_by_field_name("value").filter(|held| held.kind() == "call_expression")?;
        let named = self.text(verb_call.child_by_field_name("function")?);
        let verb = named.rsplit("::").next()?;
        VERBS.contains(&verb).then_some(())?;
        let handler = self.argument_nodes(served).first().map(|held| self.text(*held).rsplit("::").next().unwrap_or_default().to_string())?;
        (!handler.is_empty()).then_some((verb.to_string(), handler))
    }

    fn root_call<'t>(&self, mut chain: Node<'t>) -> Node<'t> {
        while let Some(function) = chain.child_by_field_name("function").filter(|function| function.kind() == "field_expression") {
            match function.child_by_field_name("value") {
                Some(inner) if inner.kind() == "call_expression" => chain = inner,
                _ => break,
            }
        }
        chain
    }

    fn named_root(&self, chain: Node, wanted: &str) -> Option<String> {
        let root = self.root_call(chain);
        let function = self.text(root.child_by_field_name("function")?);
        if function.rsplit("::").next() != Some(wanted) {
            return None;
        }
        let first = self.argument_nodes(root).into_iter().next()?;
        (first.kind() == "string_literal").then(|| trim_quotes(self.text(first)).to_string())
    }

    fn resource_of(&self, chain: Node) -> Option<String> {
        self.named_root(chain, "resource")
    }

    fn scope_prefix(&self, call: Node) -> String {
        let mut prefix = String::new();
        let mut chain = call;
        for _ in 0..8 {
            if let Some(scope) = self.named_root(chain, "scope") {
                prefix = join(&scope, &prefix);
            }
            let outer = chain
                .parent()
                .filter(|held| held.kind() == "arguments")
                .and_then(|held| held.parent())
                .filter(|held| held.kind() == "call_expression");
            match outer {
                Some(next) => chain = next,
                None => break,
            }
        }
        prefix
    }
}

fn join(prefix: &str, path: &str) -> String {
    let joined = format!("{}/{}", prefix.trim_end_matches('/'), path.trim_start_matches('/'));
    let joined = joined.trim_end_matches('/');
    match joined.starts_with('/') {
        true => joined.to_string(),
        false => format!("/{joined}"),
    }
}

#[cfg(test)]
mod tests {
    use super::join;

    #[test]
    fn a_scope_and_a_path_make_one_route() {
        assert_eq!(join("/api", "/items"), "/api/items");
        assert_eq!(join("", "/users"), "/users");
        assert_eq!(join("/api", "/"), "/api");
        assert_eq!(join("", ""), "/");
    }
}

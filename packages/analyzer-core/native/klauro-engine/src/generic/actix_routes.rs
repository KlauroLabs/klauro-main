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
            [path, served] if path.kind() == "string_literal" => (Some(vec![trim_quotes(self.text(*path)).to_string()]), *served),
            [served] => (None, *served),
            _ => return,
        };
        let Some((verb, handler)) = self.verb_served_by(served) else { return };
        let receiver = function.child_by_field_name("value");
        let paths = match written {
            Some(path) => path,
            None => match receiver.map(|chain| self.resource_of(chain)).filter(|found| !found.is_empty()) {
                Some(paths) => paths,
                None => return,
            },
        };
        let prefix = self.scope_prefix(call);
        self.attached_routes.insert(call.id());
        for path in paths {
            let label = format!("{} {}", verb.to_ascii_uppercase(), join(&prefix, &path));
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar: "route".to_string(),
                label,
                handler: handler.clone(),
                line: call.start_position().row as u32 + 1,
                through: Vec::new(),
            });
        }
    }

    pub(super) fn composes_routes(&self, call: Node, callee: &str) -> bool {
        self.attached_routes.contains(&call.id())
            || (self.spec.id == "rust" && COMPOSES.contains(&crate::names::leaf(callee)))
    }

    pub(super) fn argument_nodes<'t>(&self, call: Node<'t>) -> Vec<Node<'t>> {
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

    fn named_root(&self, chain: Node, wanted: &str) -> Vec<String> {
        let root = self.root_call(chain);
        let Some(function) = root.child_by_field_name("function").map(|held| self.text(held)) else { return Vec::new() };
        if function.rsplit("::").next() != Some(wanted) {
            return Vec::new();
        }
        let Some(first) = self.argument_nodes(root).into_iter().next() else { return Vec::new() };
        match first.kind() {
            "string_literal" => vec![trim_quotes(self.text(first)).to_string()],
            "array_expression" => {
                let mut cursor = first.walk();
                first
                    .named_children(&mut cursor)
                    .filter(|element| element.kind() == "string_literal")
                    .map(|element| trim_quotes(self.text(element)).to_string())
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn resource_of(&self, chain: Node) -> Vec<String> {
        self.named_root(chain, "resource")
    }

    fn chain_end<'t>(&self, mut chain: Node<'t>) -> Node<'t> {
        while let Some(next) = chain
            .parent()
            .filter(|held| held.kind() == "field_expression" && held.child_by_field_name("value").map(|value| value.id()) == Some(chain.id()))
            .and_then(|held| held.parent())
            .filter(|held| held.kind() == "call_expression")
        {
            chain = next;
        }
        chain
    }

    fn scope_prefix(&self, call: Node) -> String {
        let mut prefix = String::new();
        let mut chain = self.chain_end(call);
        for _ in 0..8 {
            if let Some(scope) = self.named_root(chain, "scope").first() {
                prefix = join(scope, &prefix);
            }
            let outer = chain
                .parent()
                .filter(|held| held.kind() == "arguments")
                .and_then(|held| held.parent())
                .filter(|held| held.kind() == "call_expression");
            match outer {
                Some(next) => chain = self.chain_end(next),
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

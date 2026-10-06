use tree_sitter::Node;

use super::{Extractor, REQUEST_METHODS, trim_quotes};

impl<'a> Extractor<'a> {
    pub(super) fn ktor_route<'t>(&self, call: Node<'t>, callee: &str) -> Option<(String, Node<'t>)> {
        if self.spec.id != "kotlin" || REQUEST_METHODS.binary_search(&callee.to_ascii_lowercase().as_str()).is_err() {
            return None;
        }
        if !self.ktor_callee(call).is_some_and(|named| named == callee) {
            return None;
        }
        let mut cursor = call.walk();
        let block = call.named_children(&mut cursor).find(|child| child.kind() == "annotated_lambda")?;
        let (routed, prefix) = self.ktor_enclosing(call);
        routed.then(|| (self.ktor_joined(&prefix, &self.ktor_path_of(call).unwrap_or_default()), block))
    }

    fn ktor_enclosing(&self, call: Node) -> (bool, Vec<String>) {
        let mut prefix: Vec<String> = Vec::new();
        let mut routed = false;
        let mut enclosing = call.parent();
        while let Some(held) = enclosing {
            match held.kind() {
                "call_expression" => match self.ktor_callee(held) {
                    Some("routing") => routed = true,
                    Some("route") => {
                        routed = true;
                        prefix.push(self.ktor_path_of(held).unwrap_or_default());
                    }
                    _ => {}
                },
                "function_declaration" if self.ktor_extends_a_route(held) => routed = true,
                _ => {}
            }
            enclosing = held.parent();
        }
        prefix.reverse();
        (routed, prefix)
    }

    fn ktor_head<'t>(&self, call: Node<'t>) -> Option<Node<'t>> {
        let first = call.named_child(0)?;
        match first.kind() {
            "identifier" => Some(call),
            "call_expression" if first.named_child(0).is_some_and(|inner| inner.kind() == "identifier") => Some(first),
            _ => None,
        }
    }

    fn ktor_callee(&self, call: Node) -> Option<&'a str> {
        let head = self.ktor_head(call)?;
        Some(self.text(head.named_child(0)?))
    }

    fn ktor_extends_a_route(&self, declaration: Node) -> bool {
        let written = self.text(declaration);
        let header = written.split('(').next().unwrap_or(written);
        header.contains("Route.") || header.contains("Routing.")
    }

    fn ktor_path_of(&self, call: Node) -> Option<String> {
        let head = self.ktor_head(call)?;
        let mut cursor = head.walk();
        let arguments = head.named_children(&mut cursor).find(|child| child.kind() == "value_arguments")?;
        let mut inner = arguments.walk();
        let first = arguments.named_children(&mut inner).next()?;
        let mut parts = first.walk();
        let literal = first.named_children(&mut parts).find(|child| child.kind() == "string_literal")?;
        Some(trim_quotes(self.text(literal)).to_string())
    }

    fn ktor_joined(&self, prefix: &[String], own: &str) -> String {
        let joined: Vec<&str> = prefix.iter().map(String::as_str).chain([own]).map(|held| held.trim_matches('/')).filter(|held| !held.is_empty()).collect();
        format!("/{}", joined.join("/"))
    }
}

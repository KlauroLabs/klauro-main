use tree_sitter::Node;

use super::{trim_quotes, Extractor, Scope};
use crate::messages::{a_discriminant, a_tag, the_discriminant_in};
use crate::model::*;

fn quoted_strings(text: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut open: Option<usize> = None;
    let mut escaped = false;
    for (at, letter) in text.char_indices() {
        match (open, letter) {
            (Some(_), _) if escaped => escaped = false,
            (Some(_), '\\') => escaped = true,
            (Some(start), '"') => {
                found.push((start + 1, at));
                open = None;
            }
            (None, '"') => open = Some(at),
            _ => {}
        }
    }
    found
}

fn tag_told_in(text: &str) -> Option<&str> {
    let strings = quoted_strings(text);
    strings.windows(2).find_map(|pair| {
        let (key, value) = (&text[pair[0].0..pair[0].1], &text[pair[1].0..pair[1].1]);
        let between = text[pair[0].1 + 1..pair[1].0 - 1].trim();
        (between == ":" && a_discriminant(key)).then(|| a_tag(value)).flatten()
    })
}

impl Extractor<'_> {
    fn handed_to_a_delivery(&self, argument: Node) -> bool {
        let mut held = argument.parent();
        while let Some(parent) = held {
            if parent.kind() == "call_expression" {
                return parent
                    .child_by_field_name("function")
                    .is_some_and(|function| crate::messages::a_delivery(self.text(function).trim()));
            }
            if matches!(parent.kind(), "block" | "function_item" | "let_declaration") {
                return false;
            }
            held = parent.parent();
        }
        false
    }

    fn returned_as_a_frame(&self, value: Node) -> bool {
        let Some(block) = value.parent().filter(|parent| parent.kind() == "block") else { return false };
        let last = {
            let mut cursor = block.walk();
            block.named_children(&mut cursor).last()
        };
        last.is_some_and(|held| held.id() == value.id()) && block.parent().is_some_and(|parent| parent.kind() == "function_item")
    }

    pub(super) fn note_rust_messages(&mut self, node: Node, scope: &Scope) {
        let Some(unit) = scope.callable.clone() else { return };
        match node.kind() {
            "macro_invocation" => {
                let named_json = node
                    .child_by_field_name("macro")
                    .is_some_and(|name| self.text(name).trim().rsplit("::").next() == Some("json"));
                if !named_json || !(self.handed_to_a_delivery(node) || self.returned_as_a_frame(node)) {
                    return;
                }
                if let Some(tag) = tag_told_in(self.text(node)) {
                    let line = node.start_position().row as u32 + 1;
                    self.facts.messages.push(MessageFact {
                        file: self.file,
                        unit,
                        tag: tag.to_string(),
                        said: Said::Sent,
                        line,
                        end_line: line,
                    });
                }
            }
            "match_expression" => {
                let Some(subject) = node.child_by_field_name("value") else { return };
                let Some(body) = node.child_by_field_name("body") else { return };
                if !the_discriminant_in(self.text(subject)) {
                    return;
                }
                let mut cursor = body.walk();
                for arm in body.named_children(&mut cursor).filter(|arm| arm.kind() == "match_arm") {
                    let Some(pattern) = arm.child_by_field_name("pattern") else { continue };
                    let mut strings = Vec::new();
                    let mut pending = vec![pattern];
                    while let Some(held) = pending.pop() {
                        match held.kind() {
                            "string_literal" => strings.push(held),
                            _ => {
                                let mut inner = held.walk();
                                pending.extend(held.named_children(&mut inner));
                            }
                        }
                    }
                    for written in strings {
                        if let Some(tag) = a_tag(trim_quotes(self.text(written))) {
                            self.facts.messages.push(MessageFact {
                                file: self.file,
                                unit: unit.clone(),
                                tag: tag.to_string(),
                                said: Said::Handled,
                                line: arm.start_position().row as u32 + 1,
                                end_line: arm.end_position().row as u32 + 1,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tag_told_in;

    #[test]
    fn a_json_object_tells_its_tag_by_the_discriminant_key() {
        assert_eq!(tag_told_in(r#"json!({ "t": "data", "to": dev })"#), Some("data"));
        assert_eq!(tag_told_in(r#"json!({"to": "dev", "type":"prompt"})"#), Some("prompt"));
        assert_eq!(tag_told_in(r#"json!({ "text": "hello there" })"#), None);
    }
}

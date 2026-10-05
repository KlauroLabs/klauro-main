use tree_sitter::Node;

use super::{addressing, line_of, trim_quotes, Extractor, Scope};
use crate::messages::{a_discriminant, a_tag};
use crate::model::*;

static CHANNEL_KEYS: &[&str] = &["channel", "event", "kind", "topic", "type"];

impl Extractor<'_> {
    pub(super) fn channel_in(&self, object: Node) -> Option<String> {
        let mut cursor = object.walk();
        object.named_children(&mut cursor).filter(|pair| pair.kind() == "pair").find_map(|pair| {
            let key = trim_quotes(self.text(pair.child_by_field_name("key")?));
            if !CHANNEL_KEYS.contains(&key) {
                return None;
            }
            let value = pair.child_by_field_name("value")?;
            let named = match value.kind() {
                "string" => Some(trim_quotes(self.text(value)).to_string()),
                "identifier" => self
                    .remembered
                    .get(self.text(value))
                    .cloned()
                    .or_else(|| addressing::a_named_constant(self.text(value).trim())),
                "member_expression" => value
                    .child_by_field_name("property")
                    .and_then(|property| addressing::a_named_constant(self.text(property).trim())),
                _ => None,
            }?;
            Some(format!("{key}={named}"))
        })
    }

    fn discriminant_read(&self, subject: Node) -> bool {
        let subject = match subject.kind() {
            "parenthesized_expression" => subject.named_child(0).unwrap_or(subject),
            _ => subject,
        };
        match subject.kind() {
            "member_expression" => subject
                .child_by_field_name("property")
                .is_some_and(|property| a_discriminant(self.text(property).trim())),
            "identifier" => a_discriminant(self.text(subject).trim()),
            _ => false,
        }
    }

    fn tags_compared(&self, condition: Node, into: &mut Vec<String>) {
        if condition.kind() == "binary_expression" {
            let operator = condition.child_by_field_name("operator").map(|held| self.text(held)).unwrap_or("");
            if matches!(operator, "==" | "===")
                && let (Some(left), Some(right)) = (condition.child_by_field_name("left"), condition.child_by_field_name("right"))
            {
                let tag = [(left, right), (right, left)]
                    .into_iter()
                    .filter(|(subject, written)| written.kind() == "string" && self.discriminant_read(*subject))
                    .find_map(|(_, written)| a_tag(trim_quotes(self.text(written))).map(str::to_string));
                into.extend(tag);
                return;
            }
        }
        let mut cursor = condition.walk();
        for child in condition.named_children(&mut cursor) {
            self.tags_compared(child, into);
        }
    }

    pub(super) fn note_handled_tags(&mut self, node: Node, scope: &Scope) {
        let Some(unit) = scope.enclosing_callable.clone() else { return };
        match node.kind() {
            "if_statement" => {
                let (Some(condition), Some(consequence)) =
                    (node.child_by_field_name("condition"), node.child_by_field_name("consequence"))
                else {
                    return;
                };
                let mut tags = Vec::new();
                self.tags_compared(condition, &mut tags);
                for tag in tags {
                    self.facts.messages.push(MessageFact {
                        file: self.file,
                        unit: unit.clone(),
                        tag,
                        said: Said::Handled,
                        line: line_of(node),
                        end_line: consequence.end_position().row as u32 + 1,
                    });
                }
            }
            "switch_statement" => {
                if !node.child_by_field_name("value").is_some_and(|subject| self.discriminant_read(subject)) {
                    return;
                }
                let Some(body) = node.child_by_field_name("body") else { return };
                let mut cases = body.walk();
                for case in body.named_children(&mut cases).filter(|case| case.kind() == "switch_case") {
                    let tag = case
                        .child_by_field_name("value")
                        .filter(|written| written.kind() == "string")
                        .and_then(|written| a_tag(trim_quotes(self.text(written))));
                    if let Some(tag) = tag {
                        self.facts.messages.push(MessageFact {
                            file: self.file,
                            unit: unit.clone(),
                            tag: tag.to_string(),
                            said: Said::Handled,
                            line: line_of(case),
                            end_line: case.end_position().row as u32 + 1,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn note_sent_tag(&mut self, object: Node, scope: &Scope) {
        let Some(unit) = scope.enclosing_callable.clone() else { return };
        let mut cursor = object.walk();
        let tag = object.named_children(&mut cursor).filter(|pair| pair.kind() == "pair").find_map(|pair| {
            let key = trim_quotes(self.text(pair.child_by_field_name("key")?));
            let value = pair.child_by_field_name("value").filter(|value| value.kind() == "string")?;
            a_discriminant(key).then(|| a_tag(trim_quotes(self.text(value))).map(str::to_string)).flatten()
        });
        if let Some(tag) = tag {
            self.facts.messages.push(MessageFact {
                file: self.file,
                unit,
                tag,
                said: Said::Sent,
                line: line_of(object),
                end_line: line_of(object),
            });
        }
    }
}

use tree_sitter::Node;

use super::{trim_quotes, Extractor};

static STARTS_A_PROGRAM: &[&str] = &[
    "Command", "Popen", "call", "check_call", "check_output", "command", "exec", "execv", "execvp", "run", "spawn",
    "system",
];

const ELEMENTS_AT_MOST: usize = 3;

static JOINS_A_PATH: &[&str] = &["Join", "join", "join_path", "joinpath", "resolve"];

impl<'a> Extractor<'a> {
    pub(super) fn declare_go_const(&mut self, node: Node) {
        let Some(name) = node.child_by_field_name("name") else { return };
        let Some(listed) = node.child_by_field_name("value") else { return };
        let value = match listed.kind() {
            "expression_list" => listed.named_child(0),
            _ => Some(listed),
        };
        let Some(value) = value.filter(|held| held.kind().contains("string")) else { return };
        let written = trim_quotes(self.text(value)).trim().to_string();
        if written.is_empty() || written.len() > 400 {
            return;
        }
        self.facts.locals.push(crate::model::LocalBinding {
            file: self.file,
            unit: String::new(),
            name: self.text(name).trim().to_string(),
            written: Some(written),
            line: node.start_position().row as u32 + 1,
            ..Default::default()
        });
    }

    pub(super) fn joined_written(&self, value: Node) -> Option<String> {
        if !self.spec.calls.kinds.contains(&value.kind()) {
            return None;
        }
        let called = self.called_name(value)?;
        let leaf = called.rsplit(['.', ':']).next().unwrap_or(&called);
        if !JOINS_A_PATH.contains(&leaf) {
            return None;
        }
        let arguments = value.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        let parts: Vec<String> = arguments
            .named_children(&mut cursor)
            .filter(|argument| argument.kind().contains("string"))
            .map(|argument| trim_quotes(self.text(argument)).trim().trim_matches('/').to_string())
            .filter(|part| !part.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join("/"))
    }

    pub(super) fn listed_program_words(&self, callee: &str, arguments: Option<Node>) -> Vec<String> {
        let leaf = callee.rsplit(['.', ':']).next().unwrap_or(callee);
        let Some(arguments) = arguments.filter(|_| STARTS_A_PROGRAM.contains(&leaf)) else { return Vec::new() };
        let mut cursor = arguments.walk();
        let Some(list) = arguments
            .named_children(&mut cursor)
            .find(|argument| matches!(argument.kind(), "list" | "array" | "tuple" | "array_creation_expression"))
        else {
            return Vec::new();
        };
        let mut inner = list.walk();
        list.named_children(&mut inner)
            .filter_map(|element| match element.kind() {
                "string" | "string_literal" | "interpreted_string_literal" | "raw_string_literal" => {
                    let word = trim_quotes(self.text(element)).trim().to_string();
                    (!word.is_empty() && word.len() <= 200).then_some(word)
                }
                "identifier" | "attribute" => Some(self.text(element).trim().to_string()),
                _ => None,
            })
            .take(ELEMENTS_AT_MOST)
            .collect()
    }
}

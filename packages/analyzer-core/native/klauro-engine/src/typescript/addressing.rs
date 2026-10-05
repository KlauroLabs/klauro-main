use tree_sitter::Node;

use super::{trim_quotes, Extractor, TEXT_REMEMBERED};

static BASE_KEYS: &[&str] = &["baseURL", "baseUrl", "base_url", "prefixUrl", "prefixURL"];

static STARTS_A_PROGRAM: &[&str] = &["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"];

static JOINS_A_PATH: &[&str] = &["join", "normalize", "path.join", "path.posix.join", "path.resolve", "resolve"];

fn shouted(name: &str) -> bool {
    name.len() > 2
        && name.chars().any(|letter| letter.is_ascii_uppercase())
        && name.chars().all(|letter| letter.is_ascii_uppercase() || letter.is_ascii_digit() || letter == '_')
}

pub(super) fn a_named_constant(name: &str) -> Option<String> {
    shouted(name).then(|| format!("${{{name}}}"))
}

impl Extractor<'_> {
    fn pieces<'t>(&self, node: Node<'t>, into: &mut Vec<Node<'t>>) -> bool {
        if node.kind() != "binary_expression" {
            into.push(node);
            return true;
        }
        let plus = node.child_by_field_name("operator").is_some_and(|operator| self.text(operator) == "+");
        match (plus, node.child_by_field_name("left"), node.child_by_field_name("right")) {
            (true, Some(left), Some(right)) => self.pieces(left, into) && self.pieces(right, into),
            _ => false,
        }
    }

    pub(super) fn concatenated(&self, joined: Node) -> Option<String> {
        let mut parts = Vec::new();
        if !self.pieces(joined, &mut parts) {
            return None;
        }
        let mut written = String::new();
        let mut said = false;
        for part in parts {
            match part.kind() {
                "string" | "template_string" => {
                    said = true;
                    written.push_str(trim_quotes(self.text(part)));
                }
                "identifier" | "member_expression" => {
                    said = true;
                    written.push_str(&format!("${{{}}}", self.text(part).trim()));
                }
                _ => written.push_str("${}"),
            }
        }
        (said && !written.is_empty() && written.len() <= TEXT_REMEMBERED).then_some(written)
    }

    fn joined_path(&self, call: Node) -> Option<String> {
        let function = call.child_by_field_name("function")?;
        if !JOINS_A_PATH.contains(&self.text(function).trim()) {
            return None;
        }
        let arguments = call.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        let parts: Vec<&str> = arguments
            .named_children(&mut cursor)
            .filter(|argument| argument.kind() == "string")
            .map(|argument| trim_quotes(self.text(argument)).trim_matches('/'))
            .filter(|part| !part.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join("/"))
    }

    pub(super) fn constant_value(&self, value: Node) -> Option<String> {
        let written = match value.kind() {
            "string" | "template_string" => Some(trim_quotes(self.text(value)).trim().to_string()),
            "binary_expression" => self.concatenated(value),
            "call_expression" => self.joined_path(value),
            _ => None,
        };
        written.filter(|written| !written.is_empty() && written.len() <= TEXT_REMEMBERED)
    }

    pub(super) fn listed_program_words(&self, callee: &str, arguments: Option<Node>) -> Vec<String> {
        let Some(arguments) = arguments.filter(|_| STARTS_A_PROGRAM.contains(&callee)) else { return Vec::new() };
        let mut cursor = arguments.walk();
        let Some(list) = arguments.named_children(&mut cursor).find(|argument| argument.kind() == "array") else {
            return Vec::new();
        };
        let mut inner = list.walk();
        list.named_children(&mut inner)
            .filter_map(|element| match element.kind() {
                "string" | "template_string" => Some(trim_quotes(self.text(element)).trim().to_string()),
                "identifier" => self
                    .remembered
                    .get(self.text(element))
                    .cloned()
                    .or_else(|| a_named_constant(self.text(element).trim())),
                _ => None,
            })
            .filter(|word| !word.is_empty() && word.len() <= TEXT_REMEMBERED)
            .take(3)
            .collect()
    }

    pub(super) fn base_in(&self, object: Node) -> Option<String> {
        let mut cursor = object.walk();
        object.named_children(&mut cursor).filter(|pair| pair.kind() == "pair").find_map(|pair| {
            let key = trim_quotes(self.text(pair.child_by_field_name("key")?));
            if !BASE_KEYS.contains(&key) {
                return None;
            }
            let value = pair.child_by_field_name("value")?;
            let written = match value.kind() {
                "identifier" | "member_expression" => Some(format!("${{{}}}", self.text(value).trim())),
                _ => self.constant_value(value),
            }?;
            Some(format!("base={written}"))
        })
    }
}

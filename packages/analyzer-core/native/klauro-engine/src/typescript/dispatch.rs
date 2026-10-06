use tree_sitter::Node;

use super::{line_of, span_of, trim_quotes, Extractor, Scope, ASKED_METHODS};
use crate::model::*;

static PATH_SUBJECTS: &[&str] = &["path", "pathname", "requestpath", "route", "routepath", "url", "urlpath"];

static REQUEST_PARAMETERS: &[&str] =
    &["ctx", "incomingmessage", "req", "request", "res", "response", "serverresponse"];

static ADDRESS_KEYS: &[&str] = &["path", "pattern", "route", "url"];

static HANDLER_KEYS: &[&str] = &["action", "callback", "controller", "fn", "handle", "handler"];

static ANY_METHOD_REGISTRAR: &str = "route.all";

#[derive(Default)]
struct Reading {
    methods: Vec<String>,
    exact: Vec<(String, bool)>,
    prefixes: Vec<String>,
}

pub(super) struct Served {
    pub method: Option<String>,
    pub path: String,
}

impl Reading {
    fn served(mut self, in_a_request_handler: bool) -> Option<Served> {
        let method = (!self.methods.is_empty()).then(|| self.methods.remove(0));
        let named_for_a_path = |(_, named): &&(String, bool)| *named && in_a_request_handler;
        let path = match method {
            Some(_) => self
                .exact
                .first()
                .map(|(path, _)| path.clone())
                .or_else(|| self.prefixes.first().map(|held| format!("{}*", held.trim_end_matches('*')))),
            None => self.exact.iter().find(named_for_a_path).map(|(path, _)| path.clone()),
        }?;
        Some(Served { method, path })
    }
}

fn names_a_path(subject: &str) -> bool {
    let last = subject.trim().rsplit(['.', ']']).next().unwrap_or(subject).trim();
    PATH_SUBJECTS.contains(&last.to_ascii_lowercase().as_str())
}

fn names_the_method(subject: &str) -> bool {
    let last = subject.trim().rsplit('.').next().unwrap_or(subject).trim();
    last == "method"
}

fn tokens_of(parameters: &str) -> impl Iterator<Item = String> + '_ {
    parameters.split(|held: char| !held.is_alphanumeric()).filter(|token| !token.is_empty()).map(str::to_ascii_lowercase)
}

pub(super) fn route_of_a_pattern(pattern: &str) -> Option<String> {
    let body = pattern.strip_prefix('^').unwrap_or(pattern);
    let body = body.strip_suffix('$').unwrap_or(body);
    let body = body.strip_suffix("\\/?").unwrap_or(body);
    let mut path = String::new();
    let mut characters = body.chars().peekable();
    while let Some(held) = characters.next() {
        match held {
            '\\' => match characters.next()? {
                escaped @ ('/' | '.' | '-' | '_') => path.push(escaped),
                _ => return None,
            },
            '(' => {
                let mut depth = 1;
                let mut inner = String::new();
                for next in characters.by_ref() {
                    match next {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 {
                        break;
                    }
                    inner.push(next);
                }
                if depth != 0 {
                    return None;
                }
                let named = inner.strip_prefix("?<").and_then(|rest| rest.split_once('>')).map(|(name, _)| name);
                path.push_str(&format!("{{{}}}", named.unwrap_or("param")));
            }
            '.' if matches!(characters.peek(), Some('*' | '+')) => {
                characters.next();
                if characters.peek().is_some() {
                    return None;
                }
                path.push('*');
            }
            plain if plain.is_alphanumeric() || matches!(plain, '/' | '-' | '_') => path.push(plain),
            _ => return None,
        }
    }
    path.starts_with('/').then_some(path)
}

impl Extractor<'_> {
    fn literal_of(&self, node: Node) -> Option<String> {
        match node.kind() {
            "string" => Some(trim_quotes(self.text(node)).to_string()),
            "template_string" if node.named_child_count() == 0 => Some(trim_quotes(self.text(node)).to_string()),
            _ => None,
        }
    }

    fn constant_of(&self, node: Node) -> Option<String> {
        let named = self.text(node).trim();
        let leaf = named.rsplit('.').next().unwrap_or(named);
        let shouted = leaf.len() > 2
            && leaf.chars().any(|letter| letter.is_ascii_uppercase())
            && leaf.chars().all(|letter| letter.is_ascii_uppercase() || letter.is_ascii_digit() || letter == '_');
        shouted.then(|| format!("{}{leaf}", crate::entry_exit::DISPATCH_CONST_MARKER))
    }

    fn pattern_of(&self, node: Node) -> Option<String> {
        if node.kind() != "regex" {
            return None;
        }
        let written = self.text(node);
        let closed = written.rfind('/')?;
        route_of_a_pattern(written.get(1..closed)?)
    }

    fn pattern_matched_against_a_path(&self, call: Node) -> Option<String> {
        let function = call.child_by_field_name("function").filter(|function| function.kind() == "member_expression")?;
        let object = function.child_by_field_name("object")?;
        let property = self.text(function.child_by_field_name("property")?);
        let argument = call.child_by_field_name("arguments")?.named_child(0)?;
        match property {
            "match" if names_a_path(self.text(object)) => self.pattern_of(argument),
            "exec" | "test" if names_a_path(self.text(argument)) => self.pattern_of(object),
            _ => None,
        }
    }

    fn pattern_held_in(&self, name: &str, before: Node) -> Option<String> {
        let mut held = before.prev_named_sibling();
        while let Some(statement) = held {
            if statement.kind() == "lexical_declaration" || statement.kind() == "variable_declaration" {
                let mut cursor = statement.walk();
                for declarator in statement.named_children(&mut cursor) {
                    let named = declarator.child_by_field_name("name").is_some_and(|held| self.text(held) == name);
                    let value = declarator.child_by_field_name("value").filter(|value| value.kind() == "call_expression");
                    if let (true, Some(value)) = (named, value) {
                        return self.pattern_matched_against_a_path(value);
                    }
                }
            }
            held = statement.prev_named_sibling();
        }
        None
    }

    fn read_a_condition(&self, condition: Node, branch: Node, into: &mut Reading) {
        match condition.kind() {
            "parenthesized_expression" => {
                if let Some(inner) = condition.named_child(0) {
                    self.read_a_condition(inner, branch, into);
                }
            }
            "identifier" => {
                if let Some(path) = self.pattern_held_in(self.text(condition), branch) {
                    into.exact.push((path, true));
                }
            }
            "call_expression" => {
                if let Some(path) = self.pattern_matched_against_a_path(condition) {
                    into.exact.push((path, true));
                } else if let Some(prefix) = self.prefix_asked_of_a_path(condition) {
                    into.prefixes.push(prefix);
                }
            }
            "binary_expression" => {
                let operator = condition.child_by_field_name("operator").map(|held| self.text(held)).unwrap_or("");
                let (Some(left), Some(right)) = (condition.child_by_field_name("left"), condition.child_by_field_name("right")) else {
                    return;
                };
                match operator {
                    "&&" | "||" => {
                        self.read_a_condition(left, branch, into);
                        self.read_a_condition(right, branch, into);
                    }
                    "===" | "==" => {
                        let spoken = |held: Node| self.literal_of(held).or_else(|| self.constant_of(held));
                        let (subject, literal) = match (spoken(right), spoken(left)) {
                            (Some(literal), _) => (left, literal),
                            (None, Some(literal)) => (right, literal),
                            _ => return,
                        };
                        let subject = self.text(subject);
                        if names_the_method(subject) && ASKED_METHODS.contains(&literal.as_str()) {
                            into.methods.push(literal);
                        } else if literal.starts_with(['/', '\u{1}']) {
                            into.exact.push((literal, names_a_path(subject)));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn prefix_asked_of_a_path(&self, call: Node) -> Option<String> {
        let function = call.child_by_field_name("function").filter(|function| function.kind() == "member_expression")?;
        if self.text(function.child_by_field_name("property")?) != "startsWith" {
            return None;
        }
        let argument = call.child_by_field_name("arguments")?.named_child(0)?;
        self.literal_of(argument).filter(|held| held.starts_with('/'))
    }

    fn in_a_request_handler(&self, node: Node) -> bool {
        let mut held = node.parent();
        while let Some(ancestor) = held {
            if matches!(ancestor.kind(), "arrow_function" | "function_declaration" | "function_expression" | "function" | "method_definition")
                && let Some(parameters) = ancestor.child_by_field_name("parameters").or_else(|| ancestor.child_by_field_name("parameter"))
                && tokens_of(self.text(parameters)).any(|token| REQUEST_PARAMETERS.contains(&token.as_str()))
            {
                return true;
            }
            held = ancestor.parent();
        }
        false
    }

    pub(super) fn served_by_a_condition(&self, condition: Node, branch: Node) -> Option<Served> {
        let mut reading = Reading::default();
        self.read_a_condition(condition, branch, &mut reading);
        reading.served(self.in_a_request_handler(branch))
    }

    fn declare_a_route(&mut self, scope: &Scope, at: Node, served: &Served) -> String {
        let spoken = served.method.as_deref().unwrap_or("ANY");
        let name = format!("{spoken} {}#{}", served.path, line_of(at));
        let id = self.id("callback", &name, at);
        let holder = scope.enclosing_callable.clone().or_else(|| scope.owner.clone());
        let registrar = match &served.method {
            Some(method) => format!("route.{}", method.to_ascii_lowercase()),
            None => ANY_METHOD_REGISTRAR.to_string(),
        };
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(at),
            parent: holder.clone(),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: Some(registrar),
            registration_label: Some(served.path.clone()),
        });
        if let Some(owner) = holder {
            self.push_edge(&owner, &id, EdgeKind::Contains);
        }
        id
    }

    pub(super) fn routed_branch(&mut self, node: Node, scope: &Scope) -> bool {
        let (Some(condition), Some(consequence)) =
            (node.child_by_field_name("condition"), node.child_by_field_name("consequence"))
        else {
            return false;
        };
        let Some(served) = self.served_by_a_condition(condition, node) else { return false };
        let id = self.declare_a_route(scope, consequence, &served);
        let mut conditioned = scope.child(None, None);
        conditioned.enclosing_callable = scope.enclosing_callable.clone();
        conditioned.context.conditional_depth = scope.context.conditional_depth + 1;
        self.visit(condition, &conditioned);
        let inner = scope.child(Some(id.clone()), Some(id));
        self.visit(consequence, &inner);
        if let Some(alternative) = node.child_by_field_name("alternative") {
            self.visit(alternative, &conditioned);
        }
        true
    }

    fn handed_to_a_route_call(&self, object: Node) -> bool {
        let mut held = object.parent();
        for _ in 0..3 {
            let Some(ancestor) = held else { return false };
            if ancestor.kind() == "call_expression" {
                let callee = ancestor.child_by_field_name("function").map(|function| self.text(function)).unwrap_or("");
                return crate::names::leaf(callee) == super::routes::ROUTE_REGISTRAR;
            }
            held = ancestor.parent();
        }
        false
    }

    pub(super) fn tabulated_route(&mut self, object: Node) {
        if self.handed_to_a_route_call(object) {
            return;
        }
        let Some(path) = ADDRESS_KEYS
            .iter()
            .find_map(|key| self.pair_value(object, key).and_then(|value| self.literal_of(value)))
            .filter(|held| held.starts_with('/'))
        else {
            return;
        };
        let Some(handler) = HANDLER_KEYS
            .iter()
            .find_map(|key| self.pair_value(object, key))
            .filter(|value| matches!(value.kind(), "identifier" | "member_expression"))
        else {
            return;
        };
        let method = self
            .pair_value(object, "method")
            .and_then(|value| self.literal_of(value))
            .map(|held| held.to_ascii_uppercase())
            .filter(|held| ASKED_METHODS.contains(&held.as_str()));
        let registrar = match &method {
            Some(method) => format!("route.{}", method.to_ascii_lowercase()),
            None => ANY_METHOD_REGISTRAR.to_string(),
        };
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar,
            label: path,
            handler: self.text_owned(handler),
            line: line_of(object),
            through: Vec::new(),
        });
    }

    pub(super) fn routed_switch(&mut self, node: Node, scope: &Scope) -> bool {
        let Some(value) = node.child_by_field_name("value") else { return false };
        let discriminant = value.named_child(0).unwrap_or(value);
        if !names_a_path(self.text(discriminant)) || !self.in_a_request_handler(node) {
            return false;
        }
        let Some(body) = node.child_by_field_name("body") else { return false };
        let mut matched = false;
        let mut cases = body.walk();
        for case in body.named_children(&mut cases) {
            let Some(path) = case
                .child_by_field_name("value")
                .and_then(|held| self.literal_of(held))
                .filter(|held| held.starts_with('/'))
            else {
                continue;
            };
            matched = true;
            let id = self.declare_a_route(scope, case, &Served { method: None, path });
            let inner = scope.child(Some(id.clone()), Some(id));
            let mut statements = case.walk();
            for statement in case.children_by_field_name("body", &mut statements) {
                self.visit(statement, &inner);
            }
        }
        matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pattern_over_a_path_reads_as_the_route_it_matches() {
        assert_eq!(route_of_a_pattern("^\\/api\\/projects\\/([^/]+)\\/query$").as_deref(), Some("/api/projects/{param}/query"));
        assert_eq!(route_of_a_pattern("^\\/v1\\/analyses\\/([^/]+)\\/cas\\/sections\\/([^/]+)$").as_deref(), Some("/v1/analyses/{param}/cas/sections/{param}"));
        assert_eq!(route_of_a_pattern("^\\/files\\/(?<name>.+)\\/?$").as_deref(), Some("/files/{name}"));
        assert_eq!(route_of_a_pattern("^\\/api\\/engine\\/.*").as_deref(), Some("/api/engine/*"));
    }

    #[test]
    fn a_pattern_that_is_not_a_plain_route_is_left_alone() {
        assert_eq!(route_of_a_pattern("^\\d+$"), None);
        assert_eq!(route_of_a_pattern("^\\/a|\\/b$"), None);
        assert_eq!(route_of_a_pattern("[a-z]+"), None);
    }

    #[test]
    fn only_a_variable_named_for_a_request_path_is_a_path() {
        assert!(names_a_path("request.url"));
        assert!(names_a_path("url.pathname"));
        assert!(names_a_path("route"));
        assert!(!names_a_path("filePath.value"));
        assert!(!names_a_path("home"));
    }
}

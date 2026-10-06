use tree_sitter::Node;

use super::{Extractor, REQUEST_METHODS, trim_quotes};
use crate::model::RegistrationFact;

static CONSTRUCTED_ROUTES: &str = include_str!("../../data/route_constructors.tsv");

const BARE_VERBS: &[&str] = &["delete", "get", "head", "options", "patch", "post", "put", "ws"];
const SOCKET_VERB: &str = "ws";
const SOCKET_REGISTRAR: &str = "get";
const BUILT_AS: &[&str] = &["identifier", "type_identifier"];
const PARAMETER_LISTS: &[&str] = &["formal_parameter_list"];
const DECLARING: &[&str] = &["static_final_declaration", "initialized_variable_definition", "initialized_identifier"];

struct Constructed {
    language: &'static str,
    constructor: &'static str,
    path_argument: &'static str,
    children_argument: &'static str,
    registrar: &'static str,
}

fn constructed() -> Vec<Constructed> {
    CONSTRUCTED_ROUTES
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let held: Vec<&'static str> = line.split('\t').collect();
            Some(Constructed {
                language: held.first()?,
                constructor: held.get(1)?,
                path_argument: held.get(2)?,
                children_argument: held.get(3)?,
                registrar: held.get(4)?,
            })
        })
        .collect()
}

fn joined(base: &str, path: &str) -> String {
    if path.starts_with('/') || base.is_empty() {
        return path.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), path)
}

impl<'a> Extractor<'a> {
    fn route_in(&self, held: Option<Node>) -> Option<String> {
        let held = held?;
        let written = match held.kind().contains("string") {
            true => trim_quotes(self.text(held)).to_string(),
            false => {
                let mut cursor = held.walk();
                let inner = held.named_children(&mut cursor).find(|child| child.kind().contains("string"))?;
                trim_quotes(self.text(inner)).to_string()
            }
        };
        Some(written).filter(|path| !path.is_empty())
    }

    fn arguments_inside<'t>(&self, call: Node<'t>) -> Vec<Node<'t>> {
        let mut cursor = call.walk();
        let Some(list) = call.named_children(&mut cursor).find(|child| child.kind() == "parenthesized_argument") else {
            return Vec::new();
        };
        let mut inner = list.walk();
        let Some(arguments) = list.named_children(&mut inner).find(|child| child.kind() == "arguments") else {
            return Vec::new();
        };
        let mut walking = arguments.walk();
        arguments.named_children(&mut walking).collect()
    }

    pub(super) fn mojo_route(&mut self, call: Node, callee: &str) -> bool {
        if self.spec.id != "perl" || callee != "to" {
            return false;
        }
        let Some(inner) = call.child_by_field_name("object_return_value").filter(|held| held.kind() == "method_invocation") else {
            return false;
        };
        let Some(verb) = inner.child_by_field_name("function_name").map(|held| self.text(held).to_string()) else { return false };
        let lowered = verb.to_ascii_lowercase();
        if REQUEST_METHODS.binary_search(&lowered.as_str()).is_err() && lowered != "del" {
            return false;
        }
        let Some(path) = self
            .arguments_inside(inner)
            .into_iter()
            .next()
            .and_then(|first| self.route_in(Some(first)))
            .filter(|written| written.starts_with('/'))
        else {
            return false;
        };
        let Some(handler) = self.arguments_inside(call).into_iter().next().and_then(|first| self.route_in(Some(first))) else {
            return false;
        };
        let receiver = inner.child_by_field_name("object_return_value").map(|held| self.text(held).to_string());
        let registrar = match receiver {
            Some(receiver) => format!("{receiver}.{verb}"),
            None => verb,
        };
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar,
            label: path,
            handler,
            line: call.start_position().row as u32 + 1,
            through: Vec::new(),
        });
        true
    }

    pub(super) fn declare_command_routes(&mut self, root: Node) {
        if self.spec.id != "crystal" {
            return;
        }
        let mut cursor = root.walk();
        let statements: Vec<Node> = root.named_children(&mut cursor).collect();
        for pair in statements.windows(2) {
            let [verb, path] = pair else { continue };
            let said = self.statement_value(*verb).filter(|held| held.kind() == "identifier").map(|held| self.text(held).to_string());
            let Some(said) = said.filter(|held| BARE_VERBS.contains(&held.as_str())) else { continue };
            let Some(written) = self
                .statement_value(*path)
                .filter(|held| held.kind() == "string")
                .map(|held| trim_quotes(self.text(held)).to_string())
                .filter(|held| held.starts_with('/'))
            else {
                continue;
            };
            let registrar = match said.as_str() {
                SOCKET_VERB => SOCKET_REGISTRAR.to_string(),
                _ => said,
            };
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar,
                label: written.clone(),
                handler: written,
                line: verb.start_position().row as u32 + 1,
                through: Vec::new(),
            });
        }
    }

    fn statement_value<'t>(&self, statement: Node<'t>) -> Option<Node<'t>> {
        match statement.kind() {
            "expression_statement" => statement.child_by_field_name("value").or_else(|| statement.named_child(0)),
            _ => None,
        }
    }

    pub(super) fn cascade_owner(&self, node: Node) -> Option<String> {
        if self.spec.id != "dart" || node.kind() != "cascade_call_expression" {
            return None;
        }
        let mut held = node.parent();
        while let Some(parent) = held {
            if DECLARING.contains(&parent.kind()) {
                return parent.child_by_field_name("name").map(|name| self.text(name).to_string());
            }
            held = parent.parent();
        }
        None
    }

    pub(super) fn constructed_route(&mut self, call: Node, callee: &str) -> bool {
        let table = constructed();
        let Some(row) = table.iter().find(|row| row.language == self.spec.id && row.constructor == callee) else {
            return false;
        };
        let Some(own) = self.named_argument(call, row.path_argument).and_then(|value| self.route_in(Some(value))) else {
            return false;
        };
        let mut paths = vec![own];
        let mut held = call.parent();
        while let Some(parent) = held {
            if parent.kind() == "call_expression"
                && parent.child_by_field_name("function").is_some_and(|function| self.text(function) == row.constructor)
                && let Some(above) = self.named_argument(parent, row.path_argument).and_then(|value| self.route_in(Some(value)))
            {
                paths.push(above);
            }
            held = parent.parent();
        }
        let label = paths.iter().rev().fold(String::new(), |base, next| joined(&base, next));
        let Some(handler) = self.built_widget(call, row) else { return false };
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: row.registrar.to_string(),
            label,
            handler,
            line: call.start_position().row as u32 + 1,
            through: Vec::new(),
        });
        true
    }

    fn named_argument<'t>(&self, call: Node<'t>, label: &str) -> Option<Node<'t>> {
        let arguments = call.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        arguments.named_children(&mut cursor).find_map(|argument| {
            let named = argument.named_child(0).map(|held| self.text(held).trim().trim_end_matches(':').to_string())?;
            (argument.kind() == "named_argument" && named == label).then(|| argument.named_child(1)).flatten()
        })
    }

    fn built_widget(&self, call: Node, row: &Constructed) -> Option<String> {
        let arguments = call.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        for argument in arguments.named_children(&mut cursor) {
            let label = argument.named_child(0).map(|held| self.text(held).trim().trim_end_matches(':').to_string()).unwrap_or_default();
            if argument.kind() != "named_argument" || label == row.path_argument || label == row.children_argument {
                continue;
            }
            let mut frontier = vec![argument];
            while let Some(node) = frontier.pop() {
                if PARAMETER_LISTS.contains(&node.kind()) {
                    continue;
                }
                if BUILT_AS.contains(&node.kind()) && self.text(node).starts_with(char::is_uppercase) {
                    return Some(self.text(node).to_string());
                }
                let mut inner = node.walk();
                let mut children: Vec<Node> = node.named_children(&mut inner).collect();
                children.reverse();
                frontier.extend(children);
            }
        }
        None
    }
}

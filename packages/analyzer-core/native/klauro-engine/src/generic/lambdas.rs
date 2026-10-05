use tree_sitter::Node;

use super::{Extractor, Scope};
use crate::model::*;

const IDENTIFIERS: &[&str] = &["identifier", "simple_identifier", "variable_name", "name"];

impl<'a> Extractor<'a> {
    fn parameter_container<'t>(&self, lambda: Node<'t>) -> Option<Node<'t>> {
        if let Some(found) = lambda.child_by_field_name("parameters").or_else(|| lambda.child_by_field_name("parameter")) {
            return Some(found);
        }
        let mut cursor = lambda.walk();
        let named: Vec<Node<'t>> = lambda.named_children(&mut cursor).collect();
        named
            .iter()
            .copied()
            .find(|child| {
                let kind = child.kind();
                kind.ends_with("parameters") || kind.ends_with("parameter_list") || kind == "block_parameters"
            })
            .or_else(|| named.first().copied().filter(|child| IDENTIFIERS.contains(&child.kind())))
    }

    pub(super) fn lambda_parameters(&self, lambda: Node) -> Option<Vec<Parameter>> {
        let container = self.parameter_container(lambda)?;
        if IDENTIFIERS.contains(&container.kind()) {
            return Some(vec![Parameter {
                name: self.text(container).trim().to_string(),
                type_annotation: None,
                optional: false,
                default_value: None,
            }]);
        }
        let mut parameters = Vec::new();
        let mut cursor = container.walk();
        for child in container.named_children(&mut cursor) {
            let kind = child.kind();
            if IDENTIFIERS.contains(&kind) {
                parameters.push(Parameter {
                    name: self.text(child).trim().to_string(),
                    type_annotation: None,
                    optional: false,
                    default_value: None,
                });
                continue;
            }
            if kind.contains("parameter") || kind.contains("declaration") {
                let name = self
                    .name_of(child)
                    .or_else(|| child.child_by_field_name("pattern").and_then(|held| self.bound_by(held).into_iter().next()))
                    .unwrap_or_else(|| "_".to_string());
                let type_annotation = child
                    .child_by_field_name("type")
                    .map(|annotation| self.text(annotation).trim().to_string())
                    .or_else(|| self.declared_type(child));
                parameters.push(Parameter { name, type_annotation, optional: false, default_value: None });
                continue;
            }
            parameters.push(Parameter { name: "_".to_string(), type_annotation: None, optional: false, default_value: None });
        }
        Some(parameters)
    }

    pub(super) fn declare_callback_elements(&mut self, id: &str, parameters: &[Parameter], scope: &Scope, line: u32) {
        let (Some(callee), Some(receiver)) = (scope.registrar.as_deref(), scope.registrar_receiver.as_deref()) else {
            return;
        };
        let Some(position) = crate::elements::adapter_position(callee) else { return };
        let Some(parameter) = parameters.get(position) else { return };
        if parameter.name == "_" || parameter.type_annotation.is_some() {
            return;
        }
        self.facts.locals.push(LocalBinding {
            file: self.file,
            unit: id.to_string(),
            name: parameter.name.clone(),
            element_of: Some(receiver.to_string()),
            line,
            ..Default::default()
        });
    }

    pub(super) fn declare_loop_element(&mut self, node: Node, scope: &Scope) {
        let (name_node, value_node, typed) = match (self.spec.id, node.kind()) {
            ("rust", "for_expression") => (node.child_by_field_name("pattern"), node.child_by_field_name("value"), None),
            ("python", "for_statement" | "for_in_clause") => {
                (node.child_by_field_name("left"), node.child_by_field_name("right"), None)
            }
            ("java", "enhanced_for_statement") => {
                (node.child_by_field_name("name"), node.child_by_field_name("value"), node.child_by_field_name("type"))
            }
            ("csharp", "foreach_statement") => {
                (node.child_by_field_name("left"), node.child_by_field_name("right"), node.child_by_field_name("type"))
            }
            ("go", "range_clause") => {
                let left = node.child_by_field_name("left");
                let mut cursor = left.map(|held| held.walk());
                let names: Vec<Node> = match (left, cursor.as_mut()) {
                    (Some(left), Some(cursor)) => left.named_children(cursor).collect(),
                    _ => Vec::new(),
                };
                (names.get(1).copied().filter(|held| held.kind() == "identifier"), node.child_by_field_name("right"), None)
            }
            _ => return,
        };
        let (Some(name_node), Some(value_node)) = (name_node, value_node) else { return };
        let name = self.text(name_node).trim().to_string();
        if name.is_empty() || name == "_" || !name.chars().all(|letter| letter.is_alphanumeric() || letter == '_') {
            return;
        }
        let annotation = typed
            .map(|held| self.text(held).trim().to_string())
            .filter(|written| !matches!(written.as_str(), "var" | "auto") && !written.is_empty());
        let expression = self.text(value_node).trim().to_string();
        if expression.is_empty() || expression.len() > 200 {
            return;
        }
        let expression = match scope.self_binding.as_deref() {
            Some(binding) if crate::names::root(&expression) == binding => format!("this{}", &expression[binding.len()..]),
            _ => expression,
        };
        self.facts.locals.push(LocalBinding {
            file: self.file,
            unit: scope.callable.clone().unwrap_or_default(),
            name,
            annotation: annotation.clone(),
            element_of: annotation.is_none().then_some(expression),
            line: node.start_position().row as u32 + 1,
            ..Default::default()
        });
    }
}

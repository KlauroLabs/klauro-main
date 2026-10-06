use rustc_hash::FxHashMap as HashMap;
use serde::Serialize;

use crate::model::{IndexNode, NodeKind};

const FIELDS_KEPT: usize = 64;

#[derive(Debug, Serialize)]
pub struct Shape {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub node_id: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub fields: Vec<ShapeField>,
}

#[derive(Debug, Serialize)]
pub struct ShapeField {
    pub name: String,
    #[serde(rename = "type")]
    pub declared_as: String,
}

fn kind_of(kind: NodeKind) -> Option<&'static str> {
    match kind {
        NodeKind::Class => Some("class"),
        NodeKind::Interface => Some("interface"),
        NodeKind::TypeAlias => Some("type"),
        _ => None,
    }
}

pub fn derive(nodes: &[IndexNode], paths: &[String]) -> Vec<Shape> {
    let mut members: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Property) {
        if let Some(parent) = node.parent.as_deref() {
            members.entry(parent).or_default().push(node);
        }
    }
    nodes
        .iter()
        .filter_map(|node| {
            let kind = kind_of(node.kind)?;
            let path = paths.get(node.file as usize)?.as_str();
            if crate::paths::is_test(path) {
                return None;
            }
            let held = members.get(node.id.as_str())?;
            let fields: Vec<ShapeField> = held
                .iter()
                .take(FIELDS_KEPT)
                .map(|field| ShapeField {
                    name: field.name.clone(),
                    declared_as: field.type_annotation.clone().unwrap_or_default(),
                })
                .collect();
            Some(Shape {
                id: format!("shape:{}", node.id),
                name: node.name.clone(),
                kind,
                node_id: node.id.clone(),
                file: path.to_string(),
                project: node.project.clone(),
                fields,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Modifiers, Span};

    fn node(id: &str, name: &str, kind: NodeKind, parent: Option<&str>, declared: Option<&str>) -> IndexNode {
        IndexNode {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            file: 0,
            span: Span { line: 1, column: 0, end_line: 1, end_column: 0 },
            parent: parent.map(str::to_string),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: declared.map(str::to_string),
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        }
    }

    #[test]
    fn a_type_with_declared_members_is_a_shape_and_a_bare_one_is_not() {
        let nodes = vec![
            node("a.ts:interface:User", "User", NodeKind::Interface, None, None),
            node("a.ts:property:id", "id", NodeKind::Property, Some("a.ts:interface:User"), Some("string")),
            node("a.ts:property:age", "age", NodeKind::Property, Some("a.ts:interface:User"), Some("number")),
            node("a.ts:interface:Empty", "Empty", NodeKind::Interface, None, None),
        ];
        let found = derive(&nodes, &["a.ts".to_string()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "User");
        assert_eq!(found[0].fields.len(), 2);
        assert_eq!(found[0].fields[1].declared_as, "number");
    }
}

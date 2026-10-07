use std::path::Path;

use rustc_hash::FxHashMap as HashMap;

use crate::model::{EdgeKind, IndexNode, TypeReferenceFact};

fn root_element(text: &str) -> Option<(&str, Option<&str>)> {
    let mut rest = text;
    loop {
        let at = rest.find('<')?;
        rest = &rest[at + 1..];
        if rest.starts_with('?') || rest.starts_with('!') {
            continue;
        }
        let opening = &rest[..rest.find('>')?];
        let tag = opening.split_whitespace().next()?;
        let class = opening.split("x:Class=\"").nth(1).and_then(|held| held.split('"').next());
        return Some((tag.rsplit(':').next().unwrap_or(tag), class));
    }
}

pub fn declared_bases(root: &Path, paths: &[String], nodes: &[IndexNode]) -> Vec<TypeReferenceFact> {
    let mut types_in: HashMap<(&str, &str), &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_type()) {
        if let Some(path) = paths.get(node.file as usize) {
            types_in.insert((path.as_str(), node.name.as_str()), node);
        }
    }
    let mut found = Vec::new();
    for path in paths.iter().filter(|path| path.to_ascii_lowercase().ends_with(".xaml")) {
        let Some(text) = crate::paths::read_inside(root, path) else { continue };
        let Some((base, Some(class))) = root_element(&text) else { continue };
        let class = class.rsplit('.').next().unwrap_or(class);
        let behind = format!("{path}.cs");
        let Some(node) = types_in.get(&(behind.as_str(), class)) else { continue };
        found.push(TypeReferenceFact { file: node.file, source: node.id.clone(), name: base.to_string(), kind: EdgeKind::Extends, arguments: Vec::new() });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_extends_its_root_element_and_names_its_class() {
        let page = "\u{feff}<?xml version=\"1.0\"?>\n<!-- page -->\n<views:ContentPageBase\n    x:Class=\"Shop.Views.CatalogView\"\n    xmlns=\"x\">\n</views:ContentPageBase>";
        assert_eq!(root_element(page), Some(("ContentPageBase", Some("Shop.Views.CatalogView"))));
        assert_eq!(root_element("<ResourceDictionary xmlns=\"x\"/>"), Some(("ResourceDictionary", None)));
    }
}

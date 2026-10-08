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

static LOADS: &str = include_str!("../data/view_model_loads.tsv");

fn attribute<'t>(opening: &'t str, named: &str) -> Option<&'t str> {
    opening.split(&format!("{named}=\"")).nth(1).and_then(|held| held.split('"').next())
}

fn opening_tag(text: &str) -> Option<&str> {
    let mut rest = text;
    loop {
        let at = rest.find('<')?;
        rest = &rest[at + 1..];
        if rest.starts_with('?') || rest.starts_with('!') {
            continue;
        }
        return rest.get(..rest.find('>')?);
    }
}

fn data_type(opening: &str) -> Option<&str> {
    let written = attribute(opening, "x:DataType").or_else(|| attribute(opening, "d:DataContext"))?;
    let written = written.trim_start_matches('{').trim_end_matches('}');
    let written = written.split_whitespace().last().unwrap_or(written);
    let written = written.strip_prefix("Type=").unwrap_or(written).trim_end_matches(',');
    Some(written.rsplit([':', '.']).next().unwrap_or(written))
}

fn commands(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("Command=\"") {
        rest = &rest[at + "Command=\"".len()..];
        let value = rest.split('"').next().unwrap_or_default();
        let Some(binding) = value.trim().strip_prefix("{Binding") else { continue };
        let named = match binding.split("Path=").nth(1) {
            Some(path) => path,
            None => binding.trim_start(),
        };
        let named = named.split([',', ' ', '}']).next().unwrap_or_default();
        if let Some(command) = named.strip_suffix("Command")
            && !command.is_empty()
            && !found.iter().any(|held| held == command)
        {
            found.push(command.to_string());
        }
    }
    found
}

pub struct Bound {
    pub edges: Vec<crate::model::IndexEdge>,
    pub entries: Vec<crate::entry_exit::EntryPoint>,
}

pub fn bound(root: &Path, paths: &[String], nodes: &[IndexNode]) -> Bound {
    let mut held = Bound { edges: Vec::new(), entries: Vec::new() };
    let mut types_in: HashMap<(&str, &str), &IndexNode> = HashMap::default();
    let mut types_named: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    let mut members: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    for node in nodes {
        if node.kind.is_type() {
            if let Some(path) = paths.get(node.file as usize) {
                types_in.insert((path.as_str(), node.name.as_str()), node);
            }
            types_named.entry(node.name.as_str()).or_default().push(node);
        } else if node.kind.is_unit()
            && let Some(parent) = node.parent.as_deref()
        {
            members.entry(parent).or_default().push(node);
        }
    }
    for path in paths.iter().filter(|path| path.to_ascii_lowercase().ends_with(".xaml")) {
        let Some(text) = crate::paths::read_inside(root, path) else { continue };
        let Some(opening) = opening_tag(&text) else { continue };
        let Some(class) = attribute(opening, "x:Class") else { continue };
        let class = class.rsplit('.').next().unwrap_or(class);
        let behind = format!("{path}.cs");
        let Some(view) = types_in.get(&(behind.as_str(), class)) else { continue };
        let Some(model) = data_type(opening).and_then(|named| {
            let found = types_named.get(named)?;
            found.iter().find(|candidate| candidate.project == view.project).or_else(|| found.first()).copied()
        }) else {
            continue;
        };
        let own = members.get(model.id.as_str()).map(Vec::as_slice).unwrap_or_default();
        for member in own.iter().filter(|member| LOADS.lines().any(|named| named == member.name)) {
            held.edges.push(crate::model::IndexEdge {
                source: view.id.clone(),
                target: member.id.clone(),
                kind: EdgeKind::Calls,
                via: crate::model::Via::Rule,
            });
        }
        for command in commands(&text) {
            let Some(member) = own.iter().find(|member| member.name == command || member.name == format!("{command}Async")) else { continue };
            held.entries.push(crate::entry_exit::EntryPoint {
                id: format!("entry:{}:bound", member.id),
                kind: "ui",
                name: format!("{}.{command}", view.name),
                method: None,
                path: None,
                handler: member.id.clone(),
                file: member.file,
                line: member.span.line,
                guards: Vec::new(),
                registrar: "binding".to_string(),
                unshipped: None,
            });
        }
    }
    held
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_names_its_model_and_the_commands_it_binds() {
        let page = "<ContentPage x:Class=\"Shop.Views.CatalogView\" x:DataType=\"viewmodels:CatalogViewModel\">\n<Button Command=\"{Binding FilterCommand, Mode=OneTime}\"/>\n<Button Command=\"{Binding Source={RelativeSource AncestorType={x:Type viewmodels:CatalogViewModel}}, Path=SelectBrandCommand}\"/>\n<Label Text=\"{Binding Name}\"/></ContentPage>";
        assert_eq!(opening_tag(page).and_then(data_type), Some("CatalogViewModel"));
        assert_eq!(commands(page), vec!["Filter".to_string(), "SelectBrand".to_string()]);
    }

    #[test]
    fn a_view_extends_its_root_element_and_names_its_class() {
        let page = "\u{feff}<?xml version=\"1.0\"?>\n<!-- page -->\n<views:ContentPageBase\n    x:Class=\"Shop.Views.CatalogView\"\n    xmlns=\"x\">\n</views:ContentPageBase>";
        assert_eq!(root_element(page), Some(("ContentPageBase", Some("Shop.Views.CatalogView"))));
        assert_eq!(root_element("<ResourceDictionary xmlns=\"x\"/>"), Some(("ResourceDictionary", None)));
    }
}

use crate::model::*;

pub fn is_go_module(path: &str) -> bool {
    crate::paths::basename(path) == "go.mod"
}

pub fn extract(source: &str, file: u32, path: &str) -> FileFacts {
    let mut facts = FileFacts {
        lines: source.lines().count() as u32,
        ..FileFacts::default()
    };
    facts.nodes.push(IndexNode {
        id: path.to_string(),
        name: path.to_string(),
        kind: NodeKind::Module,
        file,
        span: Span { line: 1, column: 0, end_line: facts.lines, end_column: 0 },
        parent: None,
        signature: None,
        modifiers: Modifiers::default(),
        decorators: Vec::new(),
        type_annotation: None,
        documentation: None,
        project: None,
        callback_of: None,
        registration_label: None,
    });
    for (offset, line) in source.lines().enumerate() {
        let Some(module) = directive(line, "module") else { continue };
        let line = offset as u32 + 1;
        facts.nodes.push(IndexNode {
            id: format!("{path}:key:module:{line}"),
            name: "module".to_string(),
            kind: NodeKind::Property,
            file,
            span: Span { line, column: 0, end_line: line, end_column: 0 },
            parent: Some(path.to_string()),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: Some(module.to_string()),
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        });
        break;
    }
    facts
}

fn directive<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = line.trim().strip_prefix(keyword)?;
    let value = match rest.split_once("//") {
        Some((value, _)) => value,
        None => rest,
    };
    let value = value.trim().trim_matches('"');
    (!value.is_empty() && !value.starts_with('(')).then_some(value)
}

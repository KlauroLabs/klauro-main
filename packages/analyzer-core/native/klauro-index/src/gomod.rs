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
    let mut required = false;
    let mut declared_requirements = false;
    for (offset, text) in source.lines().enumerate() {
        let line = offset as u32 + 1;
        if let Some(module) = directive(text, "module") {
            facts.nodes.push(declaration(
                format!("{path}:key:module:{line}"),
                "module".to_string(),
                NodeKind::Property,
                file,
                line,
                Some(path.to_string()),
                Some(module.to_string()),
            ));
            continue;
        }
        let trimmed = text.trim();
        if trimmed.starts_with("require") {
            required = !trimmed.ends_with(')') && trimmed.ends_with('(');
            if let Some(single) = directive(trimmed, "require") {
                require(&mut facts, single, file, path, line);
            }
            if required && !declared_requirements {
                declared_requirements = true;
                facts.nodes.push(declaration(
                    format!("{path}:section:require"),
                    "require".to_string(),
                    NodeKind::Class,
                    file,
                    line,
                    Some(path.to_string()),
                    None,
                ));
            }
            continue;
        }
        if trimmed == ")" {
            required = false;
            continue;
        }
        if required {
            require(&mut facts, trimmed, file, path, line);
        }
    }
    facts
}

fn require(facts: &mut FileFacts, text: &str, file: u32, path: &str, line: u32) {
    let text = match text.split_once("//") {
        Some((named, _)) => named,
        None => text,
    };
    let mut words = text.split_whitespace();
    let (Some(name), version) = (words.next(), words.next()) else { return };
    if name.is_empty() {
        return;
    }
    facts.nodes.push(declaration(
        format!("{path}:key:{name}:{line}"),
        name.to_string(),
        NodeKind::Property,
        file,
        line,
        Some(format!("{path}:section:require")),
        version.map(str::to_string),
    ));
}

fn declaration(
    id: String,
    name: String,
    kind: NodeKind,
    file: u32,
    line: u32,
    parent: Option<String>,
    annotation: Option<String>,
) -> IndexNode {
    IndexNode {
        id,
        name,
        kind,
        file,
        span: Span { line, column: 0, end_line: line, end_column: 0 },
        parent,
        signature: None,
        modifiers: Modifiers::default(),
        decorators: Vec::new(),
        type_annotation: annotation,
        documentation: None,
        project: None,
        callback_of: None,
        registration_label: None,
    }
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

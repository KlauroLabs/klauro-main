use crate::model::*;

pub fn is_dockerfile(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path);
    let lowered = basename.to_ascii_lowercase();
    lowered == "dockerfile"
        || lowered == "containerfile"
        || lowered.starts_with("dockerfile.")
        || lowered.ends_with(".dockerfile")
}

struct Instruction<'a> {
    keyword: String,
    argument: &'a str,
    line: u32,
}

fn instructions(source: &str) -> Vec<Instruction<'_>> {
    let mut found = Vec::new();
    let mut continued = String::new();
    let mut start = 0u32;
    for (offset, raw) in source.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if continued.is_empty() {
            start = offset as u32 + 1;
        }
        let body = line.strip_suffix('\\').unwrap_or(line);
        continued.push_str(body);
        if line.ends_with('\\') {
            continued.push(' ');
            continue;
        }
        let statement = std::mem::take(&mut continued);
        let Some((keyword, argument)) = statement.split_once(char::is_whitespace) else {
            continue;
        };
        let argument = argument.trim();
        let range = source_range(source, argument);
        found.push(Instruction {
            keyword: keyword.to_ascii_uppercase(),
            argument: range,
            line: start,
        });
    }
    found
}

fn source_range<'a>(source: &'a str, argument: &str) -> &'a str {
    match source.find(argument) {
        Some(at) => &source[at..at + argument.len()],
        None => "",
    }
}

fn stage_name(argument: &str) -> Option<String> {
    let mut parts = argument.split_whitespace();
    let image = parts.next()?;
    let alias = parts
        .position(|part| part.eq_ignore_ascii_case("as"))
        .and_then(|_| argument.split_whitespace().last());
    Some(alias.unwrap_or(image).to_string())
}

fn copied_paths(argument: &str) -> Vec<String> {
    let parts: Vec<&str> = argument
        .split_whitespace()
        .filter(|part| !part.starts_with("--"))
        .collect();
    if parts.len() < 2 {
        return Vec::new();
    }
    parts[..parts.len() - 1]
        .iter()
        .map(|part| part.trim_matches(['"', '\'', ',', '[', ']']).to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

pub fn extract(source: &str, file: u32, path: &str) -> FileFacts {
    let mut facts = FileFacts {
        lines: source.lines().count() as u32,
        ..FileFacts::default()
    };
    let module = path.to_string();
    facts.nodes.push(IndexNode {
        id: module.clone(),
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

    let mut stage = module.clone();
    for instruction in instructions(source) {
        match instruction.keyword.as_str() {
            "FROM" => {
                let Some(name) = stage_name(instruction.argument) else { continue };
                stage = format!("{module}:stage:{name}:{}", instruction.line);
                facts.nodes.push(declaration(
                    &stage,
                    &name,
                    NodeKind::Class,
                    file,
                    instruction.line,
                    Some(module.clone()),
                    None,
                ));
                facts.edges.push(IndexEdge {
                    source: module.clone(),
                    target: stage.clone(),
                    kind: EdgeKind::Contains,
                });
                facts.imports.push(ImportFact {
                    file,
                    specifier: instruction.argument.split_whitespace().next().unwrap_or("").to_string(),
                    line: instruction.line,
                    type_only: false,
                    everywhere: false,
                    names: Vec::new(),
                });
            }
            "COPY" | "ADD" => {
                if instruction.argument.contains("--from") {
                    continue;
                }
                for shipped in copied_paths(instruction.argument) {
                    let id = format!("{stage}:ships:{shipped}:{}", instruction.line);
                    facts.nodes.push(declaration(
                        &id,
                        &shipped,
                        NodeKind::Property,
                        file,
                        instruction.line,
                        Some(stage.clone()),
                        Some(instruction.keyword.clone()),
                    ));
                    facts.edges.push(IndexEdge {
                        source: stage.clone(),
                        target: id,
                        kind: EdgeKind::HasField,
                    });
                }
            }
            "ENTRYPOINT" | "CMD" | "EXPOSE" | "WORKDIR" | "USER" => {
                let id = format!("{stage}:{}:{}", instruction.keyword, instruction.line);
                facts.nodes.push(declaration(
                    &id,
                    &instruction.keyword,
                    NodeKind::Property,
                    file,
                    instruction.line,
                    Some(stage.clone()),
                    Some(instruction.argument.to_string()),
                ));
                facts.edges.push(IndexEdge {
                    source: stage.clone(),
                    target: id,
                    kind: EdgeKind::HasField,
                });
            }
            _ => {}
        }
    }
    facts
}

fn declaration(
    id: &str,
    name: &str,
    kind: NodeKind,
    file: u32,
    line: u32,
    parent: Option<String>,
    annotation: Option<String>,
) -> IndexNode {
    IndexNode {
        id: id.to_string(),
        name: name.to_string(),
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

use crate::model::*;

const REPORTED_LIMIT: usize = 4096;

pub fn is_report(path: &str) -> bool {
    let basename = crate::paths::basename(path).to_ascii_lowercase();
    basename == "lcov.info" || basename == "coverage.xml" || basename == "cobertura.xml"
}

pub fn extract(source: &str, file: u32, path: &str) -> FileFacts {
    let mut facts = FileFacts {
        lines: source.lines().count() as u32,
        ..FileFacts::default()
    };
    facts.nodes.push(declaration(
        path.to_string(),
        path.to_string(),
        NodeKind::Module,
        file,
        1,
        None,
        None,
    ));
    let measured = match crate::paths::basename(path).to_ascii_lowercase().as_str() {
        "lcov.info" => tracefile(source),
        _ => rated(source),
    };
    for (line, (covered, found, hit)) in measured.into_iter().take(REPORTED_LIMIT).enumerate() {
        let at = line as u32 + 1;
        facts.nodes.push(declaration(
            format!("{path}:key:{covered}:{at}"),
            covered,
            NodeKind::Property,
            file,
            at,
            Some(path.to_string()),
            Some(format!("{hit}/{found}")),
        ));
    }
    facts
}

fn tracefile(source: &str) -> Vec<(String, u32, u32)> {
    let mut measured = Vec::new();
    let mut covered = String::new();
    let mut found = 0;
    let mut hit = 0;
    for line in source.lines() {
        let line = line.trim();
        if let Some(named) = line.strip_prefix("SF:") {
            covered = named.trim().to_string();
            found = 0;
            hit = 0;
            continue;
        }
        if let Some(counted) = line.strip_prefix("DA:") {
            let mut parts = counted.split(',');
            let (Some(_), Some(times)) = (parts.next(), parts.next()) else { continue };
            found += 1;
            hit += u32::from(times.trim() != "0");
            continue;
        }
        if line == "end_of_record" && !covered.is_empty() {
            measured.push((std::mem::take(&mut covered), found, hit));
        }
    }
    measured
}

fn rated(source: &str) -> Vec<(String, u32, u32)> {
    let mut measured = Vec::new();
    for element in source.split('<') {
        if !element.starts_with("class ") {
            continue;
        }
        let (Some(filename), Some(rate)) = (attribute(element, "filename"), attribute(element, "line-rate"))
        else {
            continue;
        };
        let rate: f64 = rate.parse().unwrap_or(0.0);
        let found = element.matches("<line ").count().max(1) as u32;
        measured.push((filename.to_string(), found, (rate * found as f64).round() as u32));
    }
    measured
}

fn attribute<'a>(element: &'a str, name: &str) -> Option<&'a str> {
    let at = element.find(&format!("{name}=\""))? + name.len() + 2;
    let rest = &element[at..];
    let end = rest.find('"')?;
    Some(&rest[..end])
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

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::constants::{Constants, Standing};
use crate::crossings::Crossing;
use crate::model::{CallFact, ImportFact, IndexNode, LocalBinding};
use crate::names;
use crate::paths::{is_test, read_inside};

static BROKER_CALLS: &str = include_str!("../data/broker_calls.tsv");

const MOST_PER_CHANNEL: usize = 24;
const LONGEST_CHANNEL: usize = 200;
const LONGEST_EXPRESSION: usize = 60;
const LONGEST_ARGUMENTS: usize = 4000;
const DECORATOR_LINES: u32 = 6;
const LONGEST_HERITAGE: usize = 600;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Site {
    Call,
    Decorator,
    Literal,
    Method,
    Implementer,
    Job,
}

enum Spec {
    Position(usize),
    Key(String),
    TypeAt(usize),
    TypeArgument(usize),
    Parameter(usize),
    Handler,
}

struct Row {
    produces: bool,
    broker: String,
    imports: Vec<Vec<String>>,
    site: Site,
    names: Vec<String>,
    specs: Vec<Spec>,
}

struct Table {
    rows: Vec<Row>,
    lists: HashSet<String>,
}

fn segments(written: &str) -> Vec<String> {
    written
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn spec_of(written: &str) -> Spec {
    match written.split_once('#') {
        Some(("type", at)) => Spec::TypeAt(at.parse().unwrap_or(0)),
        Some(("typearg", at)) => Spec::TypeArgument(at.parse().unwrap_or(0)),
        Some(("param", at)) => Spec::Parameter(at.parse().unwrap_or(0)),
        Some((_, at)) => Spec::Position(at.parse().unwrap_or(0)),
        None if written == "-" => Spec::Handler,
        None => Spec::Key(written.to_string()),
    }
}

fn table() -> &'static Table {
    static HELD: OnceLock<Table> = OnceLock::new();
    HELD.get_or_init(|| {
        let mut rows = Vec::new();
        let mut lists = HashSet::default();
        for line in BROKER_CALLS.lines().filter(|line| !line.trim().is_empty()) {
            let held: Vec<&str> = line.split('\t').collect();
            let listed: Vec<String> = held[4].split(',').map(str::to_string).collect();
            if held[0] == "list" {
                lists.extend(listed);
                continue;
            }
            rows.push(Row {
                produces: held[0] == "produce",
                broker: held[1].to_string(),
                imports: held[2].split(',').filter(|named| *named != "-").map(segments).collect(),
                site: match held[3] {
                    "decorator" => Site::Decorator,
                    "literal" => Site::Literal,
                    "method" => Site::Method,
                    "implementer" => Site::Implementer,
                    "job" => Site::Job,
                    _ => Site::Call,
                },
                names: listed,
                specs: held[5].split(',').map(spec_of).collect(),
            });
        }
        Table { rows, lists }
    })
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Endpoint {
    broker: String,
    channel: String,
    produces: bool,
    unit: String,
    file: u32,
    line: u32,
    unconfirmed: bool,
}

enum Value {
    Resolved(String),
    Symbol(String),
}

fn within(text: &str, open: usize) -> Option<(Vec<&str>, usize)> {
    let bytes = text.as_bytes();
    let opener = *bytes.get(open)?;
    if !matches!(opener, b'(' | b'{' | b'[') {
        return None;
    }
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut parts = Vec::new();
    let mut from = open + 1;
    let mut at = open;
    while at < bytes.len() && at - open < LONGEST_ARGUMENTS {
        let letter = bytes[at];
        match quote {
            Some(held) => {
                if letter == b'\\' {
                    at += 1;
                } else if letter == held {
                    quote = None;
                }
            }
            None => match letter {
                b'"' | b'\'' | b'`' => quote = Some(letter),
                b'(' | b'{' | b'[' => depth += 1,
                b')' | b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        parts.push(&text[from..at]);
                        return Some((parts, at));
                    }
                }
                b',' if depth == 1 => {
                    parts.push(&text[from..at]);
                    from = at + 1;
                }
                _ => {}
            },
        }
        at += 1;
    }
    None
}

fn quoted(raw: &str) -> Option<(String, &str)> {
    let start = raw.find(['"', '\'', '`'])?;
    if !raw[..start].chars().all(|letter| letter.is_ascii_alphabetic()) || raw[..start].len() > 2 {
        return None;
    }
    let bytes = raw.as_bytes();
    let quote = bytes[start];
    let mut at = start + 1;
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            at += 2;
            continue;
        }
        if bytes[at] == quote {
            let formatted = raw[..start].to_ascii_lowercase().contains('f');
            let body = &raw[start + 1..at];
            let cut = match (quote, formatted) {
                (b'`', _) => body.find("${"),
                (_, true) => body.find('{'),
                _ => body.find("#{"),
            };
            let text = match cut {
                Some(split) => format!("{}*", &body[..split]),
                None => body.to_string(),
            };
            return Some((text, &raw[at + 1..]));
        }
        at += 1;
    }
    None
}

fn a_symbol(written: &str) -> bool {
    let mut letters = written.chars();
    letters.next().is_some_and(|first| first.is_alphabetic() || matches!(first, '_' | '$' | '@' | ':'))
        && written.len() <= LONGEST_EXPRESSION
        && written.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | '$' | '.' | ':' | '@'))
        && !matches!(written, "null" | "nil" | "None" | "true" | "false" | "undefined" | "this" | "self")
}

fn keyed_position(raw: &str) -> bool {
    let word = raw.trim_start().find(|letter: char| !(letter.is_alphanumeric() || letter == '_')).unwrap_or(0);
    let head = raw.trim_start();
    word > 0 && {
        let rest = head[word..].trim_start();
        (rest.starts_with('=') && !rest.starts_with("==")) || (rest.starts_with(':') && !rest.starts_with("::"))
    }
}

struct Reading<'a> {
    constants: &'a Constants<'a>,
    standing: Standing<'a>,
    lists: &'a HashSet<String>,
}

impl Reading<'_> {
    fn values(&self, raw: &str) -> Vec<Value> {
        let held = raw.trim().trim_start_matches(['&', '*']).trim_start_matches("await ").trim();
        if held.is_empty() {
            return Vec::new();
        }
        if let Some((text, rest)) = quoted(held) {
            let after = rest.trim_start();
            let method = after.starts_with('.') && !after.starts_with("..");
            return match after.is_empty() || method {
                true => vec![Value::Resolved(text)],
                false if after.starts_with(['+', '%']) => vec![Value::Resolved(format!("{text}*"))],
                false => Vec::new(),
            };
        }
        if let Some(open) = held.find(['[', '{', '(']) {
            let head = held[..open].trim_end_matches('!').trim();
            let listing = head.is_empty()
                || head.ends_with("[]")
                || head == "new"
                || self.lists.contains(names::leaf(head.trim_start_matches("new ").trim()))
                || self.lists.contains(head.trim_start_matches("new ").trim_end_matches("[]").trim());
            if listing && let Some((parts, _)) = within(held, open) {
                return parts.into_iter().flat_map(|part| self.values(part)).collect();
            }
            return Vec::new();
        }
        if a_symbol(held) {
            return match self.constants.value(&self.standing, held) {
                Some(written) if !written.is_empty() && written.len() <= LONGEST_CHANNEL => vec![Value::Resolved(written)],
                _ => vec![Value::Symbol(held.to_string())],
            };
        }
        Vec::new()
    }

    fn keyed(&self, arguments: &[&str], key: &str) -> Vec<Value> {
        let mut found = Vec::new();
        for argument in arguments {
            let mut rest = *argument;
            let mut base = 0;
            while let Some(at) = rest.find(key) {
                let absolute = base + at;
                let before = argument[..absolute].chars().next_back();
                let after = &argument[absolute + key.len()..];
                base = absolute + key.len();
                rest = &argument[base..];
                if before.is_some_and(|letter| letter.is_alphanumeric() || letter == '_' || letter == '.') {
                    continue;
                }
                let tail = after.trim_start_matches(['"', '\'', '`']).trim_start();
                let value = if let Some(value) = tail.strip_prefix("=>") {
                    value
                } else if let Some(value) = tail.strip_prefix(':').filter(|value| !value.starts_with(':')) {
                    value
                } else if let Some(value) = tail.strip_prefix('=').filter(|value| !value.starts_with('=')) {
                    value
                } else {
                    continue;
                };
                found.extend(self.values(&first_expression(value)));
            }
        }
        found
    }
}

fn first_expression(text: &str) -> String {
    let wrapped = format!("({text})");
    match within(&wrapped, 0) {
        Some((parts, _)) => parts.first().map(|part| part.to_string()).unwrap_or_default(),
        None => text.split(['\n', ',']).next().unwrap_or("").to_string(),
    }
}

fn type_written(raw: &str) -> Option<String> {
    let held = raw.trim().trim_start_matches(['&', '*']).trim();
    let held = held.strip_prefix("new ").unwrap_or(held).trim();
    let end = held.find(|letter: char| !(letter.is_alphanumeric() || matches!(letter, '_' | '.' | ':'))).unwrap_or(held.len());
    let word = names::leaf(&held[..end]);
    let rest = held[end..].trim_start();
    (word.chars().next().is_some_and(char::is_uppercase) && (rest.starts_with(['(', '{', '<']) || rest.is_empty()))
        .then(|| word.to_string())
}

fn unwrapped(annotation: &str) -> String {
    let held = annotation.trim().trim_end_matches('?');
    match (held.find('<'), held.rfind('>')) {
        (Some(open), Some(close)) if close > open => {
            let inner = held[open + 1..close].split(',').next().unwrap_or("").trim();
            names::leaf(inner.trim_end_matches('?')).to_string()
        }
        _ => names::leaf(held).to_string(),
    }
}

struct Source {
    text: String,
    starts: Vec<usize>,
}

impl Source {
    fn offset(&self, line: u32, column: u32) -> usize {
        let start = self.starts.get(line.saturating_sub(1) as usize).copied().unwrap_or(self.text.len());
        let mut at = (start + column as usize).min(self.text.len());
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        at
    }
}

fn arguments_after<'t>(text: &'t str, from: usize, name: &str) -> Option<Vec<&'t str>> {
    let mut at = from;
    while let Some(found) = text.get(at..)?.find(name) {
        let start = at + found;
        let end = start + name.len();
        at = end;
        let before = text[..start].chars().next_back();
        if before.is_some_and(|letter| letter.is_alphanumeric() || letter == '_') {
            continue;
        }
        let mut open = end;
        let rest = text[open..].trim_start();
        open = text.len() - rest.len();
        if rest.starts_with('<') {
            let mut depth = 0;
            let mut closed = None;
            for (position, letter) in rest.char_indices().take(200) {
                match letter {
                    '<' => depth += 1,
                    '>' => {
                        depth -= 1;
                        if depth == 0 {
                            closed = Some(position);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(closed) = closed else { continue };
            let tail = rest[closed + 1..].trim_start();
            open = text.len() - tail.len();
        }
        if text.as_bytes().get(open) == Some(&b'(') {
            return within(text, open).map(|(parts, _)| parts);
        }
    }
    None
}

fn type_arguments_after(text: &str, from: usize, name: &str) -> Vec<String> {
    let mut at = from;
    while let Some(found) = text.get(at..).and_then(|rest| rest.find(name)) {
        let end = at + found + name.len();
        at = end;
        if text[end..].starts_with('<') {
            let mut depth = 0;
            let mut parts = Vec::new();
            let mut from = end + 1;
            for (position, letter) in text[end..].char_indices().take(200) {
                match letter {
                    '<' => depth += 1,
                    '>' => {
                        depth -= 1;
                        if depth == 0 {
                            parts.push(text[from..end + position].trim().to_string());
                            return parts.iter().map(|held| unwrapped(held)).collect();
                        }
                    }
                    ',' if depth == 1 => {
                        parts.push(text[from..end + position].trim().to_string());
                        from = end + position + 1;
                    }
                    _ => {}
                }
            }
        }
    }
    Vec::new()
}

struct Evidence<'a> {
    files: &'a [String],
    nodes: HashMap<&'a str, &'a IndexNode>,
    units_in: HashMap<u32, Vec<&'a IndexNode>>,
    locals: HashMap<(&'a str, &'a str), &'a LocalBinding>,
    gates: Vec<(HashSet<u32>, HashSet<&'a str>)>,
    project_of: HashMap<u32, &'a str>,
    constants: Constants<'a>,
}

impl<'a> Evidence<'a> {
    fn new(files: &'a [String], nodes: &'a [IndexNode], locals: &'a [LocalBinding], imports: &'a [ImportFact]) -> Self {
        let mut units_in: HashMap<u32, Vec<&IndexNode>> = HashMap::default();
        let mut project_of: HashMap<u32, &str> = HashMap::default();
        for node in nodes {
            if let Some(project) = node.project.as_deref() {
                project_of.entry(node.file).or_insert(project);
            }
            if node.kind.is_unit() {
                units_in.entry(node.file).or_default().push(node);
            }
        }
        let gates = table()
            .rows
            .iter()
            .map(|row| {
                let files: HashSet<u32> = imports
                    .iter()
                    .filter(|held| {
                        let spoken = segments(&held.specifier);
                        row.imports.iter().any(|hint| spoken.windows(hint.len()).any(|window| window == hint.as_slice()))
                    })
                    .map(|held| held.file)
                    .collect();
                let projects = files.iter().filter_map(|file| project_of.get(file).copied()).collect();
                (files, projects)
            })
            .collect();
        Evidence {
            files,
            nodes: nodes.iter().map(|node| (node.id.as_str(), node)).collect(),
            units_in,
            locals: locals.iter().map(|held| ((held.unit.as_str(), held.name.as_str()), held)).collect(),
            gates,
            project_of,
            constants: Constants::new(locals),
        }
    }

    fn open(&self, index: usize, file: u32) -> bool {
        let row = &table().rows[index];
        if row.imports.is_empty() {
            return true;
        }
        let (held, projects) = &self.gates[index];
        held.contains(&file) || self.project_of.get(&file).is_some_and(|project| projects.contains(project))
    }

    fn unit_at(&self, file: u32, line: u32) -> String {
        self.units_in
            .get(&file)
            .into_iter()
            .flatten()
            .filter(|node| node.span.line <= line && line <= node.span.end_line)
            .min_by_key(|node| node.span.end_line - node.span.line)
            .map(|node| node.id.clone())
            .unwrap_or_else(|| self.files[file as usize].clone())
    }

    fn type_of(&self, unit: &str, expression: &str) -> Option<String> {
        if let Some(written) = type_written(expression) {
            return Some(written);
        }
        let name = expression.trim();
        let binding = self.locals.get(&(unit, name))?;
        binding
            .annotation
            .as_deref()
            .map(unwrapped)
            .or_else(|| binding.constructed.as_deref().map(|held| names::leaf(held).to_string()))
            .or_else(|| binding.from_call.as_deref().and_then(type_written))
    }
}

fn load(root: &Path, files: &[String], held: &mut HashMap<u32, Option<Source>>, file: u32) {
    held.entry(file).or_insert_with(|| {
        let text = read_inside(root, &files[file as usize])?;
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(at, _)| at + 1));
        Some(Source { text, starts })
    });
}

fn keep(found: &mut BTreeSet<Endpoint>, row: &Row, values: Vec<Value>, unit: &str, file: u32, line: u32) {
    for value in values {
        let channel = match value {
            Value::Resolved(text) if !text.is_empty() && text.len() <= LONGEST_CHANNEL && text != "*" => text,
            Value::Symbol(expression) => format!("?{expression}"),
            Value::Resolved(_) => continue,
        };
        found.insert(Endpoint {
            broker: row.broker.clone(),
            channel,
            produces: row.produces,
            unit: unit.to_string(),
            file,
            line,
            unconfirmed: row.imports.is_empty() && row.site == Site::Method,
        });
    }
}

fn read_specs(
    row: &Row,
    reading: &Reading,
    evidence: &Evidence,
    arguments: &[&str],
    type_arguments: &[String],
    unit: &str,
) -> Vec<Value> {
    for spec in &row.specs {
        let values: Vec<Value> = match spec {
            Spec::Position(at) => arguments
                .get(*at)
                .filter(|raw| !keyed_position(raw))
                .map(|raw| reading.values(raw))
                .unwrap_or_default(),
            Spec::Key(key) => reading.keyed(arguments, key),
            Spec::TypeAt(at) => arguments
                .get(*at)
                .and_then(|raw| evidence.type_of(unit, raw))
                .map(Value::Resolved)
                .into_iter()
                .collect(),
            Spec::TypeArgument(at) => type_arguments.get(*at).cloned().map(Value::Resolved).into_iter().collect(),
            Spec::Parameter(_) | Spec::Handler => Vec::new(),
        };
        if !values.is_empty() {
            return values;
        }
    }
    Vec::new()
}

fn calls_of(
    root: &Path,
    evidence: &Evidence,
    calls: &[CallFact],
    held: &mut HashMap<u32, Option<Source>>,
    lists: &HashSet<String>,
    found: &mut BTreeSet<Endpoint>,
) {
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::default();
    for (index, row) in table().rows.iter().enumerate().filter(|(_, row)| row.site == Site::Call) {
        for name in &row.names {
            by_name.entry(name.as_str()).or_default().push(index);
        }
    }
    for call in calls {
        let leaf = names::leaf(call.callee.trim_end_matches(':'));
        let Some(wanted) = by_name.get(leaf) else { continue };
        let Some(path) = evidence.files.get(call.file as usize) else { continue };
        if is_test(path) {
            continue;
        }
        let rows: Vec<usize> = wanted.iter().copied().filter(|index| evidence.open(*index, call.file)).collect();
        if rows.is_empty() {
            continue;
        }
        load(root, evidence.files, held, call.file);
        let Some(Some(source)) = held.get(&call.file) else { continue };
        let at = source.offset(call.line, call.column);
        let Some(arguments) = arguments_after(&source.text, at, leaf) else { continue };
        let typed = type_arguments_after(&source.text, at, leaf);
        let unit = call.caller.clone().unwrap_or_else(|| evidence.unit_at(call.file, call.line));
        let reading = Reading {
            constants: &evidence.constants,
            standing: Standing { file: call.file, unit: &unit, owner: None, node: evidence.nodes.get(unit.as_str()).copied() },
            lists,
        };
        for index in rows {
            let row = &table().rows[index];
            let values = read_specs(row, &reading, evidence, &arguments, &typed, &unit);
            keep(found, row, values, &unit, call.file, call.line);
        }
    }
}

fn decorators_of(
    root: &Path,
    evidence: &Evidence,
    nodes: &[IndexNode],
    held: &mut HashMap<u32, Option<Source>>,
    lists: &HashSet<String>,
    found: &mut BTreeSet<Endpoint>,
) {
    for node in nodes.iter().filter(|node| !node.decorators.is_empty()) {
        let Some(path) = evidence.files.get(node.file as usize) else { continue };
        if is_test(path) {
            continue;
        }
        for decorator in &node.decorators {
            let leaf = names::leaf(&decorator.name);
            for (index, row) in table().rows.iter().enumerate().filter(|(_, row)| row.site == Site::Decorator) {
                if !row.names.iter().any(|named| named == leaf) || !evidence.open(index, node.file) {
                    continue;
                }
                let handler = row.specs.iter().any(|spec| matches!(spec, Spec::Handler));
                if handler {
                    let owner = node.parent.as_deref().and_then(|parent| evidence.nodes.get(parent)).filter(|parent| parent.kind.is_type());
                    let channel = owner.map(|parent| parent.name.clone()).unwrap_or_else(|| node.name.clone());
                    keep(found, row, vec![Value::Resolved(channel)], &node.id, node.file, node.span.line);
                    continue;
                }
                load(root, evidence.files, held, node.file);
                let Some(Some(source)) = held.get(&node.file) else { continue };
                let from = source.offset(node.span.line, 0);
                let until = source.offset(node.span.line + DECORATOR_LINES, 0);
                let region = &source.text[from..until.max(from)];
                let Some(arguments) = decorated_arguments(region, leaf) else { continue };
                let target = decorated_unit(evidence, node);
                let reading = Reading {
                    constants: &evidence.constants,
                    standing: Standing { file: node.file, unit: &target, owner: None, node: evidence.nodes.get(target.as_str()).copied() },
                    lists,
                };
                let values = read_specs(row, &reading, evidence, &arguments, &[], &target);
                keep(found, row, values, &target, node.file, node.span.line);
            }
        }
    }
}

fn decorated_unit(evidence: &Evidence, node: &IndexNode) -> String {
    if node.kind.is_unit() {
        return node.id.clone();
    }
    let constructor = evidence
        .units_in
        .get(&node.file)
        .into_iter()
        .flatten()
        .find(|held| held.parent.as_deref() == Some(node.id.as_str()) && held.kind.is_unit() && held.name == node.name);
    constructor.map(|held| held.id.clone()).unwrap_or_else(|| node.id.clone())
}

fn decorated_arguments<'t>(region: &'t str, name: &str) -> Option<Vec<&'t str>> {
    let mut at = 0;
    while let Some(found) = region[at..].find(name) {
        let start = at + found;
        let end = start + name.len();
        at = end;
        if !region[..start].ends_with('@') && !region[..start].ends_with("@Annotation(") {
            continue;
        }
        let rest = region[end..].trim_start();
        let open = region.len() - rest.len();
        if rest.starts_with('(') {
            return within(region, open).map(|(parts, _)| parts);
        }
        return Some(Vec::new());
    }
    None
}

fn literals_of(
    root: &Path,
    evidence: &Evidence,
    held: &mut HashMap<u32, Option<Source>>,
    lists: &HashSet<String>,
    found: &mut BTreeSet<Endpoint>,
) {
    for (index, row) in table().rows.iter().enumerate().filter(|(_, row)| row.site == Site::Literal) {
        let (files, _) = &evidence.gates[index];
        for file in files {
            let Some(path) = evidence.files.get(*file as usize) else { continue };
            if is_test(path) {
                continue;
            }
            load(root, evidence.files, held, *file);
            let Some(Some(source)) = held.get(file) else { continue };
            for name in &row.names {
                let mut at = 0;
                while let Some(position) = source.text[at..].find(name.as_str()) {
                    let start = at + position;
                    let end = start + name.len();
                    at = end;
                    let before = source.text[..start].chars().next_back();
                    if before.is_some_and(|letter| letter.is_alphanumeric() || letter == '_') || !source.text[end..].starts_with('{') {
                        continue;
                    }
                    let Some((parts, _)) = within(&source.text, end) else { continue };
                    let line = source.text[..start].matches('\n').count() as u32 + 1;
                    let unit = evidence.unit_at(*file, line);
                    let reading = Reading {
                        constants: &evidence.constants,
                        standing: Standing { file: *file, unit: &unit, owner: None, node: evidence.nodes.get(unit.as_str()).copied() },
                        lists,
                    };
                    let values = read_specs(row, &reading, evidence, &parts, &[], &unit);
                    keep(found, row, values, &unit, *file, line);
                }
            }
        }
    }
}

fn methods_of(evidence: &Evidence, nodes: &[IndexNode], found: &mut BTreeSet<Endpoint>) {
    for (index, row) in table().rows.iter().enumerate().filter(|(_, row)| row.site == Site::Method) {
        for node in nodes.iter().filter(|node| node.kind.is_unit() && row.names.iter().any(|named| *named == node.name)) {
            let Some(path) = evidence.files.get(node.file as usize) else { continue };
            if is_test(path) || !evidence.open(index, node.file) {
                continue;
            }
            let channel = row.specs.iter().find_map(|spec| match spec {
                Spec::Parameter(at) => node
                    .signature
                    .as_ref()
                    .and_then(|signature| signature.parameters.get(*at))
                    .and_then(|parameter| parameter.type_annotation.as_deref())
                    .map(unwrapped),
                Spec::Handler => node
                    .parent
                    .as_deref()
                    .and_then(|parent| evidence.nodes.get(parent))
                    .filter(|parent| parent.kind.is_type())
                    .map(|parent| parent.name.clone()),
                _ => None,
            });
            if let Some(channel) = channel.filter(|held| held.chars().next().is_some_and(char::is_alphabetic)) {
                keep(found, row, vec![Value::Resolved(channel)], &node.id, node.file, node.span.line);
            }
        }
    }
}

fn implementers_of(
    root: &Path,
    evidence: &Evidence,
    nodes: &[IndexNode],
    held: &mut HashMap<u32, Option<Source>>,
    found: &mut BTreeSet<Endpoint>,
) {
    for (index, row) in table().rows.iter().enumerate().filter(|(_, row)| row.site == Site::Implementer) {
        for node in nodes.iter().filter(|node| node.kind.is_type()) {
            let Some(path) = evidence.files.get(node.file as usize) else { continue };
            if is_test(path) || !evidence.open(index, node.file) {
                continue;
            }
            load(root, evidence.files, held, node.file);
            let Some(Some(source)) = held.get(&node.file) else { continue };
            let from = source.offset(node.span.line, 0);
            let until = source.text[from..].find('{').map(|at| from + at).unwrap_or(source.text.len());
            let heritage = source.text[from..until].chars().take(LONGEST_HERITAGE).collect::<String>();
            for name in &row.names {
                let Some(channel) = type_arguments_after(&heritage, 0, name).into_iter().next().filter(|held| !held.is_empty()) else {
                    continue;
                };
                let handler = evidence
                    .units_in
                    .get(&node.file)
                    .into_iter()
                    .flatten()
                    .find(|unit| {
                        unit.parent.as_deref() == Some(node.id.as_str())
                            && row.specs.iter().any(|spec| matches!(spec, Spec::Key(wanted) if *wanted == unit.name))
                    })
                    .map(|unit| (unit.id.as_str(), unit.span.line))
                    .unwrap_or((node.id.as_str(), node.span.line));
                keep(found, row, vec![Value::Resolved(channel)], handler.0, node.file, handler.1);
            }
        }
    }
}

fn jobs_of(evidence: &Evidence, calls: &[CallFact], found: &mut BTreeSet<Endpoint>) {
    let working: HashSet<String> = found
        .iter()
        .filter(|held| !held.produces)
        .map(|held| format!("{}\u{1}{}", held.broker, held.channel))
        .collect();
    for call in calls {
        let (Some(receiver), Some(unit)) = (call.receiver.as_deref(), call.caller.as_deref()) else { continue };
        let Some(path) = evidence.files.get(call.file as usize) else { continue };
        if is_test(path) {
            continue;
        }
        let verb = names::leaf(&call.callee);
        for (index, row) in table().rows.iter().enumerate().filter(|(_, row)| row.site == Site::Job) {
            if !row.names.iter().any(|named| named == verb) || !evidence.open(index, call.file) {
                continue;
            }
            let job = names::leaf(receiver.trim_end_matches(['.', ':']));
            if working.contains(&format!("{}\u{1}{}", row.broker, job)) {
                keep(found, row, vec![Value::Resolved(job.to_string())], unit, call.file, call.line);
            }
        }
    }
}

pub fn derive(
    root: &Path,
    files: &[String],
    nodes: &[IndexNode],
    calls: &[CallFact],
    locals: &[LocalBinding],
    imports: &[ImportFact],
) -> Vec<Crossing> {
    let evidence = Evidence::new(files, nodes, locals, imports);
    let lists = &table().lists;
    let mut held: HashMap<u32, Option<Source>> = HashMap::default();
    let mut found: BTreeSet<Endpoint> = BTreeSet::new();
    calls_of(root, &evidence, calls, &mut held, lists, &mut found);
    decorators_of(root, &evidence, nodes, &mut held, lists, &mut found);
    literals_of(root, &evidence, &mut held, lists, &mut found);
    methods_of(&evidence, nodes, &mut found);
    implementers_of(root, &evidence, nodes, &mut held, &mut found);
    jobs_of(&evidence, calls, &mut found);
    paired(found.into_iter().collect())
}

fn paired(endpoints: Vec<Endpoint>) -> Vec<Crossing> {
    let mut sides: HashMap<(&str, &str), (Vec<&Endpoint>, Vec<&Endpoint>)> = HashMap::default();
    let mut seen: HashSet<(&str, &str, &str, &str)> = HashSet::default();
    for endpoint in &endpoints {
        let held = sides.entry((endpoint.broker.as_str(), endpoint.channel.as_str())).or_default();
        match endpoint.produces {
            true => held.0.push(endpoint),
            false => held.1.push(endpoint),
        }
    }
    let mut made: BTreeSet<Crossing> = BTreeSet::new();
    for ((broker, channel), (producers, consumers)) in sides {
        let mut kept = 0;
        for (from, to) in producers.iter().flat_map(|from| consumers.iter().map(move |to| (from, to))) {
            if from.unit == to.unit || kept >= MOST_PER_CHANNEL || !seen.insert((broker, channel, from.unit.as_str(), to.unit.as_str())) {
                continue;
            }
            kept += 1;
            made.insert(Crossing {
                kind: "queue",
                communication: "message",
                channel: channel.to_string(),
                from: from.unit.clone(),
                from_file: from.file,
                from_line: from.line,
                through: None,
                to: to.unit.clone(),
                to_file: to.file,
                to_line: to.line,
                to_end_line: None,
                broker: Some(broker.to_string()),
                open: None,
            });
        }
        let paired_units: HashSet<&str> = match kept {
            0 => HashSet::default(),
            _ => producers.iter().chain(consumers.iter()).map(|endpoint| endpoint.unit.as_str()).collect(),
        };
        for endpoint in producers
            .iter()
            .chain(consumers.iter())
            .filter(|endpoint| !paired_units.contains(endpoint.unit.as_str()) && !endpoint.unconfirmed)
        {
            made.insert(Crossing {
                kind: "queue",
                communication: "message",
                channel: channel.to_string(),
                from: if endpoint.produces { endpoint.unit.clone() } else { String::new() },
                from_file: endpoint.file,
                from_line: endpoint.line,
                through: None,
                to: if endpoint.produces { String::new() } else { endpoint.unit.clone() },
                to_file: endpoint.file,
                to_line: endpoint.line,
                to_end_line: None,
                broker: Some(broker.to_string()),
                open: Some(if endpoint.produces { "consumer" } else { "producer" }),
            });
        }
    }
    made.into_iter().collect()
}

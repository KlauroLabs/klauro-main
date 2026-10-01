use std::collections::BTreeMap;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::{CallFact, EdgeKind, IndexEdge, IndexNode, LocalBinding, NodeKind};

const ARGUMENTS_READ: usize = 4;
const ELEMENTS_READ: usize = 3;
const MEMBERS_READ: usize = 6;
const DEPTH_READ: u8 = 4;
const PATH_AT_MOST: usize = 80;
const CLIMB_AT_MOST: usize = 8;
const WRAPPER_ROUNDS: usize = 3;

static STORES_A_VALUE: &[&str] = &[
    "add", "append", "commit", "dump", "emit", "insert", "output", "persist", "publish", "put",
    "save", "send", "serialize", "set", "store", "upsert", "write",
];

static READS_A_VALUE: &[&str] = &[
    "fetch", "find", "get", "load", "lrange", "open", "parse", "pop", "query", "read", "retrieve", "select",
];

static SERIALIZES: &[&str] = &[
    "dump", "dumps", "encode", "marshal", "serialize", "stringify", "to_bytes", "to_json", "to_string",
    "to_string_pretty", "to_value", "to_vec", "to_vec_pretty", "to_yaml", "tojson", "tostring",
];

static DESERIALIZES: &[&str] = &[
    "decode", "deserialize", "from_reader", "from_slice", "from_str", "from_value", "loads", "parse", "unmarshal",
];

static NOT_A_CONTENT_READ: &[&str] = &["dir", "exists", "remove", "stat"];

static OVER_A_BOUNDARY: &[&str] = &["graphql", "http", "ipc", "message", "rpc"];

static KEPT_AWAY: &[&str] = &["cache", "client_storage", "file"];

static NOT_A_VARIABLE: &[&str] = &["false", "nil", "none", "null", "true", "undefined"];

fn is_path(text: &str) -> bool {
    let mut letters = text.chars();
    let Some(first) = letters.next() else { return false };
    (first.is_alphabetic() || matches!(first, '_' | '$'))
        && text.len() <= PATH_AT_MOST
        && !text.ends_with(['.', ':'])
        && text.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | '$' | '.' | ':'))
        && !NOT_A_VARIABLE.contains(&text)
}

fn top_level(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut from = 0;
    for (at, letter) in text.char_indices() {
        match letter {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&text[from..at]);
                from = at + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[from..]);
    parts
}

fn plus_parts(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut from = 0;
    for (at, letter) in text.char_indices() {
        match (quote, letter) {
            (Some(open), _) if letter == open => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"' | '`') => quote = Some(letter),
            (None, '(' | '[' | '{') => depth += 1,
            (None, ')' | ']' | '}') => depth -= 1,
            (None, '+') if depth == 0 => {
                parts.push(&text[from..at]);
                from = at + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[from..]);
    parts
}

fn without_decoration(text: &str) -> &str {
    let mut held = text.trim();
    loop {
        let before = held;
        for prefix in ["await ", "&mut ", "&", "*", "mut ", "ref ", "move ", "new ", "try "] {
            if let Some(rest) = held.strip_prefix(prefix) {
                held = rest.trim_start();
            }
        }
        held = held.trim_end_matches(['?', '!', ';']).trim_end();
        if let Some(rest) = held.strip_suffix(".await") {
            held = rest;
        }
        if let Some(stripped) = held.strip_suffix("()")
            && let Some((receiver, last)) = stripped.rsplit_once('.')
            && !last.is_empty()
            && last.chars().all(|letter| letter.is_alphanumeric() || letter == '_')
            && !receiver.is_empty()
        {
            held = receiver;
        }
        if held == before {
            return held;
        }
    }
}

fn matching_open(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (at, letter) in text.char_indices().rev() {
        match letter {
            ')' => depth += 1,
            '(' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
    }
    None
}

fn roots_of(text: &str, depth: u8, held: &mut Vec<String>) {
    if depth > DEPTH_READ {
        return;
    }
    let mut text = text.trim();
    if let Some((before, _)) = text.split_once(" as ") {
        text = before;
    }
    let text = without_decoration(text);
    if text.is_empty() {
        return;
    }
    let joined = plus_parts(text);
    if joined.len() > 1 {
        for part in joined.into_iter().take(ELEMENTS_READ) {
            roots_of(part, depth + 1, held);
        }
        return;
    }
    if let Some(inner) = text.strip_prefix('{').and_then(|rest| rest.strip_suffix('}')) {
        for member in top_level(inner).into_iter().take(MEMBERS_READ) {
            let member = member.trim();
            let value = match member.strip_prefix("...") {
                Some(spread) => spread,
                None => match member.split_once(':') {
                    Some((_, value)) if !value.starts_with(':') => value,
                    _ => member,
                },
            };
            roots_of(value, depth + 1, held);
        }
        return;
    }
    if let Some(inner) = text.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        for element in top_level(inner).into_iter().take(ELEMENTS_READ) {
            roots_of(element, depth + 1, held);
        }
        return;
    }
    if is_path(text) {
        if !held.iter().any(|known| known == text) {
            held.push(text.to_string());
        }
        return;
    }
    if !text.ends_with(')') {
        return;
    }
    let Some(open) = matching_open(text) else { return };
    let callee = text[..open].trim_end();
    let inner = &text[open + 1..text.len() - 1];
    match is_path(callee) {
        true => {
            if let Some((receiver, _)) = callee.rsplit_once(['.', ':'])
                && is_path(receiver.trim_end_matches(':'))
            {
                roots_of(receiver.trim_end_matches(':'), depth + 1, held);
            }
        }
        false => {
            if let Some((receiver, _)) = callee.rsplit_once('.') {
                roots_of(receiver, depth + 1, held);
            }
        }
    }
    if let Some(first) = top_level(inner).first()
        && !first.trim().is_empty()
    {
        roots_of(first, depth + 1, held);
    }
}

pub fn passed<'a>(arguments: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut held = Vec::new();
    for (at, argument) in arguments.take(ARGUMENTS_READ).enumerate() {
        let mut roots = Vec::new();
        roots_of(argument, 0, &mut roots);
        held.extend(roots.into_iter().map(|root| format!("{at}={root}")));
    }
    held
}

fn passing(held: &str) -> Option<(usize, &str)> {
    let (at, path) = held.split_once('=')?;
    Some((at.parse().ok()?, path))
}

pub fn built_from(text: &str) -> Vec<String> {
    let text = without_decoration(text);
    let literal = text.starts_with('{');
    let macro_call = text.find("!(").is_some_and(|at| text[..at].chars().all(|letter| letter.is_alphanumeric() || letter == '_'));
    let serializing = SERIALIZES.iter().any(|word| {
        text.match_indices(word).any(|(at, _)| {
            let before = text[..at].chars().next_back();
            let after = &text[at + word.len()..];
            before.is_none_or(|letter| !(letter.is_alphanumeric() || letter == '_'))
                && (after.starts_with('(') || after.starts_with("::<"))
        })
    });
    if !(literal || macro_call || serializing) {
        return Vec::new();
    }
    let mut held = Vec::new();
    roots_of(text, 0, &mut held);
    held.truncate(ARGUMENTS_READ);
    held
}

pub fn tokens(annotation: &str) -> Vec<&str> {
    annotation
        .split(|letter: char| !(letter.is_alphanumeric() || letter == '_'))
        .filter(|word| word.len() > 1 && word.chars().next().is_some_and(|first| first.is_alphabetic() || first == '_'))
        .collect()
}

pub struct Sources<'a> {
    pub nodes: &'a [IndexNode],
    pub edges: &'a [IndexEdge],
    pub calls: &'a [CallFact],
    pub locals: &'a [LocalBinding],
    pub exit_points: &'a [ExitPoint],
    pub entry_points: &'a [EntryPoint],
}

pub struct Sighting {
    pub unit: String,
    pub exit: Option<String>,
    pub node: String,
    pub place: &'static str,
}

#[derive(Default)]
pub struct Sightings {
    pub stored: Vec<Sighting>,
    pub loaded: Vec<Sighting>,
    pub carried: Vec<Sighting>,
}

struct Typing<'a> {
    node_of: HashMap<&'a str, &'a IndexNode>,
    fields_of: HashMap<&'a str, Vec<(&'a str, Option<&'a str>)>>,
    locals_in: HashMap<(&'a str, &'a str), &'a LocalBinding>,
    units_named: HashMap<&'a str, Vec<&'a IndexNode>>,
    types_named: HashMap<&'a str, Vec<&'a IndexNode>>,
    variables: HashMap<(u32, &'a str), &'a IndexNode>,
}

type Named = Vec<(String, u32)>;

impl<'a> Typing<'a> {
    fn new(sources: &Sources<'a>) -> Self {
        let node_of: HashMap<&str, &IndexNode> =
            sources.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
        let mut fields_of: HashMap<&str, Vec<(&str, Option<&str>)>> = HashMap::default();
        for edge in sources.edges.iter().filter(|edge| edge.kind == EdgeKind::HasField) {
            if let Some(field) = node_of.get(edge.target.as_str()) {
                fields_of
                    .entry(edge.source.as_str())
                    .or_default()
                    .push((field.name.as_str(), field.type_annotation.as_deref()));
            }
        }
        let mut locals_in: HashMap<(&str, &str), &LocalBinding> = HashMap::default();
        for local in sources.locals {
            locals_in.entry((local.unit.as_str(), local.name.as_str())).or_insert(local);
        }
        let mut units_named: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
        let mut types_named: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
        let mut variables: HashMap<(u32, &str), &IndexNode> = HashMap::default();
        for node in sources.nodes {
            if node.kind.is_unit() {
                units_named.entry(node.name.as_str()).or_default().push(node);
            } else if node.kind.is_type() {
                types_named.entry(node.name.as_str()).or_default().push(node);
            } else if node.kind == NodeKind::Variable && node.type_annotation.is_some() {
                variables.entry((node.file, node.name.as_str())).or_insert(node);
            }
        }
        Typing { node_of, fields_of, locals_in, units_named, types_named, variables }
    }

    fn enclosing_type(&self, unit: &IndexNode) -> Option<&'a IndexNode> {
        let mut at = unit.parent.as_deref();
        for _ in 0..CLIMB_AT_MOST {
            let node = self.node_of.get(at?).copied()?;
            if node.kind.is_type() {
                return Some(node);
            }
            at = node.parent.as_deref();
        }
        None
    }

    fn named(&self, annotation: &str, site: u32) -> Named {
        tokens(annotation).into_iter().map(|word| (word.to_string(), site)).collect()
    }

    fn returned_by(&self, called: &str, caller: &IndexNode) -> Named {
        let Some(found) = self.units_named.get(called) else { return Vec::new() };
        let within = self.enclosing_type(caller).map(|held| held.id.as_str());
        let narrowed: Vec<&&IndexNode> = found
            .iter()
            .filter(|node| node.file == caller.file)
            .filter(|node| within.is_none() || node.parent.as_deref() == within)
            .collect();
        let chosen: Vec<&&IndexNode> = match narrowed.is_empty() {
            true => found.iter().filter(|node| node.file == caller.file).collect(),
            false => narrowed,
        };
        let chosen = match chosen.is_empty() && found.len() == 1 {
            true => found.iter().collect(),
            false => chosen,
        };
        let [only] = chosen.as_slice() else { return Vec::new() };
        only.signature
            .as_ref()
            .and_then(|signature| signature.return_type.as_deref())
            .map(|returned| self.named(returned, only.file))
            .unwrap_or_default()
    }

    fn root_type_within(&self, unit: &IndexNode, first: &str, depth: u8) -> Named {
        if matches!(first, "this" | "self" | "Self" | "cls") {
            return self
                .enclosing_type(unit)
                .map(|held| vec![(held.name.clone(), held.file)])
                .unwrap_or_default();
        }
        let mut at = Some(unit);
        for _ in 0..CLIMB_AT_MOST {
            let Some(node) = at else { break };
            if let Some(local) = self.locals_in.get(&(node.id.as_str(), first)) {
                let mut found: Named = Vec::new();
                if let Some(annotation) = local.annotation.as_deref() {
                    found.extend(self.named(annotation, node.file));
                }
                if let Some(constructed) = local.constructed.as_deref() {
                    found.push((constructed.to_string(), node.file));
                }
                if found.is_empty()
                    && let Some(called) = local.from_call.as_deref()
                {
                    found.extend(self.returned_by(called, node));
                }
                if found.is_empty() && depth < DEPTH_READ {
                    for path in &local.from_values {
                        found.extend(self.typed_within(node, path, depth + 1));
                    }
                }
                return found;
            }
            if let Some(parameter) = node
                .signature
                .as_ref()
                .and_then(|signature| signature.parameters.iter().find(|parameter| parameter.name == first))
            {
                return parameter
                    .type_annotation
                    .as_deref()
                    .map(|annotation| self.named(annotation, node.file))
                    .unwrap_or_default();
            }
            at = node.parent.as_deref().and_then(|parent| self.node_of.get(parent).copied());
        }
        self.variables
            .get(&(unit.file, first))
            .and_then(|node| node.type_annotation.as_deref())
            .map(|annotation| self.named(annotation, unit.file))
            .unwrap_or_default()
    }

    fn types_called(&self, name: &str, site: u32) -> Vec<&'a IndexNode> {
        let Some(found) = self.types_named.get(name) else { return Vec::new() };
        let alongside: Vec<&&IndexNode> = found.iter().filter(|node| node.file == site).collect();
        match alongside.is_empty() {
            true => found.to_vec(),
            false => alongside.into_iter().copied().collect(),
        }
    }

    fn typed(&self, unit: &IndexNode, path: &str) -> Named {
        self.typed_within(unit, path, 0)
    }

    fn typed_within(&self, unit: &IndexNode, path: &str, depth: u8) -> Named {
        let mut segments = path.split(['.', ':']).filter(|segment| !segment.is_empty());
        let Some(first) = segments.next() else { return Vec::new() };
        let mut current = self.root_type_within(unit, first, depth);
        for segment in segments {
            if current.is_empty() {
                break;
            }
            let mut next: Named = Vec::new();
            for (name, site) in &current {
                for owner in self.types_called(name, *site) {
                    for (field, annotation) in self.fields_of.get(owner.id.as_str()).into_iter().flatten() {
                        if *field == segment
                            && let Some(annotation) = annotation
                        {
                            next.extend(self.named(annotation, owner.file));
                        }
                    }
                }
            }
            current = next;
        }
        current
    }
}

fn writes_a_value(exit: &ExitPoint) -> bool {
    let operation = exit.operation.to_ascii_lowercase();
    STORES_A_VALUE.iter().any(|word| operation.contains(word))
}

fn reads_a_value(exit: &ExitPoint) -> bool {
    let operation = exit.operation.to_ascii_lowercase();
    READS_A_VALUE.iter().any(|word| operation.contains(word))
        && !NOT_A_CONTENT_READ.iter().any(|word| operation.contains(word))
}

pub fn gather(
    sources: &Sources,
    resolve: &dyn Fn(&str, u32) -> Vec<String>,
) -> Sightings {
    let typing = Typing::new(sources);
    let mut at_line: HashMap<(&str, u32), Vec<&CallFact>> = HashMap::default();
    for call in sources.calls {
        if let Some(caller) = call.caller.as_deref() {
            at_line.entry((caller, call.line)).or_default().push(call);
        }
    }
    let writing_units: HashSet<&str> = sources
        .exit_points
        .iter()
        .filter(|exit| KEPT_AWAY.contains(&exit.kind) && writes_a_value(exit))
        .map(|exit| exit.source.as_str())
        .collect();
    let mut wrappers: Vec<(&str, usize, &'static str)> = Vec::new();
    let mut readers: Vec<(&str, &'static str)> = Vec::new();
    let mut deserializing: HashMap<&str, Vec<&CallFact>> = HashMap::default();
    for call in sources.calls {
        if let Some(caller) = call.caller.as_deref()
            && !call.type_arguments.is_empty()
            && DESERIALIZES.contains(&crate::names::leaf(&call.callee))
        {
            deserializing.entry(caller).or_default().push(call);
        }
    }
    let mut found = Sightings::default();
    let see = |into: &mut Vec<Sighting>, unit: &str, exit: Option<&str>, place: &'static str, named: Named| {
        for (name, site) in named {
            for node in resolve(&name, site) {
                into.push(Sighting {
                    unit: unit.to_string(),
                    exit: exit.map(str::to_string),
                    node,
                    place,
                });
            }
        }
    };
    for exit in sources.exit_points {
        let kept_away = KEPT_AWAY.contains(&exit.kind);
        let sent = matches!(exit.kind, "api" | "message" | "network");
        let database = exit.kind == "database";
        if !(kept_away || sent || database) {
            continue;
        }
        let Some(unit) = typing.node_of.get(exit.source.as_str()).copied() else { continue };
        let operation = crate::names::leaf(&exit.operation);
        let calls: Vec<&&CallFact> = at_line
            .get(&(exit.source.as_str(), exit.line))
            .into_iter()
            .flatten()
            .filter(|call| crate::names::leaf(&call.callee) == operation)
            .collect();
        match writes_a_value(exit) || sent {
            true => {
                for call in &calls {
                    for held in &call.passes {
                        let Some((_, path)) = passing(held) else { continue };
                        let named = typing.typed(unit, path);
                        see(&mut found.stored, &exit.source, Some(&exit.id), exit.kind, named);
                        if !sent
                            && !path.contains(['.', ':'])
                            && let Some(signature) = unit.signature.as_ref()
                            && let Some(parameter) = signature.parameters.iter().position(|parameter| parameter.name == path)
                        {
                            wrappers.push((unit.id.as_str(), parameter, exit.kind));
                        }
                    }
                }
            }
            false if !reads_a_value(exit) => {}
            false => {
                let mut named: Named = Vec::new();
                for local in sources.locals.iter().filter(|local| {
                    local.unit == exit.source && local.from_call.as_deref().map(crate::names::leaf) == Some(operation)
                }) {
                    if let Some(annotation) = local.annotation.as_deref() {
                        named.extend(typing.named(annotation, unit.file));
                    }
                    if let Some(constructed) = local.constructed.as_deref() {
                        named.push((constructed.to_string(), unit.file));
                    }
                }
                for call in &calls {
                    for argument in &call.type_arguments {
                        named.extend(typing.named(argument, unit.file));
                    }
                }
                if kept_away && !writing_units.contains(exit.source.as_str()) {
                    readers.push((unit.id.as_str(), exit.kind));
                    for call in deserializing.get(exit.source.as_str()).into_iter().flatten() {
                        for argument in &call.type_arguments {
                            named.extend(typing.named(argument, unit.file));
                        }
                    }
                }
                if kept_away
                    && !writing_units.contains(exit.source.as_str())
                    && let Some(returned) = unit.signature.as_ref().and_then(|signature| signature.return_type.as_deref())
                {
                    named.extend(typing.named(returned, unit.file));
                }
                see(&mut found.loaded, &exit.source, Some(&exit.id), exit.kind, named);
            }
        }
    }
    let reaches: HashSet<(&str, &str)> = sources
        .edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::Calls)
        .map(|edge| (edge.source.as_str(), edge.target.as_str()))
        .collect();
    let mut by_callee: HashMap<&str, Vec<&CallFact>> = HashMap::default();
    for call in sources.calls {
        if !call.passes.is_empty() || !call.type_arguments.is_empty() {
            by_callee.entry(crate::names::leaf(&call.callee)).or_default().push(call);
        }
    }
    let mut taken: HashSet<(&str, usize)> = wrappers.iter().map(|(unit, at, _)| (*unit, *at)).collect();
    let mut frontier = wrappers;
    for _ in 0..WRAPPER_ROUNDS {
        let mut next: Vec<(&str, usize, &'static str)> = Vec::new();
        for (wrapper, parameter, place) in frontier {
            let Some(node) = typing.node_of.get(wrapper).copied() else { continue };
            for call in by_callee.get(node.name.as_str()).into_iter().flatten() {
                let Some(caller) = call.caller.as_deref() else { continue };
                if !reaches.contains(&(caller, wrapper)) {
                    continue;
                }
                let Some(unit) = typing.node_of.get(caller).copied() else { continue };
                for held in &call.passes {
                    let Some((at, path)) = passing(held) else { continue };
                    if at != parameter {
                        continue;
                    }
                    see(&mut found.stored, caller, None, place, typing.typed(unit, path));
                    if !path.contains(['.', ':'])
                        && let Some(signature) = unit.signature.as_ref()
                        && let Some(passed_on) = signature.parameters.iter().position(|held| held.name == path)
                        && taken.insert((unit.id.as_str(), passed_on))
                    {
                        next.push((unit.id.as_str(), passed_on, place));
                    }
                }
            }
        }
        frontier = next;
    }
    let readers_called: HashSet<&str> = readers.iter().map(|(reader, _)| *reader).collect();
    for edge in sources.edges.iter().filter(|edge| edge.kind == EdgeKind::Calls) {
        if !readers_called.contains(edge.target.as_str()) || writing_units.contains(edge.source.as_str()) {
            continue;
        }
        let Some(caller) = typing.node_of.get(edge.source.as_str()).copied() else { continue };
        if let Some(returned) = caller.signature.as_ref().and_then(|signature| signature.return_type.as_deref()) {
            see(&mut found.loaded, &edge.source, None, "file", typing.named(returned, caller.file));
        }
    }
    for (reader, place) in readers {
        let Some(node) = typing.node_of.get(reader).copied() else { continue };
        for call in by_callee.get(node.name.as_str()).into_iter().flatten() {
            let Some(caller) = call.caller.as_deref() else { continue };
            if !reaches.contains(&(caller, reader)) {
                continue;
            }
            let Some(unit) = typing.node_of.get(caller).copied() else { continue };
            let named: Named = call.type_arguments.iter().flat_map(|argument| typing.named(argument, unit.file)).collect();
            see(&mut found.loaded, caller, None, place, named);
        }
        for local in sources.locals.iter().filter(|local| local.from_call.as_deref() == Some(node.name.as_str())) {
            if !reaches.contains(&(local.unit.as_str(), reader)) {
                continue;
            }
            let Some(unit) = typing.node_of.get(local.unit.as_str()).copied() else { continue };
            let mut named: Named = Vec::new();
            if let Some(annotation) = local.annotation.as_deref() {
                named.extend(typing.named(annotation, unit.file));
            }
            if let Some(constructed) = local.constructed.as_deref() {
                named.push((constructed.to_string(), unit.file));
            }
            see(&mut found.loaded, &local.unit, None, place, named);
        }
    }
    for entry in sources.entry_points.iter().filter(|entry| OVER_A_BOUNDARY.contains(&entry.kind)) {
        let Some(handler) = typing.node_of.get(entry.handler.as_str()).copied() else { continue };
        let Some(signature) = handler.signature.as_ref() else { continue };
        let changing = entry
            .method
            .as_deref()
            .is_some_and(|method| matches!(method.to_ascii_uppercase().as_str(), "DELETE" | "PATCH" | "POST" | "PUT"));
        let mut named: Named = Vec::new();
        for parameter in &signature.parameters {
            if let Some(annotation) = parameter.type_annotation.as_deref() {
                named.extend(typing.named(annotation, handler.file));
            }
        }
        let asked = match changing {
            true => "request_changing",
            false => "request",
        };
        see(&mut found.carried, &entry.handler, None, asked, named);
        if let Some(returned) = signature.return_type.as_deref() {
            see(&mut found.carried, &entry.handler, None, "response", typing.named(returned, handler.file));
        }
    }
    found
}

#[derive(Default)]
pub struct Keeping {
    pub documents: BTreeMap<String, Vec<String>>,
    pub stored: HashMap<String, Vec<String>>,
    pub loaded: HashMap<String, Vec<String>>,
    pub document_stored: HashMap<String, Vec<String>>,
    pub document_loaded: HashMap<String, Vec<String>>,
    pub exits: HashMap<String, Vec<String>>,
    pub mentions: HashMap<String, Vec<String>>,
    pub roots_of: HashMap<String, Vec<String>>,
}

#[derive(Default)]
pub struct Through {
    pub writes: Vec<String>,
    pub reads: Vec<String>,
    pub writers: Vec<(String, String)>,
    pub readers: Vec<(String, String)>,
}

fn push_unique(into: &mut Vec<String>, value: &str) {
    if !into.iter().any(|held| held == value) {
        into.push(value.to_string());
    }
}

impl Keeping {
    pub fn index(&mut self) {
        let mut roots_of: HashMap<String, Vec<String>> = HashMap::default();
        for (root, elements) in &self.documents {
            for element in elements {
                push_unique(roots_of.entry(element.clone()).or_default(), root);
            }
        }
        self.roots_of = roots_of;
    }

    pub fn through_documents(&self, units: &[&str]) -> Through {
        let mut through = Through::default();
        if self.documents.is_empty() {
            return through;
        }
        let mut written: HashSet<&str> = HashSet::default();
        let mut read: HashSet<&str> = HashSet::default();
        for unit in units {
            written.extend(self.document_stored.get(*unit).into_iter().flatten().map(String::as_str));
            read.extend(self.document_loaded.get(*unit).into_iter().flatten().map(String::as_str));
        }
        if written.is_empty() && read.is_empty() {
            return through;
        }
        for unit in units {
            for element in self.mentions.get(*unit).into_iter().flatten() {
                let Some(roots) = self.roots_of.get(element) else { continue };
                if roots.iter().any(|root| written.contains(root.as_str())) {
                    push_unique(&mut through.writes, element);
                    through.writers.push((element.clone(), (*unit).to_string()));
                } else if roots.iter().any(|root| read.contains(root.as_str())) {
                    push_unique(&mut through.reads, element);
                    through.readers.push((element.clone(), (*unit).to_string()));
                }
            }
        }
        through
    }
}

pub fn mentions(
    sources: &Sources,
    elements: &HashSet<&str>,
) -> HashMap<String, Vec<String>> {
    let mut held: HashMap<String, Vec<String>> = HashMap::default();
    if elements.is_empty() {
        return held;
    }
    let mut note = |unit: &str, word: &str| {
        if elements.contains(word) {
            push_unique(held.entry(unit.to_string()).or_default(), word);
        }
    };
    for node in sources.nodes.iter().filter(|node| node.kind.is_unit()) {
        let Some(signature) = node.signature.as_ref() else { continue };
        for parameter in &signature.parameters {
            for word in tokens(parameter.type_annotation.as_deref().unwrap_or_default()) {
                note(&node.id, word);
            }
        }
        for word in tokens(signature.return_type.as_deref().unwrap_or_default()) {
            note(&node.id, word);
        }
    }
    for local in sources.locals {
        for word in tokens(local.annotation.as_deref().unwrap_or_default())
            .into_iter()
            .chain(local.constructed.as_deref())
        {
            note(&local.unit, word);
        }
    }
    for call in sources.calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        for argument in &call.type_arguments {
            for word in tokens(argument) {
                note(caller, word);
            }
        }
        if call.constructs {
            note(caller, crate::names::leaf(&call.callee));
        }
    }
    let node_of: HashMap<&str, &IndexNode> = sources.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    for edge in sources.edges.iter().filter(|edge| edge.kind == EdgeKind::Instantiates) {
        if let Some(target) = node_of.get(edge.target.as_str()) {
            note(&edge.source, &target.name);
        }
    }
    held
}

#[cfg(test)]
mod tests {
    use super::{passed, passing};

    fn roots(argument: &str) -> Vec<String> {
        passed(std::iter::once(argument))
            .iter()
            .filter_map(|held| passing(held).map(|(_, path)| path.to_string()))
            .collect()
    }

    #[test]
    fn a_value_keeps_the_place_it_was_passed_in() {
        assert_eq!(passed(["path", "JSON.stringify(record)"].into_iter()), vec!["0=path", "1=JSON", "1=record"]);
    }

    #[test]
    fn a_value_is_found_through_whatever_wraps_it_on_its_way_to_the_store() {
        assert_eq!(roots("db"), vec!["db"]);
        assert_eq!(roots("JSON.stringify(db, null, 2)"), vec!["JSON", "db"]);
        assert_eq!(roots("&state"), vec!["state"]);
        assert_eq!(roots("serde_json::to_string_pretty(&self.state)?"), vec!["serde_json", "self.state"]);
        assert_eq!(roots("toml::to_string(&cfg).unwrap()"), vec!["toml", "cfg"]);
        assert_eq!(roots("[row]"), vec!["row"]);
        assert_eq!(roots("prefix + JSON.stringify(entry) + '\\n'"), vec!["prefix", "JSON", "entry"]);
        assert_eq!(roots("{ version: 1, users: db.users, ...extra }"), vec!["db.users", "extra"]);
        assert_eq!(roots("this.items.clone()"), vec!["this.items"]);
        assert!(roots("'/tmp/file'").is_empty());
        assert!(roots("null").is_empty());
    }
}

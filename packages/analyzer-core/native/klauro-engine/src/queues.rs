use std::collections::BTreeSet;

use rustc_hash::FxHashMap as HashMap;

use crate::crossings::Crossing;
use crate::model::{CallFact, ImportFact, IndexNode, LocalBinding};
use crate::names;
use crate::paths::is_test;
use crate::rules::{queue_calls, QueueRole};

const MOST_PER_QUEUE: usize = 24;
const CLIMBS: usize = 8;
const CHAIN: usize = 4;

struct Evidence<'a> {
    nodes: HashMap<&'a str, &'a IndexNode>,
    functions: HashMap<&'a str, Vec<&'a IndexNode>>,
    members: HashMap<(&'a str, &'a str), &'a IndexNode>,
    locals: HashMap<(&'a str, &'a str), Vec<&'a LocalBinding>>,
    creations: HashMap<&'a str, Vec<&'a CallFact>>,
    declared: HashMap<&'a str, Vec<u32>>,
    imported: HashMap<(u32, &'a str), &'a str>,
    files: &'a [String],
}

fn matching_close(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (at, letter) in text[open..].char_indices() {
        match letter {
            '<' => depth += 1,
            '>' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(open + at);
                }
            }
            _ => {}
        }
    }
    None
}

fn first_argument(inside: &str) -> &str {
    let mut depth = 0usize;
    for (at, letter) in inside.char_indices() {
        match letter {
            '<' | '(' | '[' => depth += 1,
            '>' | ')' | ']' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => return inside[..at].trim(),
            _ => {}
        }
    }
    inside.trim()
}

fn endpoint_argument<'t>(annotation: &'t str, endpoints: &[String]) -> Option<&'t str> {
    endpoints.iter().find_map(|endpoint| {
        let mut from = 0;
        while let Some(found) = annotation[from..].find(endpoint.as_str()) {
            let start = from + found;
            let end = start + endpoint.len();
            let alone = annotation[..start].chars().next_back().is_none_or(|before| !before.is_alphanumeric() && before != '_');
            if alone && annotation[end..].starts_with('<') {
                let close = matching_close(annotation, end)?;
                return Some(first_argument(&annotation[end + 1..close]));
            }
            from = end;
        }
        None
    })
}

fn names_its_module(specifier: &str, path: &str) -> bool {
    let mut segments = specifier.rsplit("::");
    segments.next();
    let Some(module) = segments.next() else { return false };
    if matches!(module, "crate" | "super" | "self") {
        return true;
    }
    let module = module.replace('-', "_");
    path.split('/').any(|part| {
        let stem = part.split('.').next().unwrap_or(part);
        stem.replace('-', "_") == module
    })
}

fn payload(argument: &str) -> &str {
    let bare = argument.trim().trim_start_matches(['&', '*']).trim_start_matches("mut ").trim_start_matches("dyn ").trim();
    let end = bare.find(['<', '(', ' ', '[']).unwrap_or(bare.len());
    names::leaf(&bare[..end])
}

impl<'a> Evidence<'a> {
    fn new(files: &'a [String], nodes: &'a [IndexNode], calls: &'a [CallFact], locals: &'a [LocalBinding], imports: &'a [ImportFact]) -> Self {
        let creating: Vec<&str> = queue_calls()
            .iter()
            .filter(|rule| rule.role == QueueRole::Create)
            .flat_map(|rule| rule.verbs.iter().map(String::as_str))
            .collect();
        let mut functions: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
        let mut members: HashMap<(&str, &str), &IndexNode> = HashMap::default();
        for node in nodes {
            if node.kind.is_unit() {
                functions.entry(node.name.as_str()).or_default().push(node);
            }
            if let Some(parent) = node.parent.as_deref() {
                members.entry((parent, node.name.as_str())).or_insert(node);
            }
        }
        let mut held: HashMap<(&str, &str), Vec<&LocalBinding>> = HashMap::default();
        for binding in locals {
            held.entry((binding.unit.as_str(), binding.name.as_str())).or_default().push(binding);
        }
        let mut creations: HashMap<&str, Vec<&CallFact>> = HashMap::default();
        for call in calls.iter().filter(|call| !call.type_arguments.is_empty()) {
            if let Some(unit) = call.caller.as_deref()
                && creating.contains(&names::leaf(call.callee.trim_end_matches(':')))
            {
                creations.entry(unit).or_default().push(call);
            }
        }
        let mut declared: HashMap<&str, Vec<u32>> = HashMap::default();
        for node in nodes.iter().filter(|node| node.kind.is_type()) {
            declared.entry(node.name.as_str()).or_default().push(node.file);
        }
        Evidence {
            nodes: nodes.iter().map(|node| (node.id.as_str(), node)).collect(),
            functions,
            members,
            locals: held,
            creations,
            declared,
            imported: imports
                .iter()
                .flat_map(|held| held.names.iter().map(move |name| ((held.file, name.local.as_str()), held.specifier.as_str())))
                .collect(),
            files,
        }
    }

    fn enclosing(&self, unit: &'a str) -> Vec<&'a str> {
        let mut chain = vec![unit];
        let mut held = unit;
        for _ in 0..CLIMBS {
            let Some(node) = self.nodes.get(held) else { break };
            if !node.id.contains(":callback:") {
                break;
            }
            match node.parent.as_deref() {
                Some(parent) => {
                    chain.push(parent);
                    held = parent;
                }
                None => break,
            }
        }
        chain
    }

    fn declared_payload(&self, argument: Option<&'a str>, file: u32) -> Option<(u32, &'a str)> {
        let name = argument.map(payload)?;
        let homes = self.declared.get(name)?;
        if homes.contains(&file) {
            return Some((file, name));
        }
        let specifier = self.imported.get(&(file, name))?;
        match homes.as_slice() {
            [only] if self.files.get(*only as usize).is_some_and(|path| names_its_module(specifier, path)) => Some((*only, name)),
            _ => None,
        }
    }

    fn of_annotation(&self, annotation: &'a str, endpoints: &[String], file: u32) -> Option<(u32, &'a str)> {
        self.declared_payload(endpoint_argument(annotation, endpoints), file)
    }

    fn of_name(&self, chain: &[&'a str], name: &str, endpoints: &[String], file: u32, depth: usize) -> Option<(u32, &'a str)> {
        for unit in chain {
            for binding in self.locals.get(&(*unit, name)).into_iter().flatten() {
                if let Some(found) = binding.annotation.as_deref().and_then(|held| self.of_annotation(held, endpoints, file)) {
                    return Some(found);
                }
                let Some(origin) = binding.from_call.as_deref() else { continue };
                let created = self.creations.get(unit).into_iter().flatten().find(|call| call.callee == origin);
                if let Some(call) = created
                    && let Some(found) = self.declared_payload(call.type_arguments.first().map(String::as_str), file)
                {
                    return Some(found);
                }
                if depth < CHAIN {
                    let source = names::root(origin);
                    if source != name
                        && let Some(found) = self.of_name(chain, source, endpoints, file, depth + 1).or_else(|| self.of_function(source, endpoints, file))
                    {
                        return Some(found);
                    }
                }
            }
            let parameter = self.nodes.get(unit).and_then(|node| node.signature.as_ref()).and_then(|signature| {
                signature.parameters.iter().find(|parameter| parameter.name == name)
            });
            if let Some(found) = parameter.and_then(|held| held.type_annotation.as_deref()).and_then(|held| self.of_annotation(held, endpoints, file)) {
                return Some(found);
            }
        }
        None
    }

    fn of_function(&self, name: &str, endpoints: &[String], file: u32) -> Option<(u32, &'a str)> {
        let mut found = self.functions.get(name)?.iter().filter_map(|node| {
            node.signature
                .as_ref()
                .and_then(|signature| signature.return_type.as_deref())
                .or(node.type_annotation.as_deref())
                .and_then(|held| self.of_annotation(held, endpoints, file))
        });
        let first = found.next()?;
        found.all(|other| other == first).then_some(first)
    }

    fn of_field(&self, chain: &[&'a str], receiver: &str, endpoints: &[String], file: u32) -> Option<(u32, &'a str)> {
        let field = receiver.strip_prefix("self.").or_else(|| receiver.strip_prefix("this."))?;
        let field = names::root(field);
        chain.iter().find_map(|unit| {
            let owner = self.nodes.get(unit)?.parent.as_deref()?;
            let member = self.members.get(&(owner, field))?;
            member
                .type_annotation
                .as_deref()
                .or_else(|| member.signature.as_ref()?.return_type.as_deref())
                .and_then(|held| self.of_annotation(held, endpoints, file))
        })
    }
}

struct Site<'a> {
    unit: &'a str,
    file: u32,
    line: u32,
}

pub fn derive(files: &[String], nodes: &[IndexNode], calls: &[CallFact], locals: &[LocalBinding], imports: &[ImportFact]) -> Vec<Crossing> {
    let evidence = Evidence::new(files, nodes, calls, locals, imports);
    let mut sending: HashMap<(u32, &str), Vec<Site>> = HashMap::default();
    let mut receiving: HashMap<(u32, &str), Vec<Site>> = HashMap::default();
    for call in calls {
        let (Some(unit), Some(receiver)) = (call.caller.as_deref(), call.receiver.as_deref()) else { continue };
        if files.get(call.file as usize).is_none_or(|path| is_test(path)) {
            continue;
        }
        let verb = names::leaf(&call.callee);
        let Some(rule) = queue_calls().iter().find(|rule| rule.role != QueueRole::Create && rule.verbs.iter().any(|held| held == verb)) else { continue };
        let chain = evidence.enclosing(unit);
        let endpoints: Vec<String> = queue_calls().iter().filter(|held| held.role == rule.role).flat_map(|held| held.endpoints.clone()).collect();
        let found = evidence
            .of_field(&chain, receiver, &endpoints, call.file)
            .or_else(|| evidence.of_name(&chain, names::root(receiver), &endpoints, call.file, 0));
        let Some(payload) = found else { continue };
        let held = match rule.role {
            QueueRole::Send => &mut sending,
            _ => &mut receiving,
        };
        held.entry(payload).or_default().push(Site { unit, file: call.file, line: call.line });
    }
    let mut found: BTreeSet<Crossing> = BTreeSet::new();
    for ((home, payload), from_sites) in &sending {
        let Some(to_sites) = receiving.get(&(*home, *payload)) else { continue };
        let mut kept = 0;
        for (from, to) in from_sites.iter().flat_map(|from| to_sites.iter().map(move |to| (from, to))) {
            if from.unit == to.unit || kept >= MOST_PER_QUEUE {
                continue;
            }
            kept += 1;
            found.insert(Crossing {
                kind: "queue",
                communication: "message",
                channel: (*payload).to_string(),
                from: from.unit.to_string(),
                from_file: from.file,
                from_line: from.line,
                through: None,
                to: to.unit.to_string(),
                to_file: to.file,
                to_line: to.line,
                to_end_line: None,
            });
        }
    }
    found.into_iter().collect()
}

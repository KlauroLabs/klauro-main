use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;

const STEPS_KEPT: usize = 16;
const FLOWS_KEPT: usize = 400;

#[derive(Debug, Serialize)]
pub struct Step {
    pub unit: String,
    pub depth: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leaves: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Flow {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<String>,
    pub id: String,
    pub entry_point: String,
    pub kind: &'static str,
    pub operation: String,
    pub standing: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<crate::author::Grounding>,
    pub steps: Vec<Step>,
    pub units: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leads_into: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Entity {
    pub declared_as: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub named_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<crate::author::Grounding>,
    pub declared_in: String,
    pub fields: u32,
    pub written_by: Vec<String>,
    pub read_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Capability {
    pub id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<String>,
    pub changes: Vec<String>,
    pub flows: Vec<String>,
    pub surfaces: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<crate::author::Grounding>,
}

#[derive(Debug, Serialize)]
pub struct Comprehension {
    pub capabilities: Vec<Capability>,
    pub flows: Vec<Flow>,
    pub entities: Vec<Entity>,
    pub terminal: u32,
    pub chained: u32,
}

static GENERIC: &[&str] = &[
    "Command", "Controller", "Handler", "Mutation", "Query", "Resolver", "Service", "View",
    "ViewSet", "handle", "perform_mutation", "run",
];

static CHANGING: &[&str] = &[
    "create", "delete", "dispatch", "emit", "enqueue", "insert", "patch", "post", "publish", "put",
    "remove", "save", "send", "set", "store", "update", "upsert", "write",
];

fn changes(exit: &ExitPoint) -> bool {
    let operation = exit.operation.to_ascii_lowercase();
    match exit.kind {
        "process" | "message" => true,
        "database" | "file" | "network" | "api" | "client_storage" | "cache" => CHANGING
            .iter()
            .any(|word| operation.contains(word)),
        _ => false,
    }
}

pub fn author(held: &mut Comprehension) -> u32 {
    if !crate::author::asked() {
        return 0;
    }
    let mut evidence = std::collections::BTreeMap::new();
    let mut owner: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut ticket = 0;
    let mut mark = |owner: &mut std::collections::BTreeMap<String, String>, id: &str| {
        ticket += 1;
        let key = format!("m{ticket}");
        owner.insert(key.clone(), id.to_string());
        key
    };
    for capability in held.capabilities.iter().take(40) {
        let key = mark(&mut owner, &capability.id);
        evidence.insert(
            key,
            format!(
                "  kind: capability of a software system\n  what it changes when it runs: {}\n                   how it is reached: {} flows\n  the surfaces that reach it, named as the code names them: {}",
                match capability.changes.is_empty() {
                    true => "nothing directly; it leads into other flows".to_string(),
                    false => capability.changes.join(", "),
                },
                capability.flows.len(),
                capability.surfaces.join(", ")
            ),
        );
    }
    for flow in held.flows.iter().filter(|flow| flow.standing != "reading").take(40) {
        let key = mark(&mut owner, &flow.id);
        evidence.insert(
            key,
            format!(
                "  kind: a path through the system that someone sets off\n  \
                 the operation it serves, named as the code names it: {}\n  \
                 how it is reached: {}\n  the records it writes: {}\n  \
                 it runs {} units and ends by: {}",
                flow.operation,
                flow.kind,
                match flow.writes.is_empty() {
                    true => "none named".to_string(),
                    false => flow.writes.join(", "),
                },
                flow.units,
                match flow.changes.is_empty() {
                    true => "leading into other paths".to_string(),
                    false => flow.changes.join(", "),
                }
            ),
        );
    }
    for entity in held.entities.iter().take(40) {
        let key = mark(&mut owner, &format!("entity:{}", entity.declared_in));
        evidence.insert(
            key,
            format!(
                "  kind: data entity\n  declared as: {} in {}\n  it holds these fields: {}\n  written by {} units, read by {} units",
                entity.declared_as,
                entity.declared_in.split(':').next().unwrap_or(""),
                match entity.named_fields.is_empty() {
                    true => format!("{} unnamed", entity.fields),
                    false => entity.named_fields.join(", "),
                },
                entity.written_by.len(),
                entity.read_by.len()
            ),
        );
    }
    let written = crate::author::name_them("outcomes, paths and data records", &evidence);
    let grounded = crate::author::ground(&written, &evidence);
    let by_id: std::collections::BTreeMap<String, (&crate::author::Written, crate::author::Grounding)> =
        owner
            .iter()
            .filter_map(|(key, id)| {
                Some((id.clone(), (written.get(key)?, grounded.get(key).copied()?)))
            })
            .collect();
    let mut settled = 0;
    for capability in held.capabilities.iter_mut() {
        let Some((held, grounding)) = by_id.get(&capability.id).copied() else { continue };
        let (name, description) = crate::author::written_name(held);
        capability.grounding = Some(grounding);
        if grounding.reads_as_an_outcome() {
            capability.name = Some(name.to_string());
            capability.description = Some(description.to_string());
            settled += 1;
        }
    }
    for flow in held.flows.iter_mut() {
        let Some((written, grounding)) = by_id.get(&flow.id).copied() else { continue };
        let (name, description) = crate::author::written_name(written);
        flow.grounding = Some(grounding);
        if grounding.reads_as_an_outcome() {
            flow.name = Some(name.to_string());
            flow.description = Some(description.to_string());
            settled += 1;
        }
    }
    for entity in held.entities.iter_mut() {
        let id = format!("entity:{}", entity.declared_in);
        let Some((held, grounding)) = by_id.get(&id).copied() else { continue };
        let (name, description) = crate::author::written_name(held);
        entity.grounding = Some(grounding);
        if grounding.holds() {
            entity.name = Some(name.to_string());
            entity.description = Some(description.to_string());
            settled += 1;
        }
    }
    settled
}

pub fn derive(
    nodes: &[IndexNode],
    files: &[String],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    roles: &crate::roles::Roles,
) -> Comprehension {
    let position_of: HashMap<&str, u32> = nodes
        .iter()
        .enumerate()
        .map(|(at, node)| (node.id.as_str(), at as u32))
        .collect();
    let mut next: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
    for edge in edges {
        let (Some(source), Some(target)) = (
            position_of.get(edge.source.as_str()).copied(),
            position_of.get(edge.target.as_str()).copied(),
        ) else {
            continue;
        };
        match edge.kind {
            EdgeKind::Calls | EdgeKind::Instantiates => next.entry(source).or_default().push(target),
            EdgeKind::HasMethod => members.entry(source).or_default().push(target),
            _ => {}
        }
    }
    let mut leaving: HashMap<&str, Vec<&ExitPoint>> = HashMap::new();
    for exit in exit_points {
        leaving.entry(exit.source.as_str()).or_default().push(exit);
    }

    let entities_first = entities(nodes, edges, exit_points, roles);
    let held: HashSet<&str> = entities_first
        .iter()
        .map(|entity| entity.declared_as.as_str())
        .collect();
    let mut entity_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for exit in exit_points {
        if exit.kind != "database" || !changes(exit) {
            continue;
        }
        let named = crate::names::root(&exit.target);
        if !held.contains(named) {
            continue;
        }
        let touching = entity_of.entry(exit.source.as_str()).or_default();
        if !touching.contains(&named) {
            touching.push(named);
        }
    }

    let served: Vec<&EntryPoint> = entry_points
        .iter()
        .filter(|entry| entry.kind != "test")
        .take(FLOWS_KEPT)
        .collect();
    let handlers: HashMap<&str, &str> = served
        .iter()
        .map(|entry| (entry.handler.as_str(), entry.id.as_str()))
        .collect();

    let named_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut flows = Vec::with_capacity(served.len());
    for entry in &served {
        let Some(start) = position_of.get(entry.handler.as_str()).copied() else { continue };
        let mut seen: HashSet<u32> = HashSet::from([start]);
        let mut queue: Vec<(u32, u32)> = vec![(start, 0)];
        for member in members.get(&start).into_iter().flatten() {
            if seen.insert(*member) {
                queue.push((*member, 0));
            }
        }
        let mut steps = Vec::new();
        let mut changing: Vec<String> = Vec::new();
        let mut into: Vec<String> = Vec::new();
        let mut head = 0;
        while head < queue.len() {
            let (current, depth) = queue[head];
            head += 1;
            let unit = nodes[current as usize].id.as_str();
            let leaves: Vec<String> = leaving
                .get(unit)
                .into_iter()
                .flatten()
                .map(|exit| format!("{}:{}", exit.kind, exit.operation))
                .collect();
            for exit in leaving.get(unit).into_iter().flatten() {
                if changes(exit) {
                    changing.push(format!("{}:{}", exit.kind, exit.operation));
                }
            }
            if let Some(other) = handlers.get(unit)
                && *other != entry.id
            {
                into.push((*other).to_string());
            }
            if steps.len() < STEPS_KEPT {
                steps.push(Step { unit: unit.to_string(), depth, leaves });
            }
            for target in next.get(&current).into_iter().flatten() {
                if seen.insert(*target) {
                    queue.push((*target, depth + 1));
                }
            }
        }
        changing.sort();
        changing.dedup();
        into.sort();
        into.dedup();
        let standing = match (!changing.is_empty(), !into.is_empty()) {
            (true, _) => "terminal",
            (false, true) => "proximal",
            (false, false) => "reading",
        };
        let named = named_of
            .get(entry.handler.as_str())
            .and_then(|node| node.parent.as_deref())
            .and_then(|parent| named_of.get(parent))
            .filter(|owner| owner.kind.is_type())
            .map(|owner| owner.name.as_str())
            .filter(|named| !GENERIC.contains(named))
            .map(str::to_string)
            .or_else(|| {
                GENERIC.contains(&entry.name.as_str()).then(|| {
                    let path = crate::paths::basename(&files[entry.file as usize]);
                    path.split('.').next().unwrap_or(path).to_string()
                })
            })
            .unwrap_or_else(|| entry.name.clone());
        let mut writes: Vec<String> = seen
            .iter()
            .filter_map(|unit| entity_of.get(nodes[*unit as usize].id.as_str()))
            .flatten()
            .map(|named| (*named).to_string())
            .collect();
        writes.sort();
        writes.dedup();
        flows.push(Flow {
            writes,
            id: format!("flow:{}", entry.id),
            entry_point: entry.id.clone(),
            kind: entry.kind,
            operation: named,
            name: None,
            description: None,
            grounding: None,
            standing,
            steps,
            units: seen.len() as u32,
            changes: changing,
            leads_into: into,
            project: nodes[start as usize].project.clone(),
        });
    }
    flows.sort_by(|left, right| left.id.cmp(&right.id));

    let entities = entities_first;
    let terminal = flows.iter().filter(|flow| flow.standing == "terminal").count() as u32;
    let chained = flows.iter().filter(|flow| !flow.leads_into.is_empty()).count() as u32;
    let capabilities = capabilities(&flows);
    Comprehension { capabilities, flows, entities, terminal, chained }
}

fn capabilities(flows: &[Flow]) -> Vec<Capability> {
    let mut grouped: HashMap<(Option<String>, String), Vec<&Flow>> = HashMap::new();
    for flow in flows {
        if flow.standing == "reading" {
            continue;
        }
        let signatures: Vec<String> = match (flow.writes.is_empty(), flow.changes.is_empty()) {
            (false, _) => flow.writes.clone(),
            (true, false) => vec![flow.changes.join(",")],
            (true, true) => vec!["reaches other flows".to_string()],
        };
        for signature in signatures {
            grouped.entry((flow.project.clone(), signature)).or_default().push(flow);
        }
    }
    let mut capabilities: Vec<Capability> = grouped
        .into_iter()
        .map(|((project, signature), held)| {
            let mut surfaces: Vec<String> = held.iter().map(|flow| flow.operation.clone()).collect();
            surfaces.sort();
            surfaces.dedup();
            surfaces.truncate(12);
            let mut changes: Vec<String> = held
                .iter()
                .flat_map(|flow| flow.changes.iter().cloned())
                .collect();
            changes.sort();
            changes.dedup();
            let records = match held.iter().any(|flow| flow.writes.contains(&signature)) {
                true => vec![signature.clone()],
                false => Vec::new(),
            };
            Capability {
                records,
                id: format!("capability:{}:{signature}", project.as_deref().unwrap_or("root")),
                changes,
                flows: held.iter().map(|flow| flow.id.clone()).collect(),
                surfaces,
                project,
                name: None,
                description: None,
                grounding: None,
            }
        })
        .collect();
    capabilities.sort_by(|left, right| left.id.cmp(&right.id));
    capabilities
}

fn entities(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    exit_points: &[ExitPoint],
    roles: &crate::roles::Roles,
) -> Vec<Entity> {
    let named_of: HashMap<&str, &str> = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.name.as_str()))
        .collect();
    let mut fields: HashMap<&str, u32> = HashMap::new();
    let mut named_fields: HashMap<&str, Vec<String>> = HashMap::new();
    for edge in edges {
        if edge.kind == EdgeKind::HasField {
            *fields.entry(edge.source.as_str()).or_insert(0) += 1;
            let held = named_fields.entry(edge.source.as_str()).or_default();
            if held.len() < 16
                && let Some(named) = named_of.get(edge.target.as_str())
            {
                held.push((*named).to_string());
            }
        }
    }
    let modelled: HashSet<&str> = roles
        .roles
        .iter()
        .filter(|role| role.role == "model")
        .map(|role| role.node.as_str())
        .collect();
    let stored: HashSet<&str> = exit_points
        .iter()
        .filter(|exit| exit.kind == "database")
        .map(|exit| crate::names::root(&exit.target))
        .collect();
    let storing: HashSet<&str> = exit_points
        .iter()
        .filter(|exit| matches!(exit.kind, "database" | "file" | "client_storage"))
        .map(|exit| exit.source.as_str())
        .collect();
    let holder_of: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|node| Some((node.id.as_str(), node.parent.as_deref()?)))
        .collect();
    let mut written: HashMap<&str, Vec<String>> = HashMap::new();
    let mut read: HashMap<&str, Vec<String>> = HashMap::new();
    for edge in edges {
        if !matches!(edge.kind, EdgeKind::Instantiates | EdgeKind::Calls) {
            continue;
        }
        let holder = holder_of.get(edge.target.as_str()).copied().unwrap_or(edge.target.as_str());
        let held = match storing.contains(edge.source.as_str()) {
            true => written.entry(holder).or_default(),
            false => read.entry(holder).or_default(),
        };
        if held.len() < 8 {
            held.push(edge.source.clone());
        }
    }
    let mut entities: Vec<Entity> = nodes
        .iter()
        .filter(|node| node.kind.is_type())
        .filter(|node| {
            modelled.contains(node.id.as_str()) || stored.contains(node.name.as_str())
        })
        .filter(|node| fields.get(node.id.as_str()).copied().unwrap_or(0) >= 1)
        .map(|node| Entity {
            declared_as: node.name.clone(),
            named_fields: named_fields.get(node.id.as_str()).cloned().unwrap_or_default(),
            name: None,
            description: None,
            grounding: None,
            declared_in: node.id.clone(),
            fields: fields.get(node.id.as_str()).copied().unwrap_or(0),
            written_by: written.get(node.id.as_str()).cloned().unwrap_or_default(),
            read_by: read.get(node.id.as_str()).cloned().unwrap_or_default(),
            project: node.project.clone(),
        })
        .collect();
    entities.sort_by(|left, right| {
        right
            .fields
            .cmp(&left.fields)
            .then(left.declared_in.cmp(&right.declared_in))
    });
    entities.truncate(FLOWS_KEPT);
    entities
}

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;

const STEPS_KEPT: usize = 16;
const FLOWS_KEPT: usize = 400;
const PROPOSED: usize = 160;

fn shared<T>(lanes: &[Vec<T>], budget: usize) -> Vec<usize> {
    let offered: usize = lanes.iter().map(Vec::len).sum();
    let mut shares: Vec<usize> = lanes
        .iter()
        .map(|lane| match offered <= budget {
            true => lane.len(),
            false => (budget * lane.len() / offered).max(1).min(lane.len()),
        })
        .collect();
    let mut spent: usize = shares.iter().sum();
    let mut order: Vec<usize> = (0..lanes.len()).collect();
    order.sort_by_key(|at| std::cmp::Reverse(lanes[*at].len()));
    while spent > budget {
        let Some(at) = order.iter().rev().find(|at| shares[**at] > 1).copied() else { break };
        shares[at] -= 1;
        spent -= 1;
    }
    while spent < budget {
        let Some(at) = order.iter().find(|at| shares[**at] < lanes[**at].len()).copied() else {
            break;
        };
        shares[at] += 1;
        spent += 1;
    }
    shares
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
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
    pub id: String,
    pub declared_as: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub named_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<crate::author::Grounding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_in: Option<String>,
    pub fields: u32,
    pub addressed_by: u32,
    pub written_by: Vec<String>,
    pub read_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Delivery {
    pub flow: String,
    pub role: &'static str,
    pub rationale: String,
}

#[derive(Debug, Serialize)]
pub struct Capability {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub delivered: Vec<Delivery>,
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
pub struct Product {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub description: String,
    pub grounding: crate::author::Grounding,
}

#[derive(Debug, Serialize)]
pub struct Comprehension {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub products: Vec<Product>,
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

const ASSIGNED: f64 = 0.6;
const TESTED: f64 = 0.5;

fn spoken_for(root: &std::path::Path, nodes: &[IndexNode], files: &[String]) -> String {
    let mut said = Vec::new();
    for (at, path) in files.iter().enumerate() {
        let basename = crate::paths::basename(path).to_ascii_lowercase();
        if basename.starts_with("readme") && path.matches('/').count() == 0 {
            if let Ok(text) = std::fs::read_to_string(root.join(path)) {
                let opening: String = text.lines().take(24).collect::<Vec<_>>().join("\n");
                said.push(opening.chars().take(1600).collect::<String>());
            }
            let _ = at;
            break;
        }
    }
    for node in nodes {
        if node.name != "description" || node.kind != NodeKind::Property {
            continue;
        }
        let Some(path) = files.get(node.file as usize) else { continue };
        if !matches!(
            crate::paths::basename(path),
            "package.json" | "composer.json" | "pyproject.toml" | "Cargo.toml" | "pubspec.yaml"
        ) {
            continue;
        }
        if let Some(said_here) = node.type_annotation.as_deref() {
            said.push(format!("It describes itself as: {}", said_here.trim_matches('"')));
        }
    }
    match said.is_empty() {
        true => "It says nothing about itself.".to_string(),
        false => said.join("\n"),
    }
}

pub struct Telling<'a> {
    pub shape: &'a str,
    pub serving: u32,
    pub routes: u32,
    pub shipped: u32,
    pub projects: usize,
    pub languages: Vec<(String, u32)>,
    pub frameworks: Vec<String>,
}

fn describe_product(held: &mut Comprehension, spoken: &str, told: &Telling<'_>) {
    if held.capabilities.is_empty() {
        return;
    }
    let mut projects: Vec<Option<String>> = held
        .capabilities
        .iter()
        .map(|capability| capability.project.clone())
        .collect();
    projects.sort();
    projects.dedup();
    let mut written: Vec<Product> = Vec::new();
    if projects.len() > 1 {
        for project in &projects {
            if let Some(product) = describe_one(held, spoken, told, project.as_deref()) {
                written.push(product);
            }
        }
    }
    if let Some(whole) = describe_one(held, spoken, told, None) {
        written.push(whole);
    }
    written.sort_by(|left, right| left.project.cmp(&right.project));
    held.products = written;
}

fn describe_one(
    held: &Comprehension,
    spoken: &str,
    told: &Telling<'_>,
    project: Option<&str>,
) -> Option<Product> {
    let its = |held: Option<&String>| project.is_none() || held.map(String::as_str) == project;
    let capabilities: Vec<&Capability> = held
        .capabilities
        .iter()
        .filter(|capability| its(capability.project.as_ref()))
        .collect();
    if capabilities.is_empty() {
        return None;
    }
    let facts = format!(
        "{}The product says this about itself:\n{spoken}\n\n\
         What someone can do with it, read from the code, with the audience each is for:\n{}\n\n\
         What it keeps: {}\n\
         {}How it serves: {} across {} serving surfaces, {} routes\n\
         How it ships: {} shipped units across {} projects\n\
         What it is written in: {}\n\
         What it is built with: {}",
        match project {
            Some(named) => format!(
                "These facts are about one part of a larger repository, the part called {named}. \
                 Describe that part, not the repository around it.\n\n"
            ),
            None => String::new(),
        },
        capabilities
            .iter()
            .map(|capability| format!(
                "- {} (for {}): {}",
                capability.name.as_deref().unwrap_or(""),
                capability.audience.as_deref().unwrap_or("someone"),
                capability.description.as_deref().unwrap_or("")
            ))
            .collect::<Vec<_>>()
            .join("\n"),
        {
            let mut kept: Vec<&str> = match project {
                Some(_) => capabilities
                    .iter()
                    .flat_map(|capability| capability.records.iter().map(String::as_str))
                    .collect(),
                None => held
                    .entities
                    .iter()
                    .map(|entity| entity.declared_as.as_str())
                    .collect(),
            };
            kept.dedup();
            kept.truncate(14);
            match kept.is_empty() {
                true => "no named records".to_string(),
                false => kept.join(", "),
            }
        },
        match project.is_some() {
            true => "These last counts are the whole repository's, not this part's, and belong in a \
                     description of this part only where they are plainly true of it:\n",
            false => "",
        },
        told.shape,
        told.serving,
        told.routes,
        told.shipped,
        told.projects,
        told.languages
            .iter()
            .take(4)
            .map(|(language, count)| format!("{language} ({count} files)"))
            .collect::<Vec<_>>()
            .join(", "),
        match told.frameworks.is_empty() {
            true => "nothing the catalog names".to_string(),
            false => told.frameworks.join(", "),
        }
    );
    let description = crate::author::describe_system(&facts)?;
    let grounding = crate::author::test_description(&format!(
        "{facts}\n\nPROPOSED DESCRIPTION: {description}"
    ));
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!(
            "product {:<34} supported {:.2} invented {:.2} outcome {:.2} -> {}",
            project.unwrap_or("the whole system"),
            grounding.supported,
            grounding.invented,
            grounding.outcome,
            grounding.holds() && grounding.outcome >= TESTED
        );
    }
    (grounding.holds() && grounding.outcome >= TESTED).then(|| Product {
        project: project.map(str::to_string),
        description,
        grounding,
    })
}

fn test_capabilities(held: &mut Comprehension, spoken: &str) {
    let tests: Vec<(String, crate::author::Grounding)> = held
        .capabilities
        .iter()
        .map(|capability| {
            let facts = format!(
                "A software system describes itself like this:\n{spoken}\n\n\
                 FACTS about one part of it:\n  reached through these surfaces: {}\n  \
                 it writes these records: {}\n  it ends by: {}\n\n\
                 PROPOSED CAPABILITY: {}\nPROPOSED DESCRIPTION: {}",
                capability.surfaces.join(", "),
                match capability.records.is_empty() {
                    true => "none named".to_string(),
                    false => capability.records.join(", "),
                },
                match capability.changes.is_empty() {
                    true => "leading into other paths".to_string(),
                    false => capability.changes.join(", "),
                },
                capability.name.as_deref().unwrap_or(""),
                capability.description.as_deref().unwrap_or("")
            );
            (capability.id.clone(), crate::author::test_capability(&facts))
        })
        .collect();
    let judged: HashMap<String, crate::author::Grounding> = tests.into_iter().collect();
    held.capabilities.retain_mut(|capability| {
        let Some(grounding) = judged.get(&capability.id).copied() else { return false };
        capability.grounding = Some(grounding);
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!(
                "capability {:<44} supported {:.2} invented {:.2} outcome {:.2} universal {:.2} -> {}",
                capability.name.as_deref().unwrap_or(""),
                grounding.supported,
                grounding.invented,
                grounding.outcome,
                grounding.universal.unwrap_or(1.0),
                grounding.stands()
            );
        }
        grounding.stands()
    });
}

fn form_capabilities(held: &mut Comprehension, spoken: &str) {
    if !crate::author::asked() || !crate::jev::asked() {
        return;
    }
    let mut ranked: Vec<&Flow> = held.flows.iter().collect();
    ranked.sort_by_key(|flow| match flow.standing {
        "terminal" => 0,
        "proximal" => 1,
        _ => 2,
    });
    let mut lanes: BTreeMap<Option<&str>, Vec<&Flow>> = BTreeMap::new();
    for flow in ranked {
        lanes.entry(flow.project.as_deref()).or_default().push(flow);
    }
    let lanes: Vec<Vec<&Flow>> = lanes.into_values().collect();
    let shares = shared(&lanes, PROPOSED);
    let ranked: Vec<&Flow> = lanes
        .iter()
        .zip(&shares)
        .flat_map(|(lane, share)| lane.iter().take(*share).copied())
        .collect();
    let candidates: Vec<(&str, String)> = ranked
        .into_iter()
        .map(|flow| {
            (
                flow.id.as_str(),
                format!(
                    "- reached by: {}{} ({}), it {}, writes: {}, ends by: {}",
                    flow.method.as_deref().map(|held| format!("{held} ")).unwrap_or_default(),
                    flow.operation,
                    flow.kind,
                    match flow.standing {
                        "terminal" => "changes something outside the process",
                        "proximal" => "sets off other paths",
                        _ => "only reads",
                    },
                    match flow.writes.is_empty() {
                        true => "no named record".to_string(),
                        false => flow.writes.join("/"),
                    },
                    match flow.changes.is_empty() {
                        true => "nothing directly".to_string(),
                        false => flow.changes.join("/"),
                    }
                ),
            )
        })
        .collect();
    let outcomes = crate::author::propose_outcomes(
        &candidates.iter().map(|(_, facts)| facts.clone()).collect::<Vec<_>>(),
        spoken,
    );
    if outcomes.is_empty() {
        return;
    }
    let mut criteria: std::collections::BTreeMap<String, String> = outcomes
        .iter()
        .enumerate()
        .map(|(at, outcome)| (format!("o{at}"), outcome.description.clone()))
        .collect();
    criteria.insert("none".to_string(), "This path serves none of these".to_string());
    let questions: std::collections::BTreeMap<String, crate::jev::Question> = candidates
        .iter()
        .enumerate()
        .map(|(at, (_, facts))| {
            (
                format!("f{at}"),
                crate::jev::Question {
                    kind: "choice",
                    instructions: format!("Which outcome does this path serve? {facts}"),
                    criteria: criteria.clone().into(),
                },
            )
        })
        .collect();
    let state = format!(
        "A software system describes itself like this:\n{spoken}\n\nIt delivers these outcomes:\n{}\n\n\
         Each question names one path through the system. Decide which outcome that path serves.",
        outcomes
            .iter()
            .enumerate()
            .map(|(at, outcome)| format!("o{at}: {} — {}", outcome.name, outcome.description))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let answers = crate::jev::decide(&state, questions);
    let mut grouped: HashMap<usize, Vec<(&Flow, f64)>> = HashMap::new();
    let by_id: HashMap<&str, &Flow> = held.flows.iter().map(|flow| (flow.id.as_str(), flow)).collect();
    for (at, (id, _)) in candidates.iter().enumerate() {
        let Some(answer) = answers.get(&format!("f{at}")) else { continue };
        let Some(chosen) = answer.held(ASSIGNED) else { continue };
        let Some(outcome) = chosen.strip_prefix('o').and_then(|at| at.parse::<usize>().ok()) else {
            continue;
        };
        if let Some(flow) = by_id.get(id) {
            grouped
                .entry(outcome)
                .or_default()
                .push((flow, answer.confidence.unwrap_or(0.0)));
        }
    }
    let mut capabilities: Vec<Capability> = grouped
        .into_iter()
        .filter_map(|(at, flows)| {
            let outcome = outcomes.get(at)?;
            let mut surfaces: Vec<String> = flows
                .iter()
                .map(|(flow, _)| match flow.method.as_deref() {
                    Some(method) => format!("{method} {}", flow.operation),
                    None => flow.operation.clone(),
                })
                .collect();
            surfaces.sort();
            surfaces.dedup();
            surfaces.truncate(12);
            let mut records: Vec<String> = flows
                .iter()
                .flat_map(|(flow, _)| flow.writes.iter().cloned())
                .collect();
            records.sort();
            records.dedup();
            let mut changes: Vec<String> = flows
                .iter()
                .flat_map(|(flow, _)| flow.changes.iter().cloned())
                .collect();
            changes.sort();
            changes.dedup();
            let mut delivered: Vec<Delivery> = flows
                .iter()
                .map(|(flow, settled)| Delivery {
                    flow: flow.id.clone(),
                    role: match *settled >= 0.85 {
                        true => "primary",
                        false => "supporting",
                    },
                    rationale: format!(
                        "{} {} and it was placed here with confidence {:.2}",
                        flow.operation,
                        match flow.changes.is_empty() {
                            true => "leads into other paths".to_string(),
                            false => format!("ends by {}", flow.changes.join(", ")),
                        },
                        settled
                    ),
                })
                .collect();
            delivered.sort_by(|left, right| left.flow.cmp(&right.flow));
            Some(Capability {
                id: format!("capability:{}", outcome.name.to_ascii_lowercase().replace(' ', "-")),
                records,
                changes,
                flows: delivered.iter().map(|held| held.flow.clone()).collect(),
                delivered,
                surfaces,
                project: flows.first().and_then(|(flow, _)| flow.project.clone()),
                audience: match outcome.audience.is_empty() {
                    true => None,
                    false => Some(outcome.audience.clone()),
                },
                name: Some(outcome.name.clone()),
                description: Some(outcome.description.clone()),
                grounding: None,
            })
        })
        .collect();
    capabilities.sort_by(|left, right| left.id.cmp(&right.id));
    held.capabilities = capabilities;
}

pub fn author(
    held: &mut Comprehension,
    root: &std::path::Path,
    nodes: &[IndexNode],
    files: &[String],
    told: &Telling<'_>,
) -> u32 {
    if !crate::author::asked() || !crate::jev::asked() {
        return 0;
    }
    let spoken = spoken_for(root, nodes, files);
    form_capabilities(held, &spoken);
    test_capabilities(held, &spoken);
    describe_product(held, &spoken, told);
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
    for flow in held.flows.iter().take(40) {
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
        let key = mark(&mut owner, &entity.id);
        evidence.insert(
            key,
            format!(
                "  kind: data entity\n  {}\n  it holds these fields: {}\n  written by {} units, read by {} units",
                match entity.declared_in.as_deref() {
                    Some(held) => format!(
                        "declared as: {} in {}",
                        entity.declared_as,
                        held.split(':').next().unwrap_or("")
                    ),
                    None => format!(
                        "never declared; the database is addressed by the name {} in {} places",
                        entity.declared_as, entity.addressed_by
                    ),
                },
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
    settled += held.capabilities.len() as u32;
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
        let Some((held, grounding)) = by_id.get(&entity.id).copied() else { continue };
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
            EdgeKind::Contains | EdgeKind::HasMethod => {
                members.entry(source).or_default().push(target)
            }
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

    let project_of: HashMap<&str, Option<&str>> =
        nodes.iter().map(|node| (node.id.as_str(), node.project.as_deref())).collect();
    let mut by_project: BTreeMap<Option<&str>, Vec<&EntryPoint>> = BTreeMap::new();
    for entry in entry_points.iter().filter(|entry| entry.kind != "test") {
        by_project
            .entry(project_of.get(entry.handler.as_str()).copied().flatten())
            .or_default()
            .push(entry);
    }
    let lanes: Vec<Vec<&EntryPoint>> = by_project.into_values().collect();
    let shares = shared(&lanes, FLOWS_KEPT);
    let served: Vec<&EntryPoint> = lanes
        .iter()
        .zip(&shares)
        .flat_map(|(lane, share)| lane.iter().take(*share).copied())
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
            method: entry.method.clone(),
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
    Comprehension { products: Vec::new(), capabilities: Vec::new(), flows, entities, terminal, chained }
}

static MANAGERS: &[&str] = &["db_session", "objects", "session"];
static HANDLES: &[&str] = &[
    "CrudRepository",
    "DbQuery",
    "DbSet",
    "EntityRepository",
    "IMongoCollection",
    "JpaRepository",
    "MongoCollection",
    "MongoRepository",
    "Repository",
];

fn held_by_a_handle(annotation: &str) -> Option<&str> {
    let (handle, rest) = annotation.split_once('<')?;
    let handle = handle.rsplit(['.', ':']).next()?;
    if HANDLES.binary_search(&handle).is_err() {
        return None;
    }
    let held = rest.strip_suffix('>')?;
    match held.contains([',', '<']) {
        true => None,
        false => Some(held.trim()),
    }
}

fn receiver_of(exit: &ExitPoint) -> &str {
    exit.name.strip_suffix(&format!(".{}", exit.operation)).unwrap_or(&exit.name)
}

fn plainly_named(held: &str) -> bool {
    !held.is_empty()
        && held.chars().all(|letter| letter.is_alphanumeric() || letter == '_')
        && !held.chars().next().is_some_and(|letter| letter.is_ascii_digit())
}

fn addressed<'a>(receiver: &'a str, modelled: &HashSet<&str>) -> Option<&'a str> {
    let segments: Vec<&str> = receiver
        .split('.')
        .filter(|held| !matches!(*held, "this" | "self"))
        .collect();
    if !segments.iter().all(|held| plainly_named(held)) {
        return None;
    }
    if let Some(at) = segments.iter().position(|held| MANAGERS.binary_search(held).is_ok()) {
        return segments[..at].last().copied().filter(|held| modelled.contains(held));
    }
    match segments.len() == 2 {
        true => segments.get(1).copied(),
        false => None,
    }
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
        .filter(|role| role.role == "model" && !role.from.starts_with("name:"))
        .map(|role| role.node.as_str())
        .collect();
    let handled: HashSet<&str> = nodes
        .iter()
        .filter_map(|node| node.type_annotation.as_deref())
        .filter_map(held_by_a_handle)
        .collect();
    let modelled_names: HashSet<&str> = nodes
        .iter()
        .filter(|node| modelled.contains(node.id.as_str()))
        .map(|node| node.name.as_str())
        .collect();
    let mut kept: BTreeMap<String, (Vec<String>, Vec<String>, u32)> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "database") {
        let Some(named) = addressed(receiver_of(exit), &modelled_names) else { continue };
        let held = kept.entry(named.to_ascii_lowercase()).or_default();
        held.2 += 1;
        let reaching = match changes(exit) {
            true => &mut held.0,
            false => &mut held.1,
        };
        if reaching.len() < 8 && !reaching.contains(&exit.source) {
            reaching.push(exit.source.clone());
        }
    }
    let stored: HashSet<&str> = kept.keys().map(String::as_str).collect();
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
            modelled.contains(node.id.as_str())
                || handled.contains(node.name.as_str())
                || (stored.contains(node.name.to_ascii_lowercase().as_str())
                    && fields.get(node.id.as_str()).copied().unwrap_or(0) >= 1)
        })
        .map(|node| Entity {
            id: format!("entity:{}", node.id),
            addressed_by: kept
                .get(&node.name.to_ascii_lowercase())
                .map(|held| held.2)
                .unwrap_or(0),
            declared_as: node.name.clone(),
            named_fields: named_fields.get(node.id.as_str()).cloned().unwrap_or_default(),
            name: None,
            description: None,
            grounding: None,
            declared_in: Some(node.id.clone()),
            fields: fields.get(node.id.as_str()).copied().unwrap_or(0),
            written_by: written.get(node.id.as_str()).cloned().unwrap_or_default(),
            read_by: read.get(node.id.as_str()).cloned().unwrap_or_default(),
            project: node.project.clone(),
        })
        .collect();
    let mut richest: BTreeMap<String, Entity> = BTreeMap::new();
    for entity in entities {
        match richest.entry(entity.declared_as.to_ascii_lowercase()) {
            std::collections::btree_map::Entry::Vacant(held) => {
                held.insert(entity);
            }
            std::collections::btree_map::Entry::Occupied(mut held) => {
                if entity.fields > held.get().fields {
                    held.insert(entity);
                }
            }
        }
    }
    let written_down: HashSet<String> = richest.keys().cloned().collect();
    let mut entities: Vec<Entity> = richest.into_values().collect();
    for (named, (written_by, read_by, addressed_by)) in kept {
        if written_down.contains(&named) {
            continue;
        }
        entities.push(Entity {
            id: format!("record:{named}"),
            declared_as: named,
            named_fields: Vec::new(),
            name: None,
            description: None,
            grounding: None,
            declared_in: None,
            fields: 0,
            addressed_by,
            written_by,
            read_by,
            project: None,
        });
    }
    entities.sort_by(|left, right| {
        right
            .addressed_by
            .cmp(&left.addressed_by)
            .then(right.fields.cmp(&left.fields))
            .then(left.id.cmp(&right.id))
    });
    entities.truncate(FLOWS_KEPT);
    entities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_database_call_names_the_record_it_addresses() {
        let modelled = HashSet::from(["Booking"]);
        assert_eq!(addressed("prisma.booking", &modelled), Some("booking"));
        assert_eq!(addressed("this.prisma.booking", &modelled), Some("booking"));
        assert_eq!(addressed("Booking.objects", &modelled), Some("Booking"));
        assert_eq!(addressed("db.session", &modelled), None);
        assert_eq!(addressed("session", &modelled), None);
        assert_eq!(addressed("queryHistoryApi.endpoints.editorQueries", &modelled), None);
        assert_eq!(addressed("request(app.getHttpServer())", &modelled), None);
    }

    #[test]
    fn a_persistence_handle_names_what_it_holds() {
        assert_eq!(held_by_a_handle("DbSet<AccessSchedule>"), Some("AccessSchedule"));
        assert_eq!(held_by_a_handle("Microsoft.EntityFrameworkCore.DbSet<User>"), Some("User"));
        assert_eq!(held_by_a_handle("Dictionary<string, User>"), None);
        assert_eq!(held_by_a_handle("DbSet<List<User>>"), None);
        assert_eq!(held_by_a_handle("User"), None);
    }
}


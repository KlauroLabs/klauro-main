use std::collections::{BTreeMap, HashMap, HashSet};
use rayon::prelude::*;

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;
use crate::tables::Table;

const STEPS_KEPT: usize = 16;
const REACHING_AT_ONCE: usize = 24;

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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<String>,
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
pub struct Reference {
    pub field: String,
    pub entity: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub many: bool,
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
    /// The records this one points at, and the field that points.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<Reference>,
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
    "Command", "Controller", "Handler", "Main", "Mutation", "Query", "Resolver", "Service", "View",
    "ViewSet", "handle", "main", "on", "perform_mutation", "run", "wmain",
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

fn describe_product(
    capabilities: &[Capability],
    entities: &[Entity],
    spoken: &str,
    told: &Telling<'_>,
) -> Vec<Product> {
    if capabilities.is_empty() {
        return Vec::new();
    }
    let mut projects: Vec<Option<String>> = capabilities
        .iter()
        .map(|capability| capability.project.clone())
        .collect();
    projects.sort();
    projects.dedup();
    let mut wanted: Vec<Option<&str>> = Vec::new();
    if projects.len() > 1 {
        wanted.extend(projects.iter().map(|project| project.as_deref()));
    }
    wanted.push(None);
    let mut written: Vec<Product> = wanted
        .into_par_iter()
        .filter_map(|project| describe_one(capabilities, entities, spoken, told, project))
        .collect();
    written.sort_by(|left, right| left.project.cmp(&right.project));
    written
}

fn describe_one(
    held: &[Capability],
    entities: &[Entity],
    spoken: &str,
    told: &Telling<'_>,
    project: Option<&str>,
) -> Option<Product> {
    let its = |held: Option<&String>| project.is_none() || held.map(String::as_str) == project;
    let capabilities: Vec<&Capability> = held
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
                None => entities.iter().map(|entity| entity.declared_as.as_str()).collect(),
            };
            kept.dedup();
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

fn test_capabilities(capabilities: &mut Vec<Capability>, spoken: &str) {
    let tests: Vec<(String, String)> = capabilities
        .iter()
        .map(|capability| {
            let facts = format!(
                "FACTS about one part of it:\n  reached through these surfaces: {}\n  \
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
            (capability.id.clone(), facts)
        })
        .collect();
    let judged = crate::author::test_capabilities(
        &format!("A software system describes itself like this:\n{spoken}"),
        &tests,
    );
    capabilities.retain_mut(|capability| {
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

fn form_capabilities(held: &Comprehension, spoken: &str) -> Vec<Capability> {
    if !crate::author::asked() || !crate::jev::asked() {
        return Vec::new();
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
    let mut lanes: Vec<Vec<&Flow>> = lanes.into_values().collect();
    for lane in &mut lanes {
        let mut seen: HashSet<String> = HashSet::new();
        lane.retain(|flow| {
            seen.insert(format!(
                "{}|{}|{}|{}",
                flow.operation,
                flow.standing,
                flow.writes.join(","),
                flow.changes.join(",")
            ))
        });
    }
    let ranked: Vec<&Flow> = lanes.into_iter().flatten().collect();
    let candidates: Vec<(&str, String)> = ranked
        .into_iter()
        .map(|flow| {
            (
                flow.id.as_str(),
                format!(
                    "{}{} ({}), {}{}",
                    flow.method.as_deref().map(|held| format!("{held} ")).unwrap_or_default(),
                    flow.operation,
                    flow.kind,
                    match flow.standing {
                        "terminal" => "changes",
                        "proximal" => "leads on",
                        _ => "reads",
                    },
                    match (flow.writes.is_empty(), flow.reads.is_empty()) {
                        (true, true) => String::new(),
                        (true, false) => format!(" reads {}", flow.reads.join("/")),
                        (false, true) => format!(" {}", flow.writes.join("/")),
                        (false, false) => {
                            format!(" {} reads {}", flow.writes.join("/"), flow.reads.join("/"))
                        }
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
        return Vec::new();
    }
    let mut criteria: std::collections::BTreeMap<String, String> = outcomes
        .iter()
        .enumerate()
        .map(|(at, outcome)| (format!("o{at}"), outcome.name.clone()))
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
        "Outcomes of this system: {}",
        outcomes
            .iter()
            .enumerate()
            .map(|(at, outcome)| format!("o{at} {}", outcome.name))
            .collect::<Vec<_>>()
            .join("; ")
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
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        let settled = candidates
            .iter()
            .enumerate()
            .filter(|(at, _)| {
                answers.get(&format!("f{at}")).and_then(|held| held.held(ASSIGNED)).is_some()
            })
            .count();
        eprintln!(
            "  author proposed {} outcomes, answered {} of {} paths, settled {}, grouped {}",
            outcomes.len(),
            answers.len(),
            candidates.len(),
            settled,
            grouped.len()
        );
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
    capabilities
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
    let mut evidence = std::collections::BTreeMap::new();
    let mut owner: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut ticket = 0;
    let mut mark = |owner: &mut std::collections::BTreeMap<String, String>, id: &str| {
        ticket += 1;
        let key = format!("m{ticket}");
        owner.insert(key.clone(), id.to_string());
        key
    };
    for entity in held.entities.iter() {
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
    let started = std::time::Instant::now();
    let reaching = rayon::ThreadPoolBuilder::new()
        .num_threads(crate::author::reaching_at_once(REACHING_AT_ONCE))
        .build()
        .ok();
    let work = || rayon::join(
        || {
            let mut capabilities = form_capabilities(held, &spoken);
            let formed = started.elapsed();
            test_capabilities(&mut capabilities, &spoken);
            let tested = started.elapsed();
            let products = describe_product(&capabilities, &held.entities, &spoken, told);
            eprintln!(
                "  author form {formed:?} | test {:?} | describe {:?}",
                tested - formed,
                started.elapsed() - tested
            );
            (capabilities, products)
        },
        || {
            let written = crate::author::name_them("records this system keeps", &spoken, &evidence);
            let named = started.elapsed();
            let grounded = crate::author::ground(&written, &evidence);
            eprintln!("  author name {named:?} | ground {:?}", started.elapsed() - named);
            (written, grounded)
        },
    );
    let ((capabilities, products), (written, grounded)) = match &reaching {
        Some(pool) => pool.install(work),
        None => work(),
    };
    held.capabilities = capabilities;
    held.products = products;
    let delivered: HashMap<&str, (&str, &str)> = held
        .capabilities
        .iter()
        .flat_map(|capability| {
            let told = (
                capability.name.as_deref().unwrap_or_default(),
                capability.description.as_deref().unwrap_or_default(),
            );
            capability.flows.iter().map(move |flow| (flow.as_str(), told))
        })
        .collect();
    let spoken_of: HashMap<String, (String, String)> = held
        .flows
        .iter()
        .filter_map(|flow| {
            let (name, description) = delivered.get(flow.id.as_str())?;
            Some((flow.id.clone(), ((*name).to_string(), (*description).to_string())))
        })
        .collect();
    for flow in held.flows.iter_mut() {
        if let Some((name, description)) = spoken_of.get(&flow.id) {
            flow.name = Some(name.clone());
            flow.description = Some(description.clone());
        }
    }
    let by_id: std::collections::BTreeMap<String, (&crate::author::Written, crate::author::Grounding)> =
        owner
            .iter()
            .filter_map(|(key, id)| {
                Some((id.clone(), (written.get(key)?, grounded.get(key).copied()?)))
            })
            .collect();
    let mut settled = held.capabilities.len() as u32;
    for entity in held.entities.iter_mut() {
        entity.name = Some(crate::names::spoken_as(&entity.declared_as));
        let Some((held, grounding)) = by_id.get(&entity.id).copied() else { continue };
        let (_, description) = crate::author::written_name(held);
        entity.grounding = Some(grounding);
        if grounding.holds() {
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
    declared_tables: &[crate::tables::Table],
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

    let entities_first = entities(nodes, files, edges, exit_points, roles, declared_tables);
    let held: HashSet<&str> = entities_first
        .iter()
        .map(|entity| entity.declared_as.as_str())
        .collect();
    let mut entity_of: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut read_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for exit in exit_points {
        if exit.kind != "database" {
            continue;
        }
        let named = crate::names::root(&exit.target);
        if !held.contains(named) {
            continue;
        }
        let touching = match changes(exit) {
            true => entity_of.entry(exit.source.as_str()).or_default(),
            false => read_of.entry(exit.source.as_str()).or_default(),
        };
        if !touching.contains(&named) {
            touching.push(named);
        }
    }

    /// A surface carries a name someone could ask for. A keystroke a reader binds, a topic
    /// left unnamed, a timer known only by its handle: each is a registration and no more.
    fn names_a_surface(entry: &EntryPoint) -> bool {
        if entry.kind == "schedule" && !crate::entry_exit::recurring(&entry.registrar) {
            return false;
        }
        if !matches!(entry.kind, "event" | "message" | "schedule") {
            return true;
        }
        entry
            .name
            .as_bytes()
            .windows(2)
            .any(|held| held.iter().all(u8::is_ascii_alphabetic))
    }

    let project_of: HashMap<&str, Option<&str>> =
        nodes.iter().map(|node| (node.id.as_str(), node.project.as_deref())).collect();
    let mut by_project: BTreeMap<Option<&str>, Vec<&EntryPoint>> = BTreeMap::new();
    for entry in entry_points
        .iter()
        .filter(|entry| entry.kind != "test")
        .filter(|entry| names_a_surface(entry))
    {
        by_project
            .entry(project_of.get(entry.handler.as_str()).copied().flatten())
            .or_default()
            .push(entry);
    }
    let served: Vec<&EntryPoint> = by_project.into_values().flatten().collect();
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
        let named = entry
            .path
            .as_deref()
            .filter(|_| entry.kind == "http")
            .map(str::to_string)
            .or_else(|| {
                named_of
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
        let mut reads: Vec<String> = seen
            .iter()
            .filter_map(|unit| read_of.get(nodes[*unit as usize].id.as_str()))
            .flatten()
            .map(|named| (*named).to_string())
            .filter(|named| !writes.contains(named))
            .collect();
        reads.sort();
        reads.dedup();
        flows.push(Flow {
            writes,
            reads,
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

static DECLARED_OF: &[&str] = &[
    "appends",
    "attributes",
    "casts",
    "connection",
    "dates",
    "dispatchesEvents",
    "fillable",
    "guarded",
    "hidden",
    "incrementing",
    "keyType",
    "perPage",
    "primaryKey",
    "table",
    "timestamps",
    "touches",
    "with",
];

fn tells_of_itself(named: &str) -> bool {
    DECLARED_OF.binary_search(&named).is_ok()
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

fn addressed<'a>(
    receiver: &'a str,
    modelled: &HashSet<&str>,
    declared: &HashSet<String>,
) -> Option<&'a str> {
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
        true => segments
            .get(1)
            .copied()
            .filter(|held| declared.contains(&held.to_ascii_lowercase())),
        false => None,
    }
}

/// The record a field's type names, and whether the field holds many of them.
fn points_at(annotation: &str) -> Option<(String, bool)> {
    let mut held = annotation.trim();
    let many = held.contains("[]");
    loop {
        let trimmed = held
            .trim_end_matches(['?', '!', ' '])
            .trim_start_matches(['?', ' ']);
        let trimmed = trimmed.strip_suffix("[]").unwrap_or(trimmed);
        let trimmed = match (trimmed.find('<'), trimmed.rfind('>')) {
            (Some(open), Some(close)) if close > open + 1 => &trimmed[open + 1..close],
            _ => trimmed,
        };
        if trimmed == held {
            break;
        }
        held = trimmed;
    }
    let held = held.rsplit(['.', ':']).next()?.trim();
    let named = held
        .chars()
        .all(|letter| letter.is_alphanumeric() || letter == '_')
        .then(|| held.to_string())?;
    (!named.is_empty()).then_some((named, many))
}

/// A file that configures a codebase rather than declaring anything in it.
fn a_setting(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    [".yml", ".yaml", ".json", ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml"]
        .iter()
        .any(|extension| lowered.ends_with(extension))
}

/// Whether two shapes describe the same record, told by the fields they share.
fn the_same_record(left: &[String], right: &[String]) -> bool {
    let smaller = left.len().min(right.len());
    if smaller < 4 {
        return false;
    }
    let held: HashSet<String> = right.iter().map(|field| field.to_ascii_lowercase()).collect();
    let shared = left
        .iter()
        .filter(|field| held.contains(&field.to_ascii_lowercase()))
        .count();
    shared * 5 >= smaller * 4
}

/// A file whose whole purpose is to declare the shape of stored data.
fn a_schema(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.ends_with(".prisma") || lowered.ends_with(".sql")
}

fn entities(
    nodes: &[IndexNode],
    files: &[String],
    edges: &[IndexEdge],
    exit_points: &[ExitPoint],
    roles: &crate::roles::Roles,
    declared_tables: &[crate::tables::Table],
) -> Vec<Entity> {
    let node_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut fields: HashMap<&str, u32> = HashMap::new();
    let mut named_fields: HashMap<&str, Vec<String>> = HashMap::new();
    let mut pointing: HashMap<&str, Vec<Reference>> = HashMap::new();
    for edge in edges {
        if edge.kind == EdgeKind::HasField {
            *fields.entry(edge.source.as_str()).or_insert(0) += 1;
            let held = named_fields.entry(edge.source.as_str()).or_default();
            if let Some(field) = node_of.get(edge.target.as_str())
                && !tells_of_itself(&field.name)
            {
                held.push(field.name.clone());
                if let Some(annotation) = field.type_annotation.as_deref()
                    && let Some((entity, many)) = points_at(annotation)
                {
                    pointing.entry(edge.source.as_str()).or_default().push(Reference {
                        field: field.name.clone(),
                        entity,
                        many,
                    });
                }
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
    let mut created: BTreeMap<String, Table> = BTreeMap::new();
    for table in declared_tables {
        let key = table.named.to_ascii_lowercase();
        let fuller = created
            .get(&key)
            .is_none_or(|held| table.columns.len() > held.columns.len());
        if fuller {
            created.insert(
                key,
                Table {
                    named: table.named.clone(),
                    columns: table.columns.clone(),
                    points_at: table.points_at.clone(),
                    file: table.file,
                    line: table.line,
                },
            );
        }
    }
    let declared_names: HashSet<String> = nodes
        .iter()
        .filter(|node| node.kind.is_type())
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !a_setting(path)))
        .map(|node| node.name.to_ascii_lowercase())
        .chain(created.keys().cloned())
        .collect();
    let mut kept: BTreeMap<String, (Vec<String>, Vec<String>, u32)> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "database") {
        let Some(named) = addressed(receiver_of(exit), &modelled_names, &declared_names) else { continue };
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
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !a_setting(path)))
        .filter(|node| {
            modelled.contains(node.id.as_str())
                || files.get(node.file as usize).is_some_and(|path| a_schema(path))
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
            references: pointing.remove(node.id.as_str()).unwrap_or_default(),
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
    created.retain(|key, table| {
        !written_down.contains(key)
            && !entities
                .iter()
                .any(|entity| the_same_record(&table.columns, &entity.named_fields))
    });
    for (named, (written_by, read_by, addressed_by)) in kept {
        if written_down.contains(&named) {
            continue;
        }
        let columns = created.remove(&named).map(|table| table.columns).unwrap_or_default();
        entities.push(Entity {
            id: format!("record:{named}"),
            fields: columns.len() as u32,
            named_fields: columns,
            declared_as: named,
            name: None,
            description: None,
            grounding: None,
            declared_in: None,
            addressed_by,
            written_by,
            read_by,
            references: Vec::new(),
            project: None,
        });
    }
    for (named, table) in created {
        entities.push(Entity {
            id: format!("record:{named}"),
            declared_as: table.named,
            fields: table.columns.len() as u32,
            named_fields: table.columns,
            name: None,
            description: None,
            grounding: None,
            declared_in: None,
            addressed_by: 0,
            written_by: Vec::new(),
            read_by: Vec::new(),
            references: table
                .points_at
                .into_iter()
                .map(|(field, entity)| Reference { field, entity, many: false })
                .collect(),
            project: None,
        });
    }
    let known: HashMap<String, String> = entities
        .iter()
        .map(|entity| (entity.declared_as.to_ascii_lowercase(), entity.declared_as.clone()))
        .collect();
    for entity in entities.iter_mut() {
        entity.references.retain_mut(|reference| {
            let Some(declared) = known.get(&reference.entity.to_ascii_lowercase()) else {
                return false;
            };
            reference.entity = declared.clone();
            true
        });
        entity.references.sort_by(|left, right| left.field.cmp(&right.field));
        entity.references.dedup_by(|left, right| left.field == right.field);
    }
    entities.sort_by(|left, right| {
        right
            .addressed_by
            .cmp(&left.addressed_by)
            .then(right.fields.cmp(&left.fields))
            .then(left.id.cmp(&right.id))
    });
    entities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_database_call_names_the_record_it_addresses() {
        let modelled = HashSet::from(["Booking"]);
        let declared = HashSet::from(["booking".to_string()]);
        assert_eq!(addressed("prisma.booking", &modelled, &declared), Some("booking"));
        assert_eq!(addressed("this.prisma.booking", &modelled, &declared), Some("booking"));
        assert_eq!(addressed("Booking.objects", &modelled, &declared), Some("Booking"));
        assert_eq!(addressed("db.session", &modelled, &declared), None);
        assert_eq!(addressed("session", &modelled, &declared), None);
        assert_eq!(addressed("queryHistoryApi.endpoints.editorQueries", &modelled, &declared), None);
        assert_eq!(addressed("request(app.getHttpServer())", &modelled, &declared), None);
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


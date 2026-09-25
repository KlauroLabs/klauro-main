use std::collections::BTreeMap;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use rayon::prelude::*;

use serde::{Deserialize, Serialize};

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;
use crate::tables::{Column, Table};

const STEPS_KEPT: usize = 16;
const REACHING_AT_ONCE: usize = 24;

#[derive(Debug, Serialize)]
pub struct Step {
    pub unit: String,
    pub depth: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leaves: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Flow {
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reaches: Vec<String>,
    pub id: String,
    pub entry_point: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plays: Option<String>,
    pub standing: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<crate::author::Grounding>,
    pub path: Vec<Step>,
    pub steps: Vec<crate::steps::LogicalStep>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub step_edges: Vec<crate::steps::StepEdge>,
    pub units: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leads_into: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_as: Option<String>,
}

impl From<Column> for Field {
    fn from(column: Column) -> Self {
        Field { name: column.named, declared_as: column.declared_as }
    }
}

#[derive(Debug, Serialize)]
pub struct Reference {
    pub field: String,
    pub entity: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub many: bool,
    pub declared_by: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Entity {
    pub id: String,
    pub declared_as: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub named_fields: Vec<Field>,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<Reference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminality: Option<&'static str>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Delivery {
    pub flow: String,
    pub role: &'static str,
    pub rationale: String,
}

#[derive(Debug, Serialize, Clone)]
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub also_in: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<crate::author::Grounding>,
    pub standing: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub touches: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminality: Option<&'static str>,
    #[serde(skip)]
    pub evidence: String,
}

#[derive(Debug, Serialize, Deserialize)]
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
    "add", "commit", "create", "delete", "dispatch", "emit", "enqueue", "insert", "mkdir", "patch",
    "post", "publish", "put", "remove", "rename", "save", "send", "set", "store", "unlink", "update",
    "upsert", "write",
];

pub(crate) fn changes_something(exit: &ExitPoint) -> bool {
    changes(exit)
}

const FIELDS_TOLD: usize = 10;

const INHERITED_AT_MOST: usize = 4;

fn with_inherited(named: &HashMap<&str, Vec<Field>>, extending: &HashMap<&str, Vec<&str>>, id: &str) -> Vec<Field> {
    let mut held: Vec<Field> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::default();
    let mut pending: Vec<(&str, usize)> = vec![(id, 0)];
    while let Some((at, depth)) = pending.pop() {
        if !seen.insert(at) {
            continue;
        }
        for field in named.get(at).into_iter().flatten() {
            if !held.iter().any(|kept| kept.name == field.name) {
                held.push(field.clone());
            }
        }
        if depth < INHERITED_AT_MOST {
            pending.extend(extending.get(at).into_iter().flatten().map(|base| (*base, depth + 1)));
        }
    }
    held
}

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

pub(crate) const PUBLISHED: &str = "published";
const PROVISIONAL: &str = "provisional";

fn spoken_within(spoken: &str, part: Option<&str>) -> String {
    match part {
        Some(part) => format!(
            "{spoken}\n\nThese facts are about one part of that repository, the part called {}. \
             Read them as that part alone, not as the repository around it.",
            part.rsplit(':').next().unwrap_or(part)
        ),
        None => spoken.to_string(),
    }
}

const SAID_OF_ITSELF: usize = 8000;

fn spoken_for(root: &std::path::Path, nodes: &[IndexNode], files: &[String]) -> String {
    let mut said = Vec::new();
    for (at, path) in files.iter().enumerate() {
        let basename = crate::paths::basename(path).to_ascii_lowercase();
        if basename.starts_with("readme") && path.matches('/').count() == 0 {
            if let Ok(text) = std::fs::read_to_string(root.join(path)) {
                said.push(text.chars().take(SAID_OF_ITSELF).collect::<String>());
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
    pub scope: &'a str,
    pub shape: &'a str,
    pub serving: u32,
    pub routes: u32,
    pub shipped: u32,
    pub projects: usize,
    pub within: Vec<String>,
    pub languages: Vec<(String, u32)>,
    pub frameworks: Vec<String>,
}

const SPOKEN_TO_BY: f64 = 0.15;
const SPEAKING_TO: f64 = 0.05;

#[derive(Default)]
pub struct Talking<'a> {
    pub reaching: HashSet<&'a str>,
    pub reached: HashSet<&'a str>,
}

fn talks_to<'a>(flows: &'a [Flow]) -> HashMap<&'a str, Talking<'a>> {
    let of: HashMap<&str, &str> = flows
        .iter()
        .filter_map(|flow| {
            flow.project.as_deref().map(|part| (flow.entry_point.as_str(), part))
        })
        .collect();
    let mut found: HashMap<&str, Talking> = HashMap::default();
    for flow in flows {
        let Some(part) = flow.project.as_deref() else { continue };
        for into in flow.leads_into.iter() {
            let Some(other) = of.get(into.as_str()).copied() else { continue };
            if other == part {
                continue;
            }
            found.entry(part).or_default().reaching.insert(other);
            found.entry(other).or_default().reached.insert(part);
        }
    }
    found
}

fn carries(
    project: Option<&str>,
    flows: &[Flow],
    entities: &[Entity],
    talking: &HashMap<&str, Talking<'_>>,
) -> f64 {
    let within = |held: Option<&String>| held.map(String::as_str) == project;
    let doing: f64 = flows
        .iter()
        .filter(|flow| within(flow.project.as_ref()))
        .map(|flow| match flow.standing {
            "terminal" => 3.0,
            "proximal" => 2.0,
            _ => 1.0,
        })
        .sum();
    let kept = entities.iter().filter(|entity| within(entity.project.as_ref())).count();
    let held = project.and_then(|part| talking.get(part));
    let spoken_to = held.map(|talking| talking.reached.len()).unwrap_or_default() as f64;
    let speaking = held.map(|talking| talking.reaching.len()).unwrap_or_default() as f64;
    (doing + 2.0 * kept as f64) * (1.0 + SPOKEN_TO_BY * spoken_to + SPEAKING_TO * speaking)
}

fn parts_of(capabilities: &[Capability]) -> Vec<String> {
    let mut held: Vec<String> =
        capabilities.iter().filter_map(|capability| capability.project.clone()).collect();
    held.sort();
    held.dedup();
    held
}

fn describe_product(
    capabilities: &[Capability],
    entities: &[Entity],
    flows: &[Flow],
    spoken: &str,
    told: &Telling<'_>,
    described: Vec<Product>,
) -> Vec<Product> {
    if capabilities.is_empty() {
        return Vec::new();
    }
    let projects = parts_of(capabilities);
    if projects.len() < 2 {
        return describe_one(capabilities, entities, spoken, told, None).into_iter().collect();
    }
    let mut named: Vec<&str> = projects.iter().map(String::as_str).collect();
    for part in told.within.iter() {
        if !named.contains(&part.as_str()) {
            named.push(part.as_str());
        }
    }
    named.sort();
    let mut parts = described;

    let mut by_depth: BTreeMap<std::cmp::Reverse<usize>, Vec<&str>> = BTreeMap::new();
    for project in named.iter() {
        by_depth
            .entry(std::cmp::Reverse(within_of(project).matches('/').count()))
            .or_default()
            .push(project);
    }
    for (_, alongside) in by_depth {
        let recomposed: Vec<Product> = alongside
            .par_iter()
            .filter_map(|project| {
                let under: Vec<Option<&str>> = named
                    .iter()
                    .filter(|held| held_within(held, project))
                    .map(|held| Some(*held))
                    .collect();
                if under.is_empty() {
                    return None;
                }
                let beneath: Vec<&Product> = parts
                    .iter()
                    .filter(|part| {
                        part.project.as_deref().is_some_and(|held| held_within(held, project))
                    })
                    .collect();
                describe_whole(
                    &under, &beneath, capabilities, entities, flows, spoken, told, Some(project),
                )
            })
            .collect();
        for held in recomposed {
            match parts.iter_mut().find(|part| part.project == held.project) {
                Some(there) => *there = held,
                None => parts.push(held),
            }
        }
    }

    let standing: Vec<Option<&str>> = named
        .iter()
        .filter(|held| !named.iter().any(|other| held_within(held, other)))
        .map(|held| Some(*held))
        .collect();
    let top: Vec<&Product> = parts.iter().collect();
    let whole = describe_whole(&standing, &top, capabilities, entities, flows, spoken, told, None);
    let mut written: Vec<Product> = whole.into_iter().collect();
    written.extend(parts);
    written.sort_by(|left, right| left.project.cmp(&right.project));
    written
}

fn within_of(project: &str) -> &str {
    project.strip_prefix("subproject:").unwrap_or(project)
}

fn held_within(held: &str, owner: &str) -> bool {
    let (held, owner) = (within_of(held), within_of(owner));
    !owner.is_empty() && held != owner && held.starts_with(&format!("{owner}/"))
}

fn describe_whole(
    speaking: &[Option<&str>],
    parts: &[&Product],
    capabilities: &[Capability],
    entities: &[Entity],
    flows: &[Flow],
    spoken: &str,
    told: &Telling<'_>,
    owner: Option<&str>,
) -> Option<Product> {
    let talking = talks_to(flows);
    let weighed: Vec<(Option<&str>, Option<&Product>, f64)> = speaking
        .iter()
        .map(|held| {
            let part = parts.iter().find(|part| part.project.as_deref() == *held).copied();
            (*held, part, carries(*held, flows, entities, &talking))
        })
        .collect();
    let whole: f64 = weighed.iter().map(|(_, _, held)| held).sum::<f64>().max(1.0);
    let mut ranked: Vec<(Option<&str>, Option<&Product>, f64)> = weighed
        .into_iter()
        .map(|(named, part, held)| (named, part, 100.0 * held / whole))
        .collect();
    ranked.sort_by(|left, right| right.2.total_cmp(&left.2));
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        for (named, part, share) in ranked.iter() {
            let named = named.unwrap_or("root");
            let told = match part {
                Some(_) => "",
                None => "  (no description held)",
            };
            eprintln!("  carries {share:5.1}%  {}{told}", named.rsplit(':').next().unwrap_or(named));
        }
    }
    let said = ranked
        .iter()
        .map(|(held, part, share)| {
            let named = held.unwrap_or("the repository root");
            let named = named.rsplit(':').next().unwrap_or(named);
            let doing: Vec<&str> = capabilities
                .iter()
                .filter(|capability| {
                    capability.project.as_deref() == *held
                        || held.is_some_and(|part| capability.also_in.iter().any(|in_| in_ == part))
                })
                .filter_map(|capability| capability.name.as_deref())
                .collect();
            format!(
                "- {named} carries {share:.0}% of what this system does\n  it is: {}\n  what someone can do with it: {}",
                match part {
                    Some(part) => part.description.as_str(),
                    None => "not described on its own; read it from what someone can do with it",
                },
                match doing.is_empty() {
                    true => "nothing this reading could name".to_string(),
                    false => doing.join(", "),
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let digest = crate::jev::named(&format!(
        "{owner:?}\u{1}{spoken}\u{1}{}\u{1}{}",
        ranked
            .iter()
            .map(|(held, part, _)| {
                let doing: Vec<&str> = capabilities
                    .iter()
                    .filter(|capability| {
                        capability.project.as_deref() == *held
                            || held.is_some_and(|part| capability.also_in.iter().any(|in_| in_ == part))
                    })
                    .filter_map(|capability| capability.name.as_deref())
                    .collect();
                format!("{held:?}:{}:{}", part.map(|part| part.description.as_str()).unwrap_or(""), doing.join(","))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        told.shape
    ));
    let facts = format!(
        "It says this about itself:\n{}\n\nIt is made of parts that have each already been read \
         on their own.\n\n{said}\n\nHow it is put together: {} across {} serving surfaces, \
         {} routes, {} shipped units.",
        spoken_within(spoken, owner),
        told.shape,
        told.serving,
        told.routes,
        told.shipped
    );
    let speaking = match owner {
        Some(owner) => format!(
            "These parts all sit inside {}, so describe that, not the repository around it.\n\n",
            within_of(owner)
        ),
        None => String::new(),
    };
    let key = format!("{}\u{1}whole\u{1}{}", told.scope, owner.unwrap_or(""));
    crate::memory::unless_changed("products", &key, &digest, || {
        let description = crate::author::describe_system(&format!(
            "{facts}\n\n{speaking}Write what this is, as one thing. The parts above are evidence of \
             what it does, not an outline to follow: do not walk them in order, do not give each one \
             a clause of its own, and do not write a sentence shaped like \"A does this; B does that; \
             C does the other\". Someone who uses this should recognise it from the first sentence. \
             The share each part carries tells you how much of the thing it accounts for, so what the \
             heaviest parts do is most of what it does, so weigh your emphasis that way. But what a \
             thing IS does not follow from which part has the most code in it: a demonstration can be \
             the largest part of something whose purpose is to be started from, and a small part can \
             be the whole reason the rest exists. Settle what it is from what it says about itself and \
             what it ships, then let the shares decide what gets the room. Name a part only where \
             naming it tells the reader something they would otherwise get wrong, and let the lighter \
             ones show up in what the product can do rather than as components. Never call it a \
             repository, a monorepo, a codebase or a collection of parts."
        ))?;
        let grounding = crate::author::test_description(&format!(
            "{facts}\n\nPROPOSED DESCRIPTION: {description}"
        ));
        (!grounding.fabricated()).then(|| Product {
            project: owner.map(str::to_string),
            description,
            grounding,
        })
    })
}

fn describe_one(
    held: &[Capability],
    entities: &[Entity],
    spoken: &str,
    told: &Telling<'_>,
    project: Option<&str>,
) -> Option<Product> {
    let its = |capability: &Capability| {
        project.is_none()
            || capability.project.as_deref() == project
            || project.is_some_and(|part| capability.also_in.iter().any(|held| held == part))
    };
    let mine: Vec<&Capability> = held.iter().filter(|capability| its(capability)).collect();
    let leading: Vec<&Capability> =
        mine.iter().copied().filter(|capability| capability.place != Some("supporting")).collect();
    let capabilities = if leading.is_empty() { mine } else { leading };
    if capabilities.is_empty() {
        return None;
    }
    let listed = capabilities
        .iter()
        .map(|capability| format!(
            "- {} (for {}): {}",
            capability.name.as_deref().unwrap_or(""),
            capability.audience.as_deref().unwrap_or("someone"),
            capability.description.as_deref().unwrap_or("")
        ))
        .collect::<Vec<_>>()
        .join("\n");
    let kept = {
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
        };
    let digest = crate::jev::named(&format!(
        "{project:?}\u{1}{spoken}\u{1}{listed}\u{1}{kept}\u{1}{}\u{1}{}",
        told.shape,
        told.frameworks.join(",")
    ));
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
                 Describe that part, not the repository around it. It has only what is here, so \
                 say what it does with that and nothing further: it cannot know what the rest of \
                 the system needs, avoids, replaces or does without, and a thing it does nothing \
                 with is not a thing it can speak about.\n\n"
            ),
            None => String::new(),
        },
        listed,
        kept,
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
    let key = format!("{}\u{1}{}", told.scope, project.unwrap_or(""));
    crate::memory::unless_changed("products", &key, &digest, || {
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
                !grounding.fabricated()
            );
        }
        (!grounding.fabricated()).then(|| Product {
            project: project.map(str::to_string),
            description,
            grounding,
        })
    })
}

const PRIMARY_PATHS_TOLD: usize = 4;

fn say_what_happens(held: &mut Comprehension, spoken: &str) {
    let asked_for: Option<Vec<String>> = std::env::var("KLAURO_DESCRIBE_FLOWS")
        .ok()
        .filter(|held| !held.is_empty())
        .map(|held| held.split(',').map(|id| id.trim().to_string()).collect());
    let everything = asked_for.as_ref().is_some_and(|ids| ids.iter().any(|id| id == "all"));
    let mut chosen: HashSet<String> = HashSet::default();
    match (&asked_for, everything) {
        (Some(ids), false) => chosen.extend(ids.iter().cloned()),
        (_, true) => chosen.extend(held.flows.iter().filter(|flow| !flow.steps.is_empty()).map(|flow| flow.id.clone())),
        (None, _) => {
            for capability in held.capabilities.iter().filter(|capability| capability.project.is_some()) {
                chosen.extend(
                    capability
                        .delivered
                        .iter()
                        .filter(|delivery| delivery.role == "primary")
                        .take(PRIMARY_PATHS_TOLD)
                        .map(|delivery| delivery.flow.clone()),
                );
            }
        }
    }
    let told: Vec<(String, String)> = held
        .flows
        .iter()
        .filter(|flow| chosen.contains(&flow.id) && !flow.steps.is_empty())
        .map(|flow| {
            (
                flow.id.clone(),
                format!(
                    "  reached through: {}\n  steps: {}",
                    crate::capabilities::surface_of(flow),
                    crate::capabilities::told_steps(flow)
                ),
            )
        })
        .collect();
    if told.is_empty() {
        return;
    }
    let said = crate::memory::each("what happens, named", spoken, &told, |missing| {
        let written = crate::author::what_happens(spoken, missing);
        let evidence: BTreeMap<String, String> = missing.iter().cloned().collect();
        let grounded = crate::author::ground(&written, &evidence);
        written
            .into_iter()
            .filter(|(id, _)| grounded.get(id).is_some_and(|grounding| grounding.holds()))
            .collect()
    });
    for flow in held.flows.iter_mut() {
        if let Some(written) = said.get(&flow.id) {
            flow.description = Some(written.description.clone());
            if !written.name.is_empty() {
                flow.name = Some(written.name.clone());
            }
        }
    }
}

fn test_capabilities(capabilities: &mut Vec<Capability>, spoken: &str, level: &str) {
    let tests: Vec<(String, String)> = capabilities
        .iter()
        .map(|capability| {
            let told: String = capability
                .evidence
                .lines()
                .filter(|line| !line.trim_start().starts_with(crate::capabilities::RECORDS_HOLD))
                .collect::<Vec<_>>()
                .join("\n")
                .chars()
                .take(EVIDENCE_TESTED)
                .collect();
            let facts = format!(
                "FACTS read from the code about what it delivers:\n{}\n\n\
                 PROPOSED CAPABILITY: {}\nPROPOSED DESCRIPTION: {}\nFOR: {}",
                match told.is_empty() {
                    true => format!("  reached through: {}\n  writes: {}", capability.surfaces.join(", "), capability.records.join(", ")),
                    false => told,
                },
                capability.name.as_deref().unwrap_or(""),
                capability.description.as_deref().unwrap_or(""),
                capability.audience.as_deref().unwrap_or("someone")
            );
            (capability.id.clone(), facts)
        })
        .collect();
    let context = format!("A software system describes itself like this:\n{spoken}");
    let context = format!("{context}\n\u{1}{level}\u{1}{}", crate::author::questions_asked());
    let judged = crate::memory::each("judged", &context, &tests, |missing| {
        crate::author::test_capabilities(context.split('\u{1}').next().unwrap_or_default(), missing, level)
    });
    let facts_of: HashMap<String, String> = tests.iter().cloned().collect();
    capabilities.retain_mut(|capability| {
        let Some(grounding) = judged.get(&capability.id).copied() else { return false };
        crate::dataset::record(
            "capability",
            serde_json::json!({
                "level": level,
                "context": spoken,
                "facts": facts_of.get(&capability.id),
                "name": capability.name,
                "description": capability.description,
                "audience": capability.audience,
                "terminality": capability.terminality,
                "grounding": grounding,
                "delivered": grounding.delivers(),
            }),
        );
        capability.grounding = Some(grounding);
        capability.standing = match grounding.stands() {
            true => PUBLISHED,
            false => PROVISIONAL,
        };
        let delivers = grounding.delivers();
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!(
                "capability {:<44} supported {:.2} invented {:.2} outcome {:.2} scope {:.2} universal {:.2} mechanism {:.2} hollow {:.2} -> {} {}",
                capability.name.as_deref().unwrap_or(""),
                grounding.supported,
                grounding.invented,
                grounding.outcome,
                grounding.scope.unwrap_or(0.0),
                grounding.universal.unwrap_or(1.0),
                grounding.mechanism.unwrap_or(0.0),
                grounding.hollow.unwrap_or(0.0),
                capability.standing,
                if delivers { "kept" } else { "absent" }
            );
        }
        delivers
    });
}

fn say_what_each_is_for(held: &mut [Capability], spoken: &str) {
    let listed: BTreeMap<String, String> = held
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            (
                format!("p{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  what someone gets: {}",
                    capability.name.as_deref().unwrap_or(""),
                    capability.audience.as_deref().unwrap_or("someone"),
                    capability.description.as_deref().unwrap_or("")
                ),
            )
        })
        .collect();
    let listed: Vec<(String, String)> = listed.into_iter().collect();
    let said = crate::memory::each("placed", spoken, &listed, |missing| {
        crate::author::what_it_is_for(spoken, &missing.iter().cloned().collect())
    });
    for (at, capability) in held.iter_mut().enumerate() {
        capability.place = match said.get(&format!("p{at}")).map(String::as_str) {
            Some("terminal") => Some("terminal"),
            Some("proximal") => Some("proximal"),
            Some("supporting") => Some("supporting"),
            _ => None,
        };
    }
}

const EVIDENCE_HELD: usize = 6000;
const EVIDENCE_TESTED: usize = 2500;

pub(crate) fn joined(into: &mut Capability, other: Capability) {
    if let Some(part) = other.project
        && Some(&part) != into.project.as_ref()
        && !into.also_in.contains(&part)
    {
        into.also_in.push(part);
    }
    for part in other.also_in {
        if Some(&part) != into.project.as_ref() && !into.also_in.contains(&part) {
            into.also_in.push(part);
        }
    }
    into.delivered.extend(other.delivered);
    into.records.extend(other.records);
    into.changes.extend(other.changes);
    into.surfaces.extend(other.surfaces);
    into.touches.extend(other.touches);
    if other.terminality == Some("terminal") || into.terminality.is_none() {
        into.terminality = other.terminality.or(into.terminality);
    }
    if !other.evidence.is_empty() && into.evidence.len() < EVIDENCE_HELD {
        into.evidence.push('\n');
        into.evidence.push_str(&other.evidence);
    }
    if other.standing == PUBLISHED {
        into.standing = PUBLISHED;
    }
    into.delivered.sort_by(|left, right| left.flow.cmp(&right.flow));
    into.delivered.dedup_by(|left, right| left.flow == right.flow);
    into.flows = into.delivered.iter().map(|held| held.flow.clone()).collect();
    settle(&mut into.records);
    settle(&mut into.changes);
    settle(&mut into.surfaces);
    settle(&mut into.touches);
    into.also_in.sort();
    into.also_in.dedup();
}



fn summarised(entry: &EntryPoint, named: &str, writes: &[String], reads: &[String], reaching: &[String]) -> String {
    let entered = match (entry.kind, entry.method.as_deref(), entry.path.as_deref()) {
        ("http", Some(method), _) => format!("{method} {named}"),
        ("export", _, _) => format!("uses {named}"),
        (kind, _, Some(path)) => format!("{kind} {path}"),
        (kind, _, None) => format!("{kind} {named}"),
    };
    let mut said = vec![entered];
    if !writes.is_empty() {
        said.push(format!("writes {}", writes.join(", ")));
    }
    if !reads.is_empty() {
        said.push(format!("reads {}", reads.join(", ")));
    }
    if !reaching.is_empty() {
        said.push(format!("reaches {}", reaching.join(", ")));
    }
    said.join("; ")
}

pub(crate) fn settle(held: &mut Vec<String>) {
    held.sort();
    held.dedup();
}

pub(crate) fn carved_name(name: &str) -> String {
    let held: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|letter| match letter.is_ascii_alphanumeric() {
            true => letter,
            false => '-',
        })
        .collect();
    held.split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-")
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Family {
    pub(crate) key: String,
    pub(crate) basis: &'static str,
}

pub(crate) fn family_of(flow: &Flow) -> Family {
    if let Some(surface) = surface_family(flow) {
        return Family {
            key: format!("surface:{surface}"),
            basis: "the surface it is reached through",
        };
    }
    if flow.kind == "export"
        && let Some(role) = flow.plays.as_deref().filter(|held| !held.is_empty())
    {
        return Family {
            key: format!("role:{role}"),
            basis: "the role it plays, which it shares with the others like it",
        };
    }
    if flow.kind == "export"
        && let Some(offered) = flow.surface.as_deref().filter(|held| !held.is_empty())
    {
        return Family {
            key: format!("surface:{offered}"),
            basis: "the module that publishes it",
        };
    }
    let mut handled = flow.writes.clone();
    handled.extend(flow.reads.iter().cloned());
    settle(&mut handled);
    if !handled.is_empty() {
        return Family {
            key: format!("records:{}", handled.join(",")),
            basis: "the records it handles",
        };
    }
    if !flow.changes.is_empty() {
        let mut held: Vec<String> = flow
            .changes
            .iter()
            .map(|change| change.split(':').next().unwrap_or(change).to_string())
            .collect();
        settle(&mut held);
        return Family { key: format!("effect:{}", held.join(",")), basis: "the effect it ends in" };
    }
    Family { key: format!("trigger:{}", flow.kind), basis: "how it is triggered" }
}

fn surface_family(flow: &Flow) -> Option<String> {
    let held = match flow.kind {
        "http" => flow.surface.as_deref().unwrap_or(flow.operation.as_str()),
        _ => flow.operation.as_str(),
    };
    if flow.kind != "http" && !held.starts_with('/') {
        return None;
    }
    let operation = held;
    let named = operation
        .split('/')
        .find(|segment| !segment.is_empty() && !addressed_by_version(segment) && !segment.starts_with(':'))?;
    let held: String = named
        .chars()
        .take_while(|letter| letter.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    (!held.is_empty()).then_some(held)
}

fn addressed_by_version(segment: &str) -> bool {
    segment == "api"
        || (segment.starts_with('v') && segment[1..].chars().all(|letter| letter.is_ascii_digit()))
}


pub fn author(
    held: &mut Comprehension,
    root: &std::path::Path,
    nodes: &[IndexNode],
    files: &[String],
    told: &Telling<'_>,
) -> u32 {
    if !crate::author::asked() {
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
                "  kind: data entity\n  {}{}\n  it holds these fields: {}\n  {}",
                match entity.declared_in.as_deref() {
                    Some(held) => format!(
                        "declared as: {} in {}",
                        entity.declared_as,
                        held.split(':').next().unwrap_or("")
                    ),
                    None if entity.addressed_by == 0 => format!(
                        "kept as the table {}, which its schema creates and the code never names",
                        entity.declared_as
                    ),
                    None => format!(
                        "kept as the table {}, which the code addresses by name in {} places",
                        entity.declared_as, entity.addressed_by
                    ),
                },
                match entity.project.as_deref() {
                    Some(part) => format!("\n  kept by the part: {}", part.rsplit(['/', ':']).next().unwrap_or(part)),
                    None => String::new(),
                },
                match entity.named_fields.is_empty() {
                    true => format!("{} unnamed", entity.fields),
                    false => entity
                        .named_fields
                        .iter()
                        .map(|field| field.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                },
                match (entity.written_by.len(), entity.read_by.len()) {
                    (0, 0) => "no code here reads or writes it by name".to_string(),
                    (written, read) => format!("written by {written} units, read by {read} units"),
                }
            ),
        );
    }
    let fields: crate::capabilities::Fields = held
        .entities
        .iter()
        .filter(|entity| !entity.named_fields.is_empty())
        .map(|entity| {
            let named: Vec<&str> = entity.named_fields.iter().map(|field| field.name.as_str()).take(FIELDS_TOLD).collect();
            (entity.declared_as.clone(), named.join(", "))
        })
        .collect();
    let started = std::time::Instant::now();
    let reaching = rayon::ThreadPoolBuilder::new()
        .num_threads(crate::author::reaching_at_once(REACHING_AT_ONCE))
        .build()
        .ok();
    let work = || rayon::join(
        || {
            let mut parts: Vec<Option<String>> =
                held.flows.iter().map(|flow| flow.project.clone()).collect();
            parts.sort();
            parts.dedup();
            let several = parts.iter().filter(|part| part.is_some()).count() > 1;
            let read: Vec<(Vec<Capability>, Option<Product>)> = parts
                .par_iter()
                .map(|part| {
                    let flows: Vec<&Flow> = held.flows.iter().filter(|flow| &flow.project == part).collect();
                    let said = spoken_within(&spoken, part.as_deref());
                    let remembered_as = format!("{}\u{1}{}", told.scope, part.as_deref().unwrap_or(""));
                    let mut found = crate::capabilities::of_a_part(&flows, &said, &remembered_as, &fields);
                    test_capabilities(&mut found, &said, if part.is_some() { "this part of the system" } else { "this system" });
                    say_what_each_is_for(&mut found, &said);
                    let described = match (several, part.as_deref()) {
                        (true, Some(named)) if !found.is_empty() => {
                            describe_one(&found, &held.entities, &spoken, told, Some(named))
                        }
                        _ => None,
                    };
                    (found, described)
                })
                .collect();
            let mut described: Vec<Product> = Vec::new();
            let mut capabilities: Vec<Capability> = Vec::new();
            for (found, product) in read {
                capabilities.extend(found);
                described.extend(product);
            }
            if parts_of(&capabilities).len() < 2 {
                described.clear();
            }
            described.sort_by(|left, right| left.project.cmp(&right.project));
            capabilities.sort_by(|left, right| left.id.cmp(&right.id));
            let offered_only: HashSet<&str> = held
                .flows
                .iter()
                .filter(|flow| flow.kind == "export")
                .map(|flow| flow.id.as_str())
                .collect();
            let served: Vec<Capability> = capabilities
                .iter()
                .filter(|capability| capability.flows.iter().any(|flow| !offered_only.contains(flow.as_str())))
                .cloned()
                .collect();
            let mut whole = crate::capabilities::of_the_whole(&served, &spoken, told.scope, &held.flows);
            test_capabilities(&mut whole, &spoken, "this system as a whole");
            eprintln!(
                "  author read {} capabilities across the parts into {} for the whole",
                capabilities.len(),
                whole.len()
            );
            let mut together = capabilities.clone();
            together.extend(whole.iter().cloned());
            together.sort_by(|left, right| left.id.cmp(&right.id));
            let formed = started.elapsed();
            let ((), products) = rayon::join(
                || say_what_each_is_for(&mut whole, &spoken),
                || describe_product(&together, &held.entities, &held.flows, &spoken, told, described),
            );
            capabilities.extend(whole);
            capabilities.sort_by(|left, right| left.id.cmp(&right.id));
            eprintln!(
                "  author form {formed:?} across {} parts | describe {:?} | backend writes {} bytes/s | asked again {}",
                parts.len(),
                started.elapsed() - formed,
                crate::author::writing_rate(),
                crate::author::asked_again()
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
    say_what_happens(held, &spoken);
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
        crate::dataset::record(
            "entity",
            serde_json::json!({
                "declared_as": entity.declared_as,
                "fields": entity.named_fields.iter().map(|field| field.name.as_str()).collect::<Vec<_>>(),
                "description": description,
                "grounding": grounding,
                "holds": grounding.holds(),
            }),
        );
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!(
                "entity {:<28} supported {:.2} invented {:.2} -> {} | {description}",
                entity.declared_as,
                grounding.supported,
                grounding.invented,
                grounding.holds()
            );
        }
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
    calls: &[CallFact],
    type_references: &[crate::model::TypeReferenceFact],
    metrics: &[crate::model::UnitMetricsEntry],
    events: &HashSet<&str>,
    guessed: &HashSet<(String, String)>,
) -> Comprehension {
    let position_of: HashMap<&str, u32> = nodes
        .iter()
        .enumerate()
        .map(|(at, node)| (node.id.as_str(), at as u32))
        .collect();
    let mut played: HashMap<&str, &str> = HashMap::default();
    for held in type_references {
        if held.kind != EdgeKind::Implements {
            continue;
        }
        played.entry(held.source.as_str()).or_insert(held.name.as_str());
    }
    let mut next: HashMap<u32, Vec<u32>> = HashMap::default();
    let mut members: HashMap<u32, Vec<u32>> = HashMap::default();
    for edge in edges {
        let (Some(source), Some(target)) = (
            position_of.get(edge.source.as_str()).copied(),
            position_of.get(edge.target.as_str()).copied(),
        ) else {
            continue;
        };
        match edge.kind {
            EdgeKind::Calls | EdgeKind::Instantiates
                if !guessed.contains(&(edge.source.clone(), edge.target.clone())) =>
            {
                next.entry(source).or_default().push(target)
            }
            EdgeKind::Contains | EdgeKind::HasMethod => {
                members.entry(source).or_default().push(target)
            }
            _ => {}
        }
    }
    let mut leaving: HashMap<&str, Vec<&ExitPoint>> = HashMap::default();
    for exit in exit_points {
        leaving.entry(exit.source.as_str()).or_default().push(exit);
    }
    let mut carried_names: HashSet<&str> = HashSet::default();
    for node in nodes.iter().filter(|node| node.kind.is_type()) {
        let declared = files.get(node.file as usize).map(String::as_str).unwrap_or_default();
        if node.decorators.iter().any(over_a_wire) || agreed_in_a_schema(declared) {
            carried_names.insert(node.name.as_str());
        }
    }
    let mut carries: HashMap<&str, Vec<Shared>> = HashMap::default();
    for reference in type_references {
        let Some(named) = carried_names.get(reference.name.as_str()).copied() else { continue };
        carried_by(&mut carries, reference.source.as_str(), contract(named));
    }
    for node in nodes.iter().filter(|node| node.type_annotation.is_some()) {
        let Some(spoken) = node.type_annotation.as_deref() else { continue };
        for word in spoken.split(|letter: char| !letter.is_alphanumeric() && letter != '_') {
            let Some(named) = carried_names.get(word).copied() else { continue };
            let unit = node.parent.as_deref().unwrap_or(node.id.as_str());
            carried_by(&mut carries, unit, contract(named));
        }
    }
    for call in calls {
        let Some(unit) = call.caller.as_deref() else { continue };
        let spoken = [call.callee.as_str()]
            .into_iter()
            .chain(call.receiver.as_deref())
            .flat_map(|held| held.split(|letter: char| !letter.is_alphanumeric() && letter != '_'));
        for word in spoken {
            let Some(named) = carried_names.get(word).copied() else { continue };
            carried_by(&mut carries, unit, contract(named));
        }
        for held in agreed_by_hand(call) {
            carried_by(&mut carries, unit, held);
        }
    }
    let served_shapes: Vec<(Vec<String>, &str)> = entry_points
        .iter()
        .filter(|entry| entry.kind == "http")
        .filter_map(|entry| entry.path.as_deref().map(|path| (route_shape(path), entry.id.as_str())))
        .filter(|(shape, _)| said_plainly_in(shape) > 0)
        .collect();
    let mut served_at: HashMap<&str, &str> = HashMap::default();
    for exit in exit_points {
        let Some(addressed) = exit.addressed.as_deref() else { continue };
        if served_at.contains_key(addressed) {
            continue;
        }
        let asked = route_shape(addressed);
        let found = served_shapes
            .iter()
            .find(|(shape, _)| same_shape(&asked, shape))
            .or_else(|| {
                served_shapes
                    .iter()
                    .filter(|(shape, _)| mounted_under(&asked, shape))
                    .max_by_key(|(shape, _)| shape.len())
            });
        if let Some((_, served)) = found {
            served_at.insert(addressed, served);
        }
    }

    let entities_first = entities(
        nodes,
        files,
        edges,
        exit_points,
        roles,
        declared_tables,
        calls,
        type_references,
    );
    let held: HashSet<&str> = entities_first
        .iter()
        .map(|entity| entity.declared_as.as_str())
        .collect();
    let mut entity_of: HashMap<&str, Vec<&str>> = HashMap::default();
    let mut read_of: HashMap<&str, Vec<&str>> = HashMap::default();
    let spoken_of: HashMap<&str, &str> =
        nodes.iter().map(|node| (node.id.as_str(), node.name.as_str())).collect();
    let stored: HashSet<&str> = type_references
        .iter()
        .filter(|reference| declares_a_table(&reference.name))
        .filter_map(|reference| spoken_of.get(reference.source.as_str()).copied())
        .filter_map(|named| held.get(named).copied())
        .collect();
    let keeps = |named: &&str| stored.is_empty() || stored.contains(named);
    let mut named_within: HashMap<&str, Vec<&str>> = HashMap::default();
    for reference in type_references {
        let Some(named) = held.get(reference.name.as_str()).copied().filter(keeps) else {
            continue;
        };
        let holding = named_within.entry(reference.source.as_str()).or_default();
        if !holding.contains(&named) {
            holding.push(named);
        }
    }
    for call in calls {
        let Some(unit) = call.caller.as_deref() else { continue };
        let spoken = [crate::names::root(&call.callee)]
            .into_iter()
            .chain(call.receiver.as_deref().map(crate::names::root))
            .chain(call.literals.iter().map(|literal| crate::names::root(literal)));
        for named in spoken {
            let Some(named) = held.get(named).copied().filter(keeps) else { continue };
            let holding = named_within.entry(unit).or_default();
            if !holding.contains(&named) {
                holding.push(named);
            }
        }
    }
    let mut handled_by: HashMap<String, &str> = HashMap::default();
    for node in nodes {
        let Some(annotation) = node.type_annotation.as_deref() else { continue };
        let Some(record) = held_by_a_handle(annotation).and_then(|record| held.get(record).copied()) else {
            continue;
        };
        handled_by.entry(node.name.to_ascii_lowercase()).or_insert(record);
    }
    let lowered_records: HashMap<String, &str> =
        held.iter().map(|record| (record.to_ascii_lowercase(), *record)).collect();
    let through_a_handle = |exit: &ExitPoint| -> Option<&str> {
        receiver_of(exit)
            .split('.')
            .map(|segment| {
                let segment = segment.trim();
                let end = segment.find(|letter: char| !(letter.is_alphanumeric() || letter == '_')).unwrap_or(segment.len());
                segment[..end].trim_start_matches('_').to_ascii_lowercase()
            })
            .filter(|segment| !segment.is_empty())
            .find_map(|segment| handled_by.get(&segment).or_else(|| lowered_records.get(&segment)).copied())
    };
    let mut exit_records: HashMap<&str, Vec<&str>> = HashMap::default();
    let mut typed_at: HashMap<(&str, u32), &str> = HashMap::default();
    for call in calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        if let Some(record) = call.literals.iter().find_map(|literal| {
            let bare = literal.rsplit('=').next().unwrap_or(literal).trim().trim_matches(['"', '\'', '`']);
            let bare = bare.split([' ', '.']).next().unwrap_or(bare);
            lowered_records.get(&bare.to_ascii_lowercase()).copied().or_else(|| {
                bare.split('_')
                    .filter(|word| word.len() > 2)
                    .find_map(|word| lowered_records.get(&word.to_ascii_lowercase()).copied())
            })
        }) {
            typed_at.entry((caller, call.line)).or_insert(record);
        }
        if let Some(record) = call
            .type_arguments
            .iter()
            .find_map(|argument| held.get(crate::names::leaf(argument.trim())).copied())
        {
            typed_at.entry((caller, call.line)).or_insert(record);
        }
    }
    for exit in exit_points {
        if exit.kind != "database" {
            continue;
        }
        let named = crate::names::root(&exit.target);
        let touching: Vec<&str> = match (held.contains(named), through_a_handle(exit)) {
            (true, _) => vec![named],
            (false, Some(record)) => vec![record],
            (false, None) => match typed_at.get(&(exit.source.as_str(), exit.line)) {
                Some(record) => vec![*record],
                None => named_within.get(exit.source.as_str()).cloned().unwrap_or_default(),
            },
        };
        if touching.is_empty() {
            continue;
        }
        exit_records.insert(exit.id.as_str(), touching.clone());
        let holding = match changes(exit) {
            true => entity_of.entry(exit.source.as_str()).or_default(),
            false => read_of.entry(exit.source.as_str()).or_default(),
        };
        for named in touching {
            if !holding.contains(&named) {
                holding.push(named);
            }
        }
    }

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
        .filter(|entry| !matches!(entry.kind, "export" | "test"))
        .map(|entry| (entry.handler.as_str(), entry.id.as_str()))
        .collect();

    let named_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let reader = crate::steps::Reader::new(nodes, &position_of, &next, calls, exit_points, &exit_records, &held, metrics, events);
    let mut flows = Vec::with_capacity(served.len());
    let mut carried: HashMap<String, Vec<Shared>> = HashMap::default();
    for entry in &served {
        let Some(start) = position_of.get(entry.handler.as_str()).copied() else { continue };
        let mut seen: HashSet<u32> = HashSet::from_iter([start]);
        let mut queue: Vec<(u32, u32)> = vec![(start, 0)];
        for member in members.get(&start).into_iter().flatten() {
            if seen.insert(*member) {
                queue.push((*member, 0));
            }
            if nodes[*member as usize].kind != crate::model::NodeKind::Variable {
                continue;
            }
            for held in members.get(member).into_iter().flatten() {
                if seen.insert(*held) {
                    queue.push((*held, 0));
                }
            }
        }
        let mut steps = Vec::new();
        let mut changing: Vec<String> = Vec::new();
        let mut into: Vec<String> = Vec::new();
        let mut carrying: Vec<Shared> = Vec::new();
        let mut reaching: Vec<String> = Vec::new();
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
                if let Some(service) = exit.service.as_deref()
                    && !reaching.iter().any(|held| held == service)
                {
                    reaching.push(service.to_string());
                }
            }
            if let Some(other) = handlers.get(unit)
                && *other != entry.id
            {
                into.push((*other).to_string());
            }
            for held in carries.get(unit).into_iter().flatten() {
                carrying.push(held.clone());
            }
            for exit in leaving.get(unit).into_iter().flatten() {
                let Some(family) = shared_family(&exit.kind) else { continue };
                let named = exit.addressed.as_deref().unwrap_or(exit.target.as_str());
                if named.len() < 2 {
                    continue;
                }
                let role = match (family, changes(exit)) {
                    ("artifact", true) => "writes",
                    ("artifact", false) => "reads",
                    _ => "mentions",
                };
                carrying.push(Shared { family, name: named.to_string(), role });
            }
            for exit in leaving.get(unit).into_iter().flatten() {
                let Some(addressed) = exit.addressed.as_deref() else { continue };
                let Some(other) = served_at.get(addressed).copied() else { continue };
                if other != entry.id {
                    into.push(other.to_string());
                }
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
        carrying.sort_by(|left, right| {
            (left.family, &left.name, left.role).cmp(&(right.family, &right.name, right.role))
        });
        carrying.dedup_by(|left, right| {
            left.family == right.family && left.name == right.name && left.role == right.role
        });
        if !carrying.is_empty() {
            carried.insert(entry.id.clone(), carrying);
        }
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
                    .map(|owner| match (entry.kind, named_of.get(entry.handler.as_str())) {
                        ("rpc" | "graphql", Some(method)) => format!("{owner}.{}", method.name),
                        _ => owner.to_string(),
                    })
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
        reaching.sort();
        let (logical, step_edges) = reader.read(entry);
        let stores_something = logical
            .iter()
            .any(|step| matches!(step.kind, "change" | "remove") && step.doing.is_none());
        for step in &logical {
            let Some(object) = step.object.as_deref().filter(|object| held.contains(object)) else { continue };
            let in_memory = step.doing.is_some() || step.kind == "create";
            match step.kind {
                "change" | "create" | "remove" if !in_memory || stores_something => {
                    if !writes.iter().any(|held| held == object) {
                        writes.push(object.to_string());
                    }
                }
                "read" => {
                    if !reads.iter().any(|held| held == object) && !writes.iter().any(|held| held == object) {
                        reads.push(object.to_string());
                    }
                }
                _ => {}
            }
        }
        writes.sort();
        reads.retain(|held| !writes.contains(held));
        reads.sort();
        let summary = summarised(entry, &named, &writes, &reads, &reaching);
        let hands_on = logical.iter().any(|step| matches!(step.kind, "raise" | "hand_off"));
        let standing = match (!changing.is_empty() || !writes.is_empty() || hands_on, !into.is_empty()) {
            (true, _) => "terminal",
            (false, true) => "proximal",
            (false, false) => "reading",
        };
        flows.push(Flow {
            path: steps,
            steps: logical,
            step_edges,
            reaches: reaching,
            summary,
            writes,
            reads,
            id: format!("flow:{}", entry.id),
            entry_point: entry.id.clone(),
            kind: entry.kind,
            method: entry.method.clone(),
            operation: named,
            plays: played
                .get(nodes[start as usize].id.as_str())
                .map(|held| (*held).to_string()),
            surface: match entry.kind {
                "export" => files
                    .get(entry.file as usize)
                    .map(|path| crate::published::offered_from(path).to_string()),
                _ => entry.path.clone(),
            },
            name: None,
            description: None,
            grounding: None,
            standing,
            units: seen.len() as u32,
            changes: changing,
            leads_into: into,
            project: nodes[start as usize].project.clone(),
        });
    }
    flows.sort_by(|left, right| left.id.cmp(&right.id));
    link_across_parts(&mut flows, &carried);
    let mut received: HashMap<&str, Vec<String>> = HashMap::default();
    for entry in entry_points.iter().filter(|entry| matches!(entry.kind, "message" | "event")) {
        received.entry(entry.name.as_str()).or_default().push(entry.id.clone());
    }
    for flow in flows.iter_mut() {
        let handed: Vec<String> = flow
            .steps
            .iter()
            .filter(|step| matches!(step.kind, "raise" | "hand_off"))
            .filter_map(|step| step.object.as_deref())
            .flat_map(|object| received.get(object).into_iter().flatten().cloned())
            .filter(|entry| *entry != flow.entry_point)
            .collect();
        for entry in handed {
            if !flow.leads_into.contains(&entry) {
                flow.leads_into.push(entry);
            }
        }
        flow.leads_into.sort();
    }

    let touching = |holding: &HashMap<&str, Vec<&str>>| -> BTreeMap<String, Vec<String>> {
        let mut found: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (unit, records) in holding {
            for record in records {
                found.entry((*record).to_string()).or_default().push((*unit).to_string());
            }
        }
        for units in found.values_mut() {
            units.sort();
            units.dedup();
            units.truncate(8);
        }
        found
    };
    let writers = touching(&entity_of);
    let readers = touching(&read_of);

    let mut entities = entities_first;
    for entity in entities.iter_mut() {
        if entity.written_by.is_empty() {
            entity.written_by = writers.get(&entity.declared_as).cloned().unwrap_or_default();
        }
        if entity.read_by.is_empty() {
            entity.read_by = readers.get(&entity.declared_as).cloned().unwrap_or_default();
        }
    }
    for entity in entities.iter_mut() {
        let named = entity.declared_as.as_str();
        entity.terminality = match (
            flows.iter().any(|flow| flow.writes.iter().any(|held| held == named)),
            flows.iter().any(|flow| flow.reads.iter().any(|held| held == named)),
        ) {
            (true, _) => Some("terminal"),
            (false, true) => Some("proximal"),
            _ => None,
        };
    }
    let terminal = flows.iter().filter(|flow| flow.standing == "terminal").count() as u32;
    let chained = flows.iter().filter(|flow| !flow.leads_into.is_empty()).count() as u32;
    Comprehension { products: Vec::new(), capabilities: Vec::new(), flows, entities, terminal, chained }
}

static OVER_A_WIRE: &[&str] = &[
    "datacontract",
    "decodable",
    "decode",
    "deserialize",
    "encodable",
    "encode",
    "jsonserializable",
    "messagepackobject",
    "protobuf",
    "serializable",
    "serialize",
];

const LINKED_AT_MOST: usize = 8;
const SHARED_BY_AT_MOST: usize = 8;

#[derive(Clone)]
pub struct Shared {
    pub family: &'static str,
    pub name: String,
    pub role: &'static str,
}

const MOUNTED_WITH_AT_LEAST: usize = 2;

fn route_shape(path: &str) -> Vec<String> {
    let bare = path.split(['?', '#']).next().unwrap_or_default();
    let bare = match bare.find("://") {
        Some(at) => bare[at + 3..].find('/').map(|slash| &bare[at + 3 + slash..]).unwrap_or(""),
        None => bare,
    };
    bare.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| match stands_for_a_value(segment) {
            true => "*".to_string(),
            false => segment.to_ascii_lowercase(),
        })
        .collect()
}

fn stands_for_a_value(segment: &str) -> bool {
    segment == "*"
        || segment.starts_with([':', '{', '[', '<'])
        || segment.ends_with(['}', ']', '>'])
        || segment.contains("${")
}

fn said_plainly_in(shape: &[String]) -> usize {
    shape.iter().filter(|segment| *segment != "*").count()
}

fn same_shape(asked: &[String], served: &[String]) -> bool {
    asked.len() == served.len()
        && said_plainly_in(served) > 0
        && asked
            .iter()
            .zip(served)
            .all(|(left, right)| left == right || left == "*" || right == "*")
}

fn mounted_under(asked: &[String], served: &[String]) -> bool {
    served.len() < asked.len()
        && said_plainly_in(served) >= MOUNTED_WITH_AT_LEAST
        && same_shape(&asked[asked.len() - served.len()..], served)
}

fn carried_by<'a>(carries: &mut HashMap<&'a str, Vec<Shared>>, unit: &'a str, held: Shared) {
    let holding = carries.entry(unit).or_default();
    if !holding.iter().any(|kept| kept.family == held.family && kept.name == held.name) {
        holding.push(held);
    }
}

fn contract(named: &str) -> Shared {
    Shared { family: "contract", name: named.to_string(), role: "mentions" }
}

static AGREED_IN_A_SCHEMA: &[&str] =
    &["avsc", "capnp", "fbs", "gql", "graphql", "graphqls", "proto", "thrift"];

fn agreed_in_a_schema(path: &str) -> bool {
    let Some((_, spoken)) = path.rsplit_once('.') else { return false };
    AGREED_IN_A_SCHEMA.binary_search(&spoken).is_ok()
}

static PUBLISHES: &[&str] =
    &["broadcast", "enqueue", "postmessage", "produce", "publish", "sendmessage"];

static SUBSCRIBES: &[&str] = &["consume", "dequeue", "subscribe"];

static READS_A_KEY: &[&str] = &["get", "getex", "hget", "hgetall", "lrange", "mget", "smembers"];

static WRITES_A_KEY: &[&str] =
    &["decr", "del", "expire", "hset", "incr", "lpush", "mset", "rpush", "sadd", "set", "setex"];

static A_KEPT_PLACE: &[&str] = &["cache", "kv", "memcache", "redis", "store", "valkey"];

static NAMES_AN_ADDRESS: &[&str] =
    &["_addr", "_dsn", "_endpoint", "_host", "_port", "_uri", "_url"];

static ASKS_THE_ENVIRONMENT: &[&str] = &["env", "environ", "environment", "getenv", "var"];

fn said_plainly(callee: &str) -> String {
    let lowered = callee.to_ascii_lowercase();
    let spoken = lowered.strip_suffix("async").unwrap_or(&lowered);
    spoken.trim_end_matches('_').to_string()
}

fn a_topic_is_named(named: &str) -> bool {
    named.contains(['.', ':', '/', '_', '-'])
        || named.chars().any(|letter| letter.is_ascii_uppercase())
}

fn agreed_by_hand(call: &CallFact) -> Vec<Shared> {
    let Some(named) = call.literals.first().map(String::as_str).filter(|held| held.len() > 2)
    else {
        return Vec::new();
    };
    let spoken = said_plainly(crate::names::leaf(&call.callee));
    let within = call.receiver.as_deref().unwrap_or_default().to_ascii_lowercase();
    let kept = A_KEPT_PLACE.iter().any(|place| within.contains(place));
    if kept && READS_A_KEY.contains(&spoken.as_str()) {
        return vec![Shared { family: "store", name: named.to_string(), role: "reads" }];
    }
    if kept && WRITES_A_KEY.contains(&spoken.as_str()) {
        return vec![Shared { family: "store", name: named.to_string(), role: "writes" }];
    }
    if ASKS_THE_ENVIRONMENT.contains(&spoken.as_str()) || within.contains("env") {
        let lowered = named.to_ascii_lowercase();
        if NAMES_AN_ADDRESS.iter().any(|ending| lowered.ends_with(ending)) {
            return vec![Shared { family: "address", name: lowered, role: "mentions" }];
        }
        return Vec::new();
    }
    if !a_topic_is_named(named) {
        return Vec::new();
    }
    if PUBLISHES.contains(&spoken.as_str()) {
        return vec![Shared { family: "topic", name: named.to_string(), role: "writes" }];
    }
    if SUBSCRIBES.contains(&spoken.as_str()) {
        return vec![Shared { family: "topic", name: named.to_string(), role: "reads" }];
    }
    Vec::new()
}

fn over_a_wire(decorator: &crate::model::Decorator) -> bool {
    let spoken = |named: &str| {
        OVER_A_WIRE.contains(&crate::names::leaf(named).to_ascii_lowercase().as_str())
    };
    spoken(&decorator.name)
        || decorator
            .arguments
            .iter()
            .any(|argument| !argument.literal && spoken(&argument.value))
}

fn link_across_parts(
    flows: &mut [Flow],
    shared: &HashMap<String, Vec<Shared>>,
) {
    let mut speaking: HashMap<(&str, &str), Vec<(usize, Option<&str>, &'static str)>> =
        HashMap::default();
    for (at, flow) in flows.iter().enumerate() {
        for holding in shared.get(&flow.entry_point).into_iter().flatten() {
            speaking
                .entry((holding.family, holding.name.as_str()))
                .or_default()
                .push((at, flow.project.as_deref(), holding.role));
        }
    }
    let mut linked: Vec<Vec<String>> = vec![Vec::new(); flows.len()];
    let mut by_family: BTreeMap<&str, usize> = BTreeMap::new();
    for ((family, _), holding) in speaking.iter() {
        let parts: HashSet<Option<&str>> = holding.iter().map(|(_, part, _)| *part).collect();
        if parts.len() > 1 && parts.len() <= SHARED_BY_AT_MOST {
            *by_family.entry(family).or_default() += 1;
        }
    }
    if !by_family.is_empty() {
        eprintln!(
            "seams {}",
            by_family
                .iter()
                .map(|(family, held)| format!("{family} {held}"))
                .collect::<Vec<String>>()
                .join(" | ")
        );
    }
    for holding in speaking.values() {
        let parts: HashSet<Option<&str>> = holding.iter().map(|(_, part, _)| *part).collect();
        if parts.len() < 2 || parts.len() > SHARED_BY_AT_MOST {
            continue;
        }
        for (at, part, role) in holding {
            for (other, elsewhere, played) in holding {
                if elsewhere == part || !answering(role, played) {
                    continue;
                }
                linked[*at].push(flows[*other].entry_point.clone());
            }
        }
    }
    for (at, flow) in flows.iter_mut().enumerate() {
        if linked[at].is_empty() {
            continue;
        }
        flow.leads_into.append(&mut linked[at]);
        flow.leads_into.sort();
        flow.leads_into.dedup();
        flow.leads_into.truncate(LINKED_AT_MOST);
        if flow.standing == "reading" {
            flow.standing = "proximal";
        }
    }
}

fn shared_family(kind: &str) -> Option<&'static str> {
    match kind {
        "message" | "queue" | "event" | "stream" => Some("topic"),
        "file" | "blob" => Some("artifact"),
        "process" => Some("command"),
        _ => None,
    }
}

fn answering(role: &str, played: &str) -> bool {
    match (role, played) {
        ("writes", "reads") | ("reads", "writes") => true,
        ("writes", "writes") | ("reads", "reads") => false,
        _ => role == played,
    }
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

fn naming(held: &str) -> Vec<&str> {
    held.split(|letter: char| !letter.is_alphanumeric() && letter != '_')
        .filter(|word| word.len() > 1 && word.starts_with(|letter: char| letter.is_alphabetic()))
        .collect()
}

static HOLDS_MANY: &[&str] = &[
    "array", "arraylist", "btreemap", "collection", "deque", "dictionary", "enumerable", "flow",
    "flux", "hashmap", "hashset", "icollection", "idictionary", "ienumerable", "ilist", "iterable",
    "iterator", "linkedlist", "list", "map", "observable", "publisher", "queue", "seq", "sequence",
    "set", "stream", "vec", "vector",
];

fn beside_nothing(annotation: &str) -> &str {
    annotation
        .split('|')
        .map(str::trim)
        .find(|part| !matches!(part.to_ascii_lowercase().as_str(), "none" | "null" | "undefined"))
        .unwrap_or(annotation)
}

fn points_at(annotation: &str) -> Option<(String, bool)> {
    let mut held = beside_nothing(annotation.trim()).trim();
    let mut many = held.contains("[]");
    loop {
        let trimmed = beside_nothing(held).trim_matches(['?', '!', ' ']);
        let trimmed = trimmed.strip_suffix("[]").unwrap_or(trimmed).trim_end();
        let wrapped = match (trimmed.find('<'), trimmed.rfind('>')) {
            (Some(open), Some(close)) if close > open + 1 => Some((open, close)),
            _ => match (trimmed.find('['), trimmed.rfind(']')) {
                (Some(open), Some(close)) if close > open + 1 && open > 0 => Some((open, close)),
                _ => None,
            },
        };
        let within = match wrapped {
            Some((open, close)) => {
                let wrapper = trimmed[..open].rsplit(['.', ':']).next().unwrap_or("");
                many = many
                    || HOLDS_MANY
                        .binary_search(&wrapper.to_ascii_lowercase().as_str())
                        .is_ok();
                beside_nothing(trimmed[open + 1..close].rsplit(',').next().unwrap_or("")).trim()
            }
            None => trimmed,
        };
        if within == held {
            break;
        }
        held = within;
    }
    let held = held.rsplit(['.', ':']).next()?.trim();
    let named = held
        .chars()
        .all(|letter| letter.is_alphanumeric() || letter == '_')
        .then(|| held.to_string())?;
    (!named.is_empty()).then_some((named, many))
}

fn declares_a_table(name: &str) -> bool {
    let held: String = name.chars().filter(|held| !held.is_whitespace()).collect();
    held.eq_ignore_ascii_case("table=true")
}

fn unquoted(name: &str) -> &str {
    name.trim_matches(['`', '"', '[', ']', '\''])
}

fn declares_no_records(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    [
        ".yml", ".yaml", ".json", ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml", ".css",
        ".scss", ".sass", ".less", ".styl",
    ]
        .iter()
        .any(|extension| lowered.ends_with(extension))
}

fn the_same_record(left: &[Column], right: &[Field]) -> bool {
    let smaller = left.len().min(right.len());
    if smaller < 4 {
        return false;
    }
    let held: HashSet<String> = right.iter().map(|field| field.name.to_ascii_lowercase()).collect();
    let shared = left
        .iter()
        .filter(|column| held.contains(&column.named.to_ascii_lowercase()))
        .count();
    shared * 5 >= smaller * 4
}

fn a_schema(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.ends_with(".prisma") || lowered.ends_with(".sql")
}

static WRITING_A_RECORD: &[&str] = &[
    "create", "to_writer", "write", "write_all", "writealltext", "writefile", "writeall",
];
static READING_A_RECORD: &[&str] = &[
    "from_reader", "open", "read", "read_to_end", "read_to_string", "readalltext", "readfile",
];
static NOT_A_RECORD: &[&str] = &[
    "arc", "bool", "box", "duration", "hashmap", "instant", "option", "path", "pathbuf", "rc",
    "result", "self", "str", "string", "vec",
];

static CARRIES_ANOTHER: &[&str] = &["arc", "box", "option", "rc", "result", "vec"];

fn plainly(held: &str) -> &str {
    let mut held = held.trim().trim_start_matches('&').trim_start_matches("mut ").trim();
    if held.starts_with("impl ") || held.starts_with("dyn ") {
        return "";
    }
    loop {
        let Some(at) = held.find('<') else { break };
        let outer = held[..at].rsplit("::").next().unwrap_or(&held[..at]);
        if !CARRIES_ANOTHER.contains(&outer.to_ascii_lowercase().as_str()) {
            held = &held[..at];
            break;
        }
        held = held[at + 1..].trim_end_matches('>').trim();
        held = held.split(',').next().unwrap_or(held).trim();
        held = held.trim_start_matches('&').trim_start_matches("mut ").trim();
    }
    held.rsplit("::").next().unwrap_or(held).trim()
}

fn a_record(held: &str) -> bool {
    !held.is_empty()
        && held.chars().next().is_some_and(char::is_uppercase)
        && !NOT_A_RECORD.contains(&held.to_ascii_lowercase().as_str())
}

fn named_by(node: &IndexNode, holder: Option<&IndexNode>) -> Vec<String> {
    let mut held: Vec<String> = Vec::new();
    let mut returned = None;
    if let Some(signature) = node.signature.as_ref() {
        for parameter in signature.parameters.iter() {
            if let Some(annotation) = parameter.type_annotation.as_deref() {
                held.push(plainly(annotation).to_string());
            }
        }
        if let Some(gives) = signature.return_type.as_deref() {
            returned = Some(plainly(gives).to_string());
            held.push(plainly(gives).to_string());
        }
    }
    if let Some(holder) = holder.filter(|held| held.kind.is_type()) {
        let itself = returned
            .as_deref()
            .is_some_and(|gives| gives == "Self" || gives == holder.name);
        if itself {
            held.push(holder.name.clone());
        }
    }
    held.retain(|held| a_record(held) && held != "Self");
    held
}

fn kept_in_a_file(
    nodes: &[IndexNode],
    files: &[String],
    exit_points: &[ExitPoint],
) -> Vec<(String, u32)> {
    let node_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut written: HashMap<String, u32> = HashMap::default();
    let mut read: HashSet<String> = HashSet::default();
    for exit in exit_points.iter().filter(|exit| exit.kind == "file") {
        if files.get(exit.file as usize).is_some_and(|path| crate::paths::is_test(path)) {
            continue;
        }
        let verb = crate::names::leaf(&exit.operation).to_ascii_lowercase();
        let writing = WRITING_A_RECORD.contains(&verb.as_str());
        if !writing && !READING_A_RECORD.contains(&verb.as_str()) {
            continue;
        }
        let Some(node) = node_of.get(exit.source.as_str()).copied() else { continue };
        let holder = node.parent.as_deref().and_then(|at| node_of.get(at).copied());
        for named in named_by(node, holder) {
            match writing {
                true => {
                    written.entry(named).or_insert(exit.file);
                }
                false => {
                    read.insert(named);
                }
            }
        }
    }
    let mut kept: Vec<(String, u32)> =
        written.into_iter().filter(|(named, _)| read.contains(named)).collect();
    kept.sort();
    kept
}

struct Denoting<'a> {
    by_name: HashMap<String, Vec<&'a IndexNode>>,
    by_table: HashMap<String, Vec<&'a IndexNode>>,
    reaches: HashSet<(&'a str, &'a str)>,
    project_of_file: HashMap<u32, &'a str>,
    files: &'a [String],
    naming_its_table: HashSet<&'a str>,
    kind_of: HashMap<&'a str, NodeKind>,
    members: HashMap<&'a str, u32>,
}

static SPOKEN_ALIKE: &[(&str, &str)] = &[
    ("cjs", "js"), ("cts", "js"), ("js", "js"), ("jsx", "js"), ("mjs", "js"), ("mts", "js"),
    ("ts", "js"), ("tsx", "js"), ("vue", "js"), ("svelte", "js"),
];

static NAMES_ITS_TABLE: &[&str] = &["__tablename__", "_table_name", "table_name"];

fn written_in(path: &str) -> Option<&str> {
    let (_, extension) = path.rsplit_once('.')?;
    let lowered = extension.to_ascii_lowercase();
    match SPOKEN_ALIKE.iter().find(|(known, _)| *known == lowered) {
        Some((_, family)) => Some(family),
        None => Some(extension),
    }
}

impl<'a> Denoting<'a> {
    fn new(
        candidates: &[&'a IndexNode],
        nodes: &'a [IndexNode],
        edges: &'a [IndexEdge],
        files: &'a [String],
    ) -> Self {
        let node_of: HashMap<&str, &IndexNode> =
            nodes.iter().map(|node| (node.id.as_str(), node)).collect();
        let naming_its_table = edges
            .iter()
            .filter(|edge| edge.kind == EdgeKind::HasField)
            .filter(|edge| {
                node_of
                    .get(edge.target.as_str())
                    .is_some_and(|field| NAMES_ITS_TABLE.contains(&field.name.as_str()))
            })
            .map(|edge| edge.source.as_str())
            .collect();
        let mut by_name: HashMap<String, Vec<&IndexNode>> = HashMap::default();
        let mut by_table: HashMap<String, Vec<&IndexNode>> = HashMap::default();
        for node in candidates {
            by_name.entry(node.name.to_ascii_lowercase()).or_default().push(node);
            let holds_rows = !matches!(node.kind, NodeKind::Interface | NodeKind::Enum);
            for key in tables_named_for(&node.name).into_iter().filter(|_| holds_rows) {
                let held = by_table.entry(key).or_default();
                if !held.iter().any(|known| known.id == node.id) {
                    held.push(node);
                }
            }
        }
        let reaches = edges
            .iter()
            .filter(|edge| edge.kind != EdgeKind::Contains)
            .filter_map(|edge| {
                let from = node_of.get(edge.source.as_str())?.project.as_deref()?;
                let to = node_of.get(edge.target.as_str())?.project.as_deref()?;
                (from != to).then_some((from, to))
            })
            .collect();
        let project_of_file = nodes
            .iter()
            .filter(|node| node.kind == NodeKind::Module)
            .filter_map(|node| Some((node.file, node.project.as_deref()?)))
            .collect();
        let kind_of = nodes.iter().map(|node| (node.id.as_str(), node.kind)).collect();
        let mut members: HashMap<&str, u32> = HashMap::default();
        for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::HasField | EdgeKind::HasMethod)) {
            *members.entry(edge.source.as_str()).or_insert(0) += 1;
        }
        Denoting {
            by_name,
            by_table,
            reaches,
            project_of_file,
            files,
            naming_its_table,
            kind_of,
            members,
        }
    }

    fn named(&self, name: &str, site: u32) -> Vec<&'a str> {
        self.pick(self.by_name.get(&name.to_ascii_lowercase()), site)
    }

    fn tabled(&self, table: &str, site: u32) -> Vec<&'a str> {
        self.pick(self.by_table.get(&table.to_ascii_lowercase()), site)
    }

    fn spoken_alike(&self, site: u32, node: &IndexNode) -> bool {
        let Some(site) = self.files.get(site as usize) else { return true };
        if a_schema(site) {
            return true;
        }
        let declared = self.files.get(node.file as usize).and_then(|path| written_in(path));
        written_in(site) == declared
    }

    fn pick(&self, candidates: Option<&Vec<&'a IndexNode>>, site: u32) -> Vec<&'a str> {
        let Some(candidates) = candidates else { return Vec::new() };
        let spoken: Vec<&'a IndexNode> = candidates
            .iter()
            .copied()
            .filter(|node| self.spoken_alike(site, node))
            .collect();
        let named: Vec<&'a IndexNode> = spoken
            .iter()
            .copied()
            .filter(|node| self.naming_its_table.contains(node.id.as_str()))
            .collect();
        let spoken = match named.is_empty() {
            true => spoken,
            false => named,
        };
        let outermost: Vec<&'a IndexNode> = spoken
            .iter()
            .copied()
            .filter(|node| {
                node.parent
                    .as_deref()
                    .and_then(|parent| self.kind_of.get(parent))
                    .is_none_or(|kind| *kind == NodeKind::Module)
            })
            .collect();
        let spoken = match outermost.is_empty() {
            true => spoken,
            false => outermost,
        };
        let mut once: Vec<&'a IndexNode> = Vec::new();
        for node in spoken {
            let reopened = once.iter().position(|held| {
                held.project == node.project && held.name.eq_ignore_ascii_case(&node.name)
            });
            match reopened {
                None => once.push(node),
                Some(at) => {
                    let fuller = self.members.get(node.id.as_str()).copied().unwrap_or(0)
                        > self.members.get(once[at].id.as_str()).copied().unwrap_or(0);
                    if fuller {
                        once[at] = node;
                    }
                }
            }
        }
        let candidates = &once;
        let from = self.project_of_file.get(&site).copied();
        let ids = |held: Vec<&&'a IndexNode>| held.into_iter().map(|node| node.id.as_str()).collect();
        let alongside: Vec<&&IndexNode> =
            candidates.iter().filter(|node| node.project.as_deref() == from).collect();
        if !alongside.is_empty() {
            return ids(alongside);
        }
        let reached: Vec<&&IndexNode> = candidates
            .iter()
            .filter(|node| {
                from.zip(node.project.as_deref())
                    .is_some_and(|(from, to)| self.reaches.contains(&(from, to)))
            })
            .collect();
        if !reached.is_empty() {
            return ids(reached);
        }
        Vec::new()
    }
}

fn tables_named_for(name: &str) -> Vec<String> {
    let named = name.to_ascii_lowercase();
    let spoken: String = crate::names::spoken_as(name).to_ascii_lowercase().replace(' ', "_");
    let mut held: Vec<String> = [named.clone(), spoken.clone()]
        .iter()
        .flat_map(|held: &String| [held.clone(), format!("{held}s"), format!("{held}es")])
        .chain(named.strip_suffix('y').map(|held| format!("{held}ies")))
        .chain(spoken.strip_suffix('y').map(|held| format!("{held}ies")))
        .collect();
    held.sort();
    held.dedup();
    held
}

fn entities(
    nodes: &[IndexNode],
    files: &[String],
    edges: &[IndexEdge],
    exit_points: &[ExitPoint],
    roles: &crate::roles::Roles,
    declared_tables: &[crate::tables::Table],
    calls: &[CallFact],
    type_references: &[crate::model::TypeReferenceFact],
) -> Vec<Entity> {
    let node_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut fields: HashMap<&str, u32> = HashMap::default();
    let mut named_fields: HashMap<&str, Vec<Field>> = HashMap::default();
    let mut pointing: HashMap<&str, Vec<Reference>> = HashMap::default();
    let mut extending: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Extends) {
        extending.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
    }
    for edge in edges {
        if edge.kind == EdgeKind::HasField {
            *fields.entry(edge.source.as_str()).or_insert(0) += 1;
            let held = named_fields.entry(edge.source.as_str()).or_default();
            if let Some(field) = node_of.get(edge.target.as_str())
                && !tells_of_itself(&field.name)
            {
                held.push(Field {
                    name: field.name.clone(),
                    declared_as: field.type_annotation.clone(),
                });
                let held = pointing.entry(edge.source.as_str()).or_default();
                if let Some(annotation) = field.type_annotation.as_deref()
                    && let Some((entity, many)) = points_at(annotation)
                {
                    held.push(Reference {
                        field: field.name.clone(),
                        entity,
                        many,
                        declared_by: "type",
                    });
                }
                for named in field
                    .decorators
                    .iter()
                    .filter_map(|decorator| decorator.arguments.first())
                    .filter(|argument| !argument.literal)
                    .flat_map(|argument| naming(&argument.value))
                {
                    held.push(Reference {
                        field: field.name.clone(),
                        entity: named.to_string(),
                        many: false,
                        declared_by: "decorator",
                    });
                }
            }
        }
    }
    for call in calls {
        let Some(caller) = call.caller.as_deref().and_then(|id| node_of.get(id)) else { continue };
        let Some(owner) = caller.parent.as_deref().and_then(|id| node_of.get(id)) else { continue };
        let Some(named) = call.literals.first() else { continue };
        if !owner.kind.is_type() || caller.name.is_empty() {
            continue;
        }
        let many = call.callee.to_ascii_lowercase().contains("many");
        for held in naming(named) {
            pointing.entry(owner.id.as_str()).or_default().push(Reference {
                field: caller.name.clone(),
                entity: held.to_string(),
                many,
                declared_by: "call",
            });
        }
    }

    let modelled: HashSet<&str> = roles
        .roles
        .iter()
        .filter(|role| role.role == "model" && !role.from.starts_with("name:"))
        .map(|role| role.node.as_str())
        .collect();
    let declared_persisted: HashSet<&str> = roles
        .roles
        .iter()
        .filter(|role| role.role == "model" && role.from.starts_with("annotation:"))
        .map(|role| role.node.as_str())
        .chain(
            type_references
                .iter()
                .filter(|reference| declares_a_table(&reference.name))
                .map(|reference| reference.source.as_str()),
        )
        .collect();
    let handled: Vec<(&str, u32, &str)> = nodes
        .iter()
        .filter_map(|node| {
            Some((held_by_a_handle(node.type_annotation.as_deref()?)?, node.file, node.name.as_str()))
        })
        .collect();
    let modelled_names: HashSet<&str> = nodes
        .iter()
        .filter(|node| modelled.contains(node.id.as_str()))
        .map(|node| node.name.as_str())
        .collect();
    let mut created: BTreeMap<String, Table> = BTreeMap::new();
    for table in declared_tables {
        if files.get(table.file as usize).is_some_and(|path| crate::paths::is_test(path)) {
            continue;
        }
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
                    declared_by: table.declared_by.clone(),
                    change: table.change.clone(),
                },
            );
        }
    }
    let where_tables_are_made: HashSet<&str> = declared_tables
        .iter()
        .filter(|table| table.declared_by.is_none())
        .filter_map(|table| files.get(table.file as usize))
        .filter(|path| !a_schema(path))
        .map(|path| path.rsplit_once('/').map(|(directory, _)| directory).unwrap_or(""))
        .collect();
    let directory_of = |path: &'_ str| -> String {
        path.rsplit_once('/').map(|(directory, _)| directory).unwrap_or("").to_string()
    };
    let declaring_types: HashSet<String> = nodes
        .iter()
        .filter(|node| node.kind.is_type())
        .filter_map(|node| files.get(node.file as usize))
        .map(|path| directory_of(path))
        .collect();
    let history: Vec<String> = where_tables_are_made
        .iter()
        .flat_map(|made| {
            let above = made.rsplit_once('/').map(|(above, _)| above.to_string());
            std::iter::once(made.to_string())
                .chain(above.filter(|above| !declaring_types.contains(above)))
        })
        .collect();
    let in_the_history = |path: &str| {
        history.iter().any(|root| {
            path.strip_prefix(root.as_str()).is_some_and(|rest| rest.starts_with('/'))
        })
    };
    let declared_names: HashSet<String> = nodes
        .iter()
        .filter(|node| node.kind.is_type())
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !declares_no_records(path)))
        .map(|node| node.name.to_ascii_lowercase())
        .chain(created.keys().cloned())
        .collect();
    let mut kept: BTreeMap<String, (Vec<String>, Vec<String>, u32)> = BTreeMap::new();
    let mut stored_at: Vec<(String, u32)> = Vec::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "database") {
        let Some(named) = addressed(receiver_of(exit), &modelled_names, &declared_names) else { continue };
        let managed = receiver_of(exit)
            .split('.')
            .any(|segment| MANAGERS.binary_search(&segment).is_ok());
        if managed {
            stored_at.push((named.to_ascii_lowercase(), exit.file));
        }
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
    let storing: HashSet<&str> = exit_points
        .iter()
        .filter(|exit| matches!(exit.kind, "database" | "file" | "client_storage"))
        .map(|exit| exit.source.as_str())
        .collect();
    let holder_of: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|node| Some((node.id.as_str(), node.parent.as_deref()?)))
        .collect();
    let mut written: HashMap<&str, Vec<String>> = HashMap::default();
    let mut read: HashMap<&str, Vec<String>> = HashMap::default();
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
    let candidates: Vec<&IndexNode> = nodes
        .iter()
        .filter(|node| node.kind.is_type() && node.kind != NodeKind::Enum)
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !declares_no_records(path)))
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !in_the_history(path)))
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !crate::paths::is_test(path)))
        .collect();
    let denoting = Denoting::new(&candidates, nodes, edges, files);
    let claimed: HashSet<String> = declared_tables
        .iter()
        .filter(|table| table.declared_by.is_some())
        .map(|table| table.named.to_ascii_lowercase())
        .collect();
    let mut admitted: HashSet<&str> = declared_persisted;
    admitted.extend(
        candidates
            .iter()
            .filter(|node| files.get(node.file as usize).is_some_and(|path| a_schema(path)))
            .filter(|node| {
                files.get(node.file as usize).is_some_and(|path| !path.to_ascii_lowercase().ends_with(".sql"))
                    || (created.contains_key(&unquoted(&node.name).to_ascii_lowercase())
                        && !claimed.contains(&unquoted(&node.name).to_ascii_lowercase()))
            })
            .map(|node| node.id.as_str()),
    );
    for (named, site) in kept_in_a_file(nodes, files, exit_points) {
        admitted.extend(denoting.named(&named, site));
    }
    let mut handled_as: HashMap<String, &str> = HashMap::default();
    for (named, site, handle) in &handled {
        let denoted = denoting.named(named, *site);
        if let [only] = denoted.as_slice() {
            handled_as.entry(handle.to_ascii_lowercase()).or_insert(only);
        }
        admitted.extend(denoted);
    }
    for (named, site) in &stored_at {
        admitted.extend(
            denoting
                .named(named, *site)
                .into_iter()
                .filter(|id| fields.get(id).copied().unwrap_or(0) >= 1),
        );
    }
    let mut tabled: HashMap<&str, String> = HashMap::default();
    let mut accounted: HashSet<String> = HashSet::default();
    let candidate_ids: HashSet<&str> = candidates.iter().map(|node| node.id.as_str()).collect();
    let mut declaring: HashMap<&str, Vec<&str>> = HashMap::default();
    for table in declared_tables {
        let Some(by) = table.declared_by.as_deref() else { continue };
        let by = match node_of.get(by) {
            Some(inner) if inner.name == "Meta" => inner.parent.as_deref().unwrap_or(by),
            _ => by,
        };
        if candidate_ids.contains(by) {
            declaring.entry(table.named.as_str()).or_default().push(by);
        }
    }
    for (key, table) in &created {
        if let Some(by) = declaring.get(key.as_str()) {
            let mut by = by.clone();
            by.sort();
            if let Some(first) = by.first() {
                tabled.insert(first, key.clone());
            }
            accounted.extend(by.iter().skip(1).map(|_| key.clone()));
            admitted.extend(by);
            continue;
        }
        if let Some(by) = handled_as.get(key.as_str()) {
            tabled.insert(by, key.clone());
            continue;
        }
        let denoted = denoting.tabled(key, table.file);
        if let [only] = denoted.as_slice() {
            tabled.insert(*only, key.clone());
        }
        admitted.extend(denoted);
    }
    let entities: Vec<Entity> = candidates
        .iter()
        .filter(|node| admitted.contains(node.id.as_str()))
        .map(|node| Entity {
            id: format!("entity:{}", node.id),
            addressed_by: kept
                .get(&node.name.to_ascii_lowercase())
                .map(|held| held.2)
                .unwrap_or(0),
            declared_as: unquoted(&node.name).to_string(),
            named_fields: with_inherited(&named_fields, &extending, node.id.as_str()),
            name: None,
            description: None,
            grounding: None,
            declared_in: Some(node.id.clone()),
            fields: fields.get(node.id.as_str()).copied().unwrap_or(0),
            written_by: written.get(node.id.as_str()).cloned().unwrap_or_default(),
            read_by: read.get(node.id.as_str()).cloned().unwrap_or_default(),
            references: pointing.remove(node.id.as_str()).unwrap_or_default(),
            project: node.project.clone(),
            terminality: None,
        })
        .collect();
    let mut richest: BTreeMap<(String, String), Entity> = BTreeMap::new();
    for entity in entities {
        let key = (entity.project.clone().unwrap_or_default(), entity.declared_as.to_ascii_lowercase());
        match richest.entry(key) {
            std::collections::btree_map::Entry::Vacant(held) => {
                held.insert(entity);
            }
            std::collections::btree_map::Entry::Occupied(mut held) => {
                let in_sql = |entity: &Entity| {
                    entity.declared_in.as_deref().is_some_and(|at| {
                        at.split(':').next().is_some_and(|path| path.to_ascii_lowercase().ends_with(".sql"))
                    })
                };
                let plainer = in_sql(held.get()) && !in_sql(&entity);
                let fuller = in_sql(held.get()) == in_sql(&entity) && entity.fields > held.get().fields;
                if plainer || fuller {
                    held.insert(entity);
                }
            }
        }
    }
    let written_down: HashSet<String> = richest.keys().map(|(_, named)| named.clone()).collect();
    let mut entities: Vec<Entity> = richest.into_values().collect();
    let bound_as: HashMap<&str, &str> = tabled
        .iter()
        .map(|(by, key)| (key.as_str(), *by))
        .chain(handled_as.iter().map(|(handle, by)| (handle.as_str(), *by)))
        .collect();
    for entity in entities.iter_mut() {
        let Some(at) = entity.declared_in.as_deref() else { continue };
        for (addressed, by) in &bound_as {
            if *by != at {
                continue;
            }
            let Some((written_by, read_by, addressed_by)) = kept.remove(*addressed) else { continue };
            entity.addressed_by += addressed_by;
            for (held, more) in [(&mut entity.written_by, written_by), (&mut entity.read_by, read_by)] {
                for source in more {
                    if held.len() < 8 && !held.contains(&source) {
                        held.push(source);
                    }
                }
            }
        }
        let Some(key) = entity.declared_in.as_deref().and_then(|at| tabled.get(at)) else {
            continue;
        };
        let Some(table) = created.remove(key) else { continue };
        if entity.named_fields.is_empty() {
            entity.fields = table.columns.len() as u32;
            entity.named_fields = table.columns.into_iter().map(Field::from).collect();
        }
        entity.references.extend(table.points_at.into_iter().map(|(field, pointed)| Reference {
            field,
            entity: pointed,
            many: false,
            declared_by: "foreign key",
        }));
    }
    created.retain(|key, table| {
        !accounted.contains(key)
            && !written_down.contains(key)
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
            named_fields: columns.into_iter().map(Field::from).collect(),
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
            terminality: None,
        });
    }
    for (named, table) in created {
        entities.push(Entity {
            id: format!("record:{named}"),
            declared_as: table.named,
            fields: table.columns.len() as u32,
            named_fields: table.columns.into_iter().map(Field::from).collect(),
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
                .map(|(field, entity)| Reference {
                    field,
                    entity,
                    many: false,
                    declared_by: "foreign key",
                })
                .collect(),
            project: None,
            terminality: None,
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
    use crate::model::{Decorator, DecoratorArgument};

    fn derived(traits: &[&str]) -> Decorator {
        Decorator {
            name: "derive".to_string(),
            arguments: traits
                .iter()
                .map(|named| DecoratorArgument {
                    value: (*named).to_string(),
                    literal: false,
                })
                .collect(),
        }
    }

    #[test]
    fn a_type_crosses_a_wire_whichever_codec_encodes_it() {
        use super::over_a_wire;
        assert!(over_a_wire(&derived(&["Debug", "Clone", "Encode", "Decode"])));
        assert!(over_a_wire(&derived(&["Serialize", "Deserialize"])));
        assert!(over_a_wire(&derived(&["serde::Serialize"])));
        assert!(!over_a_wire(&derived(&["Debug", "Clone", "Default"])));
        assert!(over_a_wire(&Decorator {
            name: "Serializable".to_string(),
            arguments: Vec::new(),
        }));
    }

    fn calling(callee: &str, receiver: Option<&str>, literal: &str) -> crate::model::CallFact {
        crate::model::CallFact {
            file: 0,
            caller: Some("unit".to_string()),
            callee: callee.to_string(),
            receiver: receiver.map(str::to_string),
            line: 1,
            column: 1,
            argument_count: 1,
            literals: vec![literal.to_string()],
            constructs: false,
            type_arguments: Vec::new(),
            context: crate::model::CallContext::default(),
        }
    }

    fn agreed(callee: &str, receiver: Option<&str>, literal: &str) -> Option<(String, String)> {
        super::agreed_by_hand(&calling(callee, receiver, literal))
            .first()
            .map(|held| (held.family.to_string(), held.role.to_string()))
    }

    #[test]
    fn a_schema_file_is_an_agreement_however_it_is_written() {
        use super::{AGREED_IN_A_SCHEMA, agreed_in_a_schema};
        assert!(AGREED_IN_A_SCHEMA.windows(2).all(|held| held[0] < held[1]));
        assert!(agreed_in_a_schema("api/basket.proto"));
        assert!(agreed_in_a_schema("schema.graphql"));
        assert!(!agreed_in_a_schema("src/main.rs"));
        assert!(!agreed_in_a_schema("Makefile"));
    }

    #[test]
    fn a_publisher_seams_to_a_subscriber_of_the_same_topic() {
        assert_eq!(
            agreed("publish", Some("bus"), "order.placed"),
            Some(("topic".to_string(), "writes".to_string()))
        );
        assert_eq!(
            agreed("subscribe", Some("bus"), "order.placed"),
            Some(("topic".to_string(), "reads".to_string()))
        );
        assert_eq!(
            agreed("PublishAsync", Some("bus"), "order.placed"),
            Some(("topic".to_string(), "writes".to_string()))
        );
        assert_eq!(agreed("on", Some("element"), "mouseup"), None);
        assert_eq!(agreed("Handle", None, "cancellationToken"), None);
    }

    #[test]
    fn a_route_is_matched_by_its_shape_not_its_spelling() {
        use super::{route_shape, same_shape};
        let served = route_shape("/assets/:assetId/history");
        assert!(same_shape(&route_shape("/assets/${assetId}/history?limit=${limit}"), &served));
        assert!(same_shape(&route_shape("https://host.example/assets/42/history"), &served));
        assert!(same_shape(&route_shape("/assets/{asset_id}/history"), &served));
        assert!(!same_shape(&route_shape("/assets/42/prices"), &served));
        assert!(!same_shape(&route_shape("/"), &route_shape("/")));
    }

    #[test]
    fn a_route_can_be_served_under_a_prefix_the_caller_names() {
        use super::{mounted_under, route_shape};
        let served = route_shape("/opportunity-candidates/:id/evaluate");
        assert!(mounted_under(&route_shape("/api/v2/capital/opportunity-candidates/7/evaluate"), &served));
        assert!(!mounted_under(&route_shape("/search.json"), &route_shape("/price/address/:address")));
        assert!(!mounted_under(&route_shape("/api/users/7"), &route_shape("/users/:id")));
    }

    #[test]
    fn a_topic_is_a_name_agreed_on_not_a_thing_the_screen_does() {
        use super::a_topic_is_named;
        assert!(a_topic_is_named("order.placed"));
        assert!(a_topic_is_named("user:created"));
        assert!(a_topic_is_named("JOB_DONE"));
        assert!(a_topic_is_named("bookingConfirmed"));
        assert!(!a_topic_is_named("mouseup"));
        assert!(!a_topic_is_named("resize"));
        assert!(!a_topic_is_named("error"));
    }

    #[test]
    fn a_key_is_a_store_only_where_something_keeps_it() {
        assert_eq!(
            agreed("set", Some("redis"), "basket:42"),
            Some(("store".to_string(), "writes".to_string()))
        );
        assert_eq!(
            agreed("get", Some("cache"), "basket:42"),
            Some(("store".to_string(), "reads".to_string()))
        );
        assert_eq!(agreed("get", Some("account"), "basket:42"), None);
    }

    #[test]
    fn an_environment_name_is_a_seam_only_when_it_names_an_address() {
        assert_eq!(
            agreed("getenv", None, "COORDINATOR_URL"),
            Some(("address".to_string(), "mentions".to_string()))
        );
        assert_eq!(agreed("getenv", None, "LOG_LEVEL"), None);
    }

    #[test]
    fn a_store_seams_a_writer_to_a_reader_and_not_to_another_writer() {
        use super::answering;
        assert!(answering("writes", "reads"));
        assert!(answering("reads", "writes"));
        assert!(!answering("writes", "writes"));
        assert!(!answering("reads", "reads"));
        assert!(answering("mentions", "mentions"));
        assert!(!answering("mentions", "writes"));
    }

    #[test]
    fn the_containers_are_sorted() {
        assert!(super::HOLDS_MANY.windows(2).all(|held| held[0] < held[1]));
    }

    #[test]
    fn a_field_holds_many_when_its_container_says_so() {
        use super::points_at;
        assert_eq!(points_at("User"), Some(("User".to_string(), false)));
        assert_eq!(points_at("User?"), Some(("User".to_string(), false)));
        assert_eq!(points_at("Post[]"), Some(("Post".to_string(), true)));
        assert_eq!(points_at("List<User>"), Some(("User".to_string(), true)));
        assert_eq!(points_at("Vec<Episode>"), Some(("Episode".to_string(), true)));
        assert_eq!(points_at("Option<User>"), Some(("User".to_string(), false)));
        assert_eq!(points_at("Map<String, Album>"), Some(("Album".to_string(), true)));
        assert_eq!(
            points_at("java.util.List<com.tivi.Show>"),
            Some(("Show".to_string(), true))
        );
        assert_eq!(points_at("Flow<List<Season>>"), Some(("Season".to_string(), true)));
    }

    use super::*;

    #[test]
    fn a_database_call_names_the_record_it_addresses() {
        let modelled = HashSet::from_iter(["Booking"]);
        let declared = HashSet::from_iter(["booking".to_string()]);
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


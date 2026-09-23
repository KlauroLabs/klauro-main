use std::collections::{BTreeMap, HashMap, HashSet};
use rayon::prelude::*;

use serde::Serialize;

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
    pub steps: Vec<Step>,
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
    "add", "commit", "create", "delete", "dispatch", "emit", "enqueue", "insert", "patch", "post",
    "publish", "put", "remove", "save", "send", "set", "store", "update", "upsert", "write",
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

const PUBLISHED: &str = "published";
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
    pub shape: &'a str,
    pub serving: u32,
    pub routes: u32,
    pub shipped: u32,
    pub projects: usize,
    pub within: Vec<String>,
    pub languages: Vec<(String, u32)>,
    pub frameworks: Vec<String>,
}

fn carries(project: Option<&str>, flows: &[Flow], entities: &[Entity]) -> f64 {
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
    doing + 2.0 * kept as f64
}

fn parts_of(capabilities: &[Capability]) -> Vec<String> {
    let mut held: Vec<String> =
        capabilities.iter().filter_map(|capability| capability.project.clone()).collect();
    held.sort();
    held.dedup();
    held
}

fn describe_parts(
    capabilities: &[Capability],
    entities: &[Entity],
    spoken: &str,
    told: &Telling<'_>,
) -> Vec<Product> {
    let parts = parts_of(capabilities);
    if parts.len() < 2 {
        return Vec::new();
    }
    let mut held: Vec<Product> = parts
        .par_iter()
        .filter_map(|project| describe_one(capabilities, entities, spoken, told, Some(project)))
        .collect();
    held.sort_by(|left, right| left.project.cmp(&right.project));
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
    let weighed: Vec<(Option<&str>, Option<&Product>, f64)> = speaking
        .iter()
        .map(|held| {
            let part = parts.iter().find(|part| part.project.as_deref() == *held).copied();
            (*held, part, carries(*held, flows, entities))
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
    let capabilities: Vec<&Capability> = held.iter().filter(|capability| its(capability)).collect();
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
            !grounding.fabricated()
        );
    }
    (!grounding.fabricated()).then(|| Product {
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
        capability.standing = match grounding.stands() {
            true => PUBLISHED,
            false => PROVISIONAL,
        };
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!(
                "capability {:<44} supported {:.2} invented {:.2} outcome {:.2} universal {:.2} -> {}",
                capability.name.as_deref().unwrap_or(""),
                grounding.supported,
                grounding.invented,
                grounding.outcome,
                grounding.universal.unwrap_or(1.0),
                capability.standing
            );
        }
        !grounding.fabricated()
    });
}

fn families_of<'a>(flows: &[&'a Flow]) -> BTreeMap<Family, Vec<&'a Flow>> {
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    for flow in flows.iter() {
        grouped.entry(family_of(flow)).or_default().push(flow);
    }
    if grouped.keys().any(|family| !family.key.starts_with("trigger:")) {
        grouped.retain(|family, _| !family.key.starts_with("trigger:"));
    }
    for lane in grouped.values_mut() {
        lane.sort_by(|left, right| left.id.cmp(&right.id));
    }
    grouped
}

fn name_families(
    grouped: &[(Option<String>, BTreeMap<Family, Vec<&Flow>>)],
    spoken: &str,
) -> BTreeMap<String, crate::author::Written> {
    let mut pooled: BTreeMap<&str, (&Family, Vec<&Flow>)> = BTreeMap::new();
    for (_, families) in grouped.iter() {
        for (family, flows) in families.iter() {
            let held = pooled
                .entry(family.key.as_str())
                .or_insert_with(|| (family, Vec::new()));
            held.1.extend(flows.iter().copied());
        }
    }
    let keys: Vec<&str> = pooled.keys().copied().collect();
    let told: BTreeMap<String, String> = keys
        .iter()
        .enumerate()
        .filter_map(|(at, key)| {
            let (family, flows) = pooled.get(key)?;
            Some((format!("g{at}"), facts_of(flows, family)))
        })
        .collect();
    let per_call = crate::author::per_call_for(told.len());
    let written = crate::author::name_capabilities(spoken, &told, per_call);
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!(
            "  author pooled {} groups across {} parts in calls of {}, named {}",
            told.len(),
            grouped.len(),
            per_call,
            written.len()
        );
    }
    keys.into_iter()
        .enumerate()
        .filter_map(|(at, key)| Some((key.to_string(), written.get(&format!("g{at}"))?.clone())))
        .collect()
}

fn form_capabilities(
    grouped: BTreeMap<Family, Vec<&Flow>>,
    named_by_key: &BTreeMap<String, crate::author::Written>,
) -> Vec<Capability> {
    if !crate::author::asked() {
        return Vec::new();
    }
    let held: Vec<(&Family, &Vec<&Flow>)> = grouped.iter().collect();
    let mut capabilities: BTreeMap<String, Capability> = BTreeMap::new();
    for (family, flows) in held.iter() {
        let Some(named) = named_by_key.get(&family.key) else { continue };
        let id = format!("capability:{}", carved_name(&named.name));
        let entry = capabilities.entry(id.clone()).or_insert_with(|| Capability {
            id,
            audience: match named.audience.trim().is_empty() {
                true => None,
                false => Some(named.audience.trim().to_ascii_lowercase()),
            },
            delivered: Vec::new(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: Vec::new(),
            surfaces: Vec::new(),
            project: flows.first().and_then(|flow| flow.project.clone()),
            also_in: Vec::new(),
            place: None,
            name: Some(named.name.trim().to_string()),
            description: Some(named.description.trim().to_string()),
            grounding: None,
            standing: PUBLISHED,
            touches: Vec::new(),
        });
        for flow in flows.iter() {
            entry.delivered.push(Delivery {
                flow: flow.id.clone(),
                role: match flow.standing {
                    "terminal" | "proximal" => "primary",
                    _ => "supporting",
                },
                rationale: format!("{} belongs here by {}", flow.operation, family.basis),
            });
            entry.surfaces.push(match flow.method.as_deref() {
                Some(method) => format!("{method} {}", flow.operation),
                None => flow.operation.clone(),
            });
            entry.records.extend(flow.writes.iter().cloned());
            entry.touches.extend(flow.writes.iter().cloned());
            entry.touches.extend(flow.reads.iter().cloned());
            entry.changes.extend(flow.changes.iter().cloned());
        }
    }
    let mut formed: Vec<Capability> = capabilities.into_values().collect();
    for capability in formed.iter_mut() {
        capability.delivered.sort_by(|left, right| left.flow.cmp(&right.flow));
        capability.flows = capability.delivered.iter().map(|held| held.flow.clone()).collect();
        settle(&mut capability.surfaces);
        settle(&mut capability.records);
        settle(&mut capability.touches);
        settle(&mut capability.changes);
    }
    formed.sort_by(|left, right| left.id.cmp(&right.id));
    formed
}

static SAYS_NOTHING: &[&str] = &[
    "a", "access", "an", "and", "application", "control", "data", "for", "handling", "in",
    "management", "managing", "of", "operations", "or", "service", "services", "support",
    "system", "the", "to", "with",
];

fn about(name: &str) -> Vec<String> {
    name.split(|letter: char| !letter.is_ascii_alphanumeric())
        .map(|word| word.to_ascii_lowercase())
        .filter(|word| word.len() > 2 && !SAYS_NOTHING.contains(&word.as_str()))
        .map(|word| word.chars().take(4).collect())
        .collect()
}

fn worth_asking_together(capabilities: &[Capability]) -> Vec<Vec<usize>> {
    let mut owner: Vec<usize> = (0..capabilities.len()).collect();
    fn root(owner: &mut Vec<usize>, mut at: usize) -> usize {
        while owner[at] != at {
            owner[at] = owner[owner[at]];
            at = owner[at];
        }
        at
    }
    let mut by_word: HashMap<String, usize> = HashMap::new();
    for (at, capability) in capabilities.iter().enumerate() {
        for word in about(capability.name.as_deref().unwrap_or("")) {
            match by_word.get(&word).copied() {
                Some(other) => {
                    let (left, right) = (root(&mut owner, at), root(&mut owner, other));
                    owner[left] = right;
                }
                None => {
                    by_word.insert(word, at);
                }
            }
        }
    }
    let mut held: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for at in 0..capabilities.len() {
        let of = root(&mut owner, at);
        held.entry(of).or_default().push(at);
    }
    held.into_values().collect()
}

fn reconciled(capabilities: &[Capability], spoken: &str) -> Vec<Capability> {
    if capabilities.len() < 2 {
        return Vec::new();
    }
    let capabilities = &gathered_by_name(capabilities)[..];
    if capabilities.len() < 2 {
        return capabilities.to_vec();
    }
    let listed: BTreeMap<String, String> = capabilities
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            let mut surfaces = capability.surfaces.clone();
            surfaces.truncate(6);
            (
                format!("c{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  found in the part: {}\n  reached through: {}\n  paths: {}",
                    capability.name.as_deref().unwrap_or(""),
                    capability.audience.as_deref().unwrap_or("someone"),
                    capability.project.as_deref().map(within_of).unwrap_or("the repository root"),
                    surfaces.join(", "),
                    capability.delivered.len()
                ),
            )
        })
        .collect();
    let groups: Vec<crate::author::Same> = worth_asking_together(capabilities)
        .par_iter()
        .filter(|cluster| cluster.len() > 1)
        .flat_map(|cluster| {
            let asking: BTreeMap<String, String> = cluster
                .iter()
                .filter_map(|at| {
                    let key = format!("c{at}");
                    listed.get(&key).map(|told| (key, told.clone()))
                })
                .collect();
            crate::author::same_outcome(spoken, &asking)
        })
        .collect();
    let mut placed: Vec<Option<usize>> = vec![None; capabilities.len()];
    let mut named: Vec<&crate::author::Same> = Vec::new();
    for group in groups.iter() {
        let at = named.len();
        let mut held = false;
        for id in group.of.iter() {
            let Some(which) = id.trim().strip_prefix('c').and_then(|held| held.parse::<usize>().ok())
            else {
                continue;
            };
            if let Some(slot) = placed.get_mut(which)
                && slot.is_none()
            {
                *slot = Some(at);
                held = true;
            }
        }
        if held {
            named.push(group);
        }
    }
    let mut gathered: Vec<Vec<Capability>> =
        (0..named.len()).map(|_| Vec::new()).collect();
    let mut alone: Vec<Capability> = Vec::new();
    for (at, capability) in capabilities.iter().enumerate() {
        match placed[at] {
            Some(which) => gathered[which].push(capability.clone()),
            None => alone.push(capability.clone()),
        }
    }
    let mut held: Vec<Capability> = alone;
    for (group, mut members) in named.into_iter().zip(gathered) {
        if members.is_empty() {
            continue;
        }
        members.sort_by_key(|capability| std::cmp::Reverse(capability.delivered.len()));
        let mut together = members.remove(0);
        if members.is_empty() {
            held.push(together);
            continue;
        }
        for other in members {
            joined(&mut together, other);
        }
        continue_with(&mut together, group);
        together.delivered.sort_by(|left, right| left.flow.cmp(&right.flow));
        together.delivered.dedup_by(|left, right| left.flow == right.flow);
        together.flows = together.delivered.iter().map(|held| held.flow.clone()).collect();
        settle(&mut together.records);
        settle(&mut together.changes);
        settle(&mut together.surfaces);
        settle(&mut together.touches);
        held.push(together);
    }
    for capability in held.iter_mut() {
        if let Some(part) = capability.project.take()
            && !capability.also_in.contains(&part)
        {
            capability.also_in.push(part);
        }
        capability.also_in.sort();
        capability.also_in.dedup();
    }
    held.sort_by(|left, right| left.id.cmp(&right.id));
    say_what_each_is_for(&mut held, spoken);
    held
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
    let said = crate::author::what_it_is_for(spoken, &listed);
    for (at, capability) in held.iter_mut().enumerate() {
        capability.place = match said.get(&format!("p{at}")).map(String::as_str) {
            Some("terminal") => Some("terminal"),
            Some("proximal") => Some("proximal"),
            Some("supporting") => Some("supporting"),
            _ => None,
        };
    }
}

fn joined(into: &mut Capability, other: Capability) {
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

fn gathered_by_name(capabilities: &[Capability]) -> Vec<Capability> {
    let mut by: Vec<Capability> = Vec::new();
    for capability in capabilities {
        match by.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => joined(held, capability.clone()),
            None => by.push(capability.clone()),
        }
    }
    by
}

fn continue_with(held: &mut Capability, group: &crate::author::Same) {
    if group.name.trim().is_empty() {
        return;
    }
    held.id = format!("capability:{}", carved_name(&group.name));
    held.name = Some(group.name.trim().to_string());
    if !group.description.trim().is_empty() {
        held.description = Some(group.description.trim().to_string());
    }
    if !group.audience.trim().is_empty() {
        held.audience = Some(group.audience.trim().to_ascii_lowercase());
    }
}

fn settle(held: &mut Vec<String>) {
    held.sort();
    held.dedup();
}

fn carved_name(name: &str) -> String {
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
struct Family {
    key: String,
    basis: &'static str,
}

fn family_of(flow: &Flow) -> Family {
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

fn facts_of(flows: &[&Flow], family: &Family) -> String {
    let mut surfaces: Vec<String> = flows
        .iter()
        .map(|flow| match flow.method.as_deref() {
            Some(method) => format!("{method} {}", flow.operation),
            None => flow.operation.clone(),
        })
        .collect();
    settle(&mut surfaces);
    let mut records: Vec<String> = flows.iter().flat_map(|flow| flow.writes.iter().cloned()).collect();
    settle(&mut records);
    let mut changes: Vec<String> = flows.iter().flat_map(|flow| flow.changes.iter().cloned()).collect();
    settle(&mut changes);
    format!(
        "  these belong together by {}\n{}  reached through: {}\n  it writes these records: {}\n  \
         it ends by: {}\n  paths in this group: {}",
        family.basis,
        match flows.len() > 1 && family.key.starts_with("role:") {
            true => "  they are interchangeable ways of doing one thing, so name the one thing \
                     they are all for, never the interface they share\n",
            false => "",
        },
        surfaces.join(", "),
        match records.is_empty() {
            true => "none named".to_string(),
            false => records.join(", "),
        },
        match changes.is_empty() {
            true => "leading into other paths".to_string(),
            false => changes.join(", "),
        },
        flows.len()
    )
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
                    false => entity
                        .named_fields
                        .iter()
                        .map(|field| field.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
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
            let mut parts: Vec<Option<String>> =
                held.flows.iter().map(|flow| flow.project.clone()).collect();
            parts.sort();
            parts.dedup();
            let grouped: Vec<(Option<String>, BTreeMap<Family, Vec<&Flow>>)> = parts
                .par_iter()
                .map(|part| {
                    let flows: Vec<&Flow> =
                        held.flows.iter().filter(|flow| &flow.project == part).collect();
                    (part.clone(), families_of(&flows))
                })
                .collect();
            let named_by_key = name_families(&grouped, &spoken);
            let mut capabilities: Vec<Capability> = grouped
                .into_par_iter()
                .flat_map(|(part, families)| {
                    let said = spoken_within(&spoken, part.as_deref());
                    let mut found = form_capabilities(families, &named_by_key);
                    test_capabilities(&mut found, &said);
                    found
                })
                .collect();
            capabilities.sort_by(|left, right| left.id.cmp(&right.id));
            let (whole, described) = rayon::join(
                || reconciled(&capabilities, &spoken),
                || describe_parts(&capabilities, &held.entities, &spoken, told),
            );
            eprintln!(
                "  author read {} capabilities across the parts into {} for the whole",
                capabilities.len(),
                whole.len()
            );
            capabilities.extend(whole);
            capabilities.sort_by(|left, right| left.id.cmp(&right.id));
            let formed = started.elapsed();
            let products = describe_product(
                &capabilities,
                &held.entities,
                &held.flows,
                &spoken,
                told,
                described,
            );
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
    calls: &[CallFact],
    type_references: &[crate::model::TypeReferenceFact],
) -> Comprehension {
    let position_of: HashMap<&str, u32> = nodes
        .iter()
        .enumerate()
        .map(|(at, node)| (node.id.as_str(), at as u32))
        .collect();
    let mut played: HashMap<&str, &str> = HashMap::new();
    for held in type_references {
        if held.kind != EdgeKind::Implements {
            continue;
        }
        played.entry(held.source.as_str()).or_insert(held.name.as_str());
    }
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

    let entities_first = entities(nodes, files, edges, exit_points, roles, declared_tables, calls);
    let held: HashSet<&str> = entities_first
        .iter()
        .map(|entity| entity.declared_as.as_str())
        .collect();
    let mut entity_of: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut read_of: HashMap<&str, Vec<&str>> = HashMap::new();
    let spoken_of: HashMap<&str, &str> =
        nodes.iter().map(|node| (node.id.as_str(), node.name.as_str())).collect();
    let stored: HashSet<&str> = type_references
        .iter()
        .filter(|reference| declares_a_table(&reference.name))
        .filter_map(|reference| spoken_of.get(reference.source.as_str()).copied())
        .filter_map(|named| held.get(named).copied())
        .collect();
    let keeps = |named: &&str| stored.is_empty() || stored.contains(named);
    let mut named_within: HashMap<&str, Vec<&str>> = HashMap::new();
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
    for exit in exit_points {
        if exit.kind != "database" {
            continue;
        }
        let named = crate::names::root(&exit.target);
        let touching: Vec<&str> = match held.contains(named) {
            true => vec![named],
            false => named_within.get(exit.source.as_str()).cloned().unwrap_or_default(),
        };
        if touching.is_empty() {
            continue;
        }
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
            steps,
            units: seen.len() as u32,
            changes: changing,
            leads_into: into,
            project: nodes[start as usize].project.clone(),
        });
    }
    flows.sort_by(|left, right| left.id.cmp(&right.id));

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

fn a_setting(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    [".yml", ".yaml", ".json", ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml"]
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
) -> HashSet<String> {
    let node_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut written: HashSet<String> = HashSet::new();
    let mut read: HashSet<String> = HashSet::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "file") {
        if files.get(exit.file as usize).is_some_and(|path| crate::paths::is_test(path)) {
            continue;
        }
        let verb = crate::names::leaf(&exit.operation).to_ascii_lowercase();
        let held = if WRITING_A_RECORD.contains(&verb.as_str()) {
            &mut written
        } else if READING_A_RECORD.contains(&verb.as_str()) {
            &mut read
        } else {
            continue;
        };
        let Some(node) = node_of.get(exit.source.as_str()).copied() else { continue };
        let holder = node.parent.as_deref().and_then(|at| node_of.get(at).copied());
        held.extend(named_by(node, holder));
    }
    written.intersection(&read).cloned().collect()
}

fn entities(
    nodes: &[IndexNode],
    files: &[String],
    edges: &[IndexEdge],
    exit_points: &[ExitPoint],
    roles: &crate::roles::Roles,
    declared_tables: &[crate::tables::Table],
    calls: &[CallFact],
) -> Vec<Entity> {
    let node_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut fields: HashMap<&str, u32> = HashMap::new();
    let mut named_fields: HashMap<&str, Vec<Field>> = HashMap::new();
    let mut pointing: HashMap<&str, Vec<Reference>> = HashMap::new();
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
    let kept_on_disk = kept_in_a_file(nodes, files, exit_points);
    let entities: Vec<Entity> = nodes
        .iter()
        .filter(|node| node.kind.is_type())
        .filter(|node| files.get(node.file as usize).is_none_or(|path| !a_setting(path)))
        .filter(|node| {
            kept_on_disk.contains(node.name.as_str())
                || modelled.contains(node.id.as_str())
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


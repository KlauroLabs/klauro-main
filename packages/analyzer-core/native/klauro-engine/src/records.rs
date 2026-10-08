use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::comprehend::{Comprehension, Entity};

const FIELDS_TOLD: usize = 8;
const MEMBERS_TOLD: usize = 6;
const KEEPERS_TOLD: usize = 3;
const FLOWS_TOLD: usize = 3;

pub const ABOUT: &str = "domain";
pub const BOOKKEEPING: &str = "operational";

fn root_of<'a>(entities: &'a [Entity], at: &HashMap<&str, usize>, mut entity: &'a Entity) -> &'a Entity {
    let mut seen: HashSet<&str> = HashSet::default();
    while let Some(parent) = entity.part_of.as_deref().and_then(|named| at.get(named)).map(|held| &entities[*held]) {
        if !seen.insert(parent.declared_as.as_str()) {
            break;
        }
        entity = parent;
    }
    entity
}

fn told(entity: &Entity, number: usize, held_by: &HashMap<&str, Vec<&str>>, used_in: &HashMap<&str, Vec<&str>>) -> String {
    let fields: Vec<&str> = entity.named_fields.iter().take(FIELDS_TOLD).map(|field| field.name.as_str()).collect();
    let made_of: Vec<&str> = held_by.get(entity.declared_as.as_str()).into_iter().flatten().take(MEMBERS_TOLD).copied().collect();
    let keepers: Vec<&str> = entity
        .written_by
        .iter()
        .chain(entity.read_by.iter())
        .map(|unit| crate::names::leaf(unit.rsplit(':').next().unwrap_or(unit)))
        .take(KEEPERS_TOLD)
        .collect();
    let mut said = format!("{number}. {}", crate::names::spoken_as(&entity.declared_as));
    if !fields.is_empty() {
        said.push_str(&format!(" | fields: {}", fields.join(", ")));
    }
    if !made_of.is_empty() {
        said.push_str(&format!(" | made of: {}", made_of.iter().map(|named| crate::names::spoken_as(named)).collect::<Vec<_>>().join(", ")));
    }
    if let Some(flows) = used_in.get(entity.declared_as.as_str()) {
        said.push_str(&format!(" | used when: {}", flows.join("; ")));
    } else if !keepers.is_empty() {
        said.push_str(&format!(" | kept by: {}", keepers.join(", ")));
    }
    said
}

pub fn settle(comprehension: &mut Comprehension, part_names: &HashMap<&str, &str>) {
    let entities = &comprehension.entities;
    let mut used_in: HashMap<&str, Vec<&str>> = HashMap::default();
    for flow in &comprehension.flows {
        let Some(named) = flow.name.as_deref() else { continue };
        for object in flow.steps.iter().filter_map(|step| step.object.as_deref()) {
            let held = used_in.entry(object).or_default();
            if held.len() < FLOWS_TOLD && !held.contains(&named) {
                held.push(named);
            }
        }
    }
    let at: HashMap<&str, usize> = entities.iter().enumerate().map(|(at, entity)| (entity.declared_as.as_str(), at)).collect();
    let mut held_by: HashMap<&str, Vec<&str>> = HashMap::default();
    for entity in entities {
        if let Some(parent) = entity.part_of.as_deref() {
            held_by.entry(parent).or_default().push(entity.declared_as.as_str());
        }
    }
    let mut by_part: std::collections::BTreeMap<String, Vec<usize>> = std::collections::BTreeMap::new();
    for (position, entity) in entities.iter().enumerate().filter(|(_, entity)| entity.part_of.is_none()) {
        by_part.entry(entity.project.clone().unwrap_or_default()).or_default().push(position);
    }
    let mut asked: Vec<(String, String)> = Vec::new();
    let mut listed: Vec<(String, Vec<usize>)> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::default();
    for (part, positions) in by_part {
        let lines: Vec<String> = positions.iter().enumerate().map(|(number, position)| told(&entities[*position], number + 1, &held_by, &used_in)).collect();
        let named = part_names.get(part.as_str()).copied().unwrap_or(part.as_str());
        let key = format!("{part}\u{1}{}", lines.join("\n"));
        asked.push((key.clone(), format!("Part: {named}\n{}", lines.join("\n"))));
        counts.insert(key.clone(), positions.len());
        listed.push((key, positions));
    }
    let answered = crate::memory::each("record standing", crate::author::RECORDS_ASKED, &asked, |missing| {
        crate::author::asking(|| {
            missing
                .par_iter()
                .filter_map(|(key, prompt)| crate::author::bookkeeping_of(prompt, counts.get(key).copied().unwrap_or(0)).map(|held| (key.clone(), held)))
                .collect()
        })
    });
    let mut standing: HashMap<String, &'static str> = HashMap::default();
    for (key, positions) in listed {
        let Some(answer) = answered.get(&key) else { continue };
        let kinds: Vec<String> = serde_json::from_value(answer["kinds"].clone()).unwrap_or_default();
        if kinds.len() != positions.len() {
            continue;
        }
        for (kind, position) in kinds.iter().zip(positions.iter()) {
            let said = match kind.as_str() {
                "bookkeeping" => BOOKKEEPING,
                _ => ABOUT,
            };
            standing.insert(entities[*position].declared_as.clone(), said);
        }
    }
    let roots: Vec<String> = entities.iter().map(|entity| root_of(entities, &at, entity).declared_as.clone()).collect();
    for (entity, root) in comprehension.entities.iter_mut().zip(roots) {
        entity.standing = standing.get(&root).copied();
    }
}

use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::comprehend::{Comprehension, Entity};

const FIELDS_TOLD: usize = 8;
const MEMBERS_TOLD: usize = 6;
const KEEPERS_TOLD: usize = 3;

pub const ABOUT: &str = "domain";
pub const BOOKKEEPING: &str = "operational";

fn kept_on_its_own(entity: &Entity) -> bool {
    !entity.written_by.is_empty() || !entity.read_by.is_empty() || entity.addressed_by > 0
}

fn members(entities: &mut [Entity]) {
    let at: HashMap<String, usize> = entities.iter().enumerate().map(|(at, entity)| (entity.declared_as.clone(), at)).collect();
    let mut owner: Vec<Option<String>> = vec![None; entities.len()];
    for entity in entities.iter() {
        for reference in &entity.references {
            let Some(&child) = at.get(&reference.entity) else { continue };
            if entities[child].declared_as == entity.declared_as || kept_on_its_own(&entities[child]) || owner[child].is_some() {
                continue;
            }
            owner[child] = Some(entity.declared_as.clone());
        }
    }
    for (entity, part_of) in entities.iter_mut().zip(owner) {
        entity.part_of = part_of;
    }
}

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

fn told(entity: &Entity, number: usize, held_by: &HashMap<&str, Vec<&str>>) -> String {
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
    if !keepers.is_empty() {
        said.push_str(&format!(" | kept by: {}", keepers.join(", ")));
    }
    said
}

pub fn settle(comprehension: &mut Comprehension, part_names: &HashMap<&str, &str>) {
    members(&mut comprehension.entities);
    let entities = &comprehension.entities;
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
    for (part, positions) in by_part {
        let lines: Vec<String> = positions.iter().enumerate().map(|(number, position)| told(&entities[*position], number + 1, &held_by)).collect();
        let named = part_names.get(part.as_str()).copied().unwrap_or(part.as_str());
        let key = format!("{part}\u{1}{}", lines.join("\n"));
        asked.push((key.clone(), format!("Part: {named}\n{}", lines.join("\n"))));
        listed.push((key, positions));
    }
    let answered = crate::memory::each("record standing", crate::author::RECORDS_ASKED, &asked, |missing| {
        crate::author::asking(|| {
            missing
                .par_iter()
                .filter_map(|(key, prompt)| crate::author::bookkeeping_of(prompt).map(|held| (key.clone(), held)))
                .collect()
        })
    });
    let mut standing: HashMap<String, &'static str> = HashMap::default();
    for (key, positions) in listed {
        let Some(answer) = answered.get(&key) else { continue };
        let bookkeeping: HashSet<usize> = serde_json::from_value::<Vec<usize>>(answer["bookkeeping"].clone()).unwrap_or_default().into_iter().collect();
        for (number, position) in positions.iter().enumerate() {
            let said = match bookkeeping.contains(&(number + 1)) {
                true => BOOKKEEPING,
                false => ABOUT,
            };
            standing.insert(entities[*position].declared_as.clone(), said);
        }
    }
    let roots: Vec<String> = entities.iter().map(|entity| root_of(entities, &at, entity).declared_as.clone()).collect();
    for (entity, root) in comprehension.entities.iter_mut().zip(roots) {
        entity.standing = standing.get(&root).copied();
    }
}

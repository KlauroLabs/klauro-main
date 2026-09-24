use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;

use crate::author::{Placed, Proposal, Proposed};
use crate::comprehend::{carved_name, families_of, settle, Capability, Delivery, Family, Flow, PUBLISHED};

const FAMILIES_PER_PROPOSAL: usize = 60;
const SURFACES_SHOWN: usize = 6;
const CAPABILITIES_CONSOLIDATED_AT_ONCE: usize = 160;

struct Held {
    name: String,
    description: String,
    audience: String,
    families: BTreeSet<String>,
}

fn evidence_of(flows: &[&Flow], family: &Family) -> String {
    let mut surfaces: Vec<String> = flows
        .iter()
        .map(|flow| match flow.method.as_deref() {
            Some(method) => format!("{method} {}", flow.operation),
            None => flow.operation.clone(),
        })
        .collect();
    settle(&mut surfaces);
    let more = surfaces.len().saturating_sub(SURFACES_SHOWN);
    surfaces.truncate(SURFACES_SHOWN);
    let mut kinds: Vec<String> = flows.iter().map(|flow| flow.kind.to_string()).collect();
    settle(&mut kinds);
    let mut writes: Vec<String> = flows.iter().flat_map(|flow| flow.writes.iter().cloned()).collect();
    settle(&mut writes);
    let mut reads: Vec<String> = flows.iter().flat_map(|flow| flow.reads.iter().cloned()).collect();
    settle(&mut reads);
    reads.retain(|held| !writes.contains(held));
    let mut changes: Vec<String> = flows.iter().flat_map(|flow| flow.changes.iter().cloned()).collect();
    settle(&mut changes);
    let listed = |held: &[String]| match held.is_empty() {
        true => "none".to_string(),
        false => held.join(", "),
    };
    format!(
        "  belong together by {}\n  entered as: {}\n  reached through: {}{}\n  writes: {}\n  reads: {}\n  ends by: {}\n  paths: {}",
        family.basis,
        kinds.join(", "),
        surfaces.join(", "),
        match more {
            0 => String::new(),
            more => format!(" and {more} more"),
        },
        listed(&writes),
        listed(&reads),
        listed(&changes),
        flows.len()
    )
}

fn outcome_key(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

fn gather(proposals: Vec<Proposal>, held: &mut Vec<Held>, plumbing: &mut BTreeSet<String>, known: &BTreeSet<String>) {
    for proposal in proposals {
        plumbing.extend(proposal.plumbing.into_iter().filter(|id| known.contains(id)));
        for Proposed { name, description, audience, families } in proposal.capabilities {
            let families: BTreeSet<String> = families.into_iter().filter(|id| known.contains(id)).collect();
            if families.is_empty() {
                continue;
            }
            match held.iter_mut().find(|other| outcome_key(&other.name) == outcome_key(&name)) {
                Some(other) => other.families.extend(families),
                None => held.push(Held { name, description, audience, families }),
            }
        }
    }
}

fn place(
    said: &str,
    told: &BTreeMap<String, String>,
    held: &mut Vec<Held>,
    plumbing: &mut BTreeSet<String>,
) {
    let placed: BTreeSet<String> = held.iter().flat_map(|other| other.families.iter().cloned()).collect();
    let unplaced: Vec<(String, String)> = told
        .iter()
        .filter(|(id, _)| !placed.contains(*id) && !plumbing.contains(*id))
        .map(|(id, evidence)| (id.clone(), evidence.clone()))
        .collect();
    if unplaced.is_empty() {
        return;
    }
    let standing: Vec<(String, String)> =
        held.iter().map(|other| (other.name.clone(), other.description.clone())).collect();
    for Placed { family, capability, description, audience } in crate::author::place_families(said, &standing, &unplaced) {
        if !told.contains_key(&family) || placed.contains(&family) {
            continue;
        }
        if capability.trim().eq_ignore_ascii_case("plumbing") {
            plumbing.insert(family);
            continue;
        }
        match held.iter_mut().find(|other| outcome_key(&other.name) == outcome_key(&capability)) {
            Some(other) => {
                other.families.insert(family);
            }
            None => held.push(Held {
                name: capability,
                description,
                audience,
                families: BTreeSet::from([family]),
            }),
        }
    }
}

fn consolidate_within(said: &str, held: Vec<Held>) -> Vec<Held> {
    if held.len() < 2 {
        return held;
    }
    let listed: BTreeMap<String, String> = held
        .iter()
        .enumerate()
        .map(|(at, other)| {
            (
                format!("c{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  what someone gets: {}",
                    other.name, other.audience, other.description
                ),
            )
        })
        .collect();
    let groups = crate::author::same_outcome(said, &listed);
    let mut taken: Vec<bool> = vec![false; held.len()];
    let mut slots: Vec<Option<Held>> = held.into_iter().map(Some).collect();
    let mut joined: Vec<Held> = Vec::new();
    for group in groups {
        let members: Vec<usize> = group
            .of
            .iter()
            .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
            .filter(|at| *at < taken.len() && !taken[*at])
            .collect();
        if members.is_empty() {
            continue;
        }
        let mut families = BTreeSet::new();
        for at in &members {
            taken[*at] = true;
            if let Some(other) = slots[*at].take() {
                families.extend(other.families);
            }
        }
        joined.push(Held {
            name: group.name.trim().to_string(),
            description: group.description.trim().to_string(),
            audience: group.audience.trim().to_string(),
            families,
        });
    }
    joined.extend(slots.into_iter().flatten());
    joined
}

pub(crate) fn of_a_part(flows: &[&Flow], said: &str) -> Vec<Capability> {
    if !crate::author::asked() || flows.is_empty() {
        return Vec::new();
    }
    let served = flows.iter().any(|flow| flow.kind != "export");
    let kept: Vec<&Flow> = flows.iter().copied().filter(|flow| !served || flow.kind != "export").collect();
    let families = families_of(&kept);
    let keyed: Vec<(String, &Family, &Vec<&Flow>)> = families
        .iter()
        .enumerate()
        .map(|(at, (family, lane))| (format!("f{at}"), family, lane))
        .collect();
    let told: BTreeMap<String, String> =
        keyed.iter().map(|(id, family, lane)| (id.clone(), evidence_of(lane, family))).collect();
    let known: BTreeSet<String> = told.keys().cloned().collect();
    let listed: Vec<(String, String)> = told.iter().map(|(id, evidence)| (id.clone(), evidence.clone())).collect();
    let proposals: Vec<Proposal> = listed
        .par_chunks(FAMILIES_PER_PROPOSAL)
        .map(|chunk| crate::author::propose_capabilities(said, chunk))
        .collect();
    let chunked = proposals.len() > 1;
    let mut held: Vec<Held> = Vec::new();
    let mut plumbing: BTreeSet<String> = BTreeSet::new();
    gather(proposals, &mut held, &mut plumbing, &known);
    place(said, &told, &mut held, &mut plumbing);
    if chunked {
        held = consolidate_within(said, held);
    }
    let lanes: BTreeMap<&str, (&Family, &Vec<&Flow>)> =
        keyed.iter().map(|(id, family, lane)| (id.as_str(), (*family, *lane))).collect();
    let mut formed: Vec<Capability> = held
        .into_iter()
        .filter_map(|other| built(other, &lanes))
        .collect();
    formed.sort_by(|left, right| left.id.cmp(&right.id));
    formed
}

fn built(held: Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>) -> Option<Capability> {
    let name = held.name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let mut capability = Capability {
        id: format!("capability:{}", carved_name(&name)),
        audience: Some(held.audience.trim().to_ascii_lowercase()).filter(|audience| !audience.is_empty()),
        delivered: Vec::new(),
        records: Vec::new(),
        changes: Vec::new(),
        flows: Vec::new(),
        surfaces: Vec::new(),
        project: None,
        also_in: Vec::new(),
        place: None,
        name: Some(name),
        description: Some(held.description.trim().to_string()).filter(|description| !description.is_empty()),
        grounding: None,
        standing: PUBLISHED,
        touches: Vec::new(),
    };
    for family_id in &held.families {
        let Some((family, lane)) = lanes.get(family_id.as_str()) else { continue };
        for flow in lane.iter() {
            capability.project = capability.project.take().or_else(|| flow.project.clone());
            capability.delivered.push(Delivery {
                flow: flow.id.clone(),
                role: match flow.standing {
                    "terminal" | "proximal" => "primary",
                    _ => "supporting",
                },
                rationale: format!("{} belongs here by {}", flow.operation, family.basis),
            });
            capability.surfaces.push(match flow.method.as_deref() {
                Some(method) => format!("{method} {}", flow.operation),
                None => flow.operation.clone(),
            });
            capability.records.extend(flow.writes.iter().cloned());
            capability.touches.extend(flow.writes.iter().cloned());
            capability.touches.extend(flow.reads.iter().cloned());
            capability.changes.extend(flow.changes.iter().cloned());
        }
    }
    if capability.delivered.is_empty() {
        return None;
    }
    capability.delivered.sort_by(|left, right| left.flow.cmp(&right.flow));
    capability.delivered.dedup_by(|left, right| left.flow == right.flow);
    capability.flows = capability.delivered.iter().map(|held| held.flow.clone()).collect();
    settle(&mut capability.surfaces);
    settle(&mut capability.records);
    settle(&mut capability.touches);
    settle(&mut capability.changes);
    Some(capability)
}

pub(crate) fn of_the_whole(parts: &[Capability], spoken: &str) -> Vec<Capability> {
    if parts.len() < 2 {
        return Vec::new();
    }
    let listed: BTreeMap<String, String> = parts
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            let mut surfaces = capability.surfaces.clone();
            surfaces.truncate(SURFACES_SHOWN);
            (
                format!("c{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  what someone gets: {}\n  found in the part: {}\n  reached through: {}",
                    capability.name.as_deref().unwrap_or(""),
                    capability.audience.as_deref().unwrap_or("someone"),
                    capability.description.as_deref().unwrap_or(""),
                    capability.project.as_deref().unwrap_or("the repository root"),
                    surfaces.join(", ")
                ),
            )
        })
        .collect();
    let chunks: Vec<BTreeMap<String, String>> = listed
        .into_iter()
        .collect::<Vec<_>>()
        .chunks(CAPABILITIES_CONSOLIDATED_AT_ONCE)
        .map(|chunk| chunk.iter().cloned().collect())
        .collect();
    let groups: Vec<crate::author::Same> =
        chunks.par_iter().flat_map(|chunk| crate::author::same_outcome(spoken, chunk)).collect();
    let mut taken = vec![false; parts.len()];
    let mut whole: Vec<Capability> = Vec::new();
    for group in groups {
        let members: Vec<usize> = group
            .of
            .iter()
            .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
            .filter(|at| *at < parts.len() && !taken[*at])
            .collect();
        let Some(first) = members.first().copied() else { continue };
        let mut together = parts[first].clone();
        for at in &members {
            taken[*at] = true;
        }
        for at in members.iter().skip(1) {
            crate::comprehend::joined(&mut together, parts[*at].clone());
        }
        if !group.name.trim().is_empty() {
            together.id = format!("capability:{}", carved_name(&group.name));
            together.name = Some(group.name.trim().to_string());
        }
        if !group.description.trim().is_empty() {
            together.description = Some(group.description.trim().to_string());
        }
        if !group.audience.trim().is_empty() {
            together.audience = Some(group.audience.trim().to_ascii_lowercase());
        }
        whole.push(together);
    }
    for (at, capability) in parts.iter().enumerate() {
        if !taken[at] {
            whole.push(capability.clone());
        }
    }
    for capability in whole.iter_mut() {
        if let Some(part) = capability.project.take()
            && !capability.also_in.contains(&part)
        {
            capability.also_in.push(part);
        }
        capability.also_in.sort();
        capability.also_in.dedup();
    }
    let mut merged: Vec<Capability> = Vec::new();
    for capability in whole {
        match merged.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => crate::comprehend::joined(held, capability),
            None => merged.push(capability),
        }
    }
    merged.sort_by(|left, right| left.id.cmp(&right.id));
    merged
}

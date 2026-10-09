use std::collections::BTreeSet;

use rustc_hash::FxHashMap as HashMap;
use serde::{Deserialize, Serialize};

use crate::capabilities::{OfAPart, PartState, ABSENT, PENDING};
use crate::comprehend::{Capability, Delivery, Flow};

const RECORDS_TOLD: usize = 4;
const LANDINGS_TOLD: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Purpose {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub behaviours: Vec<usize>,
    #[serde(default)]
    pub supporting: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Purposes {
    #[serde(default)]
    pub purposes: Vec<Purpose>,
}

fn trigger_of(flow: &Flow) -> String {
    let said = flow.surface.as_deref().unwrap_or(&flow.operation);
    match flow.method.as_deref() {
        Some(method) => format!("{} {method} {said}", flow.kind),
        None => format!("{} {said}", flow.kind),
    }
}

fn told(number: usize, flow: &Flow, landed: &HashMap<&str, String>) -> String {
    let mut said = format!(
        "{number}. {} — {} | trigger: {}",
        flow.name.as_deref().unwrap_or(&flow.operation),
        flow.description.as_deref().unwrap_or_default(),
        trigger_of(flow)
    );
    let kept: Vec<String> = flow.writes.iter().take(RECORDS_TOLD).map(|record| crate::names::spoken_as(record)).collect();
    if !kept.is_empty() {
        said.push_str(&format!(" | keeps: {}", kept.join(", ")));
    }
    let read: Vec<String> = flow.reads.iter().take(RECORDS_TOLD).map(|record| crate::names::spoken_as(record)).collect();
    if !read.is_empty() {
        said.push_str(&format!(" | reads: {}", read.join(", ")));
    }
    let then: Vec<&str> = flow.leads_into.iter().filter_map(|into| landed.get(into.as_str()).map(String::as_str)).take(LANDINGS_TOLD).collect();
    if !then.is_empty() {
        said.push_str(&format!(" | then: {}", then.join("; ")));
    }
    said
}

pub(crate) fn of_a_part(flows: &[&Flow], said: &str, remembered_as: &str, landed: &HashMap<&str, String>) -> OfAPart {
    let named: Vec<&Flow> = flows.iter().copied().filter(|flow| flow.kind != "test").collect();
    let ships = |flow: &&Flow| !crate::unshipped::is_set_aside(flow.unshipped.as_ref());
    let tiers: [Vec<&Flow>; 3] = [
        named.iter().copied().filter(|flow| flow.kind != "export").filter(ships).collect(),
        named.iter().copied().filter(ships).collect(),
        named.clone(),
    ];
    let mut offered: Vec<&Flow> = tiers.into_iter().find(|tier| !tier.is_empty()).unwrap_or_default();
    if std::env::var("KLAURO_OFFERED_DUMP").is_ok() {
        for flow in &offered {
            eprintln!("offered[{remembered_as}]: {}", flow.surface.as_deref().unwrap_or(&flow.operation));
        }
    }
    offered.sort_by(|left, right| left.id.cmp(&right.id));
    if offered.is_empty() {
        return OfAPart { capabilities: Vec::new(), state: PartState { capabilities: ABSENT, reason: Some("the part holds no flow that ships".to_string()) }, pending: BTreeSet::new() };
    }
    if !crate::author::asked() {
        return OfAPart { capabilities: Vec::new(), state: PartState { capabilities: PENDING, reason: Some("the AI was not asked".to_string()) }, pending: BTreeSet::new() };
    }
    let lines: Vec<String> = offered.iter().enumerate().map(|(at, flow)| told(at + 1, flow, landed)).collect();
    let prompt = format!("Part: {said}\nBehaviours:\n{}", lines.join("\n"));
    let key = format!("{remembered_as}\u{1}{prompt}");
    let count = offered.len();
    let answered = crate::memory::each("part capabilities", crate::author::CAPABILITIES_ASKED, &[(key.clone(), prompt)], |missing| {
        crate::author::asking(|| missing.iter().filter_map(|(key, prompt)| crate::author::purposes_of(prompt, count).map(|held| (key.clone(), held))).collect())
    });
    let Some(answer) = answered.get(&key) else {
        return OfAPart {
            capabilities: Vec::new(),
            state: PartState { capabilities: PENDING, reason: Some("the AI gave no answer".to_string()) },
            pending: offered.iter().map(|flow| flow.id.clone()).collect(),
        };
    };
    let purposes: Purposes = serde_json::from_value(answer.clone()).unwrap_or_default();
    let mut capabilities: Vec<Capability> = Vec::new();
    let mut placed: BTreeSet<usize> = BTreeSet::new();
    for purpose in purposes.purposes {
        let name = purpose.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let mut capability = Capability {
            id: format!("capability:{}:{}", flows.first().and_then(|flow| flow.runs_in.as_deref().or(flow.project.as_deref())).unwrap_or("root"), crate::comprehend::carved_name(&name)),
            audience: None,
            delivered: Vec::new(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: Vec::new(),
            surfaces: Vec::new(),
            project: None,
            also_in: Vec::new(),
            place: Some("core"),
            name: Some(name),
            description: Some(purpose.outcome.trim().to_string()).filter(|outcome| !outcome.is_empty()),
            grounding: None,
            standing: crate::comprehend::PUBLISHED,
            level: crate::capabilities::PART,
            touches: Vec::new(),
            terminality: None,
            confidence: None,
            unsettled: None,
            composition_provenance: Vec::new(),
            parent_originated: None,
            evidence: String::new(),
        };
        for (numbers, role) in [(&purpose.behaviours, "primary"), (&purpose.supporting, "supporting")] {
            for number in numbers {
                let Some(flow) = number.checked_sub(1).and_then(|at| offered.get(at)) else { continue };
                if !placed.insert(*number) {
                    continue;
                }
                capability.project = capability.project.take().or_else(|| flow.runs_in.clone().or_else(|| flow.project.clone()));
                capability.delivered.push(Delivery { flow: flow.id.clone(), role, rationale: String::new(), unshipped: None });
                capability.surfaces.push(trigger_of(flow));
                capability.records.extend(flow.writes.iter().cloned());
                capability.touches.extend(flow.writes.iter().chain(flow.reads.iter()).cloned());
                capability.changes.extend(flow.changes.iter().cloned());
                if role == "primary" && (flow.standing == "terminal" || capability.terminality.is_none()) {
                    capability.terminality = Some(flow.standing);
                }
                capability.evidence.push_str(&lines[*number - 1]);
                capability.evidence.push('\n');
            }
        }
        if capability.delivered.iter().all(|delivered| delivered.role != "primary") {
            continue;
        }
        capability.flows = capability.delivered.iter().map(|delivered| delivered.flow.clone()).collect();
        for held in [&mut capability.records, &mut capability.touches, &mut capability.changes, &mut capability.surfaces] {
            held.sort();
            held.dedup();
        }
        capabilities.push(capability);
    }
    let pending: BTreeSet<String> = offered
        .iter()
        .enumerate()
        .filter(|(at, _)| !placed.contains(&(at + 1)))
        .map(|(_, flow)| flow.id.clone())
        .collect();
    OfAPart {
        state: PartState {
            capabilities: if capabilities.is_empty() { PENDING } else { crate::capabilities::SETTLED },
            reason: None,
        },
        capabilities,
        pending,
    }
}

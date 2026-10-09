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

pub(crate) fn of_a_part(flows: &[&Flow], quiet: &[&Flow], said: &str, remembered_as: &str, landed: &HashMap<&str, String>) -> OfAPart {
    let named: Vec<&Flow> = flows.iter().copied().filter(|flow| flow.kind != "test").collect();
    let ships = |flow: &&Flow| !crate::unshipped::is_set_aside(flow.unshipped.as_ref());
    let tiers: [Vec<&Flow>; 4] = [
        named.iter().copied().filter(|flow| flow.kind != "export").filter(ships).collect(),
        named.iter().copied().filter(ships).collect(),
        named.clone(),
        quiet.iter().copied().filter(|flow| flow.kind != "test").collect(),
    ];
    let surface_only = tiers[..3].iter().all(Vec::is_empty);
    let mut offered: Vec<&Flow> = tiers.into_iter().find(|tier| !tier.is_empty()).unwrap_or_default();
    if std::env::var("KLAURO_OFFERED_DUMP").is_ok() {
        for flow in &offered {
            eprintln!("offered[{remembered_as}]: {}", flow.surface.as_deref().unwrap_or(&flow.operation));
        }
    }
    offered.sort_by(|left, right| left.id.cmp(&right.id));
    if offered.is_empty() {
        return OfAPart { capabilities: Vec::new(), state: PartState { capabilities: ABSENT, reason: Some("the part holds no flow and offers nothing".to_string()) }, pending: BTreeSet::new() };
    }
    if !crate::author::asked() {
        return OfAPart { capabilities: Vec::new(), state: PartState { capabilities: PENDING, reason: Some("the AI was not asked".to_string()) }, pending: BTreeSet::new() };
    }
    let lines: Vec<String> = offered.iter().enumerate().map(|(at, flow)| told(at + 1, flow, landed)).collect();
    let heading = if surface_only { "What it offers other code (each is used inside the flows of the parts that call it)" } else { "Behaviours" };
    let prompt = format!("Part: {said}\n{heading}:\n{}", lines.join("\n"));
    let key = format!("{remembered_as}\u{1}{prompt}");
    let count = offered.len();
    let answered = crate::memory::each("part capabilities", crate::author::CAPABILITIES_ASKED, &[(key.clone(), prompt)], |missing| {
        crate::author::asking(|| missing.iter().filter_map(|(key, prompt)| crate::author::purposes_of(prompt, count).map(|held| (key.clone(), held))).collect())
    });
    let Some(answer) = answered.get(&key) else {
        return OfAPart {
            capabilities: Vec::new(),
            state: PartState { capabilities: PENDING, reason: Some("the AI gave no answer".to_string()) },
            pending: if surface_only { BTreeSet::new() } else { offered.iter().map(|flow| flow.id.clone()).collect() },
        };
    };
    let purposes: Purposes = serde_json::from_value(answer.clone()).unwrap_or_default();
    let (capabilities, placed) = formed(purposes, &offered, &lines, surface_only);
    let pending: BTreeSet<String> = offered
        .iter()
        .filter(|_| !surface_only)
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

fn formed(purposes: Purposes, offered: &[&Flow], lines: &[String], surface_only: bool) -> (Vec<Capability>, BTreeSet<usize>) {
    let mut capabilities: Vec<Capability> = Vec::new();
    let mut placed: BTreeSet<usize> = BTreeSet::new();
    for purpose in purposes.purposes {
        let name = purpose.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let mut capability = Capability {
            id: format!("capability:{}:{}", offered.first().and_then(|flow| flow.runs_in.as_deref().or(flow.project.as_deref())).unwrap_or("root"), crate::comprehend::carved_name(&name)),
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
        let mut primaries = 0usize;
        let serves_itself = !purpose.behaviours.iter().any(|number| (1..=offered.len()).contains(number) && !placed.contains(number));
        let (behaviours, supporting) = match serves_itself {
            true => (purpose.supporting.clone(), Vec::new()),
            false => (purpose.behaviours.clone(), purpose.supporting.clone()),
        };
        for (numbers, role) in [(&behaviours, "primary"), (&supporting, "supporting")] {
            for number in numbers {
                let Some(flow) = number.checked_sub(1).and_then(|at| offered.get(at)) else { continue };
                if !placed.insert(*number) {
                    continue;
                }
                if role == "primary" {
                    primaries += 1;
                }
                capability.project = capability.project.take().or_else(|| flow.runs_in.clone().or_else(|| flow.project.clone()));
                if !surface_only {
                    capability.delivered.push(Delivery { flow: flow.id.clone(), role, rationale: String::new(), unshipped: None });
                }
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
        if primaries == 0 {
            continue;
        }
        capability.flows = capability.delivered.iter().map(|delivered| delivered.flow.clone()).collect();
        for held in [&mut capability.records, &mut capability.touches, &mut capability.changes, &mut capability.surfaces] {
            held.sort();
            held.dedup();
        }
        capabilities.push(capability);
    }
    (capabilities, placed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered(id: &str) -> Flow {
        Flow {
            summary: String::new(),
            writes: Vec::new(),
            reads: Vec::new(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind: "export",
            method: None,
            operation: id.to_string(),
            surface: None,
            plays: None,
            standing: "reading",
            confidence: 1.0,
            unsettled: None,
            open: 0,
            cut: false,
            name: None,
            description: None,
            grounding: None,
            path: Vec::new(),
            steps: Vec::new(),
            step_edges: Vec::new(),
            units: 1,
            rank: 0,
            stages: Vec::new(),
            changes: Vec::new(),
            leads_into: Vec::new(),
            project: Some("subproject:events".to_string()),
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
        }
    }

    #[test]
    fn a_library_whose_offers_live_inside_other_parts_flows_is_still_asked_for_its_capabilities() {
        let held = [offered("PublishAsync"), offered("Subscribe")];
        let quiet: Vec<&Flow> = held.iter().collect();
        let part = of_a_part(&[], &quiet, "Event bus", "events", &HashMap::default());
        assert_ne!(part.state.capabilities, ABSENT, "a library with code has capabilities at its own level");
        assert!(part.pending.is_empty(), "what a library offers is not a flow of its own, so nothing waits on it");
    }

    fn purpose(name: &str, behaviours: &[usize], supporting: &[usize]) -> Purpose {
        Purpose { name: name.to_string(), outcome: String::new(), behaviours: behaviours.to_vec(), supporting: supporting.to_vec() }
    }

    #[test]
    fn a_purpose_whose_behaviours_are_all_supporting_delivers_them_itself() {
        let mut started = offered("Start the scheduler");
        started.kind = "lifecycle";
        let held = [started];
        let offered: Vec<&Flow> = held.iter().collect();
        let lines = vec!["1. Start the scheduler".to_string()];
        let (capabilities, placed) = formed(Purposes { purposes: vec![purpose("Run scheduled jobs", &[], &[1])] }, &offered, &lines, false);
        assert_eq!(capabilities.len(), 1, "supporting work that serves nothing else in the part is the part's purpose");
        assert_eq!(capabilities[0].delivered[0].role, "primary");
        assert!(placed.contains(&1));
    }

    #[test]
    fn supporting_behaviours_stay_under_the_capability_they_serve() {
        let held = [offered("Place order"), offered("Sign in")];
        let offered: Vec<&Flow> = held.iter().collect();
        let lines = vec!["1. Place order".to_string(), "2. Sign in".to_string()];
        let (capabilities, _) = formed(Purposes { purposes: vec![purpose("Place orders", &[1], &[2])] }, &offered, &lines, false);
        let roles: Vec<&str> = capabilities[0].delivered.iter().map(|delivered| delivered.role).collect();
        assert_eq!(roles, ["primary", "supporting"]);
    }

    #[test]
    fn a_part_that_holds_nothing_and_offers_nothing_has_no_capabilities() {
        let part = of_a_part(&[], &[], "Empty", "empty", &HashMap::default());
        assert_eq!(part.state.capabilities, ABSENT);
    }
}

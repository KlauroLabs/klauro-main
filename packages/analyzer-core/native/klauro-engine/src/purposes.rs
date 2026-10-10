use std::collections::BTreeSet;

use rustc_hash::FxHashMap as HashMap;
use serde::{Deserialize, Serialize};

use crate::capabilities::{OfAPart, PartState, ABSENT, PENDING};
use crate::comprehend::{Capability, Delivery, Flow};

const RECORDS_TOLD: usize = 4;
const LANDINGS_TOLD: usize = 3;
const MADE_TOLD: usize = 16;
const MEMBERS_TOLD: usize = 8;
const FOLDERS_TOLD_AT_MOST: usize = 80;

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
    if let Some(aside) = flow.unshipped.as_ref().filter(|aside| crate::unshipped::is_set_aside(Some(aside))) {
        said.push_str(&format!(" | not shipped: {}", aside.role));
    }
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

fn folder_of<'a>(flow: &'a Flow) -> &'a str {
    let surface = flow.surface.as_deref().unwrap_or(&flow.operation);
    let root = flow.project.as_deref().map(|part| part.strip_prefix("subproject:").unwrap_or(part)).unwrap_or_default();
    let inside = surface.strip_prefix(root).map(|rest| rest.trim_start_matches('/')).filter(|_| !root.is_empty()).unwrap_or(surface);
    inside.rsplit_once('/').map(|(folder, _)| folder).unwrap_or("")
}

fn listed(names: Vec<&str>, at_most: usize) -> String {
    let mut unique: Vec<&str> = Vec::new();
    for name in names {
        if !unique.contains(&name) {
            unique.push(name);
        }
    }
    let more = unique.len().saturating_sub(at_most);
    let mut said = unique.into_iter().take(at_most).collect::<Vec<_>>().join(", ");
    if more > 0 {
        said.push_str(&format!(" and {more} more"));
    }
    said
}

fn member_of(flow: &Flow) -> &str {
    flow.path
        .first()
        .and_then(|start| start.unit.rsplit(':').next())
        .map(|leaf| leaf.split('@').next().unwrap_or(leaf))
        .filter(|leaf| !leaf.is_empty() && !leaf.contains('/'))
        .unwrap_or(&flow.operation)
}

fn offered_together(number: usize, folder: &str, group: &[&Flow]) -> String {
    let folder = if folder.is_empty() { "top level" } else { folder };
    let made: Vec<&str> = group.iter().map(|flow| flow.surface.as_deref().unwrap_or(&flow.operation).rsplit('/').next().unwrap_or_default()).collect();
    let members: Vec<&str> = group.iter().map(|flow| member_of(flow)).collect();
    let mut said = format!("{number}. {folder}: {} | offers: {}", listed(made, MADE_TOLD), listed(members, MEMBERS_TOLD));
    let done: Vec<&str> = group.iter().flat_map(|flow| flow.steps.iter()).filter(|step| step.kind != "respond").map(|step| step.label.as_str()).filter(|label| !label.is_empty()).collect();
    if !done.is_empty() {
        said.push_str(&format!(" | does: {}", listed(done, MEMBERS_TOLD)));
    }
    let kept: Vec<String> = group.iter().flat_map(|flow| flow.writes.iter()).map(|record| crate::names::spoken_as(record)).collect();
    if !kept.is_empty() {
        said.push_str(&format!(" | keeps: {}", listed(kept.iter().map(String::as_str).collect(), RECORDS_TOLD)));
    }
    let read: Vec<String> = group.iter().flat_map(|flow| flow.reads.iter()).map(|record| crate::names::spoken_as(record)).collect();
    if !read.is_empty() {
        said.push_str(&format!(" | reads: {}", listed(read.iter().map(String::as_str).collect(), RECORDS_TOLD)));
    }
    said
}

fn by_folder<'a>(offered: &[&'a Flow]) -> Vec<(&'a str, Vec<&'a Flow>)> {
    let gathered = |coarse: bool| {
        let mut held: std::collections::BTreeMap<&'a str, Vec<&'a Flow>> = std::collections::BTreeMap::new();
        for flow in offered {
            let folder = folder_of(flow);
            let folder = if coarse { folder.split('/').next().unwrap_or(folder) } else { folder };
            held.entry(folder).or_default().push(flow);
        }
        held
    };
    let fine = gathered(false);
    let chosen = if fine.len() > FOLDERS_TOLD_AT_MOST { gathered(true) } else { fine };
    chosen.into_iter().collect()
}

pub(crate) struct Asked<'a> {
    pub part: Option<&'a str>,
    pub flows: &'a [&'a Flow],
    pub quiet: &'a [&'a Flow],
    pub checks: &'a [(String, String)],
    pub said: &'a str,
    pub remembered_as: &'a str,
    pub landed: &'a HashMap<&'a str, String>,
    pub journeys: bool,
    pub weights: &'a HashMap<String, crate::journeys::Weight>,
}

fn checked_together(number: usize, folder: &str, cases: &[&str]) -> String {
    let folder = if folder.is_empty() { "top level" } else { folder };
    format!("{number}. {folder}: {}", listed(cases.to_vec(), MADE_TOLD))
}

fn checks_by_folder<'a>(part: Option<&str>, checks: &'a [(String, String)]) -> Vec<(String, Vec<&'a str>)> {
    let root = part.map(|part| part.strip_prefix("subproject:").unwrap_or(part)).unwrap_or_default();
    let mut held: std::collections::BTreeMap<String, Vec<&str>> = std::collections::BTreeMap::new();
    for (path, case) in checks {
        let inside = path.strip_prefix(root).filter(|_| !root.is_empty()).map(|rest| rest.trim_start_matches('/')).unwrap_or(path);
        let folder = inside.rsplit_once('/').map(|(folder, _)| folder).unwrap_or("");
        held.entry(folder.to_string()).or_default().push(case.as_str());
    }
    if held.len() > FOLDERS_TOLD_AT_MOST {
        let mut coarse: std::collections::BTreeMap<String, Vec<&str>> = std::collections::BTreeMap::new();
        for (folder, cases) in held {
            coarse.entry(folder.split('/').next().unwrap_or_default().to_string()).or_default().extend(cases);
        }
        return coarse.into_iter().collect();
    }
    held.into_iter().collect()
}

pub(crate) fn of_a_part(asked: &Asked) -> OfAPart {
    let Asked { part, flows, quiet, checks, said, remembered_as, landed, journeys, weights } = *asked;
    let named: Vec<&Flow> = flows.iter().copied().filter(|flow| flow.kind != "test").collect();
    let tiers: [Vec<&Flow>; 2] = [named.clone(), quiet.iter().copied().filter(|flow| flow.kind != "test").collect()];
    let surface_only = tiers[0].is_empty();
    let checking = surface_only && !checks.is_empty();
    let mut offered: Vec<&Flow> = if checking { Vec::new() } else { tiers.into_iter().find(|tier| !tier.is_empty()).unwrap_or_default() };
    offered.sort_by(|left, right| left.id.cmp(&right.id));
    if offered.is_empty() && !checking {
        return OfAPart { capabilities: Vec::new(), state: PartState { capabilities: ABSENT, reason: Some("the part holds no flow and offers nothing".to_string()) }, pending: BTreeSet::new() };
    }
    let cases = checks_by_folder(part, checks);
    let (folders, groups): (Vec<&str>, Vec<Vec<&Flow>>) = match (checking, surface_only) {
        (true, _) => cases.iter().map(|(folder, _)| (folder.as_str(), Vec::new())).unzip(),
        (false, true) => by_folder(&offered).into_iter().unzip(),
        (false, false) => offered.iter().map(|flow| ("", vec![*flow])).unzip(),
    };
    let lines: Vec<String> = groups
        .iter()
        .zip(&folders)
        .enumerate()
        .map(|(at, (group, folder))| match (checking, surface_only) {
            (true, _) => checked_together(at + 1, folder, &cases[at].1),
            (false, true) => offered_together(at + 1, folder, group),
            (false, false) if journeys => format!(
                "{} | steps: {} | weight: {}",
                told(at + 1, group[0], landed),
                crate::journeys::through(group[0]),
                weights.get(&group[0].id).map(|weight| weight.said()).unwrap_or_else(|| "supporting work".to_string())
            ),
            (false, false) => told(at + 1, group[0], landed),
        })
        .collect();
    if std::env::var("KLAURO_OFFERED_DUMP").is_ok() {
        for line in &lines {
            eprintln!("offered[{remembered_as}]: {line}");
        }
    }
    if !crate::author::asked() {
        return OfAPart { capabilities: Vec::new(), state: PartState { capabilities: PENDING, reason: Some("the AI was not asked".to_string()) }, pending: BTreeSet::new() };
    }
    let heading = if journeys { "Flows of the whole system, each starting where a person or another system reaches it, with the steps it takes across the system and the weight of the work it carries: the system's capabilities are derived from these flows, as the outcomes the system as a whole is for, named for its customers, never naming a vendor, protocol or library" } else if checking { "What its tests check. Its capabilities are what those tests prove the system does, each named as verifying an outcome, and it has at least one" } else if surface_only { "What it offers other code. Its work runs inside the flows of the parts that call it, so its capabilities are what it lets those callers achieve, and it has at least one" } else { "Behaviours" };
    let prompt = format!("Part: {said}\n{heading}:\n{}", lines.join("\n"));
    let key = format!("{remembered_as}\u{1}{prompt}");
    let count = groups.len();
    let supporting_only: BTreeSet<usize> = groups
        .iter()
        .enumerate()
        .filter(|(_, group)| journeys && group.first().is_some_and(|flow| weights.get(&flow.id).copied() == Some(crate::journeys::Weight::Supporting)))
        .map(|(at, _)| at + 1)
        .collect();
    let holds = |_: &str, answer: &serde_json::Value| crate::author::what_is_wrong_with_purposes(answer, count).is_none();
    let answered = crate::memory::each_holding("part capabilities", crate::author::CAPABILITIES_ASKED, &[(key.clone(), prompt)], holds, |missing| {
        crate::author::asking(|| missing.iter().filter_map(|(key, prompt)| crate::author::purposes_of(prompt, count).map(|held| (key.clone(), held))).collect())
    });
    let Some(answer) = answered.get(&key) else {
        return OfAPart {
            capabilities: Vec::new(),
            state: PartState { capabilities: PENDING, reason: Some("the AI gave no answer".to_string()) },
            pending: if surface_only { BTreeSet::new() } else { offered.iter().map(|flow| flow.id.clone()).collect() },
        };
    };
    if std::env::var("KLAURO_OFFERED_DUMP").is_ok() {
        eprintln!("answered[{remembered_as}]: {answer}");
    }
    let purposes: Purposes = serde_json::from_value(answer.clone()).unwrap_or_default();
    let purposes = if journeys { without_substrate(purposes, &supporting_only) } else { purposes };
    let capabilities = formed(purposes, part, &groups, &lines, surface_only);
    OfAPart {
        state: PartState {
            capabilities: if capabilities.is_empty() { PENDING } else { crate::capabilities::SETTLED },
            reason: None,
        },
        capabilities,
        pending: BTreeSet::new(),
    }
}

fn without_substrate(mut purposes: Purposes, supporting_only: &BTreeSet<usize>) -> Purposes {
    purposes.purposes.retain(|purpose| purpose.behaviours.is_empty() || !purpose.behaviours.iter().all(|number| supporting_only.contains(number)));
    purposes
}

fn formed(purposes: Purposes, part: Option<&str>, groups: &[Vec<&Flow>], lines: &[String], surface_only: bool) -> Vec<Capability> {
    let project = groups.iter().flatten().next().and_then(|flow| flow.runs_in.clone().or_else(|| flow.project.clone())).or_else(|| part.map(str::to_string));
    let mut capabilities: Vec<Capability> = Vec::new();
    let mut delivered: BTreeSet<usize> = BTreeSet::new();
    for purpose in purposes.purposes {
        let mut letters = purpose.name.trim().chars();
        let Some(first) = letters.next() else { continue };
        let name: String = first.to_uppercase().chain(letters).collect();
        let mut capability = Capability {
            id: format!("capability:{}:{}", project.as_deref().unwrap_or("root"), crate::comprehend::carved_name(&name)),
            audience: None,
            delivered: Vec::new(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: Vec::new(),
            surfaces: Vec::new(),
            project: project.clone(),
            also_in: Vec::new(),
            supporting: false,
            name: Some(name),
            description: Some(purpose.outcome.trim().to_string()).filter(|outcome| !outcome.is_empty()),
            grounding: None,
            standing: crate::comprehend::PUBLISHED,
            level: crate::capabilities::PART,
            touches: Vec::new(),
            terminality: None,
            confidence: None,
            unsettled: None,
            offers: Vec::new(),
            used_in: Vec::new(),
            keeps: Vec::new(),
            reads: Vec::new(),
            keeps_through: Vec::new(),
            reads_through: Vec::new(),
            drawn_from: Vec::new(),
            low_weight: false,
            value: None,
            evidence: String::new(),
        };
        let mut primaries = 0usize;
        for (numbers, role) in [(&purpose.behaviours, "primary"), (&purpose.supporting, "supporting")] {
            for number in numbers {
                let Some(group) = number.checked_sub(1).and_then(|at| groups.get(at)) else { continue };
                if role == "primary" && !delivered.insert(*number) && !surface_only {
                    continue;
                }
                if role == "primary" {
                    primaries += 1;
                }
                for flow in group {
                    match surface_only {
                        true => capability.offers.extend(flow.path.first().map(|start| start.unit.clone())),
                        false => capability.delivered.push(Delivery { flow: flow.id.clone(), role, rationale: String::new(), unshipped: None }),
                    }
                    capability.surfaces.push(trigger_of(flow));
                    capability.records.extend(flow.writes.iter().cloned());
                    capability.touches.extend(flow.writes.iter().chain(flow.reads.iter()).cloned());
                    capability.changes.extend(flow.changes.iter().cloned());
                    if role == "primary" && (flow.standing == "terminal" || capability.terminality.is_none()) {
                        capability.terminality = Some(flow.standing);
                    }
                }
                capability.evidence.push_str(&lines[*number - 1]);
                capability.evidence.push('\n');
            }
        }
        if primaries == 0 {
            continue;
        }
        capability.flows = capability.delivered.iter().map(|delivered| delivered.flow.clone()).collect();
        for held in [&mut capability.records, &mut capability.touches, &mut capability.changes, &mut capability.surfaces, &mut capability.offers] {
            held.sort();
            held.dedup();
        }
        capabilities.push(capability);
    }
    capabilities
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
            takes: Vec::new(),
            leads_into: Vec::new(),
            project: Some("subproject:events".to_string()),
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capabilities: Vec::new(),
            value: None,
        }
    }

    #[test]
    fn a_library_whose_offers_live_inside_other_parts_flows_is_still_asked_for_its_capabilities() {
        let held = [offered("PublishAsync"), offered("Subscribe")];
        let quiet: Vec<&Flow> = held.iter().collect();
        let landed = HashMap::default();
        let part = of_a_part(&Asked { part: Some("subproject:events"), flows: &[], quiet: &quiet, checks: &[], said: "Event bus", remembered_as: "events", landed: &landed, journeys: false, weights: &HashMap::default() });
        assert_ne!(part.state.capabilities, ABSENT, "a library with code has capabilities at its own level");
        assert!(part.pending.is_empty(), "what a library offers is not a flow of its own, so nothing waits on it");
    }

    fn purpose(name: &str, behaviours: &[usize], supporting: &[usize]) -> Purpose {
        Purpose { name: name.to_string(), outcome: String::new(), behaviours: behaviours.to_vec(), supporting: supporting.to_vec() }
    }


    #[test]
    fn supporting_behaviours_stay_under_the_capability_they_serve() {
        let held = [offered("Place order"), offered("Sign in")];
        let groups: Vec<Vec<&Flow>> = held.iter().map(|flow| vec![flow]).collect();
        let lines = vec!["1. Place order".to_string(), "2. Sign in".to_string()];
        let capabilities = formed(Purposes { purposes: vec![purpose("Place orders", &[1], &[2])] }, None, &groups, &lines, false);
        let roles: Vec<&str> = capabilities[0].delivered.iter().map(|delivered| delivered.role).collect();
        assert_eq!(roles, ["primary", "supporting"]);
    }

    #[test]
    fn what_a_library_offers_is_told_folder_by_folder() {
        let mut first = offered("Publish");
        first.surface = Some("events/Bus/Publisher".to_string());
        let mut second = offered("Subscribe");
        second.surface = Some("events/Bus/Subscriber".to_string());
        let mut third = offered("Save");
        third.surface = Some("events/Log/Store".to_string());
        for flow in [&mut first, &mut second, &mut third] {
            flow.project = Some("subproject:events".to_string());
        }
        assert_eq!(folder_of(&first), "Bus");
        assert_eq!(offered_together(1, "Bus", &[&first, &second]), "1. Bus: Publisher, Subscriber | offers: Publish, Subscribe");
        let step = |kind: &'static str, label: &str| crate::steps::LogicalStep {
            id: label.to_string(),
            kind,
            label: label.to_string(),
            object: None,
            doing: None,
            when: "always",
            arms: Vec::new(),
            regions: Vec::new(),
            description: None,
            lands_in: Vec::new(),
            gathers: Vec::new(),
        };
        third.steps = vec![step("call", "Call /events"), step("respond", "Respond")];
        assert_eq!(offered_together(2, "Log", &[&third]), "2. Log: Store | offers: Save | does: Call /events", "what the code does is told, never its replies");
        let grouped = by_folder(&[&first, &second, &third]);
        assert_eq!(grouped.iter().map(|(folder, group)| (*folder, group.len())).collect::<Vec<_>>(), [("Bus", 2), ("Log", 1)]);
        assert_eq!(folder_of(&third), "Log");
    }

    #[test]
    fn a_flow_answer_that_numbers_nothing_among_several_behaviours_forms_nothing() {
        let held = [offered("Place order"), offered("Cancel order")];
        let groups: Vec<Vec<&Flow>> = held.iter().map(|flow| vec![flow]).collect();
        let lines = vec!["1. a".to_string(), "2. b".to_string()];
        let capabilities = formed(Purposes { purposes: vec![purpose("Place orders", &[], &[])] }, None, &groups, &lines, false);
        assert!(capabilities.is_empty(), "a flow is placed only where the answer says");
    }

    #[test]
    fn supporting_work_may_serve_several_capabilities_but_a_flow_delivers_only_one() {
        let held = [offered("Place order"), offered("Cancel order"), offered("Sign in")];
        let groups: Vec<Vec<&Flow>> = held.iter().map(|flow| vec![flow]).collect();
        let lines = vec!["1. a".to_string(), "2. b".to_string(), "3. c".to_string()];
        let capabilities = formed(Purposes { purposes: vec![purpose("Place orders", &[1], &[3]), purpose("Cancel orders", &[2, 1], &[3])] }, None, &groups, &lines, false);
        let roles = |at: usize| capabilities[at].delivered.iter().map(|held| (held.flow.as_str(), held.role)).collect::<Vec<_>>();
        assert_eq!(roles(0), [("Place order", "primary"), ("Sign in", "supporting")]);
        assert_eq!(roles(1), [("Cancel order", "primary"), ("Sign in", "supporting")]);
    }

    #[test]
    fn a_purpose_that_delivers_nothing_is_not_a_capability() {
        let held = [offered("Sign in")];
        let groups: Vec<Vec<&Flow>> = held.iter().map(|flow| vec![flow]).collect();
        let lines = vec!["1. a".to_string()];
        let capabilities = formed(Purposes { purposes: vec![purpose("Sign in", &[], &[1])] }, None, &groups, &lines, false);
        assert!(capabilities.is_empty());
    }


    #[test]
    fn a_whole_capability_built_only_on_supporting_journeys_is_absent_and_the_rest_stands() {
        let built_on_support = purpose("Manage sessions", &[3], &[]);
        let kept = purpose("Place orders", &[1], &[2]);
        let left = without_substrate(Purposes { purposes: vec![built_on_support, kept] }, &BTreeSet::from([3]));
        assert_eq!(left.purposes.iter().map(|purpose| purpose.name.as_str()).collect::<Vec<_>>(), ["Place orders"]);
    }

    #[test]
    fn a_part_that_holds_nothing_and_offers_nothing_has_no_capabilities() {
        let landed = HashMap::default();
        let part = of_a_part(&Asked { part: Some("subproject:empty"), flows: &[], quiet: &[], checks: &[], said: "Empty", remembered_as: "empty", landed: &landed, journeys: false, weights: &HashMap::default() });
        assert_eq!(part.state.capabilities, ABSENT);
    }

    #[test]
    fn a_test_suite_is_told_what_its_tests_check_folder_by_folder() {
        let checks = vec![
            ("suite/Ordering/OrdersTests.cs".to_string(), "Places an order".to_string()),
            ("suite/Ordering/OrdersTests.cs".to_string(), "Cancels an order".to_string()),
            ("suite/Basket/BasketTests.cs".to_string(), "Adds an item".to_string()),
        ];
        let folders = checks_by_folder(Some("subproject:suite"), &checks);
        let lines: Vec<String> = folders.iter().enumerate().map(|(at, (folder, cases))| checked_together(at + 1, folder, cases)).collect();
        assert_eq!(lines, ["1. Basket: Adds an item", "2. Ordering: Places an order, Cancels an order"]);
        let landed = HashMap::default();
        let part = of_a_part(&Asked { part: Some("subproject:suite"), flows: &[], quiet: &[], checks: &checks, said: "Suite", remembered_as: "suite", landed: &landed, journeys: false, weights: &HashMap::default() });
        assert_ne!(part.state.capabilities, ABSENT, "a test suite has capabilities from what it checks");
    }
}

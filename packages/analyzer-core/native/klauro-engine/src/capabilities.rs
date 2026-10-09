use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;
use serde::Serialize;

use crate::comprehend::{carved_name, Capability, Flow};

pub(crate) const PART: &str = "part";
pub(crate) const WHOLE: &str = "whole";

pub(crate) const SETTLED: &str = "settled";
pub(crate) const PENDING: &str = "pending";
pub(crate) const ABSENT: &str = "none";

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct PartState {
    pub capabilities: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(crate) struct OfAPart {
    pub(crate) capabilities: Vec<Capability>,
    pub(crate) state: PartState,
    pub(crate) pending: BTreeSet<String>,
}

impl OfAPart {
}

static SCREEN_EVENTS: &[&str] = &[
    "blur", "change", "click", "contextmenu", "dblclick", "domcontentloaded", "focus", "input", "keydown", "keypress",
    "keyup", "load", "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup",
    "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup", "resize",
    "scroll", "touchend", "touchmove", "touchstart", "visibilitychange", "wheel",
];

pub(crate) fn is_a_screen_event(operation: &str) -> bool {
    SCREEN_EVENTS.contains(&operation.to_ascii_lowercase().as_str())
}

#[derive(Debug, Serialize, Clone)]
pub struct PartCoverage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub flows: u32,
    pub related: u32,
    pub unmapped: u32,
    pub flows_to_capabilities: f64,
    pub capabilities: PartState,
}

#[derive(Debug, Serialize, Clone)]
pub struct Unmapped {
    pub flow: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct Coverage {
    pub flows: u32,
    pub related: u32,
    pub unmapped: u32,
    pub flows_to_capabilities: f64,
    pub parts: Vec<PartCoverage>,
    pub unmapped_flows: Vec<Unmapped>,
}

fn share_of(related: u32, flows: u32) -> f64 {
    match flows {
        0 => 0.0,
        flows => (f64::from(related) / f64::from(flows) * 1000.0).round() / 1000.0,
    }
}

fn why_unmapped(flow: &Flow, pending: &BTreeSet<String>) -> String {
    match pending.contains(&flow.id) {
        true => "the AI gave no answer for its part".to_string(),
        false => "no capability of its part delivers or supports it".to_string(),
    }
}

pub(crate) fn coverage_of(
    flows: &[Flow],
    capabilities: &[Capability],
    states: &BTreeMap<Option<String>, PartState>,
    pending: &BTreeSet<String>,
) -> Coverage {
    let related: BTreeSet<&str> =
        capabilities.iter().flat_map(|capability| capability.flows.iter().map(String::as_str)).collect();
    let mut parts: BTreeMap<Option<&str>, PartCoverage> = BTreeMap::new();
    let mut unmapped_flows: Vec<Unmapped> = Vec::new();
    let mut mapped = 0u32;
    for flow in flows {
        let part = parts.entry(flow.project.as_deref()).or_insert_with(|| PartCoverage {
            project: flow.project.clone(),
            flows: 0,
            related: 0,
            unmapped: 0,
            flows_to_capabilities: 0.0,
            capabilities: states
                .get(&flow.project)
                .cloned()
                .unwrap_or(PartState { capabilities: ABSENT, reason: Some("no caller-initiated flow was read".to_string()) }),
        });
        part.flows += 1;
        if related.contains(flow.id.as_str()) {
            part.related += 1;
            mapped += 1;
        } else {
            part.unmapped += 1;
            unmapped_flows.push(Unmapped { flow: flow.id.clone(), reason: why_unmapped(flow, pending) });
        }
    }
    let mut parts: Vec<PartCoverage> = parts.into_values().collect();
    for part in parts.iter_mut() {
        part.flows_to_capabilities = share_of(part.related, part.flows);
    }
    unmapped_flows.sort_by(|left, right| left.flow.cmp(&right.flow));
    let count = flows.len() as u32;
    Coverage {
        flows: count,
        related: mapped,
        unmapped: count - mapped,
        flows_to_capabilities: share_of(mapped, count),
        parts,
        unmapped_flows,
    }
}

const LISTED_AT_ONCE: usize = 120;
const TOLD_IN_A_LINE: usize = 160;

fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies").filter(|stem| stem.len() > 1) {
        return format!("{stem}y");
    }
    if ["sses", "xes", "ches", "shes"].iter().any(|ending| word.ends_with(ending)) {
        return word[..word.len() - 2].to_string();
    }
    match word.strip_suffix('s') {
        Some(stem) if stem.len() > 2 && !stem.ends_with('s') && !stem.ends_with('u') && !stem.ends_with('i') => {
            stem.to_string()
        }
        _ => word.to_string(),
    }
}

pub(crate) fn name_key(name: &str) -> String {
    name.to_lowercase()
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty() && !matches!(*word, "a" | "an" | "the"))
        .map(singular)
        .collect::<Vec<_>>()
        .join(" ")
}

fn in_a_line(told: &str) -> String {
    let first = told.split_terminator(". ").next().unwrap_or(told).trim();
    match first.char_indices().nth(TOLD_IN_A_LINE) {
        Some((cut, _)) => first[..cut].to_string(),
        None => first.to_string(),
    }
}

fn asked_together(listed: &[usize]) -> Vec<Vec<usize>> {
    if listed.len() <= LISTED_AT_ONCE {
        return vec![listed.to_vec()];
    }
    let halves: Vec<&[usize]> = listed.chunks(LISTED_AT_ONCE / 2).collect();
    let mut asked: Vec<Vec<usize>> = Vec::new();
    for first in 0..halves.len() {
        for second in first + 1..halves.len() {
            asked.push(halves[first].iter().chain(halves[second].iter()).copied().collect());
        }
    }
    asked
}

pub(crate) struct Joined {
    pub(crate) members: Vec<usize>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) audience: String,
}

pub(crate) fn the_same_among(
    listed: &[(String, String)],
    ask: impl Fn(&BTreeMap<String, String>) -> Vec<crate::author::Same> + Sync,
) -> Vec<Joined> {
    let mut leader: Vec<usize> = (0..listed.len()).collect();
    fn found(leader: &mut [usize], at: usize) -> usize {
        let mut current = at;
        while leader[current] != current {
            leader[current] = leader[leader[current]];
            current = leader[current];
        }
        current
    }
    let join = |leader: &mut Vec<usize>, first: usize, second: usize| {
        let (left, right) = (found(leader, first), found(leader, second));
        if left != right {
            leader[left.max(right)] = left.min(right);
        }
    };
    let mut first_named: BTreeMap<String, usize> = BTreeMap::new();
    for (at, (name, _)) in listed.iter().enumerate() {
        let key = name_key(name);
        if key.is_empty() {
            continue;
        }
        match first_named.get(&key).copied() {
            Some(earlier) => join(&mut leader, earlier, at),
            None => {
                first_named.insert(key, at);
            }
        }
    }
    let shown: Vec<usize> = (0..listed.len()).filter(|at| found(&mut leader, *at) == *at).collect();
    let weight = crate::author::weight();
    let answers: Vec<(Vec<usize>, Vec<crate::author::Same>)> = crate::author::asking(|| {
        asked_together(&shown)
            .into_par_iter()
            .filter(|chunk| chunk.len() > 1)
            .map(|chunk| crate::author::weighing(weight, || {
                let offered: BTreeMap<String, String> = chunk
                    .iter()
                    .map(|at| (format!("c{at}"), format!("{} | {}", listed[*at].0.trim(), listed[*at].1)))
                    .collect();
                let said = ask(&offered);
                (chunk, said)
            }))
            .collect()
    });
    let mut named: Vec<(Vec<usize>, String, String, String)> = Vec::new();
    for (chunk, said) in answers {
        for same in said {
            let members: Vec<usize> = same
                .of
                .iter()
                .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
                .filter(|at| chunk.contains(at))
                .collect::<BTreeSet<usize>>()
                .into_iter()
                .collect();
            if members.len() < 2 {
                continue;
            }
            for at in &members[1..] {
                join(&mut leader, members[0], *at);
            }
            named.push((members, same.name.trim().to_string(), same.description.trim().to_string(), same.audience.trim().to_string()));
        }
    }
    let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for at in 0..listed.len() {
        let root = found(&mut leader, at);
        components.entry(root).or_default().push(at);
    }
    components
        .into_values()
        .filter(|members| members.len() > 1)
        .map(|members| {
            let chosen = named
                .iter()
                .filter(|(held, name, _, _)| !name.is_empty() && held.iter().all(|at| members.contains(at)))
                .max_by_key(|(held, _, _, _)| held.len());
            match chosen {
                Some((_, name, description, audience)) => Joined {
                    members,
                    name: name.clone(),
                    description: description.clone(),
                    audience: audience.clone(),
                },
                None => Joined { members, name: String::new(), description: String::new(), audience: String::new() },
            }
        })
        .collect()
}

const SURFACES_COMPARED: usize = 4;
const RECORDS_COMPARED: usize = 3;

fn reached_by(capability: &Capability) -> String {
    let surfaces: Vec<&str> = capability.surfaces.iter().take(SURFACES_COMPARED).map(String::as_str).collect();
    let records: Vec<&str> = capability.records.iter().take(RECORDS_COMPARED).map(String::as_str).collect();
    let mut told = Vec::new();
    if !surfaces.is_empty() {
        told.push(format!("reached through {}", surfaces.join(", ")));
    }
    if !records.is_empty() {
        told.push(format!("changes {}", records.join(", ")));
    }
    match told.is_empty() {
        true => String::new(),
        false => format!(" ({})", told.join("; ")),
    }
}

const NEAR_FLOW_SHARE: f64 = 0.5;

fn near_in_flows(left: &[String], right: &[String]) -> bool {
    let shared = left.iter().filter(|flow| right.contains(flow)).count();
    let smaller = left.len().min(right.len());
    smaller >= 1 && shared as f64 >= NEAR_FLOW_SHARE * smaller as f64
}

fn near_duplicates(capabilities: &[Capability]) -> Vec<usize> {
    let mut near: BTreeSet<usize> = BTreeSet::new();
    for first in 0..capabilities.len() {
        for second in first + 1..capabilities.len() {
            if near_in_flows(&capabilities[first].flows, &capabilities[second].flows) {
                near.insert(first);
                near.insert(second);
            }
        }
    }
    near.into_iter().collect()
}

fn united(groups: Vec<Joined>) -> Vec<Joined> {
    let mut united: Vec<Joined> = Vec::new();
    for group in groups {
        let mut group = group;
        while let Some(at) = united.iter().position(|held| held.members.iter().any(|member| group.members.contains(member))) {
            let held = united.remove(at);
            let (keeper, other) = if held.members.len() >= group.members.len() { (held, group) } else { (group, held) };
            let mut members = keeper.members.clone();
            members.extend(other.members.iter().copied().filter(|member| !keeper.members.contains(member)));
            members.sort_unstable();
            group = Joined { members, ..keeper };
        }
        united.push(group);
    }
    united
}

pub(crate) fn which_are_the_same(capabilities: &[Capability], said: &str) -> Vec<Joined> {
    groups_of_the_same(capabilities, |offered| crate::author::same_capability(said, offered))
}

fn groups_of_the_same(
    capabilities: &[Capability],
    ask: impl Fn(&BTreeMap<String, String>) -> Vec<crate::author::Same> + Sync,
) -> Vec<Joined> {
    if capabilities.len() < 2 {
        return Vec::new();
    }
    let listed: Vec<(String, String)> = capabilities
        .iter()
        .map(|capability| {
            (
                capability.name.clone().unwrap_or_default(),
                format!(
                    "{}{}",
                    in_a_line(capability.description.as_deref().unwrap_or_default()),
                    reached_by(capability)
                ),
            )
        })
        .collect();
    let near = near_duplicates(capabilities);
    let narrowed: Vec<(String, String)> = near.iter().map(|at| listed[*at].clone()).collect();
    let (groups, again) = rayon::join(
        || the_same_among(&listed, &ask),
        || match near.len() > 1 {
            true => the_same_among(&narrowed, &ask),
            false => Vec::new(),
        },
    );
    let again = again.into_iter().map(|joined| Joined {
        members: joined.members.into_iter().map(|at| near[at]).collect(),
        ..joined
    });
    let groups = match near.len() > 1 {
        true => united(groups.into_iter().chain(again).collect()),
        false => groups,
    };
    groups
}

pub(crate) fn merge_the_same(capabilities: &mut Vec<Capability>, groups: Vec<Joined>) {
    if groups.is_empty() {
        return;
    }
    let mut slots: Vec<Option<Capability>> = std::mem::take(capabilities).into_iter().map(Some).collect();
    let mut kept: Vec<Capability> = Vec::new();
    for group in groups {
        let keeper = group
            .members
            .iter()
            .copied()
            .max_by_key(|at| (slots[*at].as_ref().map_or(0, |held| held.flows.len()), std::cmp::Reverse(*at)))
            .unwrap_or(group.members[0]);
        let Some(mut together) = slots[keeper].take() else { continue };
        let mut merged_names: Vec<String> = vec![together.name.clone().unwrap_or_default()];
        for at in &group.members {
            if let Some(other) = slots[*at].take() {
                merged_names.push(other.name.clone().unwrap_or_default());
                crate::comprehend::joined(&mut together, other);
            }
        }
        if !group.name.is_empty() {
            together.id = format!("capability:{}", carved_name(&group.name));
            together.name = Some(group.name.clone());
        }
        if !group.description.is_empty() {
            together.description = Some(group.description.clone());
        }
        if !group.audience.is_empty() {
            together.audience = Some(group.audience.to_ascii_lowercase());
        }
        eprintln!(
            "  one of each: {} <- {}",
            together.name.as_deref().unwrap_or(""),
            merged_names.join(" | ")
        );
        kept.push(together);
    }
    kept.extend(slots.into_iter().flatten());
    let mut unique: Vec<Capability> = Vec::new();
    for capability in kept {
        match unique.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => crate::comprehend::joined(held, capability),
            None => unique.push(capability),
        }
    }
    unique.sort_by(|left, right| left.id.cmp(&right.id));
    *capabilities = unique;
}

#[cfg(test)]
mod command_family_tests {
    use super::*;

    fn flow(id: &str, kind: &'static str, method: Option<&str>, operation: &str, writes: &[&str], reads: &[&str]) -> Flow {
        Flow {
            summary: String::new(),
            writes: writes.iter().map(|held| held.to_string()).collect(),
            reads: reads.iter().map(|held| held.to_string()).collect(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind,
            method: method.map(str::to_string),
            operation: operation.to_string(),
            surface: None,
            plays: None,
            standing: "terminal",
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
            project: None,
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capabilities: Vec::new(),
        }
    }

    #[test]
    fn a_directory_whose_work_is_almost_all_programs_nothing_ships_is_tooling_though_one_product_flow_starts_there() {
        let in_directory = |id: &str, directory: &str, units: u32, aside: bool| {
            let mut held = flow(id, "lifecycle", None, id, &[], &[]);
            held.path = vec![crate::comprehend::Step { unit: format!("{directory}/{id}.ts:function:main"), depth: 0, leaves: Vec::new() }];
            held.units = units;
            held.unshipped = aside.then(|| crate::entry_exit::Unshipped { role: "benchmark", basis: "shipping-evidence", evidence: String::new() });
            held
        };
        let flows = vec![
            in_directory("sweep", "src/bench", 1000, true),
            in_directory("watch", "src/bench", 40, false),
            in_directory("serve", "src/app", 300, false),
            in_directory("tool", "src/app", 400, true),
        ];
        let tooling = crate::comprehend::tooling_directories(&flows);
        assert!(tooling.contains("src/bench"));
        assert!(!tooling.contains("src/app"));
    }

    #[test]
    fn capabilities_that_mostly_share_their_flows_are_near_duplicates() {
        let flows = |ids: &[&str]| -> Vec<String> { ids.iter().map(|id| id.to_string()).collect() };
        assert!(near_in_flows(&flows(&["a", "b", "c"]), &flows(&["b", "c", "d", "e"])));
        assert!(!near_in_flows(&flows(&["a", "b", "c"]), &flows(&["c", "d", "e"])));
        assert!(near_in_flows(&flows(&["a"]), &flows(&["a", "b"])));
        assert!(!near_in_flows(&flows(&["a"]), &flows(&["b"])));
    }

    #[test]
    fn a_group_found_twice_is_united_with_the_larger_naming_it() {
        let group = |members: &[usize], name: &str| Joined {
            members: members.to_vec(),
            name: name.to_string(),
            description: String::new(),
            audience: String::new(),
        };
        let united = united(vec![group(&[0, 1], "Pair"), group(&[1, 2, 3], "Trio"), group(&[5, 6], "Apart")]);
        assert_eq!(united.len(), 2);
        let trio = united.iter().find(|held| held.name == "Trio").unwrap();
        assert_eq!(trio.members, vec![0, 1, 2, 3]);
    }

    #[test]
    fn product_surfaces_rank_before_programs_and_what_programs_alone_run() {
        let mut route = flow("flow:route", "http", Some("POST"), "/v1/analyze", &[], &[]);
        route.units = 10;
        let mut program = flow("flow:main", "lifecycle", None, "main", &[], &[]);
        program.units = 500;
        let mut benchmark = flow("flow:bench", "tool", None, "run_benchmark", &[], &[]);
        benchmark.units = 900;
        benchmark.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "reaches-only-program-code", evidence: String::new() });
        let mut orient = flow("flow:orient", "tool", None, "get_start_context", &[], &[]);
        orient.units = 50;
        let mut obscure = flow("flow:obscure", "tool", None, "do_something_rare", &[], &[]);
        obscure.units = 400;
        let pointed_to: rustc_hash::FxHashMap<String, usize> = [("flow:orient".to_string(), 5)].into_iter().collect();
        let mut flows = vec![benchmark, program, route, obscure, orient];
        crate::comprehend::rank_flows(&mut flows, &pointed_to);
        let rank_of = |id: &str| flows.iter().find(|held| held.id == id).map(|held| held.rank);
        assert_eq!(
            (rank_of("flow:route"), rank_of("flow:orient"), rank_of("flow:obscure"), rank_of("flow:main"), rank_of("flow:bench")),
            (Some(2), Some(1), Some(3), Some(4), Some(5))
        );
    }

    #[test]
    fn coverage_withholds_no_flow_and_gives_each_unmapped_one_its_reason() {
        let served = flow("flow:1", "http", Some("GET"), "/a", &[], &[]);
        let hook = flow("flow:2", "event", None, "SIGTERM", &[], &[]);
        let mut tooling = flow("flow:3", "lifecycle", None, "main", &[], &[]);
        tooling.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "shipping-evidence", evidence: String::new() });
        let reading = flow("flow:4", "event", None, "data", &[], &["orders"]);
        let waiting = flow("flow:5", "http", Some("GET"), "/b", &[], &["orders"]);
        let pending = BTreeSet::from(["flow:5".to_string()]);
        let covered = coverage_of(&[served, hook, tooling, reading, waiting], &[], &BTreeMap::new(), &pending);
        assert_eq!((covered.flows, covered.unmapped), (5, 5));
        let ids: Vec<&str> = covered.unmapped_flows.iter().map(|held| held.flow.as_str()).collect();
        assert_eq!(ids, vec!["flow:1", "flow:2", "flow:3", "flow:4", "flow:5"]);
        let reason = |id: &str| covered.unmapped_flows.iter().find(|held| held.flow == id).map(|held| held.reason.clone()).unwrap_or_default();
        assert_eq!(reason("flow:1"), "no capability of its part delivers or supports it", "a flow outside every capability is a plain fact, not a failure to explain away");
        assert_eq!(reason("flow:5"), "the AI gave no answer for its part");
    }

}

#[cfg(test)]
mod one_of_each_tests {
    use super::*;

    fn listed(names: &[String]) -> Vec<(String, String)> {
        names.iter().map(|name| (name.clone(), format!("Someone gets {name}."))).collect()
    }

    fn synonyms_asked(offered: &BTreeMap<String, String>) -> Vec<crate::author::Same> {
        let links = offered.iter().find(|(_, told)| told.starts_with("Open external links |"));
        let urls = offered.iter().find(|(_, told)| told.starts_with("Open external URLs |"));
        match (links, urls) {
            (Some((first, _)), Some((second, _))) => vec![crate::author::Same {
                of: vec![first.clone(), second.clone()],
                name: "Open external links".to_string(),
                description: "Opens links outside the app.".to_string(),
                audience: "user".to_string(),
            }],
            _ => Vec::new(),
        }
    }

    #[test]
    fn a_name_key_ignores_case_punctuation_articles_and_plurals() {
        assert_eq!(name_key("Open External Links."), name_key("open an external link"));
        assert_eq!(name_key("Manage Categories"), name_key("manage category"));
        assert_eq!(name_key("Track the process"), name_key("track processes"));
        assert_ne!(name_key("Sign in"), name_key("Sign out"));
    }

    #[test]
    fn the_same_normalized_name_is_merged_without_asking() {
        let names = vec!["Configure engine environment".to_string(), "Delete a post".to_string(), "configure Engine environments!".to_string()];
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let groups = the_same_among(&listed(&names), |offered| {
            asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            assert_eq!(offered.len(), 2, "a name already merged is listed once: {offered:?}");
            Vec::new()
        });
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![0, 2]);
    }

    #[test]
    fn a_synonym_pair_planted_in_different_chunks_comes_out_as_one() {
        let mut names: Vec<String> = (0..300).map(|at| format!("Distinct capability {at}")).collect();
        names[5] = "Open external links".to_string();
        names[280] = "Open external URLs".to_string();
        let items = listed(&names);
        assert!(asked_together(&(0..300).collect::<Vec<_>>()).iter().all(|chunk| chunk.len() <= LISTED_AT_ONCE));
        let groups = the_same_among(&items, synonyms_asked);
        assert_eq!(groups.len(), 1, "exactly the planted pair merges");
        assert_eq!(groups[0].members, vec![5, 280]);
        assert_eq!(groups[0].name, "Open external links");
    }

    #[test]
    fn every_pair_is_asked_together_at_least_once() {
        let shown: Vec<usize> = (0..400).collect();
        let chunks = asked_together(&shown);
        for first in (0..400).step_by(37) {
            for second in (0..400).step_by(41) {
                assert!(chunks.iter().any(|chunk| chunk.contains(&first) && chunk.contains(&second)), "{first} and {second}");
            }
        }
    }

    #[test]
    fn names_that_are_not_the_same_stay_apart_when_nothing_is_said_the_same() {
        let names = vec!["Sign in".to_string(), "Sign out".to_string(), "Delete a post".to_string()];
        assert!(the_same_among(&listed(&names), |_| Vec::new()).is_empty());
    }
}

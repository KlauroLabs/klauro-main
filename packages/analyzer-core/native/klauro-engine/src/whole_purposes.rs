use rustc_hash::FxHashMap as HashMap;

use crate::capabilities::{Joined, PART, WHOLE};
use crate::comprehend::{carved_name, Capability, Delivery, Flow};

const DELIVERS: &str = "primary";
const SUPPORTS: &str = "supporting";

pub(crate) struct Reach {
    pub candidates: Vec<usize>,
    pub journeys: Vec<(Option<usize>, Vec<usize>)>,
}

fn share(capability: &Capability) -> f64 {
    capability.value.as_ref().map_or(0.0, |value| value.share)
}

pub(crate) fn reach(capabilities: &[Capability], journeys: &[Flow]) -> Reach {
    let mut delivered_by: HashMap<&str, usize> = HashMap::default();
    for (at, capability) in capabilities.iter().enumerate().filter(|(_, capability)| capability.level == PART && !capability.supporting) {
        for delivered in capability.delivered.iter().filter(|delivered| delivered.role == DELIVERS) {
            let held = delivered_by.entry(delivered.flow.as_str()).or_insert(at);
            if share(capability) > share(&capabilities[*held]) {
                *held = at;
            }
        }
    }
    let journeys: Vec<(Option<usize>, Vec<usize>)> = journeys
        .iter()
        .map(|journey| {
            let members: Vec<&str> = journey.steps.iter().flat_map(|step| step.lands_in.iter().map(String::as_str)).collect();
            let mut reached: Vec<usize> = Vec::new();
            for at in members.iter().filter_map(|member| delivered_by.get(member).copied()) {
                if !reached.contains(&at) {
                    reached.push(at);
                }
            }
            let start = members.first().and_then(|first| delivered_by.get(first).copied());
            let lead = start.or_else(|| reached.iter().copied().max_by(|left, right| share(&capabilities[*left]).total_cmp(&share(&capabilities[*right])).then(right.cmp(left))));
            (lead, reached)
        })
        .collect();
    let mut candidates: Vec<usize> = journeys.iter().flat_map(|(_, reached)| reached.iter().copied()).collect();
    candidates.sort_unstable();
    candidates.dedup();
    Reach { candidates, journeys }
}

pub(crate) fn grouped(count: usize, joined: Vec<Joined>) -> Vec<Vec<usize>> {
    let mut groups: Vec<Vec<usize>> = joined.into_iter().map(|group| group.members).collect();
    let placed: Vec<usize> = groups.iter().flatten().copied().collect();
    groups.extend((0..count).filter(|at| !placed.contains(at)).map(|at| vec![at]));
    groups.sort();
    groups
}

fn told(opening: &str, members: &[&Capability], part_names: &HashMap<String, String>) -> String {
    let part = |capability: &Capability| capability.project.as_deref().map(|part| part_names.get(part).map(String::as_str).unwrap_or(part)).unwrap_or("the repository").to_string();
    let capabilities: Vec<String> = members
        .iter()
        .map(|capability| format!("- {} ({}): {}", capability.name.as_deref().unwrap_or_default(), part(capability), capability.description.as_deref().unwrap_or_default()))
        .collect();
    format!("{opening}\n\nCapabilities:\n{}", capabilities.join("\n"))
}

fn united(members: &[&Capability], of: impl Fn(&Capability) -> &Vec<String>) -> Vec<String> {
    let mut held: Vec<String> = members.iter().flat_map(|member| of(member).iter().cloned()).collect();
    held.sort();
    held.dedup();
    held
}

pub(crate) fn formed(members: &[&Capability], answer: &serde_json::Value, delivered: Vec<Delivery>) -> Capability {
    let name = answer["name"].as_str().unwrap_or_default().trim().to_string();
    let mut whole = members[0].clone();
    whole.id = format!("capability:whole:{}", carved_name(&name));
    whole.name = Some(name);
    whole.description = answer["outcome"].as_str().map(|outcome| outcome.trim().to_string());
    whole.audience = answer["audience"].as_str().map(|audience| audience.trim().to_ascii_lowercase()).filter(|audience| !audience.is_empty());
    whole.flows = delivered.iter().filter(|delivery| delivery.role == DELIVERS).map(|delivery| delivery.flow.clone()).collect();
    whole.delivered = delivered;
    whole.records = united(members, |member| &member.records);
    whole.changes = united(members, |member| &member.changes);
    whole.surfaces = united(members, |member| &member.surfaces);
    whole.touches = united(members, |member| &member.touches);
    whole.drawn_from = members.iter().map(|member| member.id.clone()).collect();
    whole.project = None;
    whole.also_in.clear();
    whole.supporting = false;
    whole.grounding = None;
    whole.level = WHOLE;
    whole.terminality = None;
    whole.confidence = None;
    whole.unsettled = None;
    whole.offers.clear();
    whole.used_in.clear();
    whole.keeps.clear();
    whole.reads.clear();
    whole.keeps_through.clear();
    whole.reads_through.clear();
    whole.low_weight = false;
    whole.value = None;
    whole.evidence.clear();
    whole
}

pub(crate) fn deliveries(group: &[usize], candidates: &[usize], journeys: &[Flow], reach: &[(Option<usize>, Vec<usize>)]) -> Vec<Delivery> {
    let held = |at: &usize| group.iter().any(|member| candidates[*member] == *at);
    journeys
        .iter()
        .zip(reach)
        .filter_map(|(journey, (lead, reached))| {
            let role = match (lead.as_ref().is_some_and(held), reached.iter().any(held)) {
                (true, _) => DELIVERS,
                (false, true) => SUPPORTS,
                (false, false) => return None,
            };
            Some(Delivery { flow: journey.id.clone(), role, rationale: String::new(), unshipped: None })
        })
        .collect()
}

pub(crate) fn of(capabilities: &[Capability], journeys: &[Flow], said: &str, opening: &str, part_names: &HashMap<String, String>) -> Vec<Capability> {
    let reach = reach(capabilities, journeys);
    if reach.candidates.is_empty() {
        return Vec::new();
    }
    let compared: Vec<Capability> = reach.candidates.iter().map(|at| capabilities[*at].clone()).collect();
    let groups = grouped(compared.len(), crate::capabilities::which_are_the_same(&compared, said));
    let asking: Vec<(String, String)> = groups
        .iter()
        .map(|group| {
            let members: Vec<&Capability> = group.iter().map(|member| &compared[*member]).collect();
            (members.iter().map(|member| member.id.as_str()).collect::<Vec<_>>().join("|"), told(opening, &members, part_names))
        })
        .collect();
    let holds = |_: &str, answer: &serde_json::Value| crate::author::what_is_wrong_with_a_whole_capability(answer).is_none();
    let answers = crate::memory::each_holding("whole capability", crate::author::WHOLE_CAPABILITY_ASKED, &asking, holds, |missing| {
        crate::author::asking(|| {
            use rayon::prelude::*;
            missing.par_iter().filter_map(|(id, prompt)| crate::author::whole_capability_of(prompt).map(|answer| (id.clone(), answer))).collect()
        })
    });
    let mut whole: Vec<Capability> = Vec::new();
    for (group, (key, _)) in groups.iter().zip(&asking) {
        let members: Vec<&Capability> = group.iter().map(|member| &compared[*member]).collect();
        let Some(answer) = answers.get(key) else {
            eprintln!("  not named, so not a capability of the whole: {}", members.iter().filter_map(|member| member.name.as_deref()).collect::<Vec<_>>().join(" | "));
            continue;
        };
        let formed = formed(&members, answer, deliveries(group, &reach.candidates, journeys, &reach.journeys));
        eprintln!("  whole: {} <- {}", formed.name.as_deref().unwrap_or_default(), members.iter().filter_map(|member| member.name.as_deref()).collect::<Vec<_>>().join(" | "));
        match whole.iter_mut().find(|held| held.id == formed.id) {
            Some(held) => {
                let drawn = formed.drawn_from.clone();
                crate::comprehend::joined(held, formed);
                held.drawn_from.extend(drawn);
                held.drawn_from.sort();
                held.drawn_from.dedup();
            }
            None => whole.push(formed),
        }
    }
    whole.sort_by(|left, right| left.id.cmp(&right.id));
    whole
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability(id: &str, delivers: &[&str], records: &[&str], share: f64) -> Capability {
        Capability {
            id: id.to_string(),
            audience: None,
            delivered: delivers.iter().map(|flow| Delivery { flow: flow.to_string(), role: DELIVERS, rationale: String::new(), unshipped: None }).collect(),
            records: records.iter().map(|held| held.to_string()).collect(),
            changes: Vec::new(),
            flows: delivers.iter().map(|flow| flow.to_string()).collect(),
            surfaces: Vec::new(),
            project: Some("shop".to_string()),
            also_in: Vec::new(),
            supporting: false,
            name: Some(id.to_string()),
            description: None,
            grounding: None,
            standing: crate::comprehend::PUBLISHED,
            level: PART,
            touches: records.iter().map(|held| held.to_string()).collect(),
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
            value: Some(crate::value::Value { own: 1.0, centrality: 1.0, position: 1.0, impact: share, share }),
            evidence: String::new(),
        }
    }

    fn journey(id: &str, crosses: &[&str]) -> Flow {
        Flow {
            summary: String::new(),
            writes: Vec::new(),
            reads: Vec::new(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind: "http",
            method: None,
            operation: id.to_string(),
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
            steps: crosses
                .iter()
                .enumerate()
                .map(|(at, flow)| crate::steps::LogicalStep { id: format!("s{at}"), kind: "do", label: flow.to_string(), object: None, doing: None, when: "always", arms: Vec::new(), regions: Vec::new(), description: None, lands_in: vec![flow.to_string()], gathers: Vec::new() })
                .collect(),
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
            value: None,
        }
    }

    #[test]
    fn a_journey_leads_to_what_its_first_flow_delivers_and_reaches_everything_its_flows_deliver_but_supporting_work() {
        let mut sign_in = capability("sign-in", &["login"], &[], 0.0);
        sign_in.supporting = true;
        let held = vec![capability("place-orders", &["checkout"], &["Order"], 0.5), capability("take-payment", &["pay"], &["Payment"], 0.3), sign_in];
        let journeys = vec![journey("journey:checkout", &["login", "checkout", "pay"]), journey("journey:pay", &["pay"])];
        let found = reach(&held, &journeys);
        assert_eq!(found.candidates, vec![0, 1]);
        assert_eq!(found.journeys[0], (Some(0), vec![0, 1]), "supporting work at the start does not lead the journey");
        assert_eq!(found.journeys[1], (Some(1), vec![1]));
    }

    #[test]
    fn every_capability_reached_is_in_exactly_one_group_and_those_found_the_same_share_one() {
        let joined = vec![Joined { members: vec![0, 2], name: String::new(), description: String::new(), audience: String::new() }];
        assert_eq!(grouped(4, joined), vec![vec![0, 2], vec![1], vec![3]]);
    }

    #[test]
    fn a_whole_capability_is_delivered_by_the_journeys_it_leads_and_supported_by_those_that_only_pass_through() {
        let held = vec![capability("place-orders", &["checkout"], &["Order"], 0.5), capability("take-payment", &["pay"], &["Payment"], 0.3)];
        let journeys = vec![journey("journey:checkout", &["checkout", "pay"]), journey("journey:pay", &["pay"])];
        let found = reach(&held, &journeys);
        let paying = deliveries(&[1], &found.candidates, &journeys, &found.journeys);
        assert_eq!(paying.iter().map(|delivery| (delivery.flow.as_str(), delivery.role)).collect::<Vec<_>>(), [("journey:checkout", SUPPORTS), ("journey:pay", DELIVERS)]);
        let members: Vec<&Capability> = held.iter().collect();
        let whole = formed(&members, &serde_json::json!({"name": "Buy books", "outcome": "People buy books.", "audience": "Shoppers"}), paying);
        assert_eq!(whole.id, "capability:whole:buy-books");
        assert_eq!(whole.level, WHOLE);
        assert_eq!(whole.drawn_from, ["place-orders", "take-payment"]);
        assert_eq!(whole.records, ["Order", "Payment"]);
        assert_eq!(whole.flows, ["journey:pay"]);
        assert!(whole.project.is_none() && whole.value.is_none());
    }

    #[test]
    fn a_name_longer_than_six_words_or_without_an_outcome_is_refused() {
        assert!(crate::author::what_is_wrong_with_a_whole_capability(&serde_json::json!({"name": "Buy books", "outcome": "People buy books."})).is_none());
        assert!(crate::author::what_is_wrong_with_a_whole_capability(&serde_json::json!({"name": "Buy and sell and trade many old books", "outcome": "x"})).is_some());
        assert!(crate::author::what_is_wrong_with_a_whole_capability(&serde_json::json!({"name": "Buy books", "outcome": " "})).is_some());
    }
}

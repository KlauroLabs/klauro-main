use std::collections::VecDeque;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::comprehend::{Flow, Step};
use crate::seams::Seam;
use crate::steps::LogicalStep;

static FEEDS_THE_PRODUCT: &[&str] = &["app", "website", "service", "app backend", "tool", "orchestrator"];
static TOOLING: &[&str] = &["tooling", "test suite", "unused"];

pub struct Parts<'a> {
    pub names: &'a HashMap<String, String>,
    pub roles: &'a HashMap<String, &'static str>,
    pub consumers: &'a HashMap<String, Vec<String>>,
}

pub struct Journeys {
    pub product: Vec<Flow>,
    pub tooling: Vec<Flow>,
}

fn home(flow: &Flow) -> Option<&str> {
    flow.runs_in.as_deref().or(flow.project.as_deref())
}

fn tooling(flow: &Flow, parts: &Parts) -> bool {
    crate::unshipped::is_set_aside(flow.unshipped.as_ref())
        || home(flow).and_then(|part| parts.roles.get(part)).is_some_and(|role| TOOLING.contains(role))
}

fn starts(flow: &Flow, parts: &Parts) -> bool {
    let feeds = |part: &str| parts.roles.get(part).is_some_and(|role| FEEDS_THE_PRODUCT.contains(role) || TOOLING.contains(role));
    let served_by_a_program = |part: &str| parts.consumers.get(part).is_some_and(|consumers| consumers.iter().any(|consumer| parts.roles.get(consumer.as_str()).is_some_and(|role| FEEDS_THE_PRODUCT.contains(role))));
    crate::entry_exit::USER_FACING.contains(&flow.kind) && home(flow).is_some_and(|part| feeds(part) || served_by_a_program(part))
}

pub fn of(flows: &[Flow], seams: &[Seam], parts: &Parts) -> Journeys {
    let at: HashMap<&str, usize> = flows.iter().enumerate().map(|(at, flow)| (flow.id.as_str(), at)).collect();
    let mut onward: HashMap<usize, Vec<(usize, &Seam)>> = HashMap::default();
    for seam in seams {
        let Some(from) = at.get(seam.from_flow.as_str()).copied() else { continue };
        for to in seam.to_flows.iter().filter_map(|to| at.get(to.as_str()).copied()) {
            if to != from {
                onward.entry(from).or_default().push((to, seam));
            }
        }
    }
    let chain = |start: usize| -> Vec<(usize, Option<&Seam>)> {
        let mut seen: HashSet<usize> = HashSet::from_iter([start]);
        let mut held: Vec<(usize, Option<&Seam>)> = vec![(start, None)];
        let mut queue: VecDeque<usize> = VecDeque::from([start]);
        while let Some(current) = queue.pop_front() {
            for (to, seam) in onward.get(&current).into_iter().flatten() {
                if seen.insert(*to) {
                    held.push((*to, Some(*seam)));
                    queue.push_back(*to);
                }
            }
        }
        held
    };
    let candidates: Vec<usize> = (0..flows.len()).filter(|at| starts(&flows[*at], parts)).collect();
    let reached_from_elsewhere: HashSet<usize> = candidates
        .iter()
        .flat_map(|start| chain(*start).into_iter().skip(1).map(|(at, _)| at).collect::<Vec<_>>())
        .filter(|at| candidates.contains(at))
        .collect();
    let mut product = Vec::new();
    let mut held_tooling = Vec::new();
    for start in candidates.into_iter().filter(|at| !reached_from_elsewhere.contains(at)) {
        let journey = journey_of(flows, &chain(start), parts);
        match tooling(&flows[start], parts) {
            true => held_tooling.push(marked_as_tooling(journey, parts)),
            false => product.push(journey),
        }
    }
    Journeys { product, tooling: held_tooling }
}

fn journey_of(flows: &[Flow], chain: &[(usize, Option<&Seam>)], parts: &Parts) -> Flow {
    let start = &flows[chain[0].0];
    let mut journey = start.clone();
    journey.id = format!("journey:{}", start.id);
    journey.runs_in = None;
    journey.capabilities = Vec::new();
    journey.leads_into = Vec::new();
    journey.step_edges = Vec::new();
    journey.path = Vec::new();
    journey.steps = Vec::new();
    for (number, (at, seam)) in chain.iter().enumerate() {
        let member = &flows[*at];
        let part = home(member).map(|part| parts.names.get(part).map(String::as_str).unwrap_or(part)).unwrap_or("the repository");
        let named = member.name.as_deref().unwrap_or(&member.operation);
        let via = seam.map(|seam| format!(" ({} {})", seam.by, seam.carries)).unwrap_or_default();
        journey.steps.push(LogicalStep {
            id: format!("s{}", number + 1),
            kind: if seam.is_some() { "hand_off" } else { "do" },
            label: format!("{part}: {named}{via}"),
            object: None,
            doing: None,
            when: "always",
            arms: Vec::new(),
            regions: member.steps.iter().flat_map(|step| step.regions.iter().cloned()).collect(),
            description: None,
            lands_in: vec![member.id.clone()],
            gathers: Vec::new(),
            contract: None,
        });
        journey.path.extend(member.path.first().map(|first| Step { unit: first.unit.clone(), depth: number as u32, leaves: Vec::new() }));
        if number == 0 {
            continue;
        }
        for (into, from) in [(&mut journey.writes, &member.writes), (&mut journey.reads, &member.reads), (&mut journey.changes, &member.changes), (&mut journey.takes, &member.takes), (&mut journey.reaches, &member.reaches)] {
            for held in from {
                if !into.contains(held) {
                    into.push(held.clone());
                }
            }
        }
        journey.units += member.units;
        journey.confidence = journey.confidence.min(member.confidence);
        if member.standing == "terminal" {
            journey.standing = "terminal";
        }
    }
    journey.reads.retain(|held| !journey.writes.contains(held));
    journey
}

fn told(journey: &Flow, opening: &str, flows: &HashMap<&str, &Flow>, children: &crate::child_layers::Children) -> String {
    let mut lines = Vec::new();
    if !opening.is_empty() {
        lines.push(format!("The system describes itself: {opening}"));
    }
    lines.push(format!("Reached through: {} {}", journey.kind, journey.surface.as_deref().unwrap_or(&journey.operation)));
    if let Some(start) = journey.steps.first().and_then(|step| step.lands_in.first()).and_then(|member| flows.get(member.as_str())) {
        lines.push(format!("Asked for at the start: {} — {}", start.name.as_deref().unwrap_or(&start.operation), start.description.as_deref().unwrap_or_default()));
    }
    for step in &journey.steps {
        let layer = step.lands_in.first().and_then(|member| flows.get(member.as_str())).map(|flow| format!("\n    the part's flow here: {}", children.of_flow(flow))).unwrap_or_default();
        lines.push(format!("{}: {}{layer}", step.id, step.label));
    }
    format!("{}\n\n{}", lines.join("\n"), crate::author::JOURNEY_ASKED)
}

pub fn named(journeys: &mut [Flow], flows: &[Flow], opening: &str, children: &crate::child_layers::Children) {
    let by_id: HashMap<&str, &Flow> = flows.iter().map(|flow| (flow.id.as_str(), flow)).collect();
    let asking: Vec<(String, String)> = journeys
        .iter()
        .filter(|journey| journey.steps.len() > 1)
        .map(|journey| (journey.id.clone(), told(journey, opening, &by_id, children)))
        .collect();
    let steps_of: HashMap<String, Vec<String>> = journeys.iter().map(|journey| (journey.id.clone(), journey.steps.iter().map(|step| step.id.clone()).collect())).collect();
    let holds = |id: &str, answer: &serde_json::Value| {
        let steps: Vec<&str> = steps_of.get(id).into_iter().flatten().map(String::as_str).collect();
        crate::author::what_is_wrong_with_behaviours(answer, &steps).is_none()
    };
    let answers = crate::memory::each_holding("journey behaviours", crate::author::JOURNEY_ASKED, &asking, holds, |missing| {
        crate::author::asking(|| {
            use rayon::prelude::*;
            missing
                .par_iter()
                .filter_map(|(id, prompt)| {
                    let steps: Vec<&str> = steps_of.get(id).into_iter().flatten().map(String::as_str).collect();
                    let before = crate::memory::last::<serde_json::Value>("journey behaviours", crate::author::JOURNEY_ASKED, id);
                    crate::author::behaviours_of(&crate::author::with_before(prompt, before.as_ref().and_then(crate::author::behaviours_before)), &steps).map(|answer| (id.clone(), answer))
                })
                .collect()
        })
    });
    for journey in journeys.iter_mut() {
        let Some(behaviour) = answers.get(&journey.id).and_then(|answer| answer["behaviours"].as_array()).and_then(|held| held.first()) else { continue };
        if let Some(name) = behaviour["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) {
            journey.name = Some(name.to_string());
        }
        if let Some(outcome) = behaviour["outcome"].as_str().map(str::trim).filter(|outcome| !outcome.is_empty()) {
            journey.description = Some(outcome.to_string());
        }
        let said: Vec<(Vec<String>, String)> = behaviour["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|step| {
                let ids = step["ids"].as_array().into_iter().flatten().filter_map(|id| id.as_str().map(str::to_string)).collect();
                (ids, step["said"].as_str().unwrap_or_default().trim().to_string())
            })
            .collect();
        journey.steps = gathered(std::mem::take(&mut journey.steps), &said);
    }
}

fn gathered(steps: Vec<LogicalStep>, said: &[(Vec<String>, String)]) -> Vec<LogicalStep> {
    let lead_of: HashMap<&str, &str> = said
        .iter()
        .flat_map(|(ids, _)| ids.iter().skip(1).filter_map(|other| Some((other.as_str(), ids.first()?.as_str()))))
        .collect();
    let said_of: HashMap<&str, &str> = said.iter().filter_map(|(ids, words)| Some((ids.first()?.as_str(), words.as_str()))).collect();
    let mut out: Vec<LogicalStep> = Vec::new();
    for mut step in steps {
        if let Some(lead) = lead_of.get(step.id.as_str()).filter(|lead| **lead != step.id.as_str())
            && let Some(into) = out.iter_mut().find(|held| held.id == *lead)
        {
            if into.gathers.is_empty() {
                into.gathers.push(into.label.clone());
            }
            into.gathers.push(step.label.clone());
            into.regions.extend(step.regions);
            into.lands_in.extend(step.lands_in);
            continue;
        }
        if let Some(words) = said_of.get(step.id.as_str()).filter(|words| !words.is_empty()) {
            step.description = Some((*words).to_string());
        }
        out.push(step);
    }
    out
}

fn marked_as_tooling(mut journey: Flow, parts: &Parts) -> Flow {
    if journey.unshipped.is_none() {
        let part = home(&journey).unwrap_or_default().to_string();
        let role = parts.roles.get(&part).copied().unwrap_or("tooling");
        let named = parts.names.get(&part).cloned().unwrap_or_else(|| part.clone());
        journey.unshipped = Some(crate::entry_exit::Unshipped { role, basis: "part-role", evidence: format!("starts in {named}") });
    }
    journey
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Weight {
    Supporting,
    Valued(f64),
}

impl Weight {
    pub fn said(&self) -> String {
        match self {
            Weight::Supporting => "supporting work".to_string(),
            Weight::Valued(share) => format!("{:.0}% of its part's value", share * 100.0),
        }
    }

    fn worth(&self) -> f64 {
        match self {
            Weight::Supporting => -1.0,
            Weight::Valued(share) => *share,
        }
    }
}

pub(crate) fn weight_of(capability: &crate::comprehend::Capability) -> Option<Weight> {
    match (capability.supporting, capability.value.as_ref()) {
        (true, _) => Some(Weight::Supporting),
        (false, Some(value)) => Some(Weight::Valued(value.share)),
        (false, None) => None,
    }
}

pub fn weights<'a>(capabilities: &[crate::comprehend::Capability], journeys: impl Iterator<Item = &'a Flow>) -> HashMap<String, Weight> {
    let mut weight_of_flow: HashMap<&str, Weight> = HashMap::default();
    for capability in capabilities.iter().filter(|capability| capability.level == crate::capabilities::PART) {
        let Some(weight) = weight_of(capability) else { continue };
        for delivered in capability.delivered.iter().filter(|delivered| delivered.role == "primary") {
            let held = weight_of_flow.entry(delivered.flow.as_str()).or_insert(weight);
            if weight.worth() > held.worth() {
                *held = weight;
            }
        }
    }
    journeys
        .filter_map(|journey| {
            let mut members = journey.steps.iter().flat_map(|step| step.lands_in.iter());
            let start = members.next().and_then(|first| weight_of_flow.get(first.as_str()).copied());
            let weight = start.or_else(|| members.filter_map(|member| weight_of_flow.get(member.as_str()).copied()).max_by(|left, right| left.worth().total_cmp(&right.worth())))?;
            Some((journey.id.clone(), weight))
        })
        .collect()
}

pub fn through(journey: &Flow) -> String {
    journey.steps.iter().map(|step| step.description.as_deref().unwrap_or(&step.label)).collect::<Vec<_>>().join(" → ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow(id: &str, kind: &'static str, part: &str, writes: &[&str]) -> Flow {
        Flow {
            summary: String::new(),
            writes: writes.iter().map(|held| held.to_string()).collect(),
            reads: Vec::new(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind,
            method: None,
            operation: id.to_string(),
            surface: None,
            plays: None,
            standing: if writes.is_empty() { "reading" } else { "terminal" },
            confidence: 1.0,
            unsettled: None,
            open: 0,
            cut: false,
            name: Some(id.to_string()),
            description: None,
            grounding: None,
            path: vec![Step { unit: format!("{part}/x.cs:function:{id}"), depth: 0, leaves: Vec::new() }],
            steps: Vec::new(),
            step_edges: Vec::new(),
            units: 1,
            rank: 0,
            stages: Vec::new(),
            changes: Vec::new(),
            takes: Vec::new(),
            leads_into: Vec::new(),
            project: Some(part.to_string()),
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capabilities: Vec::new(),
            contract: None,
            value: None,
        }
    }

    fn capability(id: &str, delivers: &str) -> crate::comprehend::Capability {
        crate::comprehend::Capability {
            id: id.to_string(),
            audience: None,
            delivered: vec![crate::comprehend::Delivery { flow: delivers.to_string(), role: "primary", rationale: String::new(), unshipped: None }],
            records: Vec::new(),
            changes: Vec::new(),
            flows: vec![delivers.to_string()],
            surfaces: Vec::new(),
            project: None,
            also_in: Vec::new(),
            supporting: false,
            name: Some(id.to_string()),
            description: None,
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
        }
    }

    fn seam(from: &str, to: &str) -> Seam {
        Seam { from: String::new(), from_flow: from.to_string(), step: None, via: "http", by: "route", carries: "POST /orders".to_string(), to: String::new(), to_entry: String::new(), to_flows: vec![to.to_string()] }
    }

    fn parts() -> (HashMap<String, String>, HashMap<String, &'static str>) {
        let names = HashMap::from_iter([("app".to_string(), "Shop app".to_string()), ("orders".to_string(), "Orders API".to_string()), ("payments".to_string(), "Payments".to_string()), ("bus".to_string(), "Bus".to_string()), ("scripts".to_string(), "Scripts".to_string())]);
        let roles = HashMap::from_iter([("app".to_string(), "app"), ("orders".to_string(), "service"), ("payments".to_string(), "worker"), ("bus".to_string(), "library"), ("scripts".to_string(), "tooling")]);
        (names, roles)
    }

    #[test]
    fn a_library_s_routes_start_journeys_when_a_program_of_the_product_serves_it() {
        let flows = vec![flow("list-media", "http", "bus", &["Media"])];
        let (names, roles) = parts();
        let served = HashMap::from_iter([("bus".to_string(), vec!["orders".to_string()])]);
        assert_eq!(of(&flows, &[], &Parts { names: &names, roles: &roles, consumers: &served }).product.len(), 1);
        assert!(of(&flows, &[], &Parts { names: &names, roles: &roles, consumers: &HashMap::default() }).product.is_empty(), "a library nothing in the product runs starts no journey");
        let only_tooling = HashMap::from_iter([("bus".to_string(), vec!["scripts".to_string()])]);
        assert!(of(&flows, &[], &Parts { names: &names, roles: &roles, consumers: &only_tooling }).product.is_empty());
    }

    #[test]
    fn a_journey_starts_where_a_person_reaches_the_system_and_follows_every_hand_off() {
        let flows = vec![flow("checkout", "ui", "app", &[]), flow("create-order", "http", "orders", &["Order"]), flow("take-payment", "message", "payments", &["Payment"])];
        let seams = vec![seam("checkout", "create-order"), seam("create-order", "take-payment")];
        let (names, roles) = parts();
        let found = of(&flows, &seams, &Parts { names: &names, roles: &roles, consumers: &HashMap::default() });
        assert_eq!(found.product.len(), 1, "the API the app calls is a step of the app's journey, not a journey of its own");
        let journey = &found.product[0];
        assert_eq!(journey.steps.iter().map(|step| step.label.as_str()).collect::<Vec<_>>(), ["Shop app: checkout", "Orders API: create-order (route POST /orders)", "Payments: take-payment (route POST /orders)"]);
        assert_eq!(journey.writes, ["Order", "Payment"]);
        assert_eq!(journey.steps[2].lands_in, ["take-payment"], "each step traces to the part flow it is");
    }

    #[test]
    fn a_service_route_no_app_calls_is_its_own_journey_and_libraries_and_workers_never_start_one() {
        let flows = vec![flow("list-orders", "http", "orders", &[]), flow("publish", "export", "bus", &[]), flow("on-paid", "message", "payments", &[])];
        let (names, roles) = parts();
        let found = of(&flows, &[], &Parts { names: &names, roles: &roles, consumers: &HashMap::default() });
        assert_eq!(found.product.iter().map(|journey| journey.id.as_str()).collect::<Vec<_>>(), ["journey:list-orders"]);
    }

    #[test]
    fn a_step_the_ai_gathers_keeps_the_part_flows_it_covers() {
        let flows = vec![flow("checkout", "ui", "app", &[]), flow("create-order", "http", "orders", &["Order"]), flow("take-payment", "message", "payments", &["Payment"])];
        let seams = vec![seam("checkout", "create-order"), seam("create-order", "take-payment")];
        let (names, roles) = parts();
        let journey = of(&flows, &seams, &Parts { names: &names, roles: &roles, consumers: &HashMap::default() }).product.remove(0);
        let said = vec![(vec!["s1".to_string()], "The customer checks out".to_string()), (vec!["s2".to_string(), "s3".to_string()], "The order is created and paid".to_string())];
        let steps = gathered(journey.steps, &said);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[1].lands_in, ["create-order", "take-payment"]);
        assert_eq!(steps[1].description.as_deref(), Some("The order is created and paid"));
    }

    #[test]
    fn a_journey_weighs_what_its_part_flows_deliver_and_one_delivering_nothing_has_no_weight() {
        let flows = vec![flow("checkout", "ui", "app", &[]), flow("create-order", "http", "orders", &["Order"]), flow("dismiss", "ui", "app", &[]), flow("sign-in", "ui", "app", &[]), flow("verify-user", "http", "orders", &[])];
        let seams = vec![seam("checkout", "create-order"), seam("sign-in", "verify-user")];
        let (names, roles) = parts();
        let found = of(&flows, &seams, &Parts { names: &names, roles: &roles, consumers: &HashMap::default() });
        let held = |id: &str, flow: &str, share: Option<f64>| {
            let mut capability = capability(id, flow);
            capability.supporting = share.is_none();
            capability.value = Some(crate::value::Value { own: 1.0, centrality: 1.0, position: 1.0, impact: 1.0, share: share.unwrap_or(0.0) });
            capability
        };
        let capabilities = vec![held("place-orders", "create-order", Some(0.6)), held("sign-in", "sign-in", None), held("identity", "verify-user", Some(0.4))];
        let weighed = weights(&capabilities, found.product.iter());
        assert_eq!(weighed.get("journey:checkout").copied(), Some(Weight::Valued(0.6)), "the app flow delivers nothing itself, but the order it hands to carries value");
        assert_eq!(weighed.get("journey:sign-in").copied(), Some(Weight::Supporting), "what the person came to do decides, not what the journey later reaches");
        assert!(!weighed.contains_key("journey:dismiss"), "a journey that delivers no part capability never reaches the whole system's capabilities");
    }

    #[test]
    fn a_journey_is_told_by_its_own_steps_not_the_names_of_the_part_flows_it_crosses() {
        let flows = vec![flow("checkout", "ui", "app", &[]), flow("create-order", "http", "orders", &["Order"])];
        let (names, roles) = parts();
        let mut found = of(&flows, &[seam("checkout", "create-order")], &Parts { names: &names, roles: &roles, consumers: &HashMap::default() });
        let journey = &mut found.product[0];
        journey.steps[0].description = Some("The shopper confirms the basket".to_string());
        journey.steps[1].description = Some("The order is recorded".to_string());
        assert_eq!(through(journey), "The shopper confirms the basket → The order is recorded");
    }

    #[test]
    fn tooling_journeys_are_kept_apart_and_marked() {
        let flows = vec![flow("deploy", "cli", "scripts", &[]), flow("checkout", "ui", "app", &[])];
        let (names, roles) = parts();
        let found = of(&flows, &[], &Parts { names: &names, roles: &roles, consumers: &HashMap::default() });
        assert_eq!(found.product.len(), 1);
        assert_eq!(found.tooling.len(), 1);
        assert_eq!(found.tooling[0].unshipped.as_ref().map(|held| held.role), Some("tooling"));
    }
}

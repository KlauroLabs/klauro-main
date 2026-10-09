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
    crate::entry_exit::USER_FACING.contains(&flow.kind)
        && home(flow).and_then(|part| parts.roles.get(part)).is_some_and(|role| FEEDS_THE_PRODUCT.contains(role) || TOOLING.contains(role))
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

fn marked_as_tooling(mut journey: Flow, parts: &Parts) -> Flow {
    if journey.unshipped.is_none() {
        let part = home(&journey).unwrap_or_default().to_string();
        let role = parts.roles.get(&part).copied().unwrap_or("tooling");
        let named = parts.names.get(&part).cloned().unwrap_or_else(|| part.clone());
        journey.unshipped = Some(crate::entry_exit::Unshipped { role, basis: "part-role", evidence: format!("starts in {named}") });
    }
    journey
}

pub fn through(journey: &Flow) -> String {
    journey.steps.iter().map(|step| step.label.as_str()).collect::<Vec<_>>().join(" → ")
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
    fn a_journey_starts_where_a_person_reaches_the_system_and_follows_every_hand_off() {
        let flows = vec![flow("checkout", "ui", "app", &[]), flow("create-order", "http", "orders", &["Order"]), flow("take-payment", "message", "payments", &["Payment"])];
        let seams = vec![seam("checkout", "create-order"), seam("create-order", "take-payment")];
        let (names, roles) = parts();
        let found = of(&flows, &seams, &Parts { names: &names, roles: &roles });
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
        let found = of(&flows, &[], &Parts { names: &names, roles: &roles });
        assert_eq!(found.product.iter().map(|journey| journey.id.as_str()).collect::<Vec<_>>(), ["journey:list-orders"]);
    }

    #[test]
    fn tooling_journeys_are_kept_apart_and_marked() {
        let flows = vec![flow("deploy", "cli", "scripts", &[]), flow("checkout", "ui", "app", &[])];
        let (names, roles) = parts();
        let found = of(&flows, &[], &Parts { names: &names, roles: &roles });
        assert_eq!(found.product.len(), 1);
        assert_eq!(found.tooling.len(), 1);
        assert_eq!(found.tooling[0].unshipped.as_ref().map(|held| held.role), Some("tooling"));
    }
}

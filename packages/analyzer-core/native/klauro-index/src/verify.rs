use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct TestCase {
    pub id: String,
    pub name: String,
    pub file: u32,
    pub shape: &'static str,
    #[serde(skip_serializing_if = "is_zero")]
    pub assertions: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stands_in_for: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Coverage {
    pub units: u32,
    pub requested_routes: u32,
    pub served: u32,
    pub tested: u32,
    pub served_and_tested: u32,
    pub entry_points: u32,
    pub entry_points_tested: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported: Option<Reported>,
}

#[derive(Debug, Serialize)]
pub struct Reported {
    pub files: u32,
    pub matched: u32,
    pub lines: u32,
    pub hit: u32,
}

#[derive(Debug, Serialize)]
pub struct Gap {
    pub gap: &'static str,
    pub node: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Invariant {
    pub invariant: &'static str,
    pub guard: String,
    pub holder: String,
    pub holds: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Verification {
    pub cases: Vec<TestCase>,
    pub suites: u32,
    pub asserting: u32,
    pub standing_in: u32,
    pub coverage: Coverage,
    pub gaps: Vec<Gap>,
    pub by_gap: Vec<(String, u32)>,
    pub invariants: Vec<Invariant>,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

static ASSERTION_WORDS: &[&str] = &[
    "assert", "expect", "must", "require", "should", "verify", "want", "xctassert",
];

static ASSERTION_RECEIVERS: &[&str] = &[
    "Assert", "Assertions", "Check", "assert", "chai", "expect", "should",
];

static STANDING_WORDS: &[&str] = &[
    "createmock", "fake", "mock", "mockimplementation", "mockresolvedvalue", "patch", "spy",
    "spyon", "stub",
];

static REQUEST_VERBS: &[&str] = &[
    "delete", "get", "head", "options", "patch", "post", "put", "request", "send",
];

static GUARD_WORDS: &[&str] = &[
    "allowany", "authenticate", "authenticated", "authorize", "authorized", "hasrole",
    "isauthenticated", "login_required", "permission_classes", "permission_required",
    "preauthorize", "requireauth", "requiresauthentication", "rolesallowed", "secured",
    "useguards",
];

fn asserts(fact: &CallFact) -> bool {
    let callee = crate::names::leaf(&fact.callee).to_ascii_lowercase();
    if ASSERTION_WORDS.iter().any(|word| callee.starts_with(word)) {
        return true;
    }
    fact.receiver
        .as_deref()
        .map(crate::names::root)
        .is_some_and(|root| ASSERTION_RECEIVERS.binary_search(&root).is_ok())
}

fn stands_in(fact: &CallFact) -> bool {
    let callee = crate::names::leaf(&fact.callee).to_ascii_lowercase();
    STANDING_WORDS.binary_search(&callee.as_str()).is_ok()
        || callee.starts_with("mock")
        || callee.starts_with("stub")
}

fn requested(fact: &CallFact) -> Option<(String, String)> {
    let callee = crate::names::leaf(&fact.callee).to_ascii_lowercase();
    let verb = REQUEST_VERBS
        .iter()
        .find(|known| callee.starts_with(*known) && ends_as_request(&callee, known))?;
    let path = fact.literals.iter().find(|literal| literal.starts_with('/'))?;
    Some((verb.to_ascii_uppercase(), path.clone()))
}

fn ends_as_request(callee: &str, verb: &str) -> bool {
    let rest = &callee[verb.len()..];
    rest.is_empty() || matches!(rest, "json" | "async" | "_json" | "request" | "asjson")
}

fn serves(route: &str, requested: &str) -> bool {
    let route = route.trim_end_matches('/');
    let requested = requested.split(['?', '#']).next().unwrap_or(requested).trim_end_matches('/');
    let mut declared = route.trim_start_matches('/').split('/');
    let mut asked = requested.trim_start_matches('/').split('/');
    loop {
        match (declared.next(), asked.next()) {
            (None, None) => return true,
            (Some(step), Some(given)) => {
                if is_parameter(step) {
                    continue;
                }
                if !step.eq_ignore_ascii_case(given) {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

fn is_parameter(step: &str) -> bool {
    step.starts_with([':', '{', '<', '*'])
        || step.ends_with('}')
        || (step.starts_with('%') && step.len() <= 2)
}

fn guard_of(node: &IndexNode) -> Option<&str> {
    node.decorators.iter().find_map(|decorator| {
        let leaf = crate::names::leaf(&decorator.name);
        let lowered = leaf.trim_start_matches('@').to_ascii_lowercase();
        GUARD_WORDS
            .binary_search(&lowered.as_str())
            .is_ok()
            .then(|| decorator.name.as_str())
    })
}

fn guarded(nodes: &[IndexNode], entry_points: &[EntryPoint]) -> Vec<Invariant> {
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut holders: HashMap<(&str, String), (Vec<String>, Vec<String>, Option<String>)> =
        HashMap::new();
    for entry in entry_points {
        if entry.kind == "test" {
            continue;
        }
        let Some(node) = by_id.get(entry.handler.as_str()).copied() else { continue };
        let holder = node.parent.as_deref().unwrap_or(entry.handler.as_str());
        let owner = by_id.get(holder).copied();
        let guard = guard_of(node).or_else(|| owner.and_then(guard_of));
        let named = match guard {
            Some(guard) => crate::names::leaf(guard).trim_start_matches('@').to_string(),
            None => String::new(),
        };
        let slot = holders
            .entry((holder, named.clone()))
            .or_insert_with(|| (Vec::new(), Vec::new(), node.project.clone()));
        match named.is_empty() {
            false => slot.0.push(entry.handler.clone()),
            true => slot.1.push(entry.handler.clone()),
        }
    }
    let unguarded: HashMap<&str, Vec<String>> = holders
        .iter()
        .filter(|((_, guard), _)| guard.is_empty())
        .map(|((holder, _), (_, missing, _))| (*holder, missing.clone()))
        .collect();
    let mut invariants: Vec<Invariant> = holders
        .iter()
        .filter(|((_, guard), _)| !guard.is_empty())
        .map(|((holder, guard), (holds, _, project))| {
            let mut holds = holds.clone();
            holds.sort();
            let mut missing = unguarded.get(holder).cloned().unwrap_or_default();
            missing.sort();
            Invariant {
                invariant: "authorization",
                guard: guard.clone(),
                holder: (*holder).to_string(),
                holds,
                missing,
                project: project.clone(),
            }
        })
        .collect();
    invariants.sort_by(|left, right| {
        left.holder.cmp(&right.holder).then(left.guard.cmp(&right.guard))
    });
    invariants
}

pub fn derive(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    files: &[String],
    calls: &[CallFact],
    metrics: &[UnitMetricsEntry],
    entry_points: &[EntryPoint],
    graph: &crate::graph::GraphFacts,
    routes: &[&crate::architecture::Route],
) -> Verification {
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut asserted: HashMap<&str, u32> = HashMap::new();
    let mut standing: HashMap<&str, Vec<String>> = HashMap::new();
    for fact in calls {
        let Some(caller) = fact.caller.as_deref() else { continue };
        if asserts(fact) {
            *asserted.entry(caller).or_insert(0) += 1;
        }
        if stands_in(fact) {
            let named = fact
                .literals
                .first()
                .cloned()
                .or_else(|| fact.receiver.clone())
                .unwrap_or_else(|| fact.callee.clone());
            standing.entry(caller).or_default().push(named);
        }
    }

    for entry in metrics {
        if entry.metrics.asserts > 0 {
            *asserted.entry(entry.unit.as_str()).or_insert(0) += entry.metrics.asserts as u32;
        }
    }

    let mut cases = Vec::new();
    let mut seen = HashSet::new();
    for entry in entry_points {
        if entry.kind != "test" || !seen.insert(entry.handler.as_str()) {
            continue;
        }
        let Some(node) = by_id.get(entry.handler.as_str()).copied() else { continue };
        let shape = match crate::names::leaf(&entry.registrar) {
            "describe" | "suite" | "context" => "suite",
            _ => "case",
        };
        let mut stands_in_for = standing.get(entry.handler.as_str()).cloned().unwrap_or_default();
        stands_in_for.sort();
        stands_in_for.dedup();
        cases.push(TestCase {
            id: entry.handler.clone(),
            name: entry.name.clone(),
            file: entry.file,
            shape,
            assertions: asserted.get(entry.handler.as_str()).copied().unwrap_or(0),
            stands_in_for,
            project: node.project.clone(),
        });
    }
    cases.sort_by(|left, right| left.id.cmp(&right.id));
    let asking: HashSet<&str> = cases.iter().map(|case| case.id.as_str()).collect();
    let mut requests: Vec<(String, String)> = calls
        .iter()
        .filter(|fact| fact.caller.as_deref().is_some_and(|caller| asking.contains(caller)))
        .filter_map(requested)
        .collect();
    requests.sort();
    requests.dedup();
    let coverage = measure(nodes, files, entry_points, graph, &requests, routes);
    let suites = cases.iter().filter(|case| case.shape == "suite").count() as u32;
    let asserting = cases.iter().filter(|case| case.assertions > 0).count() as u32;
    let standing_in = cases.iter().filter(|case| !case.stands_in_for.is_empty()).count() as u32;
    let mut gaps = missing(
        nodes,
        edges,
        files,
        entry_points,
        graph,
        &cases,
        &asked_handlers(routes, &requests),
    );
    let invariants = guarded(nodes, entry_points);
    for invariant in &invariants {
        for handler in &invariant.missing {
            gaps.push(Gap {
                gap: "unguarded-surface",
                node: handler.clone(),
                kind: Some(invariant.guard.clone()),
                project: invariant.project.clone(),
            });
        }
    }
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for gap in &gaps {
        *counts.entry(gap.gap).or_insert(0) += 1;
    }
    let mut by_gap: Vec<(String, u32)> = counts
        .into_iter()
        .map(|(gap, count)| (gap.to_string(), count))
        .collect();
    by_gap.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    Verification { cases, suites, asserting, standing_in, coverage, gaps, by_gap, invariants }
}

fn reported(nodes: &[IndexNode], files: &[String]) -> Option<Reported> {
    let held: HashSet<&str> = files.iter().map(String::as_str).collect();
    let mut measured = 0;
    let mut matched = 0;
    let mut lines = 0;
    let mut hit = 0;
    for node in nodes {
        let Some(path) = files.get(node.file as usize) else { continue };
        if !crate::coverage::is_report(path) || node.kind != NodeKind::Property {
            continue;
        }
        let Some((covered, found)) = node
            .type_annotation
            .as_deref()
            .and_then(|counted| counted.split_once('/'))
        else {
            continue;
        };
        measured += 1;
        lines += found.parse::<u32>().unwrap_or(0);
        hit += covered.parse::<u32>().unwrap_or(0);
        let named = crate::paths::normalize(node.name.trim_start_matches("./"));
        if held.contains(named.as_str())
            || files.iter().any(|path| named.ends_with(path.as_str()) || path.ends_with(&named))
        {
            matched += 1;
        }
    }
    (measured > 0).then_some(Reported { files: measured, matched, lines, hit })
}

fn asked_handlers<'a>(
    routes: &[&'a crate::architecture::Route],
    requests: &[(String, String)],
) -> HashSet<&'a str> {
    let mut asked = HashSet::new();
    for route in routes {
        if requests.iter().any(|(method, path)| {
            (route.method == "ANY" || route.method.eq_ignore_ascii_case(method))
                && serves(&route.path, path)
        }) {
            asked.insert(route.handler.as_str());
        }
    }
    asked
}

fn missing(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    files: &[String],
    entry_points: &[EntryPoint],
    graph: &crate::graph::GraphFacts,
    cases: &[TestCase],
    asked: &HashSet<&str>,
) -> Vec<Gap> {
    let position_of: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(position, node)| (node.id.as_str(), position))
        .collect();
    let project_of: HashMap<&str, Option<&str>> = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.project.as_deref()))
        .collect();
    let product: HashSet<&str> = nodes
        .iter()
        .filter(|node| {
            node.kind.is_unit()
                && files
                    .get(node.file as usize)
                    .is_some_and(|path| !crate::paths::is_test(path))
        })
        .map(|node| node.id.as_str())
        .collect();
    let mut reaching: HashSet<&str> = HashSet::new();
    for edge in edges {
        if matches!(edge.kind, EdgeKind::Calls | EdgeKind::Instantiates)
            && product.contains(edge.target.as_str())
        {
            reaching.insert(edge.source.as_str());
        }
    }
    let tested = |id: &str| {
        asked.contains(id)
            || position_of
                .get(id)
                .is_some_and(|position| graph.tested.get(*position).copied().unwrap_or(false))
    };
    let mut gaps = Vec::new();
    for entry in entry_points {
        if entry.kind == "test" || tested(&entry.handler) {
            continue;
        }
        if files.get(entry.file as usize).is_some_and(|path| crate::paths::is_test(path)) {
            continue;
        }
        gaps.push(Gap {
            gap: "untested-surface",
            node: entry.handler.clone(),
            kind: Some(entry.kind.to_string()),
            project: project_of
                .get(entry.handler.as_str())
                .copied()
                .flatten()
                .map(str::to_string),
        });
    }
    for case in cases {
        if case.shape == "suite" || case.assertions > 0 {
            continue;
        }
        gaps.push(Gap {
            gap: "no-assertions",
            node: case.id.clone(),
            kind: None,
            project: case.project.clone(),
        });
    }
    for case in cases {
        if case.stands_in_for.is_empty() || case.shape == "suite" || reaching.contains(case.id.as_str())
        {
            continue;
        }
        gaps.push(Gap {
            gap: "stands-in-only",
            node: case.id.clone(),
            kind: None,
            project: case.project.clone(),
        });
    }
    gaps.sort_by(|left, right| left.node.cmp(&right.node).then(left.gap.cmp(right.gap)));
    gaps
}

fn measure(
    nodes: &[IndexNode],
    files: &[String],
    entry_points: &[EntryPoint],
    graph: &crate::graph::GraphFacts,
    requests: &[(String, String)],
    routes: &[&crate::architecture::Route],
) -> Coverage {
    let product: Vec<bool> = nodes
        .iter()
        .map(|node| {
            node.kind.is_unit()
                && files
                    .get(node.file as usize)
                    .is_some_and(|path| !crate::paths::is_test(path))
        })
        .collect();
    let mut units = 0;
    let mut served = 0;
    let mut tested = 0;
    let mut both = 0;
    for (position, held) in product.iter().enumerate() {
        if !held {
            continue;
        }
        units += 1;
        let reached = graph.served.get(position).copied().unwrap_or(false);
        let exercised = graph.tested.get(position).copied().unwrap_or(false);
        served += u32::from(reached);
        tested += u32::from(exercised);
        both += u32::from(reached && exercised);
    }
    let position_of: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(position, node)| (node.id.as_str(), position))
        .collect();
    let mut asked: HashSet<&str> = HashSet::new();
    for route in routes {
        if requests.iter().any(|(method, path)| {
            (route.method == "ANY" || route.method.eq_ignore_ascii_case(method))
                && serves(&route.path, path)
        }) {
            asked.insert(route.handler.as_str());
        }
    }
    let surface: Vec<&EntryPoint> = entry_points.iter().filter(|entry| entry.kind != "test").collect();
    let exercised = surface
        .iter()
        .filter(|entry| {
            asked.contains(entry.handler.as_str())
                || position_of
                    .get(entry.handler.as_str())
                    .is_some_and(|position| graph.tested.get(*position).copied().unwrap_or(false))
        })
        .count() as u32;
    Coverage {
        reported: reported(nodes, files),
        units,
        requested_routes: asked.len() as u32,
        served,
        tested,
        served_and_tested: both,
        entry_points: surface.len() as u32,
        entry_points_tested: exercised,
    }
}

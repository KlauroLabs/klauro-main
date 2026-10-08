use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::{Deserialize, Serialize};

use crate::comprehend::{Comprehension, Flow};
use crate::entry_exit::EntryPoint;
use crate::model::IndexNode;

const SPLITS: &[&str] = &["http", "rpc", "graphql", "message", "cli", "tool", "ipc", "schedule", "background"];
const ROUTES: &[&str] = &["http", "rpc", "graphql"];
const REACHED_TOLD: usize = 16;

#[derive(Debug, Clone, Serialize)]
pub struct SetAside {
    pub entry_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub trigger: String,
    pub reason: &'static str,
}

pub struct Facts<'a> {
    pub entries: &'a [EntryPoint],
    pub nodes: &'a [IndexNode],
    pub part_names: HashMap<&'a str, &'a str>,
    pub consumed: HashSet<&'a str>,
    pub calling: HashSet<&'a str>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Said {
    #[serde(default)]
    id: String,
    #[serde(default)]
    said: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Behaviour {
    #[serde(default)]
    name: String,
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    steps: Vec<Said>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Answer {
    #[serde(default)]
    behaviours: Vec<Behaviour>,
}

fn trigger_of(flow: &Flow, entry: Option<&EntryPoint>) -> String {
    let said = flow
        .surface
        .clone()
        .filter(|held| !held.is_empty())
        .or_else(|| Some(flow.operation.clone()).filter(|held| !held.is_empty()))
        .or_else(|| entry.map(|held| held.name.clone()))
        .unwrap_or_default();
    match flow.method.as_deref().filter(|_| ROUTES.contains(&flow.kind)) {
        Some(method) => format!("{} {method} {said}", flow.kind),
        None => format!("{} {said}", flow.kind),
    }
}

fn lasting(flow: &Flow) -> bool {
    !flow.writes.is_empty() || !flow.reaches.is_empty() || flow.changes.iter().any(|held| !held.starts_with("client_storage:"))
}

fn set_aside_because(flow: &Flow, facts: &Facts) -> Option<&'static str> {
    let Some(project) = flow.project.as_deref() else { return Some("outside every part") };
    if matches!(flow.kind, "lifecycle" | "test") {
        return Some("a program starting up");
    }
    if !matches!(flow.kind, "ui" | "http" | "rpc" | "graphql") && flow.path.len() <= 1
        && flow.steps.is_empty()
        && flow.open == 0
        && !flow.cut
        && flow.path.first().is_none_or(|start| !facts.calling.contains(start.unit.as_str()))
    {
        return Some("does nothing when triggered");
    }
    if flow.kind == "event" && !lasting(flow) {
        return Some("a page or process event that changes only what is on screen");
    }
    if flow.kind == "export" {
        if facts.consumed.contains(project) {
            return Some("a library other parts use: its work appears in their flows");
        }
        let start = flow.path.first().map(|held| held.unit.as_str()).unwrap_or_default();
        if !start.contains(":function:") && !start.contains(":method:") {
            return Some("a type made available, not something that happens");
        }
    }
    None
}

fn told(flow: &Flow, entry: Option<&EntryPoint>, facts: &Facts, landing: &HashMap<&str, String>, one: bool) -> String {
    let part = flow.project.as_deref().map(|held| facts.part_names.get(held).copied().unwrap_or(held)).unwrap_or_default();
    let mut lines = vec![format!("Part: {part}"), format!("Trigger: {}", trigger_of(flow, entry))];
    if matches!(flow.kind, "message" | "event") {
        lines.push("The trigger is a message received from elsewhere: its name says what already happened there. This behaviour is only what this part does in response.".to_string());
    }
    for (held, word) in [(&flow.writes, "keeps"), (&flow.changes, "changes"), (&flow.reaches, "reaches")] {
        if !held.is_empty() {
            lines.push(format!("{word}: {}", held.join(", ")));
        }
    }
    for step in &flow.steps {
        let arms = match step.arms.is_empty() {
            true => String::new(),
            false => format!(", branch {}", step.arms.join(" ")),
        };
        lines.push(format!("{}: {} ({}, {}{arms})", step.id, step.label, step.kind, step.when));
    }
    for into in &flow.leads_into {
        if let Some(landed) = landing.get(into.as_str()) {
            lines.push(format!("Hands over to another part: {landed}. What that part does next is its own behaviour, not this one's."));
        }
    }
    let route = ROUTES.contains(&flow.kind);
    let mut reached: Vec<&str> = Vec::new();
    for (at, held) in flow.path.iter().enumerate() {
        if (route && at == 0) || held.unit.starts_with("package:") || held.unit.starts_with("runtime:") {
            continue;
        }
        let named = held.unit.rsplit(':').next().unwrap_or_default();
        let named = named.split(['@', '#']).next().unwrap_or_default();
        if !named.is_empty() && !reached.contains(&named) {
            reached.push(named);
        }
    }
    if !reached.is_empty() {
        lines.push(format!("Reaches, in order: {}", reached.iter().take(REACHED_TOLD).copied().collect::<Vec<_>>().join(", ")));
    }
    let asked = crate::author::BEHAVIOURS_ASKED
        .replace("ONE_OR_SEVERAL", if one || !SPLITS.contains(&flow.kind) { crate::author::ONE_ONLY } else { crate::author::SEVERAL_ALLOWED })
        .replace(
            "NOTHING_HAPPENS",
            if matches!(flow.kind, "event" | "export") { crate::author::MAY_BE_NOTHING } else { crate::author::ALWAYS_SOMETHING },
        );
    format!("{}\n\n{asked}", lines.join("\n"))
}

fn asked_all(items: &[(String, String)]) -> std::collections::BTreeMap<String, Answer> {
    crate::author::asking(|| {
        items
            .par_iter()
            .filter_map(|(id, prompt)| {
                let held = crate::author::behaviours_of(prompt)?;
                serde_json::from_value::<Answer>(held).ok().map(|answer| (id.clone(), answer))
            })
            .collect()
    })
}

fn branch_of(arm: &str) -> &str {
    arm.rsplit_once('.').map(|(branch, _)| branch).unwrap_or(arm)
}

fn alternatives(behaviours: &[Behaviour], flow: &Flow) -> bool {
    let arms_of = |held: &Behaviour| -> Vec<&str> {
        held.steps
            .iter()
            .filter_map(|said| flow.steps.iter().find(|step| step.id == said.id))
            .flat_map(|step| step.arms.iter().map(String::as_str))
            .collect()
    };
    let owned: Vec<Vec<&str>> = behaviours.iter().map(arms_of).collect();
    let apart = |left: &[&str], right: &[&str]| {
        right.iter().any(|arm| left.iter().any(|other| branch_of(other) == branch_of(arm) && other != arm))
    };
    let only_failing = behaviours.iter().any(|held| {
        let steps: Vec<_> = held.steps.iter().filter_map(|said| flow.steps.iter().find(|step| step.id == said.id)).collect();
        !steps.is_empty() && steps.iter().all(|step| step.when == "on_failure")
    });
    !only_failing
        && (0..owned.len()).all(|left| (0..owned.len()).filter(|right| *right != left).all(|right| apart(&owned[left], &owned[right])))
}

const OUTCOMES: &[&str] = &["keep", "change", "create", "remove", "send", "hand_off", "notify", "refuse", "raise"];

fn worded(flow: &Flow, behaviour: &Behaviour, alone: bool) -> Vec<crate::steps::LogicalStep> {
    let said_of: HashMap<&str, &str> = behaviour.steps.iter().map(|said| (said.id.as_str(), said.said.trim())).collect();
    flow.steps
        .iter()
        .filter(|step| said_of.contains_key(step.id.as_str()) || (alone && OUTCOMES.contains(&step.kind)))
        .map(|step| {
            let mut step = step.clone();
            if let Some(said) = said_of.get(step.id.as_str()).filter(|said| !said.is_empty()) {
                step.description = Some(said.to_string());
            }
            step
        })
        .collect()
}

fn merge_class(flow: &Flow) -> (&'static str, String, bool) {
    let method = flow.method.clone().filter(|_| ROUTES.contains(&flow.kind)).unwrap_or_default();
    let action = flow.kind == "ui" && flow.operation.contains('.') && !flow.operation.starts_with('/');
    (flow.kind, method, action)
}

fn stem(flow: &Flow) -> String {
    flow.surface
        .as_deref()
        .unwrap_or_default()
        .split('/')
        .filter(|segment| !segment.is_empty() && !segment.starts_with('{') && !segment.starts_with(':'))
        .collect::<Vec<_>>()
        .join("/")
}

fn signature(flow: &Flow) -> Vec<(&'static str, Option<&str>)> {
    flow.steps.iter().map(|step| (step.kind, step.object.as_deref())).collect()
}

fn joined(flows: Vec<Flow>) -> Vec<Flow> {
    let mut out: Vec<Flow> = Vec::new();
    for flow in flows {
        let same = out.iter().position(|held| {
            held.project == flow.project
                && merge_class(held) == merge_class(&flow)
                && !signature(held).is_empty()
                && signature(held) == signature(&flow)
                && !stem(held).is_empty()
                && stem(held) == stem(&flow)
        });
        match same {
            Some(at) => out[at].entered_by.push(flow.entry_point.clone()),
            None => out.push(flow),
        }
    }
    out
}

fn merged(flows: Vec<Flow>, facts: &Facts) -> Vec<Flow> {
    let mut by_part: std::collections::BTreeMap<(Option<String>, (&'static str, String, bool)), Vec<Flow>> = std::collections::BTreeMap::new();
    for flow in flows {
        by_part.entry((flow.project.clone(), merge_class(&flow))).or_default().push(flow);
    }
    let mut out = Vec::new();
    let mut asked: Vec<(String, String)> = Vec::new();
    let mut waiting: Vec<(String, Vec<Flow>)> = Vec::new();
    for ((project, (kind, ..)), joined) in by_part {
        if joined.len() < 2 || matches!(kind, "message" | "event" | "schedule" | "background") {
            out.extend(joined);
            continue;
        }
        let part = project.as_deref().map(|held| facts.part_names.get(held).copied().unwrap_or(held)).unwrap_or_default();
        let listing: Vec<String> = joined
            .iter()
            .enumerate()
            .map(|(at, flow)| {
                format!(
                    "{}. {} (trigger: {} {}): {}",
                    at + 1,
                    flow.name.as_deref().unwrap_or_default(),
                    flow.kind,
                    flow.surface.as_deref().unwrap_or(&flow.operation),
                    flow.description.as_deref().unwrap_or_default()
                )
            })
            .collect();
        let key = format!("{}\u{1}{}", project.as_deref().unwrap_or_default(), joined.first().map(|flow| flow.id.as_str()).unwrap_or_default());
        asked.push((key.clone(), format!("Part: {part}\n{}", listing.join("\n"))));
        waiting.push((key, joined));
    }
    let answered = crate::memory::each("same behaviours", crate::author::SAME_BEHAVIOUR_ASKED, &asked, |missing| {
        crate::author::asking(|| {
            missing
                .par_iter()
                .filter_map(|(key, prompt)| crate::author::same_behaviours(prompt).map(|held| (key.clone(), held)))
                .collect()
        })
    });
    for (key, joined) in waiting {
        let together: Vec<Vec<usize>> = answered
            .get(&key)
            .and_then(|held| serde_json::from_value::<Vec<Vec<usize>>>(held["together"].clone()).ok())
            .unwrap_or_default();
        let mut taken: HashSet<usize> = HashSet::default();
        let mut slots: Vec<Option<Flow>> = joined.into_iter().map(Some).collect();
        for group in together {
            let members: Vec<usize> = group.into_iter().filter(|at| *at >= 1 && *at <= slots.len() && taken.insert(*at - 1)).map(|at| at - 1).collect();
            let Some((first, rest)) = members.split_first() else { continue };
            let Some(mut kept) = slots[*first].take() else { continue };
            for at in rest {
                if let Some(other) = slots[*at].take() {
                    kept.entered_by.push(other.entry_point.clone());
                    kept.entered_by.extend(other.entered_by);
                }
            }
            out.push(kept);
        }
        out.extend(slots.into_iter().flatten());
    }
    out
}

pub fn settle(held: &mut Comprehension, facts: &Facts) {
    let entry_of: HashMap<&str, &EntryPoint> = facts.entries.iter().map(|entry| (entry.id.as_str(), entry)).collect();
    let project_of: HashMap<&str, Option<&str>> = facts.nodes.iter().map(|node| (node.id.as_str(), node.project.as_deref())).collect();
    let landing: HashMap<&str, String> = facts
        .entries
        .iter()
        .map(|entry| {
            let part = project_of.get(entry.handler.as_str()).copied().flatten().map(|held| facts.part_names.get(held).copied().unwrap_or(held)).unwrap_or("another part");
            (entry.id.as_str(), format!("{part} receives it ({} {})", entry.kind, entry.name))
        })
        .collect();
    let flows = std::mem::take(&mut held.flows);
    let mut kept: Vec<Flow> = Vec::new();
    let mut seen: HashSet<(Option<String>, String)> = HashSet::default();
    for flow in flows {
        let entry = entry_of.get(flow.entry_point.as_str()).copied();
        let trigger = trigger_of(&flow, entry);
        let mut reason = set_aside_because(&flow, facts);
        if reason.is_none() && !seen.insert((flow.project.clone(), trigger.clone())) {
            reason = Some("the same trigger registered twice");
        }
        match reason {
            Some(reason) => held.set_aside.push(SetAside { entry_point: flow.entry_point.clone(), project: flow.project.clone(), trigger, reason }),
            None => kept.push(flow),
        }
    }
    let kept = joined(kept);
    if !crate::author::asked() {
        held.flows = kept;
        return;
    }
    let first: Vec<(String, String)> = kept
        .iter()
        .map(|flow| (flow.id.clone(), told(flow, entry_of.get(flow.entry_point.as_str()).copied(), facts, &landing, false)))
        .collect();
    let answers = crate::memory::each("flow behaviours", crate::author::BEHAVIOURS_ASKED, &first, asked_all);
    let mut again: Vec<(String, String)> = Vec::new();
    for flow in &kept {
        let Some(answer) = answers.get(&flow.id) else { continue };
        if answer.behaviours.len() > 1 && !alternatives(&answer.behaviours, flow) {
            again.push((flow.id.clone(), told(flow, entry_of.get(flow.entry_point.as_str()).copied(), facts, &landing, true)));
        }
    }
    let single = crate::memory::each("flow behaviour, one", crate::author::BEHAVIOURS_ASKED, &again, asked_all);
    let mut settled: Vec<Flow> = Vec::new();
    for flow in kept {
        let mut behaviours: Vec<Behaviour> = match single.get(&flow.id) {
            Some(answer) if !answer.behaviours.is_empty() => answer.behaviours[..1].to_vec(),
            _ => answers.get(&flow.id).map(|answer| answer.behaviours.clone()).unwrap_or_default(),
        };
        if behaviours.len() > 1 && (!SPLITS.contains(&flow.kind) || again.iter().any(|(id, _)| id == &flow.id)) {
            let mut one = behaviours[0].clone();
            one.steps = behaviours.iter().flat_map(|held| held.steps.clone()).collect();
            behaviours = vec![one];
        }
        if behaviours.is_empty() {
            match answers.contains_key(&flow.id) && matches!(flow.kind, "event" | "export") {
                true => held.set_aside.push(SetAside {
                    entry_point: flow.entry_point.clone(),
                    project: flow.project.clone(),
                    trigger: trigger_of(&flow, entry_of.get(flow.entry_point.as_str()).copied()),
                    reason: "nothing a person would recognise happens",
                }),
                false => settled.push(flow),
            }
            continue;
        }
        let owned: Vec<Vec<&str>> = behaviours.iter().map(|held| held.steps.iter().map(|said| said.id.as_str()).collect()).collect();
        if owned.len() > 1 && owned.iter().all(|held| held == &owned[0]) {
            behaviours.truncate(1);
        }
        let several = behaviours.len() > 1;
        for (at, behaviour) in behaviours.iter().enumerate() {
            let mut shaped = flow.clone();
            if several {
                shaped.id = format!("{}#{}", flow.id, at + 1);
            }
            shaped.name = Some(behaviour.name.trim().to_string()).filter(|held| !held.is_empty());
            shaped.description = Some(behaviour.outcome.trim().to_string()).filter(|held| !held.is_empty());
            let steps = worded(&flow, behaviour, !several);
            if !steps.is_empty() || flow.steps.is_empty() {
                shaped.steps = steps;
                shaped.step_edges = shaped
                    .steps
                    .windows(2)
                    .map(|pair| crate::steps::StepEdge {
                        from: pair[0].id.clone(),
                        to: pair[1].id.clone(),
                        kind: match pair[1].when {
                            "on_failure" => "on_failure",
                            "conditionally" => "when",
                            _ => "then",
                        },
                    })
                    .collect();
            }
            settled.push(shaped);
        }
    }
    held.flows = merged(settled, facts);
}

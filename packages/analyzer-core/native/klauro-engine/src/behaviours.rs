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
    pub part_summaries: HashMap<&'a str, &'a str>,
    pub consumed: HashSet<&'a str>,
    pub calling: HashSet<&'a str>,
    pub calls: &'a [crate::model::CallFact],
    pub handled_by: HashMap<&'a str, Vec<&'a str>>,
}

static HOSTING: &str = include_str!("../data/hosting_calls.tsv");

fn hosted_in<'a>(facts: &Facts<'a>, project_of: &HashMap<&'a str, Option<&'a str>>) -> HashMap<String, &'a str> {
    let mut held: HashMap<String, &str> = HashMap::default();
    for call in facts.calls.iter().filter(|call| HOSTING.lines().any(|named| named == call.callee)) {
        let Some(part) = call.caller.as_deref().and_then(|caller| project_of.get(caller).copied().flatten()) else { continue };
        for argument in &call.type_arguments {
            for named in argument.split(['<', '>', ',', ' ']).filter(|named| !named.is_empty()) {
                held.entry(crate::names::leaf(named).to_string()).or_insert(part);
            }
        }
    }
    held
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Said {
    #[serde(default)]
    id: String,
    #[serde(default)]
    said: String,
    #[serde(default)]
    with: Vec<String>,
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
    if flow.kind == "public" {
        return Some("code nothing here calls: what it makes public is all it offers");
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

struct Known<'a> {
    calls_of: HashMap<&'a str, Vec<&'a crate::model::CallFact>>,
    named: HashMap<&'a str, Vec<&'a IndexNode>>,
    node_of: HashMap<&'a str, &'a IndexNode>,
    paths: HashMap<u32, &'a str>,
}

impl<'a> Known<'a> {
    fn new(facts: &Facts<'a>) -> Self {
        let mut calls_of: HashMap<&str, Vec<&crate::model::CallFact>> = HashMap::default();
        for call in facts.calls {
            if let Some(caller) = call.caller.as_deref() {
                calls_of.entry(caller).or_default().push(call);
            }
        }
        let mut named: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
        for node in facts.nodes.iter().filter(|node| node.kind.is_unit()) {
            named.entry(node.name.as_str()).or_default().push(node);
        }
        let node_of = facts.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
        let paths = facts.nodes.iter().filter(|node| node.kind == crate::model::NodeKind::Module).map(|node| (node.file, node.id.as_str())).collect();
        Known { calls_of, named, node_of, paths }
    }

    fn standing_for(&self, step: &crate::steps::LogicalStep) -> Option<String> {
        let doing = step.doing.as_deref()?;
        let region = step.regions.first()?;
        let call = self.calls_of.get(region.unit.as_str())?.iter().find(|call| crate::steps::spoken(crate::names::leaf(&call.callee)) == doing)?;
        let leaf = crate::names::leaf(&call.callee);
        let qualifier = call.callee.strip_suffix(leaf).map(|held| held.trim_end_matches([':', '.'])).unwrap_or_default();
        let qualifier = qualifier.rsplit([':', '.']).next().unwrap_or_default();
        let candidates = self.named.get(leaf)?;
        let stem_of = |node: &IndexNode| -> String {
            let path = self.paths.get(&node.file).copied().unwrap_or_default();
            let file = path.rsplit('/').next().unwrap_or(path);
            file.split('.').next().unwrap_or(file).to_string()
        };
        let chosen = candidates
            .iter()
            .find(|node| !qualifier.is_empty() && stem_of(node) == qualifier)
            .or_else(|| (candidates.len() == 1).then(|| &candidates[0]))?;
        let owner = chosen
            .parent
            .as_deref()
            .and_then(|parent| self.node_of.get(parent))
            .filter(|parent| parent.kind.is_type())
            .map(|parent| crate::steps::spoken(&parent.name))
            .unwrap_or_else(|| crate::steps::spoken(&stem_of(chosen)));
        let makes = chosen.signature.as_ref().and_then(|signature| signature.return_type.as_deref()).filter(|returned| returned.len() <= STANDING_TOLD_AT_MOST);
        let mut said = format!("{} in {}", crate::steps::spoken(leaf), owner.to_lowercase());
        if let Some(makes) = makes {
            said.push_str(&format!(", makes {makes}"));
        }
        Some(said)
    }
}

const STANDING_TOLD_AT_MOST: usize = 60;

fn told(flow: &Flow, entry: Option<&EntryPoint>, facts: &Facts, known: &Known, landing: &HashMap<&str, String>, one: bool) -> String {
    let part = flow.project.as_deref().map(|held| facts.part_names.get(held).copied().unwrap_or(held)).unwrap_or_default();
    let mut lines = vec![format!("Part: {part}")];
    if let Some(summary) = flow.project.as_deref().and_then(|held| facts.part_summaries.get(held)).filter(|summary| !summary.is_empty()) {
        lines.push(format!("What the part is: {summary}"));
    }
    lines.push(format!("Trigger: {}", trigger_of(flow, entry)));
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
        let standing = known.standing_for(step).map(|said| format!(" — {said}")).unwrap_or_default();
        lines.push(format!("{}: {}{standing} ({}, {}{arms})", step.id, step.label, step.kind, step.when));
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

fn asked_all(items: &[(String, String)], steps_of: &HashMap<String, Vec<String>>) -> std::collections::BTreeMap<String, Answer> {
    crate::author::asking(|| {
        items
            .par_iter()
            .filter_map(|(id, prompt)| {
                let steps: Vec<&str> = steps_of.get(id).into_iter().flatten().map(String::as_str).collect();
                let held = crate::author::behaviours_of(prompt, &steps)?;
                serde_json::from_value::<Answer>(held).ok().map(|answer| (id.clone(), answer))
            })
            .collect()
    })
}

fn branch_of(arm: &str) -> &str {
    arm.rsplit_once('.').map(|(branch, _)| branch).unwrap_or(arm)
}

fn decided_in(arm: &str) -> Option<u64> {
    u64::from_str_radix(branch_of(arm), 16).ok().map(|branch| branch >> 32)
}

fn alternatives(behaviours: &[Behaviour], flow: &Flow, deciding: &HashSet<u64>) -> bool {
    let arms_of = |held: &Behaviour| -> Vec<&str> {
        held.steps
            .iter()
            .filter_map(|said| flow.steps.iter().find(|step| step.id == said.id))
            .filter(|step| OUTCOMES.contains(&step.kind))
            .flat_map(|step| step.arms.iter().map(String::as_str))
            .filter(|arm| decided_in(arm).is_some_and(|file| deciding.contains(&file)))
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
    let mut gathered_into: HashMap<&str, &str> = HashMap::default();
    for said in &behaviour.steps {
        for other in &said.with {
            gathered_into.entry(other.as_str()).or_insert(said.id.as_str());
        }
    }
    let said_of: HashMap<&str, &Said> = behaviour.steps.iter().map(|said| (said.id.as_str(), said)).collect();
    let mut steps: Vec<crate::steps::LogicalStep> = Vec::new();
    for step in &flow.steps {
        if let Some(lead) = gathered_into.get(step.id.as_str()).filter(|lead| **lead != step.id.as_str()) {
            if let Some(into) = steps.iter_mut().find(|held| held.id == *lead) {
                gather(into, step);
            }
            continue;
        }
        let said = said_of.get(step.id.as_str());
        if said.is_none() && !(alone && OUTCOMES.contains(&step.kind)) {
            continue;
        }
        let mut step = step.clone();
        if let Some(said) = said.map(|said| said.said.trim()).filter(|said| !said.is_empty()) {
            step.description = Some(said.to_string());
        }
        steps.push(step);
    }
    steps
}

fn gather(into: &mut crate::steps::LogicalStep, member: &crate::steps::LogicalStep) {
    if into.gathers.is_empty() {
        into.gathers.push(into.label.clone());
    }
    into.gathers.push(member.label.clone());
    into.regions.extend(member.regions.iter().cloned());
    into.lands_in.extend(member.lands_in.iter().cloned());
    if !OUTCOMES.contains(&into.kind) && OUTCOMES.contains(&member.kind) {
        into.kind = member.kind;
        into.object = member.object.clone().or(into.object.take());
    }
}

type MergeClass = (&'static str, String, bool, Option<String>);

fn merge_class(flow: &Flow) -> MergeClass {
    let method = flow.method.clone().filter(|_| ROUTES.contains(&flow.kind)).unwrap_or_default();
    let action = flow.kind == "ui" && flow.operation.contains('.') && !flow.operation.starts_with('/');
    (flow.kind, method, action, flow.unshipped.as_ref().map(|unshipped| unshipped.role.to_string()))
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
    let mut by_part: std::collections::BTreeMap<(Option<String>, MergeClass), Vec<Flow>> = std::collections::BTreeMap::new();
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
    let known = Known::new(facts);
    let landing: HashMap<&str, String> = facts
        .entries
        .iter()
        .map(|entry| {
            let part = project_of.get(entry.handler.as_str()).copied().flatten().map(|held| facts.part_names.get(held).copied().unwrap_or(held)).unwrap_or("another part");
            (entry.id.as_str(), format!("{part} receives it ({} {})", entry.kind, entry.name))
        })
        .collect();
    let node_of: HashMap<&str, &IndexNode> = facts.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let flows = std::mem::take(&mut held.flows);
    let mut kept: Vec<Flow> = Vec::new();
    let mut seen: HashSet<(Option<String>, String)> = HashSet::default();
    for flow in flows {
        let entry = entry_of.get(flow.entry_point.as_str()).copied();
        let trigger = trigger_of(&flow, entry);
        let reason = set_aside_because(&flow, facts);
        let repeated = reason.is_none() && !seen.insert((flow.project.clone(), trigger.clone()));
        match (reason, repeated) {
            (Some(reason), _) => {
                held.set_aside.push(SetAside { entry_point: flow.entry_point.clone(), project: flow.project.clone(), trigger, reason });
                if flow.project.is_some() {
                    held.offered.push(flow);
                }
            }
            (None, true) => held.set_aside.push(SetAside { entry_point: flow.entry_point.clone(), project: flow.project.clone(), trigger, reason: "the same trigger registered twice" }),
            (None, false) => kept.push(flow),
        }
    }
    let kept = joined(kept);
    if !crate::author::asked() {
        held.flows = kept;
        hosting(held, facts, &project_of);
        return;
    }
    let first: Vec<(String, String)> = kept
        .iter()
        .map(|flow| (flow.id.clone(), told(flow, entry_of.get(flow.entry_point.as_str()).copied(), facts, &known, &landing, false)))
        .collect();
    let steps_of: HashMap<String, Vec<String>> = kept.iter().map(|flow| (flow.id.clone(), flow.steps.iter().map(|step| step.id.clone()).collect())).collect();
    let answers = crate::memory::each("flow behaviours", crate::author::BEHAVIOURS_ASKED, &first, |items| asked_all(items, &steps_of));
    let mut again: Vec<(String, String)> = Vec::new();
    for flow in &kept {
        let Some(answer) = answers.get(&flow.id) else { continue };
        let mut deciding: HashSet<u64> = HashSet::default();
        if let Some(node) = flow.path.first().and_then(|start| node_of.get(start.unit.as_str())) {
            deciding.insert(node.file as u64);
        }
        for step in flow.steps.iter().filter(|step| step.kind == "send") {
            for handler in step.object.as_deref().and_then(|object| facts.handled_by.get(object)).into_iter().flatten() {
                if let Some(node) = node_of.get(handler) {
                    deciding.insert(node.file as u64);
                }
            }
        }
        if answer.behaviours.len() > 1 && !alternatives(&answer.behaviours, flow, &deciding) {
            again.push((flow.id.clone(), told(flow, entry_of.get(flow.entry_point.as_str()).copied(), facts, &known, &landing, true)));
        }
    }
    let single = crate::memory::each("flow behaviour, one", crate::author::BEHAVIOURS_ASKED, &again, |items| asked_all(items, &steps_of));
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
                shaped.id = format!("{}:behaviour:{}", flow.id, at + 1);
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
    let mut flows = merged(settled, facts);
    let base_of = |id: &str| id.rsplit_once(":behaviour:").map(|(base, _)| base.to_string()).unwrap_or_else(|| id.to_string());
    let mut siblings: HashMap<String, usize> = HashMap::default();
    for flow in &flows {
        *siblings.entry(base_of(&flow.id)).or_default() += 1;
    }
    for flow in flows.iter_mut() {
        let base = base_of(&flow.id);
        if flow.id != base && siblings.get(&base) == Some(&1) {
            flow.id = base;
        }
    }
    held.flows = flows;
    hosting(held, facts, &project_of);
}

fn hosting<'a>(held: &mut Comprehension, facts: &Facts<'a>, project_of: &HashMap<&'a str, Option<&'a str>>) {
    let hosts = hosted_in(facts, project_of);
    if hosts.is_empty() {
        return;
    }
    let node_of: HashMap<&str, &IndexNode> = facts.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let entry_of: HashMap<&str, &EntryPoint> = facts.entries.iter().map(|entry| (entry.id.as_str(), entry)).collect();
    for flow in held.flows.iter_mut() {
        let Some(entry) = entry_of.get(flow.entry_point.as_str()) else { continue };
        let mut owner = node_of.get(entry.handler.as_str()).copied();
        while let Some(node) = owner.filter(|node| !node.kind.is_type()) {
            owner = node.parent.as_deref().and_then(|parent| node_of.get(parent).copied());
        }
        let Some(owner) = owner else { continue };
        if let Some(part) = hosts.get(owner.name.as_str())
            && Some(*part) != flow.project.as_deref()
        {
            flow.runs_in = Some(part.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, kind: &'static str, arms: &[&str]) -> crate::steps::LogicalStep {
        crate::steps::LogicalStep {
            id: id.to_string(),
            kind,
            label: id.to_string(),
            object: None,
            doing: None,
            when: if arms.is_empty() { "always" } else { "conditionally" },
            arms: arms.iter().map(|arm| arm.to_string()).collect(),
            regions: Vec::new(),
            description: None,
            lands_in: Vec::new(),
            gathers: Vec::new(),
        }
    }

    fn flow(steps: Vec<crate::steps::LogicalStep>) -> Flow {
        Flow {
            summary: String::new(),
            writes: Vec::new(),
            reads: Vec::new(),
            reaches: Vec::new(),
            id: "flow".to_string(),
            entry_point: "entry".to_string(),
            kind: "http",
            method: Some("POST".to_string()),
            operation: String::new(),
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
            steps,
            step_edges: Vec::new(),
            units: 1,
            rank: 0,
            stages: Vec::new(),
            changes: Vec::new(),
            leads_into: Vec::new(),
            project: None,
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capabilities: Vec::new(),
        }
    }

    #[test]
    fn consecutive_steps_that_do_one_thing_become_one_step_that_keeps_every_region() {
        let mut first = step("s1", "do", &[]);
        first.regions = vec![crate::steps::Region { unit: "a".to_string(), file: 0, start_line: 1, end_line: 1 }];
        let mut second = step("s2", "keep", &[]);
        second.object = Some("Order".to_string());
        second.regions = vec![crate::steps::Region { unit: "a".to_string(), file: 0, start_line: 2, end_line: 2 }];
        let third = step("s3", "respond", &[]);
        let held = flow(vec![first, second, third]);
        let behaviour = Behaviour {
            name: "Place an order".to_string(),
            outcome: String::new(),
            steps: vec![
                Said { id: "s1".to_string(), said: "Keep the new order".to_string(), with: vec!["s2".to_string()] },
                Said { id: "s3".to_string(), said: "Answer".to_string(), with: Vec::new() },
            ],
        };
        let steps = worded(&held, &behaviour, true);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].kind, "keep", "the gathered step does what its strongest member does");
        assert_eq!(steps[0].object.as_deref(), Some("Order"));
        assert_eq!(steps[0].regions.len(), 2, "no member's code is dropped");
        assert_eq!(steps[0].gathers, ["s1", "s2"]);
        assert_eq!(steps[0].description.as_deref(), Some("Keep the new order"));
    }

    fn behaviour(ids: &[&str]) -> Behaviour {
        Behaviour { name: String::new(), outcome: String::new(), steps: ids.iter().map(|id| Said { id: id.to_string(), said: String::new(), with: Vec::new() }).collect() }
    }

    const HERE: &str = "500000010.1";
    const THERE: &str = "500000010.2";
    const ELSEWHERE: &str = "900000010.2";

    #[test]
    fn outcomes_on_two_arms_of_the_handlers_own_decision_are_alternatives() {
        let flow = flow(vec![step("s1", "read", &[]), step("s2", "keep", &[HERE]), step("s3", "refuse", &[THERE])]);
        let deciding: HashSet<u64> = [5].into_iter().collect();
        assert!(alternatives(&[behaviour(&["s1", "s2"]), behaviour(&["s1", "s3"])], &flow, &deciding));
    }

    #[test]
    fn a_side_with_no_outcome_of_its_own_is_not_an_alternative() {
        let flow = flow(vec![step("s1", "read", &[HERE]), step("s2", "keep", &[THERE])]);
        let deciding: HashSet<u64> = [5].into_iter().collect();
        assert!(!alternatives(&[behaviour(&["s1"]), behaviour(&["s2"])], &flow, &deciding));
    }

    #[test]
    fn a_decision_made_somewhere_the_trigger_does_not_decide_is_not_a_split() {
        let flow = flow(vec![step("s1", "keep", &["900000010.1"]), step("s2", "keep", &[ELSEWHERE])]);
        let deciding: HashSet<u64> = [5].into_iter().collect();
        assert!(!alternatives(&[behaviour(&["s1"]), behaviour(&["s2"])], &flow, &deciding));
        let sent: HashSet<u64> = [5, 9].into_iter().collect();
        assert!(alternatives(&[behaviour(&["s1"]), behaviour(&["s2"])], &flow, &sent), "a sent command's handler decides for the flow");
    }

    #[test]
    fn a_flow_from_code_that_never_ships_is_never_offered_to_merge_with_a_product_flow() {
        let product = flow(Vec::new());
        let mut bench = flow(Vec::new());
        bench.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "shipping-evidence", evidence: String::new() });
        assert_ne!(merge_class(&product), merge_class(&bench));
    }
}

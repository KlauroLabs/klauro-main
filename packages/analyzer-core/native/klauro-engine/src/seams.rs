use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::Comprehension;
use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::{EdgeKind, IndexEdge, IndexNode};

const REACH_AT_MOST: usize = 20_000;

fn reached<'a>(starts: &[&'a str], next: &HashMap<&'a str, Vec<&'a str>>, stops: &HashSet<&'a str>) -> Vec<&'a str> {
    let mut seen: HashSet<&str> = starts.iter().copied().collect();
    let mut queue: Vec<&str> = starts.to_vec();
    let mut head = 0;
    while head < queue.len() && queue.len() < REACH_AT_MOST {
        let current = queue[head];
        head += 1;
        for target in next.get(current).into_iter().flatten() {
            if !stops.contains(target) && seen.insert(target) {
                queue.push(target);
            }
        }
    }
    queue
}

#[derive(Debug, Clone, Serialize)]
pub struct Seam {
    pub from: String,
    pub from_flow: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    pub via: &'static str,
    pub carries: String,
    pub to: String,
    pub to_entry: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub to_flows: Vec<String>,
}

pub fn join(
    comprehension: &mut Comprehension,
    entries: &[EntryPoint],
    exits: &[ExitPoint],
    files: &[String],
    part_of_file: &HashMap<u32, &str>,
    testing: &HashSet<&str>,
    started: &HashMap<(u32, u32), String>,
    nodes: &[IndexNode],
    edges: &[IndexEdge],
) {
    let callbacks: HashSet<&str> = nodes.iter().filter(|node| node.callback_of.is_some()).map(|node| node.id.as_str()).collect();
    let mut next: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges {
        let walks = match edge.kind {
            EdgeKind::Calls | EdgeKind::Instantiates => true,
            EdgeKind::Contains => callbacks.contains(edge.target.as_str()),
            _ => false,
        };
        if walks {
            next.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        }
    }
    let elsewhere: Vec<(&str, &str)> = entries
        .iter()
        .filter(|entry| !matches!(entry.kind, "export" | "test"))
        .filter_map(|entry| Some((entry.handler.as_str(), part_of_file.get(&entry.file).copied()?)))
        .collect();
    let handler_of: HashMap<&str, &str> = entries.iter().map(|entry| (entry.id.as_str(), entry.handler.as_str())).collect();
    let mut leaving: HashMap<&str, Vec<&ExitPoint>> = HashMap::default();
    for exit in exits.iter().filter(|exit| matches!(exit.kind, "api" | "network" | "process")) {
        leaving.entry(exit.source.as_str()).or_default().push(exit);
    }
    let mut programs: HashMap<&str, Vec<&EntryPoint>> = HashMap::default();
    for entry in entries.iter().filter(|entry| matches!(entry.kind, "cli" | "lifecycle")) {
        if let Some(part) = part_of_file.get(&entry.file) {
            programs.entry(*part).or_default().push(entry);
        }
    }
    let owner: HashMap<&str, &str> = files
        .iter()
        .enumerate()
        .filter_map(|(at, path)| Some((path.as_str(), part_of_file.get(&(at as u32)).copied()?)))
        .filter(|(_, part)| !testing.contains(part))
        .collect();
    let served = crate::composition::ServedRoutes::new(files, entries, &owner);
    let mut landing: HashMap<String, Vec<String>> = HashMap::default();
    for flow in &comprehension.flows {
        landing.entry(flow.entry_point.clone()).or_default().push(flow.id.clone());
        for other in &flow.entered_by {
            landing.entry(other.clone()).or_default().push(flow.id.clone());
        }
    }
    let entry_part: HashMap<&str, &str> = entries.iter().filter_map(|entry| Some((entry.id.as_str(), part_of_file.get(&entry.file).copied()?))).collect();
    let mut seams: Vec<Seam> = Vec::new();
    for flow in comprehension.flows.iter_mut() {
        let Some(home) = flow.runs_in.clone().or_else(|| flow.project.clone()) else { continue };
        if testing.contains(home.as_str()) || matches!(flow.kind, "test" | "export") {
            continue;
        }
        let starts: Vec<&str> = std::iter::once(flow.entry_point.as_str())
            .chain(flow.entered_by.iter().map(String::as_str))
            .filter_map(|entry| handler_of.get(entry).copied())
            .collect();
        let stops: HashSet<&str> = elsewhere.iter().filter(|(_, part)| *part != home.as_str()).map(|(handler, _)| *handler).collect();
        let mut called: Vec<&ExitPoint> = reached(&starts, &next, &stops)
            .into_iter()
            .flat_map(|unit| leaving.get(unit).into_iter().flatten().copied())
            .collect();
        called.sort_by(|left, right| left.id.cmp(&right.id));
        called.dedup_by(|left, right| left.id == right.id);
        for exit in called {
            if exit.kind == "process" {
                let Some(target) = started.get(&(exit.file, exit.line)).filter(|target| **target != home) else { continue };
                let step_id = flow
                    .steps
                    .iter()
                    .find(|step| step.regions.iter().any(|region| region.unit == exit.source && region.start_line <= exit.line && exit.line <= region.end_line.max(region.start_line)))
                    .map(|step| step.id.clone());
                for entry in programs.get(target.as_str()).into_iter().flatten() {
                    if !flow.leads_into.contains(&entry.id) {
                        flow.leads_into.push(entry.id.clone());
                    }
                    seams.push(Seam {
                        from: home.clone(),
                        from_flow: flow.id.clone(),
                        step: step_id.clone(),
                        via: "start",
                        carries: entry.name.clone(),
                        to: target.clone(),
                        to_entry: entry.id.clone(),
                        to_flows: landing.get(&entry.id).cloned().unwrap_or_default(),
                    });
                }
                continue;
            }
            let Some(path) = exit.addressed.as_deref().filter(|path| path.contains('/')) else { continue };
            let found = served.landing(exit, path);
            if found.iter().any(|(part, _)| *part == home.as_str()) {
                continue;
            }
            for (part, entry) in found {
                let step = flow
                    .steps
                    .iter_mut()
                    .find(|step| step.regions.iter().any(|region| region.unit == exit.source && region.start_line <= exit.line && exit.line <= region.end_line.max(region.start_line)));
                let step_id = step.as_ref().map(|step| step.id.clone());
                if let Some(step) = step
                    && !step.lands_in.contains(&entry.id)
                {
                    step.lands_in.push(entry.id.clone());
                }
                if !flow.leads_into.contains(&entry.id) {
                    flow.leads_into.push(entry.id.clone());
                }
                seams.push(Seam {
                    from: home.clone(),
                    from_flow: flow.id.clone(),
                    step: step_id,
                    via: match entry.kind {
                        "rpc" => "rpc",
                        _ => "http",
                    },
                    carries: format!("{} {}", entry.method.as_deref().unwrap_or("").to_ascii_uppercase(), entry.path.as_deref().unwrap_or_default()).trim().to_string(),
                    to: part.to_string(),
                    to_entry: entry.id.clone(),
                    to_flows: landing.get(&entry.id).cloned().unwrap_or_default(),
                });
            }
        }
        flow.leads_into.sort();
        flow.leads_into.dedup();
    }
    for flow in &comprehension.flows {
        let Some(home) = flow.runs_in.as_deref().or(flow.project.as_deref()) else { continue };
        for step in flow.steps.iter().filter(|step| matches!(step.kind, "raise" | "hand_off")) {
            let Some(message) = step.object.as_deref() else { continue };
            for into in &flow.leads_into {
                let Some(to) = entry_part.get(into.as_str()).copied() else { continue };
                let named = entries.iter().find(|entry| &entry.id == into).map(|entry| entry.name.as_str()).unwrap_or_default();
                if to == home || testing.contains(to) || !named.contains(message.trim_end_matches("IntegrationEvent")) {
                    continue;
                }
                seams.push(Seam {
                    from: home.to_string(),
                    from_flow: flow.id.clone(),
                    step: Some(step.id.clone()),
                    via: "message",
                    carries: message.to_string(),
                    to: to.to_string(),
                    to_entry: into.clone(),
                    to_flows: landing.get(into).cloned().unwrap_or_default(),
                });
            }
        }
    }
    let runs_in: HashMap<&str, &str> = comprehension
        .flows
        .iter()
        .filter_map(|flow| Some((flow.id.as_str(), flow.runs_in.as_deref().or(flow.project.as_deref())?)))
        .collect();
    for seam in seams.iter_mut() {
        let hosts: HashSet<&str> = seam.to_flows.iter().filter_map(|flow| runs_in.get(flow.as_str()).copied()).collect();
        if let [host] = hosts.into_iter().collect::<Vec<&str>>().as_slice() {
            seam.to = host.to_string();
        }
    }
    seams.retain(|seam| seam.to != seam.from);
    seams.sort_by(|left, right| (&left.from, &left.from_flow, &left.to_entry).cmp(&(&right.from, &right.from_flow, &right.to_entry)));
    seams.dedup_by(|left, right| left.from_flow == right.from_flow && left.to_entry == right.to_entry);
    comprehension.seams = seams;
}

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::Comprehension;
use crate::entry_exit::{EntryPoint, ExitPoint};

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

fn segments(path: &str) -> Vec<String> {
    let bare = path.split(['?', '#']).next().unwrap_or(path);
    let bare = match bare.find("://") {
        Some(at) => bare[at + 3..].split_once('/').map(|(_, rest)| rest).unwrap_or(""),
        None => bare,
    };
    bare.split('/').filter(|segment| !segment.is_empty()).map(|segment| segment.to_ascii_lowercase()).collect()
}

fn variable(segment: &str) -> bool {
    segment.starts_with('{') || segment.starts_with(':') || segment.starts_with('[') || segment.starts_with('<')
}

fn matches(called: &[String], route: &[String]) -> bool {
    let optional_tail = route.last().is_some_and(|last| last.ends_with("?}"));
    let fits = called.len() == route.len() || (optional_tail && called.len() + 1 == route.len());
    fits && called.iter().zip(route.iter()).all(|(asked, served)| asked == served || variable(asked) || variable(served))
}

fn closeness(called: &[String], route: &[String]) -> usize {
    called
        .iter()
        .zip(route.iter())
        .map(|(asked, served)| match (variable(asked), variable(served)) {
            (false, false) => 2,
            (true, true) => 2,
            (false, true) => 1,
            (true, false) => 0,
        })
        .sum()
}

pub fn join(comprehension: &mut Comprehension, entries: &[EntryPoint], exits: &[ExitPoint], part_of_file: &HashMap<u32, &str>, testing: &HashSet<&str>) {
    let mut leaving: HashMap<&str, Vec<&ExitPoint>> = HashMap::default();
    for exit in exits.iter().filter(|exit| matches!(exit.kind, "api" | "network")) {
        leaving.entry(exit.source.as_str()).or_default().push(exit);
    }
    let routes: Vec<(&EntryPoint, Vec<String>, &str)> = entries
        .iter()
        .filter(|entry| matches!(entry.kind, "http" | "rpc"))
        .filter_map(|entry| {
            let part = part_of_file.get(&entry.file).copied()?;
            (!testing.contains(part)).then_some(())?;
            Some((entry, segments(entry.path.as_deref()?), part))
        })
        .collect();
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
        let mut called: Vec<&ExitPoint> = flow
            .path
            .iter()
            .filter(|step| !step.leaves.is_empty())
            .flat_map(|step| leaving.get(step.unit.as_str()).into_iter().flatten().copied())
            .collect();
        called.sort_by(|left, right| left.id.cmp(&right.id));
        called.dedup_by(|left, right| left.id == right.id);
        for exit in called {
            let Some(path) = exit.addressed.as_deref().filter(|path| path.contains('/')) else { continue };
            let asked = segments(path);
            if asked.is_empty() {
                continue;
            }
            let method = exit.method.as_deref().map(str::to_ascii_uppercase);
            let mut found: Vec<&(&EntryPoint, Vec<String>, &str)> = routes
                .iter()
                .filter(|(entry, route, part)| {
                    *part != home.as_str()
                        && matches(&asked, route)
                        && match (method.as_deref(), entry.method.as_deref()) {
                            (Some(asked), Some(served)) => asked.eq_ignore_ascii_case(served),
                            (None, Some(served)) => !(matches!(exit.does, Some("write" | "send" | "delete")) && served.eq_ignore_ascii_case("GET")),
                            _ => true,
                        }
                })
                .collect();
            let best = found.iter().map(|(_, route, _)| closeness(&asked, route)).max().unwrap_or(0);
            found.retain(|(_, route, _)| closeness(&asked, route) == best);
            let parts: HashSet<&str> = found.iter().map(|(_, _, part)| *part).collect();
            if parts.len() != 1 {
                continue;
            }
            for (entry, _, part) in found {
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
    seams.sort_by(|left, right| (&left.from, &left.from_flow, &left.to_entry).cmp(&(&right.from, &right.from_flow, &right.to_entry)));
    seams.dedup_by(|left, right| left.from_flow == right.from_flow && left.to_entry == right.to_entry);
    comprehension.seams = seams;
}

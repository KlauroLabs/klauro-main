use std::collections::HashMap;

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct ProjectHealth {
    pub project: String,
    pub units: u32,
    pub reachable: u32,
    pub tested: u32,
    pub surfaces: u32,
    pub surfaces_tested: u32,
    pub gaps: u32,
    #[serde(skip_serializing_if = "is_zero")]
    pub commits: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct Health {
    pub projects: Vec<ProjectHealth>,
    pub noted: u32,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

const UNTESTED: f64 = 0.5;
const CHURNING: u32 = 40;

pub fn derive(
    nodes: &[IndexNode],
    files: &[String],
    entry_points: &[EntryPoint],
    graph: &crate::graph::GraphFacts,
    verification: &crate::verify::Verification,
    history: Option<&crate::history::History>,
) -> Health {
    let mut held: HashMap<&str, ProjectHealth> = HashMap::new();
    let mut of = |project: Option<&str>| project.unwrap_or("subproject:root").to_string();
    for (position, node) in nodes.iter().enumerate() {
        if !node.kind.is_unit()
            || files
                .get(node.file as usize)
                .is_none_or(|path| crate::paths::is_test(path))
        {
            continue;
        }
        let project = of(node.project.as_deref());
        let entry = held.entry(node.project.as_deref().unwrap_or("subproject:root")).or_insert_with(
            || ProjectHealth {
                project,
                units: 0,
                reachable: 0,
                tested: 0,
                surfaces: 0,
                surfaces_tested: 0,
                gaps: 0,
                commits: 0,
                notes: Vec::new(),
            },
        );
        entry.units += 1;
        if graph.served.get(position).copied().unwrap_or(false) {
            entry.reachable += 1;
            if graph.tested.get(position).copied().unwrap_or(false) {
                entry.tested += 1;
            }
        }
    }
    let position_of: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(position, node)| (node.id.as_str(), position))
        .collect();
    let project_of: HashMap<&str, &str> = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.project.as_deref().unwrap_or("subproject:root")))
        .collect();
    for entry in entry_points {
        if entry.kind == "test" {
            continue;
        }
        let project = project_of.get(entry.handler.as_str()).copied().unwrap_or("subproject:root");
        let Some(held) = held.get_mut(project) else { continue };
        held.surfaces += 1;
        if position_of
            .get(entry.handler.as_str())
            .is_some_and(|position| graph.tested.get(*position).copied().unwrap_or(false))
        {
            held.surfaces_tested += 1;
        }
    }
    for gap in &verification.gaps {
        let project = gap.project.as_deref().unwrap_or("subproject:root");
        if let Some(held) = held.get_mut(project) {
            held.gaps += 1;
        }
    }
    if let Some(history) = history {
        let project_of_file: HashMap<&str, &str> = nodes
            .iter()
            .filter_map(|node| {
                files
                    .get(node.file as usize)
                    .map(|path| (path.as_str(), node.project.as_deref().unwrap_or("subproject:root")))
            })
            .collect();
        for churn in &history.churn {
            let Some(project) = project_of_file.get(churn.path.as_str()) else { continue };
            if let Some(held) = held.get_mut(*project) {
                held.commits += churn.commits;
            }
        }
    }

    let mut projects: Vec<ProjectHealth> = held.into_values().collect();
    for project in projects.iter_mut() {
        if project.reachable > 0
            && f64::from(project.reachable - project.tested) / f64::from(project.reachable) > UNTESTED
        {
            project.notes.push("most of what it serves is untested");
        }
        if project.surfaces > 0 && project.surfaces_tested == 0 {
            project.notes.push("no surface it serves is exercised");
        }
        if project.commits >= CHURNING && project.tested == 0 {
            project.notes.push("changes often and no test reaches it");
        }
    }
    projects.sort_by(|left, right| left.project.cmp(&right.project));
    let noted = projects.iter().filter(|project| !project.notes.is_empty()).count() as u32;
    Health { projects, noted }
}

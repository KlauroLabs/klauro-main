use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::dependencies::Dependencies;
use crate::entry_exit::EntryPoint;
use crate::paths::file_of;
use crate::roles::Roles;
use crate::subproject::Partition;

#[derive(Debug, Serialize)]
pub struct Route {
    pub method: String,
    pub path: String,
    pub handler: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectArchitecture {
    pub project: String,
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entry_kinds: Vec<(String, u32)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<(String, u32)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<Route>,
    pub serves: bool,
}

#[derive(Debug, Serialize)]
pub struct Architecture {
    pub projects: Vec<ProjectArchitecture>,
    pub shape: &'static str,
    pub serving_projects: u32,
    pub routes: u32,
}

static SERVING_ENTRIES: &[&str] = &["graphql", "http", "rpc"];

fn tally(counts: HashMap<&str, u32>) -> Vec<(String, u32)> {
    let mut ranked: Vec<(String, u32)> = counts
        .into_iter()
        .map(|(name, count)| (name.to_string(), count))
        .collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    ranked
}

pub fn derive(
    partition: &Partition,
    entry_points: &[EntryPoint],
    roles: &Roles,
    dependencies: &Dependencies,
    files: &[String],
    project_of: &HashMap<&str, &str>,
) -> Architecture {
    let mut entry_kinds: HashMap<&str, HashMap<&str, u32>> = HashMap::new();
    let mut routes: HashMap<&str, Vec<Route>> = HashMap::new();
    for entry in entry_points {
        let Some(project) = files
            .get(entry.file as usize)
            .and_then(|path| project_of.get(path.as_str()))
            .copied()
            .or_else(|| project_of.get(file_of(&entry.handler)).copied())
        else {
            continue;
        };
        *entry_kinds
            .entry(project)
            .or_default()
            .entry(entry.kind)
            .or_insert(0) += 1;
        if let (Some(method), Some(path)) = (entry.method.as_deref(), entry.path.as_deref()) {
            routes.entry(project).or_default().push(Route {
                method: method.to_string(),
                path: path.to_string(),
                handler: entry.handler.clone(),
            });
        }
    }

    let mut project_roles: HashMap<&str, HashMap<&str, u32>> = HashMap::new();
    for role in &roles.roles {
        let Some(project) = role.project.as_deref() else { continue };
        *project_roles
            .entry(project)
            .or_default()
            .entry(role.role)
            .or_insert(0) += 1;
    }

    let mut categories: HashMap<&str, HashSet<&str>> = HashMap::new();
    for dependency in &dependencies.dependencies {
        if dependency.category.is_empty() {
            continue;
        }
        for project in &dependency.projects {
            categories
                .entry(project.as_str())
                .or_default()
                .insert(dependency.category);
        }
    }

    let mut projects: Vec<ProjectArchitecture> = partition
        .sub_projects
        .iter()
        .map(|project| {
            let id = project.id.as_str();
            let kinds = entry_kinds.remove(id).unwrap_or_default();
            let serves = kinds
                .keys()
                .any(|kind| SERVING_ENTRIES.binary_search(kind).is_ok());
            let mut named: Vec<String> = categories
                .remove(id)
                .unwrap_or_default()
                .into_iter()
                .map(str::to_string)
                .collect();
            named.sort();
            let mut found = routes.remove(id).unwrap_or_default();
            found.sort_by(|left, right| {
                left.path.cmp(&right.path).then(left.method.cmp(&right.method))
            });
            ProjectArchitecture {
                project: project.id.clone(),
                name: project.name.clone(),
                entry_kinds: tally(kinds),
                roles: tally(project_roles.remove(id).unwrap_or_default()),
                categories: named,
                routes: found,
                serves,
            }
        })
        .collect();
    projects.sort_by(|left, right| left.project.cmp(&right.project));

    let serving = projects.iter().filter(|project| project.serves).count() as u32;
    let total = projects.iter().map(|project| project.routes.len() as u32).sum();
    let composition = partition.sub_cas_nodes.composition;
    let shape = match (composition, serving) {
        ("container", _) => "unrelated systems",
        (_, 0) => "no served surface",
        (_, 1) => "single served surface",
        ("monorepo", _) => "several served surfaces",
        _ => "several served surfaces",
    };

    Architecture { projects, shape, serving_projects: serving, routes: total }
}

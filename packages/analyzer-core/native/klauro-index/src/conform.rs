use std::collections::HashMap;

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Convention {
    pub convention: &'static str,
    pub shape: String,
    pub population: u32,
    pub following: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub departing: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Sprawl {
    pub category: String,
    pub frameworks: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Conformance {
    pub conventions: Vec<Convention>,
    pub departures: u32,
    pub sprawl: Vec<Sprawl>,
}

const DEPARTURES_SHOWN: usize = 20;
const POPULATION_FLOOR: u32 = 8;
const FOLLOWING_FLOOR: f64 = 0.6;

fn shape_of(name: &str) -> &'static str {
    let stem = name.split('.').next().unwrap_or(name);
    if stem.is_empty() {
        return "";
    }
    if stem.contains('-') {
        return "dashed";
    }
    if stem.contains('_') {
        return "underscored";
    }
    match stem.starts_with(char::is_uppercase) {
        true => "capitalised",
        false => "plain",
    }
}

fn majority<'a>(counted: &HashMap<&'a str, Vec<String>>) -> Option<(&'a str, u32, u32)> {
    let population: u32 = counted.values().map(|members| members.len() as u32).sum();
    let (shape, members) = counted.iter().max_by_key(|(_, members)| members.len())?;
    let following = members.len() as u32;
    (population >= POPULATION_FLOOR && f64::from(following) / f64::from(population) >= FOLLOWING_FLOOR)
        .then_some((*shape, population, following))
}

fn convention(
    named: &'static str,
    counted: HashMap<&str, Vec<String>>,
    project: Option<String>,
) -> Option<Convention> {
    let (shape, population, following) = majority(&counted)?;
    let mut departing: Vec<String> = counted
        .iter()
        .filter(|(held, _)| **held != shape)
        .flat_map(|(_, members)| members.iter().cloned())
        .collect();
    departing.sort();
    departing.truncate(DEPARTURES_SHOWN);
    Some(Convention {
        convention: named,
        shape: shape.to_string(),
        population,
        following,
        departing,
        project,
    })
}

fn sprawling(dependencies: &crate::dependencies::Dependencies) -> Vec<Sprawl> {
    let mut by_category: HashMap<(&str, &str), Vec<String>> = HashMap::new();
    for dependency in &dependencies.dependencies {
        if dependency.role != "framework" || dependency.category.is_empty() {
            continue;
        }
        for project in dependency.projects.iter() {
            by_category
                .entry((dependency.category, project.as_str()))
                .or_default()
                .push(dependency.name.clone());
        }
    }
    let mut sprawl: Vec<Sprawl> = by_category
        .into_iter()
        .filter(|(_, frameworks)| frameworks.len() > 1)
        .map(|((category, project), mut frameworks)| {
            frameworks.sort();
            frameworks.dedup();
            Sprawl {
                category: category.to_string(),
                frameworks,
                project: Some(project.to_string()),
            }
        })
        .filter(|found| found.frameworks.len() > 1)
        .collect();
    sprawl.sort_by(|left, right| {
        left.project.cmp(&right.project).then(left.category.cmp(&right.category))
    });
    sprawl
}

pub fn derive(
    files: &[String],
    languages: &[&str],
    nodes: &[IndexNode],
    calls: &[CallFact],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    verification: &crate::verify::Verification,
    dependencies: &crate::dependencies::Dependencies,
) -> Conformance {
    let mut conventions = Vec::new();

    let mut naming: HashMap<&str, HashMap<&str, Vec<String>>> = HashMap::new();
    for (at, path) in files.iter().enumerate() {
        let language = languages.get(at).copied().unwrap_or_default();
        if language.is_empty() || crate::paths::is_test(path) {
            continue;
        }
        let shape = shape_of(crate::paths::basename(path));
        if shape.is_empty() {
            continue;
        }
        naming.entry(language).or_default().entry(shape).or_default().push(path.clone());
    }
    let mut languages_named: Vec<&&str> = naming.keys().collect();
    languages_named.sort();
    for language in languages_named {
        let counted = naming.get(*language).cloned().unwrap_or_default();
        if let Some(mut found) = convention("file-naming", counted, None) {
            found.shape = format!("{} {}", language, found.shape);
            conventions.push(found);
        }
    }

    let mut placement: HashMap<&str, Vec<String>> = HashMap::new();
    for case in &verification.cases {
        let Some(path) = files.get(case.file as usize) else { continue };
        let shape = match path.split('/').any(|step| {
            matches!(step, "test" | "tests" | "spec" | "specs" | "__tests__" | "e2e")
        }) {
            true => "under a test folder",
            false => "beside the code",
        };
        placement.entry(shape).or_default().push(path.clone());
    }
    conventions.extend(convention("test-placement", placement, None));

    let mut guarding: HashMap<&str, Vec<String>> = HashMap::new();
    let guarded: std::collections::HashSet<&str> = verification
        .invariants
        .iter()
        .flat_map(|invariant| invariant.holds.iter())
        .map(String::as_str)
        .collect();
    for entry in entry_points {
        if !matches!(entry.kind, "http" | "graphql" | "rpc") {
            continue;
        }
        let shape = match guarded.contains(entry.handler.as_str()) {
            true => "guarded",
            false => "open",
        };
        guarding.entry(shape).or_default().push(entry.handler.clone());
    }
    conventions.extend(convention("surface-guarding", guarding, None));

    let mut holding: HashMap<&str, Vec<String>> = HashMap::new();
    let leaving: std::collections::HashSet<(&str, u32)> = exit_points
        .iter()
        .map(|exit| (exit.source.as_str(), exit.line))
        .collect();
    for fact in calls {
        let Some(caller) = fact.caller.as_deref() else { continue };
        if !leaving.contains(&(caller, fact.line)) {
            continue;
        }
        let shape = match fact.context.in_try {
            true => "inside a try",
            false => "unguarded",
        };
        holding.entry(shape).or_default().push(format!("{caller}:{}", fact.line));
    }
    conventions.extend(convention("exit-handling", holding, None));

    let mut documented: HashMap<&str, Vec<String>> = HashMap::new();
    for node in nodes {
        if !node.kind.is_unit() || !node.modifiers.exported {
            continue;
        }
        let shape = match node.documentation.is_some() {
            true => "documented",
            false => "bare",
        };
        documented.entry(shape).or_default().push(node.id.clone());
    }
    conventions.extend(convention("exported-documentation", documented, None));

    conventions.sort_by(|left, right| {
        left.convention.cmp(right.convention).then(left.shape.cmp(&right.shape))
    });
    let departures = conventions
        .iter()
        .map(|found| found.population - found.following)
        .sum();
    Conformance { conventions, departures, sprawl: sprawling(dependencies) }
}

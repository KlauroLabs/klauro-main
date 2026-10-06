use std::collections::BTreeSet;

use rustc_hash::FxHashMap as HashMap;
use serde::Serialize;

use crate::dependencies::Dependencies;
use crate::model::ImportFact;

static LIBRARIES: &str = include_str!("../data/libraries.tsv");
static CATEGORIES: &str = include_str!("../data/library_categories.tsv");

const FUNCTIONS_SHOWN: usize = 12;
const FILES_SHOWN: usize = 3;

#[derive(Debug, Serialize)]
pub struct Usage {
    pub pattern: String,
    pub occurrences: u32,
    pub example_nodes: Vec<String>,
    pub functions_used: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Library {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub category: String,
    pub description: String,
    pub usage_patterns: Vec<Usage>,
}

fn rows(table: &'static str) -> impl Iterator<Item = (&'static str, &'static str)> {
    table.lines().filter_map(|line| line.split_once('\t'))
}

fn named_by(package: &str, prefix: &str) -> bool {
    package == prefix
        || package.strip_prefix(prefix).is_some_and(|rest| rest.starts_with(['/', '.']))
}

fn category_of(package: &str, declared: &'static str) -> Option<String> {
    rows(LIBRARIES)
        .filter(|(prefix, _)| named_by(package, prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, category)| category.to_string())
        .or_else(|| (!declared.is_empty()).then(|| declared.to_string()))
}

pub fn derive(dependencies: Option<&Dependencies>, imports: &[ImportFact], paths: &[String]) -> Vec<Library> {
    let Some(dependencies) = dependencies else { return Vec::new() };
    let guidance: HashMap<&str, &str> = rows(CATEGORIES).collect();
    let mut by_package: HashMap<&str, Vec<&ImportFact>> = HashMap::default();
    for held in imports.iter().filter(|held| !held.specifier.starts_with('.')) {
        if let Some(package) = crate::dependencies::package_of(&held.specifier) {
            by_package.entry(package).or_default().push(held);
        }
    }
    dependencies
        .dependencies
        .iter()
        .filter(|dependency| dependency.imports > 0)
        .filter_map(|dependency| {
            let category = category_of(&dependency.name, dependency.category)?;
            let held = by_package.get(dependency.name.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            let functions: BTreeSet<String> = held
                .iter()
                .flat_map(|import| import.names.iter())
                .map(|name| name.imported.clone().unwrap_or_else(|| name.local.clone()))
                .collect();
            let files: BTreeSet<&str> =
                held.iter().filter_map(|import| paths.get(import.file as usize).map(String::as_str)).collect();
            let usage = (!held.is_empty()).then(|| Usage {
                pattern: format!("{category} calls through {}", dependency.name),
                occurrences: held.len() as u32,
                example_nodes: files.into_iter().take(FILES_SHOWN).map(str::to_string).collect(),
                functions_used: functions.into_iter().take(FUNCTIONS_SHOWN).collect(),
            });
            Some(Library {
                id: format!("library:{}", dependency.name),
                name: dependency.name.clone(),
                version: dependency.version.clone(),
                kind: "production",
                description: guidance.get(category.as_str()).map(|held| held.to_string()).unwrap_or_default(),
                category,
                usage_patterns: usage.into_iter().collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scoped_package_is_named_by_its_scope_and_the_longest_name_wins() {
        assert_eq!(category_of("@temporalio/client", "").as_deref(), Some("workflow-engine"));
        assert_eq!(category_of("openai", "").as_deref(), Some("ai-sdk"));
        assert_eq!(category_of("openai-helpers", ""), None);
        assert_eq!(category_of("left-pad", ""), None);
        assert_eq!(category_of("left-pad", "data").as_deref(), Some("data"));
    }
}

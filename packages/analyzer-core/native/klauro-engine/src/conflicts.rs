use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use crate::layers::{rank_of, Layering};
use crate::model::IndexNode;
use crate::patterns::Conformance;

const NORM_SHARE: f64 = 0.7;
const COMPARABLE_AT_LEAST: usize = 3;
const FILES_SHOWN: usize = 5;
const SOURCE_ROOTS: &[&str] = &["src", "lib", "app", "source", "internal", "pkg", "cmd"];
const ENTRY_LAYERS: &[&str] = &["controller", "handler"];

#[derive(Debug, Serialize)]
pub struct Competing {
    pub label: String,
    pub files: Vec<String>,
    pub share: f64,
}

#[derive(Debug, Serialize)]
pub struct Conflict {
    pub id: String,
    pub kind: &'static str,
    pub concern: String,
    pub competing: Vec<Competing>,
    pub severity: &'static str,
    pub evidence: Vec<String>,
    pub suggested_alignment: String,
}

#[derive(Debug, Serialize)]
pub struct Violation {
    pub id: String,
    pub principle: &'static str,
    pub file: String,
    pub node_id: String,
    pub detail: String,
    pub severity: &'static str,
}

#[derive(Debug, Default)]
pub struct Conflicts {
    pub conflicts: Vec<Conflict>,
    pub violations: Vec<Violation>,
}

fn file_of(id: &str) -> &str {
    id.split(':').next().unwrap_or(id)
}

fn scope_of(file: &str) -> String {
    let segments: Vec<&str> = file.split('/').collect();
    match segments.iter().position(|segment| SOURCE_ROOTS.contains(segment)) {
        Some(at) => segments[..at].join("/"),
        None => String::new(),
    }
}

fn named(scope: &str) -> &str {
    if scope.is_empty() {
        "the repository root"
    } else {
        scope
    }
}

fn round(share: f64) -> f64 {
    (share * 100.0).round() / 100.0
}

#[derive(Default)]
struct Profile {
    through_service: bool,
    past_service: bool,
    deviating_unit: Option<String>,
}

fn severity_of(deviants: usize) -> &'static str {
    match deviants {
        0 | 1 => "low",
        2 => "medium",
        _ => "high",
    }
}

fn per_scope(layerings: &[Layering], node_file: &dyn Fn(&str) -> Option<String>) -> Conflicts {
    let mut found = Conflicts::default();
    let mut by_scope: BTreeMap<(Option<&str>, String), BTreeMap<String, Profile>> = BTreeMap::new();
    for layering in layerings {
        for unit in layering.reaching.iter().filter(|unit| ENTRY_LAYERS.contains(&unit.layer)) {
            let Some(file) = node_file(&unit.unit) else { continue };
            let through_service = unit.reaches.iter().any(|label| !label.contains(':') && rank_of(label) == 1);
            let past_service = unit.reaches.iter().any(|label| label.starts_with("database") || rank_of(label) >= 2);
            if !through_service && !past_service {
                continue;
            }
            let profile = by_scope
                .entry((layering.project.as_deref(), scope_of(&file)))
                .or_default()
                .entry(file)
                .or_default();
            profile.through_service |= through_service;
            if past_service && profile.deviating_unit.is_none() {
                profile.deviating_unit = Some(unit.unit.clone());
            }
            profile.past_service |= past_service;
        }
    }
    for ((_, scope), profiles) in by_scope {
        let total = profiles.len();
        if total < COMPARABLE_AT_LEAST {
            continue;
        }
        let layered = profiles.values().filter(|held| held.through_service && !held.past_service).count();
        let direct = profiles.values().filter(|held| held.past_service && !held.through_service).count();
        let layered_share = layered as f64 / total as f64;
        let direct_share = direct as f64 / total as f64;
        let layered_norm = layered_share >= NORM_SHARE;
        if !layered_norm && direct_share < NORM_SHARE {
            continue;
        }
        let deviates = |held: &Profile| {
            if layered_norm {
                held.past_service
            } else {
                held.through_service && !held.past_service
            }
        };
        let following = |held: &Profile| {
            if layered_norm {
                held.through_service && !held.past_service
            } else {
                held.past_service && !held.through_service
            }
        };
        let deviants: Vec<(&String, &Profile)> = profiles.iter().filter(|(_, held)| deviates(held)).collect();
        if deviants.is_empty() {
            continue;
        }
        let norm_label = if layered_norm {
            "entry-layer handlers call the service layer, which then reaches the repository"
        } else {
            "entry-layer handlers call repositories directly (no service layer in this scope)"
        };
        let deviation_label = if layered_norm {
            "direct repository call from an entry-layer handler (skipping the service layer)"
        } else {
            "entry-layer handler routed through a service layer, inconsistent with this scope's direct-repository convention"
        };
        let norm_files: Vec<String> =
            profiles.iter().filter(|(_, held)| following(held)).map(|(file, _)| file.clone()).take(FILES_SHOWN).collect();
        let deviant_files: Vec<String> = deviants.iter().map(|(file, _)| (*file).clone()).take(FILES_SHOWN).collect();
        found.conflicts.push(Conflict {
            id: format!("per-scope-layering:{}", if scope.is_empty() { "." } else { scope.as_str() }),
            kind: "pattern-conflict",
            concern: format!("entry-to-repository call path within {}", named(&scope)),
            competing: vec![
                Competing { label: norm_label.to_string(), files: norm_files, share: round(layered_share.max(direct_share)) },
                Competing {
                    label: deviation_label.to_string(),
                    files: deviant_files,
                    share: round(deviants.len() as f64 / total as f64),
                },
            ],
            severity: severity_of(deviants.len()),
            evidence: deviants
                .iter()
                .take(FILES_SHOWN)
                .map(|(file, _)| {
                    if layered_norm {
                        format!("{file}: calls the repository directly, skipping the service layer used elsewhere in {}", named(&scope))
                    } else {
                        format!("{file}: routes through a service layer, unlike other entry points in {}", named(&scope))
                    }
                })
                .collect(),
            suggested_alignment: format!(
                "Within {}, {}/{} comparable entry points follow \"{norm_label}\". Align the {} deviating site(s) on that local convention, or document why this scope's layering is deliberately split.",
                named(&scope),
                total - deviants.len(),
                total,
                deviants.len()
            ),
        });
        if layered_norm {
            for (file, held) in &deviants {
                let Some(unit) = held.deviating_unit.as_ref() else { continue };
                found.violations.push(Violation {
                    id: format!("layering:{unit}"),
                    principle: "layering",
                    file: (*file).clone(),
                    node_id: unit.clone(),
                    detail: format!("{unit} reaches past the service layer that the rest of {} goes through", named(&scope)),
                    severity: "warning",
                });
            }
        }
    }
    found
}

fn departures(conformance: &[Conformance]) -> Vec<Conflict> {
    conformance
        .iter()
        .filter(|held| !held.departing.is_empty() && held.population > 0)
        .map(|held| {
            let files: BTreeSet<String> = held.departing.iter().map(|id| file_of(id).to_string()).collect();
            let rate = round(held.following as f64 / held.population as f64);
            Conflict {
                id: format!("paradigm-conflict:{}", held.paradigm),
                kind: "pattern-conflict",
                concern: held.paradigm.to_string(),
                competing: vec![
                    Competing { label: format!("{} of {} follow it", held.following, held.population), files: Vec::new(), share: rate },
                    Competing {
                        label: format!("departs from: {}", held.paradigm),
                        files: files.iter().take(FILES_SHOWN).cloned().collect(),
                        share: round(1.0 - rate),
                    },
                ],
                severity: if held.departing.len() >= 3 { "medium" } else { "low" },
                evidence: held.departing.iter().take(FILES_SHOWN).cloned().collect(),
                suggested_alignment: format!(
                    "Align the {} deviating site(s) on \"{}\" (already followed by {}/{} comparable sites), or document why they are exempt.",
                    files.len(),
                    held.paradigm,
                    held.following,
                    held.population
                ),
            }
        })
        .collect()
}

pub fn derive(layerings: &[Layering], nodes: &[IndexNode], paths: &[String], conformance: &[Conformance]) -> Conflicts {
    let file_at: HashMap<&str, u32> = nodes.iter().map(|node| (node.id.as_str(), node.file)).collect();
    let node_file = |id: &str| file_at.get(id).and_then(|at| paths.get(*at as usize)).map(|path| path.clone());
    let mut found = per_scope(layerings, &node_file);
    found.conflicts.extend(departures(conformance));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::Reaching;

    fn controller(unit: &str, reaches: &[&str]) -> Reaching {
        Reaching { unit: unit.to_string(), layer: "controller", reaches: reaches.iter().map(|held| held.to_string()).collect() }
    }

    fn layering(reaching: Vec<Reaching>) -> Layering {
        Layering { project: None, paths: Vec::new(), transitions: Vec::new(), departures: Vec::new(), reaching }
    }

    fn files(id: &str) -> Option<String> {
        Some(file_of(id).to_string())
    }

    #[test]
    fn a_handler_that_skips_the_service_layer_its_scope_goes_through_is_the_deviation() {
        let reaching = vec![
            controller("src/a.ts:method:run", &["service"]),
            controller("src/b.ts:method:run", &["service"]),
            controller("src/c.ts:method:run", &["service"]),
            controller("src/d.ts:method:run", &["service"]),
            controller("src/e.ts:method:run", &["repository"]),
        ];
        let found = per_scope(&[layering(reaching)], &files);
        assert_eq!(found.conflicts.len(), 1);
        assert_eq!(found.conflicts[0].competing[1].files, vec!["src/e.ts".to_string()]);
        assert_eq!(found.violations.len(), 1);
    }

    #[test]
    fn a_scope_whose_handlers_all_go_direct_has_no_deviation() {
        let reaching = (0..4).map(|at| controller(&format!("src/{at}.ts:method:run"), &["repository"])).collect();
        let found = per_scope(&[layering(reaching)], &files);
        assert!(found.conflicts.is_empty());
    }

    #[test]
    fn two_apps_with_different_norms_are_judged_apart() {
        let mut reaching = Vec::new();
        for at in 0..4 {
            reaching.push(controller(&format!("apps/api/src/{at}.ts:method:run"), &["service"]));
            reaching.push(controller(&format!("apps/site/src/{at}.ts:method:run"), &["repository"]));
        }
        reaching.push(controller("apps/api/src/x.ts:method:run", &["repository"]));
        let found = per_scope(&[layering(reaching)], &files);
        assert_eq!(found.conflicts.len(), 1);
        assert_eq!(found.conflicts[0].id, "per-scope-layering:apps/api");
    }
}

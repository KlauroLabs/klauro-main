use std::collections::BTreeMap;

use rustc_hash::FxHashMap as HashMap;
use serde::Serialize;

use crate::entry_exit::ExitPoint;
use crate::model::IndexNode;

pub const STAGED_FROM_UNITS: usize = 300;
const STAGES_KEPT: usize = 60;
const LEAST_UNITS_PER_STAGE: u32 = 3;
const NAMES_KEPT: usize = 8;
const LEAVES_KEPT: usize = 4;

#[derive(Debug, Serialize, Clone)]
pub struct Stage {
    pub module: String,
    pub units: u32,
    pub names: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leaves: Vec<String>,
}

pub fn of_reach(
    reached: &[u32],
    part: Option<&str>,
    is_a_program: bool,
    nodes: &[IndexNode],
    files: &[String],
    leaving: &HashMap<&str, Vec<&ExitPoint>>,
) -> Vec<Stage> {
    if reached.len() < STAGED_FROM_UNITS && !is_a_program {
        return Vec::new();
    }
    struct Held<'a> {
        units: u32,
        names: Vec<&'a str>,
        leaves: BTreeMap<&'a str, u32>,
    }
    let mut by_file: BTreeMap<u32, Held> = BTreeMap::new();
    for at in reached {
        let node = &nodes[*at as usize];
        if node.project.as_deref() != part || !node.kind.is_unit() {
            continue;
        }
        let Some(path) = files.get(node.file as usize) else { continue };
        if crate::paths::is_test(path) {
            continue;
        }
        let held = by_file.entry(node.file).or_insert_with(|| Held { units: 0, names: Vec::new(), leaves: BTreeMap::new() });
        held.units += 1;
        if held.names.len() < NAMES_KEPT && !held.names.contains(&node.name.as_str()) {
            held.names.push(node.name.as_str());
        }
        for exit in leaving.get(node.id.as_str()).into_iter().flatten() {
            *held.leaves.entry(exit.kind).or_default() += 1;
        }
    }
    let mut stages: Vec<Stage> = by_file
        .into_iter()
        .filter(|(_, held)| held.units >= LEAST_UNITS_PER_STAGE)
        .map(|(file, held)| {
            let mut leaves: Vec<(&str, u32)> = held.leaves.into_iter().collect();
            leaves.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
            Stage {
                module: files[file as usize].clone(),
                units: held.units,
                names: held.names.into_iter().map(str::to_string).collect(),
                leaves: leaves.into_iter().take(LEAVES_KEPT).map(|(kind, _)| kind.to_string()).collect(),
            }
        })
        .collect();
    stages.sort_by(|left, right| right.units.cmp(&left.units).then(left.module.cmp(&right.module)));
    stages.truncate(STAGES_KEPT);
    stages.sort_by(|left, right| left.module.cmp(&right.module));
    stages
}

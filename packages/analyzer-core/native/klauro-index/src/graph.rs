use std::collections::HashMap;

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Reach {
    pub node: String,
    pub fan_in: u32,
    pub fan_out: u32,
    pub entry_points: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct EntryReach {
    pub entry_point: String,
    pub units: u32,
    pub depth: u32,
    pub exits: u32,
}

#[derive(Debug, Serialize)]
pub struct GraphFacts {
    pub reach: Vec<Reach>,
    pub entry_reach: Vec<EntryReach>,
    pub unreachable_units: u32,
    pub reachable_units: u32,
}

struct Adjacency {
    offsets: Vec<u32>,
    targets: Vec<u32>,
}

fn build_adjacency(count: usize, pairs: &mut Vec<(u32, u32)>) -> Adjacency {
    pairs.sort_unstable();
    pairs.dedup();
    let mut offsets = vec![0u32; count + 1];
    for (source, _) in pairs.iter() {
        offsets[*source as usize + 1] += 1;
    }
    for position in 1..offsets.len() {
        offsets[position] += offsets[position - 1];
    }
    let mut targets = vec![0u32; pairs.len()];
    let mut cursor = offsets.clone();
    for (source, target) in pairs.iter() {
        targets[cursor[*source as usize] as usize] = *target;
        cursor[*source as usize] += 1;
    }
    Adjacency { offsets, targets }
}

pub fn derive(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    exits_by_unit: &HashMap<String, u32>,
) -> GraphFacts {
    let position_of: HashMap<&str, u32> = nodes
        .iter()
        .enumerate()
        .map(|(position, node)| (node.id.as_str(), position as u32))
        .collect();

    let mut pairs: Vec<(u32, u32)> = Vec::new();
    let mut fan_in = vec![0u32; nodes.len()];
    let mut fan_out = vec![0u32; nodes.len()];
    let is_callback: Vec<bool> = nodes.iter().map(|node| node.callback_of.is_some()).collect();
    for edge in edges {
        let (Some(source), Some(target)) = (
            position_of.get(edge.source.as_str()),
            position_of.get(edge.target.as_str()),
        ) else {
            continue;
        };
        match edge.kind {
            EdgeKind::Calls | EdgeKind::Instantiates => {
                pairs.push((*source, *target));
                fan_out[*source as usize] += 1;
                fan_in[*target as usize] += 1;
            }
            EdgeKind::Contains if is_callback[*target as usize] => {
                pairs.push((*source, *target));
            }
            _ => {}
        }
    }
    let adjacency = build_adjacency(nodes.len(), &mut pairs);

    let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
    for edge in edges {
        if !matches!(edge.kind, EdgeKind::HasMethod) {
            continue;
        }
        let (Some(source), Some(target)) = (
            position_of.get(edge.source.as_str()),
            position_of.get(edge.target.as_str()),
        ) else {
            continue;
        };
        members.entry(*source).or_default().push(*target);
    }

    let mut depth = vec![u32::MAX; nodes.len()];
    let mut entry_count = vec![0u32; nodes.len()];
    let mut queue: Vec<u32> = Vec::new();
    let seed = |position: u32, depth: &mut Vec<u32>, queue: &mut Vec<u32>| {
        if depth[position as usize] == u32::MAX {
            depth[position as usize] = 0;
            queue.push(position);
        }
    };
    for entry in entry_points {
        let Some(position) = position_of.get(entry.handler.as_str()).copied() else {
            continue;
        };
        seed(position, &mut depth, &mut queue);
        if nodes[position as usize].kind.is_type() {
            for member in members.get(&position).into_iter().flatten() {
                seed(*member, &mut depth, &mut queue);
            }
        }
    }
    let mut head = 0;
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        let next = depth[current as usize] + 1;
        let start = adjacency.offsets[current as usize] as usize;
        let end = adjacency.offsets[current as usize + 1] as usize;
        for target in &adjacency.targets[start..end] {
            if depth[*target as usize] == u32::MAX {
                depth[*target as usize] = next;
                queue.push(*target);
            }
        }
    }

    let mut entry_reach = Vec::with_capacity(entry_points.len());
    let mut seen = vec![u32::MAX; nodes.len()];
    let mut frontier: Vec<u32> = Vec::new();
    for (generation, entry) in entry_points.iter().enumerate() {
        let generation = generation as u32;
        let Some(start) = position_of.get(entry.handler.as_str()).copied() else {
            entry_reach.push(EntryReach {
                entry_point: entry.id.clone(),
                units: 0,
                depth: 0,
                exits: 0,
            });
            continue;
        };
        frontier.clear();
        frontier.push(start);
        seen[start as usize] = generation;
        entry_count[start as usize] += 1;
        let mut head = 0;
        let mut units = 0u32;
        let mut deepest = 0u32;
        let mut exits = exits_by_unit.get(&nodes[start as usize].id).copied().unwrap_or(0);
        let mut levels: Vec<u32> = vec![0];
        while head < frontier.len() {
            let current = frontier[head];
            let level = levels[head];
            head += 1;
            units += 1;
            deepest = deepest.max(level);
            let begin = adjacency.offsets[current as usize] as usize;
            let end = adjacency.offsets[current as usize + 1] as usize;
            for target in &adjacency.targets[begin..end] {
                if seen[*target as usize] != generation {
                    seen[*target as usize] = generation;
                    entry_count[*target as usize] += 1;
                    exits += exits_by_unit
                        .get(&nodes[*target as usize].id)
                        .copied()
                        .unwrap_or(0);
                    frontier.push(*target);
                    levels.push(level + 1);
                }
            }
        }
        entry_reach.push(EntryReach {
            entry_point: entry.id.clone(),
            units: units.saturating_sub(1),
            depth: deepest,
            exits,
        });
    }

    let mut reach = Vec::with_capacity(nodes.len());
    let mut reachable_units = 0;
    let mut unreachable_units = 0;
    for (position, node) in nodes.iter().enumerate() {
        if !matches!(
            node.kind,
            NodeKind::Function
                | NodeKind::Method
                | NodeKind::Constructor
                | NodeKind::Getter
                | NodeKind::Setter
        ) {
            continue;
        }
        if depth[position] == u32::MAX {
            unreachable_units += 1;
        } else {
            reachable_units += 1;
        }
        if fan_in[position] == 0 && fan_out[position] == 0 && entry_count[position] == 0 {
            continue;
        }
        reach.push(Reach {
            node: node.id.clone(),
            fan_in: fan_in[position],
            fan_out: fan_out[position],
            entry_points: entry_count[position],
            depth: if depth[position] == u32::MAX {
                None
            } else {
                Some(depth[position])
            },
        });
    }

    GraphFacts { reach, entry_reach, unreachable_units, reachable_units }
}

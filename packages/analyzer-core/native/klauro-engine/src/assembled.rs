use std::collections::BTreeMap;

use crate::comprehend::Flow;

const NEIGHBOURS: usize = 5;
const KEPT_WEIGHS: f64 = 2.0;
const READ_WEIGHS: f64 = 1.0;
const TOO_COMMON: f64 = 0.5;
const BETTER_BY: f64 = 1e-10;

fn words(text: &str) -> Vec<String> {
    let mut spaced = String::new();
    let mut previous: Option<char> = None;
    for letter in text.chars() {
        if letter.is_uppercase() && previous.is_some_and(|before| before.is_lowercase() || before.is_ascii_digit()) {
            spaced.push(' ');
        }
        spaced.push(letter);
        previous = Some(letter);
    }
    spaced
        .split(|letter: char| !letter.is_ascii_alphabetic())
        .filter(|word| word.len() > 2)
        .map(|word| {
            let lowered = word.to_lowercase();
            lowered.strip_suffix('s').map(str::to_string).unwrap_or(lowered)
        })
        .collect()
}

pub(crate) fn evidence_of(flow: &Flow) -> BTreeMap<String, f64> {
    let mut held: BTreeMap<String, f64> = BTreeMap::new();
    let mut add = |fact: String, count: f64| *held.entry(fact).or_default() += count;
    for record in &flow.writes {
        add(format!("record:{record}"), KEPT_WEIGHS);
    }
    for record in &flow.reads {
        add(format!("record:{record}"), READ_WEIGHS);
    }
    let route: Vec<&str> = match flow.kind {
        "export" => Vec::new(),
        _ => flow.surface.as_deref().unwrap_or_default().split('/').filter(|part| !part.is_empty() && !part.starts_with(['{', ':', '<', '*'])).collect(),
    };
    for reach in 1..=route.len() {
        add(format!("route:{}", route[..reach].join("/")), 1.0);
    }
    let start = flow.path.first().map(|step| step.unit.as_str()).unwrap_or_default();
    let file = start.split(':').next().unwrap_or_default();
    let folders: Vec<&str> = file.split('/').filter(|part| !part.is_empty()).collect();
    for reach in 1..folders.len() {
        add(format!("folder:{}", folders[..reach].join("/")), 1.0);
    }
    if !file.is_empty() {
        add(format!("file:{file}"), 1.0);
    }
    for step in &flow.path {
        if !step.unit.is_empty() && step.unit != start {
            add(format!("reaches:{}", step.unit), 1.0);
        }
    }
    let stem = folders.last().map(|name| name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name)).unwrap_or_default();
    let symbol = start.rsplit(':').next().unwrap_or_default();
    for word in words(stem).into_iter().chain(words(symbol)).chain(route.iter().flat_map(|part| words(part))) {
        add(format!("word:{word}"), 1.0);
    }
    held
}

fn similarities(evidence: &[BTreeMap<String, f64>]) -> Vec<Vec<(usize, f64)>> {
    let count = evidence.len();
    let mut seen_in: BTreeMap<&str, usize> = BTreeMap::new();
    for held in evidence {
        for fact in held.keys() {
            *seen_in.entry(fact.as_str()).or_default() += 1;
        }
    }
    let weighed: Vec<BTreeMap<&str, f64>> = evidence
        .iter()
        .map(|held| {
            let mut vector: BTreeMap<&str, f64> = held
                .iter()
                .filter_map(|(fact, times)| {
                    let seen = *seen_in.get(fact.as_str())?;
                    (seen >= 2 && (seen as f64) <= TOO_COMMON * count as f64).then(|| (fact.as_str(), (1.0 + times.ln()) * (count as f64 / seen as f64).ln()))
                })
                .collect();
            let length = vector.values().map(|value| value * value).sum::<f64>().sqrt();
            if length > 0.0 {
                vector.values_mut().for_each(|value| *value /= length);
            }
            vector
        })
        .collect();
    let mut holders: BTreeMap<&str, Vec<(usize, f64)>> = BTreeMap::new();
    for (at, vector) in weighed.iter().enumerate() {
        for (fact, value) in vector {
            holders.entry(fact).or_default().push((at, *value));
        }
    }
    weighed
        .iter()
        .enumerate()
        .map(|(at, vector)| {
            let mut alike: BTreeMap<usize, f64> = BTreeMap::new();
            for (fact, value) in vector {
                for (other, theirs) in &holders[fact] {
                    if *other != at {
                        *alike.entry(*other).or_default() += value * theirs;
                    }
                }
            }
            let mut ranked: Vec<(usize, f64)> = alike.into_iter().filter(|(_, held)| *held > 0.0).collect();
            ranked.sort_by(|left, right| right.1.total_cmp(&left.1).then(left.0.cmp(&right.0)));
            ranked.truncate(NEIGHBOURS);
            ranked
        })
        .collect()
}

fn linked(nearest: &[Vec<(usize, f64)>]) -> BTreeMap<(usize, usize), f64> {
    let mut edges: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    for (at, ranked) in nearest.iter().enumerate() {
        for (other, weight) in ranked {
            let key = (at.min(*other), at.max(*other));
            let held = edges.entry(key).or_default();
            *held = held.max(*weight);
        }
    }
    edges
}

fn plogp(value: f64) -> f64 {
    if value > 0.0 { value * value.log2() } else { 0.0 }
}

struct Level {
    flow: Vec<f64>,
    leaving: Vec<f64>,
    links: Vec<BTreeMap<usize, f64>>,
}

fn moved(level: &Level, total: f64) -> Option<Vec<usize>> {
    let size = level.flow.len();
    let mut module: Vec<usize> = (0..size).collect();
    let mut flow_of: Vec<f64> = level.flow.clone();
    let mut exit_of: Vec<f64> = level.leaving.iter().map(|leaving| leaving / total).collect();
    let mut exits: f64 = exit_of.iter().sum();
    let mut changed_any = false;
    loop {
        let mut changed = false;
        for node in 0..size {
            let from = module[node];
            let mut toward: BTreeMap<usize, f64> = BTreeMap::new();
            for (other, weight) in &level.links[node] {
                if *other != node {
                    *toward.entry(module[*other]).or_default() += weight / total;
                }
            }
            let leaving = level.leaving[node] / total;
            let into_from = toward.get(&from).copied().unwrap_or_default();
            let exit_from_after = exit_of[from] - leaving + 2.0 * into_from;
            let flow_from_after = flow_of[from] - level.flow[node];
            let before_from = -2.0 * plogp(exit_of[from]) + plogp(exit_of[from] + flow_of[from]);
            let after_from = -2.0 * plogp(exit_from_after) + plogp(exit_from_after + flow_from_after);
            let mut best: Option<(f64, usize, f64)> = None;
            for (target, into) in &toward {
                if *target == from {
                    continue;
                }
                let exit_to_after = exit_of[*target] + leaving - 2.0 * into;
                let flow_to_after = flow_of[*target] + level.flow[node];
                let exits_after = exits - exit_of[from] - exit_of[*target] + exit_from_after + exit_to_after;
                let delta = plogp(exits_after) - plogp(exits) + after_from - before_from
                    + (-2.0 * plogp(exit_to_after) + plogp(exit_to_after + flow_to_after))
                    - (-2.0 * plogp(exit_of[*target]) + plogp(exit_of[*target] + flow_of[*target]));
                if delta < -BETTER_BY && best.is_none_or(|(held, _, _)| delta < held - BETTER_BY) {
                    best = Some((delta, *target, exit_to_after));
                }
            }
            if let Some((_, target, exit_to_after)) = best {
                exits = exits - exit_of[from] - exit_of[target] + exit_from_after + exit_to_after;
                exit_of[from] = exit_from_after;
                exit_of[target] = exit_to_after;
                flow_of[from] = flow_from_after;
                flow_of[target] += level.flow[node];
                module[node] = target;
                changed = true;
                changed_any = true;
            }
        }
        if !changed {
            break;
        }
    }
    changed_any.then_some(module)
}

fn coarsened(level: &Level, module: &[usize]) -> (Level, Vec<usize>) {
    let mut renumbered: BTreeMap<usize, usize> = BTreeMap::new();
    for held in module {
        let next = renumbered.len();
        renumbered.entry(*held).or_insert(next);
    }
    let size = renumbered.len();
    let into: Vec<usize> = module.iter().map(|held| renumbered[held]).collect();
    let mut flow = vec![0.0; size];
    let mut links: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); size];
    for (node, held) in into.iter().enumerate() {
        flow[*held] += level.flow[node];
        for (other, weight) in &level.links[node] {
            if into[*other] != *held {
                *links[*held].entry(into[*other]).or_default() += weight;
            }
        }
    }
    let leaving = links.iter().map(|held| held.values().sum()).collect();
    (Level { flow, leaving, links }, into)
}

pub(crate) fn modules(count: usize, edges: &BTreeMap<(usize, usize), f64>) -> Vec<usize> {
    let mut links: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); count];
    for ((left, right), weight) in edges {
        *links[*left].entry(*right).or_default() += weight;
        *links[*right].entry(*left).or_default() += weight;
    }
    let total: f64 = edges.values().sum::<f64>() * 2.0;
    if total <= 0.0 {
        return (0..count).collect();
    }
    let leaving: Vec<f64> = links.iter().map(|held| held.values().sum()).collect();
    let flow: Vec<f64> = leaving.iter().map(|held| held / total).collect();
    let mut level = Level { flow, leaving, links };
    let mut belongs: Vec<usize> = (0..count).collect();
    while let Some(module) = moved(&level, total) {
        let (next, into) = coarsened(&level, &module);
        belongs = belongs.iter().map(|held| into[*held]).collect();
        level = next;
    }
    belongs
}

pub(crate) struct Assembled {
    pub groups: Vec<Vec<usize>>,
}

pub(crate) fn assembled(flows: &[&Flow]) -> Assembled {
    let evidence: Vec<BTreeMap<String, f64>> = flows.iter().map(|flow| evidence_of(flow)).collect();
    let belongs = modules(flows.len(), &linked(&similarities(&evidence)));
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (at, held) in belongs.iter().enumerate() {
        groups.entry(*held).or_default().push(at);
    }
    let mut groups: Vec<Vec<usize>> = groups.into_values().collect();
    groups.sort_by(|left, right| right.len().cmp(&left.len()).then(left.cmp(right)));
    Assembled { groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_tight_groups_joined_by_one_link_are_two_modules_every_time() {
        let mut edges = BTreeMap::new();
        for (left, right) in [(0, 1), (0, 2), (1, 2), (3, 4), (3, 5), (4, 5)] {
            edges.insert((left, right), 1.0);
        }
        edges.insert((2, 3), 0.1);
        let first = modules(6, &edges);
        assert_eq!(first, modules(6, &edges));
        assert_eq!(first[0], first[1]);
        assert_eq!(first[1], first[2]);
        assert_eq!(first[3], first[4]);
        assert_eq!(first[4], first[5]);
        assert_ne!(first[0], first[3]);
    }

    #[test]
    fn a_node_with_no_link_stands_alone() {
        let edges = BTreeMap::from([((0, 1), 1.0)]);
        let held = modules(3, &edges);
        assert_eq!(held[0], held[1]);
        assert_ne!(held[2], held[0]);
    }

    #[test]
    fn identifier_words_are_split_lowered_and_made_singular() {
        assert_eq!(words("VaultContactsController"), ["vault", "contact", "controller"]);
        assert_eq!(words("update_user_settings"), ["update", "user", "setting"]);
    }

    #[test]
    fn flows_that_share_rare_facts_are_each_others_nearest() {
        let facts = |held: &[&str]| held.iter().map(|fact| (fact.to_string(), 1.0)).collect::<BTreeMap<String, f64>>();
        let evidence = vec![facts(&["record:Order", "route:orders"]), facts(&["record:Order", "route:orders"]), facts(&["record:Product", "route:products"]), facts(&["record:Product", "route:products"]), facts(&["route:orders"]), facts(&["route:products"])];
        let nearest = similarities(&evidence);
        assert_eq!(nearest[0][0].0, 1);
        assert_eq!(nearest[2][0].0, 3);
    }
}

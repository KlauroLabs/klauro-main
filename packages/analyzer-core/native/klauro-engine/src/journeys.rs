use std::collections::VecDeque;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::crossings::Crossing;
use crate::entry_exit::ExitPoint;
use crate::model::{EdgeKind, IndexEdge, IndexNode};
use crate::paths::is_test;

const HOPS: usize = 3;
const MOST_CROSSINGS: usize = 6;
const MOST_BRANCHES: usize = 3;
const MOST_JOURNEYS: usize = 400;
const MOST_REPRESENTATIVE: usize = 6;

static EFFECT_KINDS: &[&str] = &["database", "message", "process", "network", "api", "file"];

#[derive(Debug, Serialize)]
pub struct Step {
    pub file: String,
    pub symbol: String,
    pub does: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Journey {
    pub id: String,
    pub label: String,
    pub does: String,
    pub rank: u32,
    pub representative: bool,
    pub steps: Vec<Step>,
}

struct Graph<'a> {
    files: &'a [String],
    nodes: HashMap<&'a str, &'a IndexNode>,
    calls: HashMap<&'a str, Vec<&'a str>>,
    exits: HashMap<&'a str, Vec<&'a ExitPoint>>,
}

fn humanized(symbol: &str) -> String {
    let mut spoken = String::new();
    let mut before: Option<char> = None;
    for letter in symbol.chars() {
        match letter {
            '_' | '-' | '.' | ':' | '#' => {
                if !spoken.ends_with(' ') && !spoken.is_empty() {
                    spoken.push(' ');
                }
            }
            _ => {
                if letter.is_uppercase() && before.is_some_and(|held| held.is_lowercase() || held.is_ascii_digit()) {
                    spoken.push(' ');
                }
                spoken.push(letter.to_ascii_lowercase());
            }
        }
        before = Some(letter);
    }
    let spoken = spoken.trim().to_string();
    let mut letters = spoken.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => spoken,
    }
}

impl<'a> Graph<'a> {
    fn new(files: &'a [String], nodes: &'a [IndexNode], edges: &'a [IndexEdge], exit_points: &'a [ExitPoint]) -> Self {
        let mut calls: HashMap<&str, Vec<&str>> = HashMap::default();
        for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Calls) {
            calls.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        }
        let mut exits: HashMap<&str, Vec<&ExitPoint>> = HashMap::default();
        for exit in exit_points.iter().filter(|exit| EFFECT_KINDS.contains(&exit.kind)) {
            exits.entry(exit.source.as_str()).or_default().push(exit);
        }
        Graph { files, nodes: nodes.iter().map(|node| (node.id.as_str(), node)).collect(), calls, exits }
    }

    fn named_unit(&self, unit: &str) -> Option<&'a IndexNode> {
        let mut held = *self.nodes.get(unit)?;
        for _ in 0..16 {
            if !held.id.contains(":callback:") || !held.kind.is_unit() {
                return Some(held);
            }
            match held.parent.as_deref().and_then(|parent| self.nodes.get(parent)) {
                Some(parent) => held = parent,
                None => return Some(held),
            }
        }
        Some(held)
    }

    fn within(&self, from: &'a str, reach: usize) -> HashMap<&'a str, Option<&'a str>> {
        let mut seen: HashMap<&str, Option<&str>> = HashMap::default();
        seen.insert(from, None);
        let mut queue: VecDeque<(&str, usize)> = VecDeque::from([(from, 0)]);
        while let Some((unit, depth)) = queue.pop_front() {
            if depth == reach {
                continue;
            }
            for next in self.calls.get(unit).into_iter().flatten() {
                if !seen.contains_key(next) {
                    seen.insert(next, Some(unit));
                    queue.push_back((next, depth + 1));
                }
            }
        }
        seen
    }

    fn path(&self, reached: &HashMap<&'a str, Option<&'a str>>, to: &'a str) -> Vec<&'a str> {
        let mut path = vec![to];
        let mut held = to;
        while let Some(Some(before)) = reached.get(held) {
            path.push(before);
            held = before;
        }
        path.reverse();
        path
    }

    fn step(&self, unit: &str, does: String, via: Option<&'static str>) -> Option<Step> {
        let node = self.named_unit(unit)?;
        Some(Step { file: self.files.get(node.file as usize)?.clone(), symbol: node.name.clone(), does, via, effect: None })
    }

    fn effect_near(&self, reached: &HashMap<&'a str, Option<&'a str>>) -> Option<(&'a str, String)> {
        let mut found: Vec<(usize, &str, &ExitPoint)> = Vec::new();
        for unit in reached.keys() {
            for exit in self.exits.get(unit).into_iter().flatten() {
                let rank = EFFECT_KINDS.iter().position(|kind| *kind == exit.kind).unwrap_or(EFFECT_KINDS.len());
                found.push((rank, unit, exit));
            }
        }
        found.sort_by(|left, right| (left.0, left.2.id.as_str()).cmp(&(right.0, right.2.id.as_str())));
        let (_, unit, exit) = found.into_iter().next()?;
        Some((unit, format!("{}:{}", exit.kind, exit.target)))
    }
}

fn crosses(crossing: &Crossing) -> &'static str {
    crossing.kind
}

fn sender_does(crossing: &Crossing) -> String {
    format!("Sends {} over {}", crossing.channel, crosses(crossing))
}

fn receiver_does(crossing: &Crossing) -> String {
    format!("Receives {} from {}", crossing.channel, crosses(crossing))
}

struct Walk<'a> {
    graph: &'a Graph<'a>,
    crossings: &'a [&'a Crossing],
}

impl<'a> Walk<'a> {
    fn successors(&self, at: &'a str, used: &[&Crossing]) -> Vec<(u8, usize, &'a Crossing, Vec<&'a str>)> {
        let reached = self.graph.within(at, HOPS);
        let home = self.graph.nodes.get(at).map(|node| node.file);
        let mut found: Vec<(u8, usize, &Crossing, Vec<&str>)> = Vec::new();
        for next in self.crossings.iter().copied().filter(|held| !used.contains(held)) {
            if reached.contains_key(next.from.as_str()) {
                let path = self.graph.path(&reached, next.from.as_str());
                found.push((0, path.len(), next, path));
                continue;
            }
            for class in [1u8, 2u8] {
                let nearest = reached
                    .keys()
                    .filter(|unit| {
                        self.graph.nodes.get(*unit).is_some_and(|node| Some(node.file) != home && match class {
                            1 => node.file == next.from_file,
                            _ => self.beside(node.file, next.from_file),
                        })
                    })
                    .map(|unit| self.graph.path(&reached, unit))
                    .min_by(|left, right| (left.len(), left.last()).cmp(&(right.len(), right.last())));
                if let Some(mut path) = nearest {
                    path.push(next.from.as_str());
                    found.push((class, path.len(), next, path));
                    break;
                }
            }
        }
        found.sort_by(|left, right| {
            (left.0, left.1, left.2.channel.as_str(), left.2.from.as_str()).cmp(&(right.0, right.1, right.2.channel.as_str(), right.2.from.as_str()))
        });
        found
    }

    fn beside(&self, left: u32, right: u32) -> bool {
        let directory = |file: u32| self.graph.files.get(file as usize).map(|path| path.rsplit_once('/').map(|(held, _)| held).unwrap_or(""));
        directory(left).is_some() && directory(left) == directory(right)
    }

    fn crossing_steps(&self, crossing: &'a Crossing, steps: &mut Vec<Step>) {
        let own = |unit: &str, does: String, via: Option<&'static str>, into: &mut Vec<Step>| {
            if let Some(step) = self.graph.step(unit, does, via)
                && into.last().is_none_or(|last| (&last.file, &last.symbol) != (&step.file, &step.symbol))
            {
                into.push(step);
            }
        };
        if let Some(command) = crossing.through.as_deref() {
            own(command, format!("Dispatches the {} command", crosses(crossing)), Some(crossing.kind), steps);
        }
        own(&crossing.to, receiver_does(crossing), Some(crossing.kind), steps);
    }

    fn extend(&self, root: &'a Crossing, branch: usize) -> Option<Journey> {
        let mut steps: Vec<Step> = Vec::new();
        if let Some(step) = self.graph.step(&root.from, sender_does(root), None) {
            steps.push(step);
        }
        self.crossing_steps(root, &mut steps);
        let mut used: Vec<&Crossing> = vec![root];
        let mut at = root.to.as_str();
        for _ in 0..MOST_CROSSINGS {
            if used.last().is_some_and(|last| last.kind == "event") {
                break;
            }
            let choices = self.successors(at, &used);
            let Some((class, _, next, path)) = choices.into_iter().nth(if used.len() == 1 { branch } else { 0 }) else { break };
            for unit in &path {
                if let Some(step) = self.graph.step(unit, format!("Calls {}", humanized(self.graph.named_unit(unit).map(|node| node.name.as_str()).unwrap_or(unit))), (class >= 1 && *unit == next.from.as_str()).then_some("queue")) {
                    if steps.last().is_none_or(|last| (&last.file, &last.symbol) != (&step.file, &step.symbol)) {
                        steps.push(step);
                    }
                }
            }
            if let Some(last) = steps.last_mut() {
                last.does = sender_does(next);
            }
            self.crossing_steps(next, &mut steps);
            used.push(next);
            at = next.to.as_str();
        }
        if used.len() == 1 && branch > 0 {
            return None;
        }
        let reached = self.graph.within(at, HOPS);
        if let Some((unit, effect)) = self.graph.effect_near(&reached) {
            let path = self.graph.path(&reached, unit);
            for held in path.iter().skip(1) {
                if let Some(step) = self.graph.step(held, format!("Calls {}", humanized(self.graph.named_unit(held).map(|node| node.name.as_str()).unwrap_or(held))), None)
                    && steps.last().is_none_or(|last| (&last.file, &last.symbol) != (&step.file, &step.symbol))
                {
                    steps.push(step);
                }
            }
            if let Some(last) = steps.last_mut() {
                last.does = format!("{}, ending in {effect}", last.does);
                last.effect = Some(effect);
            }
        }
        let first = steps.first()?;
        let last = steps.last()?;
        let id = format!("journey:{}:{}:{}", root.from, root.channel, branch);
        let label = humanized(&first.symbol);
        let does = format!(
            "{label} from {} through {} to {}{}",
            first.file,
            used.iter().map(|held| format!("{} {}", held.kind, held.channel)).collect::<Vec<_>>().join(", "),
            last.file,
            last.effect.as_deref().map(|effect| format!(", ending in {effect}")).unwrap_or_default()
        );
        Some(Journey { id, label, does, rank: 0, representative: false, steps })
    }
}

pub fn derive(
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    crossings: &[Crossing],
    exit_points: &[ExitPoint],
) -> Vec<Journey> {
    let graph = Graph::new(files, nodes, edges, exit_points);
    let held: Vec<&Crossing> = crossings
        .iter()
        .filter(|crossing| {
            [crossing.from_file, crossing.to_file].iter().all(|file| files.get(*file as usize).is_some_and(|path| !is_test(path)))
        })
        .collect();
    let mut followed: HashSet<&str> = HashSet::default();
    for crossing in &held {
        followed.extend(graph.within(crossing.to.as_str(), HOPS).keys().copied().filter(|unit| *unit != crossing.to.as_str()));
    }
    let walk = &Walk { graph: &graph, crossings: &held };
    let mut journeys: Vec<Journey> = held
        .iter()
        .copied()
        .filter(|crossing| !followed.contains(crossing.from.as_str()))
        .flat_map(|root| (0..MOST_BRANCHES).filter_map(move |branch| walk.extend(root, branch)))
        .collect();
    let reach = |journey: &Journey| {
        let places: HashSet<&str> = journey.steps.iter().filter_map(|step| step.file.split('/').next()).collect();
        (places.len(), journey.steps.iter().filter(|step| step.via.is_some()).count(), journey.steps.len())
    };
    journeys.sort_by(|left, right| reach(right).cmp(&reach(left)).then(left.id.cmp(&right.id)));
    journeys.dedup_by(|left, right| left.id == right.id);
    journeys.truncate(MOST_JOURNEYS);
    for (position, journey) in journeys.iter_mut().enumerate() {
        journey.rank = position as u32 + 1;
        journey.representative = position < MOST_REPRESENTATIVE;
    }
    journeys
}

#[cfg(test)]
mod tests {
    use super::humanized;

    #[test]
    fn a_symbol_is_spoken_as_words() {
        assert_eq!(humanized("runChat"), "Run chat");
        assert_eq!(humanized("accept_user_message"), "Accept user message");
        assert_eq!(humanized("on_frame"), "On frame");
    }
}

use std::collections::VecDeque;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::Flow;
use crate::crossings::Crossing;
use crate::entry_exit::ExitPoint;
use crate::model::{EdgeKind, IndexEdge, IndexNode, Via};
use crate::paths::is_scaffolding;

const HOPS: usize = 3;
const EFFECT_REACH: usize = 6;
const MOST_CROSSINGS: usize = 6;
const MOST_BRANCHES: usize = 3;
const MOST_JOURNEYS: usize = 400;
const MOST_REPRESENTATIVE: usize = 6;

static EFFECT_KINDS: &[&str] = &["process", "database", "network", "api", "message", "file"];

#[derive(Debug, Serialize)]
pub struct Step {
    #[serde(skip)]
    pub unit: String,
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
        for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Calls && edge.via != Via::Name) {
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
        Some(Step { unit: node.id.clone(), file: self.files.get(node.file as usize)?.clone(), symbol: node.name.clone(), does, via, effect: None })
    }

    fn effect_near(&self, reached: &HashMap<&'a str, Option<&'a str>>) -> Option<(&'a str, String)> {
        let mut found: Vec<(usize, usize, &str, &ExitPoint)> = Vec::new();
        for unit in reached.keys() {
            for exit in self.exits.get(unit).into_iter().flatten() {
                let rank = EFFECT_KINDS.iter().position(|kind| *kind == exit.kind).unwrap_or(EFFECT_KINDS.len());
                found.push((rank, self.path(reached, unit).len(), unit, exit));
            }
        }
        found.sort_by(|left, right| (left.0, left.1, left.3.id.as_str()).cmp(&(right.0, right.1, right.3.id.as_str())));
        let (_, _, unit, exit) = found.into_iter().next()?;
        Some((unit, format!("{}:{}", exit.kind, exit.target)))
    }
}

fn thinned<'a>(path: Vec<&'a str>) -> Vec<&'a str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut at = path.len().saturating_sub(1);
    loop {
        kept.push(path[at]);
        if at == 0 {
            break;
        }
        at = at.saturating_sub(HOPS);
    }
    kept.reverse();
    kept
}

fn crosses(crossing: &Crossing) -> &'static str {
    crossing.kind
}

fn medium(kind: &str) -> &'static str {
    match kind {
        "ipc" => "the ipc bridge",
        "event" => "the event bus",
        "queue" => "a queue",
        _ => "the network",
    }
}

fn effect_phrase(effect: &str) -> String {
    let (kind, target) = effect.split_once(':').unwrap_or((effect, ""));
    match kind {
        "process" => "starts an external process".to_string(),
        "database" => format!("reads or writes the {target} database"),
        "network" => format!("talks to {target} over the network"),
        "api" => format!("calls the {target} service"),
        "message" => format!("publishes a message through {target}"),
        _ => "reads or writes files".to_string(),
    }
}

fn is_component(symbol: &str) -> bool {
    symbol.chars().next().is_some_and(char::is_uppercase)
}

struct Walk<'a> {
    graph: &'a Graph<'a>,
    crossings: &'a [&'a Crossing],
}

impl<'a> Walk<'a> {
    fn successors(&self, at: &'a str, used: &[&Crossing], visited: &[&str]) -> Vec<(u8, usize, &'a Crossing, Vec<&'a str>)> {
        let reached = self.graph.within(at, HOPS);
        let home = self.graph.nodes.get(at).map(|node| node.file);
        let seen = |unit: &str| self.graph.named_unit(unit).is_some_and(|node| visited.contains(&node.id.as_str()));
        let mut found: Vec<(u8, usize, &Crossing, Vec<&str>)> = Vec::new();
        for next in self.crossings.iter().copied().filter(|held| !used.contains(held) && !seen(&held.to) && !seen(&held.from)) {
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
            let key = |held: &(u8, usize, &Crossing, Vec<&str>)| (held.2.kind != "queue", held.0, held.1, held.2.channel.clone(), held.2.from.clone());
            key(left).cmp(&key(right))
        });
        found
    }

    fn beside(&self, left: u32, right: u32) -> bool {
        let directory = |file: u32| self.graph.files.get(file as usize).map(|path| path.rsplit_once('/').map(|(held, _)| held).unwrap_or(""));
        directory(left).is_some() && directory(left) == directory(right)
    }

    fn passing(&self, unit: &str, via: Option<&'static str>, steps: &mut Vec<Step>) {
        let human = humanized(self.graph.named_unit(unit).map(|node| node.name.as_str()).unwrap_or(unit));
        if let Some(step) = self.graph.step(unit, human, via)
            && steps.last().is_none_or(|last| last.unit != step.unit)
        {
            steps.push(step);
        }
    }

    fn crossing_steps(&self, crossing: &'a Crossing, steps: &mut Vec<Step>) {
        let own = |unit: &str, does: String, via: Option<&'static str>, into: &mut Vec<Step>| {
            if let Some(step) = self.graph.step(unit, does, via)
                && into.last().is_none_or(|last| last.unit != step.unit)
            {
                into.push(step);
            }
        };
        if let Some(command) = crossing.through.as_deref() {
            let name = self.graph.named_unit(command).map(|node| humanized(&node.name)).unwrap_or_default();
            own(command, format!("{name}: routes the {} command to its handler", crosses(crossing)), Some(crossing.kind), steps);
        }
        let name = self.graph.named_unit(&crossing.to).map(|node| humanized(&node.name)).unwrap_or_default();
        own(&crossing.to, format!("{name}: receives {} from {}", crossing.channel, medium(crossing.kind)), Some(crossing.kind), steps);
    }

    fn sends(&self, step: &mut Step, crossing: &Crossing) {
        step.does = format!("{}: sends {} over {}", humanized(&step.symbol), crossing.channel, medium(crossing.kind));
    }

    fn extend(&self, root: &'a Crossing, branch: usize) -> Option<Journey> {
        let mut steps: Vec<Step> = Vec::new();
        if let Some(mut step) = self.graph.step(&root.from, String::new(), None) {
            self.sends(&mut step, root);
            steps.push(step);
        }
        self.crossing_steps(root, &mut steps);
        let mut used: Vec<&Crossing> = vec![root];
        let mut visited: Vec<&str> = [root.from.as_str(), root.to.as_str()]
            .iter()
            .filter_map(|unit| self.graph.named_unit(unit).map(|node| node.id.as_str()))
            .collect();
        let mut at = root.to.as_str();
        for _ in 0..MOST_CROSSINGS {
            if used.last().is_some_and(|last| last.kind == "event") {
                break;
            }
            let choices = self.successors(at, &used, &visited);
            let Some((class, _, next, path)) = choices.into_iter().nth(if used.len() == 1 { branch } else { 0 }) else { break };
            for unit in &path {
                self.passing(unit, (class >= 1 && *unit == next.from.as_str()).then_some("queue"), &mut steps);
            }
            if let Some(last) = steps.last_mut() {
                self.sends(last, next);
            }
            self.crossing_steps(next, &mut steps);
            used.push(next);
            visited.extend([next.from.as_str(), next.to.as_str()].iter().filter_map(|unit| self.graph.named_unit(unit).map(|node| node.id.as_str())));
            at = next.to.as_str();
        }
        if used.len() == 1 && branch > 0 {
            return None;
        }
        let reached = self.graph.within(at, EFFECT_REACH);
        if let Some((unit, effect)) = self.graph.effect_near(&reached) {
            for held in thinned(self.graph.path(&reached, unit)).into_iter().skip(1) {
                self.passing(held, None, &mut steps);
            }
            if let Some(last) = steps.last_mut() {
                last.does = format!("{}: {}", humanized(&last.symbol), effect_phrase(&effect));
                last.effect = Some(effect);
            }
        }
        let first = steps.first()?;
        let last = steps.last()?;
        let id = format!("journey:{}:{}:{}", root.from, root.channel, branch);
        let label = match is_component(&first.symbol) {
            true => humanized(&root.channel),
            false => humanized(&first.symbol),
        };
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

fn within_reach(graph: &Graph, steps: &[Step]) -> usize {
    let mut kept = 1;
    for pair in steps.windows(2) {
        let (before, after) = (&pair[0], &pair[1]);
        if after.via.is_none() && graph.within(before.unit.as_str(), HOPS + 1).keys().all(|unit| graph.named_unit(unit).is_none_or(|node| node.id != after.unit)) {
            let family = |unit: &str| graph.nodes.get(unit).map(|node| node.parent.as_deref());
            if family(&before.unit) != family(&after.unit) {
                break;
            }
        }
        kept += 1;
    }
    kept
}

pub fn derive(
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    crossings: &[Crossing],
    exit_points: &[ExitPoint],
    set_aside: &HashSet<u32>,
) -> Vec<Journey> {
    let graph = Graph::new(files, nodes, edges, exit_points);
    let held: Vec<&Crossing> = crossings
        .iter()
        .filter(|crossing| {
            [crossing.from_file, crossing.to_file].iter().all(|file| files.get(*file as usize).is_some_and(|path| !is_scaffolding(path)))
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
    for journey in &mut journeys {
        let kept = within_reach(&graph, &journey.steps);
        journey.steps.truncate(kept);
    }
    let noisy = |journey: &Journey| noisy_steps(&graph, set_aside, &journey.steps);
    let reach = |journey: &Journey| {
        let places: HashSet<&str> = journey.steps.iter().filter_map(|step| step.file.split('/').next()).collect();
        (places.len(), journey.steps.iter().filter(|step| step.via.is_some()).count(), journey.steps.len())
    };
    journeys.sort_by(|left, right| {
        noisy(left).cmp(&noisy(right)).then(reach(right).cmp(&reach(left))).then(left.id.cmp(&right.id))
    });
    journeys.dedup_by(|left, right| left.id == right.id);
    journeys.truncate(MOST_JOURNEYS);
    let mut represented: HashSet<String> = HashSet::default();
    for (position, journey) in journeys.iter_mut().enumerate() {
        journey.rank = position as u32 + 1;
        let root = journey.steps.first().map(|step| step.unit.clone()).unwrap_or_default();
        journey.representative = represented.len() < MOST_REPRESENTATIVE && !noisy_steps(&graph, set_aside, &journey.steps) && represented.insert(root);
    }
    journeys
}

fn noisy_steps(graph: &Graph, set_aside: &HashSet<u32>, steps: &[Step]) -> bool {
    steps.iter().any(|step| graph.nodes.get(step.unit.as_str()).is_some_and(|node| set_aside.contains(&node.file)) || is_scaffolding(&step.file))
}

pub fn phrase(journeys: &mut [Journey], flows: &[Flow]) {
    let mut named: HashMap<&str, &str> = HashMap::default();
    let mut labelled: HashMap<&str, &str> = HashMap::default();
    for flow in flows {
        if let (Some(name), Some(entry)) = (flow.name.as_deref(), flow.path.first()) {
            named.entry(entry.unit.as_str()).or_insert(name);
        }
        for step in &flow.steps {
            for region in &step.regions {
                labelled.entry(region.unit.as_str()).or_insert(step.label.as_str());
            }
        }
    }
    for journey in journeys {
        if let Some(name) = journey.steps.iter().find_map(|step| named.get(step.unit.as_str())) {
            journey.label = (*name).to_string();
        }
        for step in journey.steps.iter_mut().filter(|step| step.via.is_none() && step.effect.is_none()) {
            if let Some(label) = labelled.get(step.unit.as_str()) {
                step.does = (*label).to_string();
            }
        }
    }
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

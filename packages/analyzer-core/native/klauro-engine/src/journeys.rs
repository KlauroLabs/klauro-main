use std::collections::VecDeque;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::Flow;
use crate::crossings::Crossing;
use crate::entry_exit::{EntryPoint, ExitPoint, USER_FACING};
use crate::model::{EdgeKind, IndexEdge, IndexNode, Via};
use crate::paths::is_scaffolding;
use crate::unshipped;

mod carry;

use carry::{Carrier, Imports};

const BETWEEN_REACH: usize = 6;
const EFFECT_REACH: usize = 6;
const MOST_CROSSINGS: usize = 6;
const MOST_BRANCHES: usize = 3;
const MOST_JOURNEYS: usize = 400;
const MOST_REPRESENTATIVE: usize = 6;
const ENTRY_REACH: usize = 8;
const LEAST_REPRESENTATIVE_STEPS: usize = 3;

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
    #[serde(skip)]
    pub entered: bool,
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

struct Entered<'a> {
    title: String,
    path: Vec<&'a str>,
}

fn entry_title(graph: &Graph, entry: &EntryPoint) -> String {
    match (entry.kind, entry.method.as_deref(), entry.path.as_deref()) {
        ("http", Some(method), Some(path)) => format!("{} {}", method.to_ascii_uppercase(), path),
        ("ui", ..) => graph.named_unit(&entry.handler).map(|node| humanized(&node.name)).unwrap_or_else(|| entry.name.clone()),
        _ => entry.name.clone(),
    }
}

fn served_entries(entry_points: &[EntryPoint]) -> Vec<&EntryPoint> {
    let mut served: Vec<&EntryPoint> = entry_points
        .iter()
        .filter(|entry| USER_FACING.contains(&entry.kind) && !unshipped::is_set_aside(entry.unshipped.as_ref()))
        .collect();
    served.sort_by(|left, right| left.id.cmp(&right.id));
    served
}

fn entries_by_unit<'a>(graph: &Graph<'a>, served: &[&EntryPoint]) -> HashMap<&'a str, Entered<'a>> {
    let mut found: HashMap<&str, (usize, Entered)> = HashMap::default();
    for entry in served {
        let Some(handler) = graph.nodes.get(entry.handler.as_str()) else { continue };
        let title = entry_title(graph, entry);
        let reached = graph.within(handler.id.as_str(), ENTRY_REACH);
        for unit in reached.keys() {
            let Some(node) = graph.named_unit(unit) else { continue };
            let path = graph.path(&reached, unit);
            if found.get(node.id.as_str()).is_none_or(|(length, _)| path.len() < *length) {
                found.insert(node.id.as_str(), (path.len(), Entered { title: title.clone(), path }));
            }
        }
    }
    found.into_iter().map(|(unit, (_, entered))| (unit, entered)).collect()
}

struct Walk<'a> {
    graph: &'a Graph<'a>,
    entries: HashMap<&'a str, Entered<'a>>,
    served: &'a [&'a EntryPoint],
    crossings: &'a [&'a Crossing],
    carriers: Vec<Carrier<'a>>,
    imports: Imports,
}

impl<'a> Walk<'a> {
    fn successors(&self, at: &'a str, used: &[&Crossing], visited: &[&str]) -> Vec<(usize, &'a Crossing, Vec<&'a str>)> {
        let reached = self.graph.within(at, BETWEEN_REACH);
        let seen = |unit: &str| self.graph.named_unit(unit).is_some_and(|node| visited.contains(&node.id.as_str()));
        let mut found: Vec<(usize, &Crossing, Vec<&str>)> = self
            .crossings
            .iter()
            .copied()
            .filter(|held| !used.contains(held) && !seen(&held.to) && !seen(&held.from))
            .filter(|held| reached.contains_key(held.from.as_str()))
            .map(|held| {
                let path = self.graph.path(&reached, held.from.as_str());
                (path.len(), held, path)
            })
            .collect();
        found.sort_by(|left, right| {
            let key = |held: &(usize, &Crossing, Vec<&str>)| (held.1.kind != "queue", held.0, held.1.channel.clone(), held.1.from.clone());
            key(left).cmp(&key(right))
        });
        found
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

    fn carried_by(&self, message: &Crossing) -> Option<&Carrier<'a>> {
        self.carriers.iter().find(|carrier| carrier.carries(&self.imports, message))
    }

    fn carry(&self, carrier: &Carrier<'a>, message: &Crossing, steps: &mut Vec<Step>) {
        if let Some(last) = steps.last_mut() {
            last.does = format!("{}: sends {} over the network", humanized(&last.symbol), message.channel);
        }
        let send = self.graph.step(&carrier.send.from, String::new(), Some(carrier.send.kind));
        if let Some(mut step) = send
            && steps.last().is_none_or(|last| last.unit != step.unit)
        {
            self.sends(&mut step, carrier.send);
            steps.push(step);
        }
        self.crossing_steps(carrier.send, steps);
        let reached = self.graph.within(&carrier.send.to, BETWEEN_REACH);
        let onward = self.graph.path(&reached, &carrier.forward.from);
        for unit in onward.iter().skip(1) {
            self.passing(unit, None, steps);
        }
        if let Some(last) = steps.last_mut() {
            match onward.len() {
                1 => last.does = format!("{}: receives {} from the network and forwards it", humanized(&last.symbol), carrier.send.channel),
                _ => self.sends(last, carrier.forward),
            }
        }
        self.crossing_steps(carrier.forward, steps);
    }

    fn from_entry(&self, entry: &EntryPoint) -> Option<Journey> {
        let handler = self.graph.nodes.get(entry.handler.as_str())?;
        let reached = self.graph.within(handler.id.as_str(), EFFECT_REACH);
        let (unit, effect) = self.graph.effect_near(&reached)?;
        let mut steps: Vec<Step> = Vec::new();
        for held in self.graph.path(&reached, unit) {
            self.passing(held, None, &mut steps);
        }
        let last = steps.last_mut()?;
        last.does = format!("{}: {}", humanized(&last.symbol), effect_phrase(&effect));
        last.effect = Some(effect.clone());
        let label = entry_title(self.graph, entry);
        let does = format!("{label} from {} to {}, ending in {effect}", steps.first()?.file, steps.last()?.file);
        Some(Journey { id: format!("journey:{}:entry", entry.id), label, does, rank: 0, representative: false, steps, entered: true })
    }

    fn extend(&self, root: &'a Crossing, branch: usize) -> Option<Journey> {
        let mut steps: Vec<Step> = Vec::new();
        if let Some(mut step) = self.graph.step(&root.from, String::new(), None) {
            self.sends(&mut step, root);
            steps.push(step);
        }
        let carrier = self.carried_by(root);
        if let Some(carrier) = carrier {
            self.carry(carrier, root, &mut steps);
        }
        self.crossing_steps(root, &mut steps);
        let mut used: Vec<&Crossing> = vec![root];
        let mut told: Vec<&Crossing> = vec![root];
        let mut places: Vec<&str> = vec![root.from.as_str(), root.to.as_str()];
        if let Some(carrier) = carrier {
            told = vec![carrier.send, carrier.forward, root];
            places.extend([carrier.send.to.as_str(), carrier.forward.from.as_str()]);
        }
        let mut visited: Vec<&str> = places.iter().filter_map(|unit| self.graph.named_unit(unit).map(|node| node.id.as_str())).collect();
        let mut at = root.to.as_str();
        for _ in 0..MOST_CROSSINGS {
            if used.last().is_some_and(|last| last.kind == "event") {
                break;
            }
            let effect = self.graph.effect_near(&self.graph.within(at, EFFECT_REACH));
            if effect.as_ref().is_some_and(|(_, held)| held.starts_with(EFFECT_KINDS[0])) {
                break;
            }
            let effect_ahead = effect.is_some();
            let choices: Vec<_> = self.successors(at, &used, &visited).into_iter().filter(|(_, next, _)| !(effect_ahead && next.kind == "event")).collect();
            let Some((_, next, path)) = choices.into_iter().nth(if used.len() == 1 { branch } else { 0 }) else { break };
            for unit in path {
                self.passing(unit, None, &mut steps);
            }
            if let Some(last) = steps.last_mut() {
                self.sends(last, next);
            }
            self.crossing_steps(next, &mut steps);
            used.push(next);
            told.push(next);
            visited.extend([next.from.as_str(), next.to.as_str()].iter().filter_map(|unit| self.graph.named_unit(unit).map(|node| node.id.as_str())));
            at = next.to.as_str();
        }
        if used.len() == 1 && branch > 0 {
            return None;
        }
        let reached = self.graph.within(at, EFFECT_REACH);
        if let Some((unit, effect)) = self.graph.effect_near(&reached) {
            for held in self.graph.path(&reached, unit).into_iter().skip(1) {
                self.passing(held, None, &mut steps);
            }
            if let Some(last) = steps.last_mut() {
                last.does = format!("{}: {}", humanized(&last.symbol), effect_phrase(&effect));
                last.effect = Some(effect);
            }
        }
        let entered = steps.first().and_then(|step| self.entries.get(step.unit.as_str()));
        if let Some(entered) = entered {
            let mut prefix: Vec<Step> = Vec::new();
            for unit in entered.path.iter().take(entered.path.len().saturating_sub(1)) {
                self.passing(unit, None, &mut prefix);
            }
            steps.splice(0..0, prefix);
        }
        let first = steps.first()?;
        let last = steps.last()?;
        let id = format!("journey:{}:{}:{}", root.from, root.channel, branch);
        let label = match (entered, is_component(&first.symbol) || first.symbol == first.file) {
            (Some(entered), _) => entered.title.clone(),
            (None, true) => humanized(&root.channel),
            (None, false) => humanized(&first.symbol),
        };
        let does = format!(
            "{label} from {} through {} to {}{}",
            first.file,
            told.iter().map(|held| format!("{} {}", held.kind, held.channel)).collect::<Vec<_>>().join(", "),
            last.file,
            last.effect.as_deref().map(|effect| format!(", ending in {effect}")).unwrap_or_default()
        );
        Some(Journey { id, label, does, rank: 0, representative: false, steps, entered: entered.is_some() })
    }
}

pub fn derive(
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    crossings: &[Crossing],
    exit_points: &[ExitPoint],
    entry_points: &[EntryPoint],
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
        followed.extend(graph.within(crossing.to.as_str(), BETWEEN_REACH).keys().copied().filter(|unit| *unit != crossing.to.as_str()));
    }
    let served = served_entries(entry_points);
    let walk = &Walk {
        graph: &graph,
        entries: entries_by_unit(&graph, &served),
        served: &served,
        crossings: &held,
        carriers: carry::pairs(&held, |send, forward| graph.within(send.to.as_str(), BETWEEN_REACH).contains_key(forward.from.as_str())),
        imports: Imports::new(files, edges),
    };
    let mut journeys: Vec<Journey> = held
        .iter()
        .copied()
        .filter(|crossing| !followed.contains(crossing.from.as_str()))
        .flat_map(|root| (0..MOST_BRANCHES).filter_map(move |branch| walk.extend(root, branch)))
        .collect();
    journeys.extend(served.iter().filter_map(|entry| walk.from_entry(entry)));
    let noisy = |journey: &Journey| noisy_steps(&graph, set_aside, &journey.steps);
    let reach = |journey: &Journey| {
        let places: HashSet<&str> = journey.steps.iter().filter_map(|step| step.file.split('/').next()).collect();
        (places.len(), journey.steps.iter().filter(|step| step.via.is_some()).count(), journey.steps.len())
    };
    journeys.sort_by(|left, right| {
        noisy(left).cmp(&noisy(right)).then(reach(right).cmp(&reach(left))).then(left.id.cmp(&right.id))
    });
    journeys.dedup_by(|left, right| left.id == right.id);
    let mut journeys = without_repeats(journeys);
    journeys.truncate(MOST_JOURNEYS);
    for (position, journey) in journeys.iter_mut().enumerate() {
        journey.rank = position as u32 + 1;
    }
    let calm: Vec<usize> = (0..journeys.len())
        .filter(|position| {
            let journey = &journeys[*position];
            journey.entered
                && journey.steps.len() >= LEAST_REPRESENTATIVE_STEPS
                && journey.steps.last().is_some_and(|step| step.effect.is_some())
                && !noisy_steps(&graph, set_aside, &journey.steps)
        })
        .collect();
    let mut chosen: Vec<usize> = Vec::new();
    let mut courses: HashSet<(String, String)> = HashSet::default();
    for position in calm.iter().copied() {
        if chosen.len() >= MOST_REPRESENTATIVE {
            break;
        }
        if courses.insert(course_of(&journeys[position])) {
            chosen.push(position);
        }
    }
    let mut roots: HashSet<&str> = chosen.iter().filter_map(|position| journeys[*position].steps.first()).map(|step| step.unit.as_str()).collect();
    let mut filled: Vec<usize> = Vec::new();
    for position in calm.iter().copied().filter(|position| !chosen.contains(position)) {
        if chosen.len() + filled.len() >= MOST_REPRESENTATIVE {
            break;
        }
        if journeys[position].steps.first().is_some_and(|step| roots.insert(step.unit.as_str())) {
            filled.push(position);
        }
    }
    chosen.extend(filled);
    for position in chosen {
        journeys[position].representative = true;
    }
    journeys
}

fn area_of(step: &Step) -> String {
    step.file.split('/').next().unwrap_or_default().to_string()
}

fn course_of(journey: &Journey) -> (String, String) {
    let first = journey.steps.first().map(area_of).unwrap_or_default();
    let last = journey.steps.last();
    let ending = last.map(|step| format!("{}:{}", area_of(step), step.effect.as_deref().unwrap_or_default())).unwrap_or_default();
    (first, ending)
}

fn units(journey: &Journey) -> Vec<&str> {
    journey.steps.iter().map(|step| step.unit.as_str()).collect()
}

fn contained_at_an_end(shorter: &[&str], longer: &[&str]) -> bool {
    shorter.len() <= longer.len() && (longer.starts_with(shorter) || longer.ends_with(shorter))
}

fn without_repeats(journeys: Vec<Journey>) -> Vec<Journey> {
    let mut kept: Vec<Journey> = Vec::new();
    for journey in journeys {
        let these = units(&journey);
        if kept.iter().any(|held| contained_at_an_end(&these, &units(held))) {
            continue;
        }
        let longer = kept.iter().position(|held| contained_at_an_end(&units(held), &these));
        match longer {
            Some(position) => kept[position] = journey,
            None => kept.push(journey),
        }
    }
    kept
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

use std::collections::BTreeMap;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::model::{CallFact, EdgeKind, IndexEdge, IndexNode, NodeKind};
use crate::patterns::Message;
use crate::roles::Roles;

static LABELS: &str = include_str!("../data/component_labels.tsv");
static REGISTRIES: &str = include_str!("../data/composition_registries.tsv");
static ORCHESTRATION: &str = include_str!("../data/orchestration_calls.tsv");
const ROLES_TO_TELL_ORGANISATION: usize = 3;
static ENTERING: &[&str] = &["command", "component", "controller", "handler", "listener", "scheduled", "worker"];
static WORKING: &[&str] = &["request-handler", "service", "validator", "view-model"];
static KEEPING: &[&str] = &["data-context", "integration", "mapping", "model", "repository"];
static REACTING: &[&str] = &["listener", "scheduled", "worker"];
const EXAMPLES_KEPT: usize = 5;
const FOLDERS_KEPT: usize = 3;
const STAGES_AT_LEAST: usize = 8;
const STAGES_TOLD: usize = 60;
const MODULES_AT_LEAST: usize = 3;

#[derive(Debug, Serialize)]
pub struct Component {
    pub role: &'static str,
    pub label: String,
    pub units: u32,
    pub examples: Vec<String>,
    pub folders: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Style {
    pub style: &'static str,
    pub evidence: String,
}

#[derive(Debug, Serialize)]
pub struct Orchestrated {
    pub starts: Vec<String>,
    pub provisions: Vec<String>,
}

fn readable(written: &str) -> String {
    crate::names::leaf(written).replace(['_', '.'], " ")
}

fn orchestrated(project: &str, sources: &Sources, named: &HashMap<&str, &IndexNode>) -> Orchestrated {
    let rows: Vec<(&str, &str, &str)> = ORCHESTRATION
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let (_, how, call, resource) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
            Some((how, call, resource))
        })
        .collect();
    let (mut starts, mut provisions) = (Vec::new(), Vec::new());
    for call in sources.calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        let in_project = named.get(caller).is_some_and(|node| node.project.as_deref() == Some(project));
        if !in_project || crate::paths::is_test(caller.split(':').next().unwrap_or_default()) {
            continue;
        }
        let leaf = crate::names::leaf(&call.callee);
        let Some((how, _, resource)) = rows.iter().find(|(_, named_call, _)| *named_call == leaf) else { continue };
        let told = match (*how, *resource) {
            ("starts", _) => call.type_arguments.first().map(|written| readable(written)).or_else(|| call.literals.first().cloned()),
            (_, "-") => call.literals.first().cloned(),
            (_, resource) => Some(resource.to_string()),
        };
        let Some(told) = told else { continue };
        let held = match *how {
            "starts" => &mut starts,
            _ => &mut provisions,
        };
        let spoken = |written: &str| written.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
        if !held.iter().any(|known: &String| spoken(known) == spoken(&told)) {
            held.push(told);
        }
    }
    Orchestrated { starts, provisions }
}

#[derive(Debug, Default, Serialize)]
pub struct Shape {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<Component>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<String>,
    pub organised_by: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<Style>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub starts: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub provisions: Vec<String>,
}

pub fn label_of(role: &str) -> String {
    LABELS.lines().filter_map(|line| line.split_once('\t')).find(|(held, _)| *held == role).map(|(_, label)| label.to_string()).unwrap_or_else(|| role.replace('-', " "))
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(folder, _)| folder).unwrap_or("")
}

pub struct Sources<'a> {
    pub roles: &'a Roles,
    pub nodes: &'a [IndexNode],
    pub edges: &'a [IndexEdge],
    pub calls: &'a [CallFact],
    pub messages: &'a [Message],
    pub programs: &'a [&'a str],
    pub entry_points: &'a [crate::entry_exit::EntryPoint],
    pub source_files: &'a HashSet<&'a str>,
}

fn unit_of<'a>(node: &'a IndexNode, named: &HashMap<&str, &'a IndexNode>) -> &'a IndexNode {
    let mut held = node;
    for _ in 0..16 {
        if held.kind.is_type() || held.kind == NodeKind::Module {
            return held;
        }
        match held.parent.as_deref().and_then(|parent| named.get(parent).copied()) {
            Some(parent) if parent.kind.is_type() || parent.kind == NodeKind::Module || held.id.contains(":callback:") || held.name.contains('#') => held = parent,
            _ => return held,
        }
    }
    held
}

fn unit_name(unit: &IndexNode) -> String {
    match unit.kind {
        NodeKind::Module => crate::paths::basename(&unit.name).split('.').next().unwrap_or_default().to_string(),
        _ => unit.name.clone(),
    }
}

fn stages_of(project: &str, sources: &Sources, named: &HashMap<&str, &IndexNode>) -> Vec<String> {
    let mut first_call: HashMap<(&str, &str), u32> = HashMap::default();
    for call in sources.calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        let line = first_call.entry((caller, crate::names::leaf(&call.callee))).or_insert(call.line);
        *line = (*line).min(call.line);
    }
    let mut reached: HashMap<&str, BTreeMap<(u32, String), ()>> = HashMap::default();
    for edge in sources.edges.iter().filter(|edge| edge.kind == EdgeKind::Calls) {
        let (Some(from), Some(to)) = (named.get(edge.source.as_str()), named.get(edge.target.as_str())) else { continue };
        if from.project.as_deref() != Some(project) || to.project.as_deref() != Some(project) || from.file == to.file {
            continue;
        }
        if crate::paths::is_test(edge.source.split(':').next().unwrap_or_default()) {
            continue;
        }
        let Some(line) = first_call.get(&(from.id.as_str(), to.name.as_str())).copied() else { continue };
        let file = to.id.split(':').next().unwrap_or_default();
        let stage = crate::paths::basename(file).split('.').next().unwrap_or(file).to_string();
        reached.entry(from.id.as_str()).or_default().insert((line, format!("{stage}\u{1}{}", to.id)), ());
    }
    reached
        .into_iter()
        .map(|(orchestrator, ordered)| {
            let mut stages: Vec<String> = Vec::new();
            for (_, held) in ordered.into_keys() {
                let stage = held.split('\u{1}').next().unwrap_or_default().to_string();
                if !stages.iter().any(|known| known.split('\u{1}').next() == Some(stage.as_str())) {
                    stages.push(held);
                }
            }
            (orchestrator, stages)
        })
        .filter(|(orchestrator, stages)| stages.len() >= STAGES_AT_LEAST && starts_a_program(orchestrator, sources))
        .map(|(_, stages)| stages)
        .max_by_key(Vec::len)
        .map(|stages| stages.into_iter().take(STAGES_TOLD).collect())
        .unwrap_or_default()
}

fn starts_a_program(orchestrator: &str, sources: &Sources) -> bool {
    if sources.programs.contains(&orchestrator) {
        return true;
    }
    sources.edges.iter().any(|edge| edge.kind == EdgeKind::Calls && edge.target == orchestrator && sources.programs.contains(&edge.source.as_str()))
}

fn takes_a_registry(node: &IndexNode) -> bool {
    node.signature.as_ref().is_some_and(|signature| {
        signature.parameters.iter().filter_map(|parameter| parameter.type_annotation.as_deref()).any(|written| {
            let leaf = crate::names::leaf(written.trim().trim_start_matches("this ").split('<').next().unwrap_or(written));
            REGISTRIES.lines().filter_map(|line| line.split_once('\t')).any(|(_, registry)| registry == leaf)
        })
    })
}

pub fn shape_of(project: &str, sources: &Sources) -> Shape {
    let named: HashMap<&str, &IndexNode> = sources.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut units_by_role: BTreeMap<&'static str, BTreeMap<String, &IndexNode>> = BTreeMap::new();
    for role in sources.roles.roles.iter().filter(|role| role.project.as_deref() == Some(project) && role.role != "test") {
        let Some(node) = named.get(role.node.as_str()) else { continue };
        if crate::paths::is_test(node.id.split(':').next().unwrap_or_default()) {
            continue;
        }
        let unit = unit_of(node, &named);
        units_by_role.entry(role.role).or_default().insert(unit.id.clone(), unit);
    }
    let roled: HashSet<String> = units_by_role.values().flat_map(|units| units.keys().cloned()).collect();
    let methods: HashMap<&str, usize> = sources.nodes.iter().filter(|node| matches!(node.kind, NodeKind::Method | NodeKind::Function)).filter_map(|node| node.parent.as_deref()).fold(HashMap::default(), |mut held, parent| {
        *held.entry(parent).or_default() += 1;
        held
    });
    for node in sources.nodes.iter().filter(|node| node.project.as_deref() == Some(project) && node.kind.is_type() && !roled.contains(&node.id)) {
        let path = node.id.split(':').next().unwrap_or_default();
        if !crate::paths::is_hand_written_code(path) || !sources.source_files.contains(path) {
            continue;
        }
        let role = match (node.kind, methods.get(node.id.as_str()).copied().unwrap_or(0)) {
            (NodeKind::Interface, _) => "contract",
            (_, 0) => "data-shape",
            _ => continue,
        };
        units_by_role.entry(role).or_default().insert(node.id.clone(), node);
    }
    for entry in sources.entry_points.iter().filter(|entry| entry.kind == "export") {
        let Some(node) = named.get(entry.handler.as_str()).filter(|node| node.project.as_deref() == Some(project)) else { continue };
        let unit = unit_of(node, &named);
        units_by_role.entry("offered").or_default().insert(unit.id.clone(), unit);
    }
    let mut by_label: BTreeMap<String, (&'static str, BTreeMap<String, &IndexNode>)> = BTreeMap::new();
    for (role, units) in &units_by_role {
        let held = by_label.entry(label_of(role)).or_insert((role, BTreeMap::new()));
        held.1.extend(units.iter().map(|(id, unit)| (id.clone(), *unit)));
    }
    let mut components: Vec<Component> = by_label
        .iter()
        .map(|(label, (role, units))| {
            let mut folders: BTreeMap<&str, u32> = BTreeMap::new();
            for unit in units.values() {
                *folders.entry(folder_of(unit.id.split(':').next().unwrap_or_default())).or_default() += 1;
            }
            let mut ranked: Vec<(&str, u32)> = folders.into_iter().collect();
            ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
            Component {
                role,
                label: label.clone(),
                units: units.len() as u32,
                examples: units.values().take(EXAMPLES_KEPT).map(|unit| unit_name(unit)).collect(),
                folders: ranked.into_iter().take(FOLDERS_KEPT).map(|(folder, _)| folder.to_string()).collect(),
            }
        })
        .collect();
    components.sort_by(|left, right| right.units.cmp(&left.units).then(left.role.cmp(right.role)));

    let modules: Vec<String> = units_by_role.get("module").map(|units| units.values().map(|unit| unit_name(unit)).collect()).unwrap_or_default();
    let mut roles_in_folder: HashMap<&str, HashSet<&'static str>> = HashMap::default();
    for (role, units) in units_by_role.iter().filter(|(role, _)| !matches!(**role, "migration" | "module")) {
        for unit in units.values() {
            roles_in_folder.entry(folder_of(unit.id.split(':').next().unwrap_or_default())).or_default().insert(role);
        }
    }
    let held_folders: Vec<&HashSet<&'static str>> = roles_in_folder.values().filter(|roles| !roles.is_empty()).collect();
    let mixed = held_folders.iter().filter(|roles| roles.len() >= 2).count();
    let told_roles = units_by_role.keys().filter(|role| !matches!(**role, "migration" | "module" | "contract" | "data-shape" | "offered")).count();
    let organised_by = match (modules.len() >= MODULES_AT_LEAST, held_folders.len() >= ROLES_TO_TELL_ORGANISATION && told_roles >= ROLES_TO_TELL_ORGANISATION) {
        (true, _) => "domain modules",
        (false, false) => "not shown",
        (false, true) if mixed * 2 > held_folders.len() => "domain folders",
        _ => "layer folders",
    };

    let count = |wanted: &[&str]| -> u32 { components.iter().filter(|component| wanted.contains(&component.role)).map(|component| component.units).sum() };
    let mut styles = Vec::new();
    let mediated: Vec<&Message> = sources
        .messages
        .iter()
        .filter(|message| matches!(message.kind, "command" | "query") || !message.through.is_empty())
        .filter(|message| message.handlers.iter().any(|handler| named.get(handler.as_str()).is_some_and(|node| node.project.as_deref() == Some(project))))
        .collect();
    if !mediated.is_empty() {
        styles.push(Style { style: "mediator", evidence: format!("{} messages are sent through a mediator to the handler that carries each one out", mediated.len()) });
    }
    let (entering, working, keeping) = (count(ENTERING), count(WORKING), count(KEEPING));
    if entering > 0 && working > 0 && keeping > 0 {
        styles.push(Style { style: "layered", evidence: format!("{entering} entry components hand work to {working} application components, which reach the data through {keeping} data components") });
    }
    if modules.len() >= MODULES_AT_LEAST {
        styles.push(Style { style: "modular", evidence: format!("{} modules are declared, each holding its own parts", modules.len()) });
    }
    let reacting = count(REACTING);
    if reacting as usize >= MODULES_AT_LEAST && reacting >= count(&["controller", "handler"]) {
        styles.push(Style { style: "event-driven", evidence: format!("{reacting} components run on events, messages or a schedule rather than on requests") });
    }
    let held_stages = stages_of(project, sources, &named);
    let registering = held_stages.iter().filter(|held| held.split('\u{1}').nth(1).and_then(|id| named.get(id)).is_some_and(|node| takes_a_registry(node))).count();
    let stages: Vec<String> = held_stages.iter().map(|held| held.split('\u{1}').next().unwrap_or_default().to_string()).collect();
    match (stages.is_empty(), registering * 2 >= stages.len()) {
        (true, _) => {}
        (false, true) => styles.push(Style { style: "composition root", evidence: format!("one start-up routine registers {} groups of services into the application", stages.len()) }),
        (false, false) => styles.push(Style { style: "pipeline", evidence: format!("one orchestrator runs {} stages in order", stages.len()) }),
    }
    let stages = match registering * 2 >= stages.len() {
        true => Vec::new(),
        false => stages,
    };
    let Orchestrated { starts, provisions } = orchestrated(project, sources, &named);
    if !starts.is_empty() {
        styles.push(Style { style: "orchestrator", evidence: format!("it starts {} parts and provisions {} resources for them", starts.len(), provisions.len()) });
    }
    Shape { components, modules, organised_by, styles, stages, starts, provisions }
}

pub fn steady(name: &str, shape: &Shape, frameworks: &[String]) -> String {
    let styles: Vec<&str> = shape.styles.iter().map(|style| style.style).collect();
    let components: Vec<&str> = shape.components.iter().map(|component| component.label.as_str()).collect();
    format!(
        "{name}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
        shape.organised_by,
        frameworks.join(","),
        styles.join(","),
        shape.stages.join(","),
        shape.starts.join(","),
        shape.provisions.join(","),
        shape.modules.join(","),
        components.join(",")
    )
}

pub fn told(name: &str, shape: &Shape, frameworks: &[String]) -> String {
    let mut told = format!("part: {name}\n");
    if shape.organised_by != "not shown" {
        told.push_str(&format!("organised by: {}\n", shape.organised_by));
    }
    if !frameworks.is_empty() {
        told.push_str(&format!("built on: {}\n", frameworks.join(", ")));
    }
    for style in &shape.styles {
        told.push_str(&format!("style {}: {}\n", style.style, style.evidence));
    }
    if !shape.stages.is_empty() {
        told.push_str(&format!("stages in order: {}\n", shape.stages.join(", ")));
    }
    if !shape.starts.is_empty() {
        told.push_str(&format!("starts these parts: {}\n", shape.starts.join(", ")));
    }
    if !shape.provisions.is_empty() {
        told.push_str(&format!("provisions these resources: {}\n", shape.provisions.join(", ")));
    }
    if !shape.modules.is_empty() {
        told.push_str(&format!("modules: {}\n", shape.modules.join(", ")));
    }
    for component in &shape.components {
        told.push_str(&format!("{} ({}): e.g. {}\n", component.label, component.units, component.examples.join(", ")));
    }
    told
}

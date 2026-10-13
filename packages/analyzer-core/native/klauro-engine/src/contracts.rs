use std::collections::BTreeSet;

use rustc_hash::FxHashMap as HashMap;
use serde::Serialize;

use crate::comprehend::Flow;
use crate::entry_exit::ExitPoint;
use crate::icelot::Icelot;
use crate::steps::Region;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Input {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Constraints {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub throws: Vec<String>,
    #[serde(skip_serializing_if = "nothing")]
    pub guards: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Effects {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub integrations: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub exits: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Logic {
    #[serde(skip_serializing_if = "nothing")]
    pub branches: u32,
    #[serde(skip_serializing_if = "nothing")]
    pub loops: u32,
    #[serde(skip_serializing_if = "nothing")]
    pub awaits: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Output {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub returns: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Contract {
    #[serde(skip_serializing_if = "Input::is_empty")]
    pub input: Input,
    #[serde(skip_serializing_if = "Constraints::is_empty")]
    pub constraints: Constraints,
    #[serde(skip_serializing_if = "Effects::is_empty")]
    pub effects: Effects,
    #[serde(skip_serializing_if = "Logic::is_empty")]
    pub logic: Logic,
    #[serde(skip_serializing_if = "Output::is_empty")]
    pub output: Output,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub telemetry: Vec<String>,
}

fn nothing(held: &u32) -> bool {
    *held == 0
}

impl Input {
    fn is_empty(&self) -> bool {
        self.types.is_empty() && self.reads.is_empty()
    }
}

impl Constraints {
    fn is_empty(&self) -> bool {
        self.throws.is_empty() && self.guards == 0
    }
}

impl Effects {
    fn is_empty(&self) -> bool {
        self.writes.is_empty() && self.integrations.is_empty() && self.exits.is_empty()
    }
}

impl Logic {
    fn is_empty(&self) -> bool {
        self.branches == 0 && self.loops == 0 && self.awaits == 0
    }
}

impl Output {
    fn is_empty(&self) -> bool {
        self.returns.is_empty()
    }
}

impl Contract {
    pub fn is_empty(&self) -> bool {
        self == &Contract::default()
    }
}

#[derive(Default)]
struct Gathered {
    types: BTreeSet<String>,
    reads: BTreeSet<String>,
    throws: BTreeSet<String>,
    guards: u32,
    writes: BTreeSet<String>,
    integrations: BTreeSet<String>,
    exits: BTreeSet<String>,
    branches: u32,
    loops: u32,
    awaits: u32,
    returns: BTreeSet<String>,
    telemetry: BTreeSet<String>,
}

type Exits<'a> = HashMap<&'a str, &'a ExitPoint>;

fn said_of(exit: &ExitPoint) -> String {
    let reached = exit.addressed.as_deref().unwrap_or(exit.target.as_str());
    [exit.kind, exit.method.unwrap_or_default(), exit.operation.as_str(), reached].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ")
}

impl Gathered {
    fn add(&mut self, unit: &Icelot, within: Option<(u32, u32)>, with_signature: bool, exits: &Exits) {
        if with_signature {
            self.types.extend(unit.input.types.iter().cloned());
            self.returns.extend(unit.output.return_type.iter().cloned());
        }
        self.reads.extend(unit.input.reads.iter().cloned());
        self.throws.extend(unit.constraints.throws.iter().cloned());
        self.guards += u32::from(unit.constraints.guards);
        self.writes.extend(unit.effects.writes.iter().cloned());
        for exit in unit.effects.exits.iter().filter_map(|id| exits.get(id.as_str())) {
            if within.is_none_or(|(start, end)| (start..=end).contains(&exit.line)) {
                self.exits.insert(said_of(exit));
                self.integrations.extend(exit.service.iter().cloned());
            }
        }
        self.branches += u32::from(unit.logic.branches);
        self.loops += u32::from(unit.logic.loops);
        self.awaits += u32::from(unit.logic.awaits);
        for site in &unit.telemetry {
            if within.is_none_or(|(start, end)| (start..=end).contains(&site.line)) {
                self.telemetry.insert(format!("{}: {}", site.kind, site.callee));
            }
        }
    }

    fn contract(self) -> Contract {
        let listed = |held: BTreeSet<String>| held.into_iter().collect::<Vec<_>>();
        Contract {
            input: Input { types: listed(self.types), reads: listed(self.reads) },
            constraints: Constraints { throws: listed(self.throws), guards: self.guards },
            effects: Effects { writes: listed(self.writes), integrations: listed(self.integrations), exits: listed(self.exits) },
            logic: Logic { branches: self.branches, loops: self.loops, awaits: self.awaits },
            output: Output { returns: listed(self.returns) },
            telemetry: listed(self.telemetry),
        }
    }
}

fn of_regions(regions: &[Region], units: &HashMap<&str, &Icelot>, exits: &Exits) -> Contract {
    let mut gathered = Gathered::default();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for region in regions {
        let Some(unit) = units.get(region.unit.as_str()) else { continue };
        let within = (region.end_line >= region.start_line && region.end_line > 0).then_some((region.start_line, region.end_line));
        if seen.insert(region.unit.as_str()) {
            gathered.add(unit, within, false, exits);
        } else {
            for site in &unit.telemetry {
                if within.is_none_or(|(start, end)| (start..=end).contains(&site.line)) {
                    gathered.telemetry.insert(format!("{}: {}", site.kind, site.callee));
                }
            }
        }
    }
    gathered.contract()
}

pub(crate) fn of_flow(flow: &Flow, units: &HashMap<&str, &Icelot>, exits: &Exits) -> Contract {
    let mut gathered = Gathered::default();
    let entry = flow.path.first().map(|start| start.unit.as_str());
    if let Some(unit) = entry.and_then(|entry| units.get(entry)) {
        gathered.add(unit, None, true, exits);
    }
    let mut seen: BTreeSet<&str> = entry.into_iter().collect();
    for step in &flow.steps {
        for region in &step.regions {
            if seen.insert(region.unit.as_str())
                && let Some(unit) = units.get(region.unit.as_str())
            {
                gathered.add(unit, None, false, exits);
            }
        }
    }
    gathered.types.extend(flow.takes.iter().cloned());
    gathered.reads.extend(flow.reads.iter().cloned());
    gathered.writes.extend(flow.writes.iter().chain(flow.changes.iter()).cloned());
    gathered.integrations.extend(flow.reaches.iter().cloned());
    gathered.contract()
}

const WRITING: &[&str] = &["keep", "change", "create", "remove"];
const SENDING: &[&str] = &["send", "notify", "hand_off", "raise"];

fn said_by_the_step(step: &crate::steps::LogicalStep, contract: &mut Contract) {
    let Some(object) = step.object.as_deref().filter(|object| !object.is_empty()) else { return };
    let add = |held: &mut Vec<String>, said: String| {
        if !held.contains(&said) {
            held.push(said);
            held.sort();
        }
    };
    match step.kind {
        kind if WRITING.contains(&kind) => add(&mut contract.effects.writes, object.to_string()),
        "read" => add(&mut contract.input.reads, object.to_string()),
        kind if SENDING.contains(&kind) => add(&mut contract.effects.exits, format!("{kind} {object}")),
        "refuse" => add(&mut contract.constraints.throws, object.to_string()),
        _ => {}
    }
}

pub fn attach(flows: &mut [Flow], icelot: &[Icelot], exit_points: &[ExitPoint]) -> usize {
    let units: HashMap<&str, &Icelot> = icelot.iter().map(|unit| (unit.unit.as_str(), unit)).collect();
    let exits: Exits = exit_points.iter().map(|exit| (exit.id.as_str(), exit)).collect();
    let mut held = 0;
    for flow in flows.iter_mut() {
        for step in flow.steps.iter_mut() {
            let mut contract = of_regions(&step.regions, &units, &exits);
            said_by_the_step(step, &mut contract);
            step.contract = (!contract.is_empty()).then_some(contract);
        }
        let contract = of_flow(flow, &units, &exits);
        if !contract.is_empty() {
            held += 1;
        }
        flow.contract = (!contract.is_empty()).then_some(contract);
    }
    held
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(id: &str) -> Icelot {
        Icelot {
            unit: id.to_string(),
            input: crate::icelot::Input::default(),
            constraints: crate::icelot::Constraints::default(),
            effects: crate::icelot::Effects::default(),
            logic: crate::icelot::Logic::default(),
            output: crate::icelot::Output::default(),
            telemetry: Vec::new(),
        }
    }

    fn region(unit: &str, start: u32, end: u32) -> Region {
        Region { unit: unit.to_string(), file: 0, start_line: start, end_line: end }
    }

    #[test]
    fn a_step_gathers_the_facets_of_the_code_it_maps_to_and_only_the_telemetry_inside_its_lines() {
        let mut save = unit("orders.py:function:save");
        save.constraints.throws = vec!["ValidationError".to_string()];
        save.constraints.guards = 2;
        save.effects.writes = vec!["Order".to_string()];
        save.logic.branches = 3;
        save.telemetry = vec![
            crate::icelot::TelemetrySite { kind: "log", callee: "logger.info".to_string(), line: 12 },
            crate::icelot::TelemetrySite { kind: "metric", callee: "orders.increment".to_string(), line: 40 },
        ];
        let units: HashMap<&str, &Icelot> = HashMap::from_iter([("orders.py:function:save", &save)]);
        let contract = of_regions(&[region("orders.py:function:save", 10, 20)], &units, &Exits::default());
        assert_eq!(contract.constraints, Constraints { throws: vec!["ValidationError".to_string()], guards: 2 });
        assert_eq!(contract.effects.writes, ["Order"]);
        assert_eq!(contract.logic.branches, 3);
        assert_eq!(contract.telemetry, ["log: logger.info"]);
    }

    #[test]
    fn code_mapped_to_a_step_twice_is_counted_once() {
        let mut save = unit("a:function:save");
        save.logic.branches = 2;
        let units: HashMap<&str, &Icelot> = HashMap::from_iter([("a:function:save", &save)]);
        let contract = of_regions(&[region("a:function:save", 1, 5), region("a:function:save", 6, 9)], &units, &Exits::default());
        assert_eq!(contract.logic.branches, 2);
    }

    #[test]
    fn a_step_with_no_known_code_has_no_contract() {
        let units: HashMap<&str, &Icelot> = HashMap::default();
        assert!(of_regions(&[region("missing", 1, 2)], &units, &Exits::default()).is_empty());
    }
}

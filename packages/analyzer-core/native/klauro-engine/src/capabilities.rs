use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::author::{Placed, Proposal, Proposed, Serving};
use crate::comprehend::{carved_name, settle, Capability, Delivery, Family, Flow, PUBLISHED};

const FAMILIES_PER_PROPOSAL: usize = 20;
const READINGS: usize = 3;

fn most_detailed_reading(said: &str, listed: &[(String, String)]) -> Proposal {
    let orders: Vec<Vec<(String, String)>> = (0..READINGS)
        .map(|at| {
            let mut ordered = listed.to_vec();
            match at {
                0 => {}
                1 => ordered.reverse(),
                _ => ordered.rotate_left(listed.len() / 2),
            }
            ordered
        })
        .collect();
    let readings: Vec<Proposal> = orders
        .par_iter()
        .map(|ordered| crate::author::propose_capabilities(said, ordered))
        .collect();
    let settled = |reading: &Proposal| {
        let named: BTreeSet<&str> = reading
            .capabilities
            .iter()
            .flat_map(|held| held.families.iter().map(String::as_str))
            .chain(reading.unassigned.iter().map(String::as_str))
            .collect();
        listed.iter().filter(|(id, _)| named.contains(id.as_str())).count()
    };
    readings
        .into_iter()
        .enumerate()
        .max_by_key(|(at, reading)| {
            (settled(reading), std::cmp::Reverse(reading.capabilities.len()), std::cmp::Reverse(*at))
        })
        .map(|(_, reading)| reading)
        .unwrap_or_default()
}
const SURFACES_SHOWN: usize = 6;
const CAPABILITIES_CONSOLIDATED_AT_ONCE: usize = 160;

struct Held {
    name: String,
    description: String,
    audience: String,
    families: BTreeSet<String>,
    roles: BTreeMap<String, Serving>,
}

impl Held {
    fn absorb(&mut self, other: Held) {
        self.families.extend(other.families);
        for (family, serving) in other.roles {
            self.roles.entry(family).or_insert(serving);
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Remembered {
    digest: String,
    capabilities: Vec<RememberedCapability>,
    #[serde(default, alias = "plumbing")]
    unassigned: BTreeSet<String>,
    families: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct RememberedCapability {
    name: String,
    description: String,
    audience: String,
    families: BTreeSet<String>,
    #[serde(default)]
    roles: BTreeMap<String, (String, String)>,
}

pub(crate) type Fields = BTreeMap<String, String>;

const RECORDS_DESCRIBED: usize = 4;

static SERVED_KINDS: &[&str] = &["background", "cli", "event", "graphql", "http", "message", "rpc", "schedule", "websocket"];

pub(crate) const RECORDS_HOLD: &str = "what the records it touches hold:";

fn recalled(key: &str) -> Option<Remembered> {
    crate::memory::recalled("capabilities", key)
}

fn keep_in_memory(key: &str, remembered: &Remembered) {
    crate::memory::keep("capabilities", key, remembered);
}

const PATHS_SHOWN: usize = 5;
const STEPS_TOLD: usize = 7;

fn changes_in(flow: &Flow) -> impl Iterator<Item = &str> {
    flow.steps
        .iter()
        .rev()
        .filter(|step| matches!(step.kind, "change" | "remove" | "create"))
        .filter_map(|step| step.object.as_deref())
        .filter(|object| flow.writes.iter().any(|held| held == object))
}

fn kept_for_itself<'a>(flows: &[&'a Flow]) -> BTreeSet<&'a str> {
    let mut changed_by: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for flow in flows {
        for record in &flow.writes {
            let held = changed_by.entry(record.as_str()).or_default();
            held.0 += 1;
            if flow.writes.len() == 1 {
                held.1 += 1;
            }
        }
    }
    changed_by
        .into_iter()
        .filter(|(_, (changing, alone))| *changing >= 3 && *alone == 0)
        .map(|(record, _)| record)
        .collect()
}

static SAID_OF_AN_EVENT: &[&str] = &["UiEvent", "UIEvent", "ViewEvent", "Event", "Intent", "Action"];

static KEEPS_A_SCREEN: &[&str] = &["Presenter", "ViewModel", "Reducer", "Feature"];

fn screen_of(flow: &Flow) -> Option<String> {
    if flow.kind != "ui" {
        return None;
    }
    let screen = match flow.operation.split_once('.') {
        Some((family, _)) => SAID_OF_AN_EVENT.iter().find_map(|suffix| family.strip_suffix(suffix)).unwrap_or(family),
        None => KEEPS_A_SCREEN.iter().find_map(|suffix| flow.operation.strip_suffix(suffix))?,
    };
    (!screen.is_empty()).then(|| screen.to_string())
}

static NAMED_COMMAND_KINDS: &[&str] = &["ipc", "cli", "tool"];

fn asked_for_by_name(flow: &Flow) -> Option<&str> {
    let named_kind = NAMED_COMMAND_KINDS.contains(&flow.kind)
        || (flow.kind == "http" && flow.method.is_none() && !flow.operation.starts_with('/'));
    (named_kind && !flow.operation.is_empty()).then(|| flow.operation.as_str())
}

fn outcome_of(flow: &Flow, bookkeeping: &BTreeSet<&str>) -> Family {
    if flow.kind == "export" {
        return crate::comprehend::family_of(flow);
    }
    if let Some(named) = asked_for_by_name(flow) {
        return Family {
            key: format!("asks:{named}"),
            basis: "the command someone explicitly asked it to run",
        };
    }
    if let Some(record) = changes_in(flow).find(|record| !bookkeeping.contains(record)) {
        return Family { key: format!("changes:{record}"), basis: "the record it changes" };
    }
    if flow.changes.iter().any(|change| change.starts_with("client_storage:")) {
        let kept = screen_of(flow).unwrap_or_else(|| flow.operation.clone());
        return Family { key: format!("keeps:{kept}"), basis: "what it keeps on the person's device" };
    }
    let handed: Option<&str> = flow
        .steps
        .iter()
        .rev()
        .filter(|step| matches!(step.kind, "raise" | "hand_off"))
        .find_map(|step| step.object.as_deref());
    if let Some(handed) = handed {
        return Family { key: format!("hands on:{handed}"), basis: "what it hands on to another part" };
    }
    if let Some(record) = changes_in(flow).next() {
        return Family { key: format!("changes:{record}"), basis: "the record it changes" };
    }
    let acted: Option<&str> =
        flow.steps.iter().rev().filter(|step| step.kind == "do").find_map(|step| step.doing.as_deref());
    if let Some(acted) = acted {
        return Family { key: format!("acts:{acted}"), basis: "the action it takes" };
    }
    let called: Option<&str> =
        flow.steps.iter().rev().filter(|step| step.kind == "call").find_map(|step| step.object.as_deref());
    if let Some(called) = called.filter(|_| flow.standing == "terminal") {
        return Family { key: format!("calls:{called}"), basis: "the service it acts through" };
    }
    if let Some(screen) = screen_of(flow) {
        return Family { key: format!("screen:{screen}"), basis: "the screen a person acts on" };
    }
    let shown: Option<&str> = flow
        .steps
        .iter()
        .rev()
        .filter(|step| step.kind == "read")
        .find_map(|step| step.object.as_deref().filter(|object| flow.reads.iter().any(|held| held == object)))
        .or_else(|| flow.reads.first().map(String::as_str));
    if let Some(shown) = shown {
        return Family { key: format!("shows:{shown}"), basis: "what it shows someone" };
    }
    crate::comprehend::family_of(flow)
}

const WORKS_IN: &str = "within:";
const STAGE: &str = "stage:";
const FUNCTIONS_TOLD: usize = 14;
const SPLIT_FROM_FLOWS: usize = 40;
const SPLIT_FROM_STAGES: usize = 12;
const SPLIT_OUTCOMES_SHOWN: usize = 80;
const SPLIT_LINES_PER_OUTCOME: usize = 4;
const OUTCOMES_PER_SPLIT: usize = 12;
const STAGES_AT_LEAST: usize = 6;
const STAGED_PART_FLOWS_AT_MOST: usize = 6;

fn is_a_program_with_stages(flow: &Flow, flows_in_part: usize) -> bool {
    matches!(flow.kind, "lifecycle" | "cli") && flow.stages.len() >= STAGES_AT_LEAST && flows_in_part <= STAGED_PART_FLOWS_AT_MOST
}

fn evidence_of_stage(flow: &Flow, module: &str) -> String {
    let Some(stage) = flow.stages.iter().find(|stage| stage.module == module) else {
        return format!("  outcome (proximal): {module}, which is the stage of its work done there");
    };
    format!(
        "  outcome (terminal): the work {} does in {}, which is a stage of what it carries out\n  the functions it runs there: {}\n  it reaches out through: {}\n  units of its {} that run there: {}",
        surface_of(flow),
        stage.module,
        stage.names.join(", "),
        match stage.leaves.is_empty() {
            true => "nothing outside this program".to_string(),
            false => stage.leaves.join(", "),
        },
        flow.units,
        stage.units
    )
}

fn module_of(flow: &Flow) -> &str {
    let unit = flow.path.first().map(|step| step.unit.as_str()).unwrap_or(flow.entry_point.as_str());
    unit.strip_prefix("entry:").unwrap_or(unit).split(':').next().unwrap_or_default()
}

fn is_only_a_trigger(family: &Family) -> bool {
    family.key.starts_with("trigger:")
}

pub(crate) fn outcomes_of<'a>(flows: &[&'a Flow]) -> BTreeMap<Family, Vec<&'a Flow>> {
    let bookkeeping = kept_for_itself(flows);
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    for flow in flows {
        if is_a_program_with_stages(flow, flows.len()) {
            for stage in &flow.stages {
                let family = Family { key: format!("{STAGE}{}", stage.module), basis: "the stage of its work done in that module" };
                grouped.entry(family).or_default().push(flow);
            }
            continue;
        }
        grouped.entry(outcome_of(flow, &bookkeeping)).or_default().push(flow);
    }
    if grouped.keys().any(|family| !is_only_a_trigger(family)) {
        grouped.retain(|family, _| !is_only_a_trigger(family));
    } else {
        grouped = BTreeMap::new();
        for flow in flows {
            let family = Family { key: format!("{WORKS_IN}{}", module_of(flow)), basis: "the module it works in" };
            grouped.entry(family).or_default().push(flow);
        }
    }
    for lane in grouped.values_mut() {
        lane.sort_by(|left, right| left.id.cmp(&right.id));
    }
    grouped
}

pub(crate) fn told_steps(flow: &Flow) -> String {
    let mut said: Vec<&str> = Vec::new();
    for step in &flow.steps {
        if step.kind == "respond" && step.object.is_none() {
            continue;
        }
        if said.last() != Some(&step.label.as_str()) {
            said.push(step.label.as_str());
        }
    }
    let more = said.len().saturating_sub(STEPS_TOLD);
    said.truncate(STEPS_TOLD);
    let mut told = said.join(" -> ");
    if more > 0 {
        told.push_str(&format!(" -> and {more} more"));
    }
    if told.is_empty() {
        told = touched_by(flow);
    }
    told
}

fn touched_by(flow: &Flow) -> String {
    let mut touched: Vec<&str> = Vec::new();
    for step in &flow.path {
        let name = step.unit.rsplit(':').next().unwrap_or_default();
        if !name.is_empty() && touched.last() != Some(&name) && !touched.contains(&name) {
            touched.push(name);
        }
    }
    let more = touched.len().saturating_sub(STEPS_TOLD);
    touched.truncate(STEPS_TOLD);
    match touched.is_empty() {
        true => "no steps read".to_string(),
        false => format!(
            "no steps read; it runs through {}{}",
            touched.join(" -> "),
            match more {
                0 => String::new(),
                more => format!(" -> and {more} more"),
            }
        ),
    }
}

pub(crate) fn surface_of(flow: &Flow) -> String {
    match flow.method.as_deref() {
        Some(method) => format!("{method} {}", flow.operation),
        None => format!("{} {}", flow.kind, flow.operation),
    }
}

fn only_relays_a_signal(flows: &[&Flow]) -> bool {
    !flows.is_empty()
        && flows.iter().all(|flow| {
            flow.writes.is_empty()
                && flow.changes.is_empty()
                && flow.reads.is_empty()
                && flow.reaches.is_empty()
                && flow.steps.iter().any(|step| matches!(step.kind, "raise" | "hand_off"))
                && flow.steps.iter().all(|step| matches!(step.kind, "raise" | "hand_off" | "respond"))
        })
}

const ONLY_PASSES_A_SIGNAL: &str =
    "; its paths only pass a signal on or hand what arrives to another part, and change, call and keep nothing themselves";

pub(crate) fn terminality_of(family: &Family, flows: &[&Flow]) -> &'static str {
    match family.key.split(':').next().unwrap_or_default() {
        "asks" if only_relays_a_signal(flows) => "proximal",
        "changes" | "hands on" | "calls" | "acts" | "keeps" | "asks" | "stage" => "terminal",
        _ => "proximal",
    }
}

fn evidence_of(flows: &[&Flow], family: &Family, fields: &Fields) -> String {
    if let (Some(module), [flow]) = (family.key.strip_prefix(STAGE), flows) {
        return evidence_of_stage(flow, module);
    }
    let mut surfaces: Vec<String> = flows.iter().map(|flow| surface_of(flow)).collect();
    settle(&mut surfaces);
    let more = surfaces.len().saturating_sub(SURFACES_SHOWN);
    surfaces.truncate(SURFACES_SHOWN);
    let mut kinds: Vec<String> = flows.iter().map(|flow| flow.kind.to_string()).collect();
    settle(&mut kinds);
    let mut writes: Vec<String> = flows.iter().flat_map(|flow| flow.writes.iter().cloned()).collect();
    settle(&mut writes);
    let mut reads: Vec<String> = flows.iter().flat_map(|flow| flow.reads.iter().cloned()).collect();
    settle(&mut reads);
    reads.retain(|held| !writes.contains(held));
    let mut reaches: Vec<String> = flows.iter().flat_map(|flow| flow.reaches.iter().cloned()).collect();
    settle(&mut reaches);
    let mut guarded: Vec<String> = flows
        .iter()
        .flat_map(|flow| flow.steps.iter().filter(|step| step.kind == "check").take(1))
        .filter_map(|step| step.object.clone())
        .collect();
    settle(&mut guarded);
    guarded.truncate(4);
    let mut shown: Vec<&&Flow> = flows.iter().collect();
    shown.sort_by_key(|flow| std::cmp::Reverse(flow.steps.len()));
    shown.truncate(PATHS_SHOWN);
    shown.sort_by(|left, right| left.id.cmp(&right.id));
    let listed = |held: &[String]| match held.is_empty() {
        true => "none".to_string(),
        false => held.join(", "),
    };
    let (_, object) = family.key.split_once(':').unwrap_or(("", family.key.as_str()));
    let functions_run: Vec<&str> = match flows {
        [flow] if matches!(flow.kind, "lifecycle" | "cli") => {
            flow.stages.iter().flat_map(|stage| stage.names.iter().map(String::as_str)).take(FUNCTIONS_TOLD).collect()
        }
        _ => Vec::new(),
    };
    let kept: Vec<String> = writes
        .iter()
        .chain(reads.iter())
        .filter_map(|record| fields.get(record).map(|held| format!("{record} ({held})")))
        .take(RECORDS_DESCRIBED)
        .collect();
    format!(
        "  outcome ({}): {}, which is {}\n  {RECORDS_HOLD} {}\n  entered as: {}\n  reached through: {}{}\n  guarded by: {}\n  what its paths do:\n{}{}\n  writes: {}\n  reads: {}\n  reaches: {}\n  paths: {}",
        terminality_of(family, flows),
        object,
        match family.key.starts_with("asks:") && only_relays_a_signal(flows) {
            true => format!("{}{ONLY_PASSES_A_SIGNAL}", family.basis),
            false => family.basis.to_string(),
        },
        listed(&kept),
        kinds.join(", "),
        surfaces.join(", "),
        match more {
            0 => String::new(),
            more => format!(" and {more} more"),
        },
        listed(&guarded),
        shown
            .iter()
            .map(|flow| format!("    - {}: {}", surface_of(flow), told_steps(flow)))
            .collect::<Vec<_>>()
            .join("\n"),
        match functions_run.is_empty() {
            true => String::new(),
            false => format!("\n  the functions it runs: {}", functions_run.join(", ")),
        },
        listed(&writes),
        listed(&reads),
        listed(&reaches),
        flows.len()
    )
}

fn gather(proposals: Vec<Proposal>, held: &mut Vec<Held>, unassigned: &mut BTreeSet<String>, known: &BTreeSet<String>) {
    for proposal in proposals {
        unassigned.extend(proposal.unassigned.into_iter().filter(|id| known.contains(id)));
        for Proposed { name, description, audience, families, roles } in proposal.capabilities {
            let families: BTreeSet<String> = families.into_iter().filter(|id| known.contains(id)).collect();
            if families.is_empty() {
                continue;
            }
            let roles = roles.into_iter().filter(|(id, _)| families.contains(id)).collect();
            let incoming = Held { name, description, audience, families, roles };
            match held.iter_mut().find(|other| name_key(&other.name) == name_key(&incoming.name)) {
                Some(other) => other.absorb(incoming),
                None => held.push(incoming),
            }
        }
    }
}

fn merge_same_named(held: &mut Vec<Held>) {
    let mut at = 0;
    while at < held.len() {
        let key = name_key(&held[at].name);
        let mut other = at + 1;
        while other < held.len() {
            if !key.is_empty() && name_key(&held[other].name) == key {
                let merged = held.remove(other);
                held[at].absorb(merged);
            } else {
                other += 1;
            }
        }
        at += 1;
    }
}

fn consolidate_purposes(said: &str, held: Vec<Held>) -> Vec<Held> {
    if held.len() < 2 {
        return held;
    }
    let listed: Vec<(String, String)> =
        held.iter().map(|other| (other.name.clone(), other.description.clone())).collect();
    let groups = the_same_among(&listed, |offered| crate::author::same_capability(said, offered));
    if groups.is_empty() {
        return held;
    }
    let mut slots: Vec<Option<Held>> = held.into_iter().map(Some).collect();
    let mut kept: Vec<Held> = Vec::new();
    for group in groups {
        let mut members = group.members.iter();
        let Some(mut together) = members.next().and_then(|at| slots[*at].take()) else { continue };
        for at in members {
            if let Some(other) = slots[*at].take() {
                together.absorb(other);
            }
        }
        if !group.name.is_empty() {
            together.name = group.name;
        }
        if !group.description.is_empty() {
            together.description = group.description;
        }
        if !group.audience.is_empty() {
            together.audience = group.audience;
        }
        kept.push(together);
    }
    kept.extend(slots.into_iter().flatten());
    kept
}

fn is_unassigned_word(said: &str) -> bool {
    matches!(said.trim().to_ascii_lowercase().as_str(), "unassigned" | "plumbing" | "none")
}

fn place(
    said: &str,
    told: &BTreeMap<String, String>,
    held: &mut Vec<Held>,
    unassigned: &mut BTreeSet<String>,
) -> bool {
    let placed: BTreeSet<String> = held.iter().flat_map(|other| other.families.iter().cloned()).collect();
    let unplaced: Vec<(String, String)> = told
        .iter()
        .filter(|(id, _)| !placed.contains(*id) && !unassigned.contains(*id))
        .map(|(id, evidence)| (id.clone(), evidence.clone()))
        .collect();
    if unplaced.is_empty() {
        return false;
    }
    let standing: Vec<(String, String)> =
        held.iter().map(|other| (other.name.clone(), other.description.clone())).collect();
    let answers: Vec<Placed> = unplaced
        .par_chunks(FAMILIES_PER_PROPOSAL)
        .flat_map(|chunk| crate::author::place_families(said, &standing, chunk))
        .collect();
    let answered = !answers.is_empty();
    for Placed { family, capability, description, audience, role, why } in answers {
        if !told.contains_key(&family) || placed.contains(&family) {
            continue;
        }
        if is_unassigned_word(&capability) {
            unassigned.insert(family);
            continue;
        }
        let roles: BTreeMap<String, Serving> = crate::author::role_named(&role)
            .map(|role| BTreeMap::from([(family.clone(), Serving { role: role.to_string(), why: why.trim().to_string() })]))
            .unwrap_or_default();
        match held.iter_mut().find(|other| name_key(&other.name) == name_key(&capability)) {
            Some(other) => other.absorb(Held {
                name: capability,
                description,
                audience,
                families: BTreeSet::from([family]),
                roles,
            }),
            None => held.push(Held { name: capability, description, audience, families: BTreeSet::from([family]), roles }),
        }
    }
    answered
}

pub(crate) fn is_proposable(flow: &Flow) -> bool {
    !crate::unshipped::is_set_aside(flow.unshipped.as_ref())
}

fn lines_of_outcomes(held: &Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>) -> Vec<(usize, String)> {
    let mut lines: Vec<(usize, String)> = Vec::new();
    for family_id in &held.families {
        let Some((family, lane)) = lanes.get(family_id.as_str()) else { continue };
        let (_, object) = family.key.split_once(':').unwrap_or(("", family.key.as_str()));
        let role = held.roles.get(family_id).map(|serving| serving.role.as_str()).unwrap_or("primary");
        let mut surfaces: Vec<String> = lane.iter().map(|flow| surface_of(flow)).collect();
        settle(&mut surfaces);
        let more = surfaces.len().saturating_sub(OUTCOME_SURFACES);
        surfaces.truncate(OUTCOME_SURFACES);
        lines.push((
            lane.len(),
            format!(
                "    - {role}: {object}, reached through {}{}",
                surfaces.join(", "),
                match more {
                    0 => String::new(),
                    more => format!(" and {more} more"),
                }
            ),
        ));
    }
    lines.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    lines
}

const OUTCOMES_LISTED: usize = 40;
const OUTCOME_SURFACES: usize = 2;
const OUTCOMES_DETAILED: usize = 2;

fn evidence_of_capability(held: &Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>, fields: &Fields) -> String {
    let lines = lines_of_outcomes(held, lanes);
    let more = lines.len().saturating_sub(OUTCOMES_LISTED);
    let mut told = format!(
        "  it is served by {} outcomes, each with its role in it:\n{}{}",
        lines.len(),
        lines.iter().take(OUTCOMES_LISTED).map(|(_, line)| line.as_str()).collect::<Vec<_>>().join("\n"),
        match more {
            0 => String::new(),
            more => format!("\n    - and {more} more outcomes"),
        }
    );
    let mut main: Vec<(&Family, &Vec<&Flow>)> =
        held.families.iter().filter_map(|id| lanes.get(id.as_str()).copied()).collect();
    main.sort_by(|left, right| right.1.len().cmp(&left.1.len()).then_with(|| left.0.key.cmp(&right.0.key)));
    for (family, lane) in main.into_iter().take(OUTCOMES_DETAILED) {
        told.push('\n');
        told.push_str(&evidence_of(lane, family, fields));
    }
    told
}

fn flows_held(held: &Held, lanes: &BTreeMap<&str, &Vec<&Flow>>) -> usize {
    held.families
        .iter()
        .filter_map(|id| lanes.get(id.as_str()))
        .flat_map(|lane| lane.iter().map(|flow| flow.id.as_str()))
        .collect::<BTreeSet<&str>>()
        .len()
}

fn split_the_broad(
    said: &str,
    told: &BTreeMap<String, String>,
    lanes: &BTreeMap<&str, &Vec<&Flow>>,
    key_of: &BTreeMap<&str, &str>,
    held: Vec<Held>,
    unassigned: &mut BTreeSet<String>,
) -> Vec<Held> {
    let stages_held = |held: &Held| {
        held.families.iter().filter(|id| key_of.get(id.as_str()).is_some_and(|key| key.starts_with(STAGE))).count()
    };
    let (broad, mut kept): (Vec<Held>, Vec<Held>) = held
        .into_iter()
        .partition(|other| flows_held(other, lanes) > SPLIT_FROM_FLOWS || stages_held(other) > SPLIT_FROM_STAGES);
    if broad.is_empty() {
        return kept;
    }
    let mut split_any = false;
    for wide in broad {
        let listed: Vec<(String, String)> = wide
            .families
            .iter()
            .filter_map(|id| told.get(id).map(|evidence| (id.clone(), evidence.lines().take(SPLIT_LINES_PER_OUTCOME).collect::<Vec<_>>().join("\n"))))
            .take(SPLIT_OUTCOMES_SHOWN)
            .collect();
        let proposal = crate::author::split_purpose(said, &wide.name, &wide.description, &listed, listed.len().div_ceil(OUTCOMES_PER_SPLIT).max(2));
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!("  split {} over {} outcomes into {} capabilities", wide.name, listed.len(), proposal.capabilities.len());
        }
        if proposal.capabilities.len() < 2 {
            kept.push(wide);
            continue;
        }
        split_any = true;
        let known: BTreeSet<String> = wide.families.clone();
        gather(vec![proposal], &mut kept, unassigned, &known);
    }
    if split_any {
        place(said, told, &mut kept, unassigned);
    }
    kept
}

pub(crate) fn of_a_part(flows: &[&Flow], said: &str, remembered_as: &str, fields: &Fields) -> Vec<Capability> {
    if flows.is_empty() {
        return Vec::new();
    }
    let bookkeeping = kept_for_itself(flows);
    let served = flows
        .iter()
        .any(|flow| SERVED_KINDS.contains(&flow.kind) && !is_only_a_trigger(&outcome_of(flow, &bookkeeping)));
    let proposable: Vec<&Flow> = flows
        .iter()
        .copied()
        .filter(|flow| !served || flow.kind != "export")
        .filter(|flow| is_proposable(flow))
        .collect();
    let behaving: Vec<&Flow> = proposable.iter().copied().filter(|flow| !only_moves_the_screen(flow)).collect();
    let kept = match behaving.is_empty() {
        true => proposable,
        false => behaving,
    };
    if std::env::var("KLAURO_FAMILY_DUMP").is_ok() {
        for family in outcomes_of(&kept).keys() {
            eprintln!("family[{remembered_as}]: {}", family.key);
        }
    }
    if !crate::author::asked() {
        return Vec::new();
    }
    let families = outcomes_of(&kept);
    let keyed: Vec<(String, &Family, &Vec<&Flow>)> = families
        .iter()
        .enumerate()
        .map(|(at, (family, lane))| (format!("f{at}"), family, lane))
        .collect();
    let told: BTreeMap<String, String> =
        keyed.iter().map(|(id, family, lane)| (id.clone(), evidence_of(lane, family, fields))).collect();
    let known: BTreeSet<String> = told.keys().cloned().collect();
    let key_of: BTreeMap<&str, &str> =
        keyed.iter().map(|(id, family, _)| (id.as_str(), family.key.as_str())).collect();
    let id_of: BTreeMap<&str, &str> = key_of.iter().map(|(id, key)| (*key, *id)).collect();
    let evidence_of_key: BTreeMap<String, String> = told
        .iter()
        .map(|(id, evidence)| {
            (
                key_of[id.as_str()].to_string(),
                crate::jev::named(&format!("{}\u{1}{said}\u{1}{evidence}", crate::author::PURPOSE_CONTRACT_VERSION)),
            )
        })
        .collect();
    let digest = crate::jev::named(&format!("{}\u{1}{said}\u{1}{:?}", crate::author::PURPOSE_CONTRACT_VERSION, evidence_of_key));
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("said of {}: {said}", remembered_as.replace('\u{1}', "/"));
        for (id, evidence) in &told {
            eprintln!("evidence {} {}\n{evidence}", remembered_as.replace('\u{1}', "/"), key_of[id.as_str()]);
        }
    }
    let memory = recalled(remembered_as).filter(|memory| !memory.capabilities.is_empty()).filter(|memory| {
        let carried = evidence_of_key.iter().filter(|(key, evidence)| memory.families.get(*key) == Some(*evidence)).count();
        carried * 2 >= evidence_of_key.len()
    });
    let (mut held, mut unassigned) = match memory {
        Some(memory) if memory.digest == digest => recollected(&memory, &id_of, |_| true),
        Some(memory) => {
            let (mut held, mut unassigned) = recollected(&memory, &id_of, |key| {
                memory.families.get(key).is_some_and(|was| evidence_of_key.get(key) == Some(was))
            });
            place(said, &told, &mut held, &mut unassigned);
            (held, unassigned)
        }
        None => {
            let listed: Vec<(String, String)> =
                told.iter().map(|(id, evidence)| (id.clone(), evidence.clone())).collect();
            let proposing = std::time::Instant::now();
            let proposals: Vec<Proposal> = match listed.len() <= FAMILIES_PER_PROPOSAL {
                true => vec![most_detailed_reading(said, &listed)],
                false => listed
                    .par_chunks(FAMILIES_PER_PROPOSAL)
                    .map(|chunk| most_detailed_reading(said, chunk))
                    .collect(),
            };
            let chunked = proposals.len() > 1;
            let mut held: Vec<Held> = Vec::new();
            let mut unassigned: BTreeSet<String> = BTreeSet::new();
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposing {} outcomes took {:?}", listed.len(), proposing.elapsed());
            }
            let proposed: usize = proposals.iter().map(|proposal| proposal.capabilities.len()).sum();
            gather(proposals, &mut held, &mut unassigned, &known);
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposed {proposed} capabilities, {} held after gathering, {} unassigned", held.len(), unassigned.len());
            }
            let clock = std::time::Instant::now();
            let counted = |step: &str, held: &Vec<Held>| {
                if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                    eprintln!("  after {step}: {} capabilities at {:?}", held.len(), clock.elapsed());
                }
            };
            if chunked {
                held = consolidate_purposes(said, held);
                counted("consolidating purposes", &held);
            }
            let first_look = unassigned.clone();
            if chunked {
                unassigned.clear();
            }
            if !place(said, &told, &mut held, &mut unassigned) {
                unassigned.extend(first_look);
            } else {
                let placed: BTreeSet<&String> = held.iter().flat_map(|other| other.families.iter()).collect();
                let left: Vec<String> =
                    known.iter().filter(|id| !placed.contains(id) && !unassigned.contains(*id)).cloned().collect();
                unassigned.extend(left);
            }
            counted("placing", &held);
            (held, unassigned)
        }
    };
    held.retain(|other| !other.families.is_empty());
    merge_same_named(&mut held);
    let lane_flows: BTreeMap<&str, &Vec<&Flow>> = keyed.iter().map(|(id, _, lane)| (id.as_str(), *lane)).collect();
    held = split_the_broad(said, &told, &lane_flows, &key_of, held, &mut unassigned);
    merge_same_named(&mut held);
    unassigned.retain(|id| known.contains(id) && !held.iter().any(|other| other.families.contains(id)));
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("  settled {} capabilities and {} unassigned of {} outcomes", held.len(), unassigned.len(), told.len());
        for id in &unassigned {
            eprintln!("  unassigned {}", key_of[id.as_str()]);
        }
    }
    let settled_every_family = told.keys().all(|id| {
        unassigned.contains(id) || held.iter().any(|other| other.families.contains(id))
    });
    if crate::author::asked() && settled_every_family && !held.is_empty() {
        keep_in_memory(
            remembered_as,
            &Remembered {
                digest,
                capabilities: held
                    .iter()
                    .map(|other| RememberedCapability {
                        name: other.name.clone(),
                        description: other.description.clone(),
                        audience: other.audience.clone(),
                        families: other.families.iter().map(|id| key_of[id.as_str()].to_string()).collect(),
                        roles: other
                            .roles
                            .iter()
                            .filter(|(id, _)| key_of.contains_key(id.as_str()))
                            .map(|(id, serving)| (key_of[id.as_str()].to_string(), (serving.role.clone(), serving.why.clone())))
                            .collect(),
                    })
                    .collect(),
                unassigned: unassigned.iter().map(|id| key_of[id.as_str()].to_string()).collect(),
                families: evidence_of_key.clone(),
            },
        );
    }
    let lanes: BTreeMap<&str, (&Family, &Vec<&Flow>)> =
        keyed.iter().map(|(id, family, lane)| (id.as_str(), (*family, *lane))).collect();
    let mut unanswered: Vec<Held> = known
        .iter()
        .filter(|id| !unassigned.contains(*id) && !held.iter().any(|other| other.families.contains(*id)))
        .filter(|id| !key_of.get(id.as_str()).is_some_and(|key| key.starts_with(WORKS_IN) || key.starts_with(STAGE)))
        .map(|id| structural(id, &key_of))
        .collect();
    merge_same_named(&mut unanswered);
    let mut formed: Vec<Capability> = held.into_iter().filter_map(|other| built(other, &lanes, fields)).collect();
    formed.extend(unanswered.into_iter().filter_map(|other| {
        built(other, &lanes, fields).map(|capability| Capability {
            unsettled: Some(crate::confidence::AI_UNANSWERED),
            standing: crate::comprehend::PROVISIONAL,
            ..capability
        })
    }));
    formed.sort_by(|left, right| left.id.cmp(&right.id));
    formed
}

fn recollected(
    memory: &Remembered,
    id_of: &BTreeMap<&str, &str>,
    still_holds: impl Fn(&str) -> bool,
) -> (Vec<Held>, BTreeSet<String>) {
    let held = memory
        .capabilities
        .iter()
        .map(|was| Held {
            name: was.name.clone(),
            description: was.description.clone(),
            audience: was.audience.clone(),
            families: was
                .families
                .iter()
                .filter(|key| still_holds(key))
                .filter_map(|key| id_of.get(key.as_str()).map(|id| id.to_string()))
                .collect(),
            roles: was
                .roles
                .iter()
                .filter(|(key, _)| still_holds(key))
                .filter_map(|(key, (role, why))| {
                    Some((id_of.get(key.as_str())?.to_string(), Serving { role: role.clone(), why: why.clone() }))
                })
                .collect(),
        })
        .collect();
    let unassigned = memory
        .unassigned
        .iter()
        .filter(|key| still_holds(key))
        .filter_map(|key| id_of.get(key.as_str()).map(|id| id.to_string()))
        .collect();
    (held, unassigned)
}

static SCREEN_EVENTS: &[&str] = &[
    "blur", "change", "click", "contextmenu", "dblclick", "domcontentloaded", "focus", "input", "keydown", "keypress",
    "keyup", "load", "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup",
    "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup", "resize",
    "scroll", "touchend", "touchmove", "touchstart", "visibilitychange", "wheel",
];

pub(crate) fn is_a_screen_event(operation: &str) -> bool {
    SCREEN_EVENTS.contains(&operation.to_ascii_lowercase().as_str())
}

fn only_moves_the_screen(flow: &Flow) -> bool {
    flow.kind == "event"
        && is_a_screen_event(&flow.operation)
        && flow.writes.is_empty()
        && !flow.steps.iter().any(|step| matches!(step.kind, "call" | "hand_off" | "raise" | "change" | "create" | "remove"))
}

fn structural(family: &str, key_of: &BTreeMap<&str, &str>) -> Held {
    let key = key_of.get(family).copied().unwrap_or(family);
    let (_, object) = key.split_once(':').unwrap_or(("", key));
    Held {
        name: object.to_string(),
        description: String::new(),
        audience: String::new(),
        families: BTreeSet::from([family.to_string()]),
        roles: BTreeMap::new(),
    }
}

fn built(held: Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>, fields: &Fields) -> Option<Capability> {
    let name = held.name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let evidence = evidence_of_capability(&held, lanes, fields);
    let mut capability = Capability {
        id: format!("capability:{}", carved_name(&name)),
        audience: Some(held.audience.trim().to_ascii_lowercase()).filter(|audience| !audience.is_empty()),
        delivered: Vec::new(),
        records: Vec::new(),
        changes: Vec::new(),
        flows: Vec::new(),
        surfaces: Vec::new(),
        project: None,
        also_in: Vec::new(),
        place: None,
        name: Some(name),
        description: Some(held.description.trim().to_string()).filter(|description| !description.is_empty()),
        grounding: None,
        standing: PUBLISHED,
        touches: Vec::new(),
        terminality: None,
        confidence: None,
        unsettled: None,
        composition_provenance: Vec::new(),
        parent_originated: None,
        evidence,
    };
    for family_id in &held.families {
        let Some((family, lane)) = lanes.get(family_id.as_str()) else { continue };
        let terminality = terminality_of(family, lane);
        if terminality == "terminal" || capability.terminality.is_none() {
            capability.terminality = Some(terminality);
        }
        let serving = held.roles.get(family_id);
        for flow in lane.iter() {
            capability.project = capability.project.take().or_else(|| flow.project.clone());
            capability.delivered.push(Delivery {
                flow: flow.id.clone(),
                role: serving
                    .and_then(|serving| crate::author::role_named(&serving.role))
                    .unwrap_or(match flow.standing {
                        "terminal" | "proximal" => "primary",
                        _ => "supporting",
                    }),
                rationale: match serving.map(|serving| serving.why.as_str()).filter(|why| !why.is_empty()) {
                    Some(why) => why.to_string(),
                    None => format!("{} belongs here by {}", flow.operation, family.basis),
                },
            });
            capability.surfaces.push(match flow.method.as_deref() {
                Some(method) => format!("{method} {}", flow.operation),
                None => flow.operation.clone(),
            });
            capability.records.extend(flow.writes.iter().cloned());
            capability.touches.extend(flow.writes.iter().cloned());
            capability.touches.extend(flow.reads.iter().cloned());
            capability.changes.extend(flow.changes.iter().cloned());
        }
    }
    if capability.delivered.is_empty() {
        return None;
    }
    capability.delivered.sort_by(|left, right| left.flow.cmp(&right.flow).then_with(|| role_rank(left.role).cmp(&role_rank(right.role))));
    capability.delivered.dedup_by(|left, right| left.flow == right.flow);
    capability.flows = capability.delivered.iter().map(|held| held.flow.clone()).collect();
    settle(&mut capability.surfaces);
    settle(&mut capability.records);
    settle(&mut capability.touches);
    settle(&mut capability.changes);
    Some(capability)
}

fn role_rank(role: &str) -> usize {
    crate::author::SERVING_ROLES.iter().position(|held| *held == role).unwrap_or(usize::MAX)
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct PartCoverage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub flows: u32,
    pub related: u32,
    pub unmapped: u32,
    pub set_aside: u32,
    pub inert: u32,
    pub flows_to_capabilities: f64,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct Coverage {
    pub flows: u32,
    pub related: u32,
    pub unmapped: u32,
    pub set_aside: u32,
    pub inert: u32,
    pub flows_to_capabilities: f64,
    pub parts: Vec<PartCoverage>,
    pub unmapped_flows: Vec<String>,
}

fn share_of(related: u32, flows: u32) -> f64 {
    match flows {
        0 => 0.0,
        flows => (f64::from(related) / f64::from(flows) * 1000.0).round() / 1000.0,
    }
}

pub(crate) fn delivers_nothing(flow: &Flow) -> bool {
    matches!(flow.kind, "event" | "schedule" | "background")
        && flow.writes.is_empty()
        && flow.reads.is_empty()
        && flow.reaches.is_empty()
        && flow.changes.is_empty()
        && flow.leads_into.is_empty()
        && flow.steps.iter().all(|step| step.kind == "respond" && step.object.is_none())
}

pub(crate) fn coverage_of(flows: &[Flow], capabilities: &[Capability]) -> Coverage {
    let related: BTreeSet<&str> =
        capabilities.iter().flat_map(|capability| capability.flows.iter().map(String::as_str)).collect();
    let mut parts: BTreeMap<Option<&str>, PartCoverage> = BTreeMap::new();
    let mut unmapped_flows: Vec<String> = Vec::new();
    let mut count = 0u32;
    let mut mapped = 0u32;
    let mut set_aside = 0u32;
    let mut inert = 0u32;
    for flow in flows {
        let part = parts
            .entry(flow.project.as_deref())
            .or_insert_with(|| PartCoverage { project: flow.project.clone(), ..PartCoverage::default() });
        if crate::unshipped::is_set_aside(flow.unshipped.as_ref()) {
            part.set_aside += 1;
            set_aside += 1;
            continue;
        }
        let held = related.contains(flow.id.as_str());
        if !held && delivers_nothing(flow) {
            part.inert += 1;
            inert += 1;
            continue;
        }
        part.flows += 1;
        count += 1;
        if held {
            part.related += 1;
            mapped += 1;
        } else {
            part.unmapped += 1;
            unmapped_flows.push(flow.id.clone());
        }
    }
    let mut parts: Vec<PartCoverage> = parts.into_values().collect();
    for part in parts.iter_mut() {
        part.flows_to_capabilities = share_of(part.related, part.flows);
    }
    unmapped_flows.sort();
    Coverage {
        flows: count,
        related: mapped,
        unmapped: count - mapped,
        set_aside,
        inert,
        flows_to_capabilities: share_of(mapped, count),
        parts,
        unmapped_flows,
    }
}

#[derive(Serialize, Deserialize)]
struct Whole {
    groups: Vec<WholeGroup>,
    seen: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
struct WholeGroup {
    name: String,
    description: String,
    audience: String,
    members: BTreeSet<String>,
}

fn standing_of(capability: &Capability) -> String {
    crate::jev::named(&format!(
        "{:?}\u{1}{}\u{1}{}\u{1}{}",
        capability.project,
        capability.name.as_deref().unwrap_or(""),
        capability.audience.as_deref().unwrap_or(""),
        capability.description.as_deref().unwrap_or("")
    ))
}

fn continued_together(
    groups: &mut Vec<crate::author::Same>,
    continues: &[BTreeSet<usize>],
    told: &BTreeMap<String, String>,
    spoken: &str,
) {
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    let mut pairs: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (first, onward) in continues.iter().enumerate() {
        for second in onward {
            let (Some(using), Some(reached)) = (told.get(&format!("c{first}")), told.get(&format!("c{second}"))) else {
                continue;
            };
            let key = format!("p{first}-{second}");
            questions.insert(
                key.clone(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: format!(
                        "FIRST:\n{using}\n\nSECOND:\n{reached}\n\nThe first continues into the second, so they serve one purpose reached from two parts of the system, and the product's description would list them as one thing rather than as two separate purposes"
                    ),
                    criteria: BTreeMap::new().into(),
                },
            );
            pairs.insert(key, (first, *second));
        }
    }
    if questions.is_empty() {
        return;
    }
    let answers = crate::jev::decide(&format!("A software system describes itself like this:\n{spoken}"), questions);
    let at_of = |groups: &Vec<crate::author::Same>, member: usize| {
        let id = format!("c{member}");
        groups.iter().position(|group| group.of.iter().any(|held| held.trim() == id))
    };
    let together: Vec<(usize, usize)> = pairs
        .into_iter()
        .filter(|(key, _)| answers.get(key).map(crate::jev::Decision::settled).is_some_and(|held| held >= 0.5))
        .map(|(_, pair)| pair)
        .collect();
    let mut reaching: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for (first, second) in &together {
        let landing = at_of(groups, *second).map(|at| format!("g{at}")).unwrap_or_else(|| format!("c{second}"));
        reaching.entry(*first).or_default().insert(landing);
    }
    for (first, second) in together {
        if reaching.get(&first).is_some_and(|landings| landings.len() > 1) {
            continue;
        }
        match (at_of(groups, first), at_of(groups, second)) {
            (Some(left), Some(right)) if left != right => {
                let moved = groups[right].of.clone();
                groups[left].of.extend(moved);
                groups.remove(right);
            }
            (Some(_), Some(_)) => {}
            (Some(left), None) => groups[left].of.push(format!("c{second}")),
            (None, Some(right)) => groups[right].of.push(format!("c{first}")),
            (None, None) => groups.push(crate::author::Same {
                of: vec![format!("c{first}"), format!("c{second}")],
                name: String::new(),
                description: String::new(),
                audience: String::new(),
            }),
        }
    }
}

fn asked_afresh(listed: BTreeMap<String, String>, spoken: &str) -> Vec<crate::author::Same> {
    let chunks: Vec<BTreeMap<String, String>> = listed
        .into_iter()
        .collect::<Vec<_>>()
        .chunks(CAPABILITIES_CONSOLIDATED_AT_ONCE)
        .map(|chunk| chunk.iter().cloned().collect())
        .collect();
    chunks.par_iter().flat_map(|chunk| crate::author::same_outcome(spoken, chunk)).collect()
}

fn grouped(
    parts: &[Capability],
    listed: BTreeMap<String, String>,
    spoken: &str,
    scope: &str,
) -> Vec<crate::author::Same> {
    let standing: Vec<String> = parts.iter().map(standing_of).collect();
    let at_of: BTreeMap<&str, usize> = standing.iter().enumerate().map(|(at, key)| (key.as_str(), at)).collect();
    let at_in = |id: &str| id.trim().strip_prefix('c')?.parse::<usize>().ok().filter(|at| *at < parts.len());
    let groups = match crate::memory::recalled::<Whole>("whole", scope) {
        None => asked_afresh(listed, spoken),
        Some(memory) => {
            let mut groups: Vec<crate::author::Same> = memory
                .groups
                .iter()
                .map(|group| crate::author::Same {
                    of: group
                        .members
                        .iter()
                        .filter_map(|key| at_of.get(key.as_str()))
                        .map(|at| format!("c{at}"))
                        .collect(),
                    name: group.name.clone(),
                    description: group.description.clone(),
                    audience: group.audience.clone(),
                })
                .filter(|group| !group.of.is_empty())
                .collect();
            let newcomers: BTreeSet<usize> =
                (0..parts.len()).filter(|at| !memory.seen.contains(&standing[*at])).collect();
            if !newcomers.is_empty() {
                let in_a_group: BTreeSet<usize> =
                    groups.iter().flat_map(|group| group.of.iter().filter_map(|id| at_in(id))).collect();
                let mut offered: BTreeMap<String, String> = groups
                    .iter()
                    .enumerate()
                    .map(|(at, group)| {
                        (
                            format!("g{at}"),
                            format!(
                                "  it is called: {}\n  for: {}\n  what someone gets: {}",
                                group.name, group.audience, group.description
                            ),
                        )
                    })
                    .collect();
                offered.extend(
                    listed.iter().filter(|(id, _)| at_in(id).is_some_and(|at| !in_a_group.contains(&at))).map(
                        |(id, told)| (id.clone(), told.clone()),
                    ),
                );
                for same in crate::author::same_outcome(spoken, &offered) {
                    let joining: Vec<String> = same
                        .of
                        .iter()
                        .filter(|id| at_in(id).is_some_and(|at| newcomers.contains(&at)))
                        .map(|id| id.trim().to_string())
                        .collect();
                    if joining.is_empty() {
                        continue;
                    }
                    let into = same
                        .of
                        .iter()
                        .find_map(|id| id.trim().strip_prefix('g')?.parse::<usize>().ok())
                        .filter(|at| *at < groups.len());
                    match into {
                        Some(at) => groups[at].of.extend(joining),
                        None => groups.push(crate::author::Same {
                            of: same
                                .of
                                .iter()
                                .filter(|id| at_in(id).is_some_and(|at| !in_a_group.contains(&at)))
                                .map(|id| id.trim().to_string())
                                .collect(),
                            ..same
                        }),
                    }
                }
            }
            groups
        }
    };
    if crate::author::asked() && !groups.is_empty() {
        crate::memory::keep(
            "whole",
            scope,
            &Whole {
                groups: groups
                    .iter()
                    .map(|group| WholeGroup {
                        name: group.name.clone(),
                        description: group.description.clone(),
                        audience: group.audience.clone(),
                        members: group
                            .of
                            .iter()
                            .filter_map(|id| at_in(id))
                            .map(|at| standing[at].clone())
                            .collect(),
                    })
                    .collect(),
                seen: standing.iter().cloned().collect(),
            },
        );
    }
    groups
}

pub(crate) fn of_the_whole(parts: &[Capability], spoken: &str, scope: &str, flows: &[Flow]) -> Vec<Capability> {
    let scope = &format!("{scope}\u{1}{}", crate::author::PURPOSE_CONTRACT_VERSION);
    let projects: BTreeSet<Option<&str>> = parts.iter().map(|capability| capability.project.as_deref()).collect();
    if parts.len() < 2 || projects.len() < 2 {
        return Vec::new();
    }
    let mut holding: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (at, capability) in parts.iter().enumerate() {
        for flow in &capability.flows {
            holding.entry(flow.as_str()).or_default().push(at);
        }
    }
    let flow_of: BTreeMap<&str, &Flow> = flows.iter().map(|flow| (flow.id.as_str(), flow)).collect();
    let continues: Vec<BTreeSet<usize>> = parts
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            capability
                .flows
                .iter()
                .filter_map(|flow| flow_of.get(flow.as_str()))
                .flat_map(|flow| flow.leads_into.iter())
                .flat_map(|entry| holding.get(format!("flow:{entry}").as_str()).cloned().unwrap_or_default())
                .filter(|other| *other != at && parts[*other].project != capability.project)
                .collect()
        })
        .collect();
    let listed: BTreeMap<String, String> = parts
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            let mut surfaces = capability.surfaces.clone();
            surfaces.truncate(SURFACES_SHOWN);
            (
                format!("c{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  what someone gets: {}\n  found in the part: {}\n  reached through: {}{}",
                    capability.name.as_deref().unwrap_or(""),
                    capability.audience.as_deref().unwrap_or("someone"),
                    capability.description.as_deref().unwrap_or(""),
                    capability.project.as_deref().unwrap_or("the repository root"),
                    surfaces.join(", "),
                    match continues[at].is_empty() {
                        true => String::new(),
                        false => format!(
                            "\n  its paths continue into: {}",
                            continues[at].iter().map(|other| format!("c{other}")).collect::<Vec<_>>().join(", ")
                        ),
                    }
                ),
            )
        })
        .collect();
    let told_of = listed.clone();
    let mut groups = grouped(parts, listed, spoken, scope);
    continued_together(&mut groups, &continues, &told_of, spoken);
    let mut taken = vec![false; parts.len()];
    let mut whole: Vec<Capability> = Vec::new();
    for group in groups {
        let mut from_parts: BTreeSet<Option<&str>> = BTreeSet::new();
        let members: Vec<usize> = group
            .of
            .iter()
            .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
            .filter(|at| *at < parts.len() && !taken[*at])
            .filter(|at| from_parts.insert(parts[*at].project.as_deref()))
            .collect();
        let Some(first) = members.first().copied() else { continue };
        let mut together = parts[first].clone();
        for at in &members {
            taken[*at] = true;
        }
        for at in members.iter().skip(1) {
            crate::comprehend::joined(&mut together, parts[*at].clone());
        }
        if !group.name.trim().is_empty() {
            together.id = format!("capability:{}", carved_name(&group.name));
            together.name = Some(group.name.trim().to_string());
        }
        if !group.description.trim().is_empty() {
            together.description = Some(group.description.trim().to_string());
        }
        if !group.audience.trim().is_empty() {
            together.audience = Some(group.audience.trim().to_ascii_lowercase());
        }
        whole.push(together);
    }
    for (at, capability) in parts.iter().enumerate() {
        if !taken[at] {
            whole.push(capability.clone());
        }
    }
    for capability in whole.iter_mut() {
        if let Some(part) = capability.project.take()
            && !capability.also_in.contains(&part)
        {
            capability.also_in.push(part);
        }
        capability.also_in.sort();
        capability.also_in.dedup();
    }
    let mut merged: Vec<Capability> = Vec::new();
    for capability in whole {
        match merged.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => crate::comprehend::joined(held, capability),
            None => merged.push(capability),
        }
    }
    merged.sort_by(|left, right| left.id.cmp(&right.id));
    merged
}

const LISTED_AT_ONCE: usize = 120;
const TOLD_IN_A_LINE: usize = 160;

fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies").filter(|stem| stem.len() > 1) {
        return format!("{stem}y");
    }
    if ["sses", "xes", "ches", "shes"].iter().any(|ending| word.ends_with(ending)) {
        return word[..word.len() - 2].to_string();
    }
    match word.strip_suffix('s') {
        Some(stem) if stem.len() > 2 && !stem.ends_with('s') && !stem.ends_with('u') && !stem.ends_with('i') => {
            stem.to_string()
        }
        _ => word.to_string(),
    }
}

pub(crate) fn name_key(name: &str) -> String {
    name.to_lowercase()
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty() && !matches!(*word, "a" | "an" | "the"))
        .map(singular)
        .collect::<Vec<_>>()
        .join(" ")
}

fn in_a_line(told: &str) -> String {
    let first = told.split_terminator(". ").next().unwrap_or(told).trim();
    match first.char_indices().nth(TOLD_IN_A_LINE) {
        Some((cut, _)) => first[..cut].to_string(),
        None => first.to_string(),
    }
}

fn asked_together(listed: &[usize]) -> Vec<Vec<usize>> {
    if listed.len() <= LISTED_AT_ONCE {
        return vec![listed.to_vec()];
    }
    let halves: Vec<&[usize]> = listed.chunks(LISTED_AT_ONCE / 2).collect();
    let mut asked: Vec<Vec<usize>> = Vec::new();
    for first in 0..halves.len() {
        for second in first + 1..halves.len() {
            asked.push(halves[first].iter().chain(halves[second].iter()).copied().collect());
        }
    }
    asked
}

pub(crate) struct Joined {
    pub(crate) members: Vec<usize>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) audience: String,
}

pub(crate) fn the_same_among(
    listed: &[(String, String)],
    ask: impl Fn(&BTreeMap<String, String>) -> Vec<crate::author::Same> + Sync,
) -> Vec<Joined> {
    let mut leader: Vec<usize> = (0..listed.len()).collect();
    fn found(leader: &mut [usize], at: usize) -> usize {
        let mut current = at;
        while leader[current] != current {
            leader[current] = leader[leader[current]];
            current = leader[current];
        }
        current
    }
    let join = |leader: &mut Vec<usize>, first: usize, second: usize| {
        let (left, right) = (found(leader, first), found(leader, second));
        if left != right {
            leader[left.max(right)] = left.min(right);
        }
    };
    let mut first_named: BTreeMap<String, usize> = BTreeMap::new();
    for (at, (name, _)) in listed.iter().enumerate() {
        let key = name_key(name);
        if key.is_empty() {
            continue;
        }
        match first_named.get(&key).copied() {
            Some(earlier) => join(&mut leader, earlier, at),
            None => {
                first_named.insert(key, at);
            }
        }
    }
    let shown: Vec<usize> = (0..listed.len()).filter(|at| found(&mut leader, *at) == *at).collect();
    let answers: Vec<(Vec<usize>, Vec<crate::author::Same>)> = asked_together(&shown)
        .into_par_iter()
        .filter(|chunk| chunk.len() > 1)
        .map(|chunk| {
            let offered: BTreeMap<String, String> = chunk
                .iter()
                .map(|at| (format!("c{at}"), format!("{} | {}", listed[*at].0.trim(), in_a_line(&listed[*at].1))))
                .collect();
            let said = ask(&offered);
            (chunk, said)
        })
        .collect();
    let mut named: Vec<(Vec<usize>, String, String, String)> = Vec::new();
    for (chunk, said) in answers {
        for same in said {
            let members: Vec<usize> = same
                .of
                .iter()
                .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
                .filter(|at| chunk.contains(at))
                .collect::<BTreeSet<usize>>()
                .into_iter()
                .collect();
            if members.len() < 2 {
                continue;
            }
            for at in &members[1..] {
                join(&mut leader, members[0], *at);
            }
            named.push((members, same.name.trim().to_string(), same.description.trim().to_string(), same.audience.trim().to_string()));
        }
    }
    let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for at in 0..listed.len() {
        let root = found(&mut leader, at);
        components.entry(root).or_default().push(at);
    }
    components
        .into_values()
        .filter(|members| members.len() > 1)
        .map(|members| {
            let chosen = named
                .iter()
                .filter(|(held, name, _, _)| !name.is_empty() && held.iter().all(|at| members.contains(at)))
                .max_by_key(|(held, _, _, _)| held.len());
            match chosen {
                Some((_, name, description, audience)) => Joined {
                    members,
                    name: name.clone(),
                    description: description.clone(),
                    audience: audience.clone(),
                },
                None => Joined { members, name: String::new(), description: String::new(), audience: String::new() },
            }
        })
        .collect()
}

pub(crate) fn one_of_each(capabilities: &mut Vec<Capability>, said: &str) {
    if capabilities.len() < 2 {
        return;
    }
    let listed: Vec<(String, String)> = capabilities
        .iter()
        .map(|capability| {
            (capability.name.clone().unwrap_or_default(), capability.description.clone().unwrap_or_default())
        })
        .collect();
    let groups = the_same_among(&listed, |offered| crate::author::same_capability(said, offered));
    if groups.is_empty() {
        return;
    }
    let mut slots: Vec<Option<Capability>> = std::mem::take(capabilities).into_iter().map(Some).collect();
    let mut kept: Vec<Capability> = Vec::new();
    for group in groups {
        let keeper = group
            .members
            .iter()
            .copied()
            .max_by_key(|at| (slots[*at].as_ref().map_or(0, |held| held.flows.len()), std::cmp::Reverse(*at)))
            .unwrap_or(group.members[0]);
        let Some(mut together) = slots[keeper].take() else { continue };
        let mut merged_names: Vec<String> = vec![together.name.clone().unwrap_or_default()];
        for at in &group.members {
            if let Some(other) = slots[*at].take() {
                merged_names.push(other.name.clone().unwrap_or_default());
                crate::comprehend::joined(&mut together, other);
            }
        }
        if !group.name.is_empty() {
            together.id = format!("capability:{}", carved_name(&group.name));
            together.name = Some(group.name.clone());
        }
        if !group.description.is_empty() {
            together.description = Some(group.description.clone());
        }
        if !group.audience.is_empty() {
            together.audience = Some(group.audience.to_ascii_lowercase());
        }
        eprintln!(
            "  one of each: {} <- {}",
            together.name.as_deref().unwrap_or(""),
            merged_names.join(" | ")
        );
        kept.push(together);
    }
    kept.extend(slots.into_iter().flatten());
    let mut unique: Vec<Capability> = Vec::new();
    for capability in kept {
        match unique.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => crate::comprehend::joined(held, capability),
            None => unique.push(capability),
        }
    }
    unique.sort_by(|left, right| left.id.cmp(&right.id));
    *capabilities = unique;
}

#[cfg(test)]
mod command_family_tests {
    use super::*;

    fn flow(id: &str, kind: &'static str, method: Option<&str>, operation: &str, writes: &[&str], reads: &[&str]) -> Flow {
        Flow {
            summary: String::new(),
            writes: writes.iter().map(|held| held.to_string()).collect(),
            reads: reads.iter().map(|held| held.to_string()).collect(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind,
            method: method.map(str::to_string),
            operation: operation.to_string(),
            surface: None,
            plays: None,
            standing: "terminal",
            confidence: 1.0,
            unsettled: None,
            open: 0,
            cut: false,
            name: None,
            description: None,
            grounding: None,
            path: Vec::new(),
            steps: Vec::new(),
            step_edges: Vec::new(),
            units: 1,
            rank: 0,
            stages: Vec::new(),
            changes: Vec::new(),
            leads_into: Vec::new(),
            project: None,
            unshipped: None,
        }
    }

    #[test]
    fn two_ipc_commands_ending_in_a_file_write_stay_two_families() {
        let run = flow("flow:1", "ipc", None, "chat:run", &["file"], &[]);
        let rename = flow("flow:2", "ipc", None, "archive:rename", &["file"], &[]);
        let flows = vec![&run, &rename];
        let grouped = outcomes_of(&flows);
        let keys: BTreeSet<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, BTreeSet::from(["asks:chat:run", "asks:archive:rename"]));
        assert_eq!(grouped.len(), 2, "each named command must be its own family: {keys:?}");
    }

    #[test]
    fn a_cli_and_a_tool_command_are_also_named_by_themselves() {
        let cli = flow("flow:3", "cli", None, "deploy", &["release"], &[]);
        let tool = flow("flow:4", "tool", None, "find_tests", &["release"], &[]);
        let flows = vec![&cli, &tool];
        let grouped = outcomes_of(&flows);
        let keys: BTreeSet<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, BTreeSet::from(["asks:deploy", "asks:find_tests"]));
    }

    fn starting_in(mut flow: Flow, unit: &str) -> Flow {
        flow.path = vec![crate::comprehend::Step { unit: unit.to_string(), depth: 0, leaves: Vec::new() }];
        flow
    }

    #[test]
    fn flows_that_only_trigger_are_grouped_by_the_module_they_work_in() {
        let accept = starting_in(flow("flow:6", "event", None, "click", &[], &[]), "site/consent.js:callback:accept");
        let reject = starting_in(flow("flow:7", "event", None, "click", &[], &[]), "site/consent.js:callback:reject");
        let menu = starting_in(flow("flow:8", "event", None, "click", &[], &[]), "site/menu.js:callback:toggle");
        let flows = vec![&accept, &reject, &menu];
        let grouped = outcomes_of(&flows);
        let keys: BTreeSet<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, BTreeSet::from(["within:site/consent.js", "within:site/menu.js"]));
    }

    #[test]
    fn a_trigger_beside_a_real_outcome_is_left_out() {
        let order = flow("flow:9", "http", Some("POST"), "/orders", &["orders"], &[]);
        let signal = flow("flow:10", "event", None, "SIGTERM", &[], &[]);
        let flows = vec![&order, &signal];
        let grouped = outcomes_of(&flows);
        assert_eq!(grouped.len(), 1);
    }

    #[test]
    fn a_flow_with_no_steps_is_told_by_the_units_it_runs_through() {
        let started = starting_in(flow("flow:11", "event", None, "click", &[], &[]), "site/main.js:callback:menuButton.addEventListener");
        assert_eq!(told_steps(&started), "no steps read; it runs through menuButton.addEventListener");
    }

    #[test]
    fn an_http_route_family_is_unchanged() {
        let route = flow("flow:5", "http", Some("GET"), "/orders", &[], &["orders"]);
        let flows = vec![&route];
        let grouped = outcomes_of(&flows);
        let keys: Vec<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, vec!["shows:orders"], "an http framework route must not be keyed by name");
    }

    #[test]
    fn a_named_command_is_terminal() {
        let family = Family { key: "asks:chat:run".to_string(), basis: "the command someone explicitly asked it to run" };
        let acts = flow("flow:1", "ipc", None, "chat:run", &["chat"], &[]);
        assert_eq!(terminality_of(&family, &[&acts]), "terminal");
    }

    fn logical_step(kind: &'static str, object: Option<&str>) -> crate::steps::LogicalStep {
        crate::steps::LogicalStep {
            id: "s1".to_string(),
            kind,
            label: kind.to_string(),
            object: object.map(str::to_string),
            doing: None,
            when: "always",
            regions: Vec::new(),
            description: None,
        }
    }

    #[test]
    fn a_bare_signal_relay_command_is_not_forced_terminal() {
        let family = Family { key: "asks:window:closeShortcut".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut relay = flow("flow:1", "ipc", None, "window:closeShortcut", &[], &[]);
        relay.steps.push(logical_step("raise", Some("close_event")));
        assert_eq!(terminality_of(&family, &[&relay]), "proximal");
    }

    #[test]
    fn a_named_command_whose_steps_were_never_read_stays_terminal() {
        let family = Family { key: "asks:replace".to_string(), basis: "the command someone explicitly asked it to run" };
        let unread = flow("flow:1", "ipc", None, "replace", &[], &[]);
        assert_eq!(terminality_of(&family, &[&unread]), "terminal");
        assert!(!evidence_of(&[&unread], &family, &Fields::new()).contains(ONLY_PASSES_A_SIGNAL));
    }

    #[test]
    fn a_relay_command_carries_the_signal_note_in_its_evidence() {
        let family = Family { key: "asks:relay:forward".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut relay = flow("flow:1", "ipc", None, "relay:forward", &[], &[]);
        relay.steps.push(logical_step("hand_off", Some("channel")));
        let told = evidence_of(&[&relay], &family, &Fields::new());
        assert!(told.contains("outcome (proximal)") && told.contains(ONLY_PASSES_A_SIGNAL), "{told}");
    }

    #[test]
    fn a_named_command_that_reads_what_it_shows_stays_terminal() {
        let family = Family { key: "asks:usage:get".to_string(), basis: "the command someone explicitly asked it to run" };
        let shows = flow("flow:1", "ipc", None, "usage:get", &[], &["usage"]);
        assert_eq!(terminality_of(&family, &[&shows]), "terminal");
        assert!(!evidence_of(&[&shows], &family, &Fields::new()).contains(ONLY_PASSES_A_SIGNAL));
    }

    #[test]
    fn a_route_family_never_carries_the_signal_note() {
        let family = Family { key: "hands on:close_event".to_string(), basis: "what it hands on to another part" };
        let mut raised = flow("flow:1", "event", None, "close", &[], &[]);
        raised.steps.push(logical_step("raise", Some("close_event")));
        assert_eq!(terminality_of(&family, &[&raised]), "terminal");
        assert!(!evidence_of(&[&raised], &family, &Fields::new()).contains(ONLY_PASSES_A_SIGNAL));
    }

    #[test]
    fn a_named_command_that_writes_a_record_stays_terminal() {
        let family = Family { key: "asks:archive:rename".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut renamed = flow("flow:1", "ipc", None, "archive:rename", &["file"], &[]);
        renamed.steps.push(logical_step("change", Some("file")));
        assert_eq!(terminality_of(&family, &[&renamed]), "terminal");
    }

    #[test]
    fn a_named_command_with_hand_written_logic_beyond_a_relay_stays_terminal() {
        let family = Family { key: "asks:text:replace".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut replaces = flow("flow:1", "ipc", None, "text:replace", &[], &[]);
        replaces.steps.push(logical_step("do", None));
        assert_eq!(terminality_of(&family, &[&replaces]), "terminal");
    }

    fn held_of(name: &str, families: &[&str]) -> Held {
        Held {
            name: name.to_string(),
            description: String::new(),
            audience: String::new(),
            families: families.iter().map(|id| id.to_string()).collect(),
            roles: BTreeMap::new(),
        }
    }

    #[test]
    fn a_proposal_names_a_role_per_family_and_leaves_some_unassigned() {
        let said = serde_json::json!({
            "capabilities": [
                {"name": "Trade assets", "description": "d", "audience": "traders", "serves": [
                    {"id": "f0", "role": "primary", "why": "places the trade"},
                    {"id": "f1", "role": "Prerequisite", "why": "signs in first"},
                    {"id": "f2", "role": "nonsense", "why": "x"},
                    "f3"
                ]},
                {"name": "", "serves": [{"id": "f9", "role": "primary"}]},
                {"name": "Empty", "serves": []}
            ],
            "unassigned": ["f4"],
            "plumbing": ["f5"]
        });
        let proposal = crate::author::proposal_of(&said, 6);
        assert_eq!(proposal.capabilities.len(), 1);
        let trade = &proposal.capabilities[0];
        assert_eq!(trade.families, vec!["f0", "f1", "f2", "f3"]);
        assert_eq!(trade.roles["f0"].role, "primary");
        assert_eq!(trade.roles["f0"].why, "places the trade");
        assert_eq!(trade.roles["f1"].role, "prerequisite");
        assert!(!trade.roles.contains_key("f2"), "an unknown role is not kept");
        assert!(!trade.roles.contains_key("f3"));
        assert_eq!(proposal.unassigned, vec!["f4", "f5"]);
    }

    #[test]
    fn a_proposal_that_names_only_unassigned_outcomes_is_still_an_answer() {
        let said = serde_json::json!({"capabilities": [], "unassigned": ["f0", "f1"]});
        assert_eq!(crate::author::proposal_of(&said, 2).unassigned.len(), 2);
        assert!(crate::author::proposal_of(&said, 3).unassigned.is_empty(), "a partial answer with nothing named is no answer");
    }

    #[test]
    fn the_legacy_families_list_of_ids_still_parses() {
        let said = serde_json::json!({"capabilities": [{"name": "Browse the catalog", "families": ["f0", "f1"]}], "plumbing": []});
        let proposal = crate::author::proposal_of(&said, 2);
        assert_eq!(proposal.capabilities[0].families, vec!["f0", "f1"]);
        assert!(proposal.capabilities[0].roles.is_empty());
    }

    #[test]
    fn gathering_groups_many_families_under_one_purpose_and_keeps_unassigned_ones_out() {
        let known: BTreeSet<String> = ["f0", "f1", "f2", "f3"].iter().map(|id| id.to_string()).collect();
        let one = crate::author::proposal_of(
            &serde_json::json!({"capabilities": [{"name": "Manage photo albums", "serves": [
                {"id": "f0", "role": "primary"}, {"id": "f9", "role": "primary"}]}], "unassigned": ["f3", "f8"]}),
            4,
        );
        let two = crate::author::proposal_of(
            &serde_json::json!({"capabilities": [{"name": "manage photo album", "serves": [
                {"id": "f1", "role": "supporting", "why": "lists them"}, {"id": "f2", "role": "recovery"}]}]}),
            4,
        );
        let mut held: Vec<Held> = Vec::new();
        let mut unassigned: BTreeSet<String> = BTreeSet::new();
        gather(vec![one, two], &mut held, &mut unassigned, &known);
        assert_eq!(held.len(), 1, "the same purpose named twice is one capability");
        assert_eq!(held[0].families, BTreeSet::from(["f0".to_string(), "f1".to_string(), "f2".to_string()]));
        assert_eq!(held[0].roles["f1"].role, "supporting");
        assert_eq!(held[0].roles["f2"].role, "recovery");
        assert_eq!(unassigned, BTreeSet::from(["f3".to_string()]));
    }

    #[test]
    fn a_family_no_answer_covered_becomes_a_capability_named_for_what_it_handles() {
        let key_of = BTreeMap::from([("f3", "records:Order,Item")]);
        let held = structural("f3", &key_of);
        assert_eq!(held.name, "Order,Item");
        assert_eq!(held.families, BTreeSet::from(["f3".to_string()]));
        assert!(held.description.is_empty());
    }

    #[test]
    fn capabilities_with_the_same_name_merge_at_any_level_without_asking() {
        let mut held = vec![
            held_of("Configure engine environment", &["f0"]),
            held_of("Delete a post", &["f1"]),
            held_of("  configure   Engine environments ", &["f2"]),
        ];
        merge_same_named(&mut held);
        assert_eq!(held.len(), 2);
        assert_eq!(held[0].families, BTreeSet::from(["f0".to_string(), "f2".to_string()]));
    }

    #[test]
    fn a_family_serving_two_purposes_delivers_its_flows_to_both_with_a_role_each() {
        let sign_in = flow("flow:1", "http", Some("POST"), "/session", &["session"], &[]);
        let place = flow("flow:2", "http", Some("POST"), "/orders", &["orders"], &[]);
        let sign_in_family = Family { key: "changes:session".to_string(), basis: "the record it changes" };
        let place_family = Family { key: "changes:orders".to_string(), basis: "the record it changes" };
        let (a, b) = (vec![&sign_in], vec![&place]);
        let lanes: BTreeMap<&str, (&Family, &Vec<&Flow>)> =
            BTreeMap::from([("f0", (&sign_in_family, &a)), ("f1", (&place_family, &b))]);
        let mut trade = held_of("Place orders", &["f0", "f1"]);
        trade.roles.insert("f0".to_string(), Serving { role: "prerequisite".to_string(), why: "signs in first".to_string() });
        trade.roles.insert("f1".to_string(), Serving { role: "primary".to_string(), why: String::new() });
        let mut account = held_of("Manage an account", &["f0"]);
        account.roles.insert("f0".to_string(), Serving { role: "primary".to_string(), why: String::new() });
        let placed = built(trade, &lanes, &Fields::new()).expect("built");
        let managed = built(account, &lanes, &Fields::new()).expect("built");
        let role_of = |capability: &Capability, flow: &str| capability.delivered.iter().find(|held| held.flow == flow).map(|held| held.role);
        assert_eq!(role_of(&placed, "flow:1"), Some("prerequisite"));
        assert_eq!(role_of(&placed, "flow:2"), Some("primary"));
        assert_eq!(role_of(&managed, "flow:1"), Some("primary"));
        assert_eq!(placed.flows, vec!["flow:1", "flow:2"]);
        assert!(placed.evidence.contains("it is served by 2 outcomes"), "{}", placed.evidence);
        assert!(placed.evidence.contains("- prerequisite: session"), "{}", placed.evidence);
        assert_eq!(placed.delivered.iter().find(|held| held.flow == "flow:1").map(|held| held.rationale.as_str()), Some("signs in first"));
    }

    #[test]
    fn a_small_part_with_one_program_that_runs_through_many_modules_is_read_stage_by_stage() {
        let mut program = flow("flow:main", "lifecycle", None, "main", &[], &[]);
        program.stages = (0..7)
            .map(|at| crate::comprehend::Stage {
                module: format!("src/stage{at}.rs"),
                units: 9,
                names: vec![format!("run{at}")],
                leaves: Vec::new(),
            })
            .collect();
        let families = outcomes_of(&[&program]);
        assert_eq!(families.len(), 7);
        assert!(families.keys().all(|family| family.key.starts_with("stage:src/stage")));
        let first = families.iter().next().expect("a stage");
        assert_eq!(terminality_of(first.0, first.1), "terminal");
        assert!(evidence_of(first.1, first.0, &Fields::new()).contains("run0"));
    }

    #[test]
    fn product_surfaces_rank_before_programs_and_what_programs_alone_run() {
        let mut route = flow("flow:route", "http", Some("POST"), "/v1/analyze", &[], &[]);
        route.units = 10;
        let mut program = flow("flow:main", "lifecycle", None, "main", &[], &[]);
        program.units = 500;
        let mut benchmark = flow("flow:bench", "tool", None, "run_benchmark", &[], &[]);
        benchmark.units = 900;
        benchmark.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "reaches-only-program-code", evidence: String::new() });
        let mut orient = flow("flow:orient", "tool", None, "get_start_context", &[], &[]);
        orient.units = 50;
        let mut obscure = flow("flow:obscure", "tool", None, "do_something_rare", &[], &[]);
        obscure.units = 400;
        let pointed_to: rustc_hash::FxHashMap<String, usize> = [("flow:orient".to_string(), 5)].into_iter().collect();
        let mut flows = vec![benchmark, program, route, obscure, orient];
        crate::comprehend::rank_flows(&mut flows, &pointed_to);
        let rank_of = |id: &str| flows.iter().find(|held| held.id == id).map(|held| held.rank);
        assert_eq!(
            (rank_of("flow:route"), rank_of("flow:orient"), rank_of("flow:obscure"), rank_of("flow:main"), rank_of("flow:bench")),
            (Some(2), Some(1), Some(3), Some(4), Some(5))
        );
    }

    #[test]
    fn coverage_leaves_out_flows_set_aside_and_runtime_hooks_that_deliver_nothing() {
        let served = flow("flow:1", "http", Some("GET"), "/a", &[], &[]);
        let hook = flow("flow:2", "event", None, "SIGTERM", &[], &[]);
        let mut tooling = flow("flow:3", "lifecycle", None, "main", &[], &[]);
        tooling.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "shipping-evidence", evidence: String::new() });
        let mut reading = flow("flow:4", "event", None, "data", &[], &["orders"]);
        reading.project = None;
        let covered = coverage_of(&[served, hook, tooling, reading], &[]);
        assert_eq!((covered.flows, covered.set_aside, covered.inert), (2, 1, 1));
        assert_eq!(covered.unmapped_flows, vec!["flow:1", "flow:4"]);
    }

    #[test]
    fn flows_that_no_capability_serves_are_counted_and_listed_as_unmapped() {
        let mut first = flow("flow:1", "http", Some("GET"), "/a", &[], &[]);
        first.project = Some("subproject:web".to_string());
        let mut second = flow("flow:2", "http", Some("GET"), "/b", &[], &[]);
        second.project = Some("subproject:web".to_string());
        let third = flow("flow:3", "cli", None, "tool", &[], &[]);
        let capability = Capability {
            id: "capability:x".to_string(),
            audience: None,
            delivered: Vec::new(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: vec!["flow:1".to_string(), "flow:3".to_string()],
            surfaces: Vec::new(),
            project: None,
            also_in: Vec::new(),
            place: None,
            name: Some("X".to_string()),
            description: None,
            grounding: None,
            standing: PUBLISHED,
            touches: Vec::new(),
            terminality: None,
            confidence: None,
            unsettled: None,
            composition_provenance: Vec::new(),
            parent_originated: None,
            evidence: String::new(),
        };
        let covered = coverage_of(&[first, second, third], &[capability]);
        assert_eq!((covered.flows, covered.related, covered.unmapped), (3, 2, 1));
        assert_eq!(covered.flows_to_capabilities, 0.667);
        assert_eq!(covered.unmapped_flows, vec!["flow:2"]);
        let web = covered.parts.iter().find(|part| part.project.as_deref() == Some("subproject:web")).expect("web part");
        assert_eq!((web.flows, web.related, web.unmapped), (2, 1, 1));
        let root = covered.parts.iter().find(|part| part.project.is_none()).expect("root part");
        assert_eq!(root.flows_to_capabilities, 1.0);
    }

    #[test]
    fn a_flow_tagged_as_unshipped_by_evidence_is_never_proposed() {
        let mut tooling = flow("flow:1", "cli", None, "build", &[], &[]);
        assert!(is_proposable(&tooling));
        for basis in ["shipping-evidence", "island"] {
            tooling.unshipped = Some(crate::entry_exit::Unshipped { role: "tooling", basis, evidence: String::new() });
            assert!(!is_proposable(&tooling), "{basis}");
        }
    }

    #[test]
    fn a_flow_tagged_as_unshipped_only_by_its_name_is_still_proposed() {
        let mut named = flow("flow:1", "cli", None, "build", &[], &[]);
        named.unshipped = Some(crate::entry_exit::Unshipped { role: "tooling", basis: "name", evidence: String::new() });
        assert!(is_proposable(&named));
    }
}

#[cfg(test)]
mod one_of_each_tests {
    use super::*;

    fn listed(names: &[String]) -> Vec<(String, String)> {
        names.iter().map(|name| (name.clone(), format!("Someone gets {name}."))).collect()
    }

    fn synonyms_asked(offered: &BTreeMap<String, String>) -> Vec<crate::author::Same> {
        let links = offered.iter().find(|(_, told)| told.starts_with("Open external links |"));
        let urls = offered.iter().find(|(_, told)| told.starts_with("Open external URLs |"));
        match (links, urls) {
            (Some((first, _)), Some((second, _))) => vec![crate::author::Same {
                of: vec![first.clone(), second.clone()],
                name: "Open external links".to_string(),
                description: "Opens links outside the app.".to_string(),
                audience: "user".to_string(),
            }],
            _ => Vec::new(),
        }
    }

    #[test]
    fn a_name_key_ignores_case_punctuation_articles_and_plurals() {
        assert_eq!(name_key("Open External Links."), name_key("open an external link"));
        assert_eq!(name_key("Manage Categories"), name_key("manage category"));
        assert_eq!(name_key("Track the process"), name_key("track processes"));
        assert_ne!(name_key("Sign in"), name_key("Sign out"));
    }

    #[test]
    fn the_same_normalized_name_is_merged_without_asking() {
        let names = vec!["Configure engine environment".to_string(), "Delete a post".to_string(), "configure Engine environments!".to_string()];
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let groups = the_same_among(&listed(&names), |offered| {
            asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            assert_eq!(offered.len(), 2, "a name already merged is listed once: {offered:?}");
            Vec::new()
        });
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![0, 2]);
    }

    #[test]
    fn a_synonym_pair_planted_in_different_chunks_comes_out_as_one() {
        let mut names: Vec<String> = (0..300).map(|at| format!("Distinct capability {at}")).collect();
        names[5] = "Open external links".to_string();
        names[280] = "Open external URLs".to_string();
        let items = listed(&names);
        assert!(asked_together(&(0..300).collect::<Vec<_>>()).iter().all(|chunk| chunk.len() <= LISTED_AT_ONCE));
        let groups = the_same_among(&items, synonyms_asked);
        assert_eq!(groups.len(), 1, "exactly the planted pair merges");
        assert_eq!(groups[0].members, vec![5, 280]);
        assert_eq!(groups[0].name, "Open external links");
    }

    #[test]
    fn every_pair_is_asked_together_at_least_once() {
        let shown: Vec<usize> = (0..400).collect();
        let chunks = asked_together(&shown);
        for first in (0..400).step_by(37) {
            for second in (0..400).step_by(41) {
                assert!(chunks.iter().any(|chunk| chunk.contains(&first) && chunk.contains(&second)), "{first} and {second}");
            }
        }
    }

    #[test]
    fn names_that_are_not_the_same_stay_apart_when_nothing_is_said_the_same() {
        let names = vec!["Sign in".to_string(), "Sign out".to_string(), "Delete a post".to_string()];
        assert!(the_same_among(&listed(&names), |_| Vec::new()).is_empty());
    }
}

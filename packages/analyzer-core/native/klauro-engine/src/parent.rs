use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::comprehend::{Capability, Flow};
use crate::composition::{Composition, Seam};

pub const PARENT_CONTRACT_VERSION: &str = "parent-1";
pub const LOW_WEIGHT: f64 = 0.25;
const INPUT_LIMIT: usize = 48_000;
const LINKS_SHOWN: usize = 24;
const LINK_EVIDENCE_SHOWN: usize = 2;
const DESCRIPTION_SHOWN: usize = 200;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Source {
    pub source_child: String,
    pub source_capability_id: String,
    pub disposition: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Originated {
    pub kind: &'static str,
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Promoted {
    pub capability: String,
    pub name: String,
    pub from: Vec<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_originated: Option<Originated>,
}

#[derive(Debug, Serialize, Clone)]
pub struct NotPromoted {
    pub child: String,
    pub capability: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct Summary {
    pub promoted: Vec<Promoted>,
    pub not_promoted: Vec<NotPromoted>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum Citing {
    Plain(String),
    Full {
        #[serde(default)]
        id: String,
        #[serde(default, rename = "as")]
        disposition: String,
    },
}

impl Citing {
    fn id(&self) -> &str {
        match self {
            Citing::Plain(id) => id.trim(),
            Citing::Full { id, .. } => id.trim(),
        }
    }

    fn disposition(&self) -> &'static str {
        match self {
            Citing::Full { disposition, .. } if disposition.trim().eq_ignore_ascii_case("absorbed") => "absorbed",
            _ => "promoted",
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct Derived {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub audience: String,
    #[serde(default)]
    pub from: Vec<Citing>,
    #[serde(default)]
    pub link: Vec<String>,
    #[serde(default)]
    pub stated: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct Left {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub why: String,
}

#[derive(Debug, Default, Clone)]
pub struct Answer {
    pub derived: Vec<Derived>,
    pub left: Vec<Left>,
}

pub fn answer_from(value: &serde_json::Value) -> Answer {
    let list = |key: &str| value.get(key).and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    Answer {
        derived: list("derived").into_iter().filter_map(|held| serde_json::from_value(held).ok()).collect(),
        left: list("left").into_iter().filter_map(|held| serde_json::from_value(held).ok()).collect(),
    }
}

pub struct Derivation {
    pub capabilities: Vec<Capability>,
    pub reasons: BTreeMap<(String, String), String>,
}

fn handle_of(id: &str, prefix: char, within: usize) -> Option<usize> {
    id.trim().strip_prefix(prefix)?.parse::<usize>().ok().filter(|at| *at < within)
}

fn key_of(capability: &Capability) -> (String, String) {
    (capability.project.clone().unwrap_or_default(), capability.id.clone())
}

fn bare(project: &str) -> &str {
    project.strip_prefix("subproject:").unwrap_or(project)
}

fn weight_of(composition: &Composition, project: &str) -> Option<f64> {
    composition.children.iter().find(|child| child.id == project).map(|child| child.weight)
}

fn is_residue(composition: &Composition, project: &str) -> bool {
    composition.orphan.as_ref().is_some_and(|orphan| orphan.project == project)
}

fn is_known(composition: &Composition, project: &str) -> bool {
    weight_of(composition, project).is_some() || is_residue(composition, project)
}

pub fn parts_within(composition: &Composition, served: &[Capability]) -> Vec<Capability> {
    served
        .iter()
        .filter(|capability| capability.project.as_deref().is_some_and(|project| is_known(composition, project)))
        .cloned()
        .collect()
}

pub fn spans_children(parts: &[Capability]) -> bool {
    parts.iter().filter_map(|capability| capability.project.as_deref()).collect::<BTreeSet<_>>().len() >= 2
}

fn said_of(seam: &Seam) -> String {
    format!(
        "{} to {} ({}, {}): {}",
        bare(&seam.from),
        bare(&seam.to),
        seam.kind,
        seam.communication,
        seam.evidence.iter().take(LINK_EVIDENCE_SHOWN).cloned().collect::<Vec<_>>().join("; ")
    )
}

pub fn links_of(composition: &Composition, parts: &[Capability]) -> Vec<(String, String)> {
    let present: BTreeSet<&str> = parts.iter().filter_map(|capability| capability.project.as_deref()).collect();
    let both = |from: &str, to: &str| present.contains(from) && present.contains(to);
    let mut found: Vec<(u32, String)> = composition
        .seams
        .iter()
        .filter(|seam| seam.origin == "product" && seam.from != seam.to && both(&seam.from, &seam.to))
        .map(|seam| (seam.count, said_of(seam)))
        .collect();
    found.extend(
        composition
            .dependencies
            .iter()
            .filter(|held| held.from != held.to && both(&held.from, &held.to))
            .map(|held| {
                (
                    held.count,
                    format!(
                        "{} imports from {} in {} places: {}",
                        bare(&held.from),
                        bare(&held.to),
                        held.count,
                        held.evidence.iter().take(LINK_EVIDENCE_SHOWN).cloned().collect::<Vec<_>>().join("; ")
                    ),
                )
            }),
    );
    found.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    found.truncate(LINKS_SHOWN);
    found.into_iter().enumerate().map(|(at, (_, told))| (format!("s{at}"), told)).collect()
}

fn roles_of(capability: &Capability) -> String {
    let mut counted: BTreeMap<&str, usize> = BTreeMap::new();
    for delivery in &capability.delivered {
        *counted.entry(delivery.role).or_default() += 1;
    }
    counted.into_iter().map(|(role, count)| format!("{role} {count}")).collect::<Vec<_>>().join(", ")
}

fn in_a_sentence(told: &str) -> String {
    let first = told.split_terminator(". ").next().unwrap_or(told).trim();
    match first.char_indices().nth(DESCRIPTION_SHOWN) {
        Some((cut, _)) => first[..cut].to_string(),
        None => first.to_string(),
    }
}

fn basis_of(composition: &Composition, project: &str, flows: usize) -> String {
    match composition.children.iter().find(|child| child.id == project) {
        Some(child) => {
            let basis = &child.weight_basis;
            format!(
                "{}, weight {:.2} (ship {:.2}, activity {:.2}{}{}), {} flows",
                child.status,
                child.weight,
                basis.ship,
                basis.activity,
                basis.days_since_change.map(|days| format!(", last changed {days} days ago")).unwrap_or_default(),
                match basis.consumed_by_shipped {
                    true => ", used by a shipped part",
                    false => "",
                },
                flows
            )
        }
        None => format!("the code that belongs to no part, {flows} flows"),
    }
}

pub fn packed(sizes: &[usize], limit: usize) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut from = 0;
    let mut used = 0;
    for (at, size) in sizes.iter().enumerate() {
        if used > 0 && used + size > limit {
            ranges.push(from..at);
            from = at;
            used = 0;
        }
        used += size;
    }
    if from < sizes.len() {
        ranges.push(from..sizes.len());
    }
    ranges
}

pub const RULES: &str = "Write the capabilities of the product as a whole, derived from the parts' capabilities listed below and from \
nothing else. Each part was already read on its own; nothing in the code is shown again here.\n\n\
- Every capability you write must come from the parts' capabilities: put the ids it derives from in \"from\", each with \"as\" set to \
\"promoted\" when a part delivers that purpose directly, or \"absorbed\" when a supporting part (a library, a shared service, or something \
another part consumes) only carries out part of the purpose that the part consuming it delivers, so it is folded into that purpose. \
An absorbed capability stays fully visible under its own part.\n\
- Never write a capability that no part's capability supports, and never invent what the product does.\n\
- Weight orders and selects what leads. A part with very low weight (not shipped, long untouched) must not lead the product's purposes: \
write no capability that only such a part delivers, unless the product's own words state that purpose and no other part covers it, and \
then set \"stated\" to true. Its capabilities stay visible under that part.\n\
- When several parts deliver one purpose, write it once and cite them all.\n\
- A purpose that exists only because parts work together, such as one calling or consuming another, may be written only when a connection \
listed below shows it: put that connection's id in \"link\" and cite the capabilities of the parts it joins. Otherwise leave \"link\" empty.\n\
- Capabilities of a part that serve no purpose of the product stay with their part: do not cite them, and list them in \"left\" with a \
short reason.";

const NAMING_THE_WHOLE: &str = "For each capability give a name of 2-6 words, a verb and what it is for, like \"Share posts with followers\", \
never a bare topic; one sentence saying what someone gets; and the audience it is for. Name what the person ends up with, never the way in \
and never what it is built on. Say only what the capabilities cited do. List them in the order of the weight of the parts they come from.\n\
Return JSON only: {\"derived\":[{\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\",\"from\":[{\"id\":\"...\",\"as\":\"promoted\"}],\
\"link\":[\"...\"],\"stated\":false}],\"left\":[{\"id\":\"...\",\"why\":\"...\"}]}";

pub fn prompts_of(
    spoken: &str,
    composition: &Composition,
    parts: &[Capability],
    flows: &[Flow],
    links: &[(String, String)],
) -> Vec<String> {
    let mut projects: Vec<&str> = parts.iter().filter_map(|capability| capability.project.as_deref()).collect();
    projects.sort_by(|left, right| {
        let heavy = |project: &str| weight_of(composition, project).unwrap_or(0.0);
        heavy(right).partial_cmp(&heavy(left)).unwrap_or(std::cmp::Ordering::Equal).then(left.cmp(right))
    });
    projects.dedup();
    let table: String = projects
        .iter()
        .map(|project| {
            let held = flows.iter().filter(|flow| flow.project.as_deref() == Some(*project)).count();
            format!("- {}: {}", bare(project), basis_of(composition, project, held))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let connections = match links.is_empty() {
        true => "  none found".to_string(),
        false => links.iter().map(|(id, told)| format!("- {id}: {told}")).collect::<Vec<_>>().join("\n"),
    };
    let blocks: Vec<(String, String)> = projects
        .iter()
        .flat_map(|project| {
            let lines: Vec<String> = parts
                .iter()
                .enumerate()
                .filter(|(_, capability)| capability.project.as_deref() == Some(*project))
                .map(|(at, capability)| {
                    format!(
                        "  k{at}: {} - {} ({} flows; {})",
                        capability.name.as_deref().unwrap_or(""),
                        in_a_sentence(capability.description.as_deref().unwrap_or("")),
                        capability.flows.len(),
                        roles_of(capability)
                    )
                })
                .collect();
            let sizes: Vec<usize> = lines.iter().map(|line| line.len() + 1).collect();
            packed(&sizes, INPUT_LIMIT / 2)
                .into_iter()
                .map(|range| (bare(project).to_string(), lines[range].join("\n")))
                .collect::<Vec<_>>()
        })
        .collect();
    let sizes: Vec<usize> = blocks.iter().map(|(name, lines)| name.len() + lines.len() + 8).collect();
    let fixed = spoken.len() + table.len() + connections.len() + RULES.len() + NAMING_THE_WHOLE.len();
    packed(&sizes, INPUT_LIMIT.saturating_sub(fixed).max(INPUT_LIMIT / 4))
        .into_iter()
        .map(|range| {
            let listed = blocks[range]
                .iter()
                .map(|(name, lines)| format!("PART {name}\n{lines}"))
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "A software product describes itself like this:\n{spoken}\n\n{}\n\n\
                 It is made of separate parts, and how much each one weighs in what the product is today:\n{table}\n\n\
                 How the parts connect:\n{connections}\n\n{}\n\n{RULES}\n\n{NAMING_THE_WHOLE}\n\n\
                 The capabilities of the parts:\n{listed}",
                crate::author::OWN_WORDS,
                crate::author::PURPOSE
            )
        })
        .collect()
}

fn one_of_each_name(built: &mut Vec<Capability>, capability: Capability) {
    let key = crate::capabilities::name_key(capability.name.as_deref().unwrap_or(""));
    let at = built.iter().position(|held| {
        held.id == capability.id || crate::capabilities::name_key(held.name.as_deref().unwrap_or("")) == key
    });
    match at {
        Some(at) => crate::comprehend::joined(&mut built[at], capability),
        None => built.push(capability),
    }
}

pub fn assemble(parts: &[Capability], composition: &Composition, links: &[(String, String)], answer: &Answer) -> Derivation {
    let low = |at: usize| {
        parts[at].project.as_deref().and_then(|project| weight_of(composition, project)).is_some_and(|weight| weight < LOW_WEIGHT)
    };
    let weight_at = |at: usize| parts[at].project.as_deref().and_then(|project| weight_of(composition, project));
    let evidence_of: BTreeMap<&str, &str> = links.iter().map(|(id, told)| (id.as_str(), told.as_str())).collect();
    let mut reasons: BTreeMap<(String, String), String> = BTreeMap::new();
    for left in &answer.left {
        if let Some(at) = handle_of(&left.id, 'k', parts.len()) {
            let why = left.why.trim();
            if !why.is_empty() {
                reasons.insert(key_of(&parts[at]), why.to_string());
            }
        }
    }
    let mut built: Vec<Capability> = Vec::new();
    for derived in &answer.derived {
        let name = derived.name.trim();
        if name.is_empty() {
            continue;
        }
        let mut cited: Vec<(usize, &'static str)> = Vec::new();
        for citing in &derived.from {
            let Some(at) = handle_of(citing.id(), 'k', parts.len()) else { continue };
            if cited.iter().all(|(held, _)| *held != at) {
                cited.push((at, citing.disposition()));
            }
        }
        if cited.is_empty() {
            eprintln!("  parent dropped '{name}': it cites no capability of any part");
            continue;
        }
        if cited.iter().all(|(at, _)| low(*at)) && !derived.stated {
            for (at, _) in &cited {
                reasons.entry(key_of(&parts[*at])).or_insert_with(|| {
                    "only a low-weight part delivers it and the product's own words do not state it".to_string()
                });
            }
            continue;
        }
        if cited.iter().any(|(at, _)| !low(*at)) {
            for (at, _) in cited.iter().filter(|(at, _)| low(*at)) {
                reasons.entry(key_of(&parts[*at])).or_insert_with(|| {
                    "a heavier part already delivers this purpose, so this low-weight part is not cited".to_string()
                });
            }
            cited.retain(|(at, _)| !low(*at));
        }
        cited.sort_by(|left, right| {
            let heavy = |at: usize| weight_at(at).unwrap_or(0.0);
            heavy(right.0).partial_cmp(&heavy(left.0)).unwrap_or(std::cmp::Ordering::Equal).then(left.0.cmp(&right.0))
        });
        let mut whole = parts[cited[0].0].clone();
        for (at, _) in cited.iter().skip(1) {
            crate::comprehend::joined(&mut whole, parts[*at].clone());
        }
        if let Some(part) = whole.project.take()
            && !whole.also_in.contains(&part)
        {
            whole.also_in.push(part);
        }
        whole.also_in.sort();
        whole.also_in.dedup();
        whole.id = format!("capability:{}", crate::comprehend::carved_name(name));
        whole.name = Some(name.to_string());
        whole.description = Some(derived.description.trim().to_string()).filter(|held| !held.is_empty()).or(whole.description);
        whole.audience = Some(derived.audience.trim().to_ascii_lowercase()).filter(|held| !held.is_empty()).or(whole.audience);
        whole.grounding = None;
        whole.confidence = None;
        whole.unsettled = None;
        whole.composition_provenance = cited
            .iter()
            .map(|(at, disposition)| Source {
                source_child: parts[*at].project.clone().unwrap_or_default(),
                source_capability_id: parts[*at].id.clone(),
                disposition,
                weight: weight_at(*at),
            })
            .collect();
        let children: BTreeSet<&str> = cited
            .iter()
            .filter_map(|(at, _)| parts[*at].project.as_deref())
            .filter(|project| !is_residue(composition, project))
            .collect();
        let connected: Vec<String> = derived
            .link
            .iter()
            .filter_map(|id| evidence_of.get(id.trim()).map(|told| told.to_string()))
            .collect();
        let orphaned: Vec<String> = cited
            .iter()
            .filter(|(at, _)| parts[*at].project.as_deref().is_some_and(|project| is_residue(composition, project)))
            .map(|(at, _)| format!("{}: {}", bare(parts[*at].project.as_deref().unwrap_or("")), parts[*at].id))
            .collect();
        whole.parent_originated = match (children.len() >= 2 && !connected.is_empty(), orphaned.is_empty()) {
            (true, _) => Some(Originated { kind: "seam", evidence: connected }),
            (false, false) => Some(Originated { kind: "orphan", evidence: orphaned }),
            (false, true) => None,
        };
        one_of_each_name(&mut built, whole);
    }
    built.sort_by(|left, right| left.id.cmp(&right.id));
    Derivation { capabilities: built, reasons }
}

pub fn carried(parts: &[Capability]) -> Answer {
    Answer {
        derived: parts
            .iter()
            .enumerate()
            .map(|(at, capability)| Derived {
                name: capability.name.clone().unwrap_or_default(),
                description: capability.description.clone().unwrap_or_default(),
                audience: capability.audience.clone().unwrap_or_default(),
                from: vec![Citing::Full { id: format!("k{at}"), disposition: "promoted".to_string() }],
                link: Vec::new(),
                stated: false,
            })
            .collect(),
        left: Vec::new(),
    }
}

pub fn derive(
    composition: &Composition,
    served: &[Capability],
    flows: &[Flow],
    spoken: &str,
    scope: &str,
) -> Option<(Vec<Capability>, Derivation)> {
    let parts = parts_within(composition, served);
    if !spans_children(&parts) {
        return None;
    }
    let links = links_of(composition, &parts);
    let mut answer = Answer::default();
    for (at, prompt) in prompts_of(spoken, composition, &parts, flows, &links).iter().enumerate() {
        let key = format!("{scope}\u{1}{PARENT_CONTRACT_VERSION}\u{1}{at}");
        let held = crate::memory::unless_changed("parent", &key, &crate::jev::named(prompt), || {
            crate::author::derive_parent(prompt)
        });
        if let Some(value) = held {
            let more = answer_from(&value);
            answer.derived.extend(more.derived);
            answer.left.extend(more.left);
        }
    }
    let mut derivation = assemble(&parts, composition, &links, &answer);
    if derivation.capabilities.is_empty() {
        eprintln!("  parent has no derivation to use: each part's capability is promoted on its own weight");
        derivation = assemble(&parts, composition, &links, &carried(&parts));
    }
    Some((parts, derivation))
}

pub fn lacking_provenance(whole: &[Capability]) -> Vec<&Capability> {
    whole
        .iter()
        .filter(|capability| capability.composition_provenance.is_empty() && capability.parent_originated.is_none())
        .collect()
}

pub fn mark_parent_originated(whole: &mut [Capability]) {
    let lacking: Vec<String> = lacking_provenance(whole).iter().map(|capability| capability.id.clone()).collect();
    if lacking.is_empty() {
        return;
    }
    eprintln!("  parent kept {} capabilities that trace to no child capability, marked as orphan source", lacking.len());
    for capability in whole.iter_mut().filter(|capability| lacking.contains(&capability.id)) {
        let evidence = match capability.flows.is_empty() {
            true => vec![capability.id.clone()],
            false => capability.flows.clone(),
        };
        capability.parent_originated = Some(Originated { kind: "orphan", evidence });
    }
}

pub fn summarise(whole: &[Capability], parts: &[Capability], reasons: &BTreeMap<(String, String), String>, composition: &Composition) -> Summary {
    let cited: BTreeSet<(&str, &str)> = whole
        .iter()
        .flat_map(|capability| capability.composition_provenance.iter())
        .map(|source| (source.source_child.as_str(), source.source_capability_id.as_str()))
        .collect();
    let mut promoted: Vec<Promoted> = whole
        .iter()
        .map(|capability| Promoted {
            capability: capability.id.clone(),
            name: capability.name.clone().unwrap_or_default(),
            from: capability.composition_provenance.clone(),
            parent_originated: capability.parent_originated.clone(),
        })
        .collect();
    promoted.sort_by(|left, right| left.capability.cmp(&right.capability));
    let mut not_promoted: Vec<NotPromoted> = parts
        .iter()
        .filter_map(|capability| {
            let (child, id) = key_of(capability);
            (!cited.contains(&(child.as_str(), id.as_str()))).then(|| NotPromoted {
                reason: reasons.get(&(child.clone(), id.clone())).cloned().unwrap_or_else(|| {
                    match weight_of(composition, &child).is_some_and(|weight| weight < LOW_WEIGHT) {
                        true => "its part has very low weight, so it is left visible under that part".to_string(),
                        false => "it serves no purpose the product states, so it is left under its part".to_string(),
                    }
                }),
                child,
                capability: id,
            })
        })
        .collect();
    not_promoted.sort_by(|left, right| left.child.cmp(&right.child).then(left.capability.cmp(&right.capability)));
    Summary { promoted, not_promoted }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comprehend::Delivery;
    use crate::composition::{Child, Dependency, Orphan, WeightBasis};

    fn child(id: &str, status: &'static str, weight: f64) -> Child {
        Child {
            id: format!("subproject:{id}"),
            name: id.to_string(),
            status,
            weight,
            weight_basis: WeightBasis { ship: 1.0, activity: 1.0, consumed_by_shipped: false, days_since_change: Some(400), notes: Vec::new() },
        }
    }

    fn composition(children: Vec<Child>) -> Composition {
        Composition {
            mode: "derived",
            children,
            seams: vec![Seam {
                from: "subproject:app".to_string(),
                to: "subproject:api".to_string(),
                kind: "http",
                communication: "sync",
                origin: "product",
                count: 4,
                evidence: vec!["GET /orders".to_string()],
            }],
            links: Vec::new(),
            dependencies: vec![Dependency {
                from: "subproject:api".to_string(),
                to: "subproject:kit".to_string(),
                count: 9,
                evidence: vec!["api/orders.ts".to_string()],
            }],
            orphan: Some(Orphan { project: "subproject:.".to_string(), files: 3, declarations: 5 }),
            promoted: Vec::new(),
            not_promoted: Vec::new(),
        }
    }

    fn capability(project: &str, name: &str, flows: &[&str]) -> Capability {
        Capability {
            id: format!("capability:{}", crate::comprehend::carved_name(name)),
            audience: Some("shoppers".to_string()),
            delivered: flows
                .iter()
                .map(|flow| Delivery { flow: flow.to_string(), role: "primary", rationale: String::new() })
                .collect(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: flows.iter().map(|flow| flow.to_string()).collect(),
            surfaces: Vec::new(),
            project: Some(format!("subproject:{project}")),
            also_in: Vec::new(),
            place: None,
            name: Some(name.to_string()),
            description: Some(format!("{name} for someone.")),
            grounding: None,
            standing: crate::comprehend::PUBLISHED,
            touches: Vec::new(),
            terminality: None,
            confidence: None,
            unsettled: None,
            composition_provenance: Vec::new(),
            parent_originated: None,
            evidence: String::new(),
        }
    }

    fn parts() -> Vec<Capability> {
        vec![
            capability("api", "Place an order", &["flow:a1", "flow:a2"]),
            capability("app", "Order from the shop", &["flow:b1"]),
            capability("kit", "Send tracked events", &["flow:c1"]),
            capability("legacy", "Print a paper invoice", &["flow:d1"]),
            capability("legacy", "Order by phone form", &["flow:d2"]),
            capability(".", "Release the product", &["flow:e1"]),
        ]
    }

    fn world() -> Composition {
        composition(vec![
            child("api", "deployable", 1.0),
            child("app", "deployable", 0.9),
            child("kit", "library", 0.4),
            child("legacy", "module", 0.05),
        ])
    }

    fn derived(name: &str, from: &[(&str, &str)], link: &[&str], stated: bool) -> Derived {
        Derived {
            name: name.to_string(),
            description: format!("{name}, in one sentence."),
            audience: "Shoppers".to_string(),
            from: from
                .iter()
                .map(|(id, how)| Citing::Full { id: id.to_string(), disposition: how.to_string() })
                .collect(),
            link: link.iter().map(|held| held.to_string()).collect(),
            stated,
        }
    }

    fn assembled(derived: Vec<Derived>, left: Vec<Left>) -> (Derivation, Vec<Capability>) {
        let parts = parts();
        let world = world();
        let links = links_of(&world, &parts);
        (assemble(&parts, &world, &links, &Answer { derived, left }), parts)
    }

    #[test]
    fn the_answer_parses_from_the_shape_the_model_is_asked_for() {
        let text = r#"{"derived":[{"name":"Order goods","description":"Buy things.","audience":"shoppers",
            "from":[{"id":"k0","as":"promoted"},"k1",{"id":"k2","as":"absorbed"}],"link":["s1"],"stated":false}],
            "left":[{"id":"k3","why":"old"}]}"#;
        let answer = answer_from(&serde_json::from_str(text).unwrap());
        assert_eq!(answer.derived.len(), 1);
        let from = &answer.derived[0].from;
        assert_eq!((from[0].id(), from[0].disposition()), ("k0", "promoted"));
        assert_eq!((from[1].id(), from[1].disposition()), ("k1", "promoted"));
        assert_eq!((from[2].id(), from[2].disposition()), ("k2", "absorbed"));
        assert_eq!(answer.left[0].id, "k3");
    }

    #[test]
    fn a_derived_capability_unions_its_sources_flows_and_names_them_all() {
        let (built, _) = assembled(
            vec![derived("Order goods", &[("k0", "promoted"), ("k1", "promoted"), ("k2", "absorbed")], &[], false)],
            Vec::new(),
        );
        let whole = &built.capabilities[0];
        assert_eq!(whole.project, None);
        assert_eq!(whole.flows, vec!["flow:a1", "flow:a2", "flow:b1", "flow:c1"]);
        assert_eq!(whole.also_in, vec!["subproject:api", "subproject:app", "subproject:kit"]);
        assert_eq!(whole.id, "capability:order-goods");
        assert_eq!(whole.audience.as_deref(), Some("shoppers"));
        let kit = whole.composition_provenance.iter().find(|held| held.source_child == "subproject:kit").unwrap();
        assert_eq!((kit.disposition, kit.weight), ("absorbed", Some(0.4)));
        assert_eq!(whole.composition_provenance.len(), 3);
    }

    #[test]
    fn every_derived_capability_traces_to_a_child_capability_or_is_marked() {
        let (built, _) = assembled(
            vec![
                derived("Order goods", &[("k0", "promoted"), ("k1", "promoted")], &["s1"], false),
                derived("Release the product", &[("k5", "promoted")], &[], false),
                derived("Invented thing", &[("k99", "promoted"), ("nonsense", "promoted")], &[], false),
            ],
            Vec::new(),
        );
        assert_eq!(built.capabilities.len(), 2);
        assert!(lacking_provenance(&built.capabilities).is_empty());
        assert!(built.capabilities.iter().all(|held| !held.composition_provenance.is_empty()));
        let order = built.capabilities.iter().find(|held| held.id == "capability:order-goods").unwrap();
        assert_eq!(order.parent_originated.as_ref().map(|held| held.kind), Some("seam"));
        let release = built.capabilities.iter().find(|held| held.id == "capability:release-the-product").unwrap();
        assert_eq!(release.parent_originated.as_ref().map(|held| held.kind), Some("orphan"));
    }

    #[test]
    fn a_link_that_matches_no_seam_or_a_single_child_does_not_mark_the_capability() {
        let (built, _) = assembled(
            vec![
                derived("Order goods", &[("k0", "promoted"), ("k1", "promoted")], &["s77"], false),
                derived("Place orders", &[("k0", "promoted")], &["s1"], false),
            ],
            Vec::new(),
        );
        assert!(built.capabilities.iter().all(|held| held.parent_originated.is_none()));
    }

    #[test]
    fn the_invariant_check_names_a_capability_with_no_trace_and_marking_keeps_it_as_orphan_source() {
        let mut orphan = capability("api", "Floating purpose", &["flow:z"]);
        orphan.project = None;
        let mut traced = capability("api", "Traced purpose", &["flow:y"]);
        traced.project = None;
        traced.composition_provenance =
            vec![Source { source_child: "subproject:api".into(), source_capability_id: "x".into(), disposition: "promoted", weight: Some(1.0) }];
        let mut whole = vec![orphan, traced];
        assert_eq!(lacking_provenance(&whole).len(), 1);
        mark_parent_originated(&mut whole);
        assert_eq!(whole.len(), 2);
        assert!(lacking_provenance(&whole).is_empty());
        let marked = whole.iter().find(|held| held.id == "capability:floating-purpose").unwrap();
        let origin = marked.parent_originated.as_ref().expect("marked");
        assert_eq!(origin.kind, "orphan");
        assert_eq!(origin.evidence, vec!["flow:z"]);
        assert!(whole.iter().find(|held| held.id == "capability:traced-purpose").unwrap().parent_originated.is_none());
    }

    #[test]
    fn a_low_weight_child_never_headlines_unless_the_product_states_the_purpose() {
        let (built, _) = assembled(
            vec![
                derived("Print paper invoices", &[("k3", "promoted")], &[], false),
                derived("Take orders by phone", &[("k4", "promoted")], &[], true),
            ],
            Vec::new(),
        );
        assert_eq!(built.capabilities.len(), 1);
        assert_eq!(built.capabilities[0].name.as_deref(), Some("Take orders by phone"));
        assert_eq!(built.capabilities[0].composition_provenance[0].weight, Some(0.05));
        assert!(built.reasons.values().any(|why| why.contains("low-weight")));
    }

    #[test]
    fn a_low_weight_source_beside_a_heavier_one_is_left_with_its_own_part() {
        let (built, parts) = assembled(
            vec![derived("Order goods", &[("k1", "promoted"), ("k4", "promoted")], &[], false)],
            Vec::new(),
        );
        let whole = &built.capabilities[0];
        assert_eq!(whole.flows, vec!["flow:b1"]);
        assert!(whole.composition_provenance.iter().all(|held| held.source_child != "subproject:legacy"));
        let summary = summarise(&built.capabilities, &parts, &built.reasons, &world());
        let left: Vec<&str> = summary
            .not_promoted
            .iter()
            .filter(|held| held.child == "subproject:legacy")
            .map(|held| held.capability.as_str())
            .collect();
        assert_eq!(left, vec!["capability:order-by-phone-form", "capability:print-a-paper-invoice"]);
        assert!(summary.not_promoted.iter().all(|held| !held.reason.is_empty()));
    }

    #[test]
    fn capabilities_the_model_leaves_out_are_listed_with_its_reason() {
        let (built, parts) = assembled(
            vec![derived("Order goods", &[("k0", "promoted")], &[], false)],
            vec![Left { id: "k2".into(), why: "only feeds other parts".into() }],
        );
        let summary = summarise(&built.capabilities, &parts, &built.reasons, &world());
        let kit = summary.not_promoted.iter().find(|held| held.child == "subproject:kit").unwrap();
        assert_eq!(kit.reason, "only feeds other parts");
        assert_eq!(summary.promoted.len(), 1);
        assert_eq!(summary.promoted[0].from[0].source_capability_id, "capability:place-an-order");
    }

    #[test]
    fn two_derived_capabilities_with_the_same_name_key_become_one_with_both_traces() {
        let (built, _) = assembled(
            vec![
                derived("Order goods", &[("k0", "promoted")], &[], false),
                derived("Order the goods", &[("k1", "promoted")], &[], false),
            ],
            Vec::new(),
        );
        assert_eq!(built.capabilities.len(), 1);
        assert_eq!(built.capabilities[0].composition_provenance.len(), 2);
        assert_eq!(built.capabilities[0].flows, vec!["flow:a1", "flow:a2", "flow:b1"]);
    }

    #[test]
    fn assembling_is_deterministic_whatever_order_the_model_lists_them_in() {
        let list = || {
            vec![
                derived("Order goods", &[("k0", "promoted"), ("k1", "promoted")], &["s1"], false),
                derived("Release the product", &[("k5", "promoted")], &[], false),
                derived("Track usage", &[("k2", "absorbed")], &[], false),
            ]
        };
        let shown = |built: &Derivation| serde_json::to_string(&built.capabilities).unwrap();
        let (first, _) = assembled(list(), Vec::new());
        let (second, _) = assembled(list(), Vec::new());
        let mut reversed = list();
        reversed.reverse();
        let (third, _) = assembled(reversed, Vec::new());
        assert_eq!(shown(&first), shown(&second));
        assert_eq!(shown(&first), shown(&third));
    }

    #[test]
    fn without_an_answer_each_part_is_promoted_alone_except_the_low_weight_one() {
        let parts = parts();
        let world = world();
        let links = links_of(&world, &parts);
        let built = assemble(&parts, &world, &links, &carried(&parts));
        assert!(lacking_provenance(&built.capabilities).is_empty());
        assert_eq!(built.capabilities.len(), 4);
        assert!(built.capabilities.iter().all(|held| held.composition_provenance.iter().all(|source| source.source_child != "subproject:legacy")));
        let summary = summarise(&built.capabilities, &parts, &built.reasons, &world);
        assert_eq!(summary.not_promoted.len(), 2);
        assert!(summary.not_promoted.iter().all(|held| held.reason.contains("low-weight")));
    }

    #[test]
    fn a_repository_whose_capabilities_sit_in_one_part_is_left_as_a_leaf() {
        let world = world();
        let one: Vec<Capability> = parts().into_iter().filter(|held| held.project.as_deref() == Some("subproject:api")).collect();
        assert!(!spans_children(&one));
        assert!(derive(&world, &one, &[], "words", "scope").is_none());
    }

    #[test]
    fn capabilities_of_no_declared_part_are_not_offered_to_the_parent() {
        let world = world();
        let mut all = parts();
        all.push(capability("elsewhere", "Unknown thing", &["flow:u"]));
        let within = parts_within(&world, &all);
        assert_eq!(within.len(), 6);
        assert!(within.iter().all(|held| held.project.as_deref() != Some("subproject:elsewhere")));
    }

    #[test]
    fn the_prompt_states_the_weights_the_connections_and_the_rules() {
        let parts = parts();
        let world = world();
        let links = links_of(&world, &parts);
        let prompts = prompts_of("It sells things.", &world, &parts, &[], &links);
        assert_eq!(prompts.len(), 1);
        let prompt = &prompts[0];
        assert!(prompt.contains("It sells things."));
        assert!(prompt.contains("- api: deployable, weight 1.00"));
        assert!(prompt.contains("- legacy: module, weight 0.05"));
        assert!(prompt.contains("- s1: app to api (http, sync): GET /orders"));
        assert!(prompt.contains("api imports from kit"));
        assert!(prompt.contains("k0: Place an order"));
        assert!(prompt.contains("must not lead the product's purposes"));
        assert!(prompt.find("PART api").unwrap() < prompt.find("PART legacy").unwrap());
    }

    #[test]
    fn an_oversized_input_is_split_across_asks_and_every_capability_is_listed_once() {
        let world = world();
        let many: Vec<Capability> = (0..900)
            .map(|at| capability(["api", "app", "kit"][at % 3], &format!("Do thing number {at} with a long enough name"), &["flow:x"]))
            .collect();
        let links = links_of(&world, &many);
        let prompts = prompts_of("Words.", &world, &many, &[], &links);
        assert!(prompts.len() > 1, "{}", prompts.len());
        assert!(prompts.iter().all(|held| held.len() < INPUT_LIMIT + 4000));
        for at in 0..many.len() {
            let handle = format!("  k{at}: ");
            assert_eq!(prompts.iter().filter(|held| held.contains(&handle)).count(), 1, "{handle}");
        }
    }

    #[test]
    fn packing_keeps_each_range_within_the_limit_unless_one_item_is_alone_over_it() {
        assert_eq!(packed(&[4, 4, 4], 8), vec![0..2, 2..3]);
        assert_eq!(packed(&[10, 1], 5), vec![0..1, 1..2]);
        assert!(packed(&[], 5).is_empty());
    }
}

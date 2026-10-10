use std::collections::BTreeMap;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::{Comprehension, Flow};
use crate::ties::Held;

#[derive(Debug, Clone, Serialize, Default)]
pub struct Whole {
    pub flows: Vec<Flow>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<WholeEntity>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<WholeComponent>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<Connection>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub external: Vec<WholeExternal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Defined {
    pub part: String,
    pub entity: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WholeEntity {
    pub id: String,
    pub declared_as: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standing: Option<&'static str>,
    pub defined_in: Vec<Defined>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub defined_more_than_once: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<Held>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WholeComponent {
    pub part: String,
    pub name: String,
    pub role: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub from: String,
    pub to: String,
    pub by: Vec<&'static str>,
    pub carries: Vec<String>,
    pub seams: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WholeExternal {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub used_by: Vec<String>,
}

pub struct Parts<'a> {
    pub names: &'a HashMap<String, String>,
    pub roles: &'a HashMap<String, &'static str>,
    pub summaries: &'a HashMap<String, String>,
    pub architecture: Option<&'a crate::architecture::Architecture>,
    pub services: &'a [crate::services::Service],
}

const KEEPS: &str = "keeps";
const READS: &str = "reads";

pub fn compose(held: &mut Comprehension, parts: &Parts) {
    let Some(mut whole) = held.whole.take() else { return };
    whole.entities = entities_of(held);
    whole.components = components_of(held, parts);
    whole.connections = connections_of(held);
    whole.external = parts
        .services
        .iter()
        .filter(|service| !service.projects.is_empty())
        .map(|service| WholeExternal { id: service.id.clone(), name: service.name.clone(), kind: service.kind, used_by: service.projects.clone() })
        .collect();
    drawn_from(held, &whole.flows);
    tie_records(held, &mut whole.entities);
    held.whole = Some(whole);
}

fn entities_of(held: &Comprehension) -> Vec<WholeEntity> {
    let mut grouped: BTreeMap<&str, Vec<&crate::comprehend::Entity>> = BTreeMap::new();
    for entity in &held.entities {
        grouped.entry(entity.declared_as.as_str()).or_default().push(entity);
    }
    grouped
        .into_iter()
        .map(|(declared_as, members)| {
            let parts: HashSet<&str> = members.iter().filter_map(|member| member.project.as_deref()).collect();
            WholeEntity {
                id: format!("entity:whole:{declared_as}"),
                declared_as: declared_as.to_string(),
                name: members.iter().find_map(|member| member.name.clone()),
                description: members.iter().find_map(|member| member.description.clone()),
                standing: match members.iter().any(|member| member.standing == Some("domain")) {
                    true => Some("domain"),
                    false => members.iter().find_map(|member| member.standing),
                },
                defined_in: members.iter().map(|member| Defined { part: member.project.clone().unwrap_or_default(), entity: member.id.clone() }).collect(),
                defined_more_than_once: parts.len() > 1,
                capabilities: Vec::new(),
            }
        })
        .collect()
}

fn components_of(held: &Comprehension, parts: &Parts) -> Vec<WholeComponent> {
    let shaped: HashMap<&str, Vec<String>> = parts
        .architecture
        .into_iter()
        .flat_map(|architecture| architecture.projects.iter())
        .map(|project| (project.project.as_str(), project.shape.components.iter().map(|component| component.label.clone()).collect()))
        .collect();
    let mut capabilities_of: HashMap<&str, Vec<String>> = HashMap::default();
    for capability in held.capabilities.iter().filter(|capability| capability.level == crate::capabilities::PART) {
        if let Some(part) = capability.project.as_deref() {
            capabilities_of.entry(part).or_default().push(capability.id.clone());
        }
    }
    let mut ids: Vec<&String> = parts.names.keys().collect();
    ids.sort();
    ids.into_iter()
        .map(|part| WholeComponent {
            part: part.clone(),
            name: parts.names.get(part).cloned().unwrap_or_else(|| part.clone()),
            role: parts.roles.get(part).copied().unwrap_or_default(),
            summary: parts.summaries.get(part).cloned().unwrap_or_default(),
            components: shaped.get(part.as_str()).cloned().unwrap_or_default(),
            capabilities: capabilities_of.remove(part.as_str()).unwrap_or_default(),
        })
        .collect()
}

fn connections_of(held: &Comprehension) -> Vec<Connection> {
    let mut joined: BTreeMap<(String, String), Connection> = BTreeMap::new();
    for seam in &held.seams {
        let held = joined.entry((seam.from.clone(), seam.to.clone())).or_insert_with(|| Connection {
            from: seam.from.clone(),
            to: seam.to.clone(),
            by: Vec::new(),
            carries: Vec::new(),
            seams: 0,
        });
        held.seams += 1;
        if !held.by.contains(&seam.by) {
            held.by.push(seam.by);
        }
        if !held.carries.contains(&seam.carries) {
            held.carries.push(seam.carries.clone());
        }
    }
    joined.into_values().collect()
}

fn drawn_from(held: &mut Comprehension, journeys: &[Flow]) {
    let ties_of: HashMap<&str, Vec<String>> = held
        .flows
        .iter()
        .map(|flow| (flow.id.as_str(), flow.capabilities.iter().filter(|tie| tie.role == "delivers").map(|tie| tie.capability.clone()).collect()))
        .collect();
    let members_of: HashMap<&str, Vec<&str>> = journeys
        .iter()
        .map(|journey| (journey.id.as_str(), journey.steps.iter().flat_map(|step| step.lands_in.iter().map(String::as_str)).collect()))
        .collect();
    let found: Vec<Vec<String>> = held
        .capabilities
        .iter()
        .map(|capability| {
            if capability.level != crate::capabilities::WHOLE {
                return Vec::new();
            }
            let mut from: Vec<String> = capability
                .delivered
                .iter()
                .filter(|delivered| delivered.role == "primary")
                .flat_map(|delivered| members_of.get(delivered.flow.as_str()).into_iter().flatten())
                .flat_map(|member| ties_of.get(member).into_iter().flatten().cloned())
                .collect();
            from.sort();
            from.dedup();
            from
        })
        .collect();
    for (capability, from) in held.capabilities.iter_mut().zip(found) {
        capability.drawn_from = from;
    }
}

fn tie_records(held: &mut Comprehension, entities: &mut [WholeEntity]) {
    let at: HashMap<String, usize> = entities.iter().enumerate().map(|(at, entity)| (entity.declared_as.clone(), at)).collect();
    for capability in held.capabilities.iter_mut().filter(|capability| capability.level == crate::capabilities::WHOLE) {
        capability.keeps.clear();
        capability.reads.clear();
        capability.keeps_through.clear();
        capability.reads_through.clear();
        let kept: Vec<String> = capability.records.clone();
        let read: Vec<String> = capability.touches.iter().filter(|named| !kept.contains(named)).cloned().collect();
        for (names, role) in [(kept, KEEPS), (read, READS)] {
            for named in names {
                let Some(position) = at.get(&named).copied() else { continue };
                let entity = &mut entities[position];
                let into = if role == KEEPS { &mut capability.keeps } else { &mut capability.reads };
                if !into.contains(&entity.id) {
                    into.push(entity.id.clone());
                }
                if !entity.capabilities.iter().any(|tie| tie.capability == capability.id) {
                    entity.capabilities.push(Held { capability: capability.id.clone(), role });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comprehend::{Capability, Delivery, Entity};

    fn entity(declared_as: &str, part: &str) -> Entity {
        Entity {
            id: format!("entity:{part}:{declared_as}"),
            declared_as: declared_as.to_string(),
            named_fields: Vec::new(),
            name: Some(declared_as.to_string()),
            description: None,
            grounding: None,
            declared_in: None,
            fields: 0,
            addressed_by: 0,
            written_by: Vec::new(),
            read_by: Vec::new(),
            written_in: Vec::new(),
            read_in: Vec::new(),
            references: Vec::new(),
            project: Some(part.to_string()),
            terminality: None,
            unshipped: None,
            persisted_by: None,
            part_of: None,
            standing: Some("domain"),
            used_by: Vec::new(),
            capabilities: Vec::new(),
        }
    }

    fn capability(id: &str, level: &'static str, delivered: &[&str], records: &[&str]) -> Capability {
        Capability {
            id: id.to_string(),
            audience: None,
            delivered: delivered.iter().map(|flow| Delivery { flow: flow.to_string(), role: "primary", rationale: String::new(), unshipped: None }).collect(),
            records: records.iter().map(|held| held.to_string()).collect(),
            changes: Vec::new(),
            flows: delivered.iter().map(|flow| flow.to_string()).collect(),
            surfaces: Vec::new(),
            project: None,
            also_in: Vec::new(),
            place: Some("core"),
            name: Some(id.to_string()),
            description: None,
            grounding: None,
            standing: crate::comprehend::PUBLISHED,
            level,
            touches: records.iter().map(|held| held.to_string()).collect(),
            terminality: None,
            confidence: None,
            unsettled: None,
            offers: Vec::new(),
            used_in: Vec::new(),
            keeps: Vec::new(),
            reads: Vec::new(),
            keeps_through: Vec::new(),
            reads_through: Vec::new(),
            drawn_from: Vec::new(),
            evidence: String::new(),
        }
    }

    fn flow_named(id: &str) -> Flow {
        Flow {
            summary: String::new(),
            writes: Vec::new(),
            reads: Vec::new(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind: "http",
            method: None,
            operation: id.to_string(),
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
            takes: Vec::new(),
            leads_into: Vec::new(),
            project: None,
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capabilities: Vec::new(),
        }
    }

    fn comprehension(capabilities: Vec<Capability>, entities: Vec<Entity>) -> Comprehension {
        Comprehension {
            products: Vec::new(),
            capabilities,
            flows: Vec::new(),
            entities,
            terminal: 0,
            chained: 0,
            semantic_coverage: None,
            whole: None,
            set_aside: Vec::new(),
            seams: Vec::new(),
            offered: Vec::new(),
        }
    }

    #[test]
    fn a_record_defined_in_two_parts_is_one_whole_record_flagged_as_a_finding() {
        let held = comprehension(Vec::new(), vec![entity("Order", "orders"), entity("Order", "billing"), entity("Product", "catalog")]);
        let found = entities_of(&held);
        assert_eq!(found.len(), 2);
        assert!(found[0].defined_more_than_once);
        assert_eq!(found[0].defined_in.len(), 2);
        assert!(!found[1].defined_more_than_once);
    }

    #[test]
    fn a_whole_capability_links_down_to_the_part_capabilities_of_the_flows_its_journeys_cross() {
        let mut part = capability("capability:orders:take-orders", crate::capabilities::PART, &["create-order"], &[]);
        part.project = Some("orders".to_string());
        let whole = capability("capability:whole:buy-books", crate::capabilities::WHOLE, &["journey:checkout"], &["Order"]);
        let mut held = comprehension(vec![part, whole], vec![entity("Order", "orders")]);
        let mut member = flow_named("create-order");
        member.capabilities = vec![Held { capability: "capability:orders:take-orders".to_string(), role: "delivers" }];
        held.flows.push(member);
        let mut journey = flow_named("journey:checkout");
        journey.steps = vec![crate::steps::LogicalStep { id: "s1".to_string(), kind: "do", label: "Orders: Create order".to_string(), object: None, doing: None, when: "always", arms: Vec::new(), regions: Vec::new(), description: None, lands_in: vec!["create-order".to_string()], gathers: Vec::new() }];
        held.whole = Some(Whole { flows: vec![journey], ..Default::default() });
        let names = HashMap::default();
        let roles = HashMap::default();
        let summaries = HashMap::default();
        compose(&mut held, &Parts { names: &names, roles: &roles, summaries: &summaries, architecture: None, services: &[] });
        assert_eq!(held.capabilities[1].drawn_from, ["capability:orders:take-orders"]);
        let mut supported = capability("capability:whole:sign-in", crate::capabilities::WHOLE, &[], &[]);
        supported.delivered.push(Delivery { flow: "journey:checkout".to_string(), role: "supporting", rationale: String::new(), unshipped: None });
        held.capabilities.push(supported);
        let journeys = held.whole.as_ref().unwrap().flows.clone();
        drawn_from(&mut held, &journeys);
        assert!(held.capabilities[2].drawn_from.is_empty(), "a capability is drawn only from the journeys that deliver it");
        assert_eq!(held.capabilities[1].keeps, ["entity:whole:Order"], "the whole system keeps its own record, which points at the part's");
        let whole = held.whole.as_ref().unwrap();
        assert_eq!(whole.entities[0].capabilities[0].capability, "capability:whole:buy-books");
        assert_eq!(whole.entities[0].defined_in[0].entity, "entity:orders:Order");
    }
}

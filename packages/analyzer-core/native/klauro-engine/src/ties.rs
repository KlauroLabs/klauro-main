use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::Comprehension;
use crate::model::{EdgeKind, IndexEdge, IndexNode};

const REACH_AT_MOST: usize = 20_000;
const DELIVERS: &str = "delivers";
const SUPPORTS: &str = "supports";
const KEEPS: &str = "keeps";
const READS: &str = "reads";
const KEEPS_THROUGH: &str = "keeps through another part";
const READS_THROUGH: &str = "reads through another part";

#[derive(Debug, Clone, Serialize)]
pub struct Held {
    pub capability: String,
    pub role: &'static str,
}

fn strength(role: &str) -> u8 {
    match role {
        KEEPS => 3,
        READS => 2,
        KEEPS_THROUGH => 1,
        _ => 0,
    }
}

fn file_of(unit: &str) -> &str {
    unit.split(':').next().unwrap_or(unit)
}

pub fn tie(held: &mut Comprehension, nodes: &[IndexNode], edges: &[IndexEdge]) {
    let mut held_by: HashMap<String, Vec<Held>> = HashMap::default();
    for capability in &held.capabilities {
        for delivered in &capability.delivered {
            let role = if delivered.role == "primary" { DELIVERS } else { SUPPORTS };
            held_by.entry(delivered.flow.clone()).or_default().push(Held { capability: capability.id.clone(), role });
        }
    }
    for flow in held.flows.iter_mut().chain(held.journeys.iter_mut()) {
        flow.capabilities = held_by.remove(&flow.id).unwrap_or_default();
    }

    let callbacks: HashSet<&str> = nodes.iter().filter(|node| node.callback_of.is_some()).map(|node| node.id.as_str()).collect();
    let mut next: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges {
        let walks = match edge.kind {
            EdgeKind::Calls | EdgeKind::Instantiates => true,
            EdgeKind::Contains => callbacks.contains(edge.target.as_str()),
            _ => false,
        };
        if walks {
            next.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        }
    }
    let offered_files: HashSet<&str> = held.capabilities.iter().flat_map(|capability| capability.offers.iter()).map(|unit| file_of(unit)).collect();
    let parent_of: HashMap<&str, &str> = nodes.iter().filter_map(|node| Some((node.id.as_str(), node.parent.as_deref()?))).collect();
    let mut grounds: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Extends && offered_files.contains(file_of(&edge.target))) {
        grounds.entry(edge.source.as_str()).or_default().push(file_of(&edge.target));
    }
    let mut used_in_file: HashMap<&str, Vec<String>> = HashMap::default();
    if !offered_files.is_empty() {
        for flow in &held.flows {
            let Some(start) = flow.path.first().map(|step| step.unit.as_str()) else { continue };
            let mut seen: HashSet<&str> = HashSet::from_iter([start]);
            let mut queue: Vec<&str> = vec![start];
            let mut head = 0;
            while head < queue.len() && queue.len() < REACH_AT_MOST {
                let current = queue[head];
                head += 1;
                for target in next.get(current).into_iter().flatten() {
                    if seen.insert(target) {
                        queue.push(target);
                    }
                }
            }
            let mut touched: HashSet<&str> = HashSet::default();
            for unit in queue {
                let file = file_of(unit);
                let through_a_type = [Some(unit), parent_of.get(unit).copied()].into_iter().flatten().flat_map(|owner| grounds.get(owner).into_iter().flatten().copied());
                for offered in std::iter::once(file).filter(|file| offered_files.contains(file)).chain(through_a_type) {
                    if touched.insert(offered) {
                        used_in_file.entry(offered).or_default().push(flow.id.clone());
                    }
                }
            }
        }
    }
    let flow_home: HashMap<&str, Option<&str>> = held.flows.iter().map(|flow| (flow.id.as_str(), flow.runs_in.as_deref().or(flow.project.as_deref()))).collect();
    let mut used: Vec<Vec<String>> = Vec::with_capacity(held.capabilities.len());
    for capability in &held.capabilities {
        let mut found: Vec<String> = capability
            .offers
            .iter()
            .flat_map(|unit| used_in_file.get(file_of(unit)).into_iter().flatten())
            .filter(|flow| flow_home.get(flow.as_str()).copied().flatten() != capability.project.as_deref())
            .cloned()
            .collect();
        found.sort();
        found.dedup();
        used.push(found);
    }
    for (capability, found) in held.capabilities.iter_mut().zip(used) {
        capability.used_in = found;
    }

    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::default();
    for (at, entity) in held.entities.iter().enumerate() {
        by_name.entry(entity.declared_as.as_str()).or_default().push(at);
    }
    let chosen = |named: &str, part: Option<&str>| -> Vec<usize> {
        let candidates = by_name.get(named).cloned().unwrap_or_default();
        let own: Vec<usize> = candidates.iter().copied().filter(|at| held.entities[*at].project.as_deref() == part).collect();
        if !own.is_empty() {
            return own;
        }
        let borrowed: Vec<usize> = candidates
            .iter()
            .copied()
            .filter(|at| held.entities[*at].used_by.iter().any(|using| Some(using.project.as_str()) == part))
            .collect();
        if !borrowed.is_empty() {
            return borrowed;
        }
        candidates
    };
    let flow_records: HashMap<&str, (&[String], &[String], Option<&str>)> = held
        .flows
        .iter()
        .map(|flow| (flow.id.as_str(), (flow.writes.as_slice(), flow.reads.as_slice(), flow.runs_in.as_deref().or(flow.project.as_deref()))))
        .collect();
    let mut handed: HashMap<&str, Vec<&str>> = HashMap::default();
    for seam in &held.seams {
        handed.entry(seam.from_flow.as_str()).or_default().extend(seam.to_flows.iter().map(String::as_str));
    }
    let mut ties: Vec<(usize, usize, &'static str)> = Vec::new();
    for (at, capability) in held.capabilities.iter().enumerate().filter(|(_, capability)| capability.level == crate::capabilities::PART) {
        for delivered in &capability.delivered {
            for other in handed.get(delivered.flow.as_str()).into_iter().flatten() {
                let Some((writes, reads, part)) = flow_records.get(other).copied() else { continue };
                if part == capability.project.as_deref() {
                    continue;
                }
                for named in writes {
                    for entity in chosen(named, part) {
                        ties.push((at, entity, KEEPS_THROUGH));
                    }
                }
                for named in reads.iter().filter(|named| !writes.contains(named)) {
                    for entity in chosen(named, part) {
                        ties.push((at, entity, READS_THROUGH));
                    }
                }
            }
        }
    }
    for (at, capability) in held.capabilities.iter().enumerate() {
        let part = capability.project.as_deref();
        for named in &capability.records {
            for entity in chosen(named, part) {
                ties.push((at, entity, KEEPS));
            }
        }
        for named in capability.touches.iter().filter(|named| !capability.records.contains(named)) {
            for entity in chosen(named, part) {
                ties.push((at, entity, READS));
            }
        }
    }
    let wholes: Vec<Option<usize>> = held
        .entities
        .iter()
        .map(|entity| {
            let whole = entity.part_of.as_deref()?;
            by_name.get(whole)?.iter().copied().find(|at| held.entities[*at].project == entity.project).or_else(|| by_name.get(whole)?.first().copied())
        })
        .collect();
    for (capability, entity, role) in ties {
        let id = held.entities[entity].id.clone();
        let named = held.capabilities[capability].id.clone();
        let into = match role {
            KEEPS => &mut held.capabilities[capability].keeps,
            READS => &mut held.capabilities[capability].reads,
            KEEPS_THROUGH => &mut held.capabilities[capability].keeps_through,
            _ => &mut held.capabilities[capability].reads_through,
        };
        if !into.contains(&id) {
            into.push(id);
        }
        let holding = &mut held.entities[entity].capabilities;
        match holding.iter_mut().find(|tie| tie.capability == named) {
            Some(tie) if strength(role) > strength(tie.role) => tie.role = role,
            Some(_) => {}
            None => holding.push(Held { capability: named, role }),
        }
    }
    for (member, whole) in wholes.into_iter().enumerate() {
        let Some(whole) = whole.filter(|whole| *whole != member) else { continue };
        let inherited = held.entities[whole].capabilities.clone();
        let holding = &mut held.entities[member].capabilities;
        for tie in inherited {
            if !holding.iter().any(|held| held.capability == tie.capability) {
                holding.push(tie);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comprehend::{Capability, Delivery, Entity, Flow, Step};

    fn flow(id: &str, part: &str, start: &str) -> Flow {
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
            path: vec![Step { unit: start.to_string(), depth: 0, leaves: Vec::new() }],
            steps: Vec::new(),
            step_edges: Vec::new(),
            units: 1,
            rank: 0,
            stages: Vec::new(),
            changes: Vec::new(),
            takes: Vec::new(),
            leads_into: Vec::new(),
            project: Some(part.to_string()),
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capabilities: Vec::new(),
        }
    }

    fn capability(id: &str, part: &str, delivered: &[(&str, &'static str)], records: &[&str], touches: &[&str], offers: &[&str]) -> Capability {
        Capability {
            id: id.to_string(),
            audience: None,
            delivered: delivered.iter().map(|(flow, role)| Delivery { flow: flow.to_string(), role, rationale: String::new(), unshipped: None }).collect(),
            records: records.iter().map(|held| held.to_string()).collect(),
            changes: Vec::new(),
            flows: delivered.iter().map(|(flow, _)| flow.to_string()).collect(),
            surfaces: Vec::new(),
            project: Some(part.to_string()),
            also_in: Vec::new(),
            place: Some("core"),
            name: Some(id.to_string()),
            description: None,
            grounding: None,
            standing: crate::comprehend::PUBLISHED,
            level: crate::capabilities::PART,
            touches: touches.iter().map(|held| held.to_string()).collect(),
            terminality: None,
            confidence: None,
            unsettled: None,
            offers: offers.iter().map(|held| held.to_string()).collect(),
            used_in: Vec::new(),
            keeps: Vec::new(),
            reads: Vec::new(),
            keeps_through: Vec::new(),
            reads_through: Vec::new(),
            evidence: String::new(),
        }
    }

    fn entity(declared_as: &str, part: &str) -> Entity {
        Entity {
            id: format!("entity:{part}:{declared_as}"),
            declared_as: declared_as.to_string(),
            named_fields: Vec::new(),
            name: None,
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
            standing: None,
            used_by: Vec::new(),
            capabilities: Vec::new(),
        }
    }

    fn held(capabilities: Vec<Capability>, flows: Vec<Flow>, entities: Vec<Entity>) -> Comprehension {
        Comprehension {
            products: Vec::new(),
            capabilities,
            flows,
            entities,
            terminal: 0,
            chained: 0,
            semantic_coverage: None,
            journeys: Vec::new(),
            set_aside: Vec::new(),
            seams: Vec::new(),
            offered: Vec::new(),
        }
    }

    fn edge(source: &str, target: &str) -> IndexEdge {
        IndexEdge { source: source.to_string(), target: target.to_string(), kind: EdgeKind::Calls, via: Default::default() }
    }

    #[test]
    fn each_flow_names_the_capability_it_delivers_or_supports() {
        let mut held = held(
            vec![capability("capability:shop:place-orders", "shop", &[("place", "primary"), ("sign-in", "supporting")], &[], &[], &[])],
            vec![flow("place", "shop", "shop/orders.ts:function:place"), flow("sign-in", "shop", "shop/auth.ts:function:signIn"), flow("stray", "shop", "shop/x.ts:function:x")],
            Vec::new(),
        );
        held.capabilities.push(capability("capability:shop:cancel-orders", "shop", &[("cancel", "primary"), ("sign-in", "supporting")], &[], &[], &[]));
        tie(&mut held, &[], &[]);
        let ties = |at: usize| held.flows[at].capabilities.iter().map(|tie| (tie.capability.as_str(), tie.role)).collect::<Vec<_>>();
        assert_eq!(ties(0), [("capability:shop:place-orders", DELIVERS)]);
        assert_eq!(ties(1), [("capability:shop:place-orders", SUPPORTS), ("capability:shop:cancel-orders", SUPPORTS)], "supporting work may serve several capabilities");
        assert!(ties(2).is_empty(), "a flow may belong to no capability");
    }

    #[test]
    fn a_capability_keeps_and_reads_its_own_parts_records_and_each_record_knows_it() {
        let mut held = held(
            vec![capability("capability:shop:place-orders", "shop", &[], &["Order"], &["Order", "Product"], &[])],
            Vec::new(),
            vec![entity("Order", "shop"), entity("Order", "billing"), entity("Product", "catalog")],
        );
        tie(&mut held, &[], &[]);
        assert_eq!(held.capabilities[0].keeps, ["entity:shop:Order"], "the part's own record, not another part's of the same name");
        assert_eq!(held.capabilities[0].reads, ["entity:catalog:Product"]);
        assert_eq!(held.entities[0].capabilities.len(), 1);
        assert_eq!(held.entities[0].capabilities[0].role, "keeps");
        assert!(held.entities[1].capabilities.is_empty());
        assert_eq!(held.entities[2].capabilities[0].role, "reads");
    }

    #[test]
    fn a_journey_names_the_whole_system_capability_it_delivers() {
        let mut whole = capability("capability:whole:buy-books", "shop", &[("journey:checkout", "primary")], &["Order"], &["Order"], &[]);
        whole.level = crate::capabilities::WHOLE;
        whole.project = None;
        let mut held = held(vec![whole], Vec::new(), vec![entity("Order", "orders")]);
        held.journeys.push(flow("journey:checkout", "shop", "shop/Checkout.cs:function:Pay"));
        tie(&mut held, &[], &[]);
        assert_eq!(held.journeys[0].capabilities.len(), 1);
        assert_eq!(held.journeys[0].capabilities[0].role, DELIVERS);
        assert_eq!(held.entities[0].capabilities[0].capability, "capability:whole:buy-books", "a whole-system capability keeps the record wherever it is defined");
    }

    #[test]
    fn a_capability_keeps_what_the_part_it_calls_keeps_for_it() {
        let mut submit = flow("submit", "app", "app/Checkout.tsx:function:Submit");
        submit.kind = "ui";
        let mut create = flow("create-order", "orders", "orders/Api.cs:function:Create");
        create.writes = vec!["Order".to_string()];
        create.reads = vec!["Product".to_string()];
        let mut held = held(
            vec![capability("capability:app:check-out", "app", &[("submit", "primary")], &[], &[], &[])],
            vec![submit, create],
            vec![entity("Order", "orders"), entity("Product", "orders")],
        );
        held.seams.push(crate::seams::Seam {
            from: "app".to_string(),
            from_flow: "submit".to_string(),
            step: None,
            via: "http",
            by: "route",
            carries: "POST /orders".to_string(),
            to: "orders".to_string(),
            to_entry: "entry:create-order".to_string(),
            to_flows: vec!["create-order".to_string()],
        });
        tie(&mut held, &[], &[]);
        assert_eq!(held.capabilities[0].keeps_through, ["entity:orders:Order"]);
        assert_eq!(held.capabilities[0].reads_through, ["entity:orders:Product"]);
        assert_eq!(held.entities[0].capabilities[0].role, KEEPS_THROUGH);
    }

    #[test]
    fn a_record_that_is_part_of_another_carries_its_wholes_capabilities() {
        let mut line = entity("OrderLine", "shop");
        line.part_of = Some("Order".to_string());
        let mut held = held(
            vec![capability("capability:shop:place-orders", "shop", &[], &["Order"], &["Order"], &[])],
            Vec::new(),
            vec![entity("Order", "shop"), line],
        );
        tie(&mut held, &[], &[]);
        assert_eq!(held.entities[1].capabilities.len(), 1);
        assert_eq!(held.entities[1].capabilities[0].role, "keeps");
    }

    #[test]
    fn a_library_capability_is_used_in_the_flows_of_other_parts_that_reach_its_code() {
        let mut held = held(
            vec![capability("capability:bus:publish-events", "bus", &[], &[], &[], &["bus/Bus.cs:type:Bus"])],
            vec![flow("checkout", "shop", "shop/Checkout.cs:function:Pay"), flow("browse", "shop", "shop/Browse.cs:function:List")],
            Vec::new(),
        );
        let edges = [edge("shop/Checkout.cs:function:Pay", "bus/Bus.cs:function:Publish")];
        tie(&mut held, &[], &edges);
        assert_eq!(held.capabilities[0].used_in, ["checkout"]);
    }

    #[test]
    fn a_flow_that_runs_an_implementation_of_an_offered_type_uses_it() {
        let mut held = held(
            vec![capability("capability:bus:publish-events", "bus", &[], &[], &[], &["bus/IBus.cs:type:IBus"])],
            vec![flow("checkout", "shop", "shop/Checkout.cs:function:Pay")],
            Vec::new(),
        );
        let publish = IndexNode {
            id: "rabbit/RabbitBus.cs:function:Publish".to_string(),
            name: "Publish".to_string(),
            kind: crate::model::NodeKind::Method,
            file: 0,
            span: crate::model::Span { line: 1, column: 0, end_line: 1, end_column: 0 },
            parent: Some("rabbit/RabbitBus.cs:type:RabbitBus".to_string()),
            signature: None,
            modifiers: Default::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        };
        let edges = [
            edge("shop/Checkout.cs:function:Pay", "rabbit/RabbitBus.cs:function:Publish"),
            IndexEdge { source: "rabbit/RabbitBus.cs:type:RabbitBus".to_string(), target: "bus/IBus.cs:type:IBus".to_string(), kind: EdgeKind::Extends, via: Default::default() },
        ];
        tie(&mut held, &[publish], &edges);
        assert_eq!(held.capabilities[0].used_in, ["checkout"], "the call went to the implementation of the offered interface");
    }
}

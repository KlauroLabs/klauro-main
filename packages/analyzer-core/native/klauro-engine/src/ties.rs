use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::comprehend::Comprehension;
use crate::model::{EdgeKind, IndexEdge, IndexNode};

const REACH_AT_MOST: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
pub struct Held {
    pub capability: String,
    pub role: &'static str,
}

fn file_of(unit: &str) -> &str {
    unit.split(':').next().unwrap_or(unit)
}

pub fn tie(held: &mut Comprehension, nodes: &[IndexNode], edges: &[IndexEdge]) {
    let mut placed: HashMap<String, (String, &'static str)> = HashMap::default();
    for capability in held.capabilities.iter().filter(|capability| capability.level == crate::capabilities::PART) {
        for delivered in &capability.delivered {
            placed.entry(delivered.flow.clone()).or_insert((capability.id.clone(), delivered.role));
        }
    }
    for flow in held.flows.iter_mut() {
        if let Some((capability, role)) = placed.get(&flow.id) {
            flow.capability = Some(capability.clone());
            flow.serves_as = Some(role);
        }
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
                if offered_files.contains(file) && touched.insert(file) {
                    used_in_file.entry(file).or_default().push(flow.id.clone());
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
    let mut ties: Vec<(usize, usize, &'static str)> = Vec::new();
    for (at, capability) in held.capabilities.iter().enumerate().filter(|(_, capability)| capability.level == crate::capabilities::PART) {
        let part = capability.project.as_deref();
        for named in &capability.records {
            for entity in chosen(named, part) {
                ties.push((at, entity, "keeps"));
            }
        }
        for named in capability.touches.iter().filter(|named| !capability.records.contains(named)) {
            for entity in chosen(named, part) {
                ties.push((at, entity, "reads"));
            }
        }
    }
    for (capability, entity, role) in ties {
        let id = held.entities[entity].id.clone();
        let named = held.capabilities[capability].id.clone();
        let into = if role == "keeps" { &mut held.capabilities[capability].keeps } else { &mut held.capabilities[capability].reads };
        if !into.contains(&id) {
            into.push(id);
        }
        let holding = &mut held.entities[entity].capabilities;
        if !holding.iter().any(|tie| tie.capability == named) {
            holding.push(Held { capability: named, role });
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
            leads_into: Vec::new(),
            project: Some(part.to_string()),
            unshipped: None,
            entered_by: Vec::new(),
            runs_in: None,
            capability: None,
            serves_as: None,
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
            composition_provenance: Vec::new(),
            parent_originated: None,
            offers: offers.iter().map(|held| held.to_string()).collect(),
            used_in: Vec::new(),
            keeps: Vec::new(),
            reads: Vec::new(),
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
            derivation: None,
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
        tie(&mut held, &[], &[]);
        assert_eq!(held.flows[0].capability.as_deref(), Some("capability:shop:place-orders"));
        assert_eq!(held.flows[0].serves_as, Some("primary"));
        assert_eq!(held.flows[1].serves_as, Some("supporting"));
        assert!(held.flows[2].capability.is_none(), "a flow no capability placed stays visibly unplaced");
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
}

use rustc_hash::FxHashMap as HashMap;

use crate::capabilities::PART;
use crate::comprehend::{Capability, Entity, Flow};

pub(crate) struct Children<'a> {
    pub capabilities: &'a [Capability],
    pub flows: &'a [Flow],
    pub entities: &'a [Entity],
    pub seams: &'a [crate::seams::Seam],
    pub names: &'a HashMap<String, String>,
    pub roles: &'a HashMap<String, &'static str>,
}

fn home(flow: &Flow) -> Option<&str> {
    flow.runs_in.as_deref().or(flow.project.as_deref())
}

fn weighed(capability: &Capability) -> String {
    crate::journeys::weight_of(capability).map(|weight| weight.said()).unwrap_or_else(|| "not weighed".to_string())
}

fn steps_of(flow: &Flow) -> String {
    flow.steps.iter().map(|step| step.description.clone().unwrap_or_else(|| step.label.clone())).collect::<Vec<_>>().join("; ")
}

impl Children<'_> {
    fn name_of<'b>(&'b self, part: &'b str) -> &'b str {
        self.names.get(part).map(String::as_str).unwrap_or(part)
    }

    fn records_of(&self, names: &[String]) -> String {
        names
            .iter()
            .map(|named| self.entities.iter().find(|entity| &entity.declared_as == named).and_then(|entity| entity.name.clone()).unwrap_or_else(|| named.clone()))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn tied(&self, flow: &Flow) -> Vec<(&Capability, &'static str)> {
        self.capabilities
            .iter()
            .filter(|capability| capability.level == PART)
            .filter_map(|capability| capability.delivered.iter().find(|delivered| delivered.flow == flow.id).map(|delivered| (capability, delivered.role)))
            .collect()
    }

    pub(crate) fn of_flow(&self, flow: &Flow) -> String {
        let mut lines = vec![format!("{} ({}): {}", flow.name.as_deref().unwrap_or(&flow.operation), self.name_of(home(flow).unwrap_or_default()), flow.description.as_deref().unwrap_or_default())];
        if !flow.steps.is_empty() {
            lines.push(format!("its steps: {}", steps_of(flow)));
        }
        for (capability, role) in self.tied(flow) {
            let how = if role == "primary" { "delivers" } else { "supports" };
            lines.push(format!("it {how} the part's capability {} ({}): {}", capability.name.as_deref().unwrap_or_default(), weighed(capability), capability.description.as_deref().unwrap_or_default()));
        }
        if !flow.writes.is_empty() {
            lines.push(format!("it keeps: {}", self.records_of(&flow.writes)));
        }
        if !flow.reads.is_empty() {
            lines.push(format!("it reads: {}", self.records_of(&flow.reads)));
        }
        lines.join("\n    ")
    }

    pub(crate) fn told(&self) -> String {
        let mut parts: Vec<&str> = self.capabilities.iter().filter(|capability| capability.level == PART).filter_map(|capability| capability.project.as_deref()).collect();
        parts.extend(self.flows.iter().filter_map(home));
        parts.sort_unstable();
        parts.dedup();
        let mut told: Vec<String> = parts.iter().map(|part| self.of_part(part)).collect();
        let mut seams: Vec<String> = self
            .seams
            .iter()
            .map(|seam| format!("- {} hands on to {} by {} carrying {}", self.name_of(&seam.from), self.name_of(&seam.to), seam.by, seam.carries))
            .collect();
        seams.sort();
        seams.dedup();
        if !seams.is_empty() {
            told.push(format!("How the parts hand on to each other:\n{}", seams.join("\n")));
        }
        told.join("\n\n")
    }

    fn of_part(&self, part: &str) -> String {
        let role = self.roles.get(part).copied().unwrap_or("part");
        let weight = if crate::journeys::TOOLING.contains(&role) { "low weight: it serves the people who build and run the system" } else { "full weight" };
        let mut lines = vec![format!("Part {} ({role}, {weight})", self.name_of(part))];
        let capabilities: Vec<&Capability> = self.capabilities.iter().filter(|capability| capability.level == PART && capability.project.as_deref() == Some(part)).collect();
        if !capabilities.is_empty() {
            lines.push("Its capabilities:".to_string());
        }
        for capability in capabilities {
            let mut said = format!("- {} ({}): {}", capability.name.as_deref().unwrap_or_default(), weighed(capability), capability.description.as_deref().unwrap_or_default());
            let kept: Vec<String> = capability.records.clone();
            let read: Vec<String> = capability.touches.iter().filter(|named| !kept.contains(named)).cloned().collect();
            if !kept.is_empty() {
                said.push_str(&format!("; keeps {}", self.records_of(&kept)));
            }
            if !read.is_empty() {
                said.push_str(&format!("; reads {}", self.records_of(&read)));
            }
            lines.push(said);
        }
        let flows: Vec<&Flow> = self.flows.iter().filter(|flow| home(flow) == Some(part)).collect();
        if !flows.is_empty() {
            lines.push("Its flows:".to_string());
        }
        for flow in flows {
            let ties: Vec<String> = self
                .tied(flow)
                .into_iter()
                .map(|(capability, role)| format!("{} {}", if role == "primary" { "delivers" } else { "supports" }, capability.name.as_deref().unwrap_or_default()))
                .collect();
            let mut said = format!("- {}: {}", flow.name.as_deref().unwrap_or(&flow.operation), flow.description.as_deref().unwrap_or_default());
            if !flow.steps.is_empty() {
                said.push_str(&format!(" | steps: {}", steps_of(flow)));
            }
            if !ties.is_empty() {
                said.push_str(&format!(" | {}", ties.join("; ")));
            }
            lines.push(said);
        }
        let records: Vec<&Entity> = self.entities.iter().filter(|entity| entity.project.as_deref() == Some(part)).collect();
        if !records.is_empty() {
            lines.push("Its records:".to_string());
        }
        for entity in records {
            lines.push(format!(
                "- {}{}: {}",
                entity.name.as_deref().unwrap_or(&entity.declared_as),
                entity.standing.map(|standing| format!(" ({standing})")).unwrap_or_default(),
                entity.description.as_deref().unwrap_or_default()
            ));
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ties::tests::{capability, entity, flow};

    fn step(id: &str, said: &str) -> crate::steps::LogicalStep {
        crate::steps::LogicalStep { id: id.to_string(), kind: "do", label: id.to_string(), object: None, doing: None, when: "always", arms: Vec::new(), regions: Vec::new(), description: Some(said.to_string()), lands_in: Vec::new(), gathers: Vec::new() }
    }

    #[test]
    fn every_child_is_told_with_its_whole_layer_and_its_weight() {
        let mut checkout = flow("checkout", "subproject:shop", "shop/Checkout.cs:function:Pay");
        checkout.name = Some("Pay for an order".to_string());
        checkout.description = Some("The order is paid.".to_string());
        checkout.steps = vec![step("s1", "Check the basket"), step("s2", "Charge the card")];
        checkout.writes = vec!["Order".to_string()];
        let mut pay = capability("capability:shop:place-orders", "subproject:shop", &[("checkout", "primary")], &["Order"], &["Order", "Product"], &[]);
        pay.name = Some("Place orders".to_string());
        pay.description = Some("Shoppers buy what is in their basket.".to_string());
        pay.value = Some(crate::value::Value { own: 1.0, centrality: 1.0, position: 1.0, impact: 1.0, share: 0.6 });
        let mut order = entity("Order", "subproject:shop");
        order.description = Some("What a shopper bought.".to_string());
        let names = HashMap::from_iter([("subproject:shop".to_string(), "Shop".to_string()), ("subproject:tests".to_string(), "Tests".to_string())]);
        let roles = HashMap::from_iter([("subproject:shop".to_string(), "app"), ("subproject:tests".to_string(), "test suite")]);
        let checked = flow("check", "subproject:tests", "tests/Check.cs:function:Run");
        let flows = vec![checkout, checked];
        let children = Children { capabilities: &[pay], flows: &flows, entities: &[order], seams: &[], names: &names, roles: &roles };
        let told = children.told();
        assert!(told.contains("Part Shop (app, full weight)"), "{told}");
        assert!(told.contains("- Place orders (60% of its part's value): Shoppers buy what is in their basket.; keeps Order; reads Product"), "{told}");
        assert!(told.contains("- Pay for an order: The order is paid. | steps: Check the basket; Charge the card | delivers Place orders"), "{told}");
        assert!(told.contains("- Order: What a shopper bought."), "{told}");
        assert!(told.contains("Part Tests (test suite, low weight"), "{told}");
        let one = children.of_flow(&flows[0]);
        assert!(one.contains("its steps: Check the basket; Charge the card"), "{one}");
        assert!(one.contains("it delivers the part's capability Place orders (60% of its part's value)"), "{one}");
        assert!(one.contains("it keeps: Order"), "{one}");
    }
}

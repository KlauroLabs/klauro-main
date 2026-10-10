use rustc_hash::FxHashMap as HashMap;

use crate::capabilities::PART;
use crate::comprehend::{Capability, Entity, Flow};

pub(crate) struct Children<'a> {
    pub capabilities: &'a [Capability],
    pub entities: &'a [Entity],
    pub names: &'a HashMap<String, String>,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ties::tests::{capability, entity, flow};

    fn step(id: &str, said: &str) -> crate::steps::LogicalStep {
        crate::steps::LogicalStep { id: id.to_string(), kind: "do", label: id.to_string(), object: None, doing: None, when: "always", arms: Vec::new(), regions: Vec::new(), description: Some(said.to_string()), lands_in: Vec::new(), gathers: Vec::new() }
    }

    #[test]
    fn a_part_flow_is_told_with_its_steps_what_it_delivers_and_what_it_keeps() {
        let mut checkout = flow("checkout", "subproject:shop", "shop/Checkout.cs:function:Pay");
        checkout.name = Some("Pay for an order".to_string());
        checkout.description = Some("The order is paid.".to_string());
        checkout.steps = vec![step("s1", "Check the basket"), step("s2", "Charge the card")];
        checkout.writes = vec!["Order".to_string()];
        let mut pay = capability("capability:shop:place-orders", "subproject:shop", &[("checkout", "primary")], &["Order"], &["Order"], &[]);
        pay.name = Some("Place orders".to_string());
        pay.description = Some("Shoppers buy what is in their basket.".to_string());
        pay.value = Some(crate::value::Value { own: 1.0, centrality: 1.0, position: 1.0, impact: 1.0, share: 0.6 });
        let names = HashMap::from_iter([("subproject:shop".to_string(), "Shop".to_string())]);
        let children = Children { capabilities: &[pay], entities: &[entity("Order", "subproject:shop")], names: &names };
        let told = children.of_flow(&checkout);
        assert!(told.starts_with("Pay for an order (Shop): The order is paid."), "{told}");
        assert!(told.contains("its steps: Check the basket; Charge the card"), "{told}");
        assert!(told.contains("it delivers the part's capability Place orders (60% of its part's value): Shoppers buy what is in their basket."), "{told}");
        assert!(told.contains("it keeps: Order"), "{told}");
    }
}

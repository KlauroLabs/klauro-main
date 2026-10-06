use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use crate::author::Written;
use crate::comprehend::{Capability, Comprehension, Flow};

const PRIMARY_PATHS_TOLD: usize = 4;
const SERVED_PATHS_TOLD: usize = 120;

pub(crate) struct Paths<'a> {
    spoken: &'a str,
    context: String,
    claimed: Mutex<HashSet<String>>,
    said: Mutex<BTreeMap<String, Written>>,
    unanswered: Mutex<Vec<String>>,
}

fn served_by_steps<'a>(flows: impl Iterator<Item = &'a Flow>) -> Vec<&'a Flow> {
    let mut served: Vec<&Flow> = flows
        .filter(|flow| !matches!(flow.kind, "export" | "test") && !flow.steps.is_empty())
        .collect();
    served.sort_by_key(|flow| (std::cmp::Reverse(flow.steps.len()), flow.id.clone()));
    served
}

impl<'a> Paths<'a> {
    pub(crate) fn new(spoken: &'a str) -> Self {
        Paths {
            spoken,
            context: format!("{spoken}\u{1}{}", crate::author::NAMING),
            claimed: Mutex::default(),
            said: Mutex::default(),
            unanswered: Mutex::default(),
        }
    }

    fn tell(&self, flows: &[&Flow]) {
        let told: Vec<(String, String)> = {
            let Ok(mut claimed) = self.claimed.lock() else { return };
            flows
                .iter()
                .filter(|flow| !flow.steps.is_empty() && claimed.insert(flow.id.clone()))
                .map(|flow| {
                    (
                        flow.id.clone(),
                        format!(
                            "  reached through: {}\n  steps: {}",
                            crate::capabilities::surface_of(flow),
                            crate::capabilities::told_steps(flow)
                        ),
                    )
                })
                .collect()
        };
        if told.is_empty() {
            return;
        }
        let mut unanswered: Vec<String> = Vec::new();
        let said = crate::memory::each("what happens, named", &self.context, &told, |missing| {
            let written = crate::author::what_happens(self.spoken, missing);
            unanswered.extend(missing.iter().map(|(id, _)| id.clone()).filter(|id| !written.contains_key(id)));
            let evidence: BTreeMap<String, String> = missing.iter().cloned().collect();
            let grounded = crate::author::ground(&written, &evidence);
            written
                .into_iter()
                .filter(|(id, _)| grounded.get(id).is_some_and(|grounding| grounding.holds()))
                .collect()
        });
        if let Ok(mut held) = self.said.lock() {
            held.extend(said);
        }
        if let Ok(mut held) = self.unanswered.lock() {
            held.extend(unanswered);
        }
    }

    pub(crate) fn tell_the_busiest(&self, flows: &[Flow]) {
        let busiest: Vec<&Flow> = served_by_steps(flows.iter()).into_iter().take(SERVED_PATHS_TOLD).collect();
        self.tell(&busiest);
    }

    pub(crate) fn tell_what_delivers(&self, capabilities: &[Capability], flows: &[Flow]) {
        let delivered: HashSet<&str> = primary_paths(capabilities).collect();
        let chosen: Vec<&Flow> = flows.iter().filter(|flow| delivered.contains(flow.id.as_str())).collect();
        self.tell(&chosen);
    }

    pub(crate) fn settle(self, held: &mut Comprehension) {
        let asked_for: Option<Vec<String>> = std::env::var("KLAURO_DESCRIBE_FLOWS")
            .ok()
            .filter(|held| !held.is_empty())
            .map(|held| held.split(',').map(|id| id.trim().to_string()).collect());
        let everything = asked_for.as_ref().is_some_and(|ids| ids.iter().any(|id| id == "all"));
        let mut chosen: HashSet<String> = HashSet::default();
        match (&asked_for, everything) {
            (Some(ids), false) => chosen.extend(ids.iter().cloned()),
            (_, true) => chosen.extend(held.flows.iter().filter(|flow| !flow.steps.is_empty()).map(|flow| flow.id.clone())),
            (None, _) => {
                chosen.extend(primary_paths(held.capabilities.iter()).map(str::to_string));
                let unchosen = held.flows.iter().filter(|flow| !chosen.contains(&flow.id));
                let busiest: Vec<String> =
                    served_by_steps(unchosen).into_iter().take(SERVED_PATHS_TOLD).map(|flow| flow.id.clone()).collect();
                chosen.extend(busiest);
            }
        }
        let wanted: Vec<&Flow> = held.flows.iter().filter(|flow| chosen.contains(&flow.id)).collect();
        self.tell(&wanted);
        let said = self.said.into_inner().unwrap_or_default();
        let unanswered = self.unanswered.into_inner().unwrap_or_default();
        for flow in held.flows.iter_mut() {
            if let Some(written) = said.get(&flow.id).filter(|_| chosen.contains(&flow.id)) {
                flow.description = Some(written.description.clone());
                if !written.name.is_empty() {
                    flow.name = Some(written.name.clone());
                }
            } else if chosen.contains(&flow.id) && unanswered.contains(&flow.id) {
                flow.unsettled = Some(crate::confidence::AI_UNANSWERED);
                flow.confidence = crate::confidence::left_unsettled(flow.confidence);
            }
        }
    }
}

fn primary_paths<'a>(capabilities: impl IntoIterator<Item = &'a Capability>) -> impl Iterator<Item = &'a str> {
    capabilities
        .into_iter()
        .filter(|capability| capability.project.is_some())
        .flat_map(|capability| {
            capability
                .delivered
                .iter()
                .filter(|delivery| delivery.role == "primary")
                .take(PRIMARY_PATHS_TOLD)
                .map(|delivery| delivery.flow.as_str())
        })
}

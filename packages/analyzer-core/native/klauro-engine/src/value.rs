use std::collections::BTreeMap;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::comprehend::Capability;

const GIVES_ON_ITS_OWN: f64 = 0.5;
const TAIL: f64 = 0.25;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Value {
    pub own: f64,
    pub centrality: f64,
    pub position: f64,
    pub impact: f64,
    pub share: f64,
}

pub(crate) const OWN_VALUE_ASKED: &str = "Would the person be glad to have done only \"{name}\" ({outcome}), because it gives them a result they care about \
(seeing or changing their money, goods, content or information), or does its result only make something else possible \
(signing in or out, connecting, verifying, generating links or tokens, checking a status, changing settings)?";
pub(crate) const GIVES: &str = "it gives a result the person cares about by itself";
pub(crate) const ONLY_ENABLES: &str = "its result only makes something else possible";
const CLOSER_ASKED: &str = "Which of these is closer to the reason this product exists: the result people come to it for, rather than something that supports, configures or follows that result?";

fn told(capability: &Capability) -> (String, String) {
    (capability.name.clone().unwrap_or_default(), capability.description.clone().unwrap_or_default())
}

pub(crate) fn own_value_question(name: &str, outcome: &str) -> String {
    OWN_VALUE_ASKED.replace("{name}", name).replace("{outcome}", outcome)
}

fn noul(instructions: String, yes: String, no: String) -> crate::jev::Question {
    crate::jev::Question { kind: "noul", instructions, criteria: BTreeMap::from([("true".to_string(), yes), ("false".to_string(), no)]).into() }
}

fn choice(first: String, second: String) -> crate::jev::Question {
    crate::jev::Question { kind: "choice", instructions: CLOSER_ASKED.to_string(), criteria: BTreeMap::from([("first".to_string(), first), ("second".to_string(), second)]).into() }
}

pub(crate) fn position_of(before: &BTreeMap<(usize, usize), f64>, count: usize) -> Vec<f64> {
    let net: Vec<f64> = (0..count)
        .map(|at| (0..count).filter(|other| *other != at).map(|other| before.get(&(other, at)).copied().unwrap_or(0.0) - before.get(&(at, other)).copied().unwrap_or(0.0)).sum())
        .collect();
    let lowest = net.iter().copied().fold(f64::INFINITY, f64::min);
    let highest = net.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let spread = highest - lowest;
    net.iter().map(|held| if spread > 0.0 { (held - lowest) / spread } else { 1.0 }).collect()
}

pub(crate) fn centrality_of(closer: &BTreeMap<(usize, usize), f64>, count: usize) -> Vec<f64> {
    if count < 2 {
        return vec![1.0; count];
    }
    (0..count)
        .map(|at| (0..count).filter(|other| *other != at).map(|other| (closer.get(&(at, other)).copied().unwrap_or(0.0) + 1.0 - closer.get(&(other, at)).copied().unwrap_or(1.0)) / 2.0).sum::<f64>() / (count - 1) as f64)
        .collect()
}

pub(crate) fn places(values: &[Value]) -> Vec<&'static str> {
    let mut giving: Vec<usize> = (0..values.len()).filter(|at| values[*at].own >= GIVES_ON_ITS_OWN).collect();
    giving.sort_by(|left, right| values[*right].position.total_cmp(&values[*left].position));
    let tail = (giving.len() as f64 * TAIL).ceil() as usize;
    let mut placed = vec!["supporting"; values.len()];
    for (rank, at) in giving.into_iter().enumerate() {
        placed[at] = if rank < tail { "terminal" } else { "proximal" };
    }
    placed
}

pub(crate) fn valued(own: &[f64], centrality: &[f64], position: &[f64]) -> Vec<Value> {
    let impacts: Vec<f64> = (0..own.len()).map(|at| own[at] * (centrality[at] + position[at]) / 2.0).collect();
    let total: f64 = impacts.iter().sum();
    (0..own.len())
        .map(|at| Value { own: own[at], centrality: centrality[at], position: position[at], impact: impacts[at], share: if total > 0.0 { impacts[at] / total } else { 0.0 } })
        .collect()
}

fn rounded(held: f64) -> f64 {
    (held * 1000.0).round() / 1000.0
}

pub(crate) fn weigh(capabilities: &mut [Capability], said: &str) {
    let count = capabilities.len();
    if count == 0 || !crate::jev::asked() || !crate::author::asked() {
        return;
    }
    let listed: Vec<(String, String)> = capabilities.iter().map(told).collect();
    let state = format!("{said}\n\nEverything it lets people do:\n{}", listed.iter().map(|(name, outcome)| format!("- {name}: {outcome}")).collect::<Vec<_>>().join("\n"));
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    for (at, (name, outcome)) in listed.iter().enumerate() {
        questions.insert(format!("own_{at}"), noul(own_value_question(name, outcome), GIVES.to_string(), ONLY_ENABLES.to_string()));
    }
    for first in 0..count {
        for second in (0..count).filter(|second| *second != first) {
            let (earlier, earlier_does) = &listed[first];
            let (later, later_does) = &listed[second];
            questions.insert(
                format!("before_{first}_{second}"),
                noul(
                    format!("Before someone does \"{later}\" ({later_does}), must or would they first have done \"{earlier}\" ({earlier_does}), because it needs it or because they decide based on it?"),
                    format!("\"{earlier}\" comes before \"{later}\""),
                    "it does not need to come first".to_string(),
                ),
            );
            questions.insert(format!("closer_{first}_{second}"), choice(format!("{earlier}: {earlier_does}"), format!("{later}: {later_does}")));
        }
    }
    let asked = questions.len();
    let (decided, judged) = rayon::join(
        || crate::jev::decide(&state, questions),
        || listed.par_iter().map(|(name, outcome)| crate::author::gives_on_its_own(said, &own_value_question(name, outcome), GIVES, ONLY_ENABLES)).collect::<Vec<Option<bool>>>(),
    );
    if decided.len() < asked || judged.iter().any(Option::is_none) {
        eprintln!("  value not weighed: {} of {asked} decisions and {} of {count} own-value answers came back", decided.len(), judged.iter().flatten().count());
        return;
    }
    let pair = |prefix: &str, read: &dyn Fn(&crate::jev::Decision) -> f64| -> BTreeMap<(usize, usize), f64> {
        let mut held = BTreeMap::new();
        for first in 0..count {
            for second in (0..count).filter(|second| *second != first) {
                if let Some(decision) = decided.get(&format!("{prefix}_{first}_{second}")) {
                    held.insert((first, second), read(decision));
                }
            }
        }
        held
    };
    let before = pair("before", &|decision| decision.noul.unwrap_or(0.0));
    let closer = pair("closer", &|decision| decision.probabilities.as_ref().and_then(|held| held.get("first").copied()).unwrap_or(match decision.choice.as_deref() {
        Some("first") => 1.0,
        Some("second") => 0.0,
        _ => 0.5,
    }));
    let own: Vec<f64> = (0..count)
        .map(|at| (decided.get(&format!("own_{at}")).and_then(|decision| decision.noul).unwrap_or(0.0) + if judged[at] == Some(true) { 1.0 } else { 0.0 }) / 2.0)
        .collect();
    let values = valued(&own, &centrality_of(&closer, count), &position_of(&before, count));
    let placed = places(&values);
    for ((capability, value), place) in capabilities.iter_mut().zip(values).zip(placed) {
        capability.place = Some(place);
        capability.value = Some(Value { own: rounded(value.own), centrality: rounded(value.centrality), position: rounded(value.position), impact: rounded(value.impact), share: rounded(value.share) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(held: &[((usize, usize), f64)]) -> BTreeMap<(usize, usize), f64> {
        held.iter().copied().collect()
    }

    #[test]
    fn what_everything_else_comes_before_sits_at_the_end_of_the_chain() {
        let before = pairs(&[((0, 1), 0.9), ((1, 0), 0.1), ((1, 2), 0.9), ((2, 1), 0.1), ((0, 2), 0.9), ((2, 0), 0.1)]);
        assert_eq!(position_of(&before, 3), vec![0.0, 0.5, 1.0]);
    }

    #[test]
    fn the_capability_chosen_over_every_other_is_the_most_central() {
        let closer = pairs(&[((0, 1), 0.0), ((1, 0), 1.0), ((0, 2), 0.0), ((2, 0), 1.0), ((1, 2), 1.0), ((2, 1), 0.0)]);
        let held = centrality_of(&closer, 3);
        assert_eq!(held, vec![0.0, 1.0, 0.5]);
    }

    #[test]
    fn a_lone_capability_is_wholly_central_and_at_the_end_of_its_chain() {
        assert_eq!(centrality_of(&BTreeMap::new(), 1), vec![1.0]);
        assert_eq!(position_of(&BTreeMap::new(), 1), vec![1.0]);
    }

    #[test]
    fn what_gives_nothing_on_its_own_is_supporting_and_the_tail_of_the_rest_is_terminal() {
        let values = valued(&[0.1, 0.9, 0.9, 0.9, 0.9], &[0.2, 0.9, 0.5, 0.4, 0.3], &[1.0, 0.9, 0.6, 0.3, 0.1]);
        assert_eq!(places(&values), ["supporting", "terminal", "proximal", "proximal", "proximal"]);
    }

    #[test]
    fn value_impact_is_own_value_times_centrality_and_chain_position_and_shares_sum_to_one() {
        let values = valued(&[1.0, 0.5, 0.0], &[1.0, 0.5, 1.0], &[1.0, 0.5, 1.0]);
        assert_eq!(values.iter().map(|value| value.impact).collect::<Vec<_>>(), vec![1.0, 0.25, 0.0]);
        assert!((values.iter().map(|value| value.share).sum::<f64>() - 1.0).abs() < 1e-9);
        assert_eq!(values[0].share, 0.8);
    }
}

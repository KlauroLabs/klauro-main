use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::comprehend::Capability;

const GIVES_ON_ITS_OWN: f64 = 0.5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Value {
    pub own: f64,
    pub centrality: f64,
    pub position: f64,
    pub impact: f64,
    pub share: f64,
}

pub(crate) const OWN_VALUE_ASKED: &str = "Would whoever uses \"{name}\" ({outcome}), a person or another system that works with this one, \
be glad to have done only this, because it gives them a result they care about for its own sake (getting, seeing or changing their money, goods, \
content or information, getting help, or being told that something happened to them or their things), or does its result only make something else possible \
(signing in or out, verifying, generating links or tokens, checking a status, changing settings, installing or setting up the product)?";
pub(crate) const GIVES: &str = "it gives a result its user cares about by itself";
pub(crate) const ONLY_ENABLES: &str = "its result only makes something else possible";
const CLOSER_ASKED: &str = "Which of these is closer to the reason this product exists: the result people come to it for, rather than something that supports, configures or follows that result?";

fn told(capability: &Capability) -> (String, String) {
    (capability.name.clone().unwrap_or_default(), capability.description.clone().unwrap_or_default())
}

fn noul(instructions: String, yes: String, no: String) -> crate::jev::Question {
    crate::jev::Question { kind: "noul", instructions, criteria: BTreeMap::from([("true".to_string(), yes), ("false".to_string(), no)]).into() }
}

const TOWARD_ASKED: &str = "Each question names an earlier and a later thing people do with this product. Answer true when people do the earlier one to prepare for or decide on the later one, because the later one is what they are working toward. Answer false when the later one only looks at, reports on, undoes or follows up what the earlier one already gave them.";

fn choice(first: String, second: String) -> crate::jev::Question {
    crate::jev::Question { kind: "choice", instructions: "Which of these two?".to_string(), criteria: BTreeMap::from([("first".to_string(), first), ("second".to_string(), second)]).into() }
}

const ALL_PAIRS_UP_TO: usize = 16;

fn closeness(left: &str, right: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let (low, high) = if left <= right { (left, right) } else { (right, left) };
    let mut hasher = rustc_hash::FxHasher::default();
    low.hash(&mut hasher);
    high.hash(&mut hasher);
    hasher.finish()
}

pub(crate) fn compared(keys: &[String]) -> Vec<(usize, usize)> {
    let count = keys.len();
    let mut held: std::collections::BTreeSet<(usize, usize)> = std::collections::BTreeSet::new();
    if count <= ALL_PAIRS_UP_TO {
        for first in 0..count {
            for second in (0..count).filter(|second| *second != first) {
                held.insert((first, second));
            }
        }
        return held.into_iter().collect();
    }
    let partners = 2 * (usize::BITS - (count - 1).leading_zeros()) as usize;
    for first in 0..count {
        let mut others: Vec<usize> = (0..count).filter(|second| *second != first).collect();
        others.sort_by_key(|second| (closeness(&keys[first], &keys[*second]), *second));
        for second in others.into_iter().take(partners) {
            held.insert((first, second));
            held.insert((second, first));
        }
    }
    held.into_iter().collect()
}

pub(crate) fn position_of(toward: &BTreeMap<(usize, usize), f64>, count: usize) -> Vec<f64> {
    let mut net = vec![0.0; count];
    let mut seen = vec![0usize; count];
    for ((earlier, later), held) in toward {
        net[*later] += held;
        net[*earlier] -= held;
        seen[*later] += 1;
        seen[*earlier] += 1;
    }
    let net: Vec<f64> = (0..count).map(|at| if seen[at] > 0 { net[at] * 2.0 / seen[at] as f64 } else { 0.0 }).collect();
    let lowest = net.iter().copied().fold(f64::INFINITY, f64::min);
    let highest = net.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let spread = highest - lowest;
    net.iter().map(|held| if spread > 0.0 { (held - lowest) / spread } else { 1.0 }).collect()
}

pub(crate) fn centrality_of(closer: &BTreeMap<(usize, usize), f64>, count: usize) -> Vec<f64> {
    if count < 2 {
        return vec![1.0; count];
    }
    let mut won = vec![0.0; count];
    let mut seen = vec![0usize; count];
    for ((first, second), held) in closer {
        won[*first] += held;
        won[*second] += 1.0 - held;
        seen[*first] += 1;
        seen[*second] += 1;
    }
    (0..count).map(|at| if seen[at] > 0 { won[at] / seen[at] as f64 } else { 0.5 }).collect()
}

pub(crate) fn supporting(decided: f64, judged: bool) -> bool {
    decided < GIVES_ON_ITS_OWN && !judged
}

pub(crate) fn valued(own: &[f64], centrality: &[f64], position: &[f64]) -> Vec<Value> {
    let impacts: Vec<f64> = (0..own.len()).map(|at| own[at] * centrality[at] * (1.0 + position[at]) / 2.0).collect();
    let total: f64 = impacts.iter().sum();
    (0..own.len())
        .map(|at| Value { own: own[at], centrality: centrality[at], position: position[at], impact: impacts[at], share: if total > 0.0 { impacts[at] / total } else { 0.0 } })
        .collect()
}

fn rounded(held: f64) -> f64 {
    (held * 1000.0).round() / 1000.0
}

fn judged_on_their_own(said: &str, scope: &str, listed: &[(String, String)]) -> Vec<Option<bool>> {
    let items: Vec<(String, String)> = listed.iter().map(|(name, outcome)| (format!("{name}\u{1}{outcome}"), format!("{name}\u{1}{outcome}"))).collect();
    let question = OWN_VALUE_ASKED.replace("\"{name}\" ({outcome})", "the numbered capability");
    let answered: BTreeMap<String, bool> = crate::memory::each("gives on its own", &format!("{scope}\u{1}{question}"), &items, |missing| {
        let asked: Vec<(String, String)> = missing.iter().filter_map(|(key, _)| key.split_once('\u{1}').map(|(name, outcome)| (name.to_string(), outcome.to_string()))).collect();
        let judged = crate::author::give_on_their_own(said, &asked, &question, GIVES, ONLY_ENABLES);
        missing.iter().zip(judged).filter_map(|((key, _), gave)| Some((key.clone(), gave?))).collect()
    });
    items.iter().map(|(key, _)| answered.get(key).copied()).collect()
}

pub(crate) fn weigh(capabilities: &mut [Capability], said: &str) {
    let count = capabilities.len();
    if count == 0 || !crate::author::asked() {
        return;
    }
    if !crate::jev::able() {
        eprintln!("  value not weighed: neither the decision model nor the writer is configured");
        return;
    }
    let listed: Vec<(String, String)> = capabilities.iter().map(told).collect();
    let scope = crate::capabilities::scope_of(capabilities);
    let mut owning: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    for (at, (name, outcome)) in listed.iter().enumerate() {
        owning.insert(format!("own_{at}"), noul(format!("\"{name}\" ({outcome})"), GIVES.to_string(), ONLY_ENABLES.to_string()));
    }
    let keys: Vec<String> = capabilities.iter().map(|capability| capability.id.clone()).collect();
    let pairs = compared(&keys);
    let mut toward_of: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    let mut closer_of: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    for (first, second) in pairs.iter().copied() {
        let (earlier, earlier_does) = &listed[first];
        let (later, later_does) = &listed[second];
        toward_of.insert(
            format!("toward_{first}_{second}"),
            noul(format!("Earlier: \"{earlier}\" ({earlier_does})\nLater: \"{later}\" ({later_does})"), "the earlier is done working toward the later".to_string(), "the later is not what the earlier works toward".to_string()),
        );
        closer_of.insert(format!("closer_{first}_{second}"), choice(format!("{earlier}: {earlier_does}"), format!("{later}: {later_does}")));
    }
    let brief = crate::jev::brief(said);
    let own_state = format!("{brief}\n\n{}", OWN_VALUE_ASKED.replace("\"{name}\" ({outcome})", "the capability named in each question"));
    let toward_state = format!("{brief}\n\n{TOWARD_ASKED}");
    let closer_state = format!("{brief}\n\n{CLOSER_ASKED}");
    let asked = owning.len() + toward_of.len() + closer_of.len();
    let deciding = || {
        let ((own, toward), closer) = rayon::join(
            || rayon::join(|| crate::jev::decide_remembered(&scope, &own_state, owning), || crate::jev::decide_remembered(&scope, &toward_state, toward_of)),
            || crate::jev::decide_remembered(&scope, &closer_state, closer_of),
        );
        own.into_iter().chain(toward).chain(closer).collect::<BTreeMap<String, crate::jev::Decision>>()
    };
    let (decided, judged) = rayon::join(
        deciding,
        || judged_on_their_own(said, &scope, &listed),
    );
    if decided.len() < asked || judged.iter().any(Option::is_none) {
        eprintln!("  value not weighed: {} of {asked} decisions and {} of {count} own-value answers came back", decided.len(), judged.iter().flatten().count());
        return;
    }
    let pair = |prefix: &str, read: &dyn Fn(&crate::jev::Decision) -> f64| -> BTreeMap<(usize, usize), f64> {
        let mut held = BTreeMap::new();
        for (first, second) in pairs.iter().copied() {
            if let Some(decision) = decided.get(&format!("{prefix}_{first}_{second}")) {
                held.insert((first, second), read(decision));
            }
        }
        held
    };
    let toward = pair("toward", &|decision| decision.noul.unwrap_or(0.0));
    let closer = pair("closer", &|decision| decision.probabilities.as_ref().and_then(|held| held.get("first").copied()).unwrap_or(match decision.choice.as_deref() {
        Some("first") => 1.0,
        Some("second") => 0.0,
        _ => 0.5,
    }));
    let gives: Vec<f64> = (0..count).map(|at| decided.get(&format!("own_{at}")).and_then(|decision| decision.noul).unwrap_or(0.0)).collect();
    let judged: Vec<bool> = judged.into_iter().map(|answer| answer == Some(true)).collect();
    let own: Vec<f64> = (0..count).map(|at| (gives[at] + if judged[at] { 1.0 } else { 0.0 }) / 2.0).collect();
    let values = valued(&own, &centrality_of(&closer, count), &position_of(&toward, count));
    for (at, (capability, value)) in capabilities.iter_mut().zip(values).enumerate() {
        capability.supporting = supporting(gives[at], judged[at]);
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
    fn what_everything_else_is_done_on_the_way_to_sits_at_the_end_of_the_chain() {
        let toward = pairs(&[((0, 1), 0.9), ((1, 0), 0.1), ((1, 2), 0.9), ((2, 1), 0.1), ((0, 2), 0.9), ((2, 0), 0.1)]);
        assert_eq!(position_of(&toward, 3), vec![0.0, 0.5, 1.0]);
    }

    #[test]
    fn the_capability_chosen_over_every_other_is_the_most_central() {
        let closer = pairs(&[((0, 1), 0.0), ((1, 0), 1.0), ((0, 2), 0.0), ((2, 0), 1.0), ((1, 2), 1.0), ((2, 1), 0.0)]);
        let held = centrality_of(&closer, 3);
        assert_eq!(held, vec![0.0, 1.0, 0.5]);
    }

    #[test]
    fn a_long_list_is_compared_with_a_few_stable_partners_each_and_a_newcomer_moves_only_its_own_pairs() {
        let keys: Vec<String> = (0..600).map(|at| format!("capability:part:{at}")).collect();
        assert_eq!(compared(&keys[..3]).len(), 6, "a short list compares every ordered pair");
        let held = compared(&keys);
        assert!(held.len() <= 2 * 600 * 20, "{} questions", held.len());
        let mut reached = std::collections::BTreeSet::from([0usize]);
        let mut frontier = vec![0usize];
        while let Some(at) = frontier.pop() {
            for (first, second) in &held {
                if *first == at && reached.insert(*second) {
                    frontier.push(*second);
                }
            }
        }
        assert_eq!(reached.len(), 600, "every capability is ranked against the rest");
        let named = |pairs: &[(usize, usize)], keys: &[String]| -> std::collections::BTreeSet<(String, String)> { pairs.iter().map(|(first, second)| (keys[*first].clone(), keys[*second].clone())).collect() };
        let before = named(&held, &keys);
        let mut grown = keys.clone();
        grown.insert(300, "capability:part:newcomer".to_string());
        let after = named(&compared(&grown), &grown);
        let kept = before.intersection(&after).count();
        assert!(kept * 100 >= before.len() * 95, "{kept} of {} pairs kept", before.len());
    }

    #[test]
    fn a_lone_capability_is_wholly_central_and_at_the_end_of_its_chain() {
        assert_eq!(centrality_of(&BTreeMap::new(), 1), vec![1.0]);
        assert_eq!(position_of(&BTreeMap::new(), 1), vec![1.0]);
    }

    #[test]
    fn a_capability_is_supporting_only_when_both_judges_find_it_gives_nothing_on_its_own() {
        assert!(supporting(0.2, false));
        assert!(!supporting(0.2, true), "one judge finding a result of its own keeps the capability");
        assert!(!supporting(0.7, false), "one judge finding a result of its own keeps the capability");
        assert!(!supporting(0.9, true));
    }

    #[test]
    fn value_impact_is_own_value_times_centrality_raised_by_chain_position_and_shares_sum_to_one() {
        let values = valued(&[1.0, 0.5, 0.0], &[1.0, 0.5, 1.0], &[1.0, 0.0, 1.0]);
        assert_eq!(values.iter().map(|value| value.impact).collect::<Vec<_>>(), vec![1.0, 0.125, 0.0]);
        assert!((values.iter().map(|value| value.share).sum::<f64>() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn what_follows_the_goal_never_outweighs_the_goal_for_coming_last() {
        let values = valued(&[0.95, 0.93], &[0.98, 0.41], &[0.36, 1.0]);
        assert!(values[0].impact > values[1].impact, "placing an order matters more than cancelling one, though cancelling comes after");
    }
}

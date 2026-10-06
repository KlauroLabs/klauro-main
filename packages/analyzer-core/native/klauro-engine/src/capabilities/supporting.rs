use std::collections::{BTreeMap, BTreeSet};

use crate::author::Serving;
use crate::comprehend::{Family, Flow};

use super::{evidence_of, kept_for_itself, outcome_of, place, unseated, Fields, Held, PLACING_ROUNDS};

pub(super) struct Lane<'a> {
    pub(super) id: String,
    pub(super) family: Family,
    pub(super) flows: Vec<&'a Flow>,
}

pub(super) struct Related<'a> {
    pub(super) lanes: Vec<Lane<'a>>,
    pub(super) unplaced: Vec<&'a Flow>,
}

const SHARED_NAMED: usize = 3;

fn tokens_of(flow: &Flow) -> BTreeSet<String> {
    let mut tokens: BTreeSet<String> = BTreeSet::new();
    for record in flow.writes.iter().chain(&flow.reads).chain(&flow.reaches).chain(&flow.changes) {
        tokens.insert(format!("record:{record}"));
    }
    for step in &flow.path {
        tokens.insert(format!("unit:{}", step.unit));
    }
    if let Some((file, _)) = flow.entry_point.split_once(':') {
        tokens.insert(format!("file:{file}"));
    }
    tokens
}

fn role_of(flow: &Flow) -> &'static str {
    match flow.kind {
        "schedule" | "lifecycle" => "operational",
        _ => "supporting",
    }
}

fn said_of(token: &str) -> &str {
    let named = token.split_once(':').map_or(token, |(_, named)| named);
    named.rsplit(['/', ':']).next().unwrap_or(named)
}

fn set_aside_note(flows: &[&Flow]) -> String {
    let tags: Vec<&crate::entry_exit::Unshipped> =
        flows.iter().filter_map(|flow| flow.unshipped.as_ref()).filter(|tag| crate::unshipped::is_set_aside(Some(tag))).collect();
    match (tags.len() == flows.len(), tags.first()) {
        (true, Some(tag)) => format!("\n  not shipped: {} ({})", tag.role, tag.basis),
        _ => String::new(),
    }
}

fn leaders_of(flow: &Flow, signatures: &[BTreeSet<String>], shared_by: &BTreeMap<&str, usize>) -> Vec<usize> {
    let own = tokens_of(flow);
    let scores: Vec<f64> = signatures
        .iter()
        .map(|signature| {
            own.iter()
                .filter(|token| signature.contains(*token))
                .map(|token| 1.0 / shared_by.get(token.as_str()).copied().unwrap_or(1) as f64)
                .sum()
        })
        .collect();
    let best = scores.iter().copied().fold(0.0_f64, f64::max);
    match best > 0.0 {
        true => (0..scores.len()).filter(|at| scores[*at] == best).collect(),
        false => Vec::new(),
    }
}

pub(super) fn relate<'a>(
    said: &str,
    part: &[&'a Flow],
    related: &BTreeSet<&str>,
    lanes: &BTreeMap<&str, (&Family, &Vec<&'a Flow>)>,
    held: &mut Vec<Held>,
    fields: &Fields,
) -> Related<'a> {
    let rest: Vec<&'a Flow> = part.iter().copied().filter(|flow| !related.contains(flow.id.as_str())).collect();
    if rest.is_empty() || held.is_empty() {
        return Related { lanes: Vec::new(), unplaced: rest };
    }
    let rest_count = rest.len();
    let signatures: Vec<BTreeSet<String>> = held
        .iter()
        .map(|capability| {
            capability
                .families
                .iter()
                .filter_map(|id| lanes.get(id.as_str()))
                .flat_map(|(_, lane)| lane.iter().flat_map(|flow| tokens_of(flow)))
                .collect()
        })
        .collect();
    let mut shared_by: BTreeMap<&str, usize> = BTreeMap::new();
    for signature in &signatures {
        for token in signature {
            *shared_by.entry(token.as_str()).or_default() += 1;
        }
    }
    let mut attached: BTreeMap<(usize, &'static str), Vec<&'a Flow>> = BTreeMap::new();
    let mut undecided: Vec<&'a Flow> = Vec::new();
    for flow in rest {
        match leaders_of(flow, &signatures, &shared_by).as_slice() {
            [only] => attached.entry((*only, role_of(flow))).or_default().push(flow),
            _ => undecided.push(flow),
        }
    }
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("  supporting: {} flows outside the outcomes, {} related by shared evidence, {} undecided", rest_count, attached.values().map(Vec::len).sum::<usize>(), undecided.len());
    }
    let mut formed: Vec<Lane<'a>> = Vec::new();
    for ((at, role), flows) in attached {
        let id = format!("s{}", formed.len());
        let shared: BTreeSet<String> = flows
            .iter()
            .flat_map(|flow| tokens_of(flow))
            .filter(|token| signatures[at].contains(token))
            .map(|token| said_of(&token).to_string())
            .collect();
        let named: Vec<&str> = shared.iter().map(String::as_str).take(SHARED_NAMED).collect();
        held[at].families.insert(id.clone());
        held[at].roles.insert(
            id.clone(),
            Serving {
                role: role.to_string(),
                why: format!("it runs through {} that the flows of this capability also run through", named.join(", ")),
            },
        );
        formed.push(Lane {
            id,
            family: Family { key: format!("serves:{}", held[at].name), basis: "what it shares with the capability it serves" },
            flows,
        });
    }
    if undecided.is_empty() {
        return Related { lanes: formed, unplaced: Vec::new() };
    }
    let bookkeeping = kept_for_itself(&undecided);
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    for flow in &undecided {
        grouped.entry(outcome_of(flow, &bookkeeping)).or_default().push(flow);
    }
    let mut asked: Vec<Lane<'a>> = Vec::new();
    for (family, mut flows) in grouped {
        flows.sort_by(|left, right| left.id.cmp(&right.id));
        asked.push(Lane { id: format!("s{}", formed.len() + asked.len()), family, flows });
    }
    let told: BTreeMap<String, String> = asked
        .iter()
        .map(|lane| (lane.id.clone(), format!("{}{}", evidence_of(&lane.flows, &lane.family, fields), set_aside_note(&lane.flows))))
        .collect();
    for _ in 0..PLACING_ROUNDS {
        if unseated(told.keys(), held).is_empty() || !place(said, &told, held) {
            break;
        }
    }
    let left: BTreeSet<String> = unseated(told.keys(), held).into_iter().collect();
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("  related {} supporting outcomes by evidence and asked about {}, {} unplaced", formed.len(), asked.len(), left.len());
        for lane in asked.iter().filter(|lane| left.contains(&lane.id)) {
            eprintln!("  unplaced supporting {} {}", lane.family.key, lane.flows.len());
        }
    }
    let mut leaning: BTreeMap<(usize, &'static str), Vec<&'a Flow>> = BTreeMap::new();
    let mut unplaced: Vec<&'a Flow> = Vec::new();
    asked.retain(|lane| {
        let seated = !left.contains(&lane.id);
        if !seated {
            for flow in lane.flows.iter().copied() {
                match leaders_of(flow, &signatures, &shared_by).into_iter().max_by_key(|at| (signatures[*at].len(), std::cmp::Reverse(*at))) {
                    Some(at) => leaning.entry((at, role_of(flow))).or_default().push(flow),
                    None => unplaced.push(flow),
                }
            }
        }
        seated
    });
    for ((at, role), flows) in leaning {
        let id = format!("s{}", formed.len() + asked.len());
        held[at].families.insert(id.clone());
        held[at].roles.insert(
            id.clone(),
            Serving { role: role.to_string(), why: "it shares more with this capability than with any other, and the AI named none for it".to_string() },
        );
        asked.push(Lane {
            id,
            family: Family { key: format!("serves:{}", held[at].name), basis: "what it shares with the capability it serves" },
            flows,
        });
    }
    formed.extend(asked);
    Related { lanes: formed, unplaced }
}

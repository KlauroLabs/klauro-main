use std::collections::{BTreeMap, BTreeSet};

use crate::author::Serving;
use crate::comprehend::{Family, Flow};

use super::{evidence_of, kept_for_itself, outcome_of, place, unseated, Fields, Held, PLACING_ROUNDS};

type Pool<'p, 'a> = BTreeMap<&'p str, (&'p Family, &'p Vec<&'a Flow>)>;

pub(super) struct Lane<'a> {
    pub(super) id: String,
    pub(super) family: Family,
    pub(super) flows: Vec<&'a Flow>,
    pub(super) told: String,
}

pub(super) struct Fallen<'a> {
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

fn is_file(token: &str) -> bool {
    token.starts_with("file:")
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

type Standing = (f64, f64);

fn leaders_of(flow: &Flow, signatures: &[BTreeSet<String>], shared_by: &BTreeMap<&str, usize>) -> (Vec<usize>, bool) {
    let own = tokens_of(flow);
    let scores: Vec<Standing> = signatures
        .iter()
        .map(|signature| {
            own.iter().filter(|token| signature.contains(*token)).fold((0.0, 0.0), |(strong, weak), token| {
                let share = 1.0 / shared_by.get(token.as_str()).copied().unwrap_or(1) as f64;
                match is_file(token) {
                    true => (strong, weak + share),
                    false => (strong + share, weak),
                }
            })
        })
        .collect();
    let best = scores.iter().copied().fold((0.0, 0.0), |best: Standing, score| match score.partial_cmp(&best) {
        Some(std::cmp::Ordering::Greater) => score,
        _ => best,
    });
    match best > (0.0, 0.0) {
        true => ((0..scores.len()).filter(|at| scores[*at] == best).collect(), best.0 > 0.0),
        false => (Vec::new(), false),
    }
}

fn signatures_of(held: &[Held], lanes: &Pool) -> Vec<BTreeSet<String>> {
    held.iter()
        .map(|capability| {
            capability
                .families
                .iter()
                .filter_map(|id| lanes.get(id.as_str()))
                .flat_map(|(_, lane)| lane.iter().flat_map(|flow| tokens_of(flow)))
                .collect()
        })
        .collect()
}

fn shared_among(signatures: &[BTreeSet<String>]) -> BTreeMap<&str, usize> {
    let mut shared_by: BTreeMap<&str, usize> = BTreeMap::new();
    for signature in signatures {
        for token in signature {
            *shared_by.entry(token.as_str()).or_default() += 1;
        }
    }
    shared_by
}

fn names_shared(flows: &[&Flow], signature: &BTreeSet<String>) -> Vec<String> {
    let shared: BTreeSet<String> =
        flows.iter().flat_map(|flow| tokens_of(flow)).filter(|token| signature.contains(token)).collect();
    let mut ordered: Vec<&String> = shared.iter().collect();
    ordered.sort_by_key(|token| is_file(token));
    let mut named: Vec<String> = Vec::new();
    for token in ordered {
        let said = said_of(token).to_string();
        if !named.contains(&said) {
            named.push(said);
        }
        if named.len() == SHARED_NAMED {
            break;
        }
    }
    named
}

fn told_of(flows: &[&Flow], family: &Family, fields: &Fields) -> String {
    format!("{}{}", evidence_of(flows, family, fields), set_aside_note(flows))
}

fn outcome_lanes<'a>(
    flows: Vec<&'a Flow>,
    at: usize,
    role: &'static str,
    prefix: &str,
    why: &str,
    held: &mut [Held],
    formed: &mut Vec<Lane<'a>>,
    fields: &Fields,
) {
    let bookkeeping = kept_for_itself(&flows);
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    for flow in flows {
        grouped.entry(outcome_of(flow, &bookkeeping)).or_default().push(flow);
    }
    for (family, mut lane) in grouped {
        lane.sort_by(|left, right| left.id.cmp(&right.id));
        let id = format!("{prefix}{}", formed.len());
        held[at].families.insert(id.clone());
        held[at].roles.insert(id.clone(), Serving { role: role.to_string(), why: why.to_string() });
        let told = told_of(&lane, &family, fields);
        formed.push(Lane { id, family, flows: lane, told });
    }
}

pub(super) fn relate<'a>(
    said: &str,
    part: &[&'a Flow],
    related: &BTreeSet<&str>,
    lanes: &Pool<'_, 'a>,
    held: &mut Vec<Held>,
    fields: &Fields,
) -> Vec<Lane<'a>> {
    let rest: Vec<&'a Flow> = part.iter().copied().filter(|flow| !related.contains(flow.id.as_str())).collect();
    if rest.is_empty() || held.is_empty() {
        return Vec::new();
    }
    let rest_count = rest.len();
    let signatures = signatures_of(held, lanes);
    let shared_by = shared_among(&signatures);
    let mut attached: BTreeMap<(usize, &'static str), Vec<&'a Flow>> = BTreeMap::new();
    let mut undecided: Vec<&'a Flow> = Vec::new();
    for flow in rest {
        match leaders_of(flow, &signatures, &shared_by) {
            (leaders, true) if leaders.len() == 1 => attached.entry((leaders[0], role_of(flow))).or_default().push(flow),
            _ => undecided.push(flow),
        }
    }
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!(
            "  supporting: {} flows outside the outcomes, {} related by shared records or functions, {} undecided",
            rest_count,
            attached.values().map(Vec::len).sum::<usize>(),
            undecided.len()
        );
    }
    let mut formed: Vec<Lane<'a>> = Vec::new();
    for ((at, role), flows) in attached {
        let named = names_shared(&flows, &signatures[at]);
        let why = format!("it runs through {} that the flows of this capability also run through", named.join(", "));
        outcome_lanes(flows, at, role, "s", &why, held, &mut formed, fields);
    }
    if undecided.is_empty() {
        return formed;
    }
    let bookkeeping = kept_for_itself(&undecided);
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    for flow in &undecided {
        grouped.entry(outcome_of(flow, &bookkeeping)).or_default().push(flow);
    }
    let first = formed.len();
    let mut asked: Vec<Lane<'a>> = Vec::new();
    for (family, mut flows) in grouped {
        flows.sort_by(|left, right| left.id.cmp(&right.id));
        let told = told_of(&flows, &family, fields);
        asked.push(Lane { id: format!("s{}", first + asked.len()), family, flows, told });
    }
    let told: BTreeMap<String, String> = asked.iter().map(|lane| (lane.id.clone(), lane.told.clone())).collect();
    for _ in 0..PLACING_ROUNDS {
        if unseated(told.keys(), held).is_empty() || !place(said, &told, held) {
            break;
        }
    }
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("  related {} supporting outcomes by evidence and asked about {}", first, asked.len());
    }
    formed.extend(asked);
    formed
}

pub(super) fn fall_back<'a>(held: &mut [Held], lanes: &Pool<'_, 'a>, left: Vec<&'a Flow>, fields: &Fields) -> Fallen<'a> {
    let signatures = signatures_of(held, lanes);
    let shared_by = shared_among(&signatures);
    let mut leaning: BTreeMap<(usize, &'static str, bool), Vec<&'a Flow>> = BTreeMap::new();
    let mut unplaced: Vec<&'a Flow> = Vec::new();
    for flow in left {
        let (leaders, strong) = leaders_of(flow, &signatures, &shared_by);
        match leaders.into_iter().max_by_key(|at| (signatures[*at].len(), std::cmp::Reverse(*at))) {
            Some(at) => leaning.entry((at, role_of(flow), strong)).or_default().push(flow),
            None => unplaced.push(flow),
        }
    }
    let mut formed: Vec<Lane<'a>> = Vec::new();
    for ((at, role, strong), flows) in leaning {
        let named = names_shared(&flows, &signatures[at]);
        let basis = match strong {
            true => "records or functions",
            false => "only files",
        };
        let why = format!(
            "attached by fallback with lower confidence: the AI named no capability for it, and it shares more with this one than with any other, by {basis} ({})",
            named.join(", ")
        );
        outcome_lanes(flows, at, role, "x", &why, held, &mut formed, fields);
    }
    Fallen { lanes: formed, unplaced }
}

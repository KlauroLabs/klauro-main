use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use rayon::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://api.deepinfra.com/v1/openai/chat/completions";
const GROUNDED: f64 = 0.5;
const TRIES: usize = 5;
const NAMED_PER_CALL: usize = 24;
const NAMED_PER_SPOKEN_CALL: usize = 40;

pub fn reaching_at_once(over_a_network: usize) -> usize {
    match spoken_to().is_some() {
        true => 6,
        false => over_a_network,
    }
}

/// How fast the backend writes, in bytes of answer per second, as last seen.
/// Zero until something has been asked.
static WRITTEN_PER_SECOND: AtomicU64 = AtomicU64::new(0);

/// Answers that did not carry what was asked for, and so had to be asked again.
/// This should stay at zero: an answer that has to be chased is a question that
/// was put badly, not a backend that needs another go.
static ASKED_AGAIN: AtomicU64 = AtomicU64::new(0);

pub fn asked_again() -> u64 {
    ASKED_AGAIN.load(Ordering::Relaxed)
}

/// Measured: a backend asked for one thing at a time answers in the wrong shape
/// far more often than one asked for a list, and serving many calls at once
/// divides a fixed pipe rather than widening it. Small batches were slower and
/// lost groups; the batch stays whole. The rate is still measured, because how
/// fast the backend writes is worth seeing even when nothing steers by it.
const ANSWER_WORTH_TIMING: usize = 200;

fn measured(answer: &str, took: std::time::Duration) {
    let seconds = took.as_secs_f64();
    if seconds < 0.5 || answer.len() < ANSWER_WORTH_TIMING {
        return;
    }
    let rate = (answer.len() as f64 / seconds).round() as u64;
    let held = WRITTEN_PER_SECOND.load(Ordering::Relaxed);
    let held = match held {
        0 => rate,
        held => (held * 3 + rate) / 4,
    };
    WRITTEN_PER_SECOND.store(held.max(1), Ordering::Relaxed);
}

pub fn writing_rate() -> u64 {
    WRITTEN_PER_SECOND.load(Ordering::Relaxed)
}

fn named_per_call() -> usize {
    if let Ok(held) = std::env::var("KLAURO_NAMED_PER_CALL")
        && let Ok(held) = held.parse::<usize>()
    {
        return held.max(1);
    }
    match spoken_to().is_some() {
        true => NAMED_PER_SPOKEN_CALL,
        false => NAMED_PER_CALL,
    }
}
const PATHS_PER_PROPOSAL: usize = 500;

#[derive(Debug, Serialize, Clone, Copy)]
pub struct Grounding {
    pub supported: f64,
    pub invented: f64,
    pub specific: f64,
    pub outcome: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub universal: Option<f64>,
    /// False when no grader was reachable, so these readings are what an
    /// ungraded description is given, not what one earned.
    pub graded: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Written {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub audience: String,
}

fn spoken_to() -> Option<String> {
    std::env::var("KLAURO_AUTHOR_CLI").ok().filter(|held| !held.is_empty())
}

fn key() -> Option<String> {
    ["KLAURO_AUTHOR_KEY", "DEEPINFRA_API_KEY"]
        .into_iter()
        .find_map(|named| std::env::var(named).ok())
        .filter(|key| !key.is_empty())
}

pub fn asked() -> bool {
    std::env::var("KLAURO_ENRICH").map(|held| held != "0").unwrap_or(true)
        && (spoken_to().is_some() || addressed().is_some() || key().is_some())
}

fn addressed() -> Option<String> {
    std::env::var("KLAURO_AUTHOR_ENDPOINT").ok().filter(|held| !held.is_empty())
}

fn endpoint() -> String {
    addressed().unwrap_or_else(|| ENDPOINT.to_string())
}

fn model() -> String {
    std::env::var("KLAURO_AUTHOR_MODEL").unwrap_or_else(|_| BESIDE[0].to_string())
}

static BESIDE: &[&str] = &["deepseek-coder-v2:16b", "qwen2.5:14b-instruct"];

fn asking_of_models(first: String) -> Vec<String> {
    let mut held = vec![first];
    if std::env::var("KLAURO_AUTHOR_MODEL").is_ok() {
        return held;
    }
    for other in BESIDE {
        if !held.iter().any(|named| named == other) {
            held.push((*other).to_string());
        }
    }
    held
}

fn proposing() -> Vec<String> {
    asking_of_models(
        std::env::var("KLAURO_PROPOSAL_MODEL")
            .or_else(|_| std::env::var("KLAURO_AUTHOR_MODEL"))
            .unwrap_or_else(|_| model()),
    )
}

#[derive(Debug, Deserialize, Clone)]
pub struct Outcome {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub audience: String,
}

#[derive(Debug, Deserialize)]
struct Proposed {
    outcomes: Vec<Outcome>,
}

pub fn propose_outcomes(evidence: &[String], spoken_for: &str) -> Vec<Outcome> {
    if !asked() || evidence.is_empty() {
        return Vec::new();
    }
    let mut outcomes: Vec<Outcome> = evidence
        .par_chunks(PATHS_PER_PROPOSAL)
        .flat_map(|batch| propose_batch(batch, spoken_for))
        .collect();
    outcomes.sort_by(|left, right| left.name.cmp(&right.name));
    outcomes.dedup_by(|left, right| left.name.eq_ignore_ascii_case(&right.name));
    match evidence.len() > PATHS_PER_PROPOSAL {
        true => consolidate(&outcomes, spoken_for),
        false => outcomes,
    }
}

fn consolidate(outcomes: &[Outcome], spoken_for: &str) -> Vec<Outcome> {
    if outcomes.len() < 2 {
        return outcomes.to_vec();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         Readers each looked at one part of it and proposed the outcomes it delivers. Their \
         lists overlap, because the same outcome is reached from many parts.\n\n{}\n\n\
         Give the one list the whole system delivers, by these rules:\n{RULES}\n\n\
         Fold together the ones that name the same outcome, keeping the clearer wording. Keep \
         every outcome that is genuinely its own. Do not invent one nobody proposed, and do not \
         drop one because it was proposed only once.\n\n\
         Return JSON only: {{\"outcomes\":[{{\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}",
        outcomes
            .iter()
            .map(|outcome| format!("- {} (for {}): {}", outcome.name, outcome.audience, outcome.description))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let Some(held) = answered::<Proposed>(&prompt, 4000, &proposing(), "outcomes", 1) else {
        return outcomes.to_vec();
    };
    let mut folded: Vec<Outcome> = held
        .outcomes
        .into_iter()
        .map(|mut outcome| {
            outcome.name = outcome.name.trim().to_string();
            outcome.description = outcome.description.trim().to_string();
            outcome.audience = outcome.audience.trim().to_ascii_lowercase();
            outcome
        })
        .filter(|outcome| !outcome.name.is_empty() && !outcome.description.is_empty())
        .collect();
    folded.sort_by(|left, right| left.name.cmp(&right.name));
    folded.dedup_by(|left, right| left.name.eq_ignore_ascii_case(&right.name));
    match folded.is_empty() {
        true => outcomes.to_vec(),
        false => folded,
    }
}

fn propose_batch(evidence: &[String], spoken_for: &str) -> Vec<Outcome> {
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         These are the paths through it that change something, each named as the code names the \
         operation it serves, with the records it writes:\n{}\n\n\
         Name the capabilities of this system, by these rules:\n{RULES}\n\n\
         Name the audience for each one — an end user, an operator, an administrator, a developer, \
         an analyst or an agent. Take your words from the operations and the self-description, \
         never from the storage or the framework. A path that only reads can still deliver a \
         capability; what a path does at the end tells you what it is for, not whether it counts.\n\n\
         For each, give a name of 2-6 words, one sentence saying what someone gets, and the \
         audience it is for.\n\n\
         Return JSON only: {{\"outcomes\":[{{\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}",
        evidence.join("\n")
    );
    let Some(held) = answered::<Proposed>(&prompt, 3000, &proposing(), "outcomes", 1) else { return Vec::new() };
    held.outcomes
        .into_iter()
        .map(|mut outcome| {
            outcome.name = outcome.name.trim().to_string();
            outcome.description = outcome.description.trim().to_string();
            outcome.audience = outcome.audience.trim().to_ascii_lowercase();
            outcome
        })
        .filter(|outcome| {
            !outcome.name.is_empty() && outcome.name.len() < 70 && !outcome.description.is_empty()
        })
        .collect()
}

pub fn name_them(
    member: &str,
    spoken_for: &str,
    evidence: &BTreeMap<String, String>,
) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    if !asked() || evidence.is_empty() {
        return named;
    }
    let listed: Vec<String> = evidence
        .iter()
        .map(|(id, facts)| format!("- id: {id}\n{facts}"))
        .collect();
    let batches: Vec<BTreeMap<String, Written>> = listed
        .par_chunks(named_per_call())
        .map(|batch| name_batch(member, spoken_for, batch))
        .collect();
    for batch in batches {
        named.extend(batch);
    }
    named
}

/// How many groups to put in one call, given how many there are altogether.
/// The backend answers several callers at once and writes each answer with one
/// stream, so the work belongs spread across the callers it can serve — but a
/// call carrying too few groups is answered in the wrong shape more often than
/// one carrying a list, so the batch has a floor.
pub fn per_call_for(groups: usize) -> usize {
    if spoken_to().is_some() {
        return NAMED_PER_SPOKEN_CALL;
    }
    groups.div_ceil(CALLS_AT_ONCE).clamp(LEAST_PER_CALL, NAMED_PER_CALL)
}

const CALLS_AT_ONCE: usize = 12;
const LEAST_PER_CALL: usize = 6;

pub fn name_capabilities(
    spoken_for: &str,
    grouped: &BTreeMap<String, String>,
    per_call: usize,
) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    if !asked() || grouped.is_empty() {
        return named;
    }
    let listed: Vec<String> = grouped
        .iter()
        .map(|(id, facts)| format!("- id: {id}\n{facts}"))
        .collect();
    let batches: Vec<BTreeMap<String, Written>> = listed
        .par_chunks(per_call.max(1))
        .map(|batch| name_capability_batch(spoken_for, batch))
        .collect();
    for batch in batches {
        named.extend(batch);
    }
    // A batch that comes back empty takes its groups with it, and a group that
    // is never named is a capability that silently stops existing. Ask again
    // for whatever is still unnamed, in smaller pieces, while it is still there.
    let unnamed = grouped.len() - named.len();
    if unnamed > 0 {
        eprintln!("  author left {unnamed} of {} groups unnamed", grouped.len());
    }
    named
}

fn name_capability_batch(spoken_for: &str, listed: &[String]) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         Each group below is a set of paths through the system that the evidence already placed \
         together — they share the records they write, the surface they are reached through, or \
         the effect they end in.\n\n\
         Name the capability each group delivers, by these rules:\n{RULES}\n\n\
         Name the audience for each one — an end user, an operator, an administrator, a developer, \
         an analyst or an agent. Take your words from the operations and the self-description, \
         never from the storage or the framework. A group that only reads can still deliver a \
         capability; what its paths do at the end tells you what it is for, not whether it counts.\n\n\
         Name what the person ends up with, never the way in and never what it is built on: a \
         group reached through web routes is not called an API, one reached through pages is not \
         called a web interface, and one that keeps records is not called a database. The paths \
         in a group may be reached from more than one part of the system; that is one outcome \
         offered in several places, not a capability called after the places.\n\n\
         For each group give a name of 2-6 words, one sentence saying what someone gets, and the \
         audience it is for. Echo each id back exactly as given.\n\
         Return JSON only: {{\"items\":[{{\"id\":\"...\",\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}\n\n\
         The groups:\n{}",
        listed.join("\n\n")
    );
    let Some(written) = answered::<serde_json::Value>(&prompt, 3000, &asking_of_models(model()), "items", listed.len()) else {
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!("    batch of {} got no answer at all", listed.len());
        }
        return named;
    };
    let mut refused: Vec<String> = Vec::new();
    for item in written["items"].as_array().into_iter().flatten() {
        let Ok(held) = serde_json::from_value::<Written>(item.clone()) else {
            refused.push(format!("unreadable {item}"));
            continue;
        };
        if held.name.trim().is_empty() || held.description.trim().is_empty() {
            refused.push(format!("empty {}", held.id));
            continue;
        }
        named.insert(held.id.clone(), held);
    }
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() && named.len() < listed.len() {
        let asked: Vec<&str> = listed
            .iter()
            .filter_map(|held| held.lines().next())
            .map(|line| line.trim_start_matches("- id: "))
            .collect();
        let back: Vec<&str> = named.keys().map(String::as_str).collect();
        eprintln!(
            "    batch asked {} got {} | asked {asked:?} | back {back:?} | dropped {refused:?}",
            listed.len(),
            named.len()
        );
    }
    named
}

fn name_batch(member: &str, spoken_for: &str, listed: &[String]) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         Describe the {member} of that system. For each one, say in a single clause what it is \
         and why this product keeps one — what it stands for in the world the product is about.\n\n\
         Do not list its fields: whoever reads this can already see them. Use them only to work \
         out what the thing is. Never name a technology, vendor, framework or storage, and never \
         invent a purpose the facts do not support. No more than fifteen words.\n\n\
         Echo each id back exactly as given.\n\
         Return JSON only: {{\"items\":[{{\"id\":\"...\",\"description\":\"...\"}}]}}\n\n\
         The {member}:\n{}",
        listed.join("\n\n")
    );
    let Some(written) = answered::<serde_json::Value>(&prompt, 1200, &asking_of_models(model()), "items", listed.len()) else { return named };
    for item in written["items"].as_array().into_iter().flatten() {
        let Ok(held) = serde_json::from_value::<Written>(item.clone()) else { continue };
        named.insert(held.id.clone(), held);
    }
    named
}

pub fn ground(
    written: &BTreeMap<String, Written>,
    evidence: &BTreeMap<String, String>,
) -> BTreeMap<String, Grounding> {
    let asking: Vec<(&String, &Written, &String)> = written
        .iter()
        .filter_map(|(id, held)| Some((id, held, evidence.get(id)?)))
        .collect();
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    for (at, (_, held, facts)) in asking.iter().enumerate() {
        let told = format!(
            "FACTS extracted from code:\n{facts}\n\nPROPOSED DESCRIPTION: {}",
            held.description
        );
        for (named, question) in written_of(&told) {
            questions.insert(format!("w{at}-{named}"), question);
        }
    }
    let answers = crate::jev::decide("Each question carries its own facts.", questions);
    asking
        .iter()
        .enumerate()
        .map(|(at, (id, _, _))| {
            let settled = |named: &str, fallback: f64| {
                answers
                    .get(&format!("w{at}-{named}"))
                    .map(crate::jev::Decision::settled)
                    .unwrap_or_else(|| unanswered(fallback))
            };
            (
                (*id).clone(),
                Grounding {
                    supported: settled("supported", 0.0),
                    invented: settled("invented", 1.0),
                    outcome: settled("outcome", 0.0),
                    universal: None,
                    graded: crate::jev::asked(),
                    specific: answers
                        .get(&format!("w{at}-specific"))
                        .and_then(|held| held.score)
                        .map(|score| (score * 10.0).round() / 10.0)
                        .unwrap_or_else(|| unanswered(0.0)),
                },
            )
        })
        .collect()
}

fn written_of(told: &str) -> BTreeMap<&'static str, crate::jev::Question> {
    BTreeMap::from([
        (
            "outcome",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{told}\n\nThe proposed description says what the thing is and what it stands for, rather than listing its fields or naming a code mechanism"),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "supported",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{told}\n\nThe proposed description fits the facts: nothing in it contradicts them, and it reads as a fair account of what this is"),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "invented",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{told}\n\nThe description mentions a technology, vendor or system that does not appear in the facts"),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "specific",
            crate::jev::Question {
                kind: "score",
                instructions: format!("{told}\n\nHow specific this is to these facts rather than generic"),
                criteria: vec![
                    "Generic; could describe any system".to_string(),
                    "Names the domain but little else".to_string(),
                    "Names what only this part of the system does".to_string(),
                ]
                .into(),
            },
        ),
    ])
}

/// Which capabilities say what the product is, and which are there so those
/// can happen. Both are capabilities; only one of them is the product.
pub fn what_it_is_for(spoken_for: &str, listed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut held = BTreeMap::new();
    if !asked() || listed.is_empty() {
        return held;
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         Below is everything it can do. Some of it is what someone came for. The rest is there so \
         that can happen: signing in, administering it, keeping it running, moving its data \
         about. Both are real, and neither is being thrown away — this only says which is which.\n\n\
         Mark each one:\n\
         - \"terminal\" if someone would name it as a reason the product exists\n\
         - \"proximal\" if it is not the reason itself but is what immediately delivers one\n\
         - \"supporting\" if it exists so the others can happen, and nobody arrives wanting it\n\n\
         Managing accounts supports what the accounts are for. Administering a system supports \
         whatever the system does. Storing and moving data supports whatever the data is for. A \
         product whose whole point is accounts, or administration, is the exception, so read what \
         it says about itself before deciding.\n\n\
         Return JSON only: {{\"placed\":[{{\"id\":\"...\",\"place\":\"terminal|proximal|supporting\"}}]}}\n\n\
         What it can do:\n{}",
        listed.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n")
    );
    let Some(answer) =
        answered::<serde_json::Value>(&prompt, 1500, &asking_of_models(model()), "placed", 1)
    else {
        return held;
    };
    for item in answer["placed"].as_array().into_iter().flatten() {
        let (Some(id), Some(place)) = (item["id"].as_str(), item["place"].as_str()) else {
            continue;
        };
        let place = match place.trim().to_ascii_lowercase().as_str() {
            "terminal" => "terminal",
            "proximal" => "proximal",
            "supporting" => "supporting",
            _ => continue,
        };
        held.insert(id.to_string(), place.to_string());
    }
    held
}

#[derive(Debug, Deserialize)]
pub struct Same {
    #[serde(default)]
    pub of: Vec<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub audience: String,
}

/// An outcome does not belong to a part. The same one is reached from a page
/// and from the route behind it, from a phone and from a command line, and each
/// of those was read on its own and named on its own. Nothing until here has
/// been in a position to see two of them together.
pub fn same_outcome(spoken_for: &str, listed: &BTreeMap<String, String>) -> Vec<Same> {
    if !asked() || listed.is_empty() {
        return Vec::new();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         Below is every capability read from it, each with the part it was found in and the \
         surfaces it is reached through. They were read one part at a time, so the same outcome \
         may appear more than once: reached from a page and from the route behind it, from a \
         phone and from a command line, or split into steps of one thing.\n\n\
         Put together the ones that are the same outcome, by these rules:\n{RULES}\n\n\
         Two are the same outcome when a person would say they did one thing, however many ways \
         in the system offers. Browsing an album and browsing a trash folder are both browsing; \
         sharing by link and sharing with a partner are both sharing. Two are NOT the same when \
         someone would come for one and not the other. Leave a capability by itself if nothing \
         else matches it — most groups are of one.\n\n\
         For each group give the name of the outcome in 2-6 words, one sentence saying what \
         someone gets, and the audience it is for. Name what the person ends up with, never the \
         way in and never what it is built on: a group reached through web routes is not called \
         an API, one reached through pages is not called a web interface, and one that stores \
         things is not called a database. If the ones you put together were already called \
         something between them that says the outcome, keep saying it that way. Every id below must appear in exactly one \
         group, and no id may appear that is not below.\n\
         Return JSON only: {{\"groups\":[{{\"of\":[\"...\"],\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}\n\n\
         The capabilities:\n{}",
        listed.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n")
    );
    let Some(held) = answered::<serde_json::Value>(&prompt, 4000, &asking_of_models(model()), "groups", 1)
    else {
        return Vec::new();
    };
    held["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|group| serde_json::from_value::<Same>(group.clone()).ok())
        .filter(|group| !group.of.is_empty() && !group.name.trim().is_empty())
        .collect()
}

pub const RULES: &str = "A capability is an outcome someone gets from the system. It is judged by \
two tests. The audience test, which is audience-relative: would this product's own audience \
recognise it as something they came for? Not would a passer-by nod — that rejects every correct \
capability of a developer library. Identify the audience first, then apply the test to them; the \
audience binds to the capability, not to the system, so one product may serve an end user, an \
operator, a developer and an analyst at once. The universality test: would this be true of most \
codebases? Then it is infrastructure, not a capability. Supporting concepts — connecting a wallet, \
authenticating users, recording telemetry — are not capabilities unless the product itself is that \
kind of product. Count is an output, not a target: a focused tool legitimately has one.";

#[derive(Debug, Deserialize)]
struct Told {
    description: String,
}

pub fn describe_system(facts: &str) -> Option<String> {
    if !asked() {
        return None;
    }
    let prompt = format!(
        "These are the facts a reader extracted from one software repository.\n\n{facts}\n\n\
         Write the paragraph that tells someone what this is, the way its own README would open \
         if it were honest. It must leave the reader knowing what this is and who it is for, what \
         someone can do with it, what it holds onto, and what it is made of — but let the thing \
         itself decide the order and the shape of that, and never answer those four in a row like \
         a form. Two sentences are enough if two will do. Use only the facts given and the \
         product's own words. \
         Never name a product, vendor or technology the facts do not name. Do not describe the \
         analysis, the repository or the code layout — describe the thing the code is.\n\n\
         Return JSON only: {{\"description\":\"...\"}}"
    );
    let told: Told = answered(&prompt, 1200, &proposing(), "description", 1)?;
    let described = told.description.trim().to_string();
    (!described.is_empty()).then_some(described)
}

pub fn test_description(facts: &str) -> Grounding {
    let questions = BTreeMap::from([
        (
            "supported".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "Every claim in the proposed description is supported by the facts"
                    .to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "invented".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "The description names a specific third-party product, vendor, brand or technology that does not appear in the facts".to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "outcome".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "The description says what this particular product is and what someone gets from it, rather than describing its code, its repository or software in general".to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "specific".to_string(),
            crate::jev::Question {
                kind: "score",
                instructions: "How specific this description is to this product rather than to any product".to_string(),
                criteria: vec![
                    "Generic; could describe any system".to_string(),
                    "Names the domain but little else".to_string(),
                    "Names what only this product does".to_string(),
                ]
                .into(),
            },
        ),
    ]);
    let answers = crate::jev::decide(facts, questions);
    let settled = |named: &str, fallback: f64| {
        answers.get(named).map(crate::jev::Decision::settled).unwrap_or_else(|| unanswered(fallback))
    };
    Grounding {
        supported: settled("supported", 0.0),
        invented: settled("invented", 1.0),
        outcome: settled("outcome", 0.0),
        universal: None,
        graded: crate::jev::asked(),
        specific: answers
            .get("specific")
            .and_then(|held| held.score)
            .map(|score| (score * 10.0).round() / 10.0)
            .unwrap_or_else(|| unanswered(0.0)),
    }
}

fn asking_of(facts: &str) -> BTreeMap<&'static str, crate::jev::Question> {
    BTreeMap::from([
        (
            "supported",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{facts}\n\nEvery claim in the proposed capability and description is supported by the facts"),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "invented",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{facts}\n\nThe proposal names a specific third-party product, vendor, brand or technology — a payment provider, a cloud service, a database engine, a named library — that does not appear in the facts. Ordinary words for the people who use the system and for what it does are not that."),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "outcome",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{facts}\n\nBy the rules above, this passes the audience test: this product's own audience would recognise it as something they came for, and it would appear in a product description, a user objective, a business offering or an operational responsibility"),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "universal",
            crate::jev::Question {
                kind: "noul",
                instructions: format!("{facts}\n\nBy the rules above, this fails the universality test: it would be true of most codebases, so it is infrastructure rather than something this product offers"),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "specific",
            crate::jev::Question {
                kind: "score",
                instructions: format!("{facts}\n\nHow specific this is to these facts rather than generic"),
                criteria: vec![
                    "Generic; could describe any system".to_string(),
                    "Names the domain but little else".to_string(),
                    "Names what only this part of the system does".to_string(),
                ]
                .into(),
            },
        ),
    ])
}

pub fn test_capabilities(spoken: &str, held: &[(String, String)]) -> BTreeMap<String, Grounding> {
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    for (at, (_, facts)) in held.iter().enumerate() {
        for (named, question) in asking_of(facts) {
            questions.insert(format!("c{at}-{named}"), question);
        }
    }
    let answers = crate::jev::decide(&format!("{RULES}\n\n{spoken}"), questions);
    held.iter()
        .enumerate()
        .map(|(at, (id, _))| {
            let settled = |named: &str, fallback: f64| {
                answers
                    .get(&format!("c{at}-{named}"))
                    .map(crate::jev::Decision::settled)
                    .unwrap_or_else(|| unanswered(fallback))
            };
            (
                id.clone(),
                Grounding {
                    supported: settled("supported", 0.0),
                    invented: settled("invented", 1.0),
                    outcome: settled("outcome", 0.0),
                    universal: Some(settled("universal", 1.0)),
                    graded: crate::jev::asked(),
                    specific: answers
                        .get(&format!("c{at}-specific"))
                        .and_then(|held| held.score)
                        .map(|score| (score * 10.0).round() / 10.0)
                        .unwrap_or_else(|| unanswered(0.0)),
                },
            )
        })
        .collect()
}

/// What a score reads as when no answer came back. A grader that is up and
/// declined to answer is a signal, so its silence still condemns; no grader at
/// all is not a verdict, so the reading degrades in confidence, not existence.
fn unanswered(strict: f64) -> f64 {
    match crate::jev::asked() {
        true => strict,
        false => 1.0 - strict,
    }
}

impl Grounding {
    pub fn stands(&self) -> bool {
        self.supported >= GROUNDED
            && self.invented < GROUNDED
            && self.outcome >= GROUNDED
            && self.universal.unwrap_or(1.0) < GROUNDED
    }

    pub fn holds(&self) -> bool {
        self.supported >= GROUNDED && self.invented < GROUNDED
    }

    pub fn fabricated(&self) -> bool {
        self.invented >= GROUNDED
    }

}

pub fn written_name(written: &Written) -> (&str, &str) {
    (&written.name, &written.description)
}

fn carved(text: &str) -> &str {
    let trimmed = text.trim();
    let held = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|rest| rest.trim_start())
        .and_then(|rest| rest.strip_suffix("```"))
        .unwrap_or(trimmed);
    let (Some(open), Some(close)) = (held.find('{'), held.rfind('}')) else { return held };
    &held[open..=close]
}

fn speaks_of_chat() -> bool {
    endpoint().contains("/api/chat")
}

fn shaped(of: &str) -> serde_json::Value {
    let text = serde_json::json!({"type": "string"});
    match of {
        "outcomes" => serde_json::json!({
            "type": "object",
            "properties": {"outcomes": {"type": "array", "items": {
                "type": "object",
                "properties": {"name": text, "description": text, "audience": text},
                "required": ["name", "description", "audience"],
            }}},
            "required": ["outcomes"],
        }),
        "items" => serde_json::json!({
            "type": "object",
            "properties": {"items": {"type": "array", "items": {
                "type": "object",
                "properties": {"id": text, "description": text},
                "required": ["id", "description"],
            }}},
            "required": ["items"],
        }),
        _ => serde_json::json!({
            "type": "object",
            "properties": {"description": text},
            "required": ["description"],
        }),
    }
}

fn bodied(prompt: &str, most: u32, model: &str, of: &str) -> Option<String> {
    let shape = shaped(of);
    let held = match speaks_of_chat() {
        true => serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": false,
            "format": shape,
            "options": {"temperature": 0, "num_predict": most},
        }),
        false => serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": of, "strict": true, "schema": shape},
            },
            "max_tokens": most,
            "temperature": 0,
        }),
    };
    serde_json::to_string(&held).ok()
}

fn spoken_content(text: &str) -> Option<String> {
    let held = serde_json::from_str::<serde_json::Value>(text).ok()?;
    match speaks_of_chat() {
        true => held["message"]["content"].as_str().map(str::to_string),
        false => held["choices"][0]["message"]["content"].as_str().map(str::to_string),
    }
}

fn answered<T: serde::de::DeserializeOwned>(
    prompt: &str,
    most: u32,
    models: &[String],
    of: &str,
    at_least: usize,
) -> Option<T> {
    let spoken_to = spoken_to();
    // Anything well-formed parses as a Value, so a reply carrying an empty list
    // used to count as an answer and nothing was ever asked again. What was
    // asked for has to be in there for this to be an answer at all.
    let carries = |held: &str| -> bool {
        if of.is_empty() {
            return true;
        }
        serde_json::from_str::<serde_json::Value>(held).is_ok_and(|value| match value.get(of) {
            Some(serde_json::Value::Array(held)) => held.len() >= at_least.max(1),
            Some(serde_json::Value::String(held)) => !held.trim().is_empty(),
            Some(serde_json::Value::Null) | None => false,
            Some(_) => true,
        })
    };
    let read = |text: &str| -> Option<T> {
        let held = match &spoken_to {
            Some(_) => carved(text).to_string(),
            None => carved(&spoken_content(text)?).to_string(),
        };
        carries(&held).then(|| serde_json::from_str::<T>(&held).ok())?
    };
    let mut held = None;
    'asking: for model in models {
        let request = match &spoken_to {
            Some(command) => format!("{command}\n{prompt}"),
            None => bodied(prompt, most, model, of)?,
        };
        if let Some(remembered) = crate::jev::remembered(&request)
            && let Some(value) = read(&remembered)
        {
            return Some(value);
        }
        for attempt in 0..TRIES {
            let answered = match &spoken_to {
                Some(command) => spoken(command, prompt).map_or(
                    crate::reach::Answer::Missed,
                    crate::reach::Answer::Held,
                ),
                None => ask(&request),
            };
            match answered {
                crate::reach::Answer::Held(text) => {
                    if let Some(value) = read(&text) {
                        held = Some((value, text, request));
                        break 'asking;
                    }
                    ASKED_AGAIN.fetch_add(1, Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(500 << attempt))
                }
                crate::reach::Answer::Refused => break,
                crate::reach::Answer::Missed => {
                    std::thread::sleep(std::time::Duration::from_millis(500 << attempt))
                }
            }
        }
    }
    let Some((value, text, request)) = held else {
        eprintln!("  author no answer to a prompt of {} bytes", prompt.len());
        return None;
    };
    crate::jev::remember(&request, &text);
    Some(value)
}

fn spoken(command: &str, prompt: &str) -> Option<String> {
    let mut words = command.split_whitespace();
    let program = words.next()?;
    let mut call = Command::new(program)
        .args(words)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    call.stdin.as_mut()?.write_all(prompt.as_bytes()).ok()?;
    let answered = call.wait_with_output().ok()?;
    if !answered.status.success() {
        return None;
    }
    String::from_utf8(answered.stdout).ok()
}

fn ask(request: &str) -> crate::reach::Answer {
    let started = std::time::Instant::now();
    let answer = match (key(), addressed()) {
        (Some(key), _) => crate::reach::asking(&endpoint(), &key, request),
        (None, Some(endpoint)) => crate::reach::asking(&endpoint, "", request),
        (None, None) => crate::reach::Answer::Refused,
    };
    if let crate::reach::Answer::Held(held) = &answer {
        measured(held, started.elapsed());
    }
    answer
}

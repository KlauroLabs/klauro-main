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

static WRITTEN_PER_SECOND: AtomicU64 = AtomicU64::new(0);

static ASKED_AGAIN: AtomicU64 = AtomicU64::new(0);

pub fn asked_again() -> u64 {
    ASKED_AGAIN.load(Ordering::Relaxed)
}

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

#[derive(Debug, Serialize, Clone, Copy)]
pub struct Grounding {
    pub supported: f64,
    pub invented: f64,
    pub specific: f64,
    pub outcome: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub universal: Option<f64>,
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

pub fn what_it_is_for(spoken_for: &str, listed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    if !asked() || listed.is_empty() {
        return BTreeMap::new();
    }
    let listed: Vec<(&String, &String)> = listed.iter().collect();
    let per_call = per_call_for(listed.len());
    listed
        .par_chunks(per_call.max(1))
        .map(|chunk| {
            place_a_batch(spoken_for, &chunk.iter().map(|(id, told)| ((*id).clone(), (*told).clone())).collect())
        })
        .reduce(BTreeMap::new, |mut into, held| {
            into.extend(held);
            into
        })
}

fn place_a_batch(spoken_for: &str, listed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut held = BTreeMap::new();
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
        answered::<serde_json::Value>(&prompt, 1500, &asking_of_models(model()), "placed", listed.len())
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

pub fn same_outcome(spoken_for: &str, listed: &BTreeMap<String, String>) -> Vec<Same> {
    if !asked() || listed.is_empty() {
        return Vec::new();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         Below are capabilities read from it that already look like they may be one outcome — \
         they were read one part at a time, so the same thing appears more than once: reached \
         from a page and from the route behind it, from a phone and from a command line, or \
         split into steps of one thing. They are in front of you together because they might be \
         one; expect to put most of them together.\n\n\
         Put together the ones that are the same outcome, by these rules:\n{RULES}\n\n\
         Two are the same outcome when a person would say they did one thing, however many ways \
         in the system offers. Browsing an album, a trash folder, a timeline and a favourite are \
         all browsing; sharing by link, with a partner, and seeing what is shared with you are \
         all sharing; reading a photo's metadata and its statistics are both reading about it. \
         Keep two apart only when someone would come for one and not the other — a different \
         thing to do, not a different way to do it.\n\n\
         For each group give the name of the outcome in 2-6 words, one sentence saying what \
         someone gets, and the audience it is for. Name what the person ends up with, never the \
         way in and never what it is built on: a group reached through web routes is not called \
         an API, one reached through pages is not called a web interface, and one that keeps \
         records is not called a database. Where the ones you put together were already called \
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

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Expectation {
    pub at: String,
    pub has: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Missed {
    pub kind: String,
    pub what: String,
    #[serde(default)]
    pub line: u32,
    pub expect: Expectation,
    pub smallest: String,
}

#[derive(Debug, Deserialize)]
struct Missing {
    missed: Vec<Missed>,
}

pub fn look_for_missed(path: &str, source: &str, recorded: &str) -> Vec<Missed> {
    if !asked() {
        return Vec::new();
    }
    let prompt = format!(
        "A reader that works only from the text of a file has already been over this one.\n\n\
         FILE: {path} (each line begins with its number)\n\n{source}\n\n\
         What that reader recorded for this file:\n{recorded}\n\n\
         Name only what this file plainly does that the reader did not record: a surface it \
         serves, something it reaches outside itself, a table or collection it reads or writes, \
         a message it sends or waits for. Judge only from the text above, never from what a file \
         with this name usually does. Say nothing about anything already recorded, nothing about \
         style or quality, and nothing you would have to run the code to know. If the reader \
         recorded everything this file does, return an empty list.\n\n\
         For each one, give the smallest file in the same language that shows the same \
         construct, with nothing else in it, naming nothing from this product: no product name, \
         no vendor, no brand, no word particular to this domain. The reader must be able to see \
         the construct in that file alone.\n\n\
         `line` is the number the line begins with, of the line where the thing happens, not \
         of a comment about it.\n\
         `at` names where the fact belongs, and only these words may be used:\n\
         - exit_points, carrying kind, target, operation. kind is one of api, cache, \
         client_storage, database, file, message, network, process.\n\
         - entry_points, carrying kind, method, path, name. kind is one of cli, event, export, \
         http, ipc, lifecycle, message, schedule, test.\n\
         - comprehension.entities, carrying declared_as.\n\
         Use no other place and no other field. Spell the values as they would be for your \
         smallest file, not for this one. If what you found does not fit those words, leave it \
         out.\n\n\
         Return JSON only: {{\"missed\":[{{\"kind\":\"entry|exit|entity|route\",\"what\":\"one \
         sentence, no product words\",\"line\":0,\"expect\":{{\"at\":\"exit_points\",\"has\":\
         {{\"kind\":\"database\",\"target\":\"a_table\"}}}},\"smallest\":\"...\"}}]}}"
    );
    answered::<Missing>(&prompt, 2000, &proposing(), "", 0)
        .map(|held| held.missed)
        .unwrap_or_default()
}

pub fn vet(missed: &Missed) -> bool {
    if !crate::jev::asked() {
        return false;
    }
    let state = format!(
        "A reader of source code missed something.\n\nWhat it missed: {}\n\nThe smallest file \
         that shows it:\n{}\n\nWhere the fact belongs: {} carrying {:?}",
        missed.what, missed.smallest, missed.expect.at, missed.expect.has
    );
    let meant = what_it_means(&missed.expect);
    let questions = BTreeMap::from([
        (
            "means".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: format!(
                    "In the smallest file, the construct really is this, and not merely something \
                     that shares a word with it: {meant}"
                ),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "ordinary".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "The construct named here appears in many codebases, so teaching a \
                               reader to see it would help on repositories other than this one"
                    .to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "readable".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "The smallest file alone shows the construct, so the claim can be \
                               settled by reading that file and nothing else"
                    .to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "unnamed".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "The smallest file and the sentence name no product, vendor, brand \
                               or word particular to one domain"
                    .to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
    ]);
    let answered = crate::jev::decide(&state, questions);
    ["means", "ordinary", "readable", "unnamed"]
        .iter()
        .all(|asked| answered.get(*asked).map(|held| held.settled() >= VETTED).unwrap_or(false))
}

const VETTED: f64 = 0.6;

static WHAT_A_KIND_MEANS: &[(&str, &str, &str)] = &[
    ("comprehension.entities", "", "a kind of record the program keeps in storage and reads back later, not a collection or helper type it uses while running"),
    ("entry_points", "cli", "a command someone runs from a terminal"),
    ("entry_points", "event", "a handler the program registers for an event something else raises"),
    ("entry_points", "export", "something a package offers for other code to use, not something it takes from elsewhere"),
    ("entry_points", "http", "a route the program serves to requests arriving over a network"),
    ("entry_points", "ipc", "a request arriving from another process on the same machine"),
    ("entry_points", "lifecycle", "a hook the runtime calls when the program starts or stops"),
    ("entry_points", "message", "a consumer of messages arriving on a queue or bus"),
    ("entry_points", "schedule", "work the program runs on a timer"),
    ("entry_points", "test", "a test case that exercises the program"),
    ("exit_points", "api", "a request sent over a network to another system"),
    ("exit_points", "cache", "a value written to or read from a cache that outlives one call"),
    ("exit_points", "client_storage", "a value written to or read from storage the browser keeps, such as a cookie or local storage"),
    ("exit_points", "database", "a read from or write to a database"),
    ("exit_points", "file", "a file on disk being read or written while the program runs, not a module being imported"),
    ("exit_points", "message", "a message published to or taken from a queue or bus, not an error being raised"),
    ("exit_points", "network", "a connection opened to another machine"),
    ("exit_points", "process", "another program being started, not a function being called"),
];

pub fn what_it_means(expect: &Expectation) -> String {
    let kind = expect.has.get("kind").map(String::as_str).unwrap_or_default();
    WHAT_A_KIND_MEANS
        .iter()
        .find(|(at, named, _)| *at == expect.at && (named.is_empty() || *named == kind))
        .map(|(_, _, meant)| (*meant).to_string())
        .unwrap_or_else(|| format!("{} of kind {kind}", expect.at))
}

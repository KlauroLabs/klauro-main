use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use rayon::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://api.deepinfra.com/v1/openai/chat/completions";
const GROUNDED: f64 = 0.5;
const ONLY_STORED: f64 = 1.5;

const ONLY_MECHANISM: f64 = 1.5;

const CLAIMED_BY_ITS_OWN_WORDS: f64 = 0.75;
const ONLY_THIS_PRODUCT: f64 = 0.25;
const TRIES: usize = 5;
const NAMED_PER_CALL: usize = 24;
const NAMED_PER_SPOKEN_CALL: usize = 40;

pub const DEFERRED: u8 = 0;
pub const DESCRIBING_ASK: u8 = 5;
pub const WEIGHING: u8 = 6;
pub const JOINING: u8 = 7;
pub const TIGHTENING: u8 = 7;
pub const PROPOSING: u8 = 8;
pub const DERIVING: u8 = 9;

pub fn reaching_at_once(over_a_network: usize) -> usize {
    match spoken_to().is_some() {
        true => crate::budget::ai_concurrency() * THREADS_PER_PLACE,
        false => over_a_network,
    }
}

const THREADS_PER_PLACE: usize = 16;

static ASKING: std::sync::LazyLock<rayon::ThreadPool> = std::sync::LazyLock::new(|| {
    rayon::ThreadPoolBuilder::new()
        .num_threads(crate::budget::ai_concurrency() * THREADS_PER_PLACE)
        .build()
        .expect("a pool of threads to ask on")
});

pub fn asking<R: Send>(work: impl FnOnce() -> R + Send) -> R {
    ASKING.install(work)
}

static WRITTEN_PER_SECOND: AtomicU64 = AtomicU64::new(0);

static ASKED_AGAIN: AtomicU64 = AtomicU64::new(0);

static WENT_UNANSWERED: AtomicU64 = AtomicU64::new(0);

pub fn went_unanswered() -> u64 {
    WENT_UNANSWERED.load(Ordering::Relaxed)
}

static BEGAN: std::sync::LazyLock<std::time::Instant> = std::sync::LazyLock::new(std::time::Instant::now);

thread_local! {
    static WEIGHT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

pub fn weight() -> u32 {
    WEIGHT.with(|held| held.get())
}

pub fn weighing<R>(weight: u32, work: impl FnOnce() -> R) -> R {
    let before = WEIGHT.with(|held| held.replace(weight));
    let done = work();
    WEIGHT.with(|held| held.set(before));
    done
}

pub fn priority(urgency: u8) -> u64 {
    (u64::from(weight()) << 8) | u64::from(urgency)
}

pub fn began() {
    std::sync::LazyLock::force(&BEGAN);
}

pub fn mark(label: &str) {
    if std::env::var("KLAURO_ASK_GRAPH").is_ok() {
        eprintln!("MARK {} {label}", BEGAN.elapsed().as_millis());
    }
}

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

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct Grounding {
    pub supported: f64,
    pub invented: f64,
    pub specific: f64,
    pub outcome: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub universal: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanism: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hollow: Option<f64>,
    pub graded: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Written {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub description: String,
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
        && std::env::var("KLAURO_AI_INTERPRETATION").map(|held| held != "false").unwrap_or(true)
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
    let batches: Vec<BTreeMap<String, Written>> = asking(|| {
        listed
            .par_chunks(named_per_call())
            .map(|batch| name_batch(member, spoken_for, batch, true))
            .collect()
    });
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



fn name_batch(member: &str, spoken_for: &str, listed: &[String], again: bool) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         That description may speak of the project rather than the software, such as its status, history or \
         whether it is still maintained; what the software does is read from the code below, and that decides.\n\n\
         Describe the {member} of that system. For each one, say in a single clause what it is \
         and why this product keeps one — what it stands for in the world the product is about.\n\n\
         Do not list its fields: whoever reads this can already see them. Use them only to work \
         out what the thing is. Never name a technology, vendor, framework or storage, and never \
         invent a purpose the facts do not support. A record the code never names is still kept \
         for a reason: something the product relies on reads and writes it, so say what it stands \
         for, never that it is unused, generated or a default. No more than fifteen words.\n\n\
         Echo each id back exactly as given.\n\
         Return JSON only: {{\"items\":[{{\"id\":\"...\",\"description\":\"...\"}}]}}\n\n\
         The {member}:\n{}",
        listed.join("\n\n")
    );
    let Some(written) = answered::<serde_json::Value>(&prompt, 1200, &asking_of_models(model()), "items", most_of(listed.len()), DEFERRED) else { return named };
    for item in written["items"].as_array().into_iter().flatten() {
        let Ok(held) = serde_json::from_value::<Written>(item.clone()) else { continue };
        named.insert(held.id.clone(), held);
    }
    let missing: Vec<String> = listed
        .iter()
        .filter(|told| listed_id(told).is_some_and(|id| !named.contains_key(id)))
        .cloned()
        .collect();
    if again && !missing.is_empty() {
        named.extend(name_batch(member, spoken_for, &missing, false));
    }
    named
}

fn listed_id(told: &str) -> Option<&str> {
    told.strip_prefix("- id: ")?.lines().next().map(str::trim)
}

fn most_of(listed: usize) -> usize {
    listed.div_ceil(2)
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
    let answers = crate::jev::decide_at("Each question carries its own facts.", questions, DEFERRED);
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
                    mechanism: None,
                    hollow: None,
                    scope: None,
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
    let weight = weight();
    asking(|| {
        listed
            .par_chunks(per_call.max(1))
            .map(|chunk| {
                weighing(weight, || {
                    place_a_batch(spoken_for, &chunk.iter().map(|(id, told)| ((*id).clone(), (*told).clone())).collect())
                })
            })
            .reduce(BTreeMap::new, |mut into, held| {
                into.extend(held);
                into
            })
    })
}

const PATHS_PER_CALL: usize = 12;

pub const IN_THE_USERS_WORDS: &str = "Write the name and the sentence in the words of the person who gets it: never name an internal command, message channel, handler or function, and never say that something is called through a command or a channel. A route that a client of a web API calls may be named when it is what the outcome offers.";

pub const NAMING: &str = "Also give it a name of 2-5 words that says what someone gets done on this path, a verb and what it acts on, like \"Cancel an order\", \
    never a route, a function name or a topic. What a path is reached through says what it does as much as its steps do: \
    one reached through a delete removes something, a create adds one, an update changes one, so its name says that even when the steps only show a read.";

pub fn what_happens(spoken_for: &str, listed: &[(String, String)]) -> BTreeMap<String, Written> {
    if !asked() || listed.is_empty() {
        return BTreeMap::new();
    }
    asking(|| {
        listed
            .par_chunks(PATHS_PER_CALL)
            .map(|chunk| tell_a_batch(spoken_for, chunk, true))
            .reduce(BTreeMap::new, |mut into, held| {
                into.extend(held);
                into
            })
    })
}

fn tell_a_batch(spoken_for: &str, listed: &[(String, String)], again: bool) -> BTreeMap<String, Written> {
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         That description may speak of the project rather than the software, such as its status, history or \
         whether it is still maintained; what the software does is read from the code below, and that decides.\n\n\
         Below are paths through it, each with the steps its code takes, in order, read from the \
         code. For each, say in one sentence of at most 25 words what happens when it runs: what \
         it checks, what it changes, what it hands on and what the caller gets back, the way a \
         person would say it rather than step by step. {NAMING} \
         Use only what the path and its steps show, and never \
         name a framework, library or storage technology.\n\n\
         Echo each id back exactly as given.\n\
         Return JSON only: {{\"items\":[{{\"id\":\"...\",\"name\":\"...\",\"description\":\"...\"}}]}}\n\n\
         The paths:\n{}",
        listed.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n")
    );
    let mut held = BTreeMap::new();
    let Some(answer) = answered::<serde_json::Value>(&prompt, 3000, &asking_of_models(model()), "items", most_of(listed.len()), DEFERRED) else {
        return held;
    };
    for item in answer["items"].as_array().into_iter().flatten() {
        let (Some(id), Some(description)) = (item["id"].as_str(), item["description"].as_str()) else { continue };
        if !description.trim().is_empty() {
            held.insert(
                id.to_string(),
                Written {
                    id: id.to_string(),
                    name: item["name"].as_str().unwrap_or_default().trim().to_string(),
                    description: description.trim().to_string(),
                },
            );
        }
    }
    let missing: Vec<(String, String)> = listed.iter().filter(|(id, _)| !held.contains_key(id)).cloned().collect();
    if again && !missing.is_empty() {
        held.extend(tell_a_batch(spoken_for, &missing, false));
    }
    held
}

fn place_a_batch(spoken_for: &str, listed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut held = BTreeMap::new();
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         That description may speak of the project rather than the software, such as its status, history or \
         whether it is still maintained; what the software does is read from the code below, and that decides.\n\n\
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
        answered::<serde_json::Value>(&prompt, 1500, &asking_of_models(model()), "placed", listed.len(), WEIGHING)
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

pub const SERVING_ROLES: &[&str] = &[
    "primary",
    "supporting",
    "prerequisite",
    "operational",
    "administrative",
    "recovery",
    "observability",
    "compliance",
    "maintenance",
];

pub const PURPOSE: &str = "A capability is a purpose: why the system was built, something its product description, \
a user's objective, a business offering or an operational responsibility would list. A flow is a behavior that serves \
a purpose, such as one command, route, screen or job, and many flows serve one purpose: creating, renaming, listing and \
deleting a thing are all behaviors of the one purpose of managing it, not four capabilities. Supporting concerns — \
signing in, permissions, settings, health, telemetry, generic create, read, update and delete of records — are never \
capabilities of their own; they are flows that support the capabilities they serve, unless what the product says of itself \
shows that it is that kind of product. Not every flow serves a purpose the product states, and a flow left out of every \
capability is an honest answer.";

pub const ROLES_TOLD: &str = "primary: it carries out the purpose itself; supporting: it helps carry it out; \
prerequisite: it has to happen first, such as signing in or connecting an account; operational: it runs or keeps the \
purpose running, such as scheduled and background work; administrative: it configures or controls who may; recovery: \
it undoes, retries, restores or repairs; observability: it reports on it, such as status, logs, metrics or audit; \
compliance: consent, retention or other obligations; maintenance: upkeep, clean-up or migration.";

pub const PURPOSE_CONTRACT_VERSION: &str = "purpose-5";

pub const UNASSIGNED: &str = "unassigned";

pub const OUTCOME_NAMES: &str = "A capability is named for the result someone ends up with, in the product's own domain, \
never for an operation the code performs on the way to it: hashing, encoding, parsing, serialising, validating, \
formatting, reading or writing a file, calling a service and the like are steps inside outcomes, never a purpose. \
When the only thing an outcome shows is such an operation, it serves the purpose that operation is in aid of, or is \
left unassigned; it is never named as a capability. Never name one with a filler verb such as handle, manage, process \
or support followed by a topic: say what comes out of it, like \"Schedule a delivery\" or \"Find a nearby \
shop\".";

pub const OWN_WORDS: &str = "That description may speak of the project rather than the software, such as its status, \
history or whether it is still maintained; what the software does is read from the code below, and that decides. \
When it does say what the software is for, the purposes below are the ones it names in its own words. When it says \
nothing about itself, name a purpose only when the outcomes below jointly deliver it.";

pub fn same_outcome(spoken_for: &str, listed: &BTreeMap<String, String>) -> Vec<Same> {
    if !asked() || listed.is_empty() {
        return Vec::new();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n{OWN_WORDS}\n\n\
         Below are capabilities read from it one part at a time, so the same purpose can appear more than \
         once: reached from a page and from the route behind it, from a phone and from a command line, \
         or split into narrower pieces of one thing. Find the ones that serve the same purpose and put each \
         set together; leave everything else on its own.\n\n{PURPOSE}\n\n\
         Put capabilities together when the product's description would list them as one thing: one is a part, \
         a stage, a way in or a narrower view of the other, or both are the same purpose reached from \
         different parts of the system. Managing a thing and listing it, and placing an order from the web shop \
         and from the phone app, are one purpose each. Keep two apart when the product's description would list \
         them separately: they serve different purposes, even when they touch the same records or are used by the \
         same person. A group whose name would need a list of unrelated things to cover its members is not one \
         purpose; leave those apart.\n\n\
         For each group give the name of the purpose in 2-6 words — a verb and what it is for, like \"Share posts with followers\", never a bare topic like \"Posting\" — one sentence saying what someone gets, and the audience it is for. Name what the person ends up with, never the \
         way in and never what it is built on: a group reached through web routes is not called \
         an API, one reached through pages is not called a web interface, and one that keeps \
         records is not called a database. Where the ones you put together were already called \
         something between them that says the purpose, keep saying it that way. The name and the sentence say only what the code shown does: never an option, filter, step \
         or result it does not show. When it only checks, simulates or records something, say it \
         checks, simulates or records it rather than that it does it. \
         Every id below must appear in exactly one \
         group, and no id may appear that is not below.\n\
         Return JSON only: {{\"groups\":[{{\"of\":[\"...\"],\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}\n\n\
         The capabilities:\n{}",
        listed.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n")
    );
    let Some(held) = answered::<serde_json::Value>(&prompt, 4000, &asking_of_models(model()), "groups", 1, JOINING)
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

pub fn derive_parent(prompt: &str) -> Option<serde_json::Value> {
    if !asked() {
        return None;
    }
    answered::<serde_json::Value>(prompt, 3000, &asking_of_models(model()), "derived", 1, DERIVING)
}

pub fn same_capability(spoken_for: &str, listed: &BTreeMap<String, String>) -> Vec<Same> {
    if !asked() || listed.len() < 2 {
        return Vec::new();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n{OWN_WORDS}\n\n\
         Below is the complete list of capabilities read from it, each with an id, its name and what someone \
         gets. The list was put together piece by piece, so one purpose may appear more than once under different \
         words, or be split into narrower pieces.\n\n{PURPOSE}\n\n\
         Which of these serve the same purpose? Two are the same when the product's description would list them \
         as one thing: they are the same purpose named two ways, or one is a part, a stage, a way in or a narrower \
         view of the other. Opening external links and opening external URLs are one; managing a thing and listing \
         it are one. Keep two apart when the product's description would list them as separate purposes, even when \
         they act on the same thing or are used by the same person. A group whose name would need a list of \
         unrelated things to cover its members is not one purpose. A capability that covers a whole area and one \
         that is only a part of it are one purpose: the part goes into the area.\n\n\
         List only groups of two or more ids, and leave every other id out. For each group give the name that \
         says the shared purpose best, keeping one of the names given when one says it, one sentence saying \
         what someone gets, and the audience it is for.\n\
         Return JSON only: {{\"groups\":[{{\"of\":[\"...\"],\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}\n\n\
         The capabilities:\n{}",
        listed.iter().map(|(id, told)| format!("- {id}: {told}")).collect::<Vec<_>>().join("\n")
    );
    let Some(held) = answered::<serde_json::Value>(&prompt, 3000, &asking_of_models(model()), "groups", 0, JOINING)
    else {
        return Vec::new();
    };
    held["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|group| serde_json::from_value::<Same>(group.clone()).ok())
        .filter(|group| group.of.len() > 1)
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct Serving {
    pub role: String,
    pub why: String,
}

#[derive(Debug, Clone)]
pub struct Proposed {
    pub name: String,
    pub description: String,
    pub audience: String,
    pub families: Vec<String>,
    pub roles: BTreeMap<String, Serving>,
}

#[derive(Debug, Default)]
pub struct Proposal {
    pub capabilities: Vec<Proposed>,
    pub unassigned: Vec<String>,
}

pub fn role_named(said: &str) -> Option<&'static str> {
    let said = said.trim().to_ascii_lowercase();
    SERVING_ROLES.iter().copied().find(|role| *role == said)
}

pub fn proposed_of(item: &serde_json::Value) -> Option<Proposed> {
    let text = |key: &str| item[key].as_str().unwrap_or_default().to_string();
    let mut families: Vec<String> = Vec::new();
    let mut roles: BTreeMap<String, Serving> = BTreeMap::new();
    for key in ["serves", "families"] {
        for served in item[key].as_array().into_iter().flatten() {
            let (id, role, why) = match served {
                serde_json::Value::String(id) => (id.trim().to_string(), String::new(), String::new()),
                serde_json::Value::Object(_) => (
                    served["id"].as_str().or(served["family"].as_str()).unwrap_or_default().trim().to_string(),
                    served["role"].as_str().unwrap_or_default().to_string(),
                    served["why"].as_str().unwrap_or_default().trim().to_string(),
                ),
                _ => continue,
            };
            if id.is_empty() || families.contains(&id) {
                continue;
            }
            if let Some(role) = role_named(&role) {
                roles.insert(id.clone(), Serving { role: role.to_string(), why });
            }
            families.push(id);
        }
    }
    let proposed = Proposed { name: text("name"), description: text("description"), audience: text("audience"), families, roles };
    (!proposed.name.trim().is_empty() && !proposed.families.is_empty()).then_some(proposed)
}

pub fn proposal_of(held: &serde_json::Value, offered: usize) -> Proposal {
    let ids = |key: &str| -> Vec<String> {
        held[key].as_array().into_iter().flatten().filter_map(|item| item.as_str().map(str::to_string)).collect()
    };
    let mut unassigned = ids("unassigned");
    unassigned.extend(ids("plumbing"));
    let capabilities: Vec<Proposed> =
        held["capabilities"].as_array().into_iter().flatten().filter_map(proposed_of).collect();
    if capabilities.is_empty() && unassigned.len() < offered {
        return Proposal::default();
    }
    Proposal { capabilities, unassigned }
}

pub fn propose_capabilities(spoken_for: &str, families: &[(String, String)]) -> Proposal {
    if !asked() || families.is_empty() {
        return Proposal::default();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n{OWN_WORDS}\n\n\
         Below is every outcome one part of it delivers, or some of them when the part has many: the record a path \
         changes, what it hands on to another part, the service it acts through, the command a person or another \
         program explicitly asked it to run, or what it shows someone. Each outcome lists the paths that end in \
         it and the steps each path takes. A named command is one behavior someone can ask for; it is a flow that \
         serves a purpose, not a purpose by itself. Outcomes that change something are terminal; outcomes that only \
         show something are one step short of terminal and are just as real: seeing your orders is something you \
         come for.\n\n{PURPOSE}\n\n\
         Read the outcomes as a whole and say which capabilities this part delivers, by these rules:\n{RULES}\n\n\
         Take what the product's description would list for a system like this: those are the capabilities, \
         and the outcomes below are the behaviors that serve them. Group many outcomes under one purpose when \
         they are different behaviors of it: the ways in, the stages, the views of it and the actions on it. \
         Keep two purposes apart when different people come for them or when the same person comes for \
         different reasons: a shopper checking out and a merchant fulfilling orders are two purposes even though \
         both change orders. When the outcomes are only some of the part, name purposes the way the whole \
         product's description would, not narrowed to this selection.\n\n\
         For each capability list every outcome that serves it, each with a role: {ROLES_TOLD} \
         Give each a few words on why. An outcome may serve more than one capability, with a different role in each; \
         list it under each. Work the system does without being asked — on a timer, in the background, or when a \
         message from another part arrives — serves the purpose it moves forward, with the operational role, \
         whenever someone relies on it.\n\n\
         An outcome that serves no purpose the product states is left out of every capability and listed as \
         unassigned. That is expected and honest, not a failure: tooling, scaffolding, the system keeping track of \
         itself (requests already handled, a log of messages sent, health, static files, the building blocks of a \
         page), and supporting concerns that serve nothing the product names are all unassigned. Never force an \
         outcome into a capability to place it. But most outcomes of a real product do serve some purpose: a command, \
         a route or a handler that is one of the many behaviors of a purpose serves it, whatever its role, and being \
         one of many is not a reason to leave it unassigned.\n\n\
         For each capability give a name of 2-6 words that says what the purpose is — a verb and what it is for, \
         like \"Share posts with followers\" or \"Track an order\", never a bare topic or category like \
         \"Posting\", \"Orders\" or \"Engagement\", and never the name of one command or one screen —, one \
         sentence saying what someone gets, and the audience it is for. {outcome_names} The name and the sentence say only what the code shown does: never an option, filter, step \
         or result it does not show. When it only checks, simulates or records something, say it \
         checks, simulates or records it rather than that it does it. Name the capability for what the person gets, \
         never for the way in or what it is built on: nothing is called an API, a page, an endpoint, a screen, a \
         form, a database or a table. {users_words} \
         Every id below must appear in at least one capability or in unassigned, and no other id may appear.\n\
         Return JSON only: {{\"capabilities\":[{{\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\",\"serves\":[{{\"id\":\"...\",\"role\":\"primary\",\"why\":\"...\"}}]}}],\"unassigned\":[\"...\"]}}\n\n\
         The outcomes:\n{}",
        families.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n"),
        users_words = IN_THE_USERS_WORDS,
        outcome_names = OUTCOME_NAMES
    );
    let Some(held) =
        answered::<serde_json::Value>(&prompt, 8000, &asking_of_models(model()), "capabilities", 0, PROPOSING)
    else {
        return Proposal::default();
    };
    proposal_of(&held, families.len())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PartNamed {
    pub name: String,
    pub summary: String,
}

pub fn name_a_part(facts: &str) -> Option<PartNamed> {
    if !asked() {
        return None;
    }
    let prompt = format!(
        "These are the facts read from one part of a software system.\n\n{facts}\n\n\
         Give the part a plain display name of 1-4 words that a person on the team would say aloud, \
         never the package name, never a path, never prefixed with the repository's name, and one line of \
         at most 14 words saying what the part is and what it is for, such as \"Storefront service: catalogue, \
         carts, checkout\". Say only what the facts show. Never name a product, vendor or \
         technology the facts do not name.\n\n\
         Return JSON only: {{\"name\":\"...\",\"summary\":\"...\"}}"
    );
    let named: PartNamed = answered(&prompt, 400, &proposing(), "summary", 1, DESCRIBING_ASK)?;
    let (name, summary) = (named.name.trim().to_string(), named.summary.trim().to_string());
    (!name.is_empty() && !summary.is_empty()).then_some(PartNamed { name, summary })
}

pub fn split_purpose(spoken_for: &str, name: &str, description: &str, families: &[(String, String)]) -> Proposal {
    if !asked() || families.len() < 2 {
        return Proposal::default();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n{OWN_WORDS}\n\n\
         One capability was read from it as \"{name}\", described as: {description}\n\
         It holds {} of the outcomes below, which is many for one purpose in a product's own description, so it \
         may be two or more things that were read as one: the reason someone comes for them differs, or the \
         person who comes differs.\n\n{PURPOSE}\n\n\
         Read the outcomes carefully. If they really are one purpose, return it as a single capability holding \
         all of them. If they are several, split it into the purposes it contains, each one something the \
         product's description would list on its own. Split by what someone comes for and who comes, never by \
         the way in, the technology or the kind of path. A purpose that would need a list of unrelated things \
         to name its members is not one purpose. The number of capabilities is whatever the outcomes show, \
         never a target.\n\n\
         Rules for what counts:\n{RULES}\n\n\
         For each capability list every outcome that serves it, each with a role: {ROLES_TOLD} Give each a few \
         words on why. An outcome that serves no purpose the product states is listed as unassigned. Give each \
         capability a name of 2-6 words that says what the person gets — a verb and what it is for, never a bare \
         topic and never the name of one command or screen —, one sentence saying what someone gets, and the \
         audience it is for. {users_words} {outcome_names} Every id below must appear in at least one capability or in \
         unassigned, and no other id may appear.\n\
         Return JSON only: {{\"capabilities\":[{{\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\",\"serves\":[{{\"id\":\"...\",\"role\":\"primary\",\"why\":\"...\"}}]}}],\"unassigned\":[\"...\"]}}\n\n\
         The outcomes:\n{}",
        families.len(),
        families.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n"),
        users_words = IN_THE_USERS_WORDS,
        outcome_names = OUTCOME_NAMES
    );
    let Some(held) = answered::<serde_json::Value>(&prompt, 8000, &asking_of_models(model()), "capabilities", 0, PROPOSING) else {
        return Proposal::default();
    };
    proposal_of(&held, families.len())
}

#[derive(Debug, Deserialize, Clone)]
pub struct Placed {
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub capability: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub audience: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub why: String,
}

pub fn place_families(
    spoken_for: &str,
    standing: &[(String, String)],
    unplaced: &[(String, String)],
) -> Vec<Placed> {
    if !asked() || unplaced.is_empty() {
        return Vec::new();
    }
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n{OWN_WORDS}\n\n\
         These capabilities were already read from it:\n{}\n\n\
         These outcomes were not placed yet, or were left aside when only some of the outcomes could be seen \
         together. {PURPOSE}\n\n\
         Most outcomes of a real product serve some purpose above: a command, a route or a handler that is one of \
         the many behaviors of a purpose serves it, and a purpose with many outcomes is the usual case. Do not \
         leave one aside because it is only one of many.\n\n\
         For each, say which capability above it serves, by its exact name, with a role ({ROLES_TOLD}) and a few \
         words on why; or give a new capability name of 2-6 words — a verb and what it is for, like \"Share posts with followers\", never a bare topic like \"Posting\" — with one \
         sentence saying what someone gets and its audience, only when the product's description would list that \
         purpose and none above fits; or say {unassigned} when it serves no purpose the product states, which is an \
         honest answer. Work the system does by itself — on a timer, in the background, or when a message arrives — \
         serves the purpose it moves forward. By these rules:\n{RULES}\n\n\
         Echo each group id back exactly as given.\n\
         Return JSON only: {{\"assigned\":[{{\"family\":\"...\",\"capability\":\"...\",\"role\":\"primary\",\"why\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}\n\n\
         The groups:\n{}",
        standing.iter().map(|(name, told)| format!("- {name}: {told}")).collect::<Vec<_>>().join("\n"),
        unplaced.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect::<Vec<_>>().join("\n"),
        unassigned = UNASSIGNED
    );
    let Some(held) = answered::<serde_json::Value>(&prompt, 3000, &asking_of_models(model()), "assigned", 1, PROPOSING)
    else {
        return Vec::new();
    };
    held["assigned"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| serde_json::from_value::<Placed>(item.clone()).ok())
        .filter(|item| !item.family.trim().is_empty() && !item.capability.trim().is_empty())
        .collect()
}

pub const RULES: &str = "A capability is a purpose of the system: something someone gets from it that the \
product's own description would list. It is judged by two tests. The audience test, the same at every level from \
one part to the whole: could a non-technical reader, such as a product manager, a designer or a marketer, read the \
name and know what someone gets, with no engineering vocabulary needed? A name that gives a protocol, a vendor or a \
library is wrong however real the mechanism is: mechanism belongs in the behavior beneath a capability, never in \
its name. The universality test: would this be true of most \
codebases? Then it is infrastructure, not a capability. Supporting concepts — connecting a wallet, \
authenticating users, recording telemetry — are not capabilities unless the product itself is that \
kind of product. Count is an output, not a target: a focused tool legitimately has one, and a large product has as \
many as its description lists.";

#[derive(Debug, Deserialize)]
struct Told {
    description: String,
}

pub const DESCRIBING: &str = "Write the paragraph that tells someone what this is, the way its own README would open if it were honest. \
    It must leave the reader knowing what this is and who it is for, what someone can do with it, what it holds onto, and what it is made of — \
    but let the thing itself decide the order and the shape of that, and never answer those four in a row like a form. \
    Two sentences are enough if two will do. Use only the facts given and the product's own words. \
    Never quote counts of routes, files, projects or surfaces, and never say what it does not do or does not keep — a reader wants what it is, not a tally. \
    Never name a product, vendor or technology the facts do not name. \
    Do not describe the analysis, the repository or the code layout — describe the thing the code is.";

pub fn describe_system(facts: &str) -> Option<String> {
    if !asked() {
        return None;
    }
    let prompt = format!(
        "These are the facts a reader extracted from one software repository.\n\n{facts}\n\n\
         {DESCRIBING}\n\n\
         Return JSON only: {{\"description\":\"...\"}}"
    );
    let told: Told = answered(&prompt, 1200, &proposing(), "description", 1, DESCRIBING_ASK)?;
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
        mechanism: None,
        hollow: None,
        scope: None,
        graded: crate::jev::asked(),
        specific: answers
            .get("specific")
            .and_then(|held| held.score)
            .map(|score| (score * 10.0).round() / 10.0)
            .unwrap_or_else(|| unanswered(0.0)),
    }
}

pub fn questions_asked() -> String {
    asking_of("").into_iter().map(|(named, question)| format!("{named}:{}", question.instructions)).collect::<Vec<_>>().join("\n")
}

fn asking_of(facts: &str) -> BTreeMap<&'static str, crate::jev::Question> {
    let named = facts
        .lines()
        .find_map(|line| line.strip_prefix("PROPOSED CAPABILITY:"))
        .map(str::trim)
        .unwrap_or_default();
    let described = facts
        .lines()
        .find_map(|line| line.strip_prefix("PROPOSED DESCRIPTION:"))
        .map(str::trim)
        .unwrap_or_default();
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
            "hollow",
            crate::jev::Question {
                kind: "score",
                instructions: format!("A capability is named \"{named}\". What the name acts on"),
                criteria: vec![
                    "A particular kind of thing in the product, such as a product, an order, a basket, a gift card, a post, a user or a booking, or an aspect of one, like its details or history".to_string(),
                    "A broad area of the product, such as content, media, messages or settings".to_string(),
                    "Only a generic word that could name any stored thing in any product, such as items, records, entries, objects, resources or data".to_string(),
                ]
                .into(),
            },
        ),
        (
            "mechanism",
            crate::jev::Question {
                kind: "score",
                instructions: format!("A capability is named \"{named}\" and described as: {described}. What it names"),
                criteria: vec![
                    "Something a person or another system gets done or gets from the product, such as placing an order, reading articles, backing up photos or getting paid".to_string(),
                    "A supporting ability that makes those possible, such as signing in, permissions or settings".to_string(),
                    "How the software itself works rather than anything someone gets, such as serving or routing requests, request headers, TLS, retries, idempotency, lifecycle hooks, dependency injection, validation rules, build or release scripts, or the tests".to_string(),
                ]
                .into(),
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

#[derive(Debug, Deserialize)]
pub struct Renamed {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

pub fn name_the_outcome(spoken: &str, held: &[(String, String)]) -> Vec<Renamed> {
    if !asked() || held.is_empty() {
        return Vec::new();
    }
    let weight = weight();
    asking(|| {
        held.par_chunks(CLAIMS_PER_ASK)
            .flat_map(|chunk| weighing(weight, || {
                let listed: Vec<String> = chunk.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect();
                let prompt = format!(
                    "A software system describes itself like this:\n{spoken}\n\n\
                     Each item below is a capability whose name carries words that the code only uses as the \
                     building blocks it is made from: they appear among the libraries, packages and types the code \
                     imports, and nowhere among the records and responses the product keeps and gives people. A \
                     capability is named for what someone gets, in words a non-technical reader such as a product \
                     manager, a designer or a marketer understands with no engineering vocabulary. For each item give \
                     a name of 2-6 words, a verb and what it is for, that says the outcome without the listed words, \
                     and one sentence saying what someone gets. Say only what the item's facts show.\n\
                     {outcome_names}\n\
                     Return JSON only: {{\"items\":[{{\"id\":\"...\",\"name\":\"...\",\"description\":\"...\"}}]}}\n\n\
                     The items:\n{}",
                    listed.join("\n"),
                    outcome_names = OUTCOME_NAMES
                );
                answered::<serde_json::Value>(&prompt, 3000, &asking_of_models(model()), "items", 1, TIGHTENING)
                    .map(|held| {
                        held["items"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|item| serde_json::from_value::<Renamed>(item.clone()).ok())
                            .filter(|item| !item.name.trim().is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            }))
            .collect()
    })
}

#[derive(Debug, Deserialize)]
pub struct Tightened {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub drop: bool,
}

const CLAIMS_PER_ASK: usize = 5;

pub fn tighten_claims(spoken: &str, held: &[(String, String)]) -> Vec<Tightened> {
    if !asked() || held.is_empty() {
        return Vec::new();
    }
    let weight = weight();
    asking(|| {
        held.par_chunks(CLAIMS_PER_ASK)
            .flat_map(|chunk| weighing(weight, || {
                let listed: Vec<String> = chunk.iter().map(|(id, told)| format!("- id: {id}\n{told}")).collect();
                let prompt = format!(
                    "A software system describes itself like this:\n{spoken}\n\n\
                     That description may speak of the project rather than the software; the facts below decide.\n\n\
                     Each item below is a capability someone proposed, with the facts read from the code about what \
                     serves it: several outcomes, each with a role in it. A capability is a purpose, so its name and \
                     sentence say what the product is for here, and the several behaviors that serve it stand behind \
                     that purpose without being listed in it. A careful reviewer will read the code and mark a \
                     capability wrong when its name or sentence claims more than the code does. For each item, give \
                     the name (2-6 words, a verb and what it is for) and one sentence that say exactly what the facts \
                     show someone gets:\n\
                     - drop any option, filter, step, provider or result the facts do not show, and any adjective, \
                     example or attribute they do not name (detailed, specifications, categories, recommendations);\n\
                     - the name states one purpose: it may cover the several behaviors that serve it, but it never \
                     lists them, and it is never narrowed to one command or one screen of those behaviors;\n\
                     - when the code only checks, simulates, records or shows something, say that rather than that \
                     it does it;\n\
                     - when the code where it starts shows it is a stub, a sample, a switch set in configuration, or \
                     wired to nothing configured, say exactly that;\n\
                     - when the name or sentence claims a behavior that none of the outcomes shown delivers, remove \
                     that claim, and keep every claim they do deliver;\n\
                     - when the code and the part's setup show it can never be reached — no client, provider or \
                     route for it exists anywhere — nobody gets it: set drop to true. A feature that switches on \
                     once an outside service or key is configured is real: keep it and say what it needs;\n\
                     - {users_words}\n\
                     - {outcome_names}\n\
                     - when it is named for such an operation and the outcomes show no result someone ends up with, set drop \
                     to true;\n\
                     - when the proposal is already exact, return it unchanged.\n\
                     Return JSON only: {{\"items\":[{{\"id\":\"...\",\"name\":\"...\",\"description\":\"...\",\"drop\":false}}]}}\n\n\
                     The items:\n{}",
                    listed.join("\n"),
                    users_words = IN_THE_USERS_WORDS,
                    outcome_names = OUTCOME_NAMES
                );
                answered::<serde_json::Value>(&prompt, 6000, &asking_of_models(model()), "items", 1, TIGHTENING)
                    .map(|held| {
                        held["items"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|item| serde_json::from_value::<Tightened>(item.clone()).ok())
                            .filter(|item| item.drop || !item.name.trim().is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            }))
            .collect()
    })
}

pub fn test_capabilities(spoken: &str, held: &[(String, String)], level: &str) -> BTreeMap<String, Grounding> {
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    for (at, (_, facts)) in held.iter().enumerate() {
        for (named, question) in asking_of(facts) {
            questions.insert(format!("c{at}-{named}"), question);
        }
        questions.insert(
            format!("c{at}-scope"),
            crate::jev::Question {
                kind: "noul",
                instructions: format!(
                    "{facts}\n\nSomeone saying what {level} is for would name this among the reasons it exists — something its audience comes for, or relies on it to do for them — and not something that only makes another of its capabilities possible, such as signing in or out, permissions, settings, or looking up reference data, unless providing that is what {level} exists for"
                ),
                criteria: BTreeMap::new().into(),
            },
        );
    }
    let answers = crate::jev::decide(&format!("{RULES}\n\n{spoken}"), questions);
    let answered = |at: usize| {
        !crate::jev::asked()
            || ["supported", "invented", "outcome", "scope"]
                .iter()
                .all(|named| answers.contains_key(&format!("c{at}-{named}")))
    };
    held.iter()
        .enumerate()
        .filter(|(at, _)| answered(*at))
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
                    mechanism: answers.get(&format!("c{at}-mechanism")).and_then(|held| held.score),
                    hollow: answers.get(&format!("c{at}-hollow")).and_then(|held| held.score),
                    scope: Some(settled("scope", 0.0)),
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

    pub fn confidence(&self) -> f64 {
        let held = [
            self.supported,
            self.outcome,
            self.scope.unwrap_or(self.outcome),
            1.0 - self.invented,
            1.0 - self.mechanism.unwrap_or(0.0) / 2.0,
            1.0 - self.hollow.unwrap_or(0.0) / 2.0,
        ];
        let mean = held.iter().map(|value| value.clamp(0.0, 1.0)).sum::<f64>() / held.len() as f64;
        (mean * 100.0).round() / 100.0
    }

    pub fn delivers(&self) -> bool {
        let scope = self.scope.unwrap_or(self.outcome);
        let particular = self.universal.unwrap_or(1.0) < ONLY_THIS_PRODUCT;
        !self.fabricated()
            && (scope >= GROUNDED || particular)
            && (self.universal.unwrap_or(0.0) < GROUNDED || scope >= CLAIMED_BY_ITS_OWN_WORDS)
            && self.mechanism.unwrap_or(0.0) < ONLY_MECHANISM
            && self.hollow.unwrap_or(0.0) < ONLY_STORED
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
                "properties": {"id": text, "name": text, "description": text, "audience": text},
                "required": ["id", "description"],
            }}},
            "required": ["items"],
        }),
        "capabilities" => serde_json::json!({
            "type": "object",
            "properties": {
                "capabilities": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "name": text,
                        "description": text,
                        "audience": text,
                        "families": {"type": "array", "items": text},
                    },
                    "required": ["name", "description", "audience", "families"],
                }},
                "plumbing": {"type": "array", "items": text},
            },
            "required": ["capabilities", "plumbing"],
        }),
        "summary" => serde_json::json!({
            "type": "object",
            "properties": {"name": text, "summary": text},
            "required": ["name", "summary"],
        }),
        "placed" => serde_json::json!({
            "type": "object",
            "properties": {"placed": {"type": "array", "items": {
                "type": "object",
                "properties": {"id": text, "place": {"type": "string", "enum": ["terminal", "proximal", "supporting"]}},
                "required": ["id", "place"],
            }}},
            "required": ["placed"],
        }),
        "assigned" => serde_json::json!({
            "type": "object",
            "properties": {"assigned": {"type": "array", "items": {
                "type": "object",
                "properties": {"family": text, "capability": text, "description": text, "audience": text},
                "required": ["family", "capability", "description", "audience"],
            }}},
            "required": ["assigned"],
        }),
        "derived" => serde_json::json!({
            "type": "object",
            "properties": {
                "derived": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "name": text,
                        "description": text,
                        "audience": text,
                        "from": {"type": "array", "items": {
                            "type": "object",
                            "properties": {"id": text, "as": {"type": "string", "enum": ["promoted", "absorbed"]}},
                            "required": ["id", "as"],
                        }},
                        "link": {"type": "array", "items": text},
                        "stated": {"type": "boolean"},
                    },
                    "required": ["name", "description", "audience", "from", "link", "stated"],
                }},
                "left": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"id": text, "why": text},
                    "required": ["id", "why"],
                }},
            },
            "required": ["derived", "left"],
        }),
        "groups" => serde_json::json!({
            "type": "object",
            "properties": {"groups": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "of": {"type": "array", "items": text},
                    "name": text,
                    "description": text,
                    "audience": text,
                },
                "required": ["of", "name", "description", "audience"],
            }}},
            "required": ["groups"],
        }),
        _ => serde_json::json!({
            "type": "object",
            "properties": {"description": text},
            "required": ["description"],
        }),
    }
}

const TERSE: &str = "Answer with the JSON alone, minified on one line: no code fence, no indentation, no words before or after it.";

fn bodied(prompt: &str, most: u32, model: &str, of: &str) -> Option<String> {
    let shape = shaped(of);
    let terse;
    let prompt = match of.is_empty() {
        true => prompt,
        false => {
            terse = format!("{prompt}\n\n{TERSE}");
            terse.as_str()
        }
    };
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
    urgency: u8,
) -> Option<T> {
    let began = std::time::Instant::now();
    let spoken_to = spoken_to();
    let carries = |held: &str| -> bool {
        if of.is_empty() {
            return true;
        }
        serde_json::from_str::<serde_json::Value>(held).is_ok_and(|value| match value.get(of) {
            Some(serde_json::Value::Array(held)) => held.len() >= at_least,
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
        let mut rejected = 0usize;
        let mut missed = 0u32;
        let mut waited = std::time::Duration::ZERO;
        let longest_wait = crate::reach::longest_wait();
        while rejected < TRIES && waited < longest_wait {
            let answered = match &spoken_to {
                Some(command) => spoken(command, prompt).map_or(
                    crate::reach::Answer::Missed,
                    crate::reach::Answer::Held,
                ),
                None => ask(&request, of, most, priority(urgency)),
            };
            match answered {
                crate::reach::Answer::Held(text) => {
                    if let Some(value) = read(&text) {
                        held = Some((value, text, request));
                        break 'asking;
                    }
                    ASKED_AGAIN.fetch_add(1, Ordering::Relaxed);
                    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                        let shown: String = text.chars().take(600).collect();
                        eprintln!("    rejected answer ({} bytes): {shown}", text.len());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500 << rejected.min(4)));
                    rejected += 1;
                }
                crate::reach::Answer::Refused => break,
                crate::reach::Answer::Missed => {
                    let pause = crate::reach::pause_after(missed);
                    std::thread::sleep(pause);
                    waited += pause;
                    missed += 1;
                }
            }
        }
    }
    if let Ok(folder) = std::env::var("KLAURO_AUTHOR_DUMP") {
        let named = crate::jev::named(prompt);
        let answer = held.as_ref().map(|(_, text, _)| text.as_str()).unwrap_or("");
        let _ = std::fs::write(format!("{folder}/{of}-{named}.txt"), format!("{prompt}\n\n=====\n\n{answer}"));
    }
    if std::env::var("KLAURO_ASK_GRAPH").is_ok() {
        eprintln!(
            "ASK {} {} {of} {} {}",
            (began - *BEGAN).as_millis(),
            (std::time::Instant::now() - *BEGAN).as_millis(),
            prompt.len(),
            crate::jev::named(prompt)
        );
    }
    let Some((value, text, request)) = held else {
        WENT_UNANSWERED.fetch_add(1, Ordering::Relaxed);
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

fn ask(request: &str, of: &str, most: u32, urgency: u64) -> crate::reach::Answer {
    let started = std::time::Instant::now();
    let answer = match (key(), addressed()) {
        (Some(key), _) => crate::reach::asking(&endpoint(), &key, request, urgency),
        (None, Some(endpoint)) => crate::reach::asking(&endpoint, "", request, urgency),
        (None, None) => crate::reach::Answer::Refused,
    };
    if let crate::reach::Answer::Held(held) = &answer {
        measured(held, started.elapsed());
        if std::env::var("KLAURO_AUTHOR_TRACE").is_ok() {
            eprintln!(
                "ask at {:>7}ms took {:>6}ms in {:>6} out {:>6} {of}/{most}",
                (started - *BEGAN).as_millis(),
                started.elapsed().as_millis(),
                request.len(),
                held.len()
            );
        }
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
    answered::<Missing>(&prompt, 2000, &proposing(), "", 0, DESCRIBING_ASK)
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
    ("entry_points", "background", "work a host keeps running in the background once it has started"),
    ("entry_points", "cli", "a command someone runs from a terminal"),
    ("entry_points", "event", "a handler the program registers for an event something else raises"),
    ("entry_points", "export", "something a package offers for other code to use, not something it takes from elsewhere"),
    ("entry_points", "http", "a route the program serves to requests arriving over a network"),
    ("entry_points", "ipc", "a request arriving from another process on the same machine"),
    ("entry_points", "lifecycle", "a hook the runtime calls when the program starts or stops"),
    ("entry_points", "message", "a consumer of messages arriving on a queue or bus"),
    ("entry_points", "schedule", "work the program runs on a timer"),
    ("entry_points", "test", "a test case that exercises the program"),
    ("entry_points", "ui", "an action a person takes in the program's interface, such as tapping a button or submitting a form"),
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

#[cfg(test)]
mod shapes {
    #[test]
    fn every_answer_asked_for_is_given_the_shape_it_is_read_back_in() {
        let source = include_str!("author.rs");
        let asked: std::collections::BTreeSet<&str> = source
            .match_indices("&asking_of_models(model()), \"")
            .chain(source.match_indices("&proposing(), \""))
            .filter_map(|(at, found)| source[at + found.len()..].split('"').next())
            .filter(|key| !key.is_empty() && *key != "description")
            .collect();
        assert!(asked.contains("capabilities") && asked.contains("groups"), "{asked:?}");
        for key in asked {
            let shape = super::shaped(key);
            let required = shape["required"].as_array().cloned().unwrap_or_default();
            assert!(required.iter().any(|held| held == key), "{key} is asked for but shaped as {shape}");
        }
    }
}

#[cfg(test)]
mod batches {
    use super::*;

    #[test]
    fn an_item_is_found_by_the_id_it_was_listed_under() {
        assert_eq!(listed_id("- id: m4\n  fields: a, b"), Some("m4"));
        assert_eq!(listed_id("fields"), None);
        assert_eq!(most_of(5), 3);
    }
}

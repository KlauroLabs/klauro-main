use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://api.deepinfra.com/v1/openai/chat/completions";
const SECONDS: &str = "60";
const GROUNDED: f64 = 0.5;
const NAMED_PER_CALL: usize = 8;

#[derive(Debug, Serialize, Clone, Copy)]
pub struct Grounding {
    pub supported: f64,
    pub invented: f64,
    pub specific: f64,
    pub outcome: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub universal: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct Written {
    pub id: String,
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
        && (spoken_to().is_some() || key().is_some())
}

fn endpoint() -> String {
    std::env::var("KLAURO_AUTHOR_ENDPOINT").unwrap_or_else(|_| ENDPOINT.to_string())
}

fn model() -> String {
    std::env::var("KLAURO_AUTHOR_MODEL")
        .unwrap_or_else(|_| "meta-llama/Llama-3.3-70B-Instruct".to_string())
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
    let prompt = format!(
        "A software system describes itself like this:\n{spoken_for}\n\n\
         These are the paths through it that change something, each named as the code names the \
         operation it serves, with the records it writes:\n{}\n\n\
         Name the capabilities of this system. A capability is an outcome someone gets — something \
         that would appear in a product description, a user objective or an operational \
         responsibility. It must pass two tests. The audience test: would this product's own \
         audience recognise it as something they came for? Name that audience — an end user, an \
         operator, an administrator, a developer, an analyst or an agent — and judge by them, not \
         by a passer-by. The universality test: would this be true of most codebases? Then it is \
         infrastructure and not a capability, so leave it out. Take your words from the operations \
         and the self-description, never from the storage or the framework. Say how many there are \
         by what you find; a focused tool has one.\n\n\
         For each, give a name of 2-6 words, one sentence saying what someone gets, and the \
         audience it is for.\n\n\
         Return JSON only: {{\"outcomes\":[{{\"name\":\"...\",\"description\":\"...\",\"audience\":\"...\"}}]}}",
        evidence.join("\n")
    );
    let Some(text) = complete(&prompt, 2400) else { return Vec::new() };
    let Ok(held) = serde_json::from_str::<Proposed>(carved(&text)) else { return Vec::new() };
    let mut outcomes: Vec<Outcome> = held
        .outcomes
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
        .collect();
    outcomes.sort_by(|left, right| left.name.cmp(&right.name));
    outcomes.dedup_by(|left, right| left.name == right.name);
    outcomes.truncate(24);
    outcomes
}

pub fn name_them(member: &str, evidence: &BTreeMap<String, String>) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    if !asked() || evidence.is_empty() {
        return named;
    }
    let listed: Vec<String> = evidence
        .iter()
        .map(|(id, facts)| format!("- id: {id}\n{facts}"))
        .collect();
    let batches: Vec<BTreeMap<String, Written>> = listed
        .par_chunks(NAMED_PER_CALL)
        .map(|batch| name_batch(member, batch))
        .collect();
    for batch in batches {
        named.extend(batch);
    }
    named
}

fn name_batch(member: &str, listed: &[String]) -> BTreeMap<String, Written> {
    let mut named = BTreeMap::new();
    let prompt = format!(
        "You are naming the {member} of a software system from facts extracted from its code.\n\
         Rules: say only what the facts say. Never name a technology, vendor or product that does \
         not appear in the facts. Never invent a purpose, an audience or a behaviour the facts do \
         not state. A name is 2-5 words. For a data entity, the description says what the record \
         is and what it holds, using the field names given. For an outcome, name the thing someone \
         gets from the system, taking the words from the operation names given — never name the \
         database, the storage or the code mechanism, and never use the words create, update, \
         delete, select or query on their own.\n\n\
         Echo each id back exactly as given.\n\
         Return JSON only: {{\"items\":[{{\"id\":\"...\",\"name\":\"...\",\"description\":\"...\"}}]}}\n\n\
         The {member}:\n{}",
        listed.join("\n\n")
    );
    let Some(text) = complete(&prompt, 2400) else { return named };
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("author raw: {}", &text[..text.len().min(400)]);
    }
    let Ok(written) = serde_json::from_str::<serde_json::Value>(carved(&text)) else { return named };
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
    let asked: Vec<(&String, &Written)> = written.iter().collect();
    asked
        .par_iter()
        .filter_map(|(id, held)| {
            let facts = evidence.get(*id)?;
            Some(((*id).clone(), grounding_of(held, facts)))
        })
        .collect()
}

fn grounding_of(held: &Written, facts: &str) -> Grounding {
    {
        let state = format!(
            "FACTS extracted from code:\n{facts}\n\nPROPOSED NAME: {}\nPROPOSED DESCRIPTION: {}",
            held.name, held.description
        );
        let questions = BTreeMap::from([
            (
                "outcome".to_string(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: "The proposed name describes something a person gets from the system, rather than a database operation or a code mechanism".to_string(),
                    criteria: BTreeMap::new().into(),
                },
            ),
            (
                "supported".to_string(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: "Every claim in the proposed name and description is supported by the facts".to_string(),
                    criteria: BTreeMap::new().into(),
                },
            ),
            (
                "invented".to_string(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: "The name or description mentions a technology, vendor or system that does not appear in the facts".to_string(),
                    criteria: BTreeMap::new().into(),
                },
            ),
            (
                "specific".to_string(),
                crate::jev::Question {
                    kind: "score",
                    instructions: "How specific this is to these facts rather than generic".to_string(),
                    criteria: vec![
                        "Generic; could describe any system".to_string(),
                        "Names the domain but little else".to_string(),
                        "Names what only this part of the system does".to_string(),
                    ]
                    .into(),
                },
            ),
        ]);
        let answers = crate::jev::decide(&state, questions);
        let supported = answers.get("supported").map(crate::jev::Decision::settled).unwrap_or(0.0);
        let invented = answers.get("invented").map(crate::jev::Decision::settled).unwrap_or(1.0);
        let specific = answers
            .get("specific")
            .and_then(|held| held.score)
            .map(|score| (score * 10.0).round() / 10.0)
            .unwrap_or(0.0);
        let outcome = answers.get("outcome").map(crate::jev::Decision::settled).unwrap_or(0.0);
        Grounding { supported, invented, specific, outcome, universal: None }
    }
}

pub fn test_capability(facts: &str) -> Grounding {
    let questions = BTreeMap::from([
        (
            "supported".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "Every claim in the proposed capability and description is supported by the facts".to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "invented".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "The proposal names a specific third-party product, vendor, brand or technology — a payment provider, a cloud service, a database engine, a named library — that does not appear in the facts. Ordinary words for the people who use the system and for what it does are not that.".to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "outcome".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "This is something the product's own audience came for — it would appear in a product description, a user objective, a business offering or an operational responsibility".to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "universal".to_string(),
            crate::jev::Question {
                kind: "noul",
                instructions: "This would be true of most codebases, so it is infrastructure rather than something this product offers".to_string(),
                criteria: BTreeMap::new().into(),
            },
        ),
        (
            "specific".to_string(),
            crate::jev::Question {
                kind: "score",
                instructions: "How specific this is to these facts rather than generic".to_string(),
                criteria: vec![
                    "Generic; could describe any system".to_string(),
                    "Names the domain but little else".to_string(),
                    "Names what only this part of the system does".to_string(),
                ]
                .into(),
            },
        ),
    ]);
    let answers = crate::jev::decide(facts, questions);
    let settled = |named: &str, fallback: f64| {
        answers.get(named).map(crate::jev::Decision::settled).unwrap_or(fallback)
    };
    Grounding {
        supported: settled("supported", 0.0),
        invented: settled("invented", 1.0),
        outcome: settled("outcome", 0.0),
        universal: Some(settled("universal", 1.0)),
        specific: answers
            .get("specific")
            .and_then(|held| held.score)
            .map(|score| (score * 10.0).round() / 10.0)
            .unwrap_or(0.0),
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

    pub fn reads_as_an_outcome(&self) -> bool {
        self.holds() && self.outcome >= GROUNDED
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

fn complete(prompt: &str, most: u32) -> Option<String> {
    match spoken_to() {
        Some(command) => spoken(&command, prompt),
        None => {
            let body = serde_json::json!({
                "model": model(),
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
                "max_tokens": most,
                "temperature": 0,
            });
            let request = serde_json::to_string(&body).ok()?;
            let answer = ask(&request)?;
            let parsed = serde_json::from_str::<serde_json::Value>(&answer).ok()?;
            parsed["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string)
        }
    }
}

fn spoken(command: &str, prompt: &str) -> Option<String> {
    let request = format!("{command}\u{0}{prompt}");
    if let Some(held) = crate::jev::remembered(&request) {
        return Some(held);
    }
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
    let text = String::from_utf8(answered.stdout).ok()?;
    crate::jev::remember(&request, &text);
    Some(text)
}

fn ask(request: &str) -> Option<String> {
    if let Some(held) = crate::jev::remembered(request) {
        return Some(held);
    }
    let key = key()?;
    let mut call = Command::new("curl")
        .args([
            "--silent",
            "--max-time",
            SECONDS,
            "-X",
            "POST",
            &endpoint(),
            "-H",
            &format!("Authorization: Bearer {key}"),
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    call.stdin.as_mut()?.write_all(request.as_bytes()).ok()?;
    let answered = call.wait_with_output().ok()?;
    let text = answered
        .status
        .success()
        .then(|| String::from_utf8(answered.stdout).ok())
        .flatten()?;
    crate::jev::remember(request, &text);
    Some(text)
}

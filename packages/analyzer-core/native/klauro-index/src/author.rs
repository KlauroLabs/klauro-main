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
}

#[derive(Debug, Deserialize)]
pub struct Written {
    pub id: String,
    pub name: String,
    pub description: String,
}

fn key() -> Option<String> {
    ["KLAURO_AUTHOR_KEY", "DEEPINFRA_API_KEY"]
        .into_iter()
        .find_map(|named| std::env::var(named).ok())
        .filter(|key| !key.is_empty())
}

pub fn asked() -> bool {
    std::env::var("KLAURO_ENRICH").map(|held| held != "0").unwrap_or(true) && key().is_some()
}

fn endpoint() -> String {
    std::env::var("KLAURO_AUTHOR_ENDPOINT").unwrap_or_else(|_| ENDPOINT.to_string())
}

fn model() -> String {
    std::env::var("KLAURO_AUTHOR_MODEL")
        .unwrap_or_else(|_| "meta-llama/Llama-3.3-70B-Instruct".to_string())
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
    let body = serde_json::json!({
        "model": model(),
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
        "max_tokens": 2400,
        "temperature": 0,
    });
    let Ok(request) = serde_json::to_string(&body) else { return named };
    let Some(answer) = ask(&request) else {
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!("author: no answer");
        }
        return named;
    };
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("author raw: {}", &answer[..answer.len().min(600)]);
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&answer) else { return named };
    let Some(text) = parsed["choices"][0]["message"]["content"].as_str() else { return named };
    let Ok(written) = serde_json::from_str::<serde_json::Value>(text) else { return named };
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
        Grounding { supported, invented, specific, outcome }
    }
}

impl Grounding {
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

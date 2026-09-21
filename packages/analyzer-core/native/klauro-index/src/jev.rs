use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
const BYTES_PER_CALL: usize = 60_000;
const TRIES: usize = 5;

#[derive(Debug, Serialize)]
pub struct Question {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub instructions: String,
    #[serde(skip_serializing_if = "Criteria::is_empty")]
    pub criteria: Criteria,
}

#[derive(Debug)]
pub enum Criteria {
    Named(BTreeMap<String, String>),
    Ranked(Vec<String>),
}

impl Criteria {
    fn weight(&self) -> usize {
        match self {
            Criteria::Named(held) => {
                held.iter().map(|(key, value)| key.len() + value.len() + 6).sum()
            }
            Criteria::Ranked(held) => held.iter().map(|value| value.len() + 4).sum(),
        }
    }

    fn is_empty(&self) -> bool {
        match self {
            Criteria::Named(held) => held.is_empty(),
            Criteria::Ranked(held) => held.is_empty(),
        }
    }
}

impl Serialize for Criteria {
    fn serialize<S: serde::Serializer>(&self, writer: S) -> Result<S::Ok, S::Error> {
        match self {
            Criteria::Named(held) => held.serialize(writer),
            Criteria::Ranked(held) => held.serialize(writer),
        }
    }
}

impl From<BTreeMap<String, String>> for Criteria {
    fn from(held: BTreeMap<String, String>) -> Self {
        Criteria::Named(held)
    }
}

impl From<Vec<String>> for Criteria {
    fn from(held: Vec<String>) -> Self {
        Criteria::Ranked(held)
    }
}

#[derive(Debug, Deserialize)]
pub struct Decision {
    #[serde(default)]
    pub choice: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub noul: Option<f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

impl Decision {
    pub fn held(&self, floor: f64) -> Option<&str> {
        let choice = self.choice.as_deref()?;
        (self.confidence.unwrap_or(0.0) >= floor).then_some(choice)
    }

    pub fn settled(&self) -> f64 {
        match (self.noul, self.confidence) {
            (Some(noul), _) => (noul * 100.0).round() / 100.0,
            (None, Some(confidence)) => (confidence * 100.0).round() / 100.0,
            _ => 0.0,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Answered {
    answers: BTreeMap<String, Decision>,
}

pub fn asked() -> bool {
    std::env::var("KLAURO_ENRICH").map(|held| held != "0").unwrap_or(true)
        && std::env::var("TYPESAFE_API_KEY").is_ok_and(|key| !key.is_empty())
}

pub fn decide(state: &str, questions: BTreeMap<String, Question>) -> BTreeMap<String, Decision> {
    let mut answers = BTreeMap::new();
    if !asked() {
        return answers;
    }
    let asking: Vec<(String, Question)> = questions.into_iter().collect();
    let mut batches_of: Vec<Vec<(String, Question)>> = Vec::new();
    let mut held: Vec<(String, Question)> = Vec::new();
    let mut weight = 0;
    for (named, question) in asking {
        let size = named.len() + question.instructions.len() + question.criteria.weight() + 32;
        if weight + size > BYTES_PER_CALL && !held.is_empty() {
            batches_of.push(std::mem::take(&mut held));
            weight = 0;
        }
        weight += size;
        held.push((named, question));
    }
    if !held.is_empty() {
        batches_of.push(held);
    }
    let batches: Vec<BTreeMap<String, Decision>> = batches_of
        .par_iter()
        .map(|batch| {
            let batch = batch.as_slice();
            let body = serde_json::json!({
                "model": MODEL,
                "state": state,
                "questions": batch
                    .iter()
                    .map(|(named, question)| (named.clone(), question))
                    .collect::<BTreeMap<_, _>>(),
            });
            let Ok(request) = serde_json::to_string(&body) else {
                return BTreeMap::new();
            };
            let mut held = None;
            for attempt in 0..TRIES {
                held = ask(&request);
                if held.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500 << attempt));
            }
            match held {
                Some(answered) => answered.answers,
                None => {
                    eprintln!(
                        "  jev unanswered: {} questions in a request of {} bytes",
                        batch.len(),
                        request.len()
                    );
                    BTreeMap::new()
                }
            }
        })
        .collect();
    for batch in batches {
        answers.extend(batch);
    }
    answers
}

fn ask(request: &str) -> Option<Answered> {
    if let Some(held) = remembered(request) {
        return serde_json::from_str(&held).ok();
    }
    let key = std::env::var("TYPESAFE_API_KEY").ok()?;
    let text = crate::reach::post(ENDPOINT, &key, request)?;
    let held: Answered = serde_json::from_str(&text).ok()?;
    remember(request, &text);
    Some(held)
}

pub fn kept() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let folder = PathBuf::from(home).join(".klauro/model-answers");
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder)
}

pub fn named(request: &str) -> String {
    let mut hasher = rustc_hash::FxHasher::default();
    request.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), request.len())
}

pub fn remembered(request: &str) -> Option<String> {
    let held = std::fs::read_to_string(kept()?.join(named(request))).ok()?;
    let (asked, answered) = held.split_once('\u{0}')?;
    (asked == request).then(|| answered.to_string())
}

pub fn remember(request: &str, answered: &str) {
    let Some(folder) = kept() else { return };
    let _ = std::fs::write(folder.join(named(request)), format!("{request}\u{0}{answered}"));
}

use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
const BYTES_PER_CALL: usize = 60_000;

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

static UNANSWERED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn went_unanswered() -> u64 {
    UNANSWERED.load(std::sync::atomic::Ordering::Relaxed)
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
    let batches: Vec<BTreeMap<String, Decision>> = crate::author::asking(|| {
        batches_of
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
                let mut waited = std::time::Duration::ZERO;
                let longest_wait = crate::reach::longest_wait();
                let mut missed = 0u32;
                while waited < longest_wait {
                    match ask(&request) {
                        Reply::Answered(answered) => {
                            held = Some(answered);
                            break;
                        }
                        Reply::Refused => break,
                        Reply::Missed => {
                            let pause = crate::reach::pause_after(missed);
                            std::thread::sleep(pause);
                            waited += pause;
                            missed += 1;
                        }
                    }
                }
                match held {
                    Some(answered) => answered.answers,
                    None => {
                        UNANSWERED.fetch_add(batch.len() as u64, std::sync::atomic::Ordering::Relaxed);
                        eprintln!(
                            "  jev unanswered: {} questions in a request of {} bytes",
                            batch.len(),
                            request.len()
                        );
                        BTreeMap::new()
                    }
                }
            })
            .collect()
    });
    for batch in batches {
        answers.extend(batch);
    }
    answers
}

enum Reply {
    Answered(Answered),
    Missed,
    Refused,
}

fn ask(request: &str) -> Reply {
    if let Some(held) = remembered(request)
        && let Ok(answered) = serde_json::from_str(&held)
    {
        return Reply::Answered(answered);
    }
    let Ok(key) = std::env::var("TYPESAFE_API_KEY") else { return Reply::Refused };
    let started = std::time::Instant::now();
    let text = match crate::reach::asking(ENDPOINT, &key, request) {
        crate::reach::Answer::Held(text) => text,
        crate::reach::Answer::Refused => return Reply::Refused,
        crate::reach::Answer::Missed => return Reply::Missed,
    };
    if std::env::var("KLAURO_AUTHOR_TRACE").is_ok() {
        eprintln!("jev took {:>6}ms in {:>6} out {:>6}", started.elapsed().as_millis(), request.len(), text.len());
    }
    let Ok(held) = serde_json::from_str::<Answered>(&text) else { return Reply::Missed };
    remember(request, &text);
    Reply::Answered(held)
}

pub fn kept() -> Option<PathBuf> {
    let folder = match std::env::var("KLAURO_AI_CACHE_PATH").ok().filter(|held| !held.is_empty()) {
        Some(held) => PathBuf::from(held).join("model-answers"),
        None => PathBuf::from(std::env::var("HOME").ok()?).join(".klauro/model-answers"),
    };
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder)
}

pub fn named(request: &str) -> String {
    let mut hasher = rustc_hash::FxHasher::default();
    request.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), request.len())
}

pub fn afresh() -> bool {
    std::env::var("KLAURO_FORCE_AI_REFRESH").is_ok_and(|held| held != "0")
}

pub fn remembered(request: &str) -> Option<String> {
    if afresh() {
        return None;
    }
    let held = std::fs::read_to_string(kept()?.join(named(request))).ok()?;
    let (asked, answered) = held.split_once('\u{0}')?;
    (asked == request).then(|| answered.to_string())
}

pub fn remember(request: &str, answered: &str) {
    let Some(folder) = kept() else { return };
    let _ = std::fs::write(folder.join(named(request)), format!("{request}\u{0}{answered}"));
}

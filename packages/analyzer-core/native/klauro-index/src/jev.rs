use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
const QUESTIONS_PER_CALL: usize = 48;
const SECONDS: &str = "20";

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
    let batches: Vec<BTreeMap<String, Decision>> = asking
        .par_chunks(QUESTIONS_PER_CALL)
        .map(|batch| {
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
            ask(&request).map(|answered| answered.answers).unwrap_or_default()
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
    let mut call = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--max-time",
            SECONDS,
            "-X",
            "POST",
            ENDPOINT,
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
    if !answered.status.success() {
        return None;
    }
    let text = String::from_utf8(answered.stdout).ok()?;
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

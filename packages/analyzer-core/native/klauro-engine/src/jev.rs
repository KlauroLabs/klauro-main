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
    #[serde(default)]
    pub probabilities: Option<BTreeMap<String, f64>>,
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

static DECLINED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn declined() -> bool {
    DECLINED.load(std::sync::atomic::Ordering::Relaxed)
}

fn deciders() -> Vec<String> {
    match std::env::var("KLAURO_DECIDERS").ok().filter(|held| !held.trim().is_empty()) {
        Some(held) => held.split(',').map(|endpoint| endpoint.trim().to_string()).filter(|endpoint| !endpoint.is_empty()).collect(),
        None => vec![ENDPOINT.to_string()],
    }
}

fn host_of(endpoint: &str) -> Option<&str> {
    let rest = endpoint.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    Some(host.split(':').next().unwrap_or(host))
}

fn key_for(endpoint: &str) -> Option<String> {
    let owned = host_of(endpoint).is_some_and(|host| host.eq_ignore_ascii_case("api.typesafe.ai"));
    match owned {
        true => std::env::var("TYPESAFE_API_KEY").ok().filter(|key| !key.is_empty()),
        false => Some(String::new()),
    }
}

pub fn asked() -> bool {
    std::env::var("KLAURO_ENRICH").map(|held| held != "0").unwrap_or(true)
        && deciders().iter().any(|endpoint| key_for(endpoint).is_some())
        && !declined()
        && !crate::spend::exhausted()
}

pub fn decide(state: &str, questions: BTreeMap<String, Question>) -> BTreeMap<String, Decision> {
    decide_at(state, questions, crate::author::JOINING)
}

pub fn decide_at(state: &str, questions: BTreeMap<String, Question>, urgency: u8) -> BTreeMap<String, Decision> {
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
    let weight = crate::author::weight();
    let batches: Vec<BTreeMap<String, Decision>> = crate::author::asking(|| {
        batches_of
            .par_iter()
            .map(|batch| crate::author::weighing(weight, || {
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
                    match ask(&request, crate::author::priority(urgency)) {
                        Reply::Answered(answered) => {
                            held = Some(answered);
                            break;
                        }
                        Reply::Refused | Reply::Declined => break,
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
                    None if declined() => BTreeMap::new(),
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
            }))
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
    Declined,
}

fn ask(request: &str, urgency: u64) -> Reply {
    if let Some(held) = remembered(request)
        && let Ok(answered) = serde_json::from_str(&held)
    {
        return Reply::Answered(answered);
    }
    if declined() {
        return Reply::Declined;
    }
    let reachable: Vec<(String, String)> = deciders().into_iter().filter_map(|endpoint| key_for(&endpoint).map(|key| (endpoint, key))).collect();
    let mut outcome = Reply::Refused;
    let mut text = None;
    for (endpoint, key) in &reachable {
        let started = std::time::Instant::now();
        match crate::reach::asking(endpoint, key, request, urgency) {
            crate::reach::Answer::Held(held) => {
                if std::env::var("KLAURO_AUTHOR_TRACE").is_ok() {
                    eprintln!("decided at {endpoint} in {:>6}ms in {:>6} out {:>6}", started.elapsed().as_millis(), request.len(), held.len());
                }
                text = Some(held);
                break;
            }
            crate::reach::Answer::Refused => {}
            crate::reach::Answer::Unauthorized => {
                if reachable.len() == 1 && !DECLINED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    eprintln!("  jev not asked: its backend does not accept TYPESAFE_API_KEY");
                }
                if reachable.len() == 1 {
                    return Reply::Declined;
                }
            }
            crate::reach::Answer::Missed => outcome = Reply::Missed,
        }
    }
    let Some(text) = text else { return outcome };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_decision_key_goes_only_to_the_decision_service_over_https() {
        assert_eq!(host_of("https://api.typesafe.ai/v1/systemone"), Some("api.typesafe.ai"));
        assert_eq!(host_of("https://api.typesafe.ai:443/v1/systemone"), Some("api.typesafe.ai"));
        assert_eq!(host_of("https://api.typesafe.ai.example.com/v1"), Some("api.typesafe.ai.example.com"));
        assert_eq!(host_of("https://example.com/typesafe.ai"), Some("example.com"));
        assert_eq!(host_of("https://api.typesafe.ai@example.com/v1"), Some("example.com"));
        assert_eq!(host_of("http://api.typesafe.ai/v1"), None);
        for elsewhere in ["https://api.typesafe.ai.example.com/v1", "https://example.com/typesafe.ai", "https://api.typesafe.ai@example.com/v1", "http://api.typesafe.ai/v1", "https://macbook-ai.example.ts.net/decide"] {
            assert_eq!(key_for(elsewhere), Some(String::new()), "{elsewhere} never receives the key");
        }
    }
}

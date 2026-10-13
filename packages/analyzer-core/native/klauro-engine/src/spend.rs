use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const MICROS: f64 = 1_000_000.0;
const JEV_PER_INPUT_TOKEN: f64 = 0.042 / MICROS;
const WRITER_PER_INPUT_TOKEN: f64 = 0.10 / MICROS;
const WRITER_PER_CACHED_TOKEN: f64 = 0.01 / MICROS;
const WRITER_PER_OUTPUT_TOKEN: f64 = 0.50 / MICROS;
const TARGET: f64 = 0.10;
const CEILING: f64 = 0.25;
const DECISIONS_CEILING: f64 = 0.05;

static WRITER: AtomicU64 = AtomicU64::new(0);
static DECIDER: AtomicU64 = AtomicU64::new(0);
static DECIDER_TOKENS: AtomicU64 = AtomicU64::new(0);
static STOPPED: AtomicBool = AtomicBool::new(false);
static DECISIONS_STOPPED: AtomicBool = AtomicBool::new(false);

fn dollars(from: &str, fallback: f64) -> f64 {
    std::env::var(from).ok().and_then(|held| held.parse().ok()).unwrap_or(fallback)
}

fn ceiling() -> f64 {
    dollars("KLAURO_AI_CEILING_USD", CEILING)
}

pub(crate) fn priced(endpoint: &str, answer: &str) -> (bool, f64, u64) {
    let Ok(held) = serde_json::from_str::<serde_json::Value>(answer) else { return (false, 0.0, 0) };
    let usage = &held["usage"];
    let count = |at: &serde_json::Value| at.as_u64().unwrap_or_default();
    if endpoint.contains("typesafe") || held["model"].as_str().is_some_and(|model| model.starts_with("jev")) {
        let tokens = count(&usage["input_tokens"]);
        return (true, tokens as f64 * dollars("KLAURO_JEV_PER_MILLION_USD", JEV_PER_INPUT_TOKEN * MICROS) / MICROS, tokens);
    }
    if let Some(cost) = usage["cost"].as_f64() {
        return (false, cost, 0);
    }
    let cached = count(&usage["prompt_tokens_details"]["cached_tokens"]);
    let fresh = count(&usage["prompt_tokens"]).saturating_sub(cached);
    (false, fresh as f64 * WRITER_PER_INPUT_TOKEN + cached as f64 * WRITER_PER_CACHED_TOKEN + count(&usage["completion_tokens"]) as f64 * WRITER_PER_OUTPUT_TOKEN, 0)
}

pub(crate) fn charge(endpoint: &str, answer: &str) {
    let (decider, cost, tokens) = priced(endpoint, answer);
    let micros = (cost * MICROS).round() as u64;
    match decider {
        true => {
            DECIDER.fetch_add(micros, Ordering::Relaxed);
            DECIDER_TOKENS.fetch_add(tokens, Ordering::Relaxed);
        }
        false => {
            WRITER.fetch_add(micros, Ordering::Relaxed);
        }
    }
    let decided = DECIDER.load(Ordering::Relaxed) as f64 / MICROS;
    let decisions_ceiling = dollars("KLAURO_DECISIONS_CEILING_USD", DECISIONS_CEILING);
    if decided >= decisions_ceiling && !DECISIONS_STOPPED.swap(true, Ordering::Relaxed) {
        eprintln!("  decision service not asked any more: this run has spent ${decided:.4} of its ${decisions_ceiling:.2} decisions ceiling; the writer answers the rest");
    }
    if spent() >= ceiling() && !STOPPED.swap(true, Ordering::Relaxed) {
        eprintln!("  AI not asked any more: this run has spent ${:.4} of its ${:.2} ceiling; what is left unanswered stays pending", spent(), ceiling());
    }
}

pub(crate) fn spent() -> f64 {
    (WRITER.load(Ordering::Relaxed) + DECIDER.load(Ordering::Relaxed)) as f64 / MICROS
}

pub(crate) fn decisions_exhausted() -> bool {
    DECISIONS_STOPPED.load(Ordering::Relaxed)
}

pub(crate) fn exhausted() -> bool {
    STOPPED.load(Ordering::Relaxed)
}

pub(crate) fn said() -> String {
    let writer = WRITER.load(Ordering::Relaxed) as f64 / MICROS;
    let decider = DECIDER.load(Ordering::Relaxed) as f64 / MICROS;
    format!(
        "ai spend ${:.4} of a ${TARGET:.2} target (writer ${writer:.4}, decisions ${decider:.4} for {} tokens){}",
        writer + decider,
        DECIDER_TOKENS.load(Ordering::Relaxed),
        if exhausted() { format!(", stopped at the ${:.2} ceiling", ceiling()) } else { String::new() }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_decision_is_priced_by_its_input_tokens_and_a_written_answer_by_what_it_reports() {
        let (decider, cost, tokens) = priced("https://api.typesafe.ai/v1/systemone", r#"{"model":"jev-1.13.0","usage":{"input_tokens":1000000,"output_tokens":5}}"#);
        assert!(decider);
        assert_eq!(tokens, 1_000_000);
        assert!((cost - 0.042).abs() < 1e-9);
        let (decider, cost, _) = priced("https://openrouter.ai/api/v1/chat/completions", r#"{"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.0123}}"#);
        assert!(!decider);
        assert!((cost - 0.0123).abs() < 1e-9);
        let (_, cost, _) = priced("https://example.test/v1", r#"{"usage":{"prompt_tokens":1000000,"completion_tokens":1000000,"prompt_tokens_details":{"cached_tokens":500000}}}"#);
        assert!((cost - (0.05 + 0.005 + 0.5)).abs() < 1e-9);
    }
}

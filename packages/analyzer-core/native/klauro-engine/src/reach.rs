use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

static HELD: OnceLock<ureq::Agent> = OnceLock::new();
static ASKED: AtomicUsize = AtomicUsize::new(0);

pub fn asked() -> usize {
    ASKED.load(Ordering::Relaxed)
}

struct Occupancy {
    now: usize,
    peak: usize,
    since: Option<Instant>,
    first: Option<Instant>,
    area: f64,
}

static OCCUPIED: Mutex<Occupancy> = Mutex::new(Occupancy { now: 0, peak: 0, since: None, first: None, area: 0.0 });

fn occupied(by: isize) {
    let Ok(mut held) = OCCUPIED.lock() else { return };
    let now = Instant::now();
    if let Some(since) = held.since {
        held.area += held.now as f64 * now.duration_since(since).as_secs_f64();
    }
    held.first.get_or_insert(now);
    held.since = Some(now);
    held.now = held.now.saturating_add_signed(by);
    held.peak = held.peak.max(held.now);
}

pub fn concurrency() -> (f64, usize) {
    let Ok(held) = OCCUPIED.lock() else { return (0.0, 0) };
    let span = match (held.first, held.since) {
        (Some(first), Some(last)) => last.duration_since(first).as_secs_f64(),
        _ => 0.0,
    };
    (if span > 0.0 { held.area / span } else { 0.0 }, held.peak)
}

fn agent() -> &'static ureq::Agent {
    HELD.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(300)))
            .max_idle_connections(64)
            .max_idle_connections_per_host(64)
            .build()
            .into()
    })
}

const LONGEST_WAIT_FOR_AN_ANSWER: Duration = Duration::from_secs(600);

pub fn longest_wait() -> Duration {
    std::env::var("KLAURO_AI_WAIT_SECONDS")
        .ok()
        .and_then(|held| held.parse::<u64>().ok())
        .map_or(LONGEST_WAIT_FOR_AN_ANSWER, Duration::from_secs)
}

pub fn pause_after(missed: u32) -> Duration {
    Duration::from_millis(500u64 << missed.min(5))
}

pub enum Answer {
    Held(String),
    Refused,
    Missed,
}

pub fn asking(endpoint: &str, key: &str, request: &str) -> Answer {
    let at = ASKED.fetch_add(1, Ordering::Relaxed);
    let telling = std::env::var("KLAURO_REACH_DEBUG").is_ok();
    let started = std::time::Instant::now();
    if telling {
        eprintln!("    reach {at} start {:?}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 1_000_000);
    }
    occupied(1);
    let answered = agent()
        .post(endpoint)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(request);
    occupied(-1);
    if telling {
        eprintln!("    reach {at} done  {:?} after {:?}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 1_000_000, started.elapsed());
    }
    match answered {
        Ok(mut held) => match held.body_mut().read_to_string() {
            Ok(text) => Answer::Held(text),
            Err(_) => Answer::Missed,
        },
        Err(ureq::Error::StatusCode(status)) if (400..500).contains(&status) && status != 429 => {
            Answer::Refused
        }
        Err(_) => Answer::Missed,
    }
}

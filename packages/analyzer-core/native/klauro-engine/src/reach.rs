use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

static HELD: OnceLock<ureq::Agent> = OnceLock::new();
static ASKED: AtomicUsize = AtomicUsize::new(0);

fn telling_graph() -> bool {
    std::env::var("KLAURO_ASK_GRAPH").is_ok()
}

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

#[derive(Clone)]
pub enum Answer {
    Held(String),
    Refused,
    Missed,
}

struct Places {
    free: usize,
    next: u64,
    waiting: BinaryHeap<(u64, Reverse<u64>)>,
}

static PLACES: OnceLock<(Mutex<Places>, Condvar)> = OnceLock::new();

fn places() -> &'static (Mutex<Places>, Condvar) {
    PLACES.get_or_init(|| {
        (
            Mutex::new(Places { free: crate::budget::ai_concurrency(), next: 0, waiting: BinaryHeap::new() }),
            Condvar::new(),
        )
    })
}

struct Place;

fn taken(urgency: u64) -> Place {
    let (lock, opened) = places();
    let Ok(mut held) = lock.lock() else { return Place };
    let ticket = (urgency, Reverse(held.next));
    held.next += 1;
    held.waiting.push(ticket);
    loop {
        if held.free > 0 && held.waiting.peek() == Some(&ticket) {
            held.waiting.pop();
            held.free -= 1;
            return Place;
        }
        held = match opened.wait(held) {
            Ok(held) => held,
            Err(_) => return Place,
        };
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        let (lock, opened) = places();
        if let Ok(mut held) = lock.lock() {
            held.free += 1;
        }
        opened.notify_all();
    }
}

struct Flight {
    answer: Mutex<Option<Answer>>,
    landed: Condvar,
}

static FLIGHTS: OnceLock<Mutex<HashMap<String, Arc<Flight>>>> = OnceLock::new();

pub fn asking(endpoint: &str, key: &str, request: &str, urgency: u64) -> Answer {
    let flights = FLIGHTS.get_or_init(Mutex::default);
    let named = format!("{endpoint}\u{0}{request}");
    let (flight, leading) = {
        let Ok(mut held) = flights.lock() else { return sent(endpoint, key, request, urgency) };
        match held.get(&named) {
            Some(flight) => (flight.clone(), false),
            None => {
                let flight = Arc::new(Flight { answer: Mutex::new(None), landed: Condvar::new() });
                held.insert(named.clone(), flight.clone());
                (flight, true)
            }
        }
    };
    if leading {
        let answer = sent(endpoint, key, request, urgency);
        if let Ok(mut held) = flight.answer.lock() {
            *held = Some(answer.clone());
        }
        flight.landed.notify_all();
        if let Ok(mut held) = flights.lock() {
            held.remove(&named);
        }
        return answer;
    }
    let Ok(mut held) = flight.answer.lock() else { return Answer::Missed };
    loop {
        if let Some(answer) = held.as_ref() {
            return answer.clone();
        }
        held = match flight.landed.wait(held) {
            Ok(held) => held,
            Err(_) => return Answer::Missed,
        };
    }
}

fn sent(endpoint: &str, key: &str, request: &str, urgency: u64) -> Answer {
    let waited = Instant::now();
    let _place = taken(urgency);
    if std::env::var("KLAURO_ASK_GRAPH").is_ok() {
        eprintln!("GATE {} {urgency}", waited.elapsed().as_millis());
    }
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
        Err(failed) => {
            if telling_graph() {
                eprintln!("FAIL {:?} {failed}", started.elapsed());
            }
            Answer::Missed
        }
    }
}

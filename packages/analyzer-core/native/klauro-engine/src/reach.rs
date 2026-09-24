use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

static HELD: OnceLock<ureq::Agent> = OnceLock::new();
static ASKED: AtomicUsize = AtomicUsize::new(0);

pub fn asked() -> usize {
    ASKED.load(Ordering::Relaxed)
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

pub enum Answer {
    Held(String),
    Refused,
    Missed,
}

pub fn post(endpoint: &str, key: &str, request: &str) -> Option<String> {
    match asking(endpoint, key, request) {
        Answer::Held(text) => Some(text),
        _ => None,
    }
}

pub fn asking(endpoint: &str, key: &str, request: &str) -> Answer {
    let at = ASKED.fetch_add(1, Ordering::Relaxed);
    let telling = std::env::var("KLAURO_REACH_DEBUG").is_ok();
    let started = std::time::Instant::now();
    if telling {
        eprintln!("    reach {at} start {:?}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 1_000_000);
    }
    let answered = agent()
        .post(endpoint)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(request);
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

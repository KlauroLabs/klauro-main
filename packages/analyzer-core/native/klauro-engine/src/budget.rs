const MEGABYTE: u64 = 1 << 20;
const UNBOUNDED_FROM: u64 = 1 << 60;
const TRANSIENT_PER_WORKER: u64 = 64 * MEGABYTE;
const WORKERS_SHARE: u64 = 8;

pub fn limit() -> Option<u64> {
    if let Ok(held) = std::env::var("KLAURO_MEMORY_BUDGET_MB") {
        return held.trim().parse::<u64>().ok().filter(|megabytes| *megabytes > 0).map(|megabytes| megabytes * MEGABYTE);
    }
    ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]
        .iter()
        .filter_map(|file| std::fs::read_to_string(file).ok())
        .find_map(|text| parse_limit(&text))
}

pub fn parse_limit(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok().filter(|bytes| *bytes > 0 && *bytes < UNBOUNDED_FROM)
}

pub fn workers(limit: Option<u64>, available: usize) -> usize {
    match limit {
        None => available,
        Some(bytes) => available.min((bytes / WORKERS_SHARE / TRANSIENT_PER_WORKER).max(1) as usize),
    }
}

const AI_CONCURRENCY: usize = 16;

pub fn asks_in_flight(held: Option<&str>) -> usize {
    held.and_then(|text| text.trim().parse::<usize>().ok()).filter(|places| *places > 0).unwrap_or(AI_CONCURRENCY)
}

pub fn ai_concurrency() -> usize {
    asks_in_flight(std::env::var("KLAURO_AI_CONCURRENCY").ok().as_deref())
}

pub fn pool_size() -> usize {
    let available = std::thread::available_parallelism().map(|held| held.get()).unwrap_or(1);
    workers(limit(), available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cgroup_limit_is_read_and_unbounded_values_are_not_a_limit() {
        assert_eq!(parse_limit("2147483648\n"), Some(2 << 30));
        assert_eq!(parse_limit("max\n"), None);
        assert_eq!(parse_limit("9223372036854771712"), None);
        assert_eq!(parse_limit("0"), None);
        assert_eq!(parse_limit(""), None);
    }

    #[test]
    fn no_limit_leaves_every_worker_and_an_ample_one_does_too() {
        assert_eq!(workers(None, 10), 10);
        assert_eq!(workers(Some(16 << 30), 10), 10);
        assert_eq!(workers(Some(64 << 30), 64), 64);
    }

    #[test]
    fn asks_in_flight_follow_the_setting_and_default_to_sixteen() {
        assert_eq!(asks_in_flight(None), 16);
        assert_eq!(asks_in_flight(Some("24")), 24);
        assert_eq!(asks_in_flight(Some(" 8 ")), 8);
        assert_eq!(asks_in_flight(Some("0")), 16);
        assert_eq!(asks_in_flight(Some("many")), 16);
    }

    #[test]
    fn a_small_limit_narrows_the_workers_but_never_below_one() {
        assert_eq!(workers(Some(2 << 30), 10), 4);
        assert_eq!(workers(Some(1 << 30), 10), 2);
        assert_eq!(workers(Some(64 << 20), 10), 1);
    }
}

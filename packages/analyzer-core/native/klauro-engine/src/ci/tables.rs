use std::sync::OnceLock;

use regex::Regex;
use rustc_hash::FxHashMap;

static PROVIDERS: &str = include_str!("../../data/ci_providers.tsv");
static KEYS: &str = include_str!("../../data/ci_keys.tsv");
static TRIGGERS: &str = include_str!("../../data/ci_triggers.tsv");
static REFERENCES: &str = include_str!("../../data/ci_references.tsv");
static ACTIONS: &str = include_str!("../../data/ci_actions.tsv");
static COMMANDS: &str = include_str!("../../data/ci_commands.tsv");
static JENKINS: &str = include_str!("../../data/ci_jenkins.tsv");

pub struct Detected {
    pub provider: &'static str,
    pub layout: &'static str,
}

pub struct Trigger {
    pub mode: &'static str,
    pub key: &'static str,
    pub event: &'static str,
}

pub struct Command {
    pub kind: &'static str,
    pub pattern: Regex,
    pub target: Option<Regex>,
    pub paths: Option<Regex>,
}

fn rows(table: &'static str) -> impl Iterator<Item = Vec<&'static str>> {
    table.lines().filter(|row| !row.trim().is_empty()).map(|row| row.split('\t').collect())
}

fn compiled(pattern: &str) -> Option<Regex> {
    Some(pattern).filter(|held| !held.is_empty()).and_then(|held| Regex::new(held).ok())
}

pub fn detect(path: &str) -> Option<Detected> {
    let lower = path.to_ascii_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    let yaml = basename.ends_with(".yml") || basename.ends_with(".yaml");
    rows(PROVIDERS).find_map(|row| {
        let (provider, layout, mode, pattern) = (row[0], row[1], row[2], row[3]);
        let held = match mode {
            "name" => basename == pattern,
            "prefix" => basename.starts_with(pattern),
            "path" => lower == pattern || lower.ends_with(&format!("/{pattern}")),
            "dir" => yaml && (lower.starts_with(&format!("{pattern}/")) || lower.contains(&format!("/{pattern}/"))),
            _ => false,
        };
        held.then_some(Detected { provider, layout })
    })
}

pub fn keys(role: &str) -> &'static [&'static str] {
    static HELD: OnceLock<FxHashMap<&'static str, Vec<&'static str>>> = OnceLock::new();
    HELD.get_or_init(|| rows(KEYS).map(|row| (row[0], row[1].split(',').collect())).collect())
        .get(role)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn triggers(provider: &str) -> Vec<Trigger> {
    rows(TRIGGERS)
        .filter(|row| row[0] == provider || row[0] == "*")
        .map(|row| Trigger { mode: row[1], key: row[2], event: row.get(3).copied().unwrap_or("") })
        .collect()
}

pub fn references() -> &'static [(&'static str, Regex)] {
    static HELD: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    HELD.get_or_init(|| {
        rows(REFERENCES)
            .filter_map(|row| Some((row[0], Regex::new(row[1]).ok()?)))
            .collect()
    })
}

pub fn actions() -> &'static [(&'static str, String)] {
    static HELD: OnceLock<Vec<(&'static str, String)>> = OnceLock::new();
    HELD.get_or_init(|| rows(ACTIONS).map(|row| (row[0], row[1].to_ascii_lowercase())).collect())
}

pub fn commands() -> &'static [Command] {
    static HELD: OnceLock<Vec<Command>> = OnceLock::new();
    HELD.get_or_init(|| {
        rows(COMMANDS)
            .filter_map(|row| {
                Some(Command {
                    kind: row[0],
                    pattern: Regex::new(row[1]).ok()?,
                    target: row.get(2).and_then(|held| compiled(held)),
                    paths: row.get(3).and_then(|held| compiled(held)),
                })
            })
            .collect()
    })
}

pub fn jenkins(kind: &str) -> Option<&'static Regex> {
    static HELD: OnceLock<FxHashMap<&'static str, Regex>> = OnceLock::new();
    HELD.get_or_init(|| rows(JENKINS).filter_map(|row| Some((row[0], Regex::new(row[1]).ok()?))).collect())
        .get(kind)
}

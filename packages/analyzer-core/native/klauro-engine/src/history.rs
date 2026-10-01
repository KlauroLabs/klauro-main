use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use std::path::Path;
use std::process::Command;

use serde::Serialize;

const COMMITS_READ: usize = 2000;
const WIDE_COMMIT: usize = 50;
const RANKED: usize = 50;

#[derive(Debug, Serialize)]
pub struct Churn {
    pub path: String,
    pub commits: u32,
    pub authors: u32,
    pub last: i64,
}

#[derive(Debug, Serialize)]
pub struct CoChange {
    pub path: String,
    pub with: String,
    pub commits: u32,
}

#[derive(Debug, Serialize)]
pub struct History {
    pub commits: u32,
    pub touched: u32,
    pub churn: Vec<Churn>,
    pub co_change: Vec<CoChange>,
    #[serde(skip)]
    pub per_file: Vec<(String, u32)>,
}

fn holds_itself(root: &Path) -> bool {
    let Ok(top) = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
    else {
        return false;
    };
    if !top.status.success() {
        return false;
    }
    let named = String::from_utf8_lossy(&top.stdout);
    let held = Path::new(named.trim());
    match (held.canonicalize(), root.canonicalize()) {
        (Ok(held), Ok(root)) => held == root,
        _ => false,
    }
}

pub fn read(root: &Path, files: &[String]) -> Option<History> {
    if !holds_itself(root) {
        return None;
    }
    let held: HashSet<&str> = files.iter().map(String::as_str).collect();
    let log = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "log",
            "--no-merges",
            "--name-only",
            "--pretty=format:\u{1}%at\u{1}%ae",
            &format!("-n{COMMITS_READ}"),
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&log.stdout);

    let mut commits = 0;
    let mut touched: HashMap<&str, (u32, HashSet<&str>, i64)> = HashMap::default();
    let mut together: HashMap<(&str, &str), u32> = HashMap::default();
    let mut when = 0;
    let mut author = "";
    let mut pending: Vec<&str> = Vec::new();
    for line in text.lines() {
        if let Some(header) = line.strip_prefix('\u{1}') {
            record(&mut together, &pending);
            pending.clear();
            commits += 1;
            let mut parts = header.split('\u{1}');
            when = parts.next().and_then(|at| at.parse().ok()).unwrap_or(0);
            author = parts.next().unwrap_or("");
            continue;
        }
        let path = line.trim();
        if path.is_empty() || !held.contains(path) {
            continue;
        }
        let Some(held) = held.get(path) else { continue };
        let entry = touched.entry(held).or_insert((0, HashSet::default(), 0));
        entry.0 += 1;
        entry.1.insert(author);
        entry.2 = entry.2.max(when);
        pending.push(held);
    }
    record(&mut together, &pending);

    let mut churn: Vec<Churn> = touched
        .iter()
        .map(|(path, (commits, authors, last))| Churn {
            path: (*path).to_string(),
            commits: *commits,
            authors: authors.len() as u32,
            last: *last,
        })
        .collect();
    churn.sort_by(|left, right| {
        right
            .commits
            .cmp(&left.commits)
            .then(left.path.cmp(&right.path))
    });
    let counted = churn.len() as u32;
    let mut per_file: Vec<(String, u32)> =
        churn.iter().map(|held| (held.path.clone(), held.commits)).collect();
    per_file.sort();
    churn.truncate(RANKED);

    let mut co_change: Vec<CoChange> = together
        .into_iter()
        .filter(|(_, commits)| *commits > 1)
        .map(|((path, with), commits)| CoChange {
            path: path.to_string(),
            with: with.to_string(),
            commits,
        })
        .collect();
    co_change.sort_by(|left, right| {
        right
            .commits
            .cmp(&left.commits)
            .then(left.path.cmp(&right.path))
            .then(left.with.cmp(&right.with))
    });
    co_change.truncate(RANKED);

    Some(History { commits, touched: counted, churn, co_change, per_file })
}

fn record<'a>(together: &mut HashMap<(&'a str, &'a str), u32>, changed: &[&'a str]) {
    if changed.len() < 2 || changed.len() > WIDE_COMMIT {
        return;
    }
    for (at, left) in changed.iter().enumerate() {
        for right in changed.iter().skip(at + 1) {
            let pair = match left <= right {
                true => (*left, *right),
                false => (*right, *left),
            };
            *together.entry(pair).or_insert(0) += 1;
        }
    }
}

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use std::path::Path;
use std::process::Command;

use serde::Serialize;

const COMMITS_READ: usize = 2000;
const WIDE_COMMIT: usize = 50;
const RANKED: usize = 50;
const FILES_REPORTED: usize = 2000;
const RECENT_DAYS: i64 = 30;
const QUARTER_DAYS: i64 = 90;
const SECONDS_PER_DAY: i64 = 86_400;

struct Commit<'a> {
    when: i64,
    author: &'a str,
    subject: &'a str,
    held: Vec<(&'a str, bool)>,
    source: bool,
}

#[derive(Default)]
struct Stat<'a> {
    commits: u32,
    authors: HashSet<&'a str>,
    last: i64,
    fixes: u32,
    recent: u32,
    recent_authors: HashSet<&'a str>,
    quarter: u32,
    quarter_authors: HashSet<&'a str>,
    aside: bool,
}

#[derive(Debug, Serialize)]
pub struct FileHistory {
    pub path: String,
    pub commits: u32,
    pub fixes: u32,
    pub recent: u32,
    pub quarter: u32,
    pub recent_authors: u32,
    pub quarter_authors: u32,
    pub last: i64,
    pub fix_percentile: u8,
    pub churn_percentile: u8,
}

fn percentile(sorted: &[u32], value: u32) -> u8 {
    if sorted.is_empty() {
        return 0;
    }
    let below = sorted.partition_point(|held| *held < value);
    (below * 100 / sorted.len()) as u8
}

fn rank_files(touched: &HashMap<&str, Stat>) -> Vec<FileHistory> {
    let mut commits: Vec<u32> = touched.values().filter(|stat| !stat.aside).map(|stat| stat.commits).collect();
    let mut fixes: Vec<u32> = touched.values().filter(|stat| !stat.aside).map(|stat| stat.fixes).collect();
    commits.sort_unstable();
    fixes.sort_unstable();
    let mut ranked: Vec<FileHistory> = touched
        .iter()
        .filter(|(_, stat)| !stat.aside && (stat.fixes > 0 || stat.commits > 1))
        .map(|(path, stat)| FileHistory {
            path: (*path).to_string(),
            commits: stat.commits,
            fixes: stat.fixes,
            recent: stat.recent,
            quarter: stat.quarter,
            recent_authors: stat.recent_authors.len() as u32,
            quarter_authors: stat.quarter_authors.len() as u32,
            last: stat.last,
            fix_percentile: percentile(&fixes, stat.fixes),
            churn_percentile: percentile(&commits, stat.commits),
        })
        .collect();
    ranked.sort_by(|left, right| {
        right.fixes.cmp(&left.fixes).then(right.commits.cmp(&left.commits)).then(left.path.cmp(&right.path))
    });
    ranked.truncate(FILES_REPORTED);
    ranked
}

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
    pub fix_commits: u32,
    pub churn: Vec<Churn>,
    pub co_change: Vec<CoChange>,
    pub files: Vec<FileHistory>,
    #[serde(skip)]
    pub per_file: Vec<(String, u32, i64)>,
    #[serde(skip)]
    pub quarter_authors_of: HashMap<String, Vec<String>>,
    #[serde(skip)]
    pub head: i64,
    #[serde(skip)]
    pub oldest: i64,
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

impl History {
    pub fn quarter_contributors<'a>(&self, files: impl IntoIterator<Item = &'a str>) -> u32 {
        let mut distinct: HashSet<&str> = HashSet::default();
        for path in files {
            if let Some(authors) = self.quarter_authors_of.get(path) {
                distinct.extend(authors.iter().map(String::as_str));
            }
        }
        distinct.len() as u32
    }
}

pub fn newest_change(root: &Path, directory: &str) -> Option<i64> {
    let log = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["log", "-1", "--no-merges", "--format=%at", "--"])
        .arg(match directory.is_empty() {
            true => ".",
            false => directory,
        })
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    String::from_utf8_lossy(&log.stdout).trim().parse().ok()
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
            "--pretty=format:\u{1}%at\u{1}%ae\u{1}%s",
            &format!("-n{COMMITS_READ}"),
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&log.stdout);

    let mut log: Vec<Commit> = Vec::new();
    for line in text.lines() {
        if let Some(header) = line.strip_prefix('\u{1}') {
            let mut parts = header.splitn(3, '\u{1}');
            log.push(Commit {
                when: parts.next().and_then(|at| at.parse().ok()).unwrap_or(0),
                author: parts.next().unwrap_or(""),
                subject: parts.next().unwrap_or(""),
                held: Vec::new(),
                source: false,
            });
            continue;
        }
        let path = line.trim();
        let Some(commit) = log.last_mut() else { continue };
        if path.is_empty() {
            continue;
        }
        let aside = crate::fixes::is_aside(path);
        commit.source |= !aside;
        if let Some(held) = held.get(path) {
            commit.held.push((held, aside));
        }
    }

    let commits = log.len() as u32;
    let head = log.iter().map(|commit| commit.when).max().unwrap_or(0);
    let oldest = log.iter().map(|commit| commit.when).min().unwrap_or(i64::MAX);
    let mut touched: HashMap<&str, Stat> = HashMap::default();
    let mut together: HashMap<(&str, &str), u32> = HashMap::default();
    let mut fix_commits = 0;
    for commit in &log {
        let changed: Vec<&str> = commit.held.iter().map(|(path, _)| *path).collect();
        record(&mut together, &changed);
        let fix = commit.source && crate::fixes::is_fix(commit.subject);
        fix_commits += u32::from(fix);
        for (path, aside) in &commit.held {
            let entry = touched.entry(path).or_default();
            entry.commits += 1;
            entry.authors.insert(commit.author);
            entry.last = entry.last.max(commit.when);
            entry.fixes += u32::from(fix && !aside);
            entry.aside = *aside;
            if head - commit.when <= RECENT_DAYS * SECONDS_PER_DAY {
                entry.recent += 1;
                entry.recent_authors.insert(commit.author);
            }
            if head - commit.when <= QUARTER_DAYS * SECONDS_PER_DAY {
                entry.quarter += 1;
                entry.quarter_authors.insert(commit.author);
            }
        }
    }
    let pending: Vec<&str> = log.last().map(|commit| commit.held.iter().map(|(path, _)| *path).collect()).unwrap_or_default();
    let ranked = rank_files(&touched);

    let mut churn: Vec<Churn> = touched
        .iter()
        .map(|(path, stat)| Churn {
            path: (*path).to_string(),
            commits: stat.commits,
            authors: stat.authors.len() as u32,
            last: stat.last,
        })
        .collect();
    churn.sort_by(|left, right| {
        right
            .commits
            .cmp(&left.commits)
            .then(left.path.cmp(&right.path))
    });
    let counted = churn.len() as u32;
    let first_import: HashSet<&str> = match commits > 1 && (commits as usize) < COMMITS_READ {
        true => pending.iter().copied().collect(),
        false => HashSet::default(),
    };
    let mut per_file: Vec<(String, u32, i64)> = churn
        .iter()
        .filter_map(|held| {
            let dropped = u32::from(first_import.contains(held.path.as_str()));
            (held.commits > dropped).then(|| (held.path.clone(), held.commits - dropped, held.last))
        })
        .collect();
    per_file.sort();
    let quarter_authors_of: HashMap<String, Vec<String>> = touched
        .iter()
        .filter(|(_, stat)| !stat.quarter_authors.is_empty())
        .map(|(path, stat)| {
            let mut authors: Vec<String> = stat.quarter_authors.iter().map(|author| (*author).to_string()).collect();
            authors.sort();
            ((*path).to_string(), authors)
        })
        .collect();
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

    Some(History { commits, touched: counted, fix_commits, churn, co_change, files: ranked, per_file, quarter_authors_of, head, oldest: oldest.min(head) })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_percentile_is_the_share_of_files_with_fewer() {
        let held = [0, 0, 0, 1, 2, 2, 5, 9, 9, 40];
        assert_eq!(percentile(&held, 40), 90);
        assert_eq!(percentile(&held, 0), 0);
        assert_eq!(percentile(&held, 2), 40);
        assert_eq!(percentile(&[], 3), 0);
    }

    #[test]
    fn files_set_aside_never_rank_and_a_file_is_ranked_by_its_own_fixes() {
        let mut touched: HashMap<&str, Stat> = HashMap::default();
        for (path, commits, fixes, aside) in [("a.rs", 5, 3, false), ("b.rs", 2, 0, false), ("README.md", 9, 0, true), ("c.rs", 1, 0, false)] {
            let stat = touched.entry(path).or_default();
            stat.commits = commits;
            stat.fixes = fixes;
            stat.aside = aside;
        }
        let ranked = rank_files(&touched);
        let paths: Vec<&str> = ranked.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["a.rs", "b.rs"]);
        assert_eq!(ranked[0].fix_percentile, 66);
    }

    #[test]
    fn a_files_quarter_authors_count_everyone_who_touched_it_within_ninety_days() {
        let mut stat = Stat { commits: 3, quarter: 3, ..Stat::default() };
        stat.quarter_authors.extend(["a@x", "b@x"]);
        stat.recent_authors.insert("a@x");
        let touched: HashMap<&str, Stat> = [("src/a.rs", stat)].into_iter().collect();
        let ranked = rank_files(&touched);
        assert_eq!((ranked[0].recent_authors, ranked[0].quarter_authors), (1, 2));
    }

    #[test]
    fn a_part_counts_each_author_once_across_its_files_within_ninety_days() {
        let held = History {
            commits: 3,
            touched: 3,
            fix_commits: 0,
            churn: Vec::new(),
            co_change: Vec::new(),
            files: Vec::new(),
            per_file: Vec::new(),
            quarter_authors_of: [
                ("src/a.rs".to_string(), vec!["a@x".to_string(), "b@x".to_string()]),
                ("src/b.rs".to_string(), vec!["b@x".to_string(), "c@x".to_string()]),
                ("docs/c.md".to_string(), vec!["d@x".to_string()]),
            ]
            .into_iter()
            .collect(),
            head: 0,
            oldest: 0,
        };
        assert_eq!(held.quarter_contributors(["src/a.rs", "src/b.rs", "src/none.rs"]), 3);
        assert_eq!(held.quarter_contributors(["docs/c.md"]), 1);
        assert_eq!(held.quarter_contributors([]), 0);
    }
}

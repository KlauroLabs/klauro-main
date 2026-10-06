use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::dependencies::package_of;
use crate::entry_exit::ExitPoint;
use crate::libraries::{category_of, named_by};
use crate::model::{CallFact, ImportFact};
use crate::names;

static TABLE: &str = include_str!("../data/exit_actions.tsv");

struct Row {
    scope: &'static str,
    key: &'static str,
    operations: Vec<&'static str>,
    action: &'static str,
    reaches: &'static str,
    stands_alone: bool,
}

fn rows() -> &'static [Row] {
    static HELD: std::sync::OnceLock<Vec<Row>> = std::sync::OnceLock::new();
    HELD.get_or_init(|| {
        TABLE
            .lines()
            .filter_map(|line| {
                let mut columns = line.split('\t');
                Some(Row {
                    scope: columns.next()?,
                    key: columns.next()?,
                    operations: columns.next()?.split(',').collect(),
                    action: columns.next()?,
                    reaches: columns.next()?,
                    stands_alone: columns.next()? == "yes",
                })
            })
            .collect()
    })
}

fn rows_of(package: &str) -> Vec<&'static Row> {
    let category = category_of(package, "");
    rows()
        .iter()
        .filter(|row| match row.scope {
            "category" => category.as_deref() == Some(row.key),
            _ => named_by(package, row.key),
        })
        .collect()
}

fn action_of(rows: &[&'static Row], operation: &str) -> Option<&'static Row> {
    let lowered = operation.to_ascii_lowercase();
    rows.iter().copied().find(|row| row.operations.iter().any(|held| *held == "*" || *held == lowered))
}

pub fn assign(exits: &mut Vec<ExitPoint>, calls: &[CallFact], imports: &[ImportFact], files: &[String]) {
    let mut packages: HashMap<u32, Vec<&str>> = HashMap::default();
    let mut bound: HashMap<(u32, &str), &str> = HashMap::default();
    for import in imports {
        let Some(package) = package_of(&import.specifier) else { continue };
        let held = packages.entry(import.file).or_default();
        if !held.contains(&package) {
            held.push(package);
        }
        for name in &import.names {
            bound.insert((import.file, name.local.as_str()), package);
        }
    }
    for exit in exits.iter_mut() {
        if exit.action.is_some() {
            continue;
        }
        let root = names::root(&exit.name);
        let package = bound.get(&(exit.file, root)).copied().or_else(|| package_of(&exit.target));
        let Some(package) = package else { continue };
        if let Some(row) = action_of(&rows_of(package), &exit.operation) {
            if !exit.operation.eq_ignore_ascii_case(root) {
                exit.action = Some(row.action);
            }
        }
    }
    let reached: HashSet<(u32, u32, String)> = exits.iter().map(|exit| (exit.file, exit.line, names::leaf(&exit.operation).to_ascii_lowercase())).collect();
    let mut standing_by_package: HashMap<&str, Vec<&'static Row>> = HashMap::default();
    for held in packages.values().flatten() {
        standing_by_package.entry(held).or_insert_with(|| rows_of(held).into_iter().filter(|row| row.stands_alone).collect());
    }
    standing_by_package.retain(|_, rows| !rows.is_empty());
    if standing_by_package.is_empty() {
        return;
    }
    let verbs: HashSet<&str> = standing_by_package.values().flatten().flat_map(|row| row.operations.iter().copied()).collect();
    let mut added = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some(receiver) = call.receiver.as_deref() else { continue };
        let operation = names::leaf(&call.callee);
        let lowered = operation.to_ascii_lowercase();
        if call.constructs || !verbs.contains(lowered.as_str()) {
            continue;
        }
        if files.get(call.file as usize).is_none_or(|path| crate::paths::is_test(path)) {
            continue;
        }
        let Some(source) = call.caller.clone() else { continue };
        if reached.contains(&(call.file, call.line, lowered.clone())) {
            continue;
        }
        let Some(held) = packages.get(&call.file) else { continue };
        let standing = held.iter().find_map(|package| {
            standing_by_package
                .get(package)?
                .iter()
                .find(|row| row.operations.contains(&lowered.as_str()))
                .map(|row| (*package, *row))
        });
        let Some((package, row)) = standing else { continue };
        added.push(ExitPoint {
            id: format!("exit:{}:{}:action", files[call.file as usize], position),
            kind: row.reaches,
            name: format!("{receiver}.{operation}"),
            source,
            target: package.to_string(),
            operation: operation.to_string(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: None,
            service: None,
            method: None,
            origin: None,
            action: Some(row.action),
        });
    }
    if !added.is_empty() {
        exits.extend(added);
        exits.sort_by(|left, right| left.id.cmp(&right.id));
        exits.dedup_by(|left, right| left.id == right.id);
    }
}

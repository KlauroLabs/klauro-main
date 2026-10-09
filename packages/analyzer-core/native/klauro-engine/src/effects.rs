use crate::entry_exit::ExitPoint;

static TABLE: &str = include_str!("../data/effects.tsv");

struct Rule {
    scope: &'static str,
    does: &'static str,
    words: Vec<&'static str>,
}

fn rules() -> &'static [Rule] {
    static HELD: std::sync::OnceLock<Vec<Rule>> = std::sync::OnceLock::new();
    HELD.get_or_init(|| {
        TABLE
            .lines()
            .filter_map(|line| {
                let mut columns = line.split('\t');
                let scope = columns.next()?;
                Some(Rule { scope, does: columns.next()?, words: columns.next()?.split(',').collect() })
            })
            .collect()
    })
}

pub(crate) fn words_of(operation: &str) -> Vec<String> {
    let bare = operation.rsplit(['.', ':']).next().unwrap_or(operation);
    let bare = bare.strip_suffix("Async").unwrap_or(bare);
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for letter in bare.chars() {
        if letter == '_' || letter == '-' || letter == '!' || letter == '?' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_lower = false;
            continue;
        }
        if letter.is_uppercase() && previous_lower && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        previous_lower = letter.is_lowercase() || letter.is_ascii_digit();
        current.push(letter.to_ascii_lowercase());
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

pub(crate) fn by_words(operation: &str) -> Option<&'static str> {
    let words = words_of(operation);
    let whole: String = words.concat();
    if let Some(rule) = rules().iter().find(|rule| rule.scope == "whole" && rule.words.contains(&whole.as_str())) {
        return Some(rule.does);
    }
    let first = words.first().map(String::as_str).unwrap_or_default();
    if let Some(rule) = rules().iter().find(|rule| rule.scope == "first" && rule.words.contains(&first)) {
        return Some(rule.does);
    }
    ["delete", "send", "write"].into_iter().find(|does| {
        rules()
            .iter()
            .filter(|rule| rule.scope == "word" && rule.does == *does)
            .any(|rule| words.iter().any(|word| rule.words.contains(&word.as_str())))
    })
}

fn by_method(method: &str) -> &'static str {
    match method {
        "GET" | "HEAD" | "OPTIONS" => "read",
        "DELETE" => "delete",
        _ => "write",
    }
}

pub fn does(exit: &ExitPoint) -> &'static str {
    match exit.kind {
        "message" => "send",
        "process" => "start",
        "output" => "write",
        "api" | "network" => match exit.method {
            Some(method) => by_method(method),
            None => by_words(&exit.operation).unwrap_or("call"),
        },
        _ => by_words(&exit.operation).unwrap_or("read"),
    }
}

fn type_named(written: &str) -> &str {
    let bare = written.trim().strip_prefix("new ").unwrap_or(written.trim());
    let bare = bare.split(['(', '<', '{', ' ']).next().unwrap_or(bare);
    bare.rsplit(['.', ':']).next().unwrap_or(bare)
}

pub fn published(
    calls: &[crate::model::CallFact],
    locals: &[crate::model::LocalBinding],
    entries: &[crate::entry_exit::EntryPoint],
    files: &[String],
) -> Vec<ExitPoint> {
    let received: rustc_hash::FxHashSet<&str> =
        entries.iter().filter(|entry| matches!(entry.kind, "message" | "event")).map(|entry| entry.name.as_str()).collect();
    if received.is_empty() {
        return Vec::new();
    }
    let mut typed: rustc_hash::FxHashMap<(&str, &str), &str> = rustc_hash::FxHashMap::default();
    for local in locals {
        if let Some(written) = local.constructed.as_deref().or(local.annotation.as_deref()) {
            typed.insert((local.unit.as_str(), local.name.as_str()), type_named(written));
        }
    }
    let mut made: rustc_hash::FxHashMap<&str, Vec<&str>> = rustc_hash::FxHashMap::default();
    for call in calls.iter().filter(|call| call.constructs) {
        if let (Some(caller), Some(message)) = (call.caller.as_deref(), received.get(type_named(&call.callee)).copied()) {
            let held = made.entry(caller).or_default();
            if !held.contains(&message) {
                held.push(message);
            }
        }
    }
    let subscribed: rustc_hash::FxHashSet<(u32, u32)> =
        entries.iter().filter(|entry| matches!(entry.kind, "message" | "event")).map(|entry| (entry.file, entry.line)).collect();
    let mut found = Vec::new();
    for call in calls {
        let sends = match by_words(&call.callee) {
            Some("send") => true,
            Some("write") => false,
            _ => continue,
        };
        if call.constructs || subscribed.contains(&(call.file, call.line)) || crate::paths::is_test(&files[call.file as usize]) {
            continue;
        }
        let Some(caller) = call.caller.as_deref() else { continue };
        let mut messages: Vec<&str> = Vec::new();
        for written in call.literals.iter().filter(|written| !written.trim_start().starts_with(['/', '"', '\'', '`']) && !written.trim().contains(char::is_whitespace)) {
            let direct = received
                .get(type_named(written))
                .copied()
                .filter(|_| type_named(written).starts_with(char::is_uppercase))
                .or_else(|| typed.get(&(caller, written.trim())).and_then(|held| received.get(held).copied()));
            match direct {
                Some(message) => messages.push(message),
                None if sends && !written.contains(['"', '\'', ' ']) => messages.extend(made.get(caller).into_iter().flatten().copied()),
                None => {}
            }
        }
        messages.sort_unstable();
        messages.dedup();
        for message in messages {
            found.push(ExitPoint {
                id: format!("exit:{}:{}:{}:published:{message}", files[call.file as usize], call.line, call.column),
                kind: "message",
                name: match &call.receiver {
                    Some(receiver) => format!("{receiver}.{}", call.callee),
                    None => call.callee.clone(),
                },
                source: caller.to_string(),
                target: message.to_string(),
                operation: call.callee.clone(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
                addressed: Some(message.to_string()),
                service: None,
                method: None,
                origin: None,
                action: None,
                does: Some("send"),
            });
        }
    }
    found
}

pub fn assign(exits: &mut [ExitPoint]) {
    for exit in exits.iter_mut() {
        exit.does = Some(does(exit));
    }
}

#[cfg(test)]
mod tests {
    use super::words_of;

    #[test]
    fn an_operation_is_read_as_its_words() {
        assert_eq!(words_of("KeyDeleteAsync"), vec!["key", "delete"]);
        assert_eq!(words_of("_database.StringSetAsync"), vec!["string", "set"]);
        assert_eq!(words_of("save!"), vec!["save"]);
        assert_eq!(words_of("find_or_create_by"), vec!["find", "or", "create", "by"]);
    }
}

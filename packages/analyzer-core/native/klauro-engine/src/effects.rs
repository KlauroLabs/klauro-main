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

fn words_of(operation: &str) -> Vec<String> {
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

fn by_words(operation: &str) -> Option<&'static str> {
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
        "api" | "network" => match exit.method {
            Some(method) => by_method(method),
            None => by_words(&exit.operation).unwrap_or("call"),
        },
        _ => by_words(&exit.operation).unwrap_or("read"),
    }
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

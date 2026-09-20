/// A file that only describes a codebase, never declares its tables.
fn only_prose(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    [".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"]
        .iter()
        .any(|extension| lowered.ends_with(extension))
}

/// The tables a file declares, read from the statements it holds, wherever they are written:
/// in the schema itself, in a migration's string, in the argument of a call.
pub fn declared(source: &[u8], path: &str, file: u32) -> Vec<Table> {
    if only_prose(path) || !holds_a_creation(source) {
        return Vec::new();
    }
    let Ok(text) = std::str::from_utf8(source) else {
        return Vec::new();
    };
    let mut found = creating(text);
    for table in found.iter_mut() {
        table.file = file;
    }
    found
}

/// Whether a file is worth reading for declarations at all.
fn holds_a_creation(source: &[u8]) -> bool {
    source
        .windows(11)
        .any(|held| held.eq_ignore_ascii_case(b"reate table"))
}

/// A table a statement creates, wherever that statement is written: in a schema file, or
/// inside the string a migration hands to the database.
#[derive(Debug)]
pub struct Table {
    pub named: String,
    pub columns: Vec<String>,
    pub file: u32,
    pub line: u32,
}

const RESERVED: &[&str] = &[
    "check",
    "constraint",
    "exclude",
    "foreign",
    "index",
    "key",
    "like",
    "primary",
    "unique",
];

fn spoken(word: &str) -> Option<String> {
    let word = word.trim_matches(['"', '`', '[', ']', '\'', ',', ';', '(']);
    if word.is_empty() || word.len() > 64 {
        return None;
    }
    let word = word.rsplit('.').next().unwrap_or(word);
    let plain = word
        .chars()
        .all(|letter| letter.is_alphanumeric() || letter == '_');
    (plain && !RESERVED.contains(&word.to_ascii_lowercase().as_str())).then(|| word.to_string())
}

fn columns_from(held: &str) -> Vec<String> {
    let Some(open) = held.find('(') else {
        return Vec::new();
    };
    let mut depth = 0usize;
    let mut start = open + 1;
    let mut found = Vec::new();
    for (at, letter) in held.char_indices().skip_while(|(at, _)| *at < open) {
        match letter {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(column) = leading(&held[start..at]) {
                        found.push(column);
                    }
                    break;
                }
            }
            ',' if depth == 1 => {
                if let Some(column) = leading(&held[start..at]) {
                    found.push(column);
                }
                start = at + 1;
            }
            _ => {}
        }
    }
    found
}

fn leading(segment: &str) -> Option<String> {
    spoken(segment.trim().split_whitespace().next()?)
}

/// The tables a statement creates, read from the statement itself.
pub fn creating(statement: &str) -> Vec<Table> {
    let lowered = statement.to_ascii_lowercase();
    let mut found = Vec::new();
    let mut from = 0usize;
    while let Some(at) = lowered[from..].find("create table") {
        let after = from + at + "create table".len();
        from = after;
        let rest = &statement[after..];
        let mut words = rest.split_whitespace();
        let mut word = words.next();
        while word.is_some_and(|word| {
            matches!(
                word.to_ascii_lowercase().as_str(),
                "if" | "not" | "exists" | "temporary" | "temp" | "unlogged"
            )
        }) {
            word = words.next();
        }
        let Some(word) = word else { continue };
        let Some(named) = spoken(word.split('(').next().unwrap_or(word)) else {
            continue;
        };
        let opens = rest.find('(').unwrap_or(rest.len());
        found.push(Table {
            named,
            columns: columns_from(&rest[opens..]),
            file: 0,
            line: statement[..after].matches('\n').count() as u32,
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_migration_statement_names_the_table_it_creates() {
        let held = "CREATE TABLE IF NOT EXISTS public.users (\n  id serial PRIMARY KEY,\n  email text NOT NULL,\n  PRIMARY KEY (id)\n)";
        let found = creating(held);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].named, "users");
        assert_eq!(found[0].columns, vec!["id", "email"]);
    }

    #[test]
    fn one_string_may_create_several_tables() {
        let held = "create table a (x int); create table b (y int, z int);";
        let found = creating(held);
        assert_eq!(
            found.iter().map(|t| t.named.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(found[1].columns, vec!["y", "z"]);
    }
}

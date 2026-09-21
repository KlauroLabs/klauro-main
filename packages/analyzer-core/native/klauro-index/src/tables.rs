fn only_prose(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    [".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"]
        .iter()
        .any(|extension| lowered.ends_with(extension))
}

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

fn holds_a_creation(source: &[u8]) -> bool {
    source
        .windows(11)
        .any(|held| held.eq_ignore_ascii_case(b"reate table"))
}

#[derive(Debug)]
pub struct Table {
    pub named: String,
    pub columns: Vec<String>,
    pub points_at: Vec<(String, String)>,
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

fn pointing(segment: &str) -> Option<String> {
    let lowered = segment.to_ascii_lowercase();
    let at = lowered.find("references")?;
    let rest = segment[at + "references".len()..].trim_start();
    let end = rest
        .find(|letter: char| letter.is_whitespace() || letter == '(')
        .unwrap_or(rest.len());
    spoken(&rest[..end])
}

fn constrained(segment: &str) -> Option<String> {
    let lowered = segment.to_ascii_lowercase();
    let at = lowered.find("foreign key")?;
    let rest = segment[at + "foreign key".len()..].trim_start();
    let inner = rest.strip_prefix('(')?;
    leading(inner.split(')').next()?)
}

fn columns_from(held: &str) -> (Vec<String>, Vec<(String, String)>) {
    let Some(open) = held.find('(') else {
        return (Vec::new(), Vec::new());
    };
    let mut depth = 0usize;
    let mut start = open + 1;
    let mut found = Vec::new();
    let mut points_at = Vec::new();
    let mut read = |segment: &str, found: &mut Vec<String>, points_at: &mut Vec<(String, String)>| {
        let column = leading(segment).or_else(|| constrained(segment));
        let Some(column) = column else { return };
        if let Some(table) = pointing(segment) {
            points_at.push((column.clone(), table));
        }
        if !segment.trim_start().to_ascii_lowercase().starts_with("foreign key") {
            found.push(column);
        }
    };
    for (at, letter) in held.char_indices().skip_while(|(at, _)| *at < open) {
        match letter {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    read(&held[start..at], &mut found, &mut points_at);
                    break;
                }
            }
            ',' if depth == 1 => {
                read(&held[start..at], &mut found, &mut points_at);
                start = at + 1;
            }
            _ => {}
        }
    }
    (found, points_at)
}

fn leading(segment: &str) -> Option<String> {
    spoken(segment.trim().split_whitespace().next()?)
}

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
        let (columns, points_at) = columns_from(&rest[opens..]);
        found.push(Table {
            named,
            columns,
            points_at,
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
    fn a_column_points_at_the_table_it_references() {
        let held = "CREATE TABLE episodes (\n id INTEGER PRIMARY KEY,\n season_id INTEGER NOT NULL REFERENCES seasons(id),\n title TEXT,\n FOREIGN KEY (show_id) REFERENCES shows(id)\n)";
        let found = creating(held);
        assert_eq!(found[0].columns, vec!["id", "season_id", "title"]);
        assert_eq!(
            found[0].points_at,
            vec![
                ("season_id".to_string(), "seasons".to_string()),
                ("show_id".to_string(), "shows".to_string()),
            ]
        );
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

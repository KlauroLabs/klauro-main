fn only_prose(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    [".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"]
        .iter()
        .any(|extension| lowered.ends_with(extension))
}

static REVERSES: &[&str] = &["down", "revert", "rollback", "undo"];
static REVERSAL_BEGINS: &[&str] = &["-- +goose down", "-- +migrate down", "-- migrate:down"];

fn reverses(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    basename
        .split(|letter: char| !letter.is_ascii_alphanumeric())
        .any(|token| REVERSES.contains(&token))
}

fn going_forward(text: &str) -> &str {
    let lowered = text.to_ascii_lowercase();
    let reversed = REVERSAL_BEGINS.iter().filter_map(|begins| lowered.find(begins)).min();
    match reversed {
        Some(at) => &text[..at],
        None => text,
    }
}

pub fn declared(source: &[u8], path: &str, file: u32) -> Vec<Table> {
    if only_prose(path) || crate::paths::is_test(path) || reverses(path) || !holds_a_creation(source) {
        return Vec::new();
    }
    let Ok(text) = std::str::from_utf8(source) else {
        return Vec::new();
    };
    let text = going_forward(text);
    let mut found = creating(text);
    found.extend(retiring(text));
    for table in found.iter_mut() {
        table.file = file;
    }
    found
}

fn holds_a_creation(source: &[u8]) -> bool {
    [b"create table".as_slice(), b"drop table", b"alter table"].iter().any(|written| {
        source
            .windows(written.len())
            .any(|held| held[0].eq_ignore_ascii_case(&written[0]) && held.eq_ignore_ascii_case(written))
    })
}

fn retiring(statement: &str) -> Vec<Table> {
    let lowered = statement.to_ascii_lowercase();
    let mut found = Vec::new();
    for (written, dropping) in [("drop table", true), ("alter table", false)] {
        let mut from = 0usize;
        while let Some(at) = lowered[from..].find(written) {
            let after = from + at + written.len();
            from = after;
            let mut words = statement[after..].split_whitespace().peekable();
            while words.peek().is_some_and(|word| {
                matches!(word.to_ascii_lowercase().as_str(), "if" | "exists" | "only")
            }) {
                words.next();
            }
            let Some(named) = words.next().and_then(spoken) else { continue };
            let line = statement[..after].matches('\n').count() as u32;
            let change = match dropping {
                true => Change::Dropped,
                false => {
                    let rest: Vec<String> =
                        words.take(3).map(|word| word.to_ascii_lowercase()).collect();
                    let renamed = rest.first().is_some_and(|word| word == "rename")
                        && rest.get(1).is_some_and(|word| word == "to");
                    let Some(to) = renamed.then(|| rest.get(2).and_then(|word| spoken(word))).flatten()
                    else {
                        continue;
                    };
                    Change::RenamedTo(to)
                }
            };
            found.push(Table {
                named,
                columns: Vec::new(),
                points_at: Vec::new(),
                file: 0,
                line,
                declared_by: None,
                change,
            });
        }
    }
    found
}

pub fn standing(mut tables: Vec<Table>, paths: &[&str]) -> Vec<Table> {
    tables.sort_by(|left, right| {
        let placed = |table: &Table| (paths.get(table.file as usize).copied().unwrap_or(""), table.line);
        placed(left).cmp(&placed(right))
    });
    let mut held: Vec<Table> = Vec::new();
    let key = |named: &str| named.trim_matches(['"', '`', '[', ']']).to_ascii_lowercase();
    for table in tables {
        let named = key(&table.named);
        let replayed = table.declared_by.is_none();
        match table.change.clone() {
            Change::Created => held.push(table),
            Change::Dropped if replayed => {
                held.retain(|kept| kept.declared_by.is_some() || key(&kept.named) != named)
            }
            Change::RenamedTo(to) if replayed => {
                for kept in held.iter_mut().filter(|kept| kept.declared_by.is_none()) {
                    if key(&kept.named) == named {
                        kept.named = to.clone();
                    }
                }
            }
            _ => {}
        }
    }
    held
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Column {
    pub named: String,
    pub declared_as: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Table {
    pub named: String,
    pub columns: Vec<Column>,
    pub points_at: Vec<(String, String)>,
    pub file: u32,
    pub line: u32,
    pub declared_by: Option<String>,
    pub change: Change,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Change {
    Created,
    Dropped,
    RenamedTo(String),
}

const NEVER_A_TABLE_NAME: &[&str] = &["as", "select", "table", "with"];

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
    let plain = !word.is_empty()
        && word
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

fn constrained(segment: &str) -> Option<Column> {
    let lowered = segment.to_ascii_lowercase();
    let at = lowered.find("foreign key")?;
    let rest = segment[at + "foreign key".len()..].trim_start();
    let inner = rest.strip_prefix('(')?;
    leading(inner.split(')').next()?)
}

fn columns_from(held: &str) -> (Vec<Column>, Vec<(String, String)>) {
    let Some(open) = held.find('(') else {
        return (Vec::new(), Vec::new());
    };
    let mut depth = 0usize;
    let mut start = open + 1;
    let mut found = Vec::new();
    let mut points_at = Vec::new();
    let read = |segment: &str, found: &mut Vec<Column>, points_at: &mut Vec<(String, String)>| {
        let Some(column) = constrained(segment).or_else(|| leading(segment)) else { return };
        if let Some(table) = pointing(segment) {
            points_at.push((column.named.clone(), table));
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

fn leading(segment: &str) -> Option<Column> {
    let mut words = segment.trim().split_whitespace();
    let named = spoken(words.next()?)?;
    Some(Column { named, declared_as: words.next().map(str::to_string) })
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
        if NEVER_A_TABLE_NAME.contains(&named.to_ascii_lowercase().as_str()) {
            continue;
        }
        let Some(named_at) = rest.find(word) else { continue };
        let after_the_name = rest[named_at + word.len()..].trim_start();
        if !word.contains('(') && !after_the_name.starts_with('(') {
            continue;
        }
        let opens = rest.find('(').unwrap_or(rest.len());
        let (columns, points_at) = columns_from(&rest[opens..]);
        if columns.is_empty() {
            continue;
        }
        found.push(Table {
            named,
            columns,
            points_at,
            file: 0,
            line: statement[..after].matches('\n').count() as u32,
            declared_by: None,
            change: Change::Created,
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(table: &Table) -> Vec<&str> {
        table.columns.iter().map(|column| column.named.as_str()).collect()
    }

    #[test]
    fn a_migration_statement_names_the_table_it_creates() {
        let held = "CREATE TABLE IF NOT EXISTS public.users (\n  id serial PRIMARY KEY,\n  email text NOT NULL,\n  PRIMARY KEY (id)\n)";
        let found = creating(held);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].named, "users");
        assert_eq!(named(&found[0]), vec!["id", "email"]);
        assert_eq!(found[0].columns[0].declared_as.as_deref(), Some("serial"));
    }

    #[test]
    fn a_column_points_at_the_table_it_references() {
        let held = "CREATE TABLE episodes (\n id INTEGER PRIMARY KEY,\n season_id INTEGER NOT NULL REFERENCES seasons(id),\n title TEXT,\n FOREIGN KEY (show_id) REFERENCES shows(id)\n)";
        let found = creating(held);
        assert_eq!(named(&found[0]), vec!["id", "season_id", "title"]);
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
        assert_eq!(named(&found[1]), vec!["y", "z"]);
    }
}

static CREATES_A_TABLE: &[&str] = &["create_table", "createmodel", "createtable"];
static CREATES_BY_A_SCHEMA: &[&str] = &["create"];
static DESCRIBES_A_SCHEMA: &[&str] = &["schema"];
static NAMES_WHAT_IS_CREATED: &[&str] = &["name", "table_name"];
const OPENS_BESIDE_ITS_CREATION: u32 = 3;
static SCHEMAS_MAPPING_BY_CALL: &[&str] = &[".prisma"];
static MAPS_ITS_TABLE: &[&str] = &["map"];
static DECLARES_A_COLUMN: &[&str] = &["column"];

fn creates_a_table(call: &crate::model::CallFact) -> bool {
    let callee = crate::names::leaf(&call.callee).to_ascii_lowercase();
    if CREATES_A_TABLE.contains(&callee.as_str()) {
        return true;
    }
    let receiver = call
        .receiver
        .as_deref()
        .map(|held| crate::names::leaf(held).trim_start_matches('\\').to_ascii_lowercase());
    CREATES_BY_A_SCHEMA.contains(&callee.as_str())
        && receiver.is_some_and(|held| DESCRIBES_A_SCHEMA.contains(&held.as_str()))
}

fn named_in(literal: &str) -> Option<String> {
    let held = match literal.split_once('=') {
        Some((key, value)) => NAMES_WHAT_IS_CREATED
            .contains(&key.trim().to_ascii_lowercase().as_str())
            .then_some(value.trim())?,
        None => literal.trim(),
    };
    let held = held.trim_start_matches(':').trim_matches(['"', '\'', '`']);
    if !held.chars().next().is_some_and(char::is_alphabetic) {
        return None;
    }
    let plainly = !held.is_empty()
        && held.len() <= 64
        && held.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | '.'));
    plainly.then(|| held.rsplit('.').next().unwrap_or(held).to_string())
}

pub fn created_by_calls(
    calls: &[crate::model::CallFact],
    nodes: &[crate::model::IndexNode],
    locals: &[crate::model::LocalBinding],
    paths: &[&str],
) -> Vec<Table> {
    let mut bound: rustc_hash::FxHashSet<(&str, &str)> = locals
        .iter()
        .map(|local| (local.unit.as_str(), local.name.as_str()))
        .collect();
    for node in nodes {
        for parameter in node.signature.iter().flat_map(|signature| signature.parameters.iter()) {
            bound.insert((node.id.as_str(), parameter.name.as_str()));
        }
    }
    let written = |call: &crate::model::CallFact, literal: &str| {
        call.caller.as_deref().is_none_or(|caller| !bound.contains(&(caller, literal)))
    };
    let placed: rustc_hash::FxHashMap<&str, (u32, &str)> = nodes
        .iter()
        .filter_map(|node| Some((node.id.as_str(), (node.span.line, node.parent.as_deref()?))))
        .collect();
    let mut creations: Vec<(usize, Table)> = calls
        .iter()
        .enumerate()
        .filter(|(_, call)| creates_a_table(call))
        .filter(|(_, call)| paths.get(call.file as usize).is_some_and(|path| !crate::paths::is_test(path)))
        .filter_map(|(at, call)| {
            let named = call
                .literals
                .iter()
                .filter(|literal| written(call, literal))
                .find_map(|literal| named_in(literal))?;
            Some((
                at,
                Table {
                    named: named.to_ascii_lowercase(),
                    columns: Vec::new(),
                    points_at: Vec::new(),
                    file: call.file,
                    line: call.line,
                    declared_by: None,
                    change: Change::Created,
                },
            ))
        })
        .collect();
    let mut following: rustc_hash::FxHashMap<(u32, &str), Vec<(u32, usize)>> =
        rustc_hash::FxHashMap::default();
    for (held, (at, table)) in creations.iter().enumerate() {
        if let Some(caller) = calls[*at].caller.as_deref() {
            following.entry((table.file, caller)).or_default().push((table.line, held));
        }
    }
    for held in following.values_mut() {
        held.sort();
    }
    let fields_on: rustc_hash::FxHashSet<(&str, u32)> = nodes
        .iter()
        .filter(|node| node.kind == crate::model::NodeKind::Property)
        .filter_map(|node| Some((node.parent.as_deref()?, node.span.line)))
        .collect();
    let holding_rows: rustc_hash::FxHashSet<&str> = nodes
        .iter()
        .filter(|node| node.kind == crate::model::NodeKind::Class)
        .map(|node| node.id.as_str())
        .collect();
    for call in calls {
        let in_a_schema = paths
            .get(call.file as usize)
            .is_some_and(|path| SCHEMAS_MAPPING_BY_CALL.iter().any(|written| path.ends_with(written)));
        let Some(owner) = call.caller.as_deref() else { continue };
        if !in_a_schema
            || !MAPS_ITS_TABLE.contains(&call.callee.as_str())
            || !holding_rows.contains(owner)
            || fields_on.contains(&(owner, call.line))
        {
            continue;
        }
        let Some(named) = call.literals.first().and_then(|literal| named_in(literal)) else {
            continue;
        };
        creations.push((
            usize::MAX,
            Table {
                named: named.to_ascii_lowercase(),
                columns: Vec::new(),
                points_at: Vec::new(),
                file: call.file,
                line: call.line,
                declared_by: Some(owner.to_string()),
                change: Change::Created,
            },
        ));
    }
    let mut columns: Vec<(usize, Column)> = Vec::new();
    for call in calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        let Some(named) = call
            .literals
            .first()
            .and_then(|literal| named_in(literal))
            .filter(|named| call.receiver.as_deref() != Some(named.as_str()))
        else {
            continue;
        };
        let by_a_block = placed.get(caller).and_then(|(opened, within)| {
            following
                .get(&(call.file, *within))?
                .iter()
                .rev()
                .find(|(line, _)| *line <= *opened)
                .filter(|(line, _)| *opened - *line <= OPENS_BESIDE_ITS_CREATION)
                .map(|(_, held)| *held)
        });
        let callee = crate::names::leaf(&call.callee);
        let by_a_column = || {
            DECLARES_A_COLUMN.contains(&callee.to_ascii_lowercase().as_str())
                .then(|| following.get(&(call.file, caller)))
                .flatten()
                .and_then(|held| held.iter().rev().find(|(line, _)| *line <= call.line))
                .map(|(_, held)| *held)
        };
        let Some(table) = by_a_block.or_else(by_a_column) else { continue };
        columns.push((
            table,
            Column {
                named: named.to_ascii_lowercase(),
                declared_as: Some(callee.to_string()),
            },
        ));
    }
    for (table, column) in columns {
        let held = &mut creations[table].1.columns;
        if !held.iter().any(|known| known.named == column.named) {
            held.push(column);
        }
    }
    creations.into_iter().map(|(_, table)| table).collect()
}

pub static NAMES_ITS_TABLE: &[&str] = &["$table", "__tablename__", "_table_name", "db_table", "table_name"];

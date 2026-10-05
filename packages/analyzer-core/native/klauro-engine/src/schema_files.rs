use std::sync::LazyLock;

use regex::Regex;

use crate::tables::{Change, Column, Table};

static RAILS_COLUMN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"add_column\s+[:"']+(\w+)["']?\s*,\s*[:"']+(\w+)["']?\s*,\s*[:"']+(\w+)"#).unwrap()
});
static RAILS_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"add_reference\s+[:"']+(\w+)["']?\s*,\s*[:"']+(\w+)"#).unwrap()
});
static RAILS_FOREIGN_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"add_foreign_key\s+[:"']+(\w+)["']?\s*,\s*[:"']+(\w+)["']?(?:[^\n]*?column:\s*[:"']+(\w+))?"#).unwrap()
});
static EF_COLUMN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"AddColumn<\s*([\w?.]+)\s*>\(\s*name:\s*"(\w+)"\s*,\s*(?:schema:\s*"\w+"\s*,\s*)?table:\s*"(\w+)""#).unwrap()
});
static DRIZZLE_TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:pg|mysql|sqlite|singlestore)Table\(\s*["'`](\w+)["'`]\s*,\s*\{"#).unwrap()
});
static DRIZZLE_COLUMN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*(\w+)\s*:\s*(\w+)\(\s*(?:["'`](\w+)["'`])?"#).unwrap()
});
static DRIZZLE_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"references\(\s*\(\)\s*=>\s*(\w+)\.").unwrap());
static GORM_STRUCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^type\s+(\w+)\s+struct\s*\{").unwrap());
static GORM_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(\w+)\s+([\w.*\[\]]+)\s+`[^`]*gorm:"([^"]*)""#).unwrap());
static GORM_TABLE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"func\s*\(\s*(?:\w+\s+)?\*?(\w+)\s*\)\s*TableName\(\)\s*string\s*\{\s*return\s*"(\w+)""#).unwrap()
});
static SEQUELIZE_MODEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\.define\(\s*["'`](\w+)["'`]\s*,\s*\{"#).unwrap()
});
static SEQUELIZE_COLUMN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s{1,8}(\w+)\s*:\s*(?:\{\s*type\s*:\s*)?(?:Sequelize|DataTypes)\.(\w+)"#).unwrap()
});

fn added(named: &str, columns: Vec<Column>, points_at: Vec<(String, String)>, line: u32) -> Table {
    Table { named: named.to_ascii_lowercase(), columns, points_at, file: 0, line, declared_by: None, change: Change::Added }
}

fn created(named: String, columns: Vec<Column>, points_at: Vec<(String, String)>, line: u32) -> Table {
    Table { named, columns, points_at, file: 0, line, declared_by: None, change: Change::Created }
}

fn line_of(text: &str, at: usize) -> u32 {
    text[..at].matches('\n').count() as u32 + 1
}

fn singular(plural: &str) -> String {
    let lowered = plural.to_ascii_lowercase();
    match (lowered.strip_suffix("ies"), lowered.strip_suffix('s')) {
        (Some(stem), _) => format!("{stem}y"),
        (None, Some(stem)) => stem.to_string(),
        _ => lowered,
    }
}

fn plural(singular: &str) -> String {
    let lowered = singular.to_ascii_lowercase();
    match lowered.strip_suffix('y') {
        Some(stem) if !stem.ends_with(['a', 'e', 'i', 'o', 'u']) => format!("{stem}ies"),
        _ if lowered.ends_with(['s', 'x', 'z']) || lowered.ends_with("ch") || lowered.ends_with("sh") => format!("{lowered}es"),
        _ => format!("{lowered}s"),
    }
}

fn snake(word: &str) -> String {
    let mut spelled = String::new();
    let letters: Vec<char> = word.chars().collect();
    for (at, letter) in letters.iter().enumerate() {
        if letter.is_uppercase() && at > 0 && (letters[at - 1].is_lowercase() || letters.get(at + 1).is_some_and(|next| next.is_lowercase())) {
            spelled.push('_');
        }
        spelled.extend(letter.to_lowercase());
    }
    spelled
}

fn body_of(text: &str, open: usize) -> &str {
    let mut depth = 0i32;
    for (at, letter) in text[open..].char_indices() {
        match letter {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &text[open + 1..open + at];
                }
            }
            _ => {}
        }
    }
    &text[open + 1..]
}

fn rails(text: &str) -> Vec<Table> {
    let mut found = Vec::new();
    for held in RAILS_COLUMN.captures_iter(text) {
        let at = held.get(0).map_or(0, |whole| whole.start());
        found.push(added(&held[1], vec![Column { named: held[2].to_ascii_lowercase(), declared_as: Some(held[3].to_string()) }], Vec::new(), line_of(text, at)));
    }
    for held in RAILS_REFERENCE.captures_iter(text) {
        let at = held.get(0).map_or(0, |whole| whole.start());
        let column = format!("{}_id", held[2].to_ascii_lowercase());
        found.push(added(&held[1], vec![Column { named: column, declared_as: Some("reference".to_string()) }], Vec::new(), line_of(text, at)));
    }
    for held in RAILS_FOREIGN_KEY.captures_iter(text) {
        let at = held.get(0).map_or(0, |whole| whole.start());
        let column = held.get(3).map_or_else(|| format!("{}_id", singular(&held[2])), |named| named.as_str().to_string());
        found.push(added(&held[1], Vec::new(), vec![(column, held[2].to_ascii_lowercase())], line_of(text, at)));
    }
    found
}

fn entity_framework(text: &str) -> Vec<Table> {
    EF_COLUMN
        .captures_iter(text)
        .map(|held| {
            let at = held.get(0).map_or(0, |whole| whole.start());
            added(&held[3], vec![Column { named: held[2].to_ascii_lowercase(), declared_as: Some(held[1].to_string()) }], Vec::new(), line_of(text, at))
        })
        .collect()
}

fn drizzle(text: &str) -> Vec<Table> {
    let heads: Vec<(String, String, usize)> = DRIZZLE_TABLE
        .captures_iter(text)
        .filter_map(|held| Some((held[1].to_string(), held[2].to_string(), held.get(0)?.end() - 1)))
        .collect();
    let names: std::collections::HashMap<&str, &str> = heads.iter().map(|(binding, table, _)| (binding.as_str(), table.as_str())).collect();
    heads
        .iter()
        .map(|(_, table, open)| {
            let body = body_of(text, *open);
            let mut columns = Vec::new();
            let mut points_at = Vec::new();
            for row in body.lines() {
                let Some(held) = DRIZZLE_COLUMN.captures(row) else { continue };
                let key = &held[1];
                let named = held.get(3).map_or(key, |literal| literal.as_str()).to_ascii_lowercase();
                if let Some(reference) = DRIZZLE_REFERENCE.captures(row)
                    && let Some(target) = names.get(&reference[1])
                {
                    points_at.push((named.clone(), target.to_ascii_lowercase()));
                }
                columns.push(Column { named, declared_as: Some(held[2].to_string()) });
            }
            created(table.to_ascii_lowercase(), columns, points_at, line_of(text, *open))
        })
        .filter(|table| !table.columns.is_empty())
        .collect()
}

fn gorm(text: &str) -> Vec<Table> {
    let named: std::collections::HashMap<&str, &str> = GORM_TABLE_NAME
        .captures_iter(text)
        .filter_map(|held| Some((held.get(1)?.as_str(), held.get(2)?.as_str())))
        .collect();
    let mut found = Vec::new();
    for held in GORM_STRUCT.captures_iter(text) {
        let Some(open) = held.get(0).map(|whole| whole.end() - 1) else { continue };
        let body = body_of(text, open);
        let mut columns = Vec::new();
        for row in body.lines() {
            let Some(field) = GORM_FIELD.captures(row) else { continue };
            let tag = &field[3];
            if tag == "-" || tag.starts_with("-:") {
                continue;
            }
            let column = tag
                .split(';')
                .find_map(|part| part.trim().strip_prefix("column:"))
                .map_or_else(|| snake(&field[1]), |explicit| explicit.to_ascii_lowercase());
            columns.push(Column { named: column, declared_as: Some(field[2].to_string()) });
        }
        if columns.is_empty() {
            continue;
        }
        let table = named.get(&held[1]).map_or_else(|| plural(&snake(&held[1])), |explicit| explicit.to_ascii_lowercase());
        found.push(created(table, columns, Vec::new(), line_of(text, open)));
    }
    found
}

fn sequelize(text: &str) -> Vec<Table> {
    SEQUELIZE_MODEL
        .captures_iter(text)
        .filter_map(|held| {
            let open = held.get(0)?.end() - 1;
            let columns: Vec<Column> = body_of(text, open)
                .lines()
                .filter_map(|row| {
                    let column = SEQUELIZE_COLUMN.captures(row)?;
                    Some(Column { named: column[1].to_ascii_lowercase(), declared_as: Some(column[2].to_string()) })
                })
                .collect();
            (!columns.is_empty()).then(|| created(plural(&held[1]), columns, Vec::new(), line_of(text, open)))
        })
        .collect()
}

pub fn declared(text: &str, path: &str) -> Vec<Table> {
    let lowered = path.to_ascii_lowercase();
    let extension = lowered.rsplit_once('.').map_or("", |(_, extension)| extension);
    match extension {
        "rb" if text.contains("add_column") || text.contains("add_reference") || text.contains("add_foreign_key") => rails(text),
        "cs" if text.contains("AddColumn<") => entity_framework(text),
        "ts" | "js" | "mjs" | "cjs" | "mts" | "cts" if text.contains("Table(") && text.contains("drizzle") => drizzle(text),
        "ts" | "js" | "mjs" | "cjs" | "mts" | "cts" if text.contains(".define(") && text.contains("DataTypes") => sequelize(text),
        "go" if text.contains("gorm:\"") => gorm(text),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns(table: &Table) -> Vec<&str> {
        table.columns.iter().map(|column| column.named.as_str()).collect()
    }

    #[test]
    fn a_rails_migration_adds_columns_and_references_to_existing_tables() {
        let found = declared("add_column :owners, :nickname, :string\nadd_reference :widgets, :batch, foreign_key: true\nadd_foreign_key \"widgets\", \"owners\"\n", "db/migrate/1_x.rb");
        assert_eq!(found.len(), 3);
        assert_eq!((found[0].named.as_str(), columns(&found[0])), ("owners", vec!["nickname"]));
        assert_eq!(columns(&found[1]), vec!["batch_id"]);
        assert_eq!(found[2].points_at, vec![("owner_id".to_string(), "owners".to_string())]);
        assert!(found.iter().all(|table| table.change == Change::Added));
    }

    #[test]
    fn an_entity_framework_migration_adds_a_column_to_the_table_it_names() {
        let found = declared("migrationBuilder.AddColumn<string>(name: \"Carrier\", table: \"Shipments\", nullable: true);", "Migrations/1.cs");
        assert_eq!((found[0].named.as_str(), columns(&found[0])), ("shipments", vec!["carrier"]));
    }

    #[test]
    fn a_drizzle_table_names_its_columns_and_the_table_a_column_points_at() {
        let text = "import { pgTable } from \"drizzle-orm/pg-core\";\nexport const users = pgTable(\"users\", {\n  id: serial(\"id\").primaryKey(),\n  fullName: text(\"full_name\"),\n});\nexport const orders = pgTable(\"orders\", {\n  id: serial(\"id\"),\n  userId: integer(\"user_id\").references(() => users.id),\n});\n";
        let found = declared(text, "src/schema.ts");
        assert_eq!(found.len(), 2);
        assert_eq!(columns(&found[0]), vec!["id", "full_name"]);
        assert_eq!(found[1].points_at, vec![("user_id".to_string(), "users".to_string())]);
    }

    #[test]
    fn a_gorm_struct_becomes_a_table_named_by_the_convention_or_by_its_method() {
        let text = "type OrderLine struct {\n\tID uint `gorm:\"primaryKey\"`\n\tUnitPrice float64 `gorm:\"column:price\"`\n\tNote string `gorm:\"-\"`\n}\nfunc (OrderLine) TableName() string { return \"lines\" }\ntype Customer struct {\n\tFullName string `gorm:\"not null\"`\n}\n";
        let found = declared(text, "models/m.go");
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].named.as_str(), columns(&found[0])), ("lines", vec!["id", "price"]));
        assert_eq!((found[1].named.as_str(), columns(&found[1])), ("customers", vec!["full_name"]));
    }

    #[test]
    fn a_sequelize_model_becomes_a_table_of_its_plural_name() {
        let text = "sequelize.define(\"Ticket\", {\n  title: DataTypes.STRING,\n  priority: { type: DataTypes.INTEGER },\n});";
        let found = declared(text, "models/ticket.js");
        assert_eq!((found[0].named.as_str(), columns(&found[0])), ("tickets", vec!["title", "priority"]));
    }
}

pub fn is_declarative(path: &str, source: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(source) else { return false };
    !declared(text, path).is_empty()
}

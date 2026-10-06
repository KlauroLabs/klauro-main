use tree_sitter::{Node, Parser};

pub enum Kind {
    Map(Vec<(String, Value)>),
    Seq(Vec<Value>),
    Text(String),
}

pub struct Value {
    pub line: u32,
    pub kind: Kind,
}

const DEEPEST: usize = 48;

const NO_ENTRIES: &[(String, Value)] = &[];
const NO_ITEMS: &[Value] = &[];

impl Value {
    pub fn parse(source: &str) -> Option<Value> {
        let mut parser = Parser::new();
        parser.set_language(&tree_sitter_yaml::LANGUAGE.into()).ok()?;
        let tree = parser.parse(source, None)?;
        if deeper_than(tree.root_node(), DEEPEST) {
            return None;
        }
        convert(tree.root_node(), source.as_bytes())
    }

    pub fn entries(&self) -> &[(String, Value)] {
        match &self.kind {
            Kind::Map(held) => held,
            _ => NO_ENTRIES,
        }
    }

    pub fn items(&self) -> &[Value] {
        match &self.kind {
            Kind::Seq(held) => held,
            _ => NO_ITEMS,
        }
    }

    pub fn text(&self) -> Option<&str> {
        match &self.kind {
            Kind::Text(held) => Some(held),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries().iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    pub fn get_any(&self, keys: &[&str]) -> Option<&Value> {
        keys.iter().find_map(|key| self.get(key))
    }

    pub fn names(&self) -> Vec<String> {
        match &self.kind {
            Kind::Text(held) => vec![held.clone()],
            Kind::Seq(items) => items.iter().flat_map(Value::names).collect(),
            Kind::Map(entries) => match entries.iter().find(|(key, _)| key == "job" || key == "name") {
                Some((_, value)) => value.names(),
                None => entries.iter().map(|(key, _)| key.clone()).collect(),
            },
        }
    }

    pub fn strings<'a>(&'a self, out: &mut Vec<&'a str>) {
        match &self.kind {
            Kind::Text(held) => out.push(held),
            Kind::Seq(items) => items.iter().for_each(|item| item.strings(out)),
            Kind::Map(entries) => entries.iter().for_each(|(key, value)| {
                out.push(key);
                value.strings(out);
            }),
        }
    }

    pub fn brief(&self) -> String {
        match &self.kind {
            Kind::Text(held) => held.clone(),
            Kind::Seq(items) => items.iter().map(Value::brief).collect::<Vec<_>>().join(", "),
            Kind::Map(entries) => entries
                .iter()
                .map(|(key, value)| format!("{key}: {}", value.brief()))
                .collect::<Vec<_>>()
                .join(", "),
        }
    }

    pub fn find_deep(&self, key: &str) -> Option<&Value> {
        if let Some(found) = self.get(key) {
            return Some(found);
        }
        self.entries().iter().find_map(|(_, value)| value.find_deep(key))
    }
}

fn deeper_than(root: Node, limit: usize) -> bool {
    let mut cursor = root.walk();
    let mut depth = 0usize;
    loop {
        if cursor.goto_first_child() {
            depth += 1;
            if depth > limit {
                return true;
            }
            continue;
        }
        while !cursor.goto_next_sibling() {
            if depth == 0 || !cursor.goto_parent() {
                return false;
            }
            depth -= 1;
        }
    }
}

fn text_of(node: Node, source: &[u8]) -> String {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or("").to_string()
}

fn flow_text(node: Node, source: &[u8]) -> String {
    text_of(node, source).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn quoted(node: Node, source: &[u8]) -> String {
    let raw = text_of(node, source);
    let inner = raw.trim();
    let inner = inner.strip_prefix(['"', '\'']).unwrap_or(inner);
    let inner = inner.strip_suffix(['"', '\'']).unwrap_or(inner);
    inner.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn block_text(node: Node, source: &[u8]) -> String {
    let raw = text_of(node, source);
    let mut lines = raw.lines();
    lines.next();
    let body: Vec<&str> = lines.collect();
    let indent = body
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    body.iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

fn convert(node: Node, source: &[u8]) -> Option<Value> {
    let line = line_of(node);
    let kind = match node.kind() {
        "stream" | "document" | "block_node" | "flow_node" => {
            let mut cursor = node.walk();
            return node
                .named_children(&mut cursor)
                .filter(|child| !matches!(child.kind(), "anchor" | "tag" | "comment"))
                .find_map(|child| convert(child, source));
        }
        "block_mapping" | "flow_mapping" => {
            let mut cursor = node.walk();
            let entries = node
                .named_children(&mut cursor)
                .filter(|child| matches!(child.kind(), "block_mapping_pair" | "flow_pair"))
                .filter_map(|pair| {
                    let key = pair.child_by_field_name("key").and_then(|key| convert(key, source))?;
                    let name = key.text()?.to_string();
                    let value = pair
                        .child_by_field_name("value")
                        .and_then(|value| convert(value, source))
                        .unwrap_or(Value { line: line_of(pair), kind: Kind::Text(String::new()) });
                    Some((name, Value { line: line_of(pair), ..value }))
                })
                .collect();
            Kind::Map(entries)
        }
        "block_sequence" | "flow_sequence" => {
            let mut cursor = node.walk();
            let items = node
                .named_children(&mut cursor)
                .filter(|child| child.kind() != "comment")
                .map(|item| match item.kind() {
                    "block_sequence_item" => {
                        let mut inner = item.walk();
                        let found = item
                            .named_children(&mut inner)
                            .filter(|child| child.kind() != "comment")
                            .find_map(|child| convert(child, source));
                        Value { line: line_of(item), ..found.unwrap_or(Value { line: 0, kind: Kind::Text(String::new()) }) }
                    }
                    "flow_pair" => {
                        let mut single = Vec::new();
                        if let Some(key) = item.child_by_field_name("key").and_then(|key| convert(key, source))
                            && let Some(name) = key.text()
                        {
                            let value = item
                                .child_by_field_name("value")
                                .and_then(|value| convert(value, source))
                                .unwrap_or(Value { line: line_of(item), kind: Kind::Text(String::new()) });
                            single.push((name.to_string(), value));
                        }
                        Value { line: line_of(item), kind: Kind::Map(single) }
                    }
                    _ => convert(item, source).unwrap_or(Value { line: line_of(item), kind: Kind::Text(String::new()) }),
                })
                .collect();
            Kind::Seq(items)
        }
        "plain_scalar" => Kind::Text(flow_text(node, source)),
        "double_quote_scalar" | "single_quote_scalar" => Kind::Text(quoted(node, source)),
        "block_scalar" => Kind::Text(block_text(node, source)),
        "alias" => Kind::Text(String::new()),
        _ => return None,
    };
    Some(Value { line, kind })
}

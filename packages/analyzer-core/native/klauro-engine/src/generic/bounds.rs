use tree_sitter::Node;

static ITEMS_WITH_PARAMETERS: &[&str] = &["function_item", "impl_item", "struct_item", "enum_item", "trait_item"];
static BOUND_KINDS: &[&str] = &["type_identifier", "scoped_type_identifier", "generic_type"];
static MARKERS: &[&str] = &["Clone", "Copy", "Debug", "Default", "Display", "Eq", "Hash", "Ord", "PartialEq", "PartialOrd", "Send", "Sized", "Sync", "Unpin"];

fn text<'s>(source: &'s [u8], node: Node) -> &'s str {
    source.get(node.byte_range()).and_then(|held| std::str::from_utf8(held).ok()).unwrap_or("")
}

fn first_trait(source: &[u8], bounds: Node) -> Option<String> {
    let mut cursor = bounds.walk();
    bounds
        .named_children(&mut cursor)
        .filter(|bound| BOUND_KINDS.contains(&bound.kind()))
        .map(|bound| {
            let named = bound.child_by_field_name("type").unwrap_or(bound);
            text(source, named).trim().to_string()
        })
        .find(|written| !MARKERS.contains(&written.rsplit("::").next().unwrap_or(written)))
}

fn declared_bounds(source: &[u8], item: Node, held: &mut Vec<(String, String)>) {
    if let Some(parameters) = item.child_by_field_name("type_parameters") {
        let mut cursor = parameters.walk();
        for parameter in parameters.named_children(&mut cursor) {
            let name = parameter.child_by_field_name("name").or_else(|| parameter.child_by_field_name("left"));
            let bounds = parameter.child_by_field_name("bounds");
            if let (Some(name), Some(bounds)) = (name, bounds)
                && let Some(held_trait) = first_trait(source, bounds)
            {
                held.push((text(source, name).trim().to_string(), held_trait));
            }
        }
    }
    let mut cursor = item.walk();
    for clause in item.named_children(&mut cursor).filter(|child| child.kind() == "where_clause") {
        let mut inner = clause.walk();
        for predicate in clause.named_children(&mut inner).filter(|child| child.kind() == "where_predicate") {
            if let (Some(left), Some(bounds)) = (predicate.child_by_field_name("left"), predicate.child_by_field_name("bounds"))
                && left.kind() == "type_identifier"
                && let Some(held_trait) = first_trait(source, bounds)
            {
                held.push((text(source, left).trim().to_string(), held_trait));
            }
        }
    }
}

pub(super) fn in_scope(source: &[u8], node: Node) -> Vec<(String, String)> {
    let mut held = Vec::new();
    let mut at = Some(node);
    while let Some(current) = at {
        if ITEMS_WITH_PARAMETERS.contains(&current.kind()) {
            declared_bounds(source, current, &mut held);
        }
        at = current.parent();
    }
    held
}

fn is_word(letter: char) -> bool {
    letter.is_alphanumeric() || letter == '_'
}

pub(super) fn bounded(written: &str, bounds: &[(String, String)]) -> String {
    let mut spoken = String::with_capacity(written.len());
    let mut word = String::new();
    let mut flush = |word: &mut String, spoken: &mut String| {
        if word.is_empty() {
            return;
        }
        match bounds.iter().find(|(name, _)| name == word) {
            Some((_, held_trait)) => {
                spoken.push_str("dyn ");
                spoken.push_str(held_trait);
            }
            None => spoken.push_str(word),
        }
        word.clear();
    };
    for letter in written.chars() {
        if is_word(letter) {
            word.push(letter);
        } else {
            flush(&mut word, &mut spoken);
            spoken.push(letter);
        }
    }
    flush(&mut word, &mut spoken);
    spoken
}

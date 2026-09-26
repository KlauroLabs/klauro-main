use tree_sitter::Node;

static ARMS: &[(&str, &str, &[&str])] = &[
    ("csharp", "switch_expression_arm", &["=>"]),
    ("csharp", "switch_section", &[":"]),
    ("java", "switch_block_statement_group", &["->", ":"]),
    ("java", "switch_rule", &["->", ":"]),
    ("kotlin", "when_entry", &["->"]),
    ("rust", "match_arm", &["=>"]),
    ("swift", "switch_entry", &[":"]),
];

static FAMILIES: &[&str] = &["Action", "Command", "Event", "Intent", "Msg"];
static SUBJECTS: &[&str] = &["action", "command", "event", "intent", "msg"];
static ON_SCREEN: &[&str] = &["Screen", "UI", "Ui", "View"];
static TAKEN_BY_HAND: &[&str] = &["Intent"];
static SCREEN_KEEPERS: &[&str] = &["Feature", "Presenter", "Reducer", "Screen", "View", "ViewModel"];
static WORDS_BEFORE_A_PATTERN: &[&str] = &["case ", "is ", "let ", "var "];

pub struct Dispatched {
    pub case: String,
    pub label: String,
    pub kind: &'static str,
}

fn subject_of<'t, 's>(arm: Node<'t>, text: &impl Fn(Node<'t>) -> &'s str) -> Option<String> {
    let mut holder = arm.parent()?;
    for _ in 0..3 {
        let subject = holder
            .child_by_field_name("value")
            .or_else(|| holder.child_by_field_name("condition"))
            .or_else(|| holder.child_by_field_name("subject"))
            .or_else(|| {
                let mut cursor = holder.walk();
                holder
                    .named_children(&mut cursor)
                    .find(|child| matches!(child.kind(), "when_subject" | "simple_identifier" | "identifier" | "parenthesized_expression"))
            });
        if let Some(subject) = subject {
            let written = text(subject).trim_matches(|held: char| held == '(' || held == ')' || held.is_whitespace());
            let written = written.rsplit_once(" = ").map(|(_, value)| value).unwrap_or(written);
            let last = written.rsplit(['.', ':']).next().unwrap_or(written).trim();
            return Some(last.to_string());
        }
        holder = holder.parent()?;
    }
    None
}

fn names_a_family(name: &str) -> bool {
    FAMILIES.iter().any(|suffix| name.ends_with(suffix))
}

fn on_screen(family: &str) -> bool {
    ON_SCREEN.iter().any(|word| family.contains(word)) || TAKEN_BY_HAND.iter().any(|suffix| family.ends_with(suffix))
}

fn keeper_of<'t, 's>(arm: Node<'t>, text: &impl Fn(Node<'t>) -> &'s str) -> Option<&'s str> {
    let mut holder = arm.parent();
    while let Some(held) = holder {
        let kind = held.kind();
        if kind.contains("class") || kind.contains("struct") || kind.contains("object_declaration") || kind == "impl_item" {
            let named = held.child_by_field_name("name").or_else(|| held.child_by_field_name("type")).or_else(|| {
                let mut cursor = held.walk();
                held.named_children(&mut cursor)
                    .find(|child| matches!(child.kind(), "type_identifier" | "simple_identifier" | "identifier"))
            })?;
            return Some(text(named));
        }
        holder = held.parent();
    }
    None
}

pub fn dispatched<'t, 's>(language: &str, arm: Node<'t>, text: impl Fn(Node<'t>) -> &'s str) -> Option<Dispatched> {
    let (_, _, separators) = ARMS.iter().find(|(spoken, kind, _)| *spoken == language && *kind == arm.kind())?;
    let written = text(arm);
    let before = separators
        .iter()
        .filter_map(|separator| written.find(separator))
        .min()
        .map(|at| &written[..at])?;
    let mut pattern = before.trim();
    for word in WORDS_BEFORE_A_PATTERN {
        pattern = pattern.strip_prefix(word).unwrap_or(pattern).trim_start();
    }
    let pattern = pattern
        .split(['(', '{', ' ', ',', '<', '\n'])
        .next()
        .unwrap_or("")
        .trim();
    if pattern.is_empty() || pattern == "_" || pattern.starts_with(|held: char| held.is_ascii_digit() || held == '"' || held == '\'') {
        return None;
    }
    let shorthand = pattern.starts_with('.');
    let segments: Vec<&str> = pattern
        .split("::")
        .flat_map(|part| part.split('.'))
        .filter(|segment| !segment.is_empty())
        .collect();
    let case = *segments.last()?;
    let shouted = !case.chars().any(|held| held.is_lowercase());
    if shouted || !case.chars().all(|held| held.is_alphanumeric() || held == '_') || matches!(case, "else" | "default") {
        return None;
    }
    let subject = subject_of(arm, &text).map(|held| held.to_ascii_lowercase());
    let told_by_subject = subject.as_deref().is_some_and(|held| SUBJECTS.iter().any(|word| held.ends_with(word)));
    let family = match (shorthand, segments.len()) {
        (false, count) if count >= 2 => Some(segments[count - 2].to_string()),
        (false, _) if names_a_family(case) => Some(case.to_string()),
        _ => None,
    };
    let kept_by_a_screen = keeper_of(arm, &text).is_some_and(|keeper| SCREEN_KEEPERS.iter().any(|suffix| keeper.ends_with(suffix)));
    let taken_by_hand = match (&family, told_by_subject) {
        (Some(family), _) if names_a_family(family) => on_screen(family) || (family.ends_with("Action") && kept_by_a_screen),
        (_, true) => kept_by_a_screen && subject.as_deref().is_some_and(|held| held.ends_with("action") || held.ends_with("intent")),
        _ => false,
    };
    if !taken_by_hand {
        return None;
    }
    let kind = "ui";
    if !shorthand && !case.starts_with(|held: char| held.is_ascii_uppercase()) {
        return None;
    }
    let label = match &family {
        Some(family) if family != case => format!("{family}.{case}"),
        _ => case.to_string(),
    };
    Some(Dispatched { case: case.to_string(), label, kind })
}

use crate::entry_exit::EntryPoint;

use super::humanized;

fn singular(word: &str) -> String {
    match word {
        _ if word.ends_with("ies") && word.len() > 4 => format!("{}y", &word[..word.len() - 3]),
        _ if word.ends_with("ss") || word.ends_with("us") || word.ends_with("is") => word.to_string(),
        _ if word.ends_with('s') && word.len() > 3 => word[..word.len() - 1].to_string(),
        _ => word.to_string(),
    }
}

fn plural(word: &str) -> bool {
    singular(word) != word
}

fn a_placeholder(segment: &str) -> bool {
    segment.starts_with('{') || segment.starts_with(':') || segment.starts_with('<') || segment.starts_with('*') || segment.starts_with('[')
}

fn a_version(segment: &str) -> bool {
    segment.strip_prefix('v').is_some_and(|digits| !digits.is_empty() && digits.chars().all(|letter| letter.is_ascii_digit()))
}

fn words(segment: &str) -> String {
    segment.replace(['-', '_', '.'], " ").to_ascii_lowercase()
}

fn route_action(method: &str, path: &str) -> String {
    let mut nouns: Vec<(String, bool)> = Vec::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        if a_placeholder(segment) {
            if let Some(last) = nouns.last_mut() {
                last.1 = true;
            }
        } else if segment != "api" && !a_version(segment) {
            nouns.push((words(segment), false));
        }
    }
    let last_plural = nouns.last().is_some_and(|(noun, followed)| !followed && noun.split(' ').next_back().is_some_and(plural));
    let named: Vec<String> = nouns
        .iter()
        .enumerate()
        .map(|(position, (noun, followed))| {
            let last = position + 1 == nouns.len();
            let single = *followed || (last && matches!(method, "POST") && last_plural);
            match noun.rsplit_once(' ') {
                Some((head, tail)) if single => format!("{head} {}", singular(tail)),
                None if single => singular(noun),
                _ => noun.clone(),
            }
        })
        .collect();
    let subject = if named.is_empty() { "root".to_string() } else { named.join(" ") };
    let verb = match method {
        "GET" if last_plural => "List",
        "GET" => "Get",
        "POST" if last_plural => "Create",
        "POST" => "Submit",
        "PUT" => "Replace",
        "PATCH" => "Update",
        "DELETE" => "Delete",
        _ => "Check",
    };
    format!("{verb} {subject}")
}

pub(super) fn action_of(entry: &EntryPoint, handler: Option<&str>) -> String {
    match (entry.kind, entry.method.as_deref(), entry.path.as_deref()) {
        ("http", Some(method), Some(path)) => route_action(&method.to_ascii_uppercase(), path),
        ("ui", ..) => handler.map(humanized).unwrap_or_else(|| humanized(&entry.name)),
        ("cli", ..) => format!("Run {}", humanized(entry.name.trim_start_matches('-')).to_lowercase()),
        ("ipc", ..) => humanized(entry.name.rsplit(':').next().unwrap_or(&entry.name)),
        _ => humanized(&entry.name),
    }
}

fn names_a_place(target: &str) -> bool {
    target.contains(['/', '.', ':'])
}

pub(super) fn ending_of(effect: &str) -> Option<(String, &'static str)> {
    let (kind, target) = effect.split_once(':').unwrap_or((effect, ""));
    let place = names_a_place(target);
    match kind {
        "process" => Some(("start an external process".to_string(), "process")),
        "file" => Some(("read or write files".to_string(), "file")),
        "database" if !target.is_empty() => Some((format!("read or write the {target} database"), "database")),
        "database" => Some(("read or write a database".to_string(), "database")),
        "network" | "api" if place => Some((format!("call {target}"), "call")),
        "network" | "api" => Some(("call an outside service".to_string(), "call")),
        "message" if !target.is_empty() => Some((format!("publish a message through {target}"), "message")),
        "message" => Some(("publish a message".to_string(), "message")),
        _ => None,
    }
}

pub(super) fn titled(action: &str, effect: Option<&str>) -> String {
    let Some((ending, noun)) = effect.and_then(ending_of) else { return action.to_string() };
    if action.to_ascii_lowercase().contains(noun) {
        return action.to_string();
    }
    format!("{action} and {ending}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_is_phrased_as_a_verb_and_the_resource_it_names() {
        assert_eq!(route_action("GET", "/api/workspaces/{param}/analysis"), "Get workspace analysis");
        assert_eq!(route_action("POST", "/v1/coordination/check"), "Submit coordination check");
        assert_eq!(route_action("GET", "/api/projects"), "List projects");
        assert_eq!(route_action("POST", "/api/projects"), "Create project");
        assert_eq!(route_action("DELETE", "/api/projects/{id}"), "Delete project");
        assert_eq!(route_action("GET", "/"), "Get root");
    }

    #[test]
    fn an_ending_is_added_unless_the_action_already_says_it() {
        assert_eq!(titled("Save note", Some("file:fs")), "Save note and read or write files");
        assert_eq!(titled("Write file", Some("file:fs")), "Write file");
        assert_eq!(titled("Send ask", Some("api:fetch")), "Send ask and call an outside service");
        assert_eq!(titled("Send ask", Some("api:/api/me")), "Send ask and call /api/me");
        assert_eq!(titled("Send ask", None), "Send ask");
    }
}

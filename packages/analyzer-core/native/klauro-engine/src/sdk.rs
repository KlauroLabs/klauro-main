use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::ExitPoint;
use crate::model::{EdgeKind, IndexEdge, IndexNode};

static SAID_OF_A_CLIENT: &[&str] = &["Api", "Client", "Service"];
static SAID_OF_ANY_PACKAGE: &[&str] = &[
    "android", "androidx", "api", "apis", "app", "client", "clients", "com", "core", "dev", "internal", "io",
    "java", "javax", "kotlin", "kotlinx", "lib", "model", "models", "net", "org", "sdk", "service", "services",
    "dynamic", "graphql", "grpc", "http", "rest", "web",
];

static SPEAKS_TO_A_REMOTE: &[&str] = &["DataSource", "Gateway", "Remote"];

const OWN_NAMESPACE_DEPTH: usize = 2;

pub struct Reached {
    pub service: String,
    pub specifier: String,
    pub by_its_name_alone: bool,
}

fn words_of(specifier: &str) -> Vec<String> {
    specifier
        .split(['.', '/', ':'])
        .filter(|segment| !segment.is_empty())
        .map(str::to_ascii_lowercase)
        .filter(|segment| segment.len() >= 3 && !SAID_OF_ANY_PACKAGE.contains(&segment.as_str()))
        .collect()
}

pub fn served_through(specifier: &str) -> Option<Reached> {
    let type_name = specifier.rsplit(['.', '/', ':']).next()?;
    if !type_name.starts_with(|held: char| held.is_ascii_uppercase()) {
        return None;
    }
    let lowered = type_name.to_ascii_lowercase();
    let bare = lowered.trim_end_matches(|held: char| held.is_ascii_digit());
    let package = specifier.strip_suffix(type_name)?;
    let words = words_of(package);
    let named_for_it = words.iter().find(|word| bare == word.as_str());
    let a_client = SAID_OF_A_CLIENT.iter().any(|suffix| type_name.ends_with(suffix));
    let within = words.iter().find(|word| a_client && lowered.starts_with(word.as_str()));
    let service = within.or(named_for_it)?;
    Some(Reached { service: service.clone(), specifier: specifier.to_string(), by_its_name_alone: within.is_none() })
}

fn held_by_a_remote(unit: &IndexNode, node_of: &HashMap<&str, &IndexNode>) -> bool {
    let mut current = Some(unit);
    for _ in 0..8 {
        let Some(held) = current else { return false };
        if held.kind.is_type() {
            return SPEAKS_TO_A_REMOTE.iter().any(|word| held.name.contains(word));
        }
        current = held.parent.as_deref().and_then(|parent| node_of.get(parent).copied());
    }
    false
}

pub fn reached(edges: &[IndexEdge], nodes: &[IndexNode], files: &[String], namespaces: &[&str]) -> Vec<ExitPoint> {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let ours = |specifier: &str| {
        namespaces.iter().any(|namespace| {
            let root: Vec<&str> = namespace.split('.').take(OWN_NAMESPACE_DEPTH).collect();
            root.len() == OWN_NAMESPACE_DEPTH && specifier.starts_with(&format!("{}.", root.join(".")))
        })
    };
    let mut seen: HashSet<(&str, &str)> = HashSet::default();
    let mut found = Vec::new();
    for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Calls) {
        let Some(rest) = edge.target.strip_prefix("package:") else { continue };
        let Some((specifier, member)) = rest.split_once(':') else { continue };
        if ours(specifier) {
            continue;
        }
        let Some(through) = served_through(specifier) else { continue };
        let operation = crate::names::leaf(member);
        if operation == specifier.rsplit(['.', '/', ':']).next().unwrap_or_default() {
            continue;
        }
        let Some(caller) = node_of.get(edge.source.as_str()) else { continue };
        if through.by_its_name_alone && !held_by_a_remote(caller, &node_of) {
            continue;
        }
        if files.get(caller.file as usize).is_some_and(|path| crate::paths::is_test(path)) {
            continue;
        }
        if !seen.insert((edge.source.as_str(), edge.target.as_str())) {
            continue;
        }
        found.push(ExitPoint {
            id: format!("exit:{}:{}:sdk", edge.source, member),
            kind: "api",
            name: member.to_string(),
            source: edge.source.clone(),
            target: through.specifier,
            operation: operation.to_string(),
            file: caller.file,
            line: caller.span.line,
            awaited: false,
            addressed: None,
            service: Some(through.service),
            method: None,
            origin: None,
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_named_for_its_service_serves_that_service() {
        assert_eq!(served_through("app.vendor.weather.Weather3").map(|held| held.service).as_deref(), Some("weather"));
        assert_eq!(served_through("app.vendor.flights.api.FlightsBookingsApi").map(|held| held.service).as_deref(), Some("flights"));
    }

    #[test]
    fn a_library_type_that_names_no_service_is_not_one() {
        assert!(served_through("androidx.work.WorkManager").is_none());
        assert!(served_through("io.ktor.client.HttpClient").is_none());
        assert!(served_through("kotlinx.coroutines.flow.combine").is_none());
    }
}

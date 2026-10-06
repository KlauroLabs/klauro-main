use std::collections::BTreeMap;
use std::io::Read;

use serde::{Deserialize, Serialize};

const PARAM: &str = ":param";
const LOOPBACK: &[&str] = &["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"];

#[derive(Debug, Deserialize)]
pub struct Input {
    pub repositories: Vec<Repository>,
}

#[derive(Debug, Deserialize)]
pub struct Repository {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub provides: Vec<Route>,
    #[serde(default)]
    pub calls: Vec<Call>,
}

#[derive(Debug, Deserialize)]
pub struct Route {
    pub id: String,
    pub node: String,
    #[serde(default)]
    pub method: Option<String>,
    pub path: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct Call {
    pub id: String,
    pub node: String,
    #[serde(default)]
    pub method: Option<String>,
    pub path: String,
    #[serde(default)]
    pub origin: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Party {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Link {
    pub consumer: Party,
    pub provider: Party,
    pub call: String,
    pub call_node: String,
    pub route: String,
    pub route_node: String,
    pub endpoint: String,
    pub method: Option<String>,
    pub call_method: Option<String>,
    pub confidence: f64,
    pub basis: &'static str,
    pub file: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Candidate {
    pub provider: Party,
    pub route: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Ambiguity {
    pub consumer: Party,
    pub call: String,
    pub call_node: String,
    pub endpoint: String,
    pub method: Option<String>,
    pub reason: &'static str,
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Linked {
    pub links: Vec<Link>,
    pub ambiguous: Vec<Ambiguity>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Fit {
    Exact,
    Parameterised,
    Prefixed,
}

fn segments(route: &str) -> Vec<&str> {
    route.split('/').filter(|part| !part.is_empty()).collect()
}

fn is_param(segment: &str) -> bool {
    segment == PARAM
}

pub fn normalised(written: &str) -> Option<String> {
    let trimmed = written.trim();
    if trimmed.is_empty() || !trimmed.contains('/') {
        return None;
    }
    let without_origin = match trimmed.find("://") {
        Some(at) => {
            let rest = &trimmed[at + 3..];
            rest.find('/').map(|slash| &rest[slash..]).unwrap_or("/")
        }
        None => trimmed,
    };
    let without_query = without_origin.split(['?', '#']).next().unwrap_or("");
    let mut out = String::with_capacity(without_query.len());
    let mut chars = without_query.chars().peekable();
    while let Some(letter) = chars.next() {
        match letter {
            '$' if chars.peek() == Some(&'{') => {
                for skipped in chars.by_ref() {
                    if skipped == '}' {
                        break;
                    }
                }
                out.push_str(PARAM);
            }
            '{' => {
                for skipped in chars.by_ref() {
                    if skipped == '}' {
                        break;
                    }
                }
                out.push_str(PARAM);
            }
            other => out.push(other.to_ascii_lowercase()),
        }
    }
    let mut parts: Vec<String> = Vec::new();
    for part in out.split('/').filter(|part| !part.is_empty()) {
        let parameter = part.starts_with(':') || part.starts_with('*') || part.contains(PARAM) || part.starts_with('<');
        if part.chars().any(char::is_whitespace) {
            return None;
        }
        parts.push(if parameter { PARAM.to_string() } else { part.to_string() });
    }
    Some(format!("/{}", parts.join("/")))
}

fn fits(call: &[&str], route: &[&str]) -> Option<Fit> {
    let literal = |held: &[&str], other: &[&str]| held.iter().zip(other).any(|(left, right)| left == right && !is_param(left));
    let agrees = |left: &[&str], right: &[&str]| left.iter().zip(right).all(|(left, right)| left == right || is_param(left) || is_param(right));
    if call.len() == route.len() {
        if call == route && call.iter().any(|part| !is_param(part)) {
            return Some(Fit::Exact);
        }
        return (agrees(call, route) && literal(call, route)).then_some(Fit::Parameterised);
    }
    if call.len() > route.len() && !route.is_empty() {
        let tail = &call[call.len() - route.len()..];
        return (agrees(tail, route) && literal(tail, route)).then_some(Fit::Prefixed);
    }
    if call.len() < route.len() && call.first().is_some_and(|first| is_param(first)) && call.len() > 1 {
        let rest = &call[1..];
        let tail = &route[route.len() - rest.len()..];
        return (agrees(rest, tail) && literal(rest, tail)).then_some(Fit::Prefixed);
    }
    None
}

fn methods_agree(call: Option<&str>, route: Option<&str>) -> (bool, bool) {
    let call = call.map(str::to_ascii_uppercase).filter(|held| held != "FETCH" && held != "ALL");
    let route = route.map(str::to_ascii_uppercase).filter(|held| held != "ALL");
    match (call, route) {
        (Some(left), Some(right)) => (left == right, true),
        _ => (true, false),
    }
}

fn host_of(origin: &str) -> String {
    let rest = origin.split_once("://").map(|(_, rest)| rest).unwrap_or(origin);
    let authority = rest.split('/').next().unwrap_or(rest);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = match authority.starts_with('[') {
        true => authority.split_once(']').map(|(inside, _)| format!("{inside}]")).unwrap_or_else(|| authority.to_string()),
        false => authority.split(':').next().unwrap_or(authority).to_string(),
    };
    host.to_ascii_lowercase()
}

fn spelled(held: &str) -> String {
    held.to_ascii_lowercase().chars().filter(|letter| letter.is_alphanumeric()).collect()
}

fn names_the_repository(host: &str, repository: &Repository) -> bool {
    let first = host.split('.').next().unwrap_or(host);
    let wanted = spelled(first);
    !wanted.is_empty()
        && std::iter::once(repository.name.as_str())
            .chain(std::iter::once(repository.path.rsplit('/').next().unwrap_or(&repository.path)))
            .chain(repository.hosts.iter().map(String::as_str))
            .any(|named| spelled(named) == wanted)
}

struct Candidacy<'a> {
    provider: &'a Repository,
    route: &'a Route,
    fit: Fit,
    method_known: bool,
}

fn party(repository: &Repository) -> Party {
    Party { name: repository.name.clone(), path: repository.path.clone() }
}

fn confidence(candidacy: &Candidacy, basis: &str) -> f64 {
    let base: f64 = match candidacy.fit {
        Fit::Exact => 0.95,
        Fit::Parameterised => 0.9,
        Fit::Prefixed => 0.8,
    };
    let base = if candidacy.method_known { base } else { base - 0.08 };
    let base = if basis == "origin" { base + 0.03 } else { base };
    (base.min(0.98) * 100.0).round() / 100.0
}

pub fn derive(input: &Input) -> Linked {
    let prepared: Vec<Vec<(&Route, String)>> = input
        .repositories
        .iter()
        .map(|repository| repository.provides.iter().filter_map(|route| Some((route, normalised(&route.path)?))).collect())
        .collect();
    let mut linked = Linked::default();
    for (consumer_at, consumer) in input.repositories.iter().enumerate() {
        for call in &consumer.calls {
            let Some(written) = normalised(&call.path) else { continue };
            if segments(&written).is_empty() {
                continue;
            }
            let called = segments(&written);
            let mut candidacies: Vec<Candidacy> = Vec::new();
            for (provider_at, provider) in input.repositories.iter().enumerate() {
                if provider_at == consumer_at {
                    continue;
                }
                let mut best: BTreeMap<Fit, Vec<Candidacy>> = BTreeMap::new();
                for (route, served) in &prepared[provider_at] {
                    let Some(fit) = fits(&called, &segments(served)) else { continue };
                    let (agree, known) = methods_agree(call.method.as_deref(), route.method.as_deref());
                    if !agree {
                        continue;
                    }
                    best.entry(fit).or_default().push(Candidacy { provider, route, fit, method_known: known });
                }
                if let Some((_, nearest)) = best.into_iter().next() {
                    candidacies.extend(nearest);
                }
            }
            if candidacies.is_empty() {
                continue;
            }
            let host = call.origin.as_deref().map(host_of);
            let mut basis = "route";
            if let Some(host) = host.as_deref().filter(|host| !host.is_empty()) {
                let named: Vec<usize> = candidacies
                    .iter()
                    .enumerate()
                    .filter(|(_, held)| names_the_repository(host, held.provider))
                    .map(|(at, _)| at)
                    .collect();
                if !named.is_empty() {
                    candidacies = candidacies.into_iter().enumerate().filter(|(at, _)| named.contains(at)).map(|(_, held)| held).collect();
                    basis = "origin";
                } else if !LOOPBACK.contains(&host) {
                    continue;
                }
            }
            let mut providers: Vec<&str> = candidacies.iter().map(|held| held.provider.path.as_str()).collect();
            providers.sort_unstable();
            providers.dedup();
            if providers.len() > 1 {
                linked.ambiguous.push(Ambiguity {
                    consumer: party(consumer),
                    call: call.id.clone(),
                    call_node: call.node.clone(),
                    endpoint: written.clone(),
                    method: call.method.clone(),
                    reason: "several repositories serve this method and path and the call carries nothing that names one",
                    candidates: candidacies
                        .iter()
                        .map(|held| Candidate { provider: party(held.provider), route: held.route.id.clone() })
                        .collect(),
                });
                continue;
            }
            for held in &candidacies {
                linked.links.push(Link {
                    consumer: party(consumer),
                    provider: party(held.provider),
                    call: call.id.clone(),
                    call_node: call.node.clone(),
                    route: held.route.id.clone(),
                    route_node: held.route.node.clone(),
                    endpoint: held.route.path.clone(),
                    method: held.route.method.clone(),
                    call_method: call.method.clone(),
                    confidence: confidence(held, basis),
                    basis,
                    file: held.route.file.clone(),
                    line: held.route.line,
                });
            }
        }
    }
    linked
}

pub fn run() {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        std::process::exit(2);
    }
    let Ok(input) = serde_json::from_str::<Input>(&raw) else { std::process::exit(2) };
    let linked = derive(&input);
    println!("{}", serde_json::to_string(&linked).unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(name: &str, provides: &[(&str, &str)], calls: &[(&str, Option<&str>)]) -> Repository {
        Repository {
            name: name.to_string(),
            path: name.to_string(),
            hosts: Vec::new(),
            provides: provides
                .iter()
                .enumerate()
                .map(|(at, (method, path))| Route {
                    id: format!("{name}:r{at}"),
                    node: format!("{name}:n{at}"),
                    method: Some(method.to_string()),
                    path: path.to_string(),
                    file: None,
                    line: None,
                })
                .collect(),
            calls: calls
                .iter()
                .enumerate()
                .map(|(at, (path, origin))| Call {
                    id: format!("{name}:c{at}"),
                    node: format!("{name}:cn{at}"),
                    method: Some("GET".to_string()),
                    path: path.to_string(),
                    origin: origin.map(str::to_string),
                })
                .collect(),
        }
    }

    #[test]
    fn a_path_served_by_one_repository_links_it() {
        let input = Input {
            repositories: vec![
                repository("ui", &[], &[("/shipments", None)]),
                repository("api", &[("GET", "/shipments")], &[]),
            ],
        };
        let found = derive(&input);
        assert_eq!(found.links.len(), 1);
        assert!(found.ambiguous.is_empty());
    }

    #[test]
    fn a_path_served_by_two_repositories_is_ambiguous_until_the_origin_names_one() {
        let providers = || {
            vec![
                repository("api", &[("GET", "/users")], &[]),
                repository("admin", &[("GET", "/users")], &[]),
            ]
        };
        let mut bare = vec![repository("ui", &[], &[("/users", None)])];
        bare.extend(providers());
        let found = derive(&Input { repositories: bare });
        assert!(found.links.is_empty());
        assert_eq!(found.ambiguous.len(), 1);
        assert_eq!(found.ambiguous[0].candidates.len(), 2);

        let mut named = vec![repository("ui", &[], &[("/users", Some("http://admin:8080"))])];
        named.extend(providers());
        let found = derive(&Input { repositories: named });
        assert_eq!(found.links.len(), 1);
        assert_eq!(found.links[0].provider.name, "admin");
        assert_eq!(found.links[0].basis, "origin");
    }

    #[test]
    fn a_call_to_an_unknown_host_links_nothing() {
        let input = Input {
            repositories: vec![
                repository("ui", &[], &[("/shipments", Some("https://maps.vendor.com"))]),
                repository("api", &[("GET", "/shipments")], &[]),
            ],
        };
        assert!(derive(&input).links.is_empty());
    }

    #[test]
    fn an_unresolved_dynamic_prefix_matches_the_provider_route_by_its_literal_suffix() {
        let input = Input {
            repositories: vec![
                repository("ui", &[], &[("${ this.prefix }/companies", None)]),
                repository("api", &[("GET", "/api/web/companies")], &[]),
            ],
        };
        let found = derive(&input);
        assert_eq!(found.links.len(), 1);
        assert!(found.links[0].confidence < 0.9);
        let other = Input {
            repositories: vec![
                repository("ui", &[], &[("${ this.prefix }/companies", None)]),
                repository("api", &[("GET", "/api/web/things")], &[]),
            ],
        };
        assert!(derive(&other).links.is_empty());
    }

    #[test]
    fn a_parameter_only_path_matches_nothing() {
        let input = Input {
            repositories: vec![
                repository("ui", &[], &[("/${id}", None)]),
                repository("api", &[("GET", "/:id")], &[]),
            ],
        };
        assert!(derive(&input).links.is_empty());
    }
}

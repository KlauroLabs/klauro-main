use std::collections::BTreeMap;
use std::sync::OnceLock;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::model::*;

static TABLE: &str = include_str!("../data/injection.tsv");

fn lists() -> &'static HashMap<&'static str, HashSet<String>> {
    static HELD: OnceLock<HashMap<&'static str, HashSet<String>>> = OnceLock::new();
    HELD.get_or_init(|| {
        let mut held: HashMap<&'static str, HashSet<String>> = HashMap::default();
        for row in TABLE.lines() {
            if let Some((role, names)) = row.split_once('\t') {
                held.entry(role).or_default().extend(names.split(',').map(str::to_ascii_lowercase));
            }
        }
        held
    })
}

fn listed(role: &str, name: &str) -> bool {
    let leaf = name.rsplit(['.', ':']).next().unwrap_or(name);
    lists().get(role).is_some_and(|names| names.contains(&leaf.to_ascii_lowercase()))
}

pub fn registers(callee: &str) -> bool {
    listed("registration", callee)
}

#[derive(Debug, Serialize)]
pub struct Injection {
    pub source: String,
    pub target: String,
    pub dependency_type: &'static str,
    pub through: &'static str,
}

fn plain(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']).trim();
    let annotation = annotation.split(['<', '[', '?', '|']).next().unwrap_or(annotation);
    crate::names::leaf(annotation.trim())
}

fn held_type(annotation: &str) -> &str {
    let trimmed = annotation.trim();
    if let Some(inner) = trimmed.split_once('<').map(|(_, rest)| rest.trim_end_matches('>')) {
        let outer = plain(trimmed);
        if matches!(outer, "List" | "Set" | "Collection" | "Iterable" | "IEnumerable" | "IReadOnlyList" | "ICollection" | "Optional" | "Provider" | "Lazy" | "Option") {
            return plain(inner.split(',').next().unwrap_or(inner));
        }
    }
    plain(trimmed)
}

struct Resolver<'g, 'a> {
    graph: &'g crate::shared::Graph<'a>,
    by_name: HashMap<&'a str, Vec<usize>>,
    functions: HashMap<&'a str, Vec<usize>>,
}

impl<'g, 'a> Resolver<'g, 'a> {
    fn new(graph: &'g crate::shared::Graph<'a>) -> Self {
        let mut by_name: HashMap<&str, Vec<usize>> = HashMap::default();
        let mut functions: HashMap<&str, Vec<usize>> = HashMap::default();
        for (at, node) in graph.nodes.iter().enumerate().filter(|(at, _)| !graph.tested[*at]) {
            if node.kind.is_type() && node.kind != NodeKind::TypeAlias && node.kind != NodeKind::Enum {
                by_name.entry(node.name.as_str()).or_default().push(at);
            } else if node.kind == NodeKind::Function {
                functions.entry(node.name.as_str()).or_default().push(at);
            }
        }
        Resolver { graph, by_name, functions }
    }

    fn nearest(&self, held: &[usize], from: Option<usize>) -> Option<usize> {
        let nodes = self.graph.nodes;
        match (held, from) {
            ([], _) => None,
            ([only], _) => Some(*only),
            (_, None) => None,
            (_, Some(from)) => {
                let near = |same: &dyn Fn(&IndexNode) -> bool| {
                    let found: Vec<usize> = held.iter().copied().filter(|at| same(&nodes[*at])).collect();
                    (found.len() == 1).then(|| found[0])
                };
                near(&|node| node.file == nodes[from].file)
                    .or_else(|| near(&|node| node.project.is_some() && node.project == nodes[from].project))
            }
        }
    }

    fn type_named(&self, name: &str, from: impl Into<Option<usize>>) -> Option<usize> {
        let from = from.into();
        self.nearest(self.by_name.get(name)?, from)
    }

    fn function_named(&self, name: &str, from: usize) -> Option<usize> {
        self.nearest(self.functions.get(name)?, Some(from))
    }

    fn supplied_for(&self, target: usize) -> Vec<usize> {
        let nodes = self.graph.nodes;
        if nodes[target].kind != NodeKind::Interface && !nodes[target].modifiers.abstract_member {
            return vec![target];
        }
        let implementing: Vec<usize> = self
            .graph
            .implementors
            .get(nodes[target].name.as_str())
            .map(|held| held.iter().copied().filter(|at| !self.graph.tested[*at] && nodes[*at].kind.is_type()).collect())
            .unwrap_or_default();
        if implementing.is_empty() { vec![target] } else { implementing }
    }
}

fn stronger(held: &'static str, other: &'static str) -> &'static str {
    const BY_STRENGTH: [&str; 4] = ["constructor", "setter", "field", "parameter"];
    let rank = |way: &str| BY_STRENGTH.iter().position(|known| *known == way).unwrap_or(BY_STRENGTH.len());
    if rank(other) < rank(held) { other } else { held }
}

fn marked(node: &IndexNode) -> bool {
    node.decorators.iter().any(|decorator| listed("inject_marker", &decorator.name))
}

pub fn derive(graph: &crate::shared::Graph, calls: &[CallFact]) -> Vec<Injection> {
    let nodes = graph.nodes;
    let resolver = Resolver::new(graph);

    let mut managed: HashSet<usize> = HashSet::default();
    for (at, node) in nodes.iter().enumerate().filter(|(at, node)| node.kind.is_type() && !graph.tested[*at]) {
        let annotated = node.decorators.iter().any(|decorator| listed("managed_annotation", &decorator.name));
        let derived = graph.bases[at].iter().any(|base| listed("managed_base", base));
        let marked_inside = graph.members[at].iter().any(|member| marked(&nodes[*member]));
        if annotated || derived || marked_inside {
            managed.insert(at);
        }
    }
    for call in calls.iter().filter(|call| registers(&call.callee)) {
        let from = call.caller.as_deref().and_then(|caller| graph.at(caller));
        for argument in &call.type_arguments {
            if let Some(registered) = resolver.type_named(plain(argument), from) {
                managed.insert(registered);
                managed.extend(resolver.supplied_for(registered));
            }
        }
    }

    let mut taken: BTreeMap<(usize, usize), &'static str> = BTreeMap::new();
    let mut note = |source: usize, annotation: &str, through: &'static str, only_managed: bool| {
        let Some(declared) = resolver.type_named(held_type(annotation), source) else { return };
        for target in resolver.supplied_for(declared) {
            if target != source && (!only_managed || managed.contains(&target) || managed.contains(&declared)) {
                taken.entry((source, target)).and_modify(|held| *held = stronger(held, through)).or_insert(through);
            }
        }
    };

    for owner in managed.iter().copied().collect::<Vec<_>>() {
        for member in graph.members[owner].iter().copied().filter(|at| !graph.tested[*at]) {
            let node = &nodes[member];
            match node.kind {
                NodeKind::Constructor => {
                    for parameter in node.signature.iter().flat_map(|signature| signature.parameters.iter()) {
                        if let Some(annotation) = parameter.type_annotation.as_deref() {
                            note(owner, annotation, "constructor", false);
                        }
                    }
                }
                NodeKind::Property => {
                    if let Some(annotation) = node.type_annotation.as_deref() {
                        note(owner, annotation, "field", !marked(node));
                    }
                }
                NodeKind::Method | NodeKind::Setter if marked(node) => {
                    for parameter in node.signature.iter().flat_map(|signature| signature.parameters.iter()) {
                        if let Some(annotation) = parameter.type_annotation.as_deref() {
                            note(owner, annotation, "setter", false);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let provided_by_name = |unit: usize| -> Vec<(String, Option<String>)> {
        nodes[unit]
            .signature
            .iter()
            .flat_map(|signature| signature.parameters.iter())
            .filter_map(|parameter| {
                let default = parameter.default_value.as_deref()?.trim();
                let (call, rest) = default.split_once('(')?;
                if !listed("provider_call", call.trim()) {
                    return None;
                }
                let provider = rest.trim_end_matches(')').trim();
                let written = (!provider.is_empty()).then(|| provider.to_string());
                Some((parameter.type_annotation.clone().unwrap_or_default(), written))
            })
            .collect()
    };

    let mut providers: HashSet<usize> = HashSet::default();
    let mut wanted: Vec<(usize, usize)> = Vec::new();
    for (at, node) in nodes.iter().enumerate().filter(|(at, node)| node.kind.is_unit() && !graph.tested[*at]) {
        let source = match node.kind {
            NodeKind::Constructor => graph.type_owner(at),
            _ => Some(at),
        };
        let Some(source) = source else { continue };
        for (annotation, written) in provided_by_name(at) {
            let target = match written.as_deref() {
                Some(name) => resolver.function_named(plain(name), at).or_else(|| resolver.type_named(plain(name), at)),
                None => resolver.type_named(held_type(&annotation), at),
            };
            if let Some(target) = target.filter(|target| *target != source) {
                providers.insert(target);
                wanted.push((source, target));
            }
        }
    }
    for (source, target) in wanted {
        let class_unused = nodes[source].kind.is_type() && !providers.contains(&source);
        if !class_unused {
            taken.entry((source, target)).and_modify(|held| *held = stronger(held, "parameter")).or_insert("parameter");
        }
    }

    taken
        .into_iter()
        .map(|((source, target), through)| Injection {
            source: nodes[source].id.clone(),
            target: nodes[target].id.clone(),
            dependency_type: "injection",
            through,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_collection_of_beans_is_injected_as_the_bean_it_holds() {
        assert_eq!(held_type("List<PaymentGateway>"), "PaymentGateway");
        assert_eq!(held_type("Optional<com.acme.Mailer>"), "Mailer");
        assert_eq!(held_type("UserRepository"), "UserRepository");
        assert_eq!(held_type("Repository<User>"), "Repository");
    }

    #[test]
    fn a_registration_verb_is_read_from_the_table_in_any_case() {
        assert!(registers("AddScoped"));
        assert!(registers("services.addscoped"));
        assert!(!registers("Add"));
    }

    #[test]
    fn a_constructor_is_the_strongest_way_in() {
        assert_eq!(stronger("field", "constructor"), "constructor");
        assert_eq!(stronger("setter", "parameter"), "setter");
    }
}

use std::collections::BTreeSet;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use serde::Serialize;

use crate::entry_exit::ExitPoint;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Principle {
    pub principle: &'static str,
    pub reads_as: &'static str,
    pub population: u32,
    pub following: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub departing: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct AntiPattern {
    pub anti_pattern: &'static str,
    pub reads_as: &'static str,
    pub count: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Principles {
    pub solid: Vec<Principle>,
    pub anti_patterns: Vec<AntiPattern>,
}

pub struct Sources<'a> {
    pub graph: &'a crate::shared::Graph<'a>,
    pub nodes: &'a [IndexNode],
    pub edges: &'a [IndexEdge],
    pub calls: &'a [CallFact],
    pub metrics: &'a [UnitMetricsEntry],
    pub exit_points: &'a [ExitPoint],
    pub paths: &'a [&'a str],
}

const SHOWN: usize = 12;
const CONCERNS_AT_MOST: usize = 2;
const BRANCHES_AT_MOST: u16 = 20;
const INTERFACE_MEMBERS_AT_MOST: usize = 12;
const MEMBERS_OF_A_GOD_CLASS: usize = 40;
const LINES_OF_A_GOD_CLASS: u32 = 1500;
const LINES_OF_A_LONG_METHOD: u32 = 120;
const PARAMETERS_AT_MOST: usize = 7;
const INHERITANCE_AT_MOST: usize = 5;

static NOT_DONE: &[&str] = &[
    "NotImplementedError", "NotImplementedException", "NotSupportedException", "UnsupportedOperationException",
    "unimplemented", "todo",
];
static LOCATES_SERVICES: &[&str] = &["getinstance", "getrequiredservice", "getservice", "resolve", "resolvenamed"];
static LOCATED_FROM: &[&str] = &["container", "injector", "kernel", "locator", "provider", "serviceprovider", "services"];
static COMPOSES_THE_SYSTEM: &[&str] = &["bootstrap", "composition", "main", "program", "startup"];
static HOLDS_COLLABORATORS: &[&str] = &["controller", "handler", "service"];
static COLLABORATES_AS: &[&str] = &["repository", "service"];

fn plain(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']).trim();
    let annotation = annotation.split(['<', '[', '?']).next().unwrap_or(annotation);
    crate::names::leaf(annotation.trim())
}

fn lines_of(node: &IndexNode) -> u32 {
    node.span.end_line.saturating_sub(node.span.line) + 1
}

pub fn derive(sources: &Sources) -> Principles {
    let nodes = sources.nodes;
    let graph = sources.graph;
    let tested = &graph.tested;
    let position = &graph.position;
    let implementors = &graph.implementors;
    let declared_as = &graph.declared_as;
    let metrics: HashMap<&str, &UnitMetrics> =
        sources.metrics.iter().map(|entry| (entry.unit.as_str(), &entry.metrics)).collect();
    let types: Vec<usize> = (0..nodes.len()).filter(|at| nodes[*at].kind.is_type() && !tested[*at]).collect();
    let owner_of = |unit: usize| graph.type_owner(unit);
    let role_of = |at: usize| graph.role_of[at];

    let mut solid = Vec::new();

    let mut concerns: HashMap<usize, BTreeSet<String>> = HashMap::default();
    for exit in sources.exit_points {
        let Some(unit) = position.get(exit.source.as_str()).copied() else { continue };
        if tested[unit] {
            continue;
        }
        let Some(owner) = owner_of(unit) else { continue };
        let concern = match exit.service.as_deref() {
            Some(service) => format!("{}: {service}", exit.kind),
            None => exit.kind.to_string(),
        };
        concerns.entry(owner).or_default().insert(concern);
    }
    let mut spread: Vec<(usize, usize)> =
        concerns.iter().filter(|(_, held)| held.len() > CONCERNS_AT_MOST).map(|(at, held)| (*at, held.len())).collect();
    spread.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    solid.push(Principle {
        principle: "single responsibility",
        reads_as: "a type reaches no more than two kinds of outside system",
        population: concerns.len() as u32,
        following: (concerns.len() - spread.len()) as u32,
        departing: spread
            .iter()
            .take(SHOWN)
            .map(|(at, count)| format!("{} reaches {count} kinds: {}", nodes[*at].id, concerns[at].iter().cloned().collect::<Vec<_>>().join(", ")))
            .collect(),
    });

    let extension_points = implementors.values().filter(|held| held.len() >= 2).count() as u32;
    let mut branching: Vec<(usize, u16)> = nodes
        .iter()
        .enumerate()
        .filter(|(at, node)| node.kind.is_unit() && !tested[*at])
        .filter_map(|(at, node)| Some((at, metrics.get(node.id.as_str())?.branches)))
        .collect();
    let units_measured = branching.len() as u32;
    branching.retain(|(_, branches)| *branches > BRANCHES_AT_MOST);
    branching.sort_by(|left, right| right.1.cmp(&left.1));
    solid.push(Principle {
        principle: "open for extension",
        reads_as: "new behaviour arrives as another implementation, not another branch",
        population: units_measured,
        following: units_measured - branching.len() as u32,
        departing: std::iter::once(format!("{extension_points} extension points with two or more implementations"))
            .chain(branching.iter().take(SHOWN).map(|(at, branches)| format!("{} decides among {branches} branches", nodes[*at].id)))
            .collect(),
    });

    let mut overriding = 0u32;
    let mut refused: Vec<String> = Vec::new();
    for (owner, held) in graph.bases.iter().enumerate() {
        if tested[owner] || held.is_empty() {
            continue;
        }
        let inherited: HashSet<&str> = held
            .iter()
            .filter_map(|base| implementors.contains_key(base).then_some(*base))
            .flat_map(|base| {
                declared_as.get(base).into_iter().flat_map(|declared| {
                    graph.members[*declared].iter().map(|at| nodes[*at].name.as_str())
                })
            })
            .collect();
        for member in &graph.members[owner] {
            if !nodes[*member].kind.is_unit() || !inherited.contains(nodes[*member].name.as_str()) {
                continue;
            }
            overriding += 1;
            let refuses = metrics.get(nodes[*member].id.as_str()).is_some_and(|measured| {
                measured.throws.iter().any(|thrown| NOT_DONE.iter().any(|refusal| thrown.contains(refusal)))
            });
            if refuses && refused.len() < SHOWN * 4 {
                refused.push(nodes[*member].id.clone());
            }
        }
    }
    solid.push(Principle {
        principle: "substitutable implementations",
        reads_as: "an override does what its base promises instead of refusing it",
        population: overriding,
        following: overriding.saturating_sub(refused.len() as u32),
        departing: refused.into_iter().take(SHOWN).map(|at| format!("{at} refuses what its base promises")).collect(),
    });

    let interfaces: Vec<usize> = types.iter().copied().filter(|at| nodes[*at].kind == NodeKind::Interface).collect();
    let fat: Vec<(usize, usize)> = interfaces
        .iter()
        .filter_map(|at| {
            let size = graph.members[*at].len();
            (size > INTERFACE_MEMBERS_AT_MOST).then_some((*at, size))
        })
        .collect();
    solid.push(Principle {
        principle: "segregated interfaces",
        reads_as: "an interface asks only for what its users need",
        population: interfaces.len() as u32,
        following: (interfaces.len() - fat.len()) as u32,
        departing: fat.iter().take(SHOWN).map(|(at, size)| format!("{} asks for {size} members", nodes[*at].id)).collect(),
    });

    let mut held_collaborators = 0u32;
    let mut concrete: Vec<String> = Vec::new();
    for owner in &types {
        if !role_of(*owner).is_some_and(|role| HOLDS_COLLABORATORS.contains(&role)) {
            continue;
        }
        for member in &graph.members[*owner] {
            let node = &nodes[*member];
            let typed: Vec<&str> = match node.kind {
                NodeKind::Property => node.type_annotation.as_deref().map(plain).into_iter().collect(),
                NodeKind::Constructor => node
                    .signature
                    .iter()
                    .flat_map(|signature| signature.parameters.iter())
                    .filter_map(|parameter| parameter.type_annotation.as_deref().map(plain))
                    .collect(),
                _ => Vec::new(),
            };
            for named in typed {
                let Some(declared) = declared_as.get(named).copied() else { continue };
                let Some(role) = role_of(declared) else { continue };
                if !COLLABORATES_AS.contains(&role) {
                    continue;
                }
                held_collaborators += 1;
                let abstract_one = nodes[declared].kind == NodeKind::Interface || implementors.contains_key(named);
                if !abstract_one && concrete.len() < SHOWN * 4 {
                    concrete.push(format!("{} depends on concrete {named}", nodes[*owner].id));
                }
            }
        }
    }
    concrete.sort();
    concrete.dedup();
    solid.push(Principle {
        principle: "dependency inversion",
        reads_as: "services and handlers depend on abstractions of their collaborators",
        population: held_collaborators,
        following: held_collaborators.saturating_sub(concrete.len() as u32),
        departing: concrete.into_iter().take(SHOWN).collect(),
    });

    let mut anti_patterns = Vec::new();
    let mut note = |anti_pattern: &'static str, reads_as: &'static str, examples: Vec<String>| {
        if !examples.is_empty() {
            anti_patterns.push(AntiPattern {
                anti_pattern,
                reads_as,
                count: examples.len() as u32,
                examples: examples.into_iter().take(SHOWN).collect(),
            });
        }
    };

    let mut gods: Vec<(usize, usize, u32)> = types
        .iter()
        .map(|at| (*at, graph.members[*at].len(), lines_of(&nodes[*at])))
        .filter(|(_, size, lines)| *size > MEMBERS_OF_A_GOD_CLASS || *lines > LINES_OF_A_GOD_CLASS)
        .collect();
    gods.sort_by(|left, right| right.1.cmp(&left.1));
    note("god class", "one type that knows and does too much", gods.iter().map(|(at, size, lines)| format!("{} ({size} members, {lines} lines)", nodes[*at].id)).collect());

    let mut long: Vec<(usize, u32)> = nodes
        .iter()
        .enumerate()
        .filter(|(at, node)| node.kind.is_unit() && !tested[*at])
        .map(|(at, node)| (at, lines_of(node)))
        .filter(|(_, lines)| *lines > LINES_OF_A_LONG_METHOD)
        .collect();
    long.sort_by(|left, right| right.1.cmp(&left.1));
    note("long method", "a unit too long to hold in mind at once", long.iter().map(|(at, lines)| format!("{} ({lines} lines)", nodes[*at].id)).collect());

    let many_parameters: Vec<String> = nodes
        .iter()
        .enumerate()
        .filter(|(at, node)| node.kind.is_unit() && !tested[*at])
        .filter_map(|(_, node)| {
            let count = node.signature.as_ref()?.parameters.len();
            (count > PARAMETERS_AT_MOST).then(|| format!("{} ({count} parameters)", node.id))
        })
        .collect();
    note("long parameter list", "a unit asked for more than it should need", many_parameters);

    note("circular dependency", "parts that cannot be understood or changed apart", cycles(sources, position));

    let global_state: Vec<String> = nodes
        .iter()
        .enumerate()
        .filter(|(at, node)| node.kind == NodeKind::Property && !tested[*at])
        .filter(|(_, node)| node.modifiers.is_static && !node.modifiers.readonly)
        .filter(|(_, node)| !node.name.chars().all(|letter| letter.is_ascii_uppercase() || letter == '_'))
        .map(|(_, node)| node.id.clone())
        .collect();
    note("mutable global state", "state anyone can change from anywhere", global_state);

    let located: Vec<String> = sources
        .calls
        .iter()
        .filter(|call| crate::shared::named_one_of(crate::names::leaf(&call.callee), LOCATES_SERVICES))
        .filter(|call| !graph.file_tested(call.file))
        .filter(|call| sources.paths.get(call.file as usize).is_some_and(|path| {
            let lowered = path.to_ascii_lowercase();
            !COMPOSES_THE_SYSTEM.iter().any(|composes| lowered.contains(composes))
        }))
        .filter(|call| call.receiver.as_deref().is_some_and(|within| {
            let lowered = within.to_ascii_lowercase();
            LOCATED_FROM.iter().any(|from| lowered.ends_with(from))
        }))
        .filter_map(|call| call.caller.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    note("service locator", "collaborators pulled from a container instead of handed in", located);

    let mut deep: Vec<String> = Vec::new();
    for owner in &types {
        let mut depth = 0usize;
        let mut current = *owner;
        let mut seen: HashSet<usize> = HashSet::from_iter([current]);
        while let Some(parent) = graph.extends_parent[current] {
            if !seen.insert(parent) {
                break;
            }
            depth += 1;
            current = parent;
            if depth > INHERITANCE_AT_MOST {
                break;
            }
        }
        if depth > INHERITANCE_AT_MOST {
            deep.push(format!("{} ({depth}+ levels)", nodes[*owner].id));
        }
    }
    note("deep inheritance", "behaviour spread down a long chain of parents", deep);

    let modelled: Vec<usize> = types
        .iter()
        .copied()
        .filter(|at| role_of(*at) == Some("model"))
        .collect();
    let anaemic: Vec<String> = modelled
        .iter()
        .filter(|at| {
            let held = graph.members[**at].as_slice();
            let fields = held.iter().filter(|member| nodes[**member].kind == NodeKind::Property).count();
            let behaviour = held.iter().filter(|member| {
                nodes[**member].kind.is_unit() && nodes[**member].kind != NodeKind::Constructor
                    && !matches!(nodes[**member].kind, NodeKind::Getter | NodeKind::Setter)
            }).count();
            fields >= 3 && behaviour == 0
        })
        .map(|at| nodes[*at].id.clone())
        .collect();
    if modelled.len() >= 4 && anaemic.len() * 2 > modelled.len() {
        note("anaemic domain model", "records hold data while the rules about them live elsewhere", anaemic);
    }

    Principles { solid, anti_patterns }
}

fn cycles(sources: &Sources, position: &rustc_hash::FxHashMap<&str, usize>) -> Vec<String> {
    let nodes = sources.nodes;
    let mut files_of: HashMap<u32, usize> = HashMap::default();
    let mut graph: Vec<Vec<usize>> = Vec::new();
    let mut named: Vec<u32> = Vec::new();
    let mut slot = |file: u32, graph: &mut Vec<Vec<usize>>, named: &mut Vec<u32>| -> usize {
        *files_of.entry(file).or_insert_with(|| {
            graph.push(Vec::new());
            named.push(file);
            graph.len() - 1
        })
    };
    for edge in sources.edges.iter().filter(|edge| edge.kind == EdgeKind::Imports) {
        let (Some(from), Some(to)) = (position.get(edge.source.as_str()), position.get(edge.target.as_str())) else { continue };
        let (from, to) = (nodes[*from].file, nodes[*to].file);
        if from == to {
            continue;
        }
        let tested = |file: u32| sources.paths.get(file as usize).is_some_and(|path| crate::paths::is_test(path));
        if tested(from) || tested(to) {
            continue;
        }
        let from = slot(from, &mut graph, &mut named);
        let to = slot(to, &mut graph, &mut named);
        graph[from].push(to);
    }
    strongly_connected(&graph)
        .into_iter()
        .filter(|component| component.len() > 1)
        .map(|component| {
            let mut files: Vec<&str> = component
                .iter()
                .filter_map(|at| sources.paths.get(named[*at] as usize).copied())
                .collect();
            files.sort();
            let shown: Vec<&str> = files.iter().take(4).copied().collect();
            format!("{} files import each other in a cycle: {}", files.len(), shown.join(", "))
        })
        .collect()
}

fn strongly_connected(graph: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let count = graph.len();
    let mut index = vec![usize::MAX; count];
    let mut low = vec![0usize; count];
    let mut on_stack = vec![false; count];
    let mut stack: Vec<usize> = Vec::new();
    let mut next = 0usize;
    let mut components = Vec::new();
    for root in 0..count {
        if index[root] != usize::MAX {
            continue;
        }
        let mut work: Vec<(usize, usize)> = vec![(root, 0)];
        index[root] = next;
        low[root] = next;
        next += 1;
        stack.push(root);
        on_stack[root] = true;
        while let Some(&mut (at, ref mut child)) = work.last_mut() {
            if *child < graph[at].len() {
                let to = graph[at][*child];
                *child += 1;
                if index[to] == usize::MAX {
                    index[to] = next;
                    low[to] = next;
                    next += 1;
                    stack.push(to);
                    on_stack[to] = true;
                    work.push((to, 0));
                } else if on_stack[to] {
                    low[at] = low[at].min(index[to]);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[at]);
            }
            if low[at] == index[at] {
                let mut component = Vec::new();
                while let Some(held) = stack.pop() {
                    on_stack[held] = false;
                    component.push(held);
                    if held == at {
                        break;
                    }
                }
                components.push(component);
            }
        }
    }
    components
}

#[cfg(test)]
mod tests {
    use super::strongly_connected;

    #[test]
    fn parts_that_reach_each_other_are_one_component() {
        let graph = vec![vec![1], vec![2], vec![0, 3], vec![]];
        let mut found: Vec<Vec<usize>> = strongly_connected(&graph)
            .into_iter()
            .map(|mut component| {
                component.sort();
                component
            })
            .collect();
        found.sort();
        assert_eq!(found, vec![vec![0, 1, 2], vec![3]]);
    }
}

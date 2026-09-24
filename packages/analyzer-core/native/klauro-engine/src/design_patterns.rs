use std::collections::{BTreeMap, BTreeSet};
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::model::*;
use crate::patterns::Found;

const EXAMPLES_KEPT: usize = 6;

static COLLECTS: &[&str] = &[
    "Array", "Collection", "HashSet", "IEnumerable", "ICollection", "IList", "IReadOnlyList", "List", "Set", "Vec",
    "list", "set", "vector",
];
static LISTENS: &[&str] = &["Callback", "Handler", "Listener", "Observer", "Subscriber", "Watcher"];
static ANNOUNCES: &[&str] = &["dispatch", "emit", "fire", "notify", "notifyall", "notifyobservers", "publish", "raise", "trigger"];
static ENLISTS: &[&str] = &["add", "addlistener", "attach", "on", "register", "subscribe", "watch"];
static EXECUTES: &[&str] = &["call", "execute", "invoke", "perform", "run"];
static BUILDS: &[&str] = &["build", "create", "tobuild"];
static SATISFIES: &[&str] = &["is_satisfied_by", "issatisfiedby", "satisfied_by"];
static INSTANCE_ACCESSORS: &[&str] = &["current", "default", "get_instance", "getinstance", "instance", "shared", "sharedinstance"];

struct Shape<'g, 'a> {
    graph: &'g crate::shared::Graph<'a>,
    nodes: &'a [IndexNode],
    calls: Vec<Vec<usize>>,
    instantiates: Vec<Vec<usize>>,
}

impl<'g, 'a> Shape<'g, 'a> {
    fn new(graph: &'g crate::shared::Graph<'a>, edges: &'a [IndexEdge]) -> Self {
        let nodes = graph.nodes;
        let mut calls: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
        let mut instantiates: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
        for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Calls | EdgeKind::Instantiates)) {
            let (Some(from), Some(to)) = (graph.at(edge.source.as_str()), graph.at(edge.target.as_str())) else {
                continue;
            };
            match edge.kind {
                EdgeKind::Calls => calls[from].push(to),
                _ => instantiates[from].push(to),
            }
        }
        Shape { graph, nodes, calls, instantiates }
    }

    fn tested(&self, at: usize) -> bool {
        self.graph.tested[at]
    }

    fn types(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.nodes.len()).filter(|at| self.nodes[*at].kind.is_type() && !self.tested(*at))
    }

    fn methods(&self, owner: usize) -> impl Iterator<Item = usize> + '_ {
        self.graph.members[owner].iter().copied().filter(|at| self.nodes[*at].kind.is_unit())
    }

    fn fields(&self, owner: usize) -> impl Iterator<Item = (usize, &'a str)> + '_ {
        self.graph.members[owner]
            .iter()
            .copied()
            .filter(|at| self.nodes[*at].kind == NodeKind::Property)
            .filter_map(|at| Some((at, self.nodes[at].type_annotation.as_deref()?)))
    }

    fn bases_of(&self, owner: usize) -> &[&'a str] {
        &self.graph.bases[owner]
    }

    fn named(&self, at: usize) -> &'a str {
        self.nodes[at].name.as_str()
    }

    fn called(&self, at: usize, list: &[&str]) -> bool {
        crate::shared::named_one_of(&self.nodes[at].name, list)
    }

    fn interface_like(&self, named: &str) -> bool {
        self.graph.implementors.get(named).is_some_and(|held| !held.is_empty())
    }
}

fn plain(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']).trim();
    let annotation = annotation.split(['<', '[', '?']).next().unwrap_or(annotation);
    crate::names::leaf(annotation.trim())
}

fn element_of(annotation: &str) -> Option<&str> {
    let outer = plain(annotation);
    if annotation.trim().ends_with("[]") {
        return Some(outer);
    }
    if !COLLECTS.contains(&outer) {
        return None;
    }
    let inner = annotation.split_once('<').map(|(_, rest)| rest.trim_end_matches('>'))?;
    Some(plain(inner.split(',').next().unwrap_or(inner)))
}

struct Tally<'s> {
    held: BTreeMap<&'static str, (&'static str, BTreeSet<usize>)>,
    nodes: &'s [IndexNode],
}

impl<'s> Tally<'s> {
    fn note(&mut self, pattern: &'static str, evidence: &'static str, at: usize) {
        self.held.entry(pattern).or_insert((evidence, BTreeSet::new())).1.insert(at);
    }

    fn found(self) -> Vec<Found> {
        let nodes = self.nodes;
        self.held
            .into_iter()
            .map(|(pattern, (evidence, examples))| {
                let projects: BTreeSet<String> =
                    examples.iter().filter_map(|at| nodes[*at].project.clone()).collect();
                Found {
                    pattern,
                    family: "design",
                    evidence: evidence.to_string(),
                    count: examples.len() as u32,
                    examples: examples.iter().take(EXAMPLES_KEPT).map(|at| nodes[*at].id.clone()).collect(),
                    projects: projects.into_iter().collect(),
                }
            })
            .collect()
    }
}

pub fn derive(graph: &crate::shared::Graph, edges: &[IndexEdge]) -> Vec<Found> {
    let nodes = graph.nodes;
    let shape = Shape::new(graph, edges);
    let mut tally = Tally { held: BTreeMap::new(), nodes };

    for owner in shape.types() {
        let named = shape.named(owner);
        let bases = shape.bases_of(owner);
        let fields: Vec<(usize, &str)> = shape.fields(owner).collect();
        let methods: Vec<usize> = shape.methods(owner).collect();
        let has_method = |list: &[&str]| methods.iter().any(|at| shape.called(*at, list));

        let wraps_its_own_kind = fields.iter().any(|(_, typed)| bases.contains(&plain(typed)) && shape.interface_like(plain(typed)));
        let collects_its_own_kind = fields
            .iter()
            .any(|(_, typed)| element_of(typed).is_some_and(|element| bases.contains(&element)));
        if collects_its_own_kind {
            tally.note("composite", "a part that holds parts of its own kind", owner);
        } else if wraps_its_own_kind {
            match named.contains("Proxy") {
                true => tally.note("proxy", "stands in for another of its own kind it holds", owner),
                false => tally.note("decorator", "wraps another of its own kind and adds to it", owner),
            }
        }

        let returns_itself = methods
            .iter()
            .filter(|at| {
                nodes[**at].signature.as_ref().and_then(|signature| signature.return_type.as_deref()).is_some_and(|returned| {
                    let returned = plain(returned);
                    returned == named || returned == "Self" || returned == "this"
                })
            })
            .count();
        if returns_itself >= 2 && has_method(BUILDS) {
            tally.note("builder", "assembles its product step by step, then builds it", owner);
        }

        let holds_itself_statically = fields.iter().any(|(at, typed)| nodes[*at].modifiers.is_static && plain(typed) == named);
        let hands_out_one = methods.iter().any(|at| {
            nodes[*at].modifiers.is_static && shape.called(*at, INSTANCE_ACCESSORS)
        });
        let kept_to_itself = methods
            .iter()
            .any(|at| nodes[*at].kind == NodeKind::Constructor && nodes[*at].modifiers.private_member);
        if holds_itself_statically && (hands_out_one || kept_to_itself) {
            tally.note("singleton", "keeps and hands out its one instance", owner);
        }

        let makes: HashSet<usize> = methods
            .iter()
            .filter(|at| {
                let named = shape.named(**at).as_bytes();
                let begins = |prefix: &str| named.len() >= prefix.len() && named[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes());
                begins("create") || begins("make") || begins("new") || begins("build") || begins("get") || shape.named(**at) == "for"
            })
            .flat_map(|at| shape.instantiates[*at].iter().copied())
            .filter_map(|made| match nodes[made].kind.is_type() {
                true => Some(made),
                false => graph.owner[made],
            })
            .filter(|made| nodes[*made].kind.is_type())
            .collect();
        let shared_base = makes.len() >= 2
            && makes.iter().flat_map(|made| shape.bases_of(*made).iter()).any(|base| {
                makes.iter().filter(|made| shape.bases_of(**made).contains(base)).count() >= 2
            });
        if shared_base || (named.ends_with("Factory") && !makes.is_empty()) {
            tally.note("factory", "decides which of several related things to make", owner);
        }

        if has_method(SATISFIES) || bases.iter().any(|base| base.contains("Specification")) {
            tally.note("specification", "a business rule asked whether something satisfies it", owner);
        }

        let visits = methods
            .iter()
            .filter(|at| shape.named(**at).get(..5).is_some_and(|begins| begins.eq_ignore_ascii_case("visit")))
            .count();
        if visits >= 3 {
            tally.note("visitor", "one operation written for each kind it visits", owner);
        }

        let listeners = fields.iter().any(|(at, typed)| {
            let element = element_of(typed);
            let listened = element.is_some_and(|element| LISTENS.iter().any(|ending| element.ends_with(ending)));
            let lowered = nodes[*at].name.to_ascii_lowercase();
            let named_so = element.is_some() && LISTENS.iter().any(|ending| lowered.contains(&ending.to_ascii_lowercase()));
            listened || named_so
        });
        let enlists = has_method(ENLISTS);
        let announces = has_method(ANNOUNCES);
        if (listeners && enlists && announces) || bases.iter().any(|base| matches!(*base, "EventEmitter" | "Observable" | "Subject")) {
            tally.note("observer", "keeps listeners and tells them when something happens", owner);
        }

        let abstract_methods: HashSet<usize> =
            methods.iter().copied().filter(|at| nodes[*at].modifiers.abstract_member).collect();
        let steps_through_them = methods.iter().any(|at| {
            !abstract_methods.contains(at)
                && shape.calls[*at].iter().any(|called| abstract_methods.contains(called))
        });
        if !abstract_methods.is_empty() && steps_through_them && shape.interface_like(named) {
            tally.note("template method", "fixes the steps of an algorithm and lets subclasses fill them in", owner);
        }

        let chains_to_the_next = fields.iter().any(|(at, typed)| {
            let lowered = nodes[*at].name.to_ascii_lowercase();
            (lowered.contains("next") || lowered.contains("successor")) && (plain(typed) == named || bases.contains(&plain(typed)))
        });
        if chains_to_the_next {
            tally.note("chain of responsibility", "handles what it can and passes the rest to the next", owner);
        }
    }

    let mut held_as: HashMap<&str, HashSet<usize>> = HashMap::default();
    for (at, node) in nodes.iter().enumerate() {
        if node.kind != NodeKind::Property || shape.tested(at) {
            continue;
        }
        let (Some(typed), Some(owner)) = (node.type_annotation.as_deref(), graph.owner[at]) else { continue };
        held_as.entry(plain(typed)).or_default().insert(owner);
    }
    for (base, implementing) in &graph.implementors {
        let implementing: Vec<usize> = implementing.iter().copied().filter(|at| !shape.tested(*at)).collect();
        if implementing.len() < 2 {
            continue;
        }
        let Some(declared) = graph.declared_as.get(base).copied() else { continue };
        let declared_methods: Vec<usize> = shape.methods(declared).collect();
        let held_by_others = held_as
            .get(base)
            .is_some_and(|owners| owners.iter().any(|owner| !implementing.contains(owner)));
        if declared_methods.len() == 1 && shape.called(declared_methods[0], EXECUTES) && implementing.len() >= 3 {
            tally.note("command", "each action wrapped as an object that can be run", declared);
        } else if held_by_others && implementing.len() >= 2 && !declared_methods.is_empty() && declared_methods.len() <= 4 {
            tally.note("strategy", "interchangeable ways of doing one thing, chosen by whoever holds it", declared);
        }
    }

    for (at, node) in nodes.iter().enumerate() {
        if shape.tested(at) || !node.kind.is_unit() {
            continue;
        }
        let takes_next = node.signature.as_ref().is_some_and(|signature| {
            signature.parameters.iter().any(|parameter| matches!(parameter.name.as_str(), "next" | "call_next" | "nextHandler"))
        });
        if takes_next {
            tally.note("chain of responsibility", "handles what it can and passes the rest to the next", at);
        }
    }

    tally.found()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_collection_names_what_it_holds() {
        assert_eq!(element_of("List<IShape>"), Some("IShape"));
        assert_eq!(element_of("IShape[]"), Some("IShape"));
        assert_eq!(element_of("Dictionary<string, IShape>"), None);
        assert_eq!(element_of("IShape"), None);
    }
}

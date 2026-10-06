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
static CALLABLE: &[&str] = &["Action", "Callable", "Consumer", "Delegate", "Function", "Runnable", "func"];
static MAPS: &[&str] = &["Dictionary", "HashMap", "IDictionary", "Map", "Record", "SortedMap", "TreeMap", "dict"];
static VISITS: &str = "visit";
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
    metrics: HashMap<&'a str, &'a UnitMetrics>,
    receivers: HashMap<&'a str, HashSet<&'a str>>,
}

impl<'g, 'a> Shape<'g, 'a> {
    fn new(graph: &'g crate::shared::Graph<'a>, edges: &'a [IndexEdge], metrics: &'a [UnitMetricsEntry], calls_made: &'a [CallFact]) -> Self {
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
        let metrics = metrics.iter().map(|entry| (entry.unit.as_str(), &entry.metrics)).collect();
        let mut receivers: HashMap<&str, HashSet<&str>> = HashMap::default();
        for call in calls_made {
            if let (Some(caller), Some(receiver)) = (call.caller.as_deref(), call.receiver.as_deref()) {
                receivers.entry(caller).or_default().insert(receiver.rsplit(['.', '>']).next().unwrap_or(receiver).trim());
            }
        }
        Shape { graph, nodes, calls, instantiates, metrics, receivers }
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

    fn reads(&self, unit: usize, field: &str) -> bool {
        let id = self.nodes[unit].id.as_str();
        self.metrics.get(id).is_some_and(|held| held.reads.iter().any(|read| read == field))
            || self.receivers.get(id).is_some_and(|held| held.contains(field))
    }

    fn knows(&self, owner: usize, other: usize) -> bool {
        self.fields(owner).any(|(_, typed)| {
            let held = element_of(typed).unwrap_or_else(|| plain(typed));
            held == self.named(other) || self.bases_of(other).contains(&held)
        })
    }

    fn polymorphic(&self, held: usize) -> bool {
        self.nodes[held].kind == NodeKind::Interface
            || self.nodes[held].modifiers.abstract_member
            || self.interface_like(self.named(held))
    }

    fn writes(&self, unit: usize, field: &str) -> bool {
        self.metrics.get(self.nodes[unit].id.as_str()).is_some_and(|held| held.writes.iter().any(|written| written == field))
    }

    fn returns(&self, unit: usize) -> bool {
        self.metrics.get(self.nodes[unit].id.as_str()).is_some_and(|held| held.returns > 0)
    }

    fn type_of(&self, at: usize) -> Option<usize> {
        match self.nodes[at].kind.is_type() {
            true => Some(at),
            false => self.graph.owner[at].filter(|owner| self.nodes[*owner].kind.is_type()),
        }
    }

    fn kin(&self, left: usize, right: usize) -> bool {
        left == right
            || self.bases_of(left).contains(&self.named(right))
            || self.bases_of(right).contains(&self.named(left))
            || self.bases_of(left).iter().any(|base| self.bases_of(right).contains(base))
    }

    fn collaborators(&self, owner: usize) -> Vec<(usize, usize)> {
        self.fields(owner)
            .filter(|(_, typed)| element_of(typed).is_none())
            .filter_map(|(field, typed)| {
                let held = *self.graph.declared_as.get(plain(typed))?;
                (held != owner && !self.tested(held)).then_some((field, held))
            })
            .collect()
    }

    fn delegates(&self, method: usize, field: usize, held: usize) -> bool {
        self.reads(method, self.named(field))
            && self.calls[method].iter().any(|called| self.type_of(*called).is_some_and(|owner| self.kin(owner, held)))
    }

    fn mostly_delegates(&self, owner: usize, field: usize, held: usize) -> bool {
        let methods: Vec<usize> = self
            .methods(owner)
            .filter(|at| self.nodes[*at].kind != NodeKind::Constructor && !self.nodes[*at].modifiers.private_member)
            .collect();
        let delegating = methods.iter().filter(|at| self.delegates(**at, field, held)).count();
        delegating > 0 && delegating * 2 >= methods.len()
    }

    fn translates(&self, owner: usize, field: usize, held: usize) -> bool {
        self.methods(owner).any(|method| {
            self.delegates(method, field, held)
                && self.calls[method]
                    .iter()
                    .filter(|called| self.type_of(**called).is_some_and(|target| self.kin(target, held)))
                    .any(|called| !self.named(*called).eq_ignore_ascii_case(self.named(method)))
        })
    }

    fn framework_served(&self, owner: usize) -> bool {
        !self.nodes[owner].decorators.is_empty()
            || self.methods(owner).any(|method| !self.nodes[method].decorators.is_empty())
    }

    fn creates(&self, owner: usize, held: usize) -> bool {
        self.graph.members[owner]
            .iter()
            .filter(|at| self.nodes[**at].kind.is_unit())
            .flat_map(|at| self.instantiates[*at].iter())
            .filter_map(|made| self.type_of(*made))
            .any(|made| self.kin(made, held))
    }
}

fn plain(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']).trim();
    let annotation = annotation.split(['<', '[', '?']).next().unwrap_or(annotation);
    crate::names::leaf(annotation.trim())
}

fn alternatives(annotation: &str) -> impl Iterator<Item = &str> {
    annotation.split('|').map(plain)
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

fn deep_element_of(annotation: &str) -> Option<String> {
    let written = annotation.trim();
    if let Some(inner) = written.strip_suffix("[]") {
        return Some(plain(inner).to_string());
    }
    let outer = plain(written);
    let arguments = type_arguments(written);
    if MAPS.contains(&outer) {
        let value = arguments.last()?;
        let value_written = written.rsplit_once(',').map_or(value.as_str(), |(_, rest)| rest.trim_end_matches('>').trim());
        return deep_element_of(value_written).or_else(|| Some(plain(value).to_string()));
    }
    if COLLECTS.contains(&outer) {
        return arguments.first().cloned();
    }
    None
}

fn a_callable(named: &str) -> bool {
    CALLABLE.contains(&named) || named.contains("=>") || LISTENS.iter().any(|ending| named.ends_with(ending))
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

pub fn derive(graph: &crate::shared::Graph, edges: &[IndexEdge], metrics: &[UnitMetricsEntry], calls: &[CallFact]) -> Vec<Found> {
    let nodes = graph.nodes;
    let shape = Shape::new(graph, edges, metrics, calls);
    let mut tally = Tally { held: BTreeMap::new(), nodes };

    for owner in shape.types() {
        let named = shape.named(owner);
        let bases = shape.bases_of(owner);
        let fields: Vec<(usize, &str)> = shape.fields(owner).collect();
        let methods: Vec<usize> = shape.methods(owner).collect();
        let has_method = |list: &[&str]| methods.iter().any(|at| shape.called(*at, list));

        let collaborators = shape.collaborators(owner);
        let wrapped_of_its_kind = collaborators.iter().find(|(field, held)| {
            let typed = nodes[*field].type_annotation.as_deref().map(plain).unwrap_or_default();
            (bases.contains(&typed) && shape.interface_like(typed))
                || (shape.kin(owner, *held) && shape.mostly_delegates(owner, *field, *held))
        });
        let collects_its_own_kind = fields
            .iter()
            .any(|(_, typed)| element_of(typed).is_some_and(|element| bases.contains(&element)));
        if collects_its_own_kind {
            tally.note("composite", "a part that holds parts of its own kind", owner);
        } else if let Some((_, held)) = wrapped_of_its_kind {
            match shape.creates(owner, *held) {
                true => tally.note("proxy", "stands in for another of its own kind that it makes and controls access to", owner),
                false => tally.note("decorator", "wraps another of its own kind and adds to it", owner),
            }
        }

        let roleless = graph.role_of[owner].is_none() && !shape.framework_served(owner);
        let mut delegated_to: Vec<usize> = Vec::new();
        for (field, held) in &collaborators {
            if shape.mostly_delegates(owner, *field, *held) && shape.translates(owner, *field, *held) && !delegated_to.contains(held) {
                delegated_to.push(*held);
            }
        }
        let adapts = delegated_to
            .iter()
            .filter(|held| !shape.kin(owner, **held) && !shape.polymorphic(**held) && !shape.knows(**held, owner))
            .copied()
            .collect::<Vec<usize>>();
        let leaf_collaborator = |held: usize| shape.collaborators(held).is_empty();
        if roleless && wrapped_of_its_kind.is_none() && !adapts.is_empty() {
            let layered = adapts.iter().any(|held| !leaf_collaborator(*held));
            if adapts.len() >= 2 || layered {
                tally.note("facade", "one simple entry to several parts behind it", owner);
            } else {
                tally.note("adapter", "makes one thing answer to the interface another expects", owner);
            }
        }

        let mediates = fields.iter().filter_map(|(_, typed)| Some(*graph.declared_as.get(element_of(typed)?)?)).any(|colleague| {
            colleague != owner
                && !shape.tested(colleague)
                && shape.fields(colleague).any(|(_, typed)| plain(typed) == named || bases.contains(&plain(typed)))
                && methods.iter().any(|at| shape.calls[*at].iter().any(|called| shape.type_of(*called) == Some(colleague)))
                && shape.methods(colleague).any(|at| shape.calls[at].iter().any(|called| shape.type_of(*called) == Some(owner)))
        });
        if mediates {
            tally.note("mediator", "colleagues talk through one object instead of to each other", owner);
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
        let fluent = methods
            .iter()
            .filter(|at| {
                let unannotated = nodes[**at].signature.as_ref().and_then(|signature| signature.return_type.as_deref()).is_none();
                unannotated
                    && shape.returns(**at)
                    && fields.iter().any(|(field, _)| shape.writes(**at, shape.named(*field)))
            })
            .count();
        let makes_a_product = methods.iter().any(|at| {
            shape.called(*at, BUILDS)
                && shape.instantiates[*at].iter().filter_map(|made| shape.type_of(*made)).any(|made| made != owner && !shape.kin(made, owner))
        });
        if (returns_itself >= 2 || (returns_itself + fluent >= 1 && makes_a_product)) && has_method(BUILDS) {
            tally.note("builder", "assembles its product step by step, then builds it", owner);
        }

        let holds_itself_statically = fields.iter().any(|(at, typed)| nodes[*at].modifiers.is_static && alternatives(typed).any(|held| held == named));
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
            .filter(|at| shape.named(**at).get(..VISITS.len()).is_some_and(|begins| begins.eq_ignore_ascii_case(VISITS)))
            .count();
        if visits >= 2 {
            tally.note("visitor", "one operation written for each kind it visits", owner);
        }

        let listeners = fields.iter().any(|(at, typed)| {
            let element = element_of(typed);
            let called_back = deep_element_of(typed).is_some_and(|element| a_callable(&element));
            let listened = called_back || element.is_some_and(|element| LISTENS.iter().any(|ending| element.ends_with(ending)));
            let lowered = nodes[*at].name.to_ascii_lowercase();
            let named_so = element.is_some() && LISTENS.iter().any(|ending| lowered.contains(&ending.to_ascii_lowercase()));
            listened || named_so
        });
        let enlists = has_method(ENLISTS);
        let announces = has_method(ANNOUNCES);
        if (listeners && enlists && announces) || bases.iter().any(|base| matches!(*base, "EventEmitter" | "Observable" | "Subject")) {
            tally.note("observer", "keeps listeners and tells them when something happens", owner);
        }

        let acts: Vec<usize> =
            methods.iter().copied().filter(|at| nodes[*at].kind != NodeKind::Constructor && !nodes[*at].modifiers.private_member).collect();
        if acts.len() == 1 && shape.called(acts[0], EXECUTES) && !fields.is_empty() && graph.role_of[owner].is_none() && !shape.framework_served(owner) {
            tally.note("command", "an action kept as an object with what it needs, run when asked", owner);
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
    fn a_nullable_union_still_names_the_type_it_holds() {
        assert_eq!(alternatives("ServiceRegistry | undefined").collect::<Vec<_>>(), vec!["ServiceRegistry", "undefined"]);
        assert_eq!(alternatives("Registry").collect::<Vec<_>>(), vec!["Registry"]);
    }

    #[test]
    fn a_collection_names_what_it_holds() {
        assert_eq!(element_of("List<IShape>"), Some("IShape"));
        assert_eq!(element_of("IShape[]"), Some("IShape"));
        assert_eq!(element_of("Dictionary<string, IShape>"), None);
        assert_eq!(element_of("IShape"), None);
    }
}

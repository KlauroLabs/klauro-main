use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::model::*;
use crate::names;

static ENDS_THE_REQUEST: &[&str] = &["abort", "halt", "head", "raise", "redirect_back", "redirect_back_or_to", "redirect_to", "render"];

fn ends_the_request(callee: &str) -> bool {
    let spoken = names::leaf(callee);
    ENDS_THE_REQUEST.contains(&spoken) || spoken.starts_with("render_")
}

pub fn is_a_framework_gate(callee: &str) -> bool {
    let spoken = names::leaf(callee);
    if spoken.ends_with('?') {
        return false;
    }
    let base = spoken.trim_end_matches('!');
    matches!(base, "authenticate" | "authorize")
        || base.starts_with("authenticate_")
        || base.starts_with("authorize_")
        || base.ends_with("_authorize")
}

pub struct Callbacks<'a> {
    methods: HashMap<(&'a str, &'a str), &'a IndexNode>,
    calls_in: HashMap<&'a str, Vec<&'a CallFact>>,
    above: &'a HashMap<&'a str, Vec<&'a str>>,
    types: &'a HashMap<&'a str, &'a IndexNode>,
}

impl<'a> Callbacks<'a> {
    pub fn new(
        nodes: &'a [IndexNode],
        calls: &'a [CallFact],
        above: &'a HashMap<&'a str, Vec<&'a str>>,
        types: &'a HashMap<&'a str, &'a IndexNode>,
    ) -> Self {
        let mut methods = HashMap::default();
        for node in nodes.iter().filter(|node| node.kind.is_unit()) {
            if let Some(parent) = node.parent.as_deref() {
                methods.entry((parent, node.name.as_str())).or_insert(node);
            }
        }
        let mut calls_in: HashMap<&str, Vec<&CallFact>> = HashMap::default();
        for call in calls {
            if let Some(caller) = call.caller.as_deref() {
                calls_in.entry(caller).or_default().push(call);
            }
        }
        Callbacks { methods, calls_in, above, types }
    }

    fn lineage(&self, owner: &'a str) -> Vec<&'a str> {
        let mut seen: HashSet<&str> = HashSet::default();
        let mut order = Vec::new();
        let mut pending = vec![owner];
        while let Some(at) = pending.pop() {
            if !seen.insert(at) {
                continue;
            }
            order.push(at);
            for name in self.above.get(at).into_iter().flatten() {
                if let Some(parent) = self.types.get(names::leaf(name)) {
                    pending.push(parent.id.as_str());
                }
            }
        }
        order
    }

    fn defined(&self, lineage: &[&'a str], name: &str) -> Option<&'a IndexNode> {
        lineage.iter().find_map(|owner| self.methods.get(&(*owner, name)).copied())
    }

    pub fn denies(&self, owner: &'a str, name: &str) -> Option<bool> {
        let lineage = self.lineage(owner);
        let first = self.defined(&lineage, name)?;
        let mut visited: HashSet<&str> = HashSet::default();
        let mut pending = vec![first];
        while let Some(method) = pending.pop() {
            if !visited.insert(method.id.as_str()) {
                continue;
            }
            for call in self.calls_in.get(method.id.as_str()).into_iter().flatten() {
                if ends_the_request(&call.callee) || is_a_framework_gate(&call.callee) {
                    return Some(true);
                }
                if call.receiver.as_deref().is_none_or(|within| within == "self")
                    && let Some(next) = self.defined(&lineage, &call.callee)
                {
                    pending.push(next);
                }
            }
        }
        Some(false)
    }
}

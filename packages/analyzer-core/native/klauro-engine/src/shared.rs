use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::model::*;

pub struct Graph<'a> {
    pub nodes: &'a [IndexNode],
    pub position: HashMap<&'a str, usize>,
    pub members: Vec<Vec<usize>>,
    pub owner: Vec<Option<usize>>,
    pub implementors: HashMap<&'a str, Vec<usize>>,
    pub bases: Vec<Vec<&'a str>>,
    pub extends_parent: Vec<Option<usize>>,
    pub declared_as: HashMap<&'a str, usize>,
    pub role_of: Vec<Option<&'static str>>,
    pub tested: Vec<bool>,
    pub tested_file: Vec<bool>,
    pub project_reaches: HashMap<&'a str, HashSet<&'a str>>,
}

pub fn named_one_of(name: &str, list: &[&str]) -> bool {
    list.iter().any(|held| held.eq_ignore_ascii_case(name))
}

impl<'a> Graph<'a> {
    pub fn new(
        nodes: &'a [IndexNode],
        edges: &'a [IndexEdge],
        type_references: &'a [TypeReferenceFact],
        roles: &'a crate::roles::Roles,
        paths: &[&str],
    ) -> Self {
        let mut position: HashMap<&str, usize> = HashMap::default();
        position.reserve(nodes.len());
        position.extend(nodes.iter().enumerate().map(|(at, node)| (node.id.as_str(), at)));
        let tested_file: Vec<bool> = paths.iter().map(|path| crate::paths::is_test(path)).collect();
        let tested: Vec<bool> =
            nodes.iter().map(|node| tested_file.get(node.file as usize).copied().unwrap_or(false)).collect();
        let mut members: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
        let mut owner: Vec<Option<usize>> = vec![None; nodes.len()];
        for (at, node) in nodes.iter().enumerate() {
            if let Some(parent) = node.parent.as_deref().and_then(|parent| position.get(parent)) {
                members[*parent].push(at);
                owner[at] = Some(*parent);
            }
        }
        let mut implementors: HashMap<&str, Vec<usize>> = HashMap::default();
        let mut bases: Vec<Vec<&str>> = vec![Vec::new(); nodes.len()];
        let mut extends_parent: Vec<Option<usize>> = vec![None; nodes.len()];
        let mut project_reaches: HashMap<&str, HashSet<&str>> = HashMap::default();
        for edge in edges {
            let (Some(from), Some(to)) = (position.get(edge.source.as_str()), position.get(edge.target.as_str())) else {
                continue;
            };
            if matches!(edge.kind, EdgeKind::Extends | EdgeKind::Implements) {
                implementors.entry(nodes[*to].name.as_str()).or_default().push(*from);
                bases[*from].push(nodes[*to].name.as_str());
                if edge.kind == EdgeKind::Extends && extends_parent[*from].is_none() {
                    extends_parent[*from] = Some(*to);
                }
            }
            if edge.kind != EdgeKind::Contains
                && let (Some(above), Some(below)) = (nodes[*from].project.as_deref(), nodes[*to].project.as_deref())
                && above != below
            {
                project_reaches.entry(above).or_default().insert(below);
            }
        }
        for reference in type_references.iter().filter(|reference| matches!(reference.kind, EdgeKind::Extends | EdgeKind::Implements)) {
            if let Some(from) = position.get(reference.source.as_str()) {
                let named = crate::names::leaf(reference.name.as_str());
                implementors.entry(named).or_default().push(*from);
                bases[*from].push(named);
            }
        }
        for held in implementors.values_mut() {
            held.sort_unstable();
            held.dedup();
        }
        for held in bases.iter_mut() {
            held.sort_unstable();
            held.dedup();
        }
        let mut declared_as: HashMap<&str, usize> = HashMap::default();
        for (at, node) in nodes.iter().enumerate() {
            if node.kind.is_type() {
                declared_as.entry(node.name.as_str()).or_insert(at);
            }
        }
        let mut role_of: Vec<Option<&'static str>> = vec![None; nodes.len()];
        for role in &roles.roles {
            if let Some(at) = position.get(role.node.as_str()) {
                role_of[*at].get_or_insert(role.role);
            }
        }
        Graph {
            nodes,
            position,
            members,
            owner,
            implementors,
            bases,
            extends_parent,
            declared_as,
            role_of,
            tested,
            tested_file,
            project_reaches,
        }
    }

    pub fn at(&self, id: &str) -> Option<usize> {
        self.position.get(id).copied()
    }

    pub fn file_tested(&self, file: u32) -> bool {
        self.tested_file.get(file as usize).copied().unwrap_or(false)
    }

    pub fn type_owner(&self, unit: usize) -> Option<usize> {
        self.owner[unit].filter(|at| self.nodes[*at].kind.is_type())
    }
}

use rustc_hash::FxHashSet as HashSet;

use super::installers::{binaries_of, spawns};
use super::{dependency_names, Deployable, Files};
use crate::model::{CallFact, EdgeKind, IndexEdge};
use crate::paths::{contains, file_of};

pub(super) struct Links<'a> {
    pub files: &'a Files<'a>,
    pub edges: &'a [IndexEdge],
    pub calls: &'a [CallFact],
}

fn names_of(links: &Links, unit: &Deployable) -> Vec<String> {
    let mut names = vec![unit.name.clone()];
    for found in unit.declarations.iter().filter(|found| found.kind == "package-identity" && found.at.ends_with("Cargo.toml")) {
        names.extend(binaries_of(links.files, &found.at, &unit.name));
    }
    names.sort();
    names.dedup();
    names
}

fn relies_on(links: &Links, user: &Deployable, used: &Deployable) -> bool {
    if user.root.is_empty() || used.root.is_empty() {
        return false;
    }
    let used_names = names_of(links, used);
    let declared = user
        .declarations
        .iter()
        .filter(|found| found.kind == "package-identity")
        .any(|found| dependency_names(links.files, &found.at).iter().any(|name| used_names.contains(name)));
    if declared {
        return true;
    }
    let imports = links.edges.iter().any(|edge| {
        edge.kind == EdgeKind::Imports && contains(&user.root, file_of(&edge.source)) && contains(&used.root, file_of(&edge.target))
    });
    if imports {
        return true;
    }
    links.calls.iter().any(|call| {
        spawns(&call.callee)
            && links.files.paths.get(call.file as usize).is_some_and(|path| contains(&user.root, path))
            && call.literals.iter().any(|literal| used_names.contains(literal))
    })
}

pub(super) fn leader(links: &Links, group: &[usize], deployables: &[Deployable], produced: &[String]) -> Option<usize> {
    if group.len() < 2 {
        return None;
    }
    let named: Vec<usize> = group.iter().copied().filter(|unit| produced.contains(&deployables[*unit].name)).collect();
    if let [only] = named.as_slice() {
        return Some(*only);
    }
    let relied_on: HashSet<usize> = group
        .iter()
        .copied()
        .flat_map(|user| group.iter().copied().filter(move |used| *used != user).map(move |used| (user, used)))
        .filter(|(user, used)| relies_on(links, &deployables[*user], &deployables[*used]))
        .map(|(_, used)| used)
        .collect();
    let mut driving = group.iter().copied().filter(|candidate| {
        !relied_on.contains(candidate)
            && group
                .iter()
                .copied()
                .filter(|other| other != candidate)
                .all(|other| relies_on(links, &deployables[*candidate], &deployables[other]))
    });
    match (driving.next(), driving.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

use std::sync::OnceLock;

use rustc_hash::FxHashMap as HashMap;

use super::{Candidate, Declaration, Declares, Files};
use crate::model::CallFact;
use crate::paths::{directory_of, display_name, join};

static TABLE: &str = include_str!("../../data/installers.tsv");

fn row(kind: &str) -> &'static [&'static str] {
    static HELD: OnceLock<HashMap<&'static str, Vec<&'static str>>> = OnceLock::new();
    HELD.get_or_init(|| {
        TABLE
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| {
                let (kind, values) = line.split_once('\t')?;
                Some((kind, values.split(',').collect()))
            })
            .collect()
    })
    .get(kind)
    .map(Vec::as_slice)
    .unwrap_or(&[])
}

#[derive(Default)]
pub(super) struct Evidence {
    pub by_format: bool,
    packages: Vec<String>,
    outputs: Vec<String>,
    pub produced: Vec<String>,
}

fn is_a_flag(token: &str) -> bool {
    token.starts_with('-')
}

fn is_unresolved(token: &str) -> bool {
    token.contains(['$', '*', '%']) || token.starts_with(['/', '~'])
}

fn lands_in_a_system_location(destination: &str) -> bool {
    row("system").iter().any(|prefix| destination.starts_with(prefix))
}

fn produced_name(literal: &str) -> Option<String> {
    let name = literal.rsplit(['/', '\\']).next()?;
    row("archive")
        .iter()
        .filter_map(|suffix| name.strip_suffix(suffix))
        .filter(|stem| !stem.is_empty())
        .max_by_key(|stem| std::cmp::Reverse(stem.len()))
        .map(str::to_string)
}

fn named_packages(calls: &[&CallFact]) -> Vec<String> {
    let mut named = Vec::new();
    let options = row("package_option");
    for call in calls.iter().filter(|call| row("builder").contains(&call.callee.as_str())) {
        for pair in call.literals.windows(2) {
            if !options.contains(&pair[0].as_str()) {
                continue;
            }
            let value = pair[1].trim_matches(['"', '\'']);
            if !value.starts_with('$') {
                named.push(value.to_string());
                continue;
            }
            let Some(function) = call.caller.as_deref().and_then(|caller| caller.rsplit_once(":function:")).map(|(_, name)| name) else {
                continue;
            };
            for passed in calls.iter().filter(|other| other.callee == function) {
                named.extend(passed.literals.iter().filter(|literal| !is_a_flag(literal)).cloned());
            }
        }
    }
    named.sort();
    named.dedup();
    named
}

pub(super) fn detect(files: &Files, path: &str, calls: &[CallFact], file: u32) -> Option<(Candidate, Evidence)> {
    if crate::paths::is_continuous_integration(path) {
        return None;
    }
    let extension = path.rsplit('/').next()?.rsplit_once('.')?.1.to_ascii_lowercase();
    let root = directory_of(path).to_string();
    let declaration = Declaration { declares: Declares::Ship, kind: "installer", at: path.to_string() };
    if row("format").contains(&extension.as_str()) {
        let candidate = Candidate { name: display_name(&root), root, declarations: vec![declaration], ships: Vec::new(), runs: None };
        return Some((candidate, Evidence { by_format: true, ..Evidence::default() }));
    }
    if !row("script").contains(&extension.as_str()) {
        return None;
    }
    let mine: Vec<&CallFact> = calls.iter().filter(|call| call.file == file).collect();
    let mut places_a_system_file = false;
    let mut ships: Vec<String> = Vec::new();
    let mut evidence = Evidence::default();
    for call in mine.iter().filter(|call| row("placing").contains(&call.callee.as_str())) {
        let operands: Vec<&String> = call.literals.iter().filter(|literal| !is_a_flag(literal)).collect();
        let Some((destination, sources)) = operands.split_last() else { continue };
        places_a_system_file |= lands_in_a_system_location(destination);
        for source in sources {
            let source = source.trim_end_matches('/');
            if source.is_empty() || is_unresolved(source) {
                continue;
            }
            let rooted = join(&root, source);
            match files.holds(&rooted) && !rooted.is_empty() {
                true => ships.push(rooted),
                false => evidence.outputs.push(rooted),
            }
        }
    }
    for call in mine.iter().filter(|call| row("packaging").contains(&call.callee.as_str())) {
        evidence.produced.extend(call.literals.iter().filter_map(|literal| produced_name(literal)));
    }
    let packages = mine.iter().any(|call| row("packaging").contains(&call.callee.as_str()));
    if !places_a_system_file && !packages {
        return None;
    }
    evidence.packages = named_packages(&mine);
    ships.sort();
    ships.dedup();
    let candidate = Candidate { name: display_name(&root), root, declarations: vec![declaration], ships, runs: None };
    Some((candidate, evidence))
}

pub(super) fn binaries_of(files: &Files, manifest: &str, package: &str) -> Vec<String> {
    let mut named = vec![package.to_string()];
    for binary in files.of(manifest).into_iter().flatten().filter(|node| node.name == "bin") {
        if let Some(name) = files.child(&binary.id, "name").and_then(|node| node.type_annotation.as_deref()) {
            named.push(name.trim_matches('"').to_string());
        }
    }
    named
}

pub(super) fn units_built(files: &Files, units: &[Candidate], evidence: &Evidence) -> Vec<String> {
    let identity = |unit: &&Candidate| !unit.root.is_empty() && unit.declarations.iter().any(|found| found.kind == "package-identity");
    let mut roots: Vec<String> = Vec::new();
    for package in &evidence.packages {
        let mut held = units.iter().filter(identity).filter(|unit| unit.name == *package);
        if let (Some(unit), None) = (held.next(), held.next()) {
            roots.push(unit.root.clone());
        }
    }
    for output in &evidence.outputs {
        let segments: Vec<&str> = output.split('/').collect();
        let Some((built, directories)) = segments.split_last() else { continue };
        if !directories.contains(&"target") {
            continue;
        }
        let built = built.strip_suffix(".exe").unwrap_or(built);
        let mut held = units.iter().filter(identity).filter(|unit| {
            unit.declarations.iter().filter(|found| found.kind == "package-identity" && found.at.ends_with("Cargo.toml")).any(|found| {
                binaries_of(files, &found.at, &unit.name).iter().any(|binary| binary == built)
            })
        });
        if let (Some(unit), None) = (held.next(), held.next()) {
            roots.push(unit.root.clone());
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

pub(super) fn spawns(callee: &str) -> bool {
    row("spawn").iter().any(|held| callee == *held || callee.ends_with(&format!("::{held}")) || callee.ends_with(&format!(".{held}")))
}

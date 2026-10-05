use rustc_hash::FxHashMap as HashMap;

use crate::model::{IndexNode, LocalBinding};

const EXPANDED_AT_MOST: usize = 4;

pub struct Constants<'a> {
    in_unit: HashMap<(&'a str, &'a str), &'a str>,
    in_file: HashMap<(u32, &'a str), &'a str>,
    in_repository: HashMap<&'a str, Option<&'a str>>,
}

pub struct Standing<'a> {
    pub file: u32,
    pub unit: &'a str,
    pub owner: Option<&'a str>,
    pub node: Option<&'a IndexNode>,
}

static ENDINGS: &[&str] = &["Base", "Endpoint", "Prefix", "Root", "URL", "Url"];

fn stands_apart(name: &str) -> bool {
    let shouted = name.len() > 2
        && name.chars().any(|letter| letter.is_ascii_uppercase())
        && name.chars().all(|letter| letter.is_ascii_uppercase() || letter.is_ascii_digit() || letter == '_');
    shouted || ENDINGS.iter().any(|ending| name.len() > ending.len() && name.ends_with(ending))
}

impl<'a> Constants<'a> {
    pub fn new(locals: &'a [LocalBinding]) -> Self {
        let mut in_unit = HashMap::default();
        let mut in_file = HashMap::default();
        let mut in_repository: HashMap<&str, Option<&str>> = HashMap::default();
        for local in locals {
            let Some(written) = local.written.as_deref() else { continue };
            in_unit.entry((local.unit.as_str(), local.name.as_str())).or_insert(written);
            if local.unit.is_empty() {
                in_file.entry((local.file, local.name.as_str())).or_insert(written);
                in_repository
                    .entry(local.name.as_str())
                    .and_modify(|held| {
                        if *held != Some(written) {
                            *held = None;
                        }
                    })
                    .or_insert(Some(written));
            }
        }
        Constants { in_unit, in_file, in_repository }
    }

    pub fn value(&self, at: &Standing, named: &str) -> Option<String> {
        let named = named.trim();
        let bare = named.trim_start_matches("this.").trim_start_matches("self.").trim_start_matches('_');
        let leaf = bare.rsplit('.').next().unwrap_or(bare);
        let passed = at
            .node
            .and_then(|node| node.signature.as_ref())
            .is_some_and(|signature| signature.parameters.iter().any(|parameter| parameter.name == named));
        if passed {
            return None;
        }
        for held in [named, bare] {
            let local = self
                .in_unit
                .get(&(at.unit, held))
                .or_else(|| at.owner.and_then(|owner| self.in_unit.get(&(owner, held))))
                .or_else(|| self.in_file.get(&(at.file, held)));
            if let Some(found) = local {
                return Some((*found).to_string());
            }
        }
        self.in_file
            .get(&(at.file, leaf))
            .copied()
            .or_else(|| stands_apart(leaf).then(|| self.in_repository.get(leaf).copied().flatten()).flatten())
            .map(str::to_string)
    }

    pub fn spell(&self, at: &Standing, literal: &str) -> String {
        let held = literal.trim();
        let bare = !held.is_empty() && held.chars().all(|letter| letter.is_alphanumeric() || letter == '_' || letter == '.');
        match bare.then(|| self.value(at, held)).flatten() {
            Some(value) => value,
            None => self.expand(at, held),
        }
    }

    pub fn expand(&self, at: &Standing, template: &str) -> String {
        let mut written = template.to_string();
        for _ in 0..EXPANDED_AT_MOST {
            let mut changed = false;
            let mut out = String::with_capacity(written.len());
            let mut rest = written.as_str();
            while let Some(open) = rest.find('{') {
                let Some(close) = rest[open..].find('}').map(|found| open + found) else { break };
                let named = rest[open + 1..close].trim();
                match self.value(at, named).filter(|_| !named.is_empty()) {
                    Some(value) => {
                        out.push_str(rest[..open].trim_end_matches('$'));
                        out.push_str(&value);
                        changed = true;
                    }
                    None => out.push_str(&rest[..=close]),
                }
                rest = &rest[close + 1..];
            }
            out.push_str(rest);
            written = out;
            if !changed {
                break;
            }
        }
        written
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(file: u32, unit: &str, name: &str, value: &str) -> LocalBinding {
        LocalBinding {
            file,
            unit: unit.to_string(),
            name: name.to_string(),
            written: Some(value.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn a_name_is_read_from_its_unit_then_its_file_then_the_one_place_the_repository_declares_it() {
        let locals = vec![
            constant(1, "", "ROOT", "/api"),
            constant(2, "", "SHARED", "/v1"),
            constant(2, "", "plain", "/lower"),
            constant(3, "", "CLASHES", "/a"),
            constant(4, "", "CLASHES", "/b"),
        ];
        let known = Constants::new(&locals);
        let at = Standing { file: 1, unit: "f", owner: None, node: None };
        assert_eq!(known.expand(&at, "${ROOT}/orders"), "/api/orders");
        assert_eq!(known.expand(&at, "${SHARED}/orders"), "/v1/orders");
        assert_eq!(known.expand(&at, "${CLASHES}/orders"), "${CLASHES}/orders");
        assert_eq!(known.expand(&at, "${path}"), "${path}");
        assert_eq!(known.expand(&at, "${plain}/x"), "${plain}/x");
        assert_eq!(known.expand(&at, "{ROOT}/x"), "/api/x");
    }
}

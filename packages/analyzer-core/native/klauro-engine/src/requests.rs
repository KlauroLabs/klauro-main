use std::sync::OnceLock;

use rustc_hash::FxHashMap as HashMap;

use crate::entry_exit::ExitPoint;
use crate::model::CallFact;
use crate::names;

static HTTP_CALLS: &str = include_str!("../data/http_calls.tsv");

static METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

struct Calls {
    named: HashMap<String, &'static str>,
    asking: Vec<String>,
    fallback: HashMap<String, &'static str>,
}

fn method_of(word: &str) -> Option<&'static str> {
    METHODS.iter().copied().find(|held| held.eq_ignore_ascii_case(word))
}

fn calls() -> &'static Calls {
    static HELD: OnceLock<Calls> = OnceLock::new();
    HELD.get_or_init(|| {
        let mut held = Calls { named: HashMap::default(), asking: Vec::new(), fallback: HashMap::default() };
        for line in HTTP_CALLS.lines().filter(|line| !line.trim().is_empty()) {
            let Some((verb, listed)) = line.split_once('\t') else { continue };
            let listed = listed.split(',').map(str::to_string);
            match verb {
                "*" => held.asking.extend(listed),
                _ if verb.starts_with('?') => {
                    if let Some(method) = method_of(&verb[1..]) {
                        held.fallback.extend(listed.map(|name| (name, method)));
                    }
                }
                _ => {
                    if let Some(method) = method_of(verb) {
                        held.named.extend(listed.map(|name| (name, method)));
                    }
                }
            }
        }
        held
    })
}

fn spoken_in(literal: &str) -> Option<&'static str> {
    let written = literal.trim();
    if let Some(value) = written.strip_prefix("method=") {
        return method_of(value.trim());
    }
    if let Some(found) = method_of(written) {
        return Some(found);
    }
    let qualified = written.contains(['.', ':']);
    let leaf = names::leaf(written);
    let bare = leaf.strip_prefix("Method").or_else(|| leaf.strip_prefix("method")).unwrap_or(leaf);
    method_of(bare).filter(|_| qualified)
}

pub fn fold(exits: &mut [ExitPoint], calls_made: &[CallFact]) {
    let held = calls();
    let mut at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls_made {
        at.entry((call.file, call.line)).or_default().push(call);
    }
    for exit in exits.iter_mut().filter(|exit| exit.kind == "api" && exit.method.is_none()) {
        let operation = names::leaf(&exit.operation).split('<').next().unwrap_or("").to_ascii_lowercase();
        if let Some(method) = held.named.get(&operation) {
            exit.method = Some(method);
            continue;
        }
        if !held.asking.iter().any(|name| *name == operation) {
            continue;
        }
        let spoken = at.get(&(exit.file, exit.line)).into_iter().flatten().find_map(|call| {
            let same = names::leaf(&call.callee).split('<').next().unwrap_or("").eq_ignore_ascii_case(&operation);
            same.then(|| call.literals.iter().find_map(|literal| spoken_in(literal))).flatten()
        });
        exit.method = spoken.or_else(|| held.fallback.get(&operation).copied());
    }
}

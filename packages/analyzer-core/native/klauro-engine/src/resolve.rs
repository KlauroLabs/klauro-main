use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::externals;
use crate::language_tables::SOURCE_EXTENSIONS;
use crate::model::*;
use crate::paths::{directory_of, join, normalize};

mod typing;

const FORWARDED_AT_MOST: u8 = 6;
const IMPLEMENTERS_AT_MOST: usize = 12;
const TOO_GENERIC_TO_NAME_A_TYPE: &[&str] = &[
    "args", "config", "data", "error", "event", "input", "message", "options", "output", "params", "props", "request",
    "response", "result", "state", "value",
];

pub struct Index<'a> {
    pub files: &'a [String],
    pub languages: &'a [&'a str],
    pub namespaces: &'a [&'a str],
    pub nodes: &'a [IndexNode],
    pub imports: &'a [ImportFact],
    pub calls: &'a [CallFact],
    pub type_references: &'a [TypeReferenceFact],
    pub locals: &'a [LocalBinding],
    pub forwards: &'a [crate::model::Forward],
}

impl Resolution {
    pub fn unit_named(&self, name: &str, file: u32, files: &[String]) -> Option<&str> {
        let family = self.file_families.get(file as usize)?;
        let mut candidates = self
            .named_units
            .get(name)?
            .iter()
            .filter(|(home, _)| self.file_families.get(*home as usize) == Some(family));
        let here = directory_of(files.get(file as usize)?);
        let beside: Vec<&(u32, String)> = candidates
            .clone()
            .filter(|(home, _)| files.get(*home as usize).is_some_and(|path| directory_of(path) == here))
            .collect();
        match beside.as_slice() {
            [only] => return Some(only.1.as_str()),
            [] => {}
            _ => return None,
        }
        let first = candidates.next()?;
        candidates.next().is_none().then_some(first.1.as_str())
    }
}

pub struct Resolution {
    pub edges: Vec<IndexEdge>,
    pub external_nodes: Vec<IndexNode>,
    pub modules: HashMap<(u32, String), String>,
    pub local: HashMap<(u32, String), String>,
    pub named_units: HashMap<String, Vec<(u32, String)>>,
    pub file_families: Vec<String>,
    pub call_origins: HashMap<(String, String), String>,
    pub method_owners: HashMap<String, String>,
    pub internal_specifiers: HashSet<String>,
    pub through: HashMap<(u32, String), String>,
    pub imported: HashMap<(u32, String), String>,
    pub reached: HashMap<(u32, String), u32>,
    pub package_calls: u32,
    pub runtime_calls: u32,
    pub indirect_calls: u32,
    pub dynamic_calls: u32,
    pub unresolved_calls: u32,
    pub no_caller: u32,
    pub unresolved_names: HashMap<String, u32>,
    pub open_calls: HashMap<String, u32>,
}

#[derive(Clone, Copy)]
enum Origin<'a> {
    Declared(u32),
    Runtime(&'a str),
    Package(&'a str),
    Module(u32),
    Indirect,
    Unknown,
}

struct Symbols<'a> {
    nodes: &'a [IndexNode],
    position: HashMap<&'a str, u32>,
    file_scope: HashMap<(u32, &'a str), u32>,
    exported: HashMap<(u32, &'a str), u32>,
    members: HashMap<(u32, &'a str), u32>,
    callables: HashMap<(u32, &'a str), u32>,
    unique_type: HashMap<&'a str, u32>,
    unique_unit: HashMap<&'a str, u32>,
    unique_member: HashMap<&'a str, u32>,
    unique_extension: HashMap<&'a str, u32>,
    extension: HashMap<(&'a str, &'a str), u32>,
    declaring: HashMap<&'a str, Vec<u32>>,
    owner: Vec<Option<u32>>,
    twin: HashMap<u32, u32>,
    package_of: Vec<u32>,
    package_scope: HashMap<(u32, &'a str), u32>,
}

struct Bindings<'a> {
    imported: HashMap<(u32, &'a str), u32>,
    module_files: HashMap<(u32, &'a str), u32>,
    through: HashMap<(u32, &'a str), &'a str>,
    modules: HashMap<(u32, &'a str), &'a str>,
    locals: HashMap<(&'a str, &'a str), &'a str>,
    file_locals: HashMap<(u32, &'a str), &'a str>,
    guessed: HashMap<(&'a str, &'a str), &'a str>,
    file_guessed: HashMap<(u32, &'a str), &'a str>,
    opened: HashMap<u32, Vec<&'a str>>,
    stands_for: HashMap<(&'a str, &'a str), &'a str>,
    elements: HashMap<(&'a str, &'a str), &'a str>,
    called: HashMap<(&'a str, &'a str), (&'a str, u8)>,
    file_called: HashMap<(u32, &'a str), (&'a str, u8)>,
}

fn unique(counts: HashMap<&str, (u32, u32)>) -> HashMap<&str, u32> {
    counts
        .into_iter()
        .filter(|(_, (count, _))| *count == 1)
        .map(|(name, (_, position))| (name, position))
        .collect()
}

impl<'a> Symbols<'a> {
    fn build(nodes: &'a [IndexNode]) -> Self {
        let mut symbols = Symbols {
            nodes,
            position: HashMap::with_capacity_and_hasher(nodes.len(), Default::default()),
            file_scope: HashMap::default(),
            exported: HashMap::default(),
            members: HashMap::default(),
            callables: HashMap::default(),
            unique_type: HashMap::default(),
            unique_unit: HashMap::default(),
            unique_member: HashMap::default(),
            unique_extension: HashMap::default(),
            extension: HashMap::default(),
            declaring: HashMap::default(),
            owner: vec![None; nodes.len()],
            twin: HashMap::default(),
            package_of: Vec::new(),
            package_scope: HashMap::default(),
        };
        for (at, node) in nodes.iter().enumerate() {
            symbols.position.insert(node.id.as_str(), at as u32);
        }
        let mut first_declaration: HashMap<(u32, &str, Option<&str>), u32> = HashMap::default();
        for (at, node) in nodes.iter().enumerate() {
            if !node.kind.is_type() {
                continue;
            }
            match first_declaration.entry((node.file, node.name.as_str(), node.parent.as_deref())) {
                std::collections::hash_map::Entry::Occupied(first) => {
                    symbols.twin.insert(at as u32, *first.get());
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(at as u32);
                }
            }
        }

        let mut types: HashMap<&str, (u32, u32)> = HashMap::default();
        let mut units: HashMap<&str, (u32, u32)> = HashMap::default();
        let mut member_names: HashMap<&str, (u32, u32)> = HashMap::default();
        let mut extension_names: HashMap<&str, (u32, u32)> = HashMap::default();

        for (at, node) in nodes.iter().enumerate() {
            let at = at as u32;
            if node.kind == NodeKind::Module {
                continue;
            }
            if let Some(parent) = node.parent.as_deref()
                && let Some(owner) = symbols.position.get(parent).copied()
                && holds_members(&nodes[owner as usize], node)
            {
                let owner = symbols.twin.get(&owner).copied().unwrap_or(owner);
                symbols.members.entry((owner, node.name.as_str())).or_insert(at);
                if node.kind.is_unit() {
                    symbols.callables.entry((owner, node.name.as_str())).or_insert(at);
                }
                symbols.declaring.entry(node.name.as_str()).or_default().push(owner);
                let entry = member_names.entry(node.name.as_str()).or_insert((0, at));
                entry.0 += 1;
                if node.kind.is_unit() {
                    let entry = units.entry(node.name.as_str()).or_insert((0, at));
                    entry.0 += 1;
                }
                continue;
            }
            symbols.file_scope.entry((node.file, node.name.as_str())).or_insert(at);
            if node.modifiers.exported {
                symbols.exported.entry((node.file, node.name.as_str())).or_insert(at);
            }
            if node.kind.is_type() && !symbols.twin.contains_key(&at) {
                let entry = types.entry(node.name.as_str()).or_insert((0, at));
                entry.0 += 1;
            }
            if node.kind.is_unit() {
                let entry = units.entry(node.name.as_str()).or_insert((0, at));
                entry.0 += 1;
            }
        }

        for (at, node) in nodes.iter().enumerate() {
            let Some(receiver) = node
                .signature
                .as_ref()
                .and_then(|signature| signature.receiver.as_deref())
            else {
                continue;
            };
            let at = at as u32;
            let owner = base_type_name(receiver);
            symbols.extension.entry((owner, node.name.as_str())).or_insert(at);
            if types.contains_key(owner) {
                continue;
            }
            let entry = extension_names.entry(node.name.as_str()).or_insert((0, at));
            entry.0 += 1;
        }

        symbols.unique_type = unique(types);
        symbols.unique_unit = unique(units);
        symbols.unique_member = unique(member_names);
        symbols.unique_extension = unique(extension_names);
        symbols
    }

    fn owning_type(&self, unit: u32) -> Option<u32> {
        if let Some(owner) = self.owner[unit as usize] {
            return Some(owner);
        }
        let mut current = unit;
        for _ in 0..16 {
            let node = &self.nodes[current as usize];
            if node.kind.is_type() {
                return Some(current);
            }
            if let Some(owner) = self.owner[current as usize] {
                return Some(owner);
            }
            current = *self.position.get(node.parent.as_deref()?)?;
        }
        None
    }

    fn spoken_names(receiver: &str) -> Vec<String> {
        let clean = |held: &str| held.trim_start_matches(['$', '@', '_']).to_ascii_lowercase();
        let last = receiver.rsplit(['.', '>', ':']).next().unwrap_or(receiver);
        let mut found = vec![clean(last)];
        if last.contains('(') || receiver.contains('(') {
            let root = crate::names::root(receiver.trim_start_matches(['(', '*', '&']));
            let root = clean(root);
            if !root.is_empty() && !found.contains(&root) {
                found.push(root);
            }
        }
        found
    }

    fn spoken_as_owner(&self, receiver: &str, owner: u32) -> bool {
        let owner = self.nodes[owner as usize].name.to_ascii_lowercase();
        owner.len() >= 3
            && Self::spoken_names(receiver).iter().any(|spoken| spoken.contains(owner.trim_start_matches('i')))
    }

    fn spoken_within_owner(&self, receiver: &str, owner: u32) -> bool {
        let owner = self.nodes[owner as usize].name.to_ascii_lowercase();
        Self::spoken_names(receiver).iter().any(|spoken| spoken.len() >= 4 && !TOO_GENERIC_TO_NAME_A_TYPE.contains(&spoken.as_str()) && owner.ends_with(spoken.as_str()))
    }

    fn written_for(&self, receiver: Option<&str>, name: &str) -> bool {
        let Some(owners) = self.declaring.get(name) else {
            return false;
        };
        match receiver {
            Some(receiver) => owners.iter().any(|owner| self.spoken_as_owner(receiver, *owner)),
            None => true,
        }
    }

    fn member(&self, owner: u32, name: &str) -> Option<u32> {
        let owner = self.twin.get(&owner).copied().unwrap_or(owner);
        self.members.get(&(owner, name)).copied()
    }

    fn callable(&self, owner: u32, name: &str) -> Option<u32> {
        let owner = self.twin.get(&owner).copied().unwrap_or(owner);
        self.callables.get(&(owner, name)).copied().or_else(|| self.member(owner, name))
    }

    fn member_type(&self, owner: u32, name: &str) -> Option<&'a str> {
        if let Some(at) = self.member(owner, name) {
            let member = &self.nodes[at as usize];
            let held = member.type_annotation.as_deref().or_else(|| {
                member.signature.as_ref()?.return_type.as_deref().filter(|held| !held.is_empty())
            });
            if held.is_some() {
                return held;
            }
        }
        self.handed_in(owner, name)
    }

    fn handed_in(&self, owner: u32, name: &str) -> Option<&'a str> {
        for built in ["constructor", "__init__", "new"] {
            let Some(at) = self.member(owner, built) else { continue };
            let held = self.nodes[at as usize]
                .signature
                .as_ref()
                .and_then(|signature| {
                    signature.parameters.iter().find(|parameter| parameter.name == name)
                })
                .and_then(|parameter| parameter.type_annotation.as_deref());
            if held.is_some() {
                return held;
            }
        }
        None
    }
}

struct RuntimeMember {
    name: &'static str,
    owner: &'static str,
    returns: &'static str,
}

fn holds_members(owner: &IndexNode, held: &IndexNode) -> bool {
    owner.kind.is_type() || (owner.kind == NodeKind::Variable && held.kind.is_unit())
}

const fn member(name: &'static str, owner: &'static str, returns: &'static str) -> RuntimeMember {
    RuntimeMember { name, owner, returns }
}

static RUNTIME_MEMBERS: &[RuntimeMember] = &[
    member("charAt", "String", "String"),
    member("charCodeAt", "String", "Number"),
    member("codePointAt", "String", "Number"),
    member("concat", "Array", "Array"),
    member("copyWithin", "Array", "Array"),
    member("endsWith", "String", "Boolean"),
    member("fill", "Array", "Array"),
    member("filter", "Array", "Array"),
    member("findLast", "Array", ""),
    member("findLastIndex", "Array", "Number"),
    member("flat", "Array", "Array"),
    member("flatMap", "Array", "Array"),
    member("lastIndexOf", "Array", "Number"),
    member("localeCompare", "String", "Number"),
    member("map", "Array", "Array"),
    member("matchAll", "String", "Array"),
    member("normalize", "String", "String"),
    member("padEnd", "String", "String"),
    member("padStart", "String", "String"),
    member("pop", "Array", ""),
    member("push", "Array", "Number"),
    member("repeat", "String", "String"),
    member("replaceAll", "String", "String"),
    member("reverse", "Array", "Array"),
    member("shift", "Array", ""),
    member("slice", "", ""),
    member("sort", "Array", "Array"),
    member("splice", "Array", "Array"),
    member("split", "String", "Array"),
    member("startsWith", "String", "Boolean"),
    member("substr", "String", "String"),
    member("substring", "String", "String"),
    member("toLocaleLowerCase", "String", "String"),
    member("toLocaleUpperCase", "String", "String"),
    member("toLowerCase", "String", "String"),
    member("toUpperCase", "String", "String"),
    member("trim", "String", "String"),
    member("trimEnd", "String", "String"),
    member("trimStart", "String", "String"),
    member("unshift", "Array", "Number"),
];

fn runtime_member(name: &str) -> Option<&'static RuntimeMember> {
    RUNTIME_MEMBERS
        .binary_search_by(|entry| entry.name.cmp(name))
        .ok()
        .map(|at| &RUNTIME_MEMBERS[at])
}

pub(crate) fn is_runtime_member(name: &str) -> bool {
    runtime_member(name).is_some()
}

fn sole_type_argument(annotation: &str) -> Option<&str> {
    let open = annotation.find(['<', '['])?;
    let close = annotation.rfind(['>', ']'])?;
    if close <= open + 1 {
        return None;
    }
    let inside = annotation[open + 1..close].trim();
    let mut depth = 0usize;
    for (at, byte) in inside.char_indices() {
        match byte {
            '<' | '[' | '(' => depth += 1,
            '>' | ']' | ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => return None,
            _ => {
                let _ = at;
            }
        }
    }
    (!inside.is_empty()).then_some(inside)
}

static COLUMN_TYPES: &[&str] = &[
    "bigint", "binary", "boolean", "date", "datetime", "decimal", "float", "inet", "integer", "json", "jsonb", "string",
    "text", "timestamp", "uuid",
];

static GENERATES_MEMBERS: &[&str] = &[
    "alias_method", "attr_accessor", "attr_reader", "attr_writer", "attribute", "belongs_to", "cattr_accessor",
    "class_attribute", "delegate", "has_and_belongs_to_many", "has_attached_file", "has_many", "has_many_attached",
    "has_one", "has_one_attached", "mattr_accessor", "scope", "store_accessor",
];

static HOLDERS: &[&str] = &["Lazy", "Provider"];
static WRAPS_ITS_LAST_ARGUMENT: &[&str] = &[
    "Arc", "Box", "Cell", "Cow", "Mutex", "MutexGuard", "Option", "Rc", "Ref", "RefCell", "RefMut", "RwLock",
    "RwLockReadGuard", "RwLockWriteGuard",
];
static WRAPS_ITS_FIRST_ARGUMENT: &[&str] = &["Result"];
const OUTER_TYPES_AT_MOST: usize = 3;
static HOLDER_ACCESSORS: &[&str] = &["get", "value"];
static CALLED_AS_A_FUNCTION: &[&str] = &["__call__", "callAsFunction", "invoke"];

fn base_type_name(annotation: &str) -> &str {
    let mut annotation = annotation.trim();
    loop {
        let stripped = annotation.trim_start_matches(['&', '*']).trim_start();
        if let Some(rest) = stripped.strip_prefix('\'') {
            annotation = rest.trim_start_matches(|letter: char| letter.is_alphanumeric() || letter == '_').trim_start();
            continue;
        }
        if let Some(rest) = stripped.strip_prefix("mut ").or_else(|| stripped.strip_prefix("dyn ")).or_else(|| stripped.strip_prefix("impl ")) {
            annotation = rest.trim_start();
            continue;
        }
        if stripped.len() == annotation.len() {
            break;
        }
        annotation = stripped;
    }
    let end = annotation
        .find(['<', '[', '(', ' ', '|', '?', ';'])
        .unwrap_or(annotation.len());
    let name = annotation[..end].trim().trim_end_matches('.');
    if annotation[end..].starts_with('[') {
        return "Array";
    }
    let name = name.rsplit("::").next().unwrap_or(name);
    match name {
        "string" => "String",
        "number" => "Number",
        "boolean" => "Boolean",
        "symbol" => "Symbol",
        "bigint" => "BigInt",
        "str" => "String",
        "object" => "Object",
        other => other,
    }
}

fn first_type_argument(annotation: &str) -> Option<&str> {
    let arguments = type_argument_span(annotation)?;
    top_level_arguments(arguments).into_iter().next()
}

fn last_type_argument(annotation: &str) -> Option<&str> {
    let arguments = type_argument_span(annotation)?;
    top_level_arguments(arguments).into_iter().next_back()
}

fn type_argument_span(annotation: &str) -> Option<&str> {
    let open = annotation.find(['<', '['])?;
    let close = annotation.rfind(['>', ']'])?;
    (close > open + 1).then(|| annotation[open + 1..close].trim())
}

fn top_level_arguments(inside: &str) -> Vec<&str> {
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut found = Vec::new();
    for (at, byte) in inside.char_indices() {
        match byte {
            '<' | '[' | '(' => depth += 1,
            '>' | ']' | ')' => depth -= 1,
            ',' if depth == 0 => {
                found.push(inside[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
    }
    let tail = inside[start..].trim();
    if !tail.is_empty() {
        found.push(tail);
    }
    found.into_iter().filter(|argument| !argument.is_empty()).collect()
}

fn wrapped_type_argument(annotation: &str) -> Option<&str> {
    let base = base_type_name(annotation);
    if HOLDERS.contains(&base) || WRAPS_ITS_LAST_ARGUMENT.contains(&base) {
        return last_type_argument(annotation);
    }
    if WRAPS_ITS_FIRST_ARGUMENT.contains(&base) {
        return first_type_argument(annotation);
    }
    None
}

fn qualifier_of(annotation: &str) -> Option<&str> {
    let trimmed = annotation.trim().trim_start_matches(['&', '*']);
    let end = trimmed
        .find(['<', '[', '(', ' ', '|', '?', ';'])
        .unwrap_or(trimmed.len());
    trimmed[..end].split_once('.').map(|(head, _)| head)
}

fn segments(path: &str) -> impl Iterator<Item = &str> {
    indexed_segments(path).map(|(name, _)| name)
}

fn indexed_segments(path: &str) -> impl Iterator<Item = (&str, bool)> {
    let mut parts: Vec<&str> = Vec::new();
    let mut depth = 0usize;
    let mut begin = 0usize;
    for (at, letter) in path.char_indices() {
        match letter {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            '.' if depth == 0 => {
                parts.push(&path[begin..at]);
                begin = at + 1;
            }
            _ => {}
        }
    }
    parts.push(&path[begin..]);
    parts.into_iter().map(|segment| {
        let end = segment.find(['[', '(', '!', '?']).unwrap_or(segment.len());
        let indexed = end > 0 && segment[end..].starts_with('[');
        (segment[..end].trim_end_matches('&'), indexed)
    })
}

fn indexed_element(annotation: &str) -> Option<&str> {
    let held = annotation.trim();
    if let Some(element) = held.strip_suffix("[]") {
        return Some(element.trim().trim_start_matches('(').trim_end_matches(')'));
    }
    let base = base_type_name(held);
    (INDEXED_COLLECTIONS.contains(&base) || base == "Array").then(|| last_type_argument(held)).flatten()
}

static INDEXED_COLLECTIONS: &[&str] = &["Record", "ReadonlyArray", "Map", "WeakMap", "ReadonlyMap", "Dictionary", "List", "Vec", "HashMap", "BTreeMap"];

impl<'a> Bindings<'a> {
    fn explicit(&self, unit: &str, file: u32, name: &'a str) -> Option<&'a str> {
        self.locals
            .get(&(unit, name))
            .or_else(|| self.file_locals.get(&(file, name)))
            .copied()
    }

    fn guessed(&self, unit: &str, file: u32, name: &'a str) -> Option<&'a str> {
        self.guessed
            .get(&(unit, name))
            .or_else(|| self.file_guessed.get(&(file, name)))
            .copied()
    }

    fn annotation(&self, unit: &str, file: u32, name: &'a str) -> Option<&'a str> {
        self.explicit(unit, file, name).or_else(|| self.guessed(unit, file, name))
    }
}

thread_local! {
    static BEING_TRACED: std::cell::RefCell<Vec<(u32, String)>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct Resolver<'a> {
    symbols: Symbols<'a>,
    bindings: Bindings<'a>,
    runtime: Vec<&'static str>,
    visible: crate::visibility::Visibility,
    types_named: HashMap<&'a str, Vec<u32>>,
    languages: &'a [&'a str],
    files: &'a [String],
    by_path: &'a HashMap<&'a str, u32>,
    aliases: &'a crate::alias::Aliases,
    inherits: std::sync::OnceLock<HashMap<u32, Vec<u32>>>,
}

impl<'a> Resolver<'a> {
    fn named_type(&self, file: u32, annotation: &str) -> Option<u32> {
        let name = base_type_name(annotation);
        if name.is_empty() {
            return None;
        }
        self.bindings
            .imported
            .get(&(file, name))
            .copied()
            .or_else(|| self.symbols.in_scope(file, name))
            .or_else(|| self.symbols.unique_type.get(name).copied())
            .or_else(|| self.seen_from(file, name))
            .filter(|found| self.symbols.nodes[*found as usize].kind.is_type())
    }

    fn handed_to_an_enclosing_type(&self, owner: u32, name: &str, bare: &str) -> Option<&'a str> {
        let mut holder = owner;
        for _ in 0..OUTER_TYPES_AT_MOST {
            let held = self.symbols.nodes[holder as usize]
                .signature
                .as_ref()
                .and_then(|signature| signature.parameters.iter().find(|p| p.name == name || p.name == bare))
                .and_then(|parameter| parameter.type_annotation.as_deref());
            if held.is_some() {
                return held;
            }
            if self.symbols.member(holder, name).or_else(|| self.symbols.member(holder, bare)).is_some() {
                return None;
            }
            let outer = self.symbols.nodes[holder as usize].parent.as_deref()?;
            let outer = self.symbols.position.get(outer).copied()?;
            holder = self.symbols.owning_type(outer).filter(|found| *found != holder)?;
        }
        None
    }

    fn stood_for(&self, unit: u32, name: &str) -> Option<&'a str> {
        let mut current = unit;
        for _ in 0..8 {
            let node = &self.symbols.nodes[current as usize];
            if let Some(expression) = self.bindings.stands_for.get(&(node.id.as_str(), name)) {
                return Some(expression);
            }
            if !node.id.contains(":callback:") {
                return None;
            }
            current = self.symbols.position.get(node.parent.as_deref()?).copied()?;
        }
        None
    }

    fn member_within_reach(&self, owner: u32, name: &str, bare: &str) -> Option<u32> {
        let mut holder = owner;
        for _ in 0..OUTER_TYPES_AT_MOST {
            if let Some(found) = self.symbols.member(holder, name).or_else(|| self.symbols.member(holder, bare)) {
                return Some(found);
            }
            let outer = self.symbols.nodes[holder as usize].parent.as_deref()?;
            let outer = self.symbols.position.get(outer).copied()?;
            holder = self.symbols.owning_type(outer).filter(|found| *found != holder)?;
        }
        None
    }

    fn seen_from(&self, file: u32, name: &str) -> Option<u32> {
        let mut seen = self
            .types_named
            .get(name)?
            .iter()
            .copied()
            .filter(|found| self.visible.can_see(file, self.symbols.nodes[*found as usize].file));
        match (seen.next(), seen.next()) {
            (Some(only), None) => Some(only),
            _ => None,
        }
    }

    fn ruby_type(&self, file: u32, name: &str) -> Option<u32> {
        let (namespace, leaf) = match name.rsplit_once("::") {
            Some((qualifier, leaf)) => (Some(qualifier.rsplit("::").next().unwrap_or(qualifier)), leaf),
            None => (None, name),
        };
        let written_in_ruby: Vec<u32> = self
            .types_named
            .get(leaf)
            .into_iter()
            .flatten()
            .copied()
            .filter(|found| self.languages.get(self.symbols.nodes[*found as usize].file as usize) == Some(&"ruby"))
            .collect();
        let narrow = |candidates: Vec<u32>, keep: &dyn Fn(u32) -> bool| -> Vec<u32> {
            let kept: Vec<u32> = candidates.iter().copied().filter(|found| keep(*found)).collect();
            if kept.is_empty() { candidates } else { kept }
        };
        if let Some(namespace) = namespace {
            let directory = format!("{}/", snake_case(namespace));
            let within: Vec<u32> = written_in_ruby
                .into_iter()
                .filter(|found| self.files[self.symbols.nodes[*found as usize].file as usize].contains(directory.as_str()))
                .collect();
            return match within.as_slice() {
                [only] => Some(*only),
                _ => None,
            };
        }
        let candidates = narrow(written_in_ruby, &|found| {
            let path = self.files[self.symbols.nodes[found as usize].file as usize].as_str();
            !crate::paths::is_test(path) && !path.starts_with("db/") && !path.contains("/migrate/")
        });
        let mut candidates = narrow(candidates, &|found| {
            let nested = self.symbols.nodes[found as usize]
                .parent
                .as_deref()
                .and_then(|parent| self.symbols.position.get(parent))
                .is_some_and(|parent| self.symbols.nodes[*parent as usize].kind.is_type());
            !nested || self.symbols.nodes[found as usize].file == file
        });
        if candidates.len() > 1 {
            let here: Vec<&str> = self.files[file as usize].split('/').collect();
            let shared = |found: u32| {
                let path = self.files[self.symbols.nodes[found as usize].file as usize].as_str();
                let mut parts: Vec<&str> = path.split('/').collect();
                parts.pop();
                parts.iter().skip(2).filter(|part| here.contains(part)).count()
            };
            let best = candidates.iter().map(|found| shared(*found)).max().unwrap_or(0);
            if best > 0 {
                candidates = narrow(candidates, &|found| shared(found) == best);
            } else {
                candidates = narrow(candidates, &|found| {
                    let path = self.files[self.symbols.nodes[found as usize].file as usize].as_str();
                    let mut parts: Vec<&str> = path.split('/').collect();
                    parts.pop();
                    parts.iter().skip(2).all(|part| *part == "concerns")
                });
            }
        }
        match candidates.as_slice() {
            [only] => Some(*only),
            _ => None,
        }
    }

    fn annotated(&self, file: u32, annotation: &'a str) -> Origin<'a> {
        if let Some(held) = wrapped_type_argument(annotation) {
            return self.annotated(file, held);
        }
        if let Some(found) = self.named_type(file, annotation) {
            return Origin::Declared(found);
        }
        let name = base_type_name(annotation);
        if self.runtime.binary_search(&name).is_ok() {
            return Origin::Runtime(name);
        }
        if let Some(standard) = externals::standard_type(self.languages.get(file as usize).copied().unwrap_or(""), name) {
            return Origin::Runtime(standard);
        }
        if let Some(qualifier) = qualifier_of(annotation) {
            if let Some(held) = self.bindings.module_files.get(&(file, qualifier))
                && let Some(found) = self.symbols.in_scope(*held, name.rsplit('.').next().unwrap_or(name))
                && self.symbols.nodes[found as usize].kind.is_type()
            {
                return Origin::Declared(found);
            }
            if let Some(specifier) = self.bindings.modules.get(&(file, qualifier)) {
                return Origin::Package(specifier);
            }
        }
        if let Some(specifier) = self.bindings.modules.get(&(file, name)) {
            return Origin::Package(specifier);
        }
        if let Some(opened) = self.bindings.opened.get(&file) {
            let mut claiming =
                opened.iter().copied().filter(|specifier| crate::service_catalog::a_client_of(specifier, name));
            if let (Some(only), None) = (claiming.next(), claiming.next()) {
                return Origin::Package(only);
            }
        }
        Origin::Unknown
    }

    fn root(&self, unit: u32, file: u32, name: &'a str) -> Origin<'a> {
        if let Some((_, leaf)) = name.rsplit_once("::")
            && leaf.starts_with(char::is_uppercase)
            && let Some(found) = self.named_type(file, leaf)
        {
            return Origin::Declared(found);
        }
        let bare = name.strip_prefix('$').unwrap_or(name);
        if bare == "this" || bare == "self" || bare == "Self" {
            return match self.symbols.owning_type(unit) {
                Some(owner) => Origin::Declared(owner),
                None => Origin::Unknown,
            };
        }
        let chain = self.enclosing(unit);
        for at in chain.iter().copied() {
            let level = &self.symbols.nodes[at as usize];
            let Some(signature) = level.signature.as_ref() else { continue };
            let Some(parameter) = signature.parameters.iter().find(|p| p.name == name || p.name == bare) else {
                continue;
            };
            return match parameter.type_annotation.as_deref() {
                Some(annotation) if typing::names_itself(annotation) => match self.symbols.owning_type(at) {
                    Some(owner) => Origin::Declared(owner),
                    None => Origin::Indirect,
                },
                Some(annotation) => match self.annotated(file, annotation) {
                    Origin::Unknown => Origin::Indirect,
                    known => known,
                },
                None => match self.element_binding(at, file, name, true) {
                    Origin::Unknown => Origin::Indirect,
                    known => known,
                },
            };
        }
        if let Some(expression) = self.stood_for(unit, name) {
            let asked = (unit, name.to_string());
            if BEING_TRACED.with(|tracing| tracing.borrow().contains(&asked)) {
                return Origin::Unknown;
            }
            BEING_TRACED.with(|tracing| tracing.borrow_mut().push(asked));
            let found = self.origin(unit, file, expression);
            BEING_TRACED.with(|tracing| tracing.borrow_mut().pop());
            return match found {
                Origin::Declared(called)
                    if self.languages.get(file as usize) == Some(&"ruby") && self.symbols.nodes[called as usize].kind.is_unit() =>
                {
                    self.returned_by(called)
                }
                other => other,
            };
        }
        for at in chain.iter().copied() {
            let level = &self.symbols.nodes[at as usize];
            if let Some(annotation) = self
                .bindings
                .explicit(&level.id, file, name)
                .or_else(|| self.bindings.explicit(&level.id, file, bare))
            {
                return match self.annotated(file, annotation) {
                    Origin::Unknown => self.from_a_call(unit, file, name),
                    known => known,
                };
            }
            match self.element_binding(at, file, name, false) {
                Origin::Unknown => {}
                known => return known,
            }
        }
        match self.from_a_call(unit, file, name) {
            Origin::Unknown => {}
            known => return known,
        }
        for at in chain.iter().copied() {
            let level = &self.symbols.nodes[at as usize];
            if let Some(annotation) = self
                .bindings
                .guessed(&level.id, file, name)
                .or_else(|| self.bindings.guessed(&level.id, file, bare))
            {
                return self.annotated(file, annotation);
            }
        }
        if let Some(owner) = self.symbols.owning_type(unit)
            && let Some(annotation) = self.handed_to_an_enclosing_type(owner, name, bare)
        {
            return match self.annotated(file, annotation) {
                Origin::Unknown => Origin::Indirect,
                known => known,
            };
        }
        if let Some(owner) = self.symbols.owning_type(unit)
            && let Some(member) = self.member_within_reach(owner, name, bare)
        {
            let held = &self.symbols.nodes[member as usize];
            if !held.kind.is_type()
                && let Some(annotation) = held.type_annotation.as_deref()
            {
                match self.annotated(held.file, annotation) {
                    Origin::Declared(found) => return Origin::Declared(found),
                    Origin::Package(specifier) => return Origin::Package(specifier),
                    _ => {}
                }
            }
            return Origin::Declared(member);
        }
        if let Some(found) = self
            .bindings
            .imported
            .get(&(file, name))
            .copied()
            .or_else(|| self.symbols.in_scope(file, name))
        {
            let node = &self.symbols.nodes[found as usize];
            if node.kind.is_type() || node.kind.is_unit() {
                return Origin::Declared(found);
            }
            if let Some(annotation) = node.type_annotation.as_deref() {
                return self.annotated(node.file, annotation);
            }
        }
        if let Some(found) = self.bindings.module_files.get(&(file, name)) {
            return Origin::Module(*found);
        }
        if let Some(specifier) = self.bindings.modules.get(&(file, name)) {
            return Origin::Package(specifier);
        }
        if self.runtime.binary_search(&name).is_ok() {
            return Origin::Runtime(name);
        }
        if self.languages.get(file as usize) == Some(&"ruby")
            && name.starts_with(char::is_uppercase)
            && let Some(only) = self.ruby_type(file, name)
        {
            return Origin::Declared(only);
        }
        if name.starts_with(char::is_uppercase)
            && crate::language_tables::names_modules_globally(self.languages.get(file as usize).copied().unwrap_or(""))
            && let Some(found) = self.global_module(file, name)
        {
            return Origin::Declared(found);
        }
        Origin::Unknown
    }

    fn global_module(&self, file: u32, name: &str) -> Option<u32> {
        let language = self.languages.get(file as usize)?;
        let held: Vec<u32> = self
            .types_named
            .get(name)?
            .iter()
            .copied()
            .filter(|found| self.languages.get(self.symbols.nodes[*found as usize].file as usize) == Some(language))
            .collect();
        let exact: Vec<u32> = held.iter().copied().filter(|found| self.symbols.nodes[*found as usize].name == name).collect();
        match (exact.as_slice(), held.as_slice()) {
            ([only], _) | ([], [only]) => Some(*only),
            _ => None,
        }
    }

    fn returned(&self, member: &str) -> Origin<'a> {
        match runtime_member(member) {
            Some(entry) if !entry.returns.is_empty() => Origin::Runtime(entry.returns),
            _ => Origin::Unknown,
        }
    }

    fn held(&self, unit: u32, file: u32, name: &'a str) -> Option<&'a str> {
        let chain = self.enclosing(unit);
        for at in chain.iter().copied() {
            let holder = &self.symbols.nodes[at as usize];
            if let Some(signature) = holder.signature.as_ref()
                && let Some(parameter) = signature.parameters.iter().find(|p| p.name == name)
            {
                match parameter.type_annotation.as_deref() {
                    Some(annotation) => return Some(annotation),
                    None => break,
                }
            }
            if let Some(annotation) = self.bindings.annotation(&holder.id, file, name) {
                return Some(annotation);
            }
        }
        let owner = self.symbols.owning_type(unit)?;
        if let Some(signature) = self.symbols.nodes[owner as usize].signature.as_ref()
            && let Some(parameter) = signature.parameters.iter().find(|p| p.name == name)
            && let Some(annotation) = parameter.type_annotation.as_deref()
        {
            return Some(annotation);
        }
        self.symbols.member_type(owner, name)
    }
}

fn declares_it(specifier: &str, path: &str) -> bool {
    let Some((qualifier, _)) = specifier.rsplit_once('.') else {
        return false;
    };
    let folder = qualifier.replace('.', "/");
    !folder.is_empty() && path.contains(&folder)
}

fn strip_extension(specifier: &str) -> &str {
    for extension in [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"] {
        if let Some(stripped) = specifier.strip_suffix(extension) {
            return stripped;
        }
    }
    specifier
}

fn dotted_module(files: &HashMap<&str, u32>, from: &str, specifier: &str) -> Option<u32> {
    let depth = specifier.chars().take_while(|character| *character == '.').count();
    let rest = specifier[depth..].replace('.', "/");
    let mut folder = directory_of(from);
    for _ in 1..depth {
        folder = directory_of(folder);
    }
    let base = match (rest.is_empty(), folder.is_empty()) {
        (true, _) => folder.to_string(),
        (false, true) => rest,
        (false, false) => format!("{folder}/{rest}"),
    };
    for candidate in [format!("{base}.py"), format!("{base}/__init__.py")] {
        if let Some(found) = files.get(candidate.as_str()) {
            return Some(*found);
        }
    }
    None
}

const PYTHON_ROOTS_AT_MOST: usize = 6;

static INTERNAL_ROOTS: &[&str] = &["crate", "self", "super"];

fn module_key(text: &str) -> String {
    let trimmed = text.trim().trim_matches(['*', ';', ' ']);
    let stem = match trimmed.rsplit_once('.') {
        Some((stem, extension)) if SOURCE_EXTENSIONS.binary_search(&extension).is_ok() => stem,
        _ => trimmed,
    };
    let stem = stem
        .strip_suffix("/index")
        .or_else(|| stem.strip_suffix("/mod"))
        .unwrap_or(stem);
    let key = stem.replace("::", "/").replace(['.', '\\'], "/").replace('-', "_").to_lowercase();
    key.trim_matches('/').to_string()
}

fn family(language: &str) -> &str {
    match language {
        "cpp" => "c",
        "javascript" | "svelte" | "vue" => "typescript",
        other => other,
    }
}

struct Modules {
    declaring: HashMap<String, Option<u32>>,
    condensed: HashMap<String, Option<u32>>,
    holding: HashSet<String>,
    rooted: HashSet<String>,
    packaged: HashMap<String, Vec<u32>>,
}

impl Modules {
    fn build(files: &[String], languages: &[&str]) -> Modules {
        let mut declaring: HashMap<String, Option<u32>> = HashMap::default();
        let mut condensed: HashMap<String, Option<u32>> = HashMap::default();
        let mut holding = HashSet::default();
        let mut rooted = HashSet::default();
        let mut packaged: HashMap<String, Vec<u32>> = HashMap::default();
        let mut walked: HashSet<(&str, String)> = HashSet::default();
        for (at, path) in files.iter().enumerate() {
            let language = family(languages[at]);
            packaged
                .entry(format!("{language}\u{1}{}", directory_of(path)))
                .or_default()
                .push(at as u32);
            let key = module_key(path);
            let plain = without_containers(&key);
            if let Some((root, _)) = path.split_once('/') {
                rooted.insert(format!("{language}\u{1}{}", root.to_ascii_lowercase()));
            }
            for (key, found) in [
                (Some(key.as_str()), &mut declaring),
                (plain.as_deref(), &mut condensed),
            ] {
                let Some(key) = key else { continue };
                let mut tail = key;
                loop {
                    let scoped = format!("{language}\u{1}{tail}");
                    match found.get_mut(&scoped) {
                        Some(known) => *known = None,
                        None => {
                            found.insert(scoped, Some(at as u32));
                        }
                    }
                    match tail.find('/') {
                        Some(cut) => tail = &tail[cut + 1..],
                        None => break,
                    }
                }
                let mut folder = key.rsplit_once('/').map(|(folder, _)| folder);
                while let Some(tail) = folder {
                    if !walked.insert((language, tail.to_string())) {
                        break;
                    }
                    for at in tail.match_indices('/').map(|(at, _)| at + 1).chain([0]) {
                        holding.insert(format!("{language}\u{1}{}", &tail[at..]));
                    }
                    folder = tail.rsplit_once('/').map(|(folder, _)| folder);
                }
            }
        }
        Modules { declaring, condensed, holding, rooted, packaged }
    }

    fn declared(&self, language: &str, specifier: &str) -> Option<u32> {
        let key = module_path(specifier)?;
        let language = family(language);
        let owner = key.rsplit_once('/').map(|(owner, _)| owner).unwrap_or_default();
        for names in [&self.declaring, &self.condensed] {
            if key.contains('/')
                && let Some(found) = names.get(&format!("{language}\u{1}{key}"))
            {
                return *found;
            }
            if owner.contains('/')
                && let Some(found) = names.get(&format!("{language}\u{1}{owner}"))
            {
                return *found;
            }
        }
        None
    }

    fn package_files(&self, language: &str, folder: &str) -> Option<&[u32]> {
        self.packaged
            .get(&format!("{}\u{1}{folder}", family(language)))
            .map(Vec::as_slice)
    }

    fn held(&self, language: &str, specifier: &str) -> bool {
        let Some(key) = module_path(specifier) else { return false };
        let language = family(language);
        if !key.contains('/') {
            return self.rooted.contains(&format!("{language}\u{1}{key}"));
        }
        let mut tail = key.as_str();
        loop {
            let mut owner = tail;
            while owner.contains('/') {
                if self.holding.contains(&format!("{language}\u{1}{owner}")) {
                    return true;
                }
                owner = owner.rsplit_once('/').map(|(owner, _)| owner).unwrap_or_default();
            }
            match tail.find('/') {
                Some(cut) => tail = &tail[cut + 1..],
                None => return false,
            }
        }
    }
}

static CONTAINER_SEGMENTS: &[&str] = &["java", "kotlin", "lib", "main", "src"];

fn without_containers(key: &str) -> Option<String> {
    let kept: Vec<&str> = key
        .split('/')
        .filter(|segment| !CONTAINER_SEGMENTS.contains(segment))
        .collect();
    (kept.len() < key.split('/').count() && !kept.is_empty()).then(|| kept.join("/"))
}

fn module_path(specifier: &str) -> Option<String> {
    let trimmed = specifier.trim();
    if trimmed.is_empty() || trimmed.starts_with('.') || trimmed.starts_with('/') {
        return None;
    }
    let key = module_key(trimmed);
    let mut rest = key.as_str();
    while let Some(trimmed) = INTERNAL_ROOTS
        .iter()
        .find_map(|root| rest.strip_prefix(root)?.strip_prefix('/'))
    {
        rest = trimmed;
    }
    (!rest.is_empty()).then(|| rest.to_string())
}

fn file_index(files: &HashMap<&str, u32>, from: &str, specifier: &str) -> Option<u32> {
    if !specifier.starts_with('.') {
        return None;
    }
    if !specifier.contains('/')
        && let Some(found) = dotted_module(files, from, specifier)
    {
        return Some(found);
    }
    module_file(files, &normalize(&format!("{}/{}", directory_of(from), specifier)))
}

fn namespaces(index: &Index) -> HashMap<String, Vec<u32>> {
    let mut declared: HashMap<String, Vec<u32>> = HashMap::default();
    for (at, namespace) in index.namespaces.iter().enumerate() {
        if namespace.is_empty() {
            continue;
        }
        declared
            .entry(format!("{}\u{1}{}", family(index.languages[at]), module_key(namespace)))
            .or_default()
            .push(at as u32);
    }
    declared
}

fn namespace_is_declared(declared: &HashMap<String, Vec<u32>>, language: &str, specifier: &str) -> bool {
    let Some(key) = module_path(specifier) else { return false };
    declared.contains_key(&format!("{}\u{1}{key}", family(language)))
}

fn namespace_members(
    declared: &HashMap<String, Vec<u32>>,
    named: &HashSet<(u32, String)>,
    declared_by: &HashMap<String, Vec<u32>>,
    referenced: Option<&HashSet<String>>,
    language: &str,
    specifier: &str,
) -> Vec<u32> {
    let Some(key) = module_path(specifier) else { return Vec::new() };
    let language = family(language);
    if let Some(members) = declared.get(&format!("{language}\u{1}{key}")) {
        let held: HashSet<u32> = members.iter().copied().collect();
        let mut used: Vec<u32> = referenced
            .into_iter()
            .flatten()
            .filter_map(|name| declared_by.get(name))
            .flatten()
            .copied()
            .filter(|found| held.contains(found))
            .collect();
        used.sort();
        used.dedup();
        return used;
    }
    let Some((owner, leaf)) = key.rsplit_once('/') else { return Vec::new() };
    if let Some(members) = declared.get(&format!("{language}\u{1}{owner}")) {
        return members
            .iter()
            .copied()
            .filter(|found| named.contains(&(*found, leaf.to_string())))
            .collect();
    }
    let Some((namespace, holder)) = owner.rsplit_once('/') else { return Vec::new() };
    declared
        .get(&format!("{language}\u{1}{namespace}"))
        .into_iter()
        .flatten()
        .copied()
        .filter(|found| named.contains(&(*found, holder.to_string())))
        .collect()
}

fn package_members(
    aliases: &crate::alias::Aliases,
    modules: &Modules,
    fact: &ImportFact,
    from: &str,
    language: &str,
) -> Vec<u32> {
    let Some(members) = aliases
        .expand(from, &fact.specifier)
        .iter()
        .find_map(|folder| modules.package_files(language, folder))
    else {
        return Vec::new();
    };
    members.to_vec()
}

fn module_or_owner(files: &HashMap<&str, u32>, specifier: &str, path: &str) -> Option<u32> {
    module_file(files, path).or_else(|| {
        if !specifier.contains(['/', '.']) && !specifier.contains("::") {
            return None;
        }
        let (owner, _) = path.rsplit_once('/')?;
        module_file(files, owner)
    })
}

fn relative_module(from: &str, specifier: &str) -> Option<String> {
    let mut rest = specifier.replace("::", "/");
    let mut folder = own_module(from);
    loop {
        let Some((step, tail)) = rest.split_once('/').or(Some((rest.as_str(), ""))) else {
            return None;
        };
        match step {
            "self" => {}
            "super" => folder = directory_of(&folder).to_string(),
            _ => break,
        }
        rest = tail.to_string();
        if rest.is_empty() {
            return None;
        }
    }
    (specifier.starts_with("self::") || specifier.starts_with("super::"))
        .then(|| join(&folder, &rest))
}

fn own_module(from: &str) -> String {
    let folder = directory_of(from);
    let basename = crate::paths::basename(from);
    let stem = basename.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(basename);
    match stem {
        "mod" | "lib" | "main" => folder.to_string(),
        _ => join(folder, stem),
    }
}

fn qualified_module_target(
    by_path: &HashMap<&str, u32>,
    aliases: &crate::alias::Aliases,
    files: &[String],
    languages: &[&str],
    file: u32,
    name: &str,
) -> Option<u32> {
    let _ = languages;
    let from = files.get(file as usize)?.as_str();
    if name == "super" {
        let folder = directory_of(&own_module(from)).to_string();
        return module_or_owner(by_path, name, &folder);
    }
    if let Some(path) = relative_module(from, name) {
        return module_or_owner(by_path, name, &path);
    }
    if name == "crate" || name.starts_with("crate::") {
        return aliases
            .expand(from, name)
            .iter()
            .find_map(|candidate| module_or_owner(by_path, name, candidate));
    }
    None
}

fn without_suffix(path: &str) -> &str {
    let after = path.rfind('/').map_or(0, |slash| slash + 1);
    match path[after..].rfind('.') {
        Some(dot) => &path[..after + dot],
        None => path,
    }
}

struct Beneath {
    held: HashMap<String, Option<u32>>,
}

fn noted(held: &mut HashMap<String, Option<u32>>, key: &str, at: u32) {
    match held.get_mut(key) {
        None => {
            held.insert(key.to_string(), Some(at));
        }
        Some(found) if *found != Some(at) => *found = None,
        Some(_) => {}
    }
}

impl Beneath {
    fn over(files: &[String]) -> Beneath {
        let mut held: HashMap<String, Option<u32>> = HashMap::default();
        for (at, path) in files.iter().enumerate() {
            let at = at as u32;
            let base = without_suffix(path);
            noted(&mut held, base, at);
            for (slash, _) in base.match_indices('/') {
                noted(&mut held, &base[slash + 1..], at);
            }
            if let Some(package) = base.strip_suffix("/__init__") {
                for (slash, _) in package.match_indices('/') {
                    noted(&mut held, &package[slash + 1..], at);
                }
            }
        }
        Beneath { held }
    }

    fn find(&self, dotted: &str) -> Option<u32> {
        self.held.get(&dotted.replace('.', "/")).copied().flatten()
    }
}

fn module_file(files: &HashMap<&str, u32>, path: &str) -> Option<u32> {
    if let Some(found) = files.get(path) {
        return Some(*found);
    }
    let base = strip_extension(path);
    for candidate in [
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}.mts"),
        format!("{base}.cts"),
        format!("{base}.mjs"),
        format!("{base}.cjs"),
        format!("{base}.svelte"),
        format!("{base}.vue"),
        format!("{base}.py"),
        format!("{base}/__init__.py"),
        format!("{base}.rs"),
        format!("{base}/mod.rs"),
        format!("{base}/lib.rs"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.js"),
        format!("{base}/index.jsx"),
        format!("{base}/index.svelte"),
    ] {
        if let Some(found) = files.get(candidate.as_str()) {
            return Some(*found);
        }
    }
    None
}

fn declare_external(
    known: &mut HashMap<String, IndexNode>,
    space: &str,
    origin: &str,
    name: &str,
) -> String {
    let id = format!("{space}:{origin}:{name}");
    known
        .entry(id.clone())
        .or_insert_with(|| external_node(&id, name, origin));
    id
}

fn external_node(id: &str, name: &str, origin: &str) -> IndexNode {
    IndexNode {
        id: id.to_string(),
        name: name.to_string(),
        kind: NodeKind::External,
        file: u32::MAX,
        span: Span { line: 0, column: 0, end_line: 0, end_column: 0 },
        parent: None,
        signature: None,
        modifiers: Modifiers::default(),
        decorators: Vec::new(),
        type_annotation: Some(origin.to_string()),
        documentation: None,
        project: None,
        callback_of: None,
        registration_label: None,
    }
}

enum Resolved {
    NoCaller,
    Dynamic,
    Indirect,
    Library,
    Unresolved(String, bool),
    Edge(String, EdgeKind),
    Guessed(String, EdgeKind),
    Implemented(Vec<String>, EdgeKind),
    External {
        space: &'static str,
        owner: String,
        member: String,
        kind: EdgeKind,
        origin: Option<(String, String)>,
    },
}

fn is_a_bare_name(held: &str) -> bool {
    held.starts_with(|first: char| first.is_alphabetic() || first == '_') && held.chars().all(|letter| letter.is_alphanumeric() || letter == '_')
}

pub fn resolve<'a>(index: &Index<'a>) -> Resolution {
    let timing = std::env::var("KLAURO_TIME_RESOLVE").is_ok();
    let started = std::time::Instant::now();
    let lap = |label: &str| {
        if timing {
            eprintln!("    resolve {label} {:?}", started.elapsed());
        }
    };
    let mut symbols = Symbols::build(index.nodes);
    symbols.scope_packages(index.files, index.languages, index.namespaces);
    lap("symbols");
    let by_path: HashMap<&str, u32> = index
        .files
        .iter()
        .enumerate()
        .map(|(at, path)| (path.as_str(), at as u32))
        .collect();

    let mut edges = Vec::new();
    let mut internal_specifiers: HashSet<String> = HashSet::default();
    lap("paths");
    let by_module = Modules::build(index.files, index.languages);
    lap("modules");
    let by_namespace = namespaces(index);
    lap("namespaces");
    let mut named: HashSet<(u32, String)> = symbols
        .file_scope
        .keys()
        .map(|(file, name)| (*file, name.to_ascii_lowercase()))
        .collect();
    named.extend(
        index
            .nodes
            .iter()
            .filter(|node| {
                node.signature
                    .as_ref()
                    .is_some_and(|signature| signature.receiver.is_some())
            })
            .map(|node| (node.file, node.name.to_ascii_lowercase())),
    );
    lap("named");
    let mut declared_by: HashMap<String, Vec<u32>> = HashMap::default();
    for (file, name) in &named {
        declared_by.entry(name.clone()).or_default().push(*file);
    }
    lap("declared by");
    let mut types_of: Vec<Vec<u32>> = vec![Vec::new(); index.files.len()];
    for (at, fact) in index.type_references.iter().enumerate() {
        if let Some(held) = types_of.get_mut(fact.file as usize) {
            held.push(at as u32);
        }
    }
    let mut calls_of: Vec<Vec<u32>> = vec![Vec::new(); index.files.len()];
    for (at, fact) in index.calls.iter().enumerate() {
        if let Some(held) = calls_of.get_mut(fact.file as usize) {
            held.push(at as u32);
        }
    }
    let mut nodes_of: Vec<Vec<u32>> = vec![Vec::new(); index.files.len()];
    for (at, node) in index.nodes.iter().enumerate() {
        if let Some(held) = nodes_of.get_mut(node.file as usize) {
            held.push(at as u32);
        }
    }
    let referenced_in = |file: u32| -> HashSet<String> {
        let mut held: HashSet<String> = HashSet::default();
        for at in types_of.get(file as usize).into_iter().flatten() {
            held.insert(base_type_name(&index.type_references[*at as usize].name).to_ascii_lowercase());
        }
        for at in calls_of.get(file as usize).into_iter().flatten() {
            let fact = &index.calls[*at as usize];
            held.insert(crate::names::leaf(&fact.callee).to_ascii_lowercase());
            if let Some(receiver) = fact.receiver.as_deref() {
                held.insert(crate::names::root(receiver).to_ascii_lowercase());
            }
        }
        for at in nodes_of.get(file as usize).into_iter().flatten() {
            let node = &index.nodes[*at as usize];
            for named in node
                .type_annotation
                .iter()
                .chain(node.signature.iter().flat_map(|signature| {
                    signature
                        .return_type
                        .iter()
                        .chain(signature.parameters.iter().filter_map(|p| p.type_annotation.as_ref()))
                }))
            {
                held.insert(base_type_name(named).to_ascii_lowercase());
            }
            for decorator in &node.decorators {
                held.insert(crate::names::leaf(&decorator.name).to_ascii_lowercase());
            }
        }
        held
    };
    lap("referenced");
    let aliases = crate::alias::Aliases::read(index.files, index.nodes);
    let mut bindings = Bindings {
        imported: HashMap::default(),
        module_files: HashMap::default(),
        through: HashMap::default(),
        modules: HashMap::default(),
        locals: HashMap::default(),
        file_locals: HashMap::default(),
        guessed: HashMap::default(),
        file_guessed: HashMap::default(),
        opened: HashMap::default(),
        stands_for: HashMap::default(),
        elements: HashMap::default(),
        called: HashMap::default(),
        file_called: HashMap::default(),
    };

    lap("aliases");
    let beneath = Beneath::over(index.files);
    let needing: HashSet<u32> = index
        .imports
        .iter()
        .filter(|fact| namespace_is_declared(&by_namespace, index.languages[fact.file as usize], &fact.specifier))
        .map(|fact| fact.file)
        .collect();
    let needing: Vec<u32> = needing.into_iter().collect();
    let referenced: HashMap<u32, HashSet<String>> =
        needing.par_iter().map(|file| (*file, referenced_in(*file))).collect();
    let reach_of = |fact: &ImportFact| -> Vec<u32> {
        let from = index.files[fact.file as usize].as_str();
        let language = index.languages[fact.file as usize];
        let declared = file_index(&by_path, from, &fact.specifier)
            .or_else(|| {
                relative_module(from, &fact.specifier)
                    .and_then(|path| module_or_owner(&by_path, &fact.specifier, &path))
            })
            .or_else(|| {
                aliases
                    .expand(from, &fact.specifier)
                    .iter()
                    .find_map(|path| module_or_owner(&by_path, &fact.specifier, path))
            })
            .or_else(|| {
                (language == "python" && !fact.specifier.starts_with('.'))
                    .then(|| {
                        (1..=PYTHON_ROOTS_AT_MOST).find_map(|depth| {
                            dotted_module(&by_path, from, &format!("{}{}", ".".repeat(depth), fact.specifier))
                        })
                    })
                    .flatten()
            });
        let reached: Vec<u32> = match declared {
            Some(found) => vec![found],
            None => {
                let members = namespace_members(
                    &by_namespace,
                    &named,
                    &declared_by,
                    referenced.get(&fact.file),
                    language,
                    &fact.specifier,
                );
                let members = match members.is_empty() {
                    false => members,
                    true => match by_module.declared(language, &fact.specifier) {
                        Some(found) => vec![found],
                        None => package_members(&aliases, &by_module, fact, from, language),
                    },
                };
                members
                    .into_iter()
                    .filter(|found| {
                        crate::paths::is_test(from)
                            || !crate::paths::is_test(&index.files[*found as usize])
                    })
                    .collect()
            }
        };
        reached.into_iter().filter(|found| index.files[*found as usize] != from).collect()
    };
    let reached_by_import: Vec<Vec<u32>> = index.imports.par_iter().map(reach_of).collect();
    let forwarded_through: Vec<ImportFact> = index
        .forwards
        .iter()
        .map(|forward| ImportFact {
            file: forward.file,
            specifier: forward.from.clone(),
            line: 0,
            type_only: false,
            everywhere: false,
            names: Vec::new(),
        })
        .collect();
    let forwarded_to: Vec<Vec<u32>> = forwarded_through.par_iter().map(reach_of).collect();
    let mut named_forwards: HashMap<(u32, &str), Vec<(&str, &[u32])>> = HashMap::default();
    let mut every_forward: HashMap<u32, Vec<&[u32]>> = HashMap::default();
    for (forward, reached) in index.forwards.iter().zip(&forwarded_to) {
        match forward.name.as_str() {
            "*" => every_forward.entry(forward.file).or_default().push(reached.as_slice()),
            named => named_forwards
                .entry((forward.file, named))
                .or_default()
                .push((forward.original.as_str(), reached.as_slice())),
        }
    }
    let declared_through = |target: u32, wanted: &str| -> Option<u32> {
        let mut pending: Vec<(u32, &str, u8)> = vec![(target, wanted, 0)];
        let mut visited: HashSet<(u32, &str)> = HashSet::default();
        while let Some((file, name, depth)) = pending.pop() {
            if !visited.insert((file, name)) {
                continue;
            }
            if let Some(found) = symbols
                .exported
                .get(&(file, name))
                .or_else(|| symbols.file_scope.get(&(file, name)))
                .copied()
            {
                return Some(found);
            }
            if depth >= FORWARDED_AT_MOST {
                continue;
            }
            for (original, reached) in named_forwards.get(&(file, name)).into_iter().flatten() {
                pending.extend(reached.iter().map(|next| (*next, *original, depth + 1)));
            }
            for reached in every_forward.get(&file).into_iter().flatten() {
                pending.extend(reached.iter().map(|next| (*next, name, depth + 1)));
            }
        }
        None
    };
    let mut forwarded_edges: HashSet<(u32, u32)> = HashSet::default();
    for (forward, reached) in index.forwards.iter().zip(&forwarded_to) {
        for target in reached {
            if forwarded_edges.insert((forward.file, *target)) {
                edges.push(IndexEdge {
                    via: Via::Structure,
                    source: index.files[forward.file as usize].clone(),
                    target: index.files[*target as usize].clone(),
                    kind: EdgeKind::Imports,
                });
            }
        }
    }
    let mut reached_files: HashMap<(u32, String), u32> = HashMap::default();
    for (fact, reached) in index.imports.iter().zip(reached_by_import) {
        let from = index.files[fact.file as usize].as_str();
        let language = index.languages[fact.file as usize];
        if reached.is_empty() {
            let ours = aliases.declares(from, &fact.specifier) || by_module.held(language, &fact.specifier);
            if !ours && fact.names.iter().all(|name| name.namespace) {
                bindings.opened.entry(fact.file).or_default().push(fact.specifier.as_str());
            }
            if ours {
                internal_specifiers.insert(fact.specifier.clone());
            }
            for name in &fact.names {
                let wanted = name.imported.as_deref().unwrap_or(name.local.as_str());
                if let Some(found) = symbols
                    .unique_unit
                    .get(wanted)
                    .or_else(|| symbols.unique_type.get(wanted))
                    .copied()
                    .filter(|found| {
                        declares_it(&fact.specifier, &index.files[symbols.nodes[*found as usize].file as usize])
                    })
                {
                    bindings.imported.insert((fact.file, name.local.as_str()), found);
                    continue;
                }
                if let Some(found) =
                    beneath.find(&format!("{}.{}", fact.specifier, wanted))
                    && index.files[found as usize] != from
                {
                    internal_specifiers.insert(fact.specifier.clone());
                    bindings.module_files.insert((fact.file, name.local.as_str()), found);
                    bindings
                        .through
                        .insert((fact.file, name.local.as_str()), index.files[found as usize].as_str());
                    continue;
                }
                bindings
                    .modules
                    .insert((fact.file, name.local.as_str()), fact.specifier.as_str());
            }
            continue;
        }
        internal_specifiers.insert(fact.specifier.clone());
        if let Some(first) = reached.first() {
            reached_files.entry((fact.file, fact.specifier.clone())).or_insert(*first);
            let holding = index.files[*first as usize].as_str();
            for name in &fact.names {
                let wanted = name.imported.as_deref().unwrap_or(name.local.as_str());
                let beneath =
                    beneath.find(&format!("{}.{}", fact.specifier, wanted));
                if let Some(found) = beneath {
                    bindings.module_files.insert((fact.file, name.local.as_str()), found);
                }
                if beneath.is_none() && name.namespace {
                    bindings.module_files.insert((fact.file, name.local.as_str()), *first);
                }
                let within = beneath
                    .map(|found| index.files[found as usize].as_str())
                    .unwrap_or(holding);
                bindings.through.insert((fact.file, name.local.as_str()), within);
            }
        }
        for target in &reached {
            edges.push(IndexEdge {
                via: Via::Structure,
                source: from.to_string(),
                target: index.files[*target as usize].clone(),
                kind: EdgeKind::Imports,
            });
        }
        for name in &fact.names {
            let wanted = name.imported.as_deref().unwrap_or(name.local.as_str());
            let declared = reached.iter().find_map(|target| {
                symbols
                    .exported
                    .get(&(*target, wanted))
                    .or_else(|| symbols.file_scope.get(&(*target, wanted)))
                    .copied()
            });
            let drawn_by_its_file = || {
                reached
                    .iter()
                    .find(|target| matches!(index.languages[**target as usize], "vue" | "svelte"))
                    .and_then(|target| symbols.position.get(index.files[*target as usize].as_str()).copied())
                    .filter(|_| name.default_import)
            };
            if let Some(found) = declared
                .or_else(|| reached.iter().find_map(|target| declared_through(*target, wanted)))
                .or_else(drawn_by_its_file)
            {
                bindings.imported.insert((fact.file, name.local.as_str()), found);
            }
        }
    }

    let everywhere: Vec<&ImportFact> = index
        .imports
        .iter()
        .filter(|fact| fact.everywhere && !internal_specifiers.contains(&fact.specifier))
        .collect();
    if !everywhere.is_empty() {
        let projects: Vec<&str> = index
            .files
            .iter()
            .filter(|path| path.ends_with("proj"))
            .map(|path| path.rsplit_once('/').map(|(folder, _)| folder).unwrap_or(""))
            .collect();
        let project_of = |path: &str| -> Option<usize> {
            projects
                .iter()
                .enumerate()
                .filter(|(_, folder)| folder.is_empty() || path.starts_with(&format!("{folder}/")))
                .max_by_key(|(_, folder)| folder.len())
                .map(|(at, _)| at)
        };
        let owning: Vec<Option<usize>> = index.files.iter().map(|path| project_of(path)).collect();
        for fact in everywhere {
            let Some(project) = owning[fact.file as usize] else { continue };
            let language = index.languages[fact.file as usize];
            for (file, held) in owning.iter().enumerate() {
                if *held == Some(project) && index.languages[file] == language && file as u32 != fact.file {
                    bindings.opened.entry(file as u32).or_default().push(fact.specifier.as_str());
                }
            }
        }
    }

    let mut owners: HashMap<String, String> = HashMap::default();
    lap("imports");
    for fact in index.type_references {
        if fact.kind != EdgeKind::HasMethod {
            continue;
        }
        let name = base_type_name(&fact.name);
        let Some(owner) = symbols
            .in_scope(fact.file, name)
            .or_else(|| symbols.unique_type.get(name).copied())
        else {
            continue;
        };
        if let Some(method) = symbols.position.get(fact.source.as_str()).copied() {
            symbols.owner[method as usize] = Some(owner);
            symbols
                .members
                .entry((owner, index.nodes[method as usize].name.as_str()))
                .or_insert(method);
            symbols
                .callables
                .entry((owner, index.nodes[method as usize].name.as_str()))
                .or_insert(method);
            let owner = index.nodes[owner as usize].id.clone();
            edges.push(IndexEdge {
                via: Via::Structure,
                source: owner.clone(),
                target: fact.source.clone(),
                kind: EdgeKind::HasMethod,
            });
            owners.insert(fact.source.clone(), owner);
        }
    }

    let mut made_by: Vec<(String, String, String)> = Vec::new();
    for binding in index.locals.iter() {
        let Some(from) = binding.from_call.as_deref() else { continue };
        let root = from.split("::").next().unwrap_or(from);
        let root = root.split('.').next().unwrap_or(root);
        if root.is_empty() || root == from {
            continue;
        }
        made_by.push((binding.unit.clone(), binding.name.to_string(), root.to_string()));
    }

    for binding in index.locals {
        if let Some(expression) = binding.stands_for.as_deref()
            && expression.split('.').next() != Some(binding.name.as_str())
        {
            bindings.stands_for.insert((binding.unit.as_str(), binding.name.as_str()), expression);
        }
        if let Some(expression) = binding.element_of.as_deref() {
            bindings.elements.insert((binding.unit.as_str(), binding.name.as_str()), expression);
        }
        if binding.annotation.is_none()
            && binding.constructed.is_none()
            && let Some(call) = binding.from_call.as_deref()
        {
            if binding.unit.is_empty() {
                bindings.file_called.insert((binding.file, binding.name.as_str()), (call, binding.slot));
            } else {
                bindings.called.insert((binding.unit.as_str(), binding.name.as_str()), (call, binding.slot));
            }
        }
        let explicit = binding.annotation.as_deref().or(binding.constructed.as_deref());
        let guess = || {
            let callee = crate::names::leaf(binding.from_call.as_deref()?);
            match symbols.unique_unit.get(callee) {
                Some(unit) => index.nodes[*unit as usize].signature.as_ref()?.return_type.as_deref(),
                None => runtime_member(callee).map(|entry| entry.returns).filter(|returns| !returns.is_empty()),
            }
        };
        let (annotation, guessed) = match explicit {
            Some(held) => (held, false),
            None => match guess() {
                Some(held) => (held, true),
                None => continue,
            },
        };
        match (binding.unit.is_empty(), guessed) {
            (true, false) => {
                bindings.file_locals.insert((binding.file, binding.name.as_str()), annotation);
            }
            (false, false) => {
                bindings.locals.insert((binding.unit.as_str(), binding.name.as_str()), annotation);
            }
            (true, true) => {
                bindings.file_guessed.insert((binding.file, binding.name.as_str()), annotation);
            }
            (false, true) => {
                bindings.guessed.insert((binding.unit.as_str(), binding.name.as_str()), annotation);
            }
        }
    }

    let through: HashMap<(u32, String), String> = bindings
        .through
        .iter()
        .map(|((file, name), held)| ((*file, (*name).to_string()), (*held).to_string()))
        .collect();
    lap("type references and locals");
    let mut types_named: HashMap<&str, Vec<u32>> = HashMap::default();
    for (at, node) in index.nodes.iter().enumerate().filter(|(_, node)| node.kind.is_type()) {
        types_named.entry(node.name.as_str()).or_default().push(at as u32);
        let language = index.languages.get(node.file as usize).copied().unwrap_or("");
        if crate::language_tables::names_modules_globally(language)
            && let Some((_, leaf)) = node.name.rsplit_once('.')
        {
            types_named.entry(leaf).or_default().push(at as u32);
        }
    }
    let resolver = Resolver {
        symbols,
        bindings,
        runtime: externals::sorted_runtime_globals(),
        visible: crate::visibility::Visibility::build(index.files, index.nodes),
        types_named,
        languages: index.languages,
        files: index.files,
        by_path: &by_path,
        aliases: &aliases,
        inherits: std::sync::OnceLock::new(),
    };
    let symbols = &resolver.symbols;

    let mut external_nodes: HashMap<String, IndexNode> = HashMap::default();

    let mut supertypes: HashMap<u32, Vec<u32>> = HashMap::default();
    let mut inherits_from_outside: HashSet<u32> = HashSet::default();
    for fact in index.type_references {
        if !matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements) {
            continue;
        }
        let Some(source) = symbols.position.get(fact.source.as_str()).copied() else {
            continue;
        };
        if index.languages.get(fact.file as usize) == Some(&"ruby") && fact.name.contains("::") {
            match resolver.ruby_type(fact.file, &fact.name) {
                Some(only) if only != source => supertypes.entry(source).or_default().push(only),
                Some(_) => {}
                None => {
                    inherits_from_outside.insert(source);
                }
            }
            continue;
        }
        match resolver.annotated(fact.file, &fact.name) {
            Origin::Declared(found) if found != source => supertypes.entry(source).or_default().push(found),
            Origin::Declared(_) => {}
            _ => {
                inherits_from_outside.insert(source);
            }
        }
    }
    for call in index.calls.iter() {
        if call.receiver.is_some()
            || !matches!(call.callee.as_str(), "include" | "extend" | "prepend")
            || index.languages.get(call.file as usize) != Some(&"ruby")
        {
            continue;
        }
        let Some(source) = call.caller.as_deref().and_then(|caller| symbols.position.get(caller).copied()) else {
            continue;
        };
        if !symbols.nodes[source as usize].kind.is_type() {
            continue;
        }
        for literal in call.literals.iter().filter(|literal| literal.starts_with(char::is_uppercase)) {
            match resolver.ruby_type(call.file, literal) {
                Some(only) if only != source => supertypes.entry(source).or_default().push(only),
                Some(_) => {}
                None => {
                    inherits_from_outside.insert(source);
                }
            }
        }
    }
    let _ = resolver.inherits.set(supertypes.clone());
    let columns: Vec<&str> = index
        .calls
        .iter()
        .filter(|call| {
            call.receiver.as_deref() == Some("t")
                && COLUMN_TYPES.contains(&call.callee.as_str())
                && index.files[call.file as usize].ends_with("schema.rb")
        })
        .filter_map(|call| call.literals.first().map(String::as_str))
        .filter(|named| !named.contains('='))
        .collect();
    let generated_members: HashSet<String> = index
        .calls
        .iter()
        .filter(|call| call.receiver.is_none() && index.languages.get(call.file as usize) == Some(&"ruby"))
        .filter(|call| GENERATES_MEMBERS.contains(&call.callee.as_str()))
        .flat_map(|call| {
            call.literals
                .iter()
                .take_while(|literal| !literal.contains('='))
                .filter_map(|literal| literal.strip_prefix(':'))
                .map(|named| named.trim_matches('"'))
                .filter(|named| !named.is_empty() && !named.contains('#'))
                .flat_map(|named| {
                    let identifier = format!("{named}_id");
                    [named.to_string(), format!("{named}="), format!("{named}?"), identifier]
                })
                .collect::<Vec<_>>()
        })
        .chain(columns.iter().flat_map(|named| {
            [named.to_string(), format!("{named}="), format!("{named}?")]
        }))
        .collect();
    let mut mixed_into: HashMap<u32, Vec<u32>> = HashMap::default();
    for (below, above) in supertypes.iter() {
        for held in above {
            mixed_into.entry(*held).or_default().push(*below);
        }
    }
    let reaches_outside = |owner: u32| -> bool {
        let mut seen = HashSet::default();
        let mut pending = vec![owner];
        while let Some(at) = pending.pop() {
            if !seen.insert(at) {
                continue;
            }
            if inherits_from_outside.contains(&at) {
                return true;
            }
            if let Some(above) = supertypes.get(&at) {
                pending.extend(above.iter().copied());
            }
            if symbols.nodes[at as usize].kind == NodeKind::Interface
                && let Some(hosts) = mixed_into.get(&at)
            {
                pending.extend(hosts.iter().copied());
            }
        }
        false
    };

    let inherited = |owner: u32, name: &str| -> Option<u32> {
        let mut seen = HashSet::default();
        let mut pending = vec![owner];
        while let Some(at) = pending.pop() {
            if !seen.insert(at) {
                continue;
            }
            if let Some(found) = symbols.callable(at, name) {
                return Some(found);
            }
            if let Some(above) = supertypes.get(&at) {
                pending.extend(above.iter().copied());
            }
        }
        None
    };

    let mut called_within: HashMap<&str, Vec<&str>> = HashMap::default();
    for call in index.calls.iter() {
        let spoken_to_itself = call.receiver.as_deref().is_none_or(|receiver| matches!(receiver, "this" | "self"));
        let Some(mut caller) = call.caller.as_deref() else { continue };
        if !spoken_to_itself {
            continue;
        }
        for _ in 0..8 {
            let Some(held) = symbols.position.get(caller).map(|at| &symbols.nodes[*at as usize]) else { break };
            match (held.id.contains(":callback:"), held.parent.as_deref()) {
                (true, Some(parent)) => caller = parent,
                _ => break,
            }
        }
        called_within.entry(caller).or_default().push(call.callee.as_str());
    }
    let extended_by = |unit: u32| -> Option<u32> {
        let mut current = unit;
        for _ in 0..8 {
            let node = &symbols.nodes[current as usize];
            if let Some(receiver) = node.signature.as_ref().and_then(|signature| signature.receiver.as_deref()) {
                return resolver.named_type(node.file, receiver);
            }
            if !node.id.contains(":callback:") {
                return None;
            }
            current = symbols.position.get(node.parent.as_deref()?).copied()?;
        }
        None
    };
    let mut hooks_of: HashMap<&str, Vec<&str>> = HashMap::default();
    for node in symbols.nodes.iter().filter(|node| node.kind.is_unit() && !matches!(node.kind, NodeKind::Constructor)) {
        if let Some(parent) = node.parent.as_deref() {
            hooks_of.entry(parent).or_default().push(node.name.as_str());
        }
    }
    let overridden_within = |called: u32, owner: u32| -> Option<u32> {
        let base = symbols.owning_type(called).filter(|base| *base != owner)?;
        let dispatched = called_within
            .get(symbols.nodes[called as usize].id.as_str())
            .and_then(|named| named.iter().find_map(|named| symbols.member(owner, named)));
        dispatched.or_else(|| {
            let mut hooked = hooks_of
                .get(symbols.nodes[base as usize].id.as_str())?
                .iter()
                .filter(|named| **named != symbols.nodes[called as usize].name && !matches!(**named, "constructor" | "__init__" | "init"))
                .filter_map(|named| symbols.member(owner, named));
            match (hooked.next(), hooked.next()) {
                (Some(only), None) => Some(only),
                _ => None,
            }
        })
    };

    for fact in index.type_references {
        if fact.kind == EdgeKind::HasMethod {
            continue;
        }
        let target = match resolver.annotated(fact.file, &fact.name) {
            Origin::Declared(found) => Some(symbols.nodes[found as usize].id.clone()),
            Origin::Runtime(owner) => Some(declare_external(
                &mut external_nodes,
                "runtime",
                owner,
                &fact.name,
            )),
            Origin::Package(specifier) => Some(declare_external(
                &mut external_nodes,
                "package",
                specifier,
                &fact.name,
            )),
            _ => None,
        };
        if let Some(target) = target {
            edges.push(IndexEdge {
                via: Via::Structure,
                source: fact.source.clone(),
                target,
                kind: fact.kind,
            });
        }
    }

    let mut sole_package: HashMap<u32, &str> = HashMap::default();
    for fact in index.imports {
        let Some(package) = crate::dependencies::package_of(&fact.specifier) else {
            continue;
        };
        match sole_package.entry(fact.file) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(package);
            }
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                if *slot.get() != package {
                    slot.insert("");
                }
            }
        }
    }
    let declared_anywhere: HashSet<&str> =
        index.nodes.iter().map(|node| node.name.as_str()).collect();
    let authored = |node: &&IndexNode| {
        index.languages.get(node.file as usize).is_some_and(|language| {
            !language.is_empty() && !matches!(*language, "markdown" | "configuration" | "dockerfile")
        }) && !node.id.contains(":section:")
            && !node.id.contains(":key:")
            && !crate::paths::is_test(&index.files[node.file as usize])
    };
    let mut unresolved_names: HashMap<String, u32> = HashMap::default();
    let bound: HashSet<(&str, &str)> = index.locals.iter().map(|local| (local.unit.as_str(), local.name.as_str())).collect();
    let mut open_calls: HashMap<String, u32> = HashMap::default();
    let mut call_origins: HashMap<(String, String), String> = HashMap::default();
    for (unit, name, root) in made_by {
        call_origins.entry((unit, name)).or_insert(root);
    }
    let mut package_calls = 0;
    let mut runtime_calls = 0;
    let mut indirect_calls = 0;
    let mut dynamic_calls = 0;
    let mut implemented_by: HashMap<u32, Vec<u32>> = HashMap::default();
    for (below, above) in supertypes.iter() {
        let path = index.files.get(symbols.nodes[*below as usize].file as usize).map(String::as_str).unwrap_or("");
        if crate::paths::is_test(path) {
            continue;
        }
        for held in above {
            implemented_by.entry(*held).or_default().push(*below);
        }
    }
    for below in implemented_by.values_mut() {
        below.sort_unstable();
    }
    let mut unresolved_calls = 0;
    let mut no_caller = 0;

    lap("before calls");
    let settled_edges = &edges;
    let resolve_call = |fact: &'a CallFact| -> Resolved {
        let (receiver, callee): (Option<String>, String) = match fact.receiver.clone() {
            Some(receiver) => (Some(receiver), fact.callee.clone()),
            None => match fact.callee.rfind("::") {
                Some(at) if at > 0 && at + 2 < fact.callee.len() && !fact.callee.contains('.') => (
                    Some(fact.callee[..at].to_string()),
                    fact.callee[at + 2..].to_string(),
                ),
                _ => (None, fact.callee.clone()),
            },
        };
        let Some(caller) = fact.caller.as_deref() else {
            return Resolved::NoCaller;
        };
        let Some(unit) = symbols.position.get(caller).copied() else {
            return Resolved::NoCaller;
        };
        let kind = if fact.constructs {
            EdgeKind::Instantiates
        } else {
            EdgeKind::Calls
        };

        if receiver.is_none() && callee == "import" {
            return Resolved::Dynamic;
        }
        if receiver.is_none() && callee == "super"
            && let Some(parent) = symbols
                .owning_type(unit)
                .and_then(|owner| parent_of(settled_edges, &symbols.nodes[owner as usize].id))
                .and_then(|parent| symbols.position.get(parent.as_str()).copied())
            {
                let target = symbols
                    .member(parent, "constructor")
                    .unwrap_or(parent);
                return Resolved::Edge(symbols.nodes[target as usize].id.clone(), kind);
            }

        let origin = match receiver.as_deref() {
            Some(receiver) => resolver.origin(unit, fact.file, receiver),
            None => resolver.root(unit, fact.file, &callee),
        };
        let origin = match (origin, receiver.as_deref()) {
            (Origin::Unknown, Some(receiver))
                if index.languages.get(fact.file as usize) == Some(&"rust") =>
            {
                qualified_module_target(&by_path, &aliases, index.files, index.languages, fact.file, receiver)
                    .map(Origin::Module)
                    .unwrap_or(Origin::Unknown)
            }
            (other, _) => other,
        };

        match (origin, receiver.as_deref()) {
            (Origin::Declared(found), Some(_)) => {
                let node = &symbols.nodes[found as usize];
                match inherited(found, &callee) {
                    Some(member) => {
                        let target = match node.kind.is_type() {
                            true => overridden_within(member, found).unwrap_or(member),
                            false => member,
                        };
                        return Resolved::Edge(symbols.nodes[target as usize].id.clone(), kind);
                    }
                    None if node.kind == NodeKind::Interface => {
                        let targets: Vec<String> = implemented_by
                            .get(&found)
                            .into_iter()
                            .flatten()
                            .filter(|below| resolver.visible.can_see(fact.file, symbols.nodes[**below as usize].file))
                            .filter_map(|below| inherited(*below, &callee))
                            .map(|member| symbols.nodes[member as usize].id.clone())
                            .take(IMPLEMENTERS_AT_MOST)
                            .collect();
                        if !targets.is_empty() {
                            return Resolved::Implemented(targets, kind);
                        }
                    }
                    None if node.kind.is_unit()
                        && matches!(callee.as_str(), "call" | "apply" | "bind" | "invoke" | "Invoke" | "DynamicInvoke" | "__call__") =>
                    {
                        return Resolved::Edge(node.id.clone(), kind);
                    }
                    None if node.kind.is_type()
                        && callee == "new"
                        && index.languages.get(fact.file as usize) == Some(&"ruby") =>
                    {
                        let built = symbols.member(found, "constructor").unwrap_or(found);
                        return Resolved::Edge(symbols.nodes[built as usize].id.clone(), EdgeKind::Instantiates);
                    }
                    None if node.kind.is_type() && HOLDER_ACCESSORS.contains(&callee.as_str()) => {
                        if let Some(called) = CALLED_AS_A_FUNCTION.iter().find_map(|named| inherited(found, named)) {
                            let target = overridden_within(called, found).unwrap_or(called);
                            return Resolved::Edge(symbols.nodes[target as usize].id.clone(), kind);
                        }
                    }
                    None => {}
                }
            }
            (Origin::Declared(found), None) => {
                let node = &symbols.nodes[found as usize];
                let through_a_value = node.kind.is_type() && !fact.constructs && node.name != callee;
                if through_a_value
                    && let Some(called) = CALLED_AS_A_FUNCTION.iter().find_map(|named| inherited(found, named))
                {
                    let target = overridden_within(called, found).unwrap_or(called);
                    return Resolved::Edge(symbols.nodes[target as usize].id.clone(), kind);
                }
                return Resolved::Edge(node.id.clone(), kind);
            }
            (Origin::Module(held), Some(_)) => {
                if let Some(found) = symbols.in_scope(held, callee.as_str()) {
                    return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
                }
            }
            (Origin::Indirect, None) => {
                return Resolved::Indirect;
            }
            _ => {}
        }

        if fact.renders
            && receiver.is_none()
            && let Some(found) = resolver
                .bindings
                .imported
                .get(&(fact.file, callee.as_str()))
                .copied()
                .or_else(|| symbols.in_scope(fact.file, callee.as_str()))
            && matches!(symbols.nodes[found as usize].kind, NodeKind::Variable | NodeKind::Module)
        {
            return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
        }

        if index.languages.get(fact.file as usize) == Some(&"ruby")
            && let Some(receiver) = receiver.as_deref()
            && receiver.starts_with(char::is_uppercase)
            && let Some((root, _)) = receiver.split_once('.')
            && let Some(owner) = resolver.ruby_type(fact.file, root)
            && reaches_outside(owner)
            && let Some(found) = inherited(owner, &callee)
        {
            return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
        }

        let member = match receiver.as_deref() {
            Some(receiver) => format!("{}.{}", last_segment(receiver), callee),
            None => callee.clone(),
        };

        if receiver.is_some()
            && let Some(found) = resolver
                .bindings
                .imported
                .get(&(fact.file, callee.as_str()))
                .copied()
                .filter(|found| {
                    symbols.nodes[*found as usize]
                        .signature
                        .as_ref()
                        .is_some_and(|signature| signature.receiver.is_some())
                })
        {
            return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
        }

        let known_type_without_it = receiver.is_some()
            && matches!(origin, Origin::Declared(found) if symbols.nodes[found as usize].kind.is_type())
            && crate::builtins::is_standard_member(index.languages.get(fact.file as usize).copied().unwrap_or(""), &callee);
        let external = match origin {
            Origin::Declared(_) if known_type_without_it => {
                let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
                Some(("runtime", language.to_string(), format!("{language}.{callee}")))
            }
            Origin::Package(specifier) => Some(("package", specifier.to_string(), member.clone())),
            Origin::Runtime(name) => Some((
                "runtime",
                name.to_string(),
                format!("{name}.{}", callee),
            )),
            _ => runtime_member(&callee)
                .filter(|entry| {
                    !entry.owner.is_empty()
                        && !symbols.written_for(receiver.as_deref(), &callee)
                })
                .map(|entry| {
                    (
                        "runtime",
                        entry.owner.to_string(),
                        format!("{}.{}", entry.owner, callee),
                    )
                }),
        };

        if let Some((space, owner, member)) = external {
            let origin = (space == "package")
                .then(|| receiver.as_deref())
                .flatten()
                .map(|receiver| (caller.to_string(), receiver.to_string()));
            return Resolved::External { space, owner, member, kind, origin };
        }

        if receiver.is_none()
            && let Some(extended) = extended_by(unit)
            && let Some(member) = inherited(extended, &callee)
        {
            return Resolved::Edge(symbols.nodes[member as usize].id.clone(), kind);
        }
        let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
        let in_language = |found: u32| {
            family(index.languages.get(symbols.nodes[found as usize].file as usize).copied().unwrap_or("")) == family(language)
        };
        if receiver.is_none()
            && let Some(found) = symbols.unique_unit.get(callee.as_str()).copied().filter(|found| in_language(*found))
        {
            return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
        }
        if receiver.is_none()
            && let Some(found) = symbols.unique_type.get(callee.as_str()).copied().filter(|found| in_language(*found))
        {
            let built = symbols.member(found, "constructor").unwrap_or(found);
            return Resolved::Edge(symbols.nodes[built as usize].id.clone(), EdgeKind::Instantiates);
        }
        let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
        let in_language = |found: u32| {
            family(index.languages.get(symbols.nodes[found as usize].file as usize).copied().unwrap_or("")) == family(language)
        };
        let loose_language = matches!(language, "javascript" | "typescript");
        if let Some(receiver) = receiver.as_deref()
            && let Some(found) = symbols.unique_member.get(callee.as_str()).copied().filter(|found| in_language(*found))
        {
            let target = symbols.nodes[found as usize].id.clone();
            let standard = crate::builtins::is_standard_member(language, &callee);
            let names_its_owner = symbols.owning_type(found).is_some_and(|owner| {
                symbols.spoken_as_owner(receiver, owner)
                    || ((loose_language || !standard) && symbols.spoken_within_owner(receiver, owner))
            });
            if names_its_owner {
                return Resolved::Edge(target, kind);
            }
            if !standard {
                return Resolved::Guessed(target, kind);
            }
        }
        if let Some(receiver) = receiver.as_deref() {
            let extended = match origin {
                Origin::Declared(found) if symbols.nodes[found as usize].kind.is_type() => {
                    Some(symbols.nodes[found as usize].name.as_str())
                }
                _ => resolver.bindings.annotation(caller, fact.file, last_segment(receiver)),
            };
            let typed = extended.and_then(|owner| {
                symbols
                    .extension
                    .get(&(last_segment(owner), callee.as_str()))
                    .copied()
            });
            let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
            let imported = resolver
                .bindings
                .modules
                .get(&(fact.file, callee.as_str()))
                .copied();
            let found = typed.or_else(|| {
                if imported.is_some() || crate::builtins::is_builtin(language, &callee) {
                    return None;
                }
                symbols.unique_extension.get(callee.as_str()).copied()
            });
            if let Some(found) = found {
                return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
            }
            if let Some(specifier) = imported {
                return Resolved::External {
                    space: "package",
                    owner: specifier.to_string(),
                    member: format!("{specifier}.{}", callee),
                    kind,
                    origin: None,
                };
            }
        }

        let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
        if receiver.is_none() && crate::builtins::is_builtin(language, &callee) {
            return Resolved::External {
                space: "runtime",
                owner: language.to_string(),
                member: format!("{language}.{}", callee),
                kind,
                origin: None,
            };
        }
        if !crate::builtins::is_builtin(language, &callee)
            && !declared_anywhere.contains(callee.as_str())
            && let Some(specifier) = sole_package.get(&fact.file).copied()
            && !specifier.is_empty()
        {
            return Resolved::External { space: "package", owner: specifier.to_string(), member, kind, origin: None };
        }

        let handed_in = receiver.is_none() && (bound.contains(&(caller, callee.as_str())) || {
            let mut held = false;
            let mut current = Some(unit);
            for _ in 0..8 {
                let Some(at) = current else { break };
                let node = &symbols.nodes[at as usize];
                if node.signature.as_ref().is_some_and(|signature| signature.parameters.iter().any(|parameter| parameter.name == callee)) {
                    held = true;
                    break;
                }
                current = node.parent.as_deref().and_then(|parent| symbols.position.get(parent).copied());
            }
            held
        });
        let inherited_from_a_library = index.languages.get(fact.file as usize) == Some(&"ruby")
            && match (&origin, receiver.as_deref()) {
                (Origin::Declared(found), Some(_)) => symbols.nodes[*found as usize].kind.is_type(),
                (_, None | Some("self")) => symbols.owning_type(unit).is_none_or(&reaches_outside),
                _ => false,
            };
        let foreign = handed_in || inherited_from_a_library || receiver.as_deref().is_some_and(|receiver| {
            if index.languages.get(fact.file as usize) == Some(&"ruby") && receiver.starts_with(char::is_uppercase) {
                let first = receiver.split(['.', ':']).next().unwrap_or(receiver);
                if !resolver.types_named.contains_key(first) && !declared_anywhere.contains(first) {
                    return true;
                }
                if let Some((qualifier, rest)) = receiver.split_once("::") {
                    let mut segments: Vec<&str> = std::iter::once(qualifier)
                        .chain(rest.split("::"))
                        .map(|segment| segment.split(['.', '(']).next().unwrap_or(segment))
                        .collect();
                    let leaf = segments.pop().unwrap_or_default();
                    let namespace = segments.pop().unwrap_or(leaf);
                    let directory = format!("{}/", snake_case(namespace));
                    let ours = resolver.types_named.get(leaf).into_iter().flatten().any(|found| {
                        index.files[symbols.nodes[*found as usize].file as usize].contains(directory.as_str())
                    });
                    if !ours {
                        return true;
                    }
                } else if let Some((root, link)) = receiver.split_once('.')
                    && let Some(type_found) = resolver.ruby_type(fact.file, root)
                {
                    let link = link.split(['.', '(']).next().unwrap_or(link);
                    if inherited(type_found, link).is_none() && !generated_members.contains(link) {
                        return true;
                    }
                }
            }
            if matches!(index.languages.get(fact.file as usize), Some(&("javascript" | "typescript")))
                && externals::NODE_MODULES.contains(&crate::names::root(receiver))
            {
                return true;
            }
            let receiver = receiver.trim_start_matches(['(', '*', '&']);
            if let Some((first, _)) = receiver.split_once("::") {
                return !matches!(first, "crate" | "self" | "super" | "Self")
                    && !resolver.types_named.contains_key(first)
                    && !declared_anywhere.contains(first);
            }
            let held = match receiver.strip_prefix("self.").or_else(|| receiver.strip_prefix("this.")) {
                Some(rest) => symbols
                    .owning_type(unit)
                    .and_then(|owner| symbols.member_type(owner, crate::names::root(rest))),
                None => resolver.bindings.annotation(caller, fact.file, crate::names::root(receiver)),
            };
            held.is_some_and(|annotation| {
                let mut words = annotation
                    .split(|letter: char| !letter.is_alphanumeric() && letter != '_')
                    .filter(|word| !word.is_empty())
                    .peekable();
                words.peek().is_some() && !words.any(|word| declared_anywhere.contains(word))
            })
        });
        Resolved::Unresolved(member, foreign)
    };
    let resolved: Vec<Resolved> = index.calls.par_iter().map(resolve_call).collect();
    lap("calls resolved");
    let mut ours: HashMap<&str, u32> = HashMap::default();
    for (fact, outcome) in index.calls.iter().zip(&resolved) {
        if matches!(outcome, Resolved::Unresolved(..))
            && declared_anywhere.contains(fact.callee.as_str())
            && !crate::paths::is_test(&index.files[fact.file as usize])
        {
            *ours.entry(fact.callee.as_str()).or_insert(0) += 1;
        }
    }
    eprintln!("  unresolved naming something declared here {} in hand-written code", ours.values().sum::<u32>());
    if std::env::var("KLAURO_REPORT_UNRESOLVED").is_ok() {
        let mut ranked: Vec<(&str, u32)> = ours.iter().map(|(name, count)| (*name, *count)).collect();
        ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
        for (name, count) in ranked.iter().take(40) {
            eprintln!("  unresolved ours {count:6} {name}");
        }
    }
    let visible = &resolver.visible;
    let open_ends = OpenEnds::declared(index, authored, visible);
    let carried_out = |target: &str, from_file: u32| -> Option<String> {
        let at = symbols.position.get(target).copied()?;
        let member = &symbols.nodes[at as usize];
        let owner = symbols.owning_type(at).filter(|owner| *owner != at)?;
        let seen: Vec<u32> = implemented_by
            .get(&owner)?
            .iter()
            .copied()
            .filter(|below| visible.can_see(from_file, symbols.nodes[*below as usize].file))
            .collect();
        match seen.as_slice() {
            [only] => symbols.member(*only, &member.name).map(|found| symbols.nodes[found as usize].id.clone()),
            _ => None,
        }
    };
    let dump_to = std::env::var("KLAURO_REPORT_CALLS").ok();
    let mut dumped: Vec<String> = Vec::new();
    for (fact, outcome) in index.calls.iter().zip(resolved) {
        let caller = fact.caller.as_deref().unwrap_or_default();
        let outcome = match outcome {
            Resolved::Edge(target, kind) => match carried_out(&target, fact.file) {
                Some(carried) => Resolved::Edge(carried, kind),
                None => Resolved::Edge(target, kind),
            },
            Resolved::External { .. } if fact.renders => Resolved::Library,
            other => other,
        };
        if dump_to.is_some() {
            let label = match &outcome {
                Resolved::Edge(target, _) => format!("structure\t{target}"),
                Resolved::Guessed(target, _) => format!("name\t{target}"),
                Resolved::Implemented(targets, _) => format!("implemented\t{}", targets.join(",")),
                Resolved::External { owner, member, .. } => format!("external\t{owner}\t{member}"),
                Resolved::Unresolved(_, foreign) => format!(
                    "unresolved\t{foreign}\t{}",
                    declared_anywhere.contains(fact.callee.as_str()) && !crate::paths::is_test(&index.files[fact.file as usize])
                ),
                Resolved::NoCaller => "nocaller".to_string(),
                Resolved::Dynamic => "dynamic".to_string(),
                Resolved::Indirect => "indirect".to_string(),
                Resolved::Library => "library".to_string(),
            };
            dumped.push(format!(
                "{}:{}\t{}\t{}\t{}\t{}",
                index.files[fact.file as usize],
                fact.line,
                caller,
                fact.receiver.as_deref().unwrap_or("").replace('\n', " "),
                fact.callee.replace('\n', " "),
                label
            ));
        }
        match outcome {
            Resolved::NoCaller => no_caller += 1,
            Resolved::Dynamic => dynamic_calls += 1,
            Resolved::Indirect => indirect_calls += 1,
            Resolved::Library => {}
            Resolved::Unresolved(member, foreign) => {
                let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
                let generated = language == "ruby" && generated_members.contains(fact.callee.as_str());
                if !foreign
                    && !generated
                    && open_ends.contains(&fact.callee, fact.receiver.is_some(), language, fact.file)
                {
                    *open_calls.entry(caller.to_string()).or_insert(0) += 1;
                }
                *unresolved_names.entry(member).or_insert(0) += 1;
                unresolved_calls += 1;
            }
            Resolved::Edge(target, kind) => {
                if fact.renders && target != caller {
                    edges.push(IndexEdge { via: Via::Structure, source: caller.to_string(), target: target.clone(), kind: EdgeKind::Renders });
                }
                edges.push(IndexEdge { via: Via::Structure, source: caller.to_string(), target, kind });
            }
            Resolved::Guessed(target, kind) => {
                if fact.renders && target != caller {
                    edges.push(IndexEdge { via: Via::Name, source: caller.to_string(), target: target.clone(), kind: EdgeKind::Renders });
                }
                edges.push(IndexEdge { via: Via::Name, source: caller.to_string(), target, kind });
            }
            Resolved::Implemented(targets, kind) => {
                for target in targets {
                    edges.push(IndexEdge { via: Via::Rule, source: caller.to_string(), target, kind });
                }
            }
            Resolved::External { space, owner, member, kind, origin } => {
                if let Some(origin) = origin {
                    call_origins.insert(origin, owner.clone());
                }
                let target = declare_external(&mut external_nodes, space, &owner, &member);
                edges.push(IndexEdge { via: Via::Structure, source: caller.to_string(), target, kind });
                match space {
                    "package" => package_calls += 1,
                    _ => runtime_calls += 1,
                }
            }
        }
    }

    let mut handed_over: HashSet<(&str, u32)> = HashSet::default();
    let top_level_units: HashMap<(u32, &str), u32> = index
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.kind.is_unit() && node.parent.as_deref() == index.files.get(node.file as usize).map(String::as_str))
        .map(|(at, node)| ((node.file, node.name.as_str()), at as u32))
        .collect();
    for call in index.calls.iter() {
        let Some(caller) = call.caller.as_deref().filter(|caller| symbols.position.contains_key(caller)) else { continue };
        for passed in &call.passes {
            let Some(name) = passed.split_once('=').map(|(_, root)| root).filter(|root| is_a_bare_name(root)) else { continue };
            let target = top_level_units
                .get(&(call.file, name))
                .or_else(|| symbols.file_scope.get(&(call.file, name)))
                .or_else(|| resolver.bindings.imported.get(&(call.file, name)))
                .copied()
                .filter(|at| symbols.nodes[*at as usize].kind.is_unit() && symbols.nodes[*at as usize].id != caller);
            if let Some(at) = target
                && handed_over.insert((caller, at))
            {
                edges.push(IndexEdge {
                    via: Via::Structure,
                    source: caller.to_string(),
                    target: symbols.nodes[at as usize].id.clone(),
                    kind: EdgeKind::Calls,
                });
            }
        }
    }

    if let Some(path) = dump_to {
        let _ = std::fs::write(path, dumped.join("\n"));
    }
    let mut external_nodes: Vec<IndexNode> = external_nodes.into_values().collect();
    external_nodes.sort_by(|left, right| left.id.cmp(&right.id));

    Resolution {
        edges,
        external_nodes,
        modules: resolver
            .bindings
            .modules
            .iter()
            .map(|((file, name), specifier)| ((*file, (*name).to_string()), (*specifier).to_string()))
            .collect(),
        local: symbols
            .file_scope
            .iter()
            .map(|((file, name), at)| {
                ((*file, (*name).to_string()), symbols.nodes[*at as usize].id.clone())
            })
            .collect(),
        imported: resolver
            .bindings
            .imported
            .iter()
            .map(|((file, name), at)| ((*file, (*name).to_string()), symbols.nodes[*at as usize].id.clone()))
            .collect(),
        reached: reached_files,
        named_units: {
            let mut named: HashMap<String, Vec<(u32, String)>> = HashMap::default();
            for node in symbols.nodes.iter().filter(|node| node.kind.is_unit()) {
                named.entry(node.name.clone()).or_default().push((node.file, node.id.clone()));
            }
            named
        },
        file_families: index.languages.iter().map(|language| family(language).to_string()).collect(),
        call_origins,
        open_calls,
        method_owners: owners,
        internal_specifiers,
        through,
        package_calls,
        runtime_calls,
        indirect_calls,
        dynamic_calls,
        unresolved_calls,
        no_caller,
        unresolved_names,
    }
}

struct OpenEnds<'a> {
    own_names: HashMap<&'a str, Vec<u32>>,
    free_names: HashMap<&'a str, Vec<u32>>,
    qualifiers: HashSet<&'a str>,
    enum_names: HashSet<&'a str>,
    visible: &'a crate::visibility::Visibility,
}

impl<'a> OpenEnds<'a> {
    fn declared(
        index: &'a Index,
        authored: impl Fn(&&IndexNode) -> bool,
        visible: &'a crate::visibility::Visibility,
    ) -> Self {
        let mut own_names: HashMap<&str, Vec<u32>> = HashMap::default();
        let mut free_names: HashMap<&str, Vec<u32>> = HashMap::default();
        for node in index.nodes.iter().filter(|node| authored(node)) {
            if node.kind.is_unit() || node.kind.is_type() {
                own_names.entry(node.name.as_str()).or_default().push(node.file);
            }
            if matches!(node.kind, NodeKind::Function) || node.kind.is_type() {
                free_names.entry(node.name.as_str()).or_default().push(node.file);
            }
        }
        let names_where = |keep: fn(&IndexNode) -> bool| -> HashSet<&str> {
            index.nodes.iter().filter(|node| authored(node)).filter(|node| keep(node)).map(|node| node.name.as_str()).collect()
        };
        OpenEnds {
            own_names,
            free_names,
            qualifiers: names_where(|node| node.kind.is_type() || node.kind == NodeKind::Module),
            enum_names: names_where(|node| node.kind == NodeKind::Enum),
            visible,
        }
    }

    fn contains(&self, callee: &str, has_receiver: bool, language: &str, from_file: u32) -> bool {
        let named = crate::names::leaf(callee);
        let declared = match (has_receiver || callee.contains("::"), language) {
            (false, "rust" | "python" | "javascript" | "typescript" | "go" | "php") => &self.free_names,
            _ => &self.own_names,
        };
        let Some(declaring) = declared.get(named) else { return false };
        if !declaring.iter().any(|file| self.visible.can_see(from_file, *file))
            || crate::builtins::is_builtin(language, named)
            || crate::builtins::is_standard_member(language, named)
            || is_runtime_member(named)
        {
            return false;
        }
        let Some((qualifier, _)) = callee.rsplit_once("::") else { return true };
        let root = qualifier.split("::").next().unwrap_or(qualifier);
        let owner = qualifier.rsplit("::").next().unwrap_or(qualifier);
        if self.enum_names.contains(owner) || matches!(root, "std" | "core" | "alloc") {
            return false;
        }
        matches!(root, "crate" | "self" | "super" | "Self") || self.qualifiers.contains(root) || self.qualifiers.contains(owner)
    }
}

fn snake_case(name: &str) -> String {
    let mut spelled = String::with_capacity(name.len() + 4);
    for (at, letter) in name.chars().enumerate() {
        if letter.is_uppercase() {
            if at > 0 {
                spelled.push('_');
            }
            spelled.extend(letter.to_lowercase());
        } else {
            spelled.push(letter);
        }
    }
    spelled
}

fn last_segment(receiver: &str) -> &str {
    segments(receiver).last().unwrap_or(receiver)
}

fn parent_of(edges: &[IndexEdge], owner: &str) -> Option<String> {
    edges
        .iter()
        .find(|edge| edge.kind == EdgeKind::Extends && edge.source == owner)
        .map(|edge| edge.target.clone())
}

#[cfg(test)]
mod receivers {
    use super::{segments, snake_case};

    #[test]
    fn a_dot_inside_arguments_does_not_split_the_receiver() {
        let parts: Vec<&str> = segments("Report.new(Account.find(id), year).tally").collect();
        assert_eq!(parts, ["Report", "new", "tally"]);
    }

    #[test]
    fn a_safe_navigation_marker_is_not_part_of_the_name() {
        let parts: Vec<&str> = segments("refresh&.status").collect();
        assert_eq!(parts, ["refresh", "status"]);
    }

    #[test]
    fn a_constant_namespace_is_spelled_as_its_directory() {
        assert_eq!(snake_case("ActionController"), "action_controller");
        assert_eq!(snake_case("Api"), "api");
    }
}

#[cfg(test)]
mod beneath {
    use super::{Beneath, without_suffix};

    fn scanned(files: &[String], dotted: &str) -> Option<u32> {
        let rest = dotted.replace('.', "/");
        let beneath = format!("/{rest}");
        let within = format!("/{rest}/__init__");
        let mut found = None;
        for (at, path) in files.iter().enumerate() {
            let base = without_suffix(path);
            if base != rest && !base.ends_with(&beneath) && !base.ends_with(&within) {
                continue;
            }
            if found.is_some() {
                return None;
            }
            found = Some(at as u32);
        }
        found
    }

    #[test]
    fn a_module_is_found_beneath_the_same_way_it_was_searched_for() {
        let files: Vec<String> = [
            "app/models/user.py",
            "app/models/__init__.py",
            "app/views/user.py",
            "lib/core/__init__.py",
            "lib/core/engine.py",
            "top.py",
            "pkg/__init__.py",
            "src/utils/helpers.ts",
        ]
        .iter()
        .map(|held| held.to_string())
        .collect();
        let indexed = Beneath::over(&files);
        for dotted in [
            "user", "models.user", "app.models.user", "views.user", "models", "app.models",
            "core", "lib.core", "core.engine", "engine", "top", "pkg", "helpers", "utils.helpers",
            "missing", "app", "__init__", "models.__init__",
        ] {
            assert_eq!(indexed.find(dotted), scanned(&files, dotted), "{dotted}");
        }
    }
}

use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::externals;
use crate::language_tables::SOURCE_EXTENSIONS;
use crate::model::*;
use crate::paths::{directory_of, join, normalize};

const FORWARDED_AT_MOST: u8 = 6;

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

pub struct Resolution {
    pub edges: Vec<IndexEdge>,
    pub external_nodes: Vec<IndexNode>,
    pub modules: HashMap<(u32, String), String>,
    pub local: HashMap<(u32, String), String>,
    pub unique_units: HashMap<String, String>,
    pub call_origins: HashMap<(String, String), String>,
    pub method_owners: HashMap<String, String>,
    pub internal_specifiers: HashSet<String>,
    pub through: HashMap<(u32, String), String>,
    pub package_calls: u32,
    pub runtime_calls: u32,
    pub indirect_calls: u32,
    pub dynamic_calls: u32,
    pub unresolved_calls: u32,
    pub no_caller: u32,
    pub unresolved_names: HashMap<String, u32>,
    pub guessed: HashSet<(String, String)>,
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
    unique_type: HashMap<&'a str, u32>,
    unique_unit: HashMap<&'a str, u32>,
    unique_member: HashMap<&'a str, u32>,
    unique_extension: HashMap<&'a str, u32>,
    extension: HashMap<(&'a str, &'a str), u32>,
    declared_members: HashSet<&'a str>,
    owner: Vec<Option<u32>>,
}

struct Bindings<'a> {
    imported: HashMap<(u32, &'a str), u32>,
    module_files: HashMap<(u32, &'a str), u32>,
    through: HashMap<(u32, &'a str), &'a str>,
    modules: HashMap<(u32, &'a str), &'a str>,
    locals: HashMap<(&'a str, &'a str), &'a str>,
    file_locals: HashMap<(u32, &'a str), &'a str>,
    opened: HashMap<u32, Vec<&'a str>>,
    stands_for: HashMap<(&'a str, &'a str), &'a str>,
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
            unique_type: HashMap::default(),
            unique_unit: HashMap::default(),
            unique_member: HashMap::default(),
            unique_extension: HashMap::default(),
            extension: HashMap::default(),
            declared_members: HashSet::default(),
            owner: vec![None; nodes.len()],
        };
        for (at, node) in nodes.iter().enumerate() {
            symbols.position.insert(node.id.as_str(), at as u32);
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
                symbols.members.entry((owner, node.name.as_str())).or_insert(at);
                symbols.declared_members.insert(node.name.as_str());
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
            if node.kind.is_type() {
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

    fn member(&self, owner: u32, name: &str) -> Option<u32> {
        self.members.get(&(owner, name)).copied()
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

static HOLDERS: &[&str] = &["Lazy", "Provider"];
const OUTER_TYPES_AT_MOST: usize = 3;
static HOLDER_ACCESSORS: &[&str] = &["get", "value"];
static CALLED_AS_A_FUNCTION: &[&str] = &["__call__", "callAsFunction", "invoke"];

fn base_type_name(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']);
    let end = annotation
        .find(['<', '[', '(', ' ', '|', '?', ';'])
        .unwrap_or(annotation.len());
    let name = annotation[..end].trim().trim_end_matches('.');
    if annotation[end..].starts_with('[') {
        return "Array";
    }
    match name {
        "string" => "String",
        "number" => "Number",
        "boolean" => "Boolean",
        "symbol" => "Symbol",
        "bigint" => "BigInt",
        "object" => "Object",
        other => other,
    }
}

fn qualifier_of(annotation: &str) -> Option<&str> {
    let trimmed = annotation.trim().trim_start_matches(['&', '*']);
    let end = trimmed
        .find(['<', '[', '(', ' ', '|', '?', ';'])
        .unwrap_or(trimmed.len());
    trimmed[..end].split_once('.').map(|(head, _)| head)
}

fn segments(path: &str) -> impl Iterator<Item = &str> {
    path.split('.').map(|segment| {
        let end = segment.find(['[', '(', '!', '?']).unwrap_or(segment.len());
        &segment[..end]
    })
}

impl<'a> Bindings<'a> {
    fn annotation(&self, unit: &str, file: u32, name: &'a str) -> Option<&'a str> {
        self.locals
            .get(&(unit, name))
            .or_else(|| self.file_locals.get(&(file, name)))
            .copied()
    }
}

struct Resolver<'a> {
    symbols: Symbols<'a>,
    bindings: Bindings<'a>,
    runtime: Vec<&'static str>,
    visible: crate::visibility::Visibility,
    types_named: HashMap<&'a str, Vec<u32>>,
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
            .or_else(|| self.symbols.file_scope.get(&(file, name)))
            .copied()
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

    fn annotated(&self, file: u32, annotation: &'a str) -> Origin<'a> {
        if HOLDERS.contains(&base_type_name(annotation))
            && let Some(held) = sole_type_argument(annotation)
        {
            return self.annotated(file, held);
        }
        if let Some(found) = self.named_type(file, annotation) {
            return Origin::Declared(found);
        }
        let name = base_type_name(annotation);
        if self.runtime.binary_search(&name).is_ok() {
            return Origin::Runtime(name);
        }
        if let Some(qualifier) = qualifier_of(annotation)
            && let Some(specifier) = self.bindings.modules.get(&(file, qualifier))
        {
            return Origin::Package(specifier);
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
        if bare == "this" || bare == "self" {
            return match self.symbols.owning_type(unit) {
                Some(owner) => Origin::Declared(owner),
                None => Origin::Unknown,
            };
        }
        let holder = &self.symbols.nodes[unit as usize];
        if let Some(signature) = holder.signature.as_ref()
            && let Some(parameter) =
                signature.parameters.iter().find(|p| p.name == name || p.name == bare)
        {
            return match parameter.type_annotation.as_deref() {
                Some(annotation) => match self.annotated(file, annotation) {
                    Origin::Unknown => Origin::Indirect,
                    known => known,
                },
                None => Origin::Indirect,
            };
        }
        if let Some(expression) = self.stood_for(unit, name) {
            return self.origin(unit, file, expression);
        }
        if let Some(annotation) = self
            .bindings
            .annotation(&holder.id, file, name)
            .or_else(|| self.bindings.annotation(&holder.id, file, bare))
        {
            return self.annotated(file, annotation);
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
            .or_else(|| self.symbols.file_scope.get(&(file, name)))
            .copied()
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
        Origin::Unknown
    }

    fn returned(&self, member: &str) -> Origin<'a> {
        match runtime_member(member) {
            Some(entry) if !entry.returns.is_empty() => Origin::Runtime(entry.returns),
            _ => Origin::Unknown,
        }
    }

    fn origin(&self, unit: u32, file: u32, path: &'a str) -> Origin<'a> {
        let bare = path.trim().trim_start_matches('(').trim_end_matches(')').trim();
        if let Some(built) = bare.strip_prefix("new ") {
            let named = built.split(['(', ')', ' ', '<', '{']).next().unwrap_or(built).trim();
            if !named.is_empty() {
                return self.annotated(file, named);
            }
        }
        let mut parts = segments(path);
        let Some(first) = parts.next() else {
            return Origin::Unknown;
        };
        let mut origin = self.root(unit, file, first);
        let mut held = self.held(unit, file, first);
        for part in parts {
            origin = match origin {
                Origin::Declared(owner) if self.symbols.nodes[owner as usize].kind.is_type() && part == "new" => {
                    Origin::Declared(owner)
                }
                Origin::Declared(owner) if self.symbols.nodes[owner as usize].kind.is_type() => {
                    let unwrapped = held
                        .filter(|annotation| HOLDERS.contains(&base_type_name(annotation)))
                        .filter(|_| HOLDER_ACCESSORS.contains(&part))
                        .and_then(sole_type_argument);
                    if let Some(inner) = unwrapped
                        && self.symbols.member_type(owner, part).is_none()
                    {
                        held = Some(inner);
                        origin = Origin::Declared(owner);
                        continue;
                    }
                    held = self.symbols.member_type(owner, part);
                    match held {
                        Some(annotation) => {
                            self.annotated(self.symbols.nodes[owner as usize].file, annotation)
                        }
                        None => Origin::Unknown,
                    }
                }
                Origin::Package(specifier) => Origin::Package(specifier),
                _ if part == "value" => match held.and_then(sole_type_argument) {
                    Some(inner) => {
                        held = Some(inner);
                        self.annotated(file, inner)
                    }
                    None => {
                        held = None;
                        self.returned(part)
                    }
                },
                _ => {
                    held = None;
                    self.returned(part)
                }
            };
        }
        origin
    }

    fn held(&self, unit: u32, file: u32, name: &'a str) -> Option<&'a str> {
        let holder = &self.symbols.nodes[unit as usize];
        if let Some(signature) = holder.signature.as_ref()
            && let Some(parameter) = signature.parameters.iter().find(|p| p.name == name)
            && let Some(annotation) = parameter.type_annotation.as_deref()
        {
            return Some(annotation);
        }
        if let Some(annotation) = self.bindings.annotation(&holder.id, file, name) {
            return Some(annotation);
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
    let base = match rest.is_empty() {
        true => folder.to_string(),
        false => format!("{folder}/{rest}"),
    };
    for candidate in [format!("{base}.py"), format!("{base}/__init__.py")] {
        if let Some(found) = files.get(candidate.as_str()) {
            return Some(*found);
        }
    }
    None
}

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
    Unresolved(String),
    Edge(String, EdgeKind),
    Guessed(String, EdgeKind),
    External {
        space: &'static str,
        owner: String,
        member: String,
        kind: EdgeKind,
        origin: Option<(String, String)>,
    },
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
        opened: HashMap::default(),
        stands_for: HashMap::default(),
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
            if let Some(found) = declared.or_else(|| reached.iter().find_map(|target| declared_through(*target, wanted))) {
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
            .file_scope
            .get(&(fact.file, name))
            .copied()
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
            let owner = index.nodes[owner as usize].id.clone();
            edges.push(IndexEdge {
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
        let annotation = binding
            .annotation
            .as_deref()
            .or(binding.constructed.as_deref())
            .or_else(|| {
                let callee = crate::names::leaf(binding.from_call.as_deref()?);
                match symbols.unique_unit.get(callee) {
                    Some(unit) => index.nodes[*unit as usize]
                        .signature
                        .as_ref()?
                        .return_type
                        .as_deref(),
                    None => runtime_member(callee)
                        .map(|entry| entry.returns)
                        .filter(|returns| !returns.is_empty()),
                }
            });
        let Some(annotation) = annotation else { continue };
        if binding.unit.is_empty() {
            bindings
                .file_locals
                .insert((binding.file, binding.name.as_str()), annotation);
        } else {
            bindings
                .locals
                .insert((binding.unit.as_str(), binding.name.as_str()), annotation);
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
    }
    let resolver = Resolver {
        symbols,
        bindings,
        runtime: externals::sorted_runtime_globals(),
        visible: crate::visibility::Visibility::build(index.files, index.nodes),
        types_named,
    };
    let symbols = &resolver.symbols;

    let mut external_nodes: HashMap<String, IndexNode> = HashMap::default();

    let mut supertypes: HashMap<u32, Vec<u32>> = HashMap::default();
    for fact in index.type_references {
        if !matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements) {
            continue;
        }
        let Some(source) = symbols.position.get(fact.source.as_str()).copied() else {
            continue;
        };
        if let Origin::Declared(found) = resolver.annotated(fact.file, &fact.name)
            && found != source
        {
            supertypes.entry(source).or_default().push(found);
        }
    }

    let inherited = |owner: u32, name: &str| -> Option<u32> {
        let mut seen = HashSet::default();
        let mut pending = vec![owner];
        while let Some(at) = pending.pop() {
            if !seen.insert(at) {
                continue;
            }
            if let Some(found) = symbols.member(at, name) {
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

    let mut unresolved_names: HashMap<String, u32> = HashMap::default();
    let mut guessed: HashSet<(String, String)> = HashSet::default();
    let mut call_origins: HashMap<(String, String), String> = HashMap::default();
    for (unit, name, root) in made_by {
        call_origins.entry((unit, name)).or_insert(root);
    }
    let mut package_calls = 0;
    let mut runtime_calls = 0;
    let mut indirect_calls = 0;
    let mut dynamic_calls = 0;
    let mut unresolved_calls = 0;
    let mut no_caller = 0;

    lap("before calls");
    let settled_edges = &edges;
    let resolve_call = |fact: &'a CallFact| -> Resolved {
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

        if fact.receiver.is_none() && fact.callee == "import" {
            return Resolved::Dynamic;
        }
        if fact.receiver.is_none() && fact.callee == "super"
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

        let origin = match fact.receiver.as_deref() {
            Some(receiver) => resolver.origin(unit, fact.file, receiver),
            None => resolver.root(unit, fact.file, &fact.callee),
        };

        match (origin, fact.receiver.as_deref()) {
            (Origin::Declared(found), Some(_)) => {
                let node = &symbols.nodes[found as usize];
                match inherited(found, &fact.callee) {
                    Some(member) => {
                        let target = match node.kind.is_type() {
                            true => overridden_within(member, found).unwrap_or(member),
                            false => member,
                        };
                        return Resolved::Edge(symbols.nodes[target as usize].id.clone(), kind);
                    }
                    None if node.kind.is_unit() => {
                        return Resolved::Edge(node.id.clone(), kind);
                    }
                    None if node.kind.is_type() && HOLDER_ACCESSORS.contains(&fact.callee.as_str()) => {
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
                let through_a_value = node.kind.is_type() && !fact.constructs && node.name != fact.callee;
                if through_a_value
                    && let Some(called) = CALLED_AS_A_FUNCTION.iter().find_map(|named| inherited(found, named))
                {
                    let target = overridden_within(called, found).unwrap_or(called);
                    return Resolved::Edge(symbols.nodes[target as usize].id.clone(), kind);
                }
                return Resolved::Edge(node.id.clone(), kind);
            }
            (Origin::Module(held), Some(_)) => {
                if let Some(found) =
                    symbols.file_scope.get(&(held, fact.callee.as_str())).copied()
                {
                    return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
                }
            }
            (Origin::Indirect, None) => {
                return Resolved::Indirect;
            }
            _ => {}
        }

        let member = match fact.receiver.as_deref() {
            Some(receiver) => format!("{}.{}", last_segment(receiver), fact.callee),
            None => fact.callee.clone(),
        };

        if fact.receiver.is_some()
            && let Some(found) = resolver
                .bindings
                .imported
                .get(&(fact.file, fact.callee.as_str()))
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

        let external = match origin {
            Origin::Package(specifier) => Some(("package", specifier.to_string(), member.clone())),
            Origin::Runtime(name) => Some((
                "runtime",
                name.to_string(),
                format!("{name}.{}", fact.callee),
            )),
            _ => runtime_member(&fact.callee)
                .filter(|entry| {
                    !entry.owner.is_empty()
                        && !symbols.declared_members.contains(fact.callee.as_str())
                })
                .map(|entry| {
                    (
                        "runtime",
                        entry.owner.to_string(),
                        format!("{}.{}", entry.owner, fact.callee),
                    )
                }),
        };

        if let Some((space, owner, member)) = external {
            let origin = (space == "package")
                .then(|| fact.receiver.as_deref())
                .flatten()
                .map(|receiver| (caller.to_string(), receiver.to_string()));
            return Resolved::External { space, owner, member, kind, origin };
        }

        if fact.receiver.is_none()
            && let Some(extended) = extended_by(unit)
            && let Some(member) = inherited(extended, &fact.callee)
        {
            return Resolved::Edge(symbols.nodes[member as usize].id.clone(), kind);
        }
        if fact.receiver.is_none()
            && let Some(found) = symbols.unique_unit.get(fact.callee.as_str()).copied()
        {
            return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
        }
        if fact.receiver.is_none()
            && let Some(found) = symbols.unique_type.get(fact.callee.as_str()).copied()
        {
            let built = symbols.member(found, "constructor").unwrap_or(found);
            return Resolved::Edge(symbols.nodes[built as usize].id.clone(), EdgeKind::Instantiates);
        }
        if let Some(receiver) = fact.receiver.as_deref()
            && let Some(found) = symbols.unique_member.get(fact.callee.as_str()).copied()
        {
            let target = symbols.nodes[found as usize].id.clone();
            let spoken = receiver
                .rsplit(['.', '>', ':'])
                .next()
                .unwrap_or(receiver)
                .trim_start_matches(['$', '@', '_'])
                .to_ascii_lowercase();
            let names_its_owner = symbols.owning_type(found).is_some_and(|owner| {
                let owner = symbols.nodes[owner as usize].name.to_ascii_lowercase();
                owner.len() >= 3 && spoken.contains(owner.trim_start_matches('i'))
            });
            return match names_its_owner {
                true => Resolved::Edge(target, kind),
                false => Resolved::Guessed(target, kind),
            };
        }
        if let Some(receiver) = fact.receiver.as_deref() {
            let extended = match origin {
                Origin::Declared(found) if symbols.nodes[found as usize].kind.is_type() => {
                    Some(symbols.nodes[found as usize].name.as_str())
                }
                _ => resolver.bindings.annotation(caller, fact.file, last_segment(receiver)),
            };
            let typed = extended.and_then(|owner| {
                symbols
                    .extension
                    .get(&(last_segment(owner), fact.callee.as_str()))
                    .copied()
            });
            let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
            let imported = resolver
                .bindings
                .modules
                .get(&(fact.file, fact.callee.as_str()))
                .copied();
            let found = typed.or_else(|| {
                if imported.is_some() || crate::builtins::is_builtin(language, &fact.callee) {
                    return None;
                }
                symbols.unique_extension.get(fact.callee.as_str()).copied()
            });
            if let Some(found) = found {
                return Resolved::Edge(symbols.nodes[found as usize].id.clone(), kind);
            }
            if let Some(specifier) = imported {
                return Resolved::External {
                    space: "package",
                    owner: specifier.to_string(),
                    member: format!("{specifier}.{}", fact.callee),
                    kind,
                    origin: None,
                };
            }
        }

        let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
        if fact.receiver.is_none() && crate::builtins::is_builtin(language, &fact.callee) {
            return Resolved::External {
                space: "runtime",
                owner: language.to_string(),
                member: format!("{language}.{}", fact.callee),
                kind,
                origin: None,
            };
        }
        if !crate::builtins::is_builtin(language, &fact.callee)
            && !declared_anywhere.contains(fact.callee.as_str())
            && let Some(specifier) = sole_package.get(&fact.file).copied()
            && !specifier.is_empty()
        {
            return Resolved::External { space: "package", owner: specifier.to_string(), member, kind, origin: None };
        }

        Resolved::Unresolved(member)
    };
    let resolved: Vec<Resolved> = index.calls.par_iter().map(resolve_call).collect();
    lap("calls resolved");
    let mut ours: HashMap<&str, u32> = HashMap::default();
    for (fact, outcome) in index.calls.iter().zip(&resolved) {
        if matches!(outcome, Resolved::Unresolved(_))
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
    let visible = &resolver.visible;
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
    for (fact, outcome) in index.calls.iter().zip(resolved) {
        let caller = fact.caller.as_deref().unwrap_or_default();
        let outcome = match outcome {
            Resolved::Edge(target, kind) => match carried_out(&target, fact.file) {
                Some(carried) => Resolved::Edge(carried, kind),
                None => Resolved::Edge(target, kind),
            },
            other => other,
        };
        match outcome {
            Resolved::NoCaller => no_caller += 1,
            Resolved::Dynamic => dynamic_calls += 1,
            Resolved::Indirect => indirect_calls += 1,
            Resolved::Unresolved(member) => {
                *unresolved_names.entry(member).or_insert(0) += 1;
                unresolved_calls += 1;
            }
            Resolved::Edge(target, kind) => edges.push(IndexEdge { source: caller.to_string(), target, kind }),
            Resolved::Guessed(target, kind) => {
                guessed.insert((caller.to_string(), target.clone()));
                edges.push(IndexEdge { source: caller.to_string(), target, kind });
            }
            Resolved::External { space, owner, member, kind, origin } => {
                if let Some(origin) = origin {
                    call_origins.insert(origin, owner.clone());
                }
                let target = declare_external(&mut external_nodes, space, &owner, &member);
                edges.push(IndexEdge { source: caller.to_string(), target, kind });
                match space {
                    "package" => package_calls += 1,
                    _ => runtime_calls += 1,
                }
            }
        }
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
        unique_units: symbols
            .unique_unit
            .iter()
            .map(|(name, at)| ((*name).to_string(), symbols.nodes[*at as usize].id.clone()))
            .collect(),
        call_origins,
        guessed,
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

use std::collections::{HashMap, HashSet};

use crate::externals;
use crate::language_tables::SOURCE_EXTENSIONS;
use crate::model::*;
use crate::paths::{directory_of, normalize};

pub struct Index<'a> {
    pub files: &'a [String],
    pub languages: &'a [&'a str],
    pub namespaces: &'a [&'a str],
    pub nodes: &'a [IndexNode],
    pub imports: &'a [ImportFact],
    pub calls: &'a [CallFact],
    pub type_references: &'a [TypeReferenceFact],
    pub locals: &'a [LocalBinding],
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
    pub package_calls: u32,
    pub runtime_calls: u32,
    pub indirect_calls: u32,
    pub dynamic_calls: u32,
    pub unresolved_calls: u32,
    pub no_caller: u32,
    pub unresolved_names: HashMap<String, u32>,
}

#[derive(Clone, Copy)]
enum Origin<'a> {
    Declared(u32),
    Runtime(&'a str),
    Package(&'a str),
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
    modules: HashMap<(u32, &'a str), &'a str>,
    locals: HashMap<(&'a str, &'a str), &'a str>,
    file_locals: HashMap<(u32, &'a str), &'a str>,
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
            position: HashMap::with_capacity(nodes.len()),
            file_scope: HashMap::new(),
            exported: HashMap::new(),
            members: HashMap::new(),
            unique_type: HashMap::new(),
            unique_unit: HashMap::new(),
            unique_member: HashMap::new(),
            unique_extension: HashMap::new(),
            extension: HashMap::new(),
            declared_members: HashSet::new(),
            owner: vec![None; nodes.len()],
        };
        for (at, node) in nodes.iter().enumerate() {
            symbols.position.insert(node.id.as_str(), at as u32);
        }

        let mut types: HashMap<&str, (u32, u32)> = HashMap::new();
        let mut units: HashMap<&str, (u32, u32)> = HashMap::new();
        let mut member_names: HashMap<&str, (u32, u32)> = HashMap::new();
        let mut extension_names: HashMap<&str, (u32, u32)> = HashMap::new();

        for (at, node) in nodes.iter().enumerate() {
            let at = at as u32;
            if node.kind == NodeKind::Module {
                continue;
            }
            if let Some(parent) = node.parent.as_deref()
                && let Some(owner) = symbols.position.get(parent).copied()
                && nodes[owner as usize].kind.is_type()
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
        let member = &self.nodes[self.member(owner, name)? as usize];
        member.type_annotation.as_deref().or_else(|| {
            member.signature.as_ref()?.return_type.as_deref().filter(|returns| !returns.is_empty())
        })
    }
}

struct RuntimeMember {
    name: &'static str,
    owner: &'static str,
    returns: &'static str,
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
            .filter(|found| self.symbols.nodes[*found as usize].kind.is_type())
    }

    fn annotated(&self, file: u32, annotation: &'a str) -> Origin<'a> {
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
        Origin::Unknown
    }

    fn root(&self, unit: u32, file: u32, name: &'a str) -> Origin<'a> {
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
        if let Some(annotation) = self
            .bindings
            .annotation(&holder.id, file, name)
            .or_else(|| self.bindings.annotation(&holder.id, file, bare))
        {
            return self.annotated(file, annotation);
        }
        if let Some(owner) = self.symbols.owning_type(unit)
            && let Some(signature) = self.symbols.nodes[owner as usize].signature.as_ref()
            && let Some(parameter) =
                signature.parameters.iter().find(|p| p.name == name || p.name == bare)
            && let Some(annotation) = parameter.type_annotation.as_deref()
        {
            return match self.annotated(file, annotation) {
                Origin::Unknown => Origin::Indirect,
                known => known,
            };
        }
        if let Some(owner) = self.symbols.owning_type(unit)
            && let Some(member) =
                self.symbols.member(owner, name).or_else(|| self.symbols.member(owner, bare))
        {
            let held = &self.symbols.nodes[member as usize];
            if !held.kind.is_type()
                && let Some(annotation) = held.type_annotation.as_deref()
                && let Origin::Declared(found) = self.annotated(held.file, annotation)
            {
                return Origin::Declared(found);
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
        let mut parts = segments(path);
        let Some(first) = parts.next() else {
            return Origin::Unknown;
        };
        let mut origin = self.root(unit, file, first);
        let mut held = self.held(unit, file, first);
        for part in parts {
            origin = match origin {
                Origin::Declared(owner) if self.symbols.nodes[owner as usize].kind.is_type() => {
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
        let mut declaring: HashMap<String, Option<u32>> = HashMap::new();
        let mut condensed: HashMap<String, Option<u32>> = HashMap::new();
        let mut holding = HashSet::new();
        let mut rooted = HashSet::new();
        let mut packaged: HashMap<String, Vec<u32>> = HashMap::new();
        for (at, path) in files.iter().enumerate() {
            let language = family(languages[at]);
            packaged
                .entry(format!("{language}\u{1}{}", directory_of(path)))
                .or_default()
                .push(at as u32);
            let key = module_key(path);
            let plain = without_containers(&key);
            if let Some((root, _)) = key.split_once('/') {
                rooted.insert(format!("{language}\u{1}{root}"));
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
    let mut declared: HashMap<String, Vec<u32>> = HashMap::new();
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
    let Some(members) = declared.get(&format!("{language}\u{1}{owner}")) else {
        return Vec::new();
    };
    members
        .iter()
        .copied()
        .filter(|found| named.contains(&(*found, leaf.to_string())))
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

pub fn resolve(index: &Index) -> Resolution {
    let mut symbols = Symbols::build(index.nodes);
    let by_path: HashMap<&str, u32> = index
        .files
        .iter()
        .enumerate()
        .map(|(at, path)| (path.as_str(), at as u32))
        .collect();

    let mut edges = Vec::new();
    let mut internal_specifiers: HashSet<String> = HashSet::new();
    let by_module = Modules::build(index.files, index.languages);
    let by_namespace = namespaces(index);
    let named: HashSet<(u32, String)> = symbols
        .file_scope
        .keys()
        .map(|(file, name)| (*file, name.to_ascii_lowercase()))
        .collect();
    let mut declared_by: HashMap<String, Vec<u32>> = HashMap::new();
    for (file, name) in &named {
        declared_by.entry(name.clone()).or_default().push(*file);
    }
    let mut referenced: HashMap<u32, HashSet<String>> = HashMap::new();
    for fact in index.type_references {
        referenced
            .entry(fact.file)
            .or_default()
            .insert(base_type_name(&fact.name).to_ascii_lowercase());
    }
    for fact in index.calls {
        let entry = referenced.entry(fact.file).or_default();
        entry.insert(crate::names::leaf(&fact.callee).to_ascii_lowercase());
        if let Some(receiver) = fact.receiver.as_deref() {
            entry.insert(crate::names::root(receiver).to_ascii_lowercase());
        }
    }
    let aliases = crate::alias::Aliases::read(index.files, index.nodes);
    let mut bindings = Bindings {
        imported: HashMap::new(),
        modules: HashMap::new(),
        locals: HashMap::new(),
        file_locals: HashMap::new(),
    };

    for fact in index.imports {
        let from = index.files[fact.file as usize].as_str();
        let language = index.languages[fact.file as usize];
        let declared = file_index(&by_path, from, &fact.specifier)
            .or_else(|| {
                aliases
                    .expand(from, &fact.specifier)
                    .iter()
                    .find_map(|path| module_file(&by_path, path))
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
        let reached: Vec<u32> = reached
            .into_iter()
            .filter(|found| index.files[*found as usize] != from)
            .collect();
        if reached.is_empty() {
            if aliases.declares(from, &fact.specifier) || by_module.held(language, &fact.specifier) {
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
                bindings
                    .modules
                    .insert((fact.file, name.local.as_str()), fact.specifier.as_str());
            }
            continue;
        }
        internal_specifiers.insert(fact.specifier.clone());
        for target in &reached {
            edges.push(IndexEdge {
                source: from.to_string(),
                target: index.files[*target as usize].clone(),
                kind: EdgeKind::Imports,
            });
        }
        for name in &fact.names {
            let wanted = name.imported.as_deref().unwrap_or(name.local.as_str());
            if let Some(found) = reached.iter().find_map(|target| {
                symbols
                    .exported
                    .get(&(*target, wanted))
                    .or_else(|| symbols.file_scope.get(&(*target, wanted)))
                    .copied()
            }) {
                bindings.imported.insert((fact.file, name.local.as_str()), found);
            }
        }
    }

    let mut owners: HashMap<String, String> = HashMap::new();
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

    for binding in index.locals {
        let annotation = binding
            .annotation
            .as_deref()
            .or(binding.constructed.as_deref())
            .or_else(|| {
                let callee = binding.from_call.as_deref()?;
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

    let resolver = Resolver {
        symbols,
        bindings,
        runtime: externals::sorted_runtime_globals(),
    };
    let symbols = &resolver.symbols;

    let mut external_nodes: HashMap<String, IndexNode> = HashMap::new();

    let mut supertypes: HashMap<u32, Vec<u32>> = HashMap::new();
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
        let mut seen = HashSet::new();
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

    let mut sole_package: HashMap<u32, &str> = HashMap::new();
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

    let mut unresolved_names: HashMap<String, u32> = HashMap::new();
    let mut call_origins: HashMap<(String, String), String> = HashMap::new();
    let mut package_calls = 0;
    let mut runtime_calls = 0;
    let mut indirect_calls = 0;
    let mut dynamic_calls = 0;
    let mut unresolved_calls = 0;
    let mut no_caller = 0;

    for fact in index.calls {
        let Some(caller) = fact.caller.as_deref() else {
            no_caller += 1;
            continue;
        };
        let Some(unit) = symbols.position.get(caller).copied() else {
            no_caller += 1;
            continue;
        };
        let kind = if fact.constructs {
            EdgeKind::Instantiates
        } else {
            EdgeKind::Calls
        };

        if fact.receiver.is_none() && fact.callee == "import" {
            dynamic_calls += 1;
            continue;
        }
        if fact.receiver.is_none() && fact.callee == "super"
            && let Some(parent) = symbols
                .owning_type(unit)
                .and_then(|owner| parent_of(&edges, &symbols.nodes[owner as usize].id))
                .and_then(|parent| symbols.position.get(parent.as_str()).copied())
            {
                let target = symbols
                    .member(parent, "constructor")
                    .unwrap_or(parent);
                edges.push(IndexEdge {
                    source: caller.to_string(),
                    target: symbols.nodes[target as usize].id.clone(),
                    kind,
                });
                continue;
            }

        let origin = match fact.receiver.as_deref() {
            Some(receiver) => resolver.origin(unit, fact.file, receiver),
            None => resolver.root(unit, fact.file, &fact.callee),
        };

        let mut emit = |target: String| {
            edges.push(IndexEdge {
                source: caller.to_string(),
                target,
                kind,
            })
        };

        match (origin, fact.receiver.as_deref()) {
            (Origin::Declared(found), Some(_)) => {
                let node = &symbols.nodes[found as usize];
                match inherited(found, &fact.callee) {
                    Some(member) => {
                        emit(symbols.nodes[member as usize].id.clone());
                        continue;
                    }
                    None if node.kind.is_unit() => {
                        emit(node.id.clone());
                        continue;
                    }
                    None => {}
                }
            }
            (Origin::Declared(found), None) => {
                emit(symbols.nodes[found as usize].id.clone());
                continue;
            }
            (Origin::Indirect, None) => {
                indirect_calls += 1;
                continue;
            }
            _ => {}
        }

        let member = match fact.receiver.as_deref() {
            Some(receiver) => format!("{}.{}", last_segment(receiver), fact.callee),
            None => fact.callee.clone(),
        };

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
            if space == "package"
                && let Some(receiver) = fact.receiver.as_deref()
            {
                call_origins.insert((caller.to_string(), receiver.to_string()), owner.clone());
            }
            emit(declare_external(&mut external_nodes, space, &owner, &member));
            if space == "package" {
                package_calls += 1;
            } else {
                runtime_calls += 1;
            }
            continue;
        }

        if fact.receiver.is_none()
            && let Some(found) = symbols.unique_unit.get(fact.callee.as_str()).copied()
        {
            emit(symbols.nodes[found as usize].id.clone());
            continue;
        }
        if fact.receiver.is_none()
            && let Some(found) = symbols.unique_type.get(fact.callee.as_str()).copied()
        {
            let built = symbols.member(found, "constructor").unwrap_or(found);
            edges.push(IndexEdge {
                source: caller.to_string(),
                target: symbols.nodes[built as usize].id.clone(),
                kind: EdgeKind::Instantiates,
            });
            continue;
        }
        if fact.receiver.is_some()
            && let Some(found) = symbols.unique_member.get(fact.callee.as_str()).copied()
        {
            emit(symbols.nodes[found as usize].id.clone());
            continue;
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
                emit(symbols.nodes[found as usize].id.clone());
                continue;
            }
            if let Some(specifier) = imported {
                emit(declare_external(
                    &mut external_nodes,
                    "package",
                    specifier,
                    &format!("{specifier}.{}", fact.callee),
                ));
                package_calls += 1;
                continue;
            }
        }

        let language = index.languages.get(fact.file as usize).copied().unwrap_or("");
        if fact.receiver.is_none() && crate::builtins::is_builtin(language, &fact.callee) {
            emit(declare_external(
                &mut external_nodes,
                "runtime",
                language,
                &format!("{language}.{}", fact.callee),
            ));
            runtime_calls += 1;
            continue;
        }
        if !crate::builtins::is_builtin(language, &fact.callee)
            && !declared_anywhere.contains(fact.callee.as_str())
            && let Some(specifier) = sole_package.get(&fact.file).copied()
            && !specifier.is_empty()
        {
            emit(declare_external(&mut external_nodes, "package", specifier, &member));
            package_calls += 1;
            continue;
        }

        *unresolved_names.entry(member).or_insert(0) += 1;
        unresolved_calls += 1;
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
        method_owners: owners,
        internal_specifiers,
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

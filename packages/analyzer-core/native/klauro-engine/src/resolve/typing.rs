use std::cell::Cell;

use super::*;

thread_local! {
    static DEPTH: Cell<u8> = const { Cell::new(0) };
    static SLOT: Cell<u8> = const { Cell::new(0) };
}

const RESULTS_WITHIN: u8 = 5;

struct Depth;

impl Depth {
    fn enter() -> Option<Depth> {
        DEPTH.with(|depth| {
            if depth.get() >= RESULTS_WITHIN {
                return None;
            }
            depth.set(depth.get() + 1);
            Some(Depth)
        })
    }
}

impl Drop for Depth {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

const SHARES_ONE_SCOPE: &[&str] = &["go", "java", "kotlin", "scala", "csharp"];

impl<'a> Symbols<'a> {
    pub(super) fn scope_packages(&mut self, files: &[String], languages: &[&str], namespaces: &[&str]) {
        let mut ids: HashMap<String, u32> = HashMap::default();
        let mut package_of = vec![u32::MAX; files.len()];
        for (at, path) in files.iter().enumerate() {
            let language = languages.get(at).copied().unwrap_or("");
            if !SHARES_ONE_SCOPE.contains(&language) {
                continue;
            }
            let key = match language {
                "go" => format!("go\u{1}{}", directory_of(path)),
                _ => match namespaces.get(at).filter(|namespace| !namespace.is_empty()) {
                    Some(namespace) => format!("{language}\u{1}{namespace}"),
                    None => continue,
                },
            };
            let next = ids.len() as u32;
            package_of[at] = *ids.entry(key).or_insert(next);
        }
        let mut scope: HashMap<(u32, &'a str), u32> = HashMap::default();
        for ((file, name), at) in self.file_scope.iter() {
            let package = package_of[*file as usize];
            if package == u32::MAX {
                continue;
            }
            let held = scope.entry((package, *name)).or_insert(*at);
            if *at < *held {
                *held = *at;
            }
        }
        self.package_of = package_of;
        self.package_scope = scope;
    }

    pub(super) fn in_scope(&self, file: u32, name: &str) -> Option<u32> {
        if let Some(found) = self.file_scope.get(&(file, name)) {
            return Some(*found);
        }
        let package = *self.package_of.get(file as usize)?;
        if package == u32::MAX {
            return None;
        }
        self.package_scope.get(&(package, name)).copied()
    }
}

pub(super) fn names_itself(annotation: &str) -> bool {
    let mut held = annotation;
    for _ in 0..4 {
        match wrapped_type_argument(held) {
            Some(inner) => held = inner,
            None => break,
        }
    }
    base_type_name(held) == "Self"
}

fn literal_type(written: &str) -> Option<&'static str> {
    let first = written.chars().next()?;
    match first {
        '"' | '\'' | '`' => Some("String"),
        '[' => Some("Array"),
        '/' if written[1..].contains('/') && !written.starts_with("//") => Some("RegExp"),
        digit if digit.is_ascii_digit() => Some("Number"),
        _ => None,
    }
}

fn is_tuple(annotation: &str) -> bool {
    annotation.trim_start().starts_with('(')
}

fn tuple_element(annotation: &str, slot: u8) -> Option<&str> {
    if slot == 0 {
        return None;
    }
    let inner = annotation.trim().strip_prefix('(')?.strip_suffix(')')?;
    let element = *top_level_arguments(inner).get(slot as usize - 1)?;
    match element.split_once(' ') {
        Some((name, rest))
            if !rest.is_empty()
                && name.chars().all(|letter| letter.is_alphanumeric() || letter == '_')
                && !matches!(name, "chan" | "map" | "func" | "interface" | "struct" | "mut" | "dyn" | "impl") =>
        {
            Some(rest.trim())
        }
        _ => Some(element),
    }
}

impl<'a> Resolver<'a> {
    pub(super) fn annotated_from(&self, owner: u32, declared_in: u32, annotation: &'a str) -> Origin<'a> {
        let annotation = match self.element_of_tuple(annotation) {
            Ok(held) => held,
            Err(()) => return Origin::Unknown,
        };
        if names_itself(annotation) {
            return Origin::Declared(owner);
        }
        self.annotated(self.symbols.nodes[declared_in as usize].file, annotation)
    }

    pub(super) fn inherited_member_type(&self, owner: u32, name: &str) -> Option<(&'a str, u32)> {
        if let Some(found) = self.symbols.member_type(owner, name) {
            return Some((found, owner));
        }
        let above = self.inherits.get()?;
        let mut pending = vec![owner];
        let mut seen: Vec<u32> = Vec::new();
        while let Some(at) = pending.pop() {
            if seen.contains(&at) || seen.len() > 16 {
                continue;
            }
            seen.push(at);
            if at != owner
                && let Some(found) = self.symbols.member_type(at, name)
            {
                return Some((found, at));
            }
            if let Some(parents) = above.get(&at) {
                pending.extend(parents.iter().rev().copied());
            }
        }
        None
    }

    fn element_of_tuple(&self, annotation: &'a str) -> Result<&'a str, ()> {
        if !is_tuple(annotation) {
            return Ok(annotation);
        }
        tuple_element(annotation, SLOT.with(Cell::get)).ok_or(())
    }

    fn called_in_reach(&self, unit: u32, file: u32, name: &str) -> Option<(&'a str, u8)> {
        let mut current = unit;
        for _ in 0..8 {
            let node = &self.symbols.nodes[current as usize];
            if let Some(call) = self.bindings.called.get(&(node.id.as_str(), name)) {
                return Some(*call);
            }
            if !node.id.contains(":callback:") {
                break;
            }
            current = self.symbols.position.get(node.parent.as_deref()?).copied()?;
        }
        self.bindings.file_called.get(&(file, name)).copied()
    }

    pub(super) fn from_a_call(&self, unit: u32, file: u32, name: &str) -> Origin<'a> {
        let Some((call, slot)) = self.called_in_reach(unit, file, name) else {
            return Origin::Unknown;
        };
        if crate::names::root(call) == name {
            return Origin::Unknown;
        }
        let saved = SLOT.with(|held| held.replace(slot));
        let found = self.result_of(unit, file, call);
        SLOT.with(|held| held.set(saved));
        found
    }

    pub(super) fn result_of(&self, unit: u32, file: u32, call: &'a str) -> Origin<'a> {
        let Some(_depth) = Depth::enter() else {
            return Origin::Unknown;
        };
        let call = call.trim();
        if call.is_empty() {
            return Origin::Unknown;
        }
        if !call.contains(['.']) && !call.contains("::") {
            return match self.root(unit, file, call) {
                Origin::Declared(found) => self.declared_value(found),
                _ => Origin::Unknown,
            };
        }
        self.origin(unit, file, call)
    }

    fn static_path(&self, unit: u32, file: u32, first: &'a str) -> Option<(Origin<'a>, &'a str)> {
        let (head, tail) = first.rsplit_once("::")?;
        if head.is_empty() || head.starts_with('<') || tail.starts_with(char::is_uppercase) {
            return None;
        }
        let origin = match self.root(unit, file, head) {
            Origin::Unknown if self.languages.get(file as usize) == Some(&"rust") => {
                qualified_module_target(self.by_path, self.aliases, self.files, self.languages, file, head)
                    .map(Origin::Module)
                    .unwrap_or(Origin::Unknown)
            }
            other => other,
        };
        match origin {
            Origin::Declared(found) if self.symbols.nodes[found as usize].kind.is_type() => Some((origin, tail)),
            Origin::Module(_) => Some((origin, tail)),
            _ => None,
        }
    }

    pub(super) fn origin(&self, unit: u32, file: u32, path: &'a str) -> Origin<'a> {
        self.origin_held(unit, file, path).0
    }

    pub(super) fn origin_held(&self, unit: u32, file: u32, path: &'a str) -> (Origin<'a>, Option<(&'a str, u32)>) {
        let bare = path.trim().trim_start_matches('(').trim_end_matches(')').trim();
        if let Some(name) = literal_type(bare) {
            return (Origin::Runtime(name), None);
        }
        if let Some(built) = bare.strip_prefix("new ") {
            let named = built.split(['(', ')', ' ', '<', '{']).next().unwrap_or(built).trim();
            if !named.is_empty() {
                return (self.annotated(file, named), None);
            }
        }
        let mut parts = segments(path);
        let Some(first) = parts.next() else {
            return (Origin::Unknown, None);
        };
        let (mut origin, mut held, opening) = match self.static_path(unit, file, first) {
            Some((origin, tail)) => (origin, None, Some(tail)),
            None => (self.root(unit, file, first), self.held(unit, file, first), None),
        };
        let mut held_file = file;
        for part in opening.into_iter().chain(parts) {
            if let Origin::Declared(owner) = origin
                && self.symbols.nodes[owner as usize].kind.is_unit()
            {
                origin = self.returned_by(owner);
                held = None;
            }
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
                    let found = self.inherited_member_type(owner, part);
                    held = found.map(|(annotation, _)| annotation);
                    held_file = found.map(|(_, at)| self.symbols.nodes[at as usize].file).unwrap_or(held_file);
                    match found {
                        Some((annotation, at)) => self.annotated_from(owner, at, annotation),
                        None => Origin::Unknown,
                    }
                }
                Origin::Module(held_file) => {
                    held = None;
                    match self.symbols.in_scope(held_file, part) {
                        Some(found) => self.declared_value(found),
                        None => Origin::Unknown,
                    }
                }
                Origin::Package(specifier) => Origin::Package(specifier),
                Origin::Runtime(name) if !path.contains('(') && matches!(self.returned(part), Origin::Unknown) => {
                    held = None;
                    Origin::Runtime(name)
                }
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
        if let Origin::Declared(owner) = origin
            && self.symbols.nodes[owner as usize].kind.is_unit()
            && path.trim_end().ends_with(')')
        {
            return (self.returned_by(owner), None);
        }
        (origin, held.map(|annotation| (annotation, held_file)))
    }

    pub(super) fn returned_by(&self, function: u32) -> Origin<'a> {
        let node = &self.symbols.nodes[function as usize];
        let Some(returned) = node.signature.as_ref().and_then(|signature| signature.return_type.as_deref()) else {
            return Origin::Unknown;
        };
        let Ok(returned) = self.element_of_tuple(returned) else {
            return Origin::Unknown;
        };
        if names_itself(returned) {
            return self.symbols.owning_type(function).map(Origin::Declared).unwrap_or(Origin::Unknown);
        }
        self.annotated(node.file, returned)
    }

    fn declared_value(&self, found: u32) -> Origin<'a> {
        let node = &self.symbols.nodes[found as usize];
        if node.kind.is_type() {
            return Origin::Declared(found);
        }
        if node.kind.is_unit() {
            return self.returned_by(found);
        }
        match node.type_annotation.as_deref() {
            Some(annotation) => self.annotated(node.file, annotation),
            None => Origin::Unknown,
        }
    }
}

impl<'a> Resolver<'a> {
    pub(super) fn enclosing(&self, unit: u32) -> Vec<u32> {
        let mut chain = vec![unit];
        let mut current = unit;
        for _ in 0..8 {
            let node = &self.symbols.nodes[current as usize];
            if !node.id.contains(":callback:") || node.signature.is_none() {
                break;
            }
            let Some(parent) = node.parent.as_deref().and_then(|parent| self.symbols.position.get(parent)).copied() else {
                break;
            };
            chain.push(parent);
            current = parent;
        }
        chain
    }

    pub(super) fn element_binding(&self, unit: u32, file: u32, name: &str, in_parameters: bool) -> Origin<'a> {
        let node = &self.symbols.nodes[unit as usize];
        let Some(expression) = self.bindings.elements.get(&(node.id.as_str(), name)).copied() else {
            return Origin::Unknown;
        };
        let evaluated_in = match in_parameters {
            true => match node.parent.as_deref().and_then(|parent| self.symbols.position.get(parent)) {
                Some(parent) => *parent,
                None => return Origin::Unknown,
            },
            false => unit,
        };
        self.element_origin(evaluated_in, file, expression)
    }

    fn element_origin(&self, unit: u32, file: u32, expression: &'a str) -> Origin<'a> {
        let Some(_depth) = Depth::enter() else {
            return Origin::Unknown;
        };
        let mut parts: Vec<&str> = segments(expression).collect();
        while parts.len() > 1 {
            match parts.last() {
                Some(last) if crate::elements::keeps_its_elements(last) => {
                    parts.pop();
                }
                _ => break,
            }
        }
        let Some(first) = parts.first().copied() else {
            return Origin::Unknown;
        };
        let held = match parts.len() {
            1 => self.held(unit, file, first).map(|annotation| (annotation, file)),
            _ => {
                let end = expression.find(parts[parts.len() - 1]).map(|at| at + parts[parts.len() - 1].len());
                let Some(end) = end else { return Origin::Unknown };
                self.origin_held(unit, file, &expression[..end]).1
            }
        };
        let Some((annotation, declared_in)) = held else {
            return Origin::Unknown;
        };
        match crate::elements::element_of(annotation) {
            Some(element) => self.annotated(declared_in, element),
            None => Origin::Unknown,
        }
    }
}

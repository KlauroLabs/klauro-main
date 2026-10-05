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
    pub(super) fn annotated_from(&self, owner: u32, annotation: &'a str) -> Origin<'a> {
        let annotation = match self.element_of_tuple(annotation) {
            Ok(held) => held,
            Err(()) => return Origin::Unknown,
        };
        if names_itself(annotation) {
            return Origin::Declared(owner);
        }
        self.annotated(self.symbols.nodes[owner as usize].file, annotation)
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
        let (mut origin, mut held, opening) = match self.static_path(unit, file, first) {
            Some((origin, tail)) => (origin, None, Some(tail)),
            None => (self.root(unit, file, first), self.held(unit, file, first), None),
        };
        for part in opening.into_iter().chain(parts) {
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
                        Some(annotation) => self.annotated_from(owner, annotation),
                        None => Origin::Unknown,
                    }
                }
                Origin::Declared(owner) if self.symbols.nodes[owner as usize].kind.is_unit() => {
                    held = None;
                    self.returned_by(owner)
                }
                Origin::Module(held_file) => {
                    held = None;
                    match self.symbols.in_scope(held_file, part) {
                        Some(found) => self.declared_value(found),
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

    fn returned_by(&self, function: u32) -> Origin<'a> {
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

use rustc_hash::FxHashMap as HashMap;

use crate::entry_exit::EntryPoint;
use crate::model::*;

pub fn draws_routes(path: &str) -> bool {
    path.ends_with(".rb") && (path.ends_with("config/routes.rb") || path.contains("config/routes/"))
}

fn app_root(path: &str) -> &str {
    match path.find("config/routes") {
        Some(at) => &path[..at],
        None => "",
    }
}

#[derive(Clone, Default)]
struct Within {
    path: String,
    module: String,
    controller: Option<String>,
    resource: Option<Resource>,
    placing: Option<&'static str>,
}

#[derive(Clone)]
struct Resource {
    segment: String,
    controller: String,
    singular: bool,
    param: String,
}

fn option<'a>(call: &'a CallFact, key: &str) -> Option<&'a str> {
    call.literals.iter().find_map(|literal| {
        let (named, value) = literal.split_once('=')?;
        (named.trim() == key).then(|| value.trim().trim_matches(['"', '\'']))
    })
}

fn listed(call: &CallFact, key: &str) -> Option<Vec<String>> {
    option(call, key).map(|value| value.split(',').map(|word| word.trim().trim_start_matches(':').to_string()).collect())
}

fn named_args(call: &CallFact) -> Vec<String> {
    call.literals
        .iter()
        .filter(|literal| !literal.contains('='))
        .map(|literal| literal.trim().trim_start_matches(':').trim_matches(['"', '\'']).to_string())
        .filter(|literal| !literal.is_empty())
        .collect()
}

fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies") {
        return format!("{stem}y");
    }
    for ending in ["sses", "shes", "ches", "xes", "uses", "ases"] {
        if let Some(stem) = word.strip_suffix(ending) {
            return format!("{stem}{}", &ending[..ending.len() - 2]);
        }
    }
    word.strip_suffix('s').filter(|stem| !stem.ends_with('s')).unwrap_or(word).to_string()
}

fn plural(word: &str) -> String {
    if word.ends_with('s') {
        return word.to_string();
    }
    if let Some(stem) = word.strip_suffix('y').filter(|stem| !stem.ends_with(['a', 'e', 'i', 'o', 'u'])) {
        return format!("{stem}ies");
    }
    format!("{word}s")
}

fn joined(base: &str, segment: &str) -> String {
    let segment = segment.trim_matches('/');
    if segment.is_empty() {
        return if base.is_empty() { "/".to_string() } else { base.to_string() };
    }
    format!("{}/{segment}", base.trim_end_matches('/'))
}

fn entered(within: &Within, call: &CallFact) -> Within {
    let mut inner = within.clone();
    let verb = crate::names::leaf(&call.callee);
    let args = named_args(call);
    match verb {
        "namespace" => {
            if let Some(name) = args.first() {
                let segment = option(call, "path").unwrap_or(name);
                inner.path = joined(&inner.path, segment);
                inner.module = format!("{}{}/", inner.module, option(call, "module").unwrap_or(name));
            }
        }
        "scope" => {
            if let Some(segment) = option(call, "path").or_else(|| args.first().map(String::as_str)) {
                inner.path = joined(&inner.path, segment);
            }
            if let Some(module) = option(call, "module") {
                inner.module = format!("{}{}/", inner.module, module);
            }
            if let Some(controller) = option(call, "controller") {
                inner.controller = Some(controller.to_string());
            }
        }
        "controller" => {
            if let Some(name) = args.first() {
                inner.controller = Some(name.clone());
            }
        }
        "resources" | "resource" => {
            if let Some(name) = args.first() {
                let singular_resource = verb == "resource";
                let segment = option(call, "path").unwrap_or(name).to_string();
                let controller = option(call, "controller")
                    .map(str::to_string)
                    .unwrap_or_else(|| if singular_resource { plural(name) } else { name.clone() });
                let param = option(call, "param").unwrap_or("id").to_string();
                if let Some(outer) = &within.resource {
                    inner.path = nested_under(&within.path, outer);
                }
                if let Some(module) = option(call, "module") {
                    inner.module = format!("{}{}/", inner.module, module);
                }
                inner.resource = Some(Resource { segment, controller, singular: singular_resource, param });
                inner.placing = None;
            }
        }
        "member" => inner.placing = Some("member"),
        "collection" => inner.placing = Some("collection"),
        _ => {}
    }
    inner
}

fn nested_under(base: &str, outer: &Resource) -> String {
    let at = joined(base, &outer.segment);
    match outer.singular {
        true => at,
        false => joined(&at, &format!(":{}_id", singular(&outer.segment))),
    }
}

static RESTFUL: &[(&str, &str, &str, bool)] = &[
    ("index", "GET", "", true),
    ("create", "POST", "", false),
    ("new", "GET", "new", false),
    ("edit", "GET", ":id/edit", false),
    ("show", "GET", ":id", false),
    ("update", "PATCH", ":id", false),
    ("destroy", "DELETE", ":id", false),
];

fn routed(within: &Within, call: &CallFact) -> Vec<(String, String, String, String)> {
    let verb = crate::names::leaf(&call.callee);
    let args = named_args(call);
    let mut found = Vec::new();
    match verb {
        "resources" | "resource" => {
            let singular_resource = verb == "resource";
            let only = listed(call, "only");
            let except = listed(call, "except").unwrap_or_default();
            for name in &args {
                let segment = option(call, "path").unwrap_or(name).to_string();
                let controller = option(call, "controller")
                    .map(str::to_string)
                    .unwrap_or_else(|| if singular_resource { plural(name) } else { name.clone() });
                let param = option(call, "param").unwrap_or("id");
                let base = match &within.resource {
                    Some(outer) => nested_under(&within.path, outer),
                    None => within.path.clone(),
                };
                let at = joined(&base, &segment);
                for (action, method, suffix, collection) in RESTFUL {
                    if singular_resource && *collection {
                        continue;
                    }
                    if only.as_ref().is_some_and(|only| !only.iter().any(|held| held == action)) || except.iter().any(|held| held == action) {
                        continue;
                    }
                    let suffix = match singular_resource {
                        true => suffix.replace(":id/", "").replace(":id", ""),
                        false => suffix.replace(":id", &format!(":{param}")),
                    };
                    found.push((method.to_string(), joined(&at, &suffix), format!("{}{controller}", within.module), action.to_string()));
                }
            }
        }
        "get" | "post" | "put" | "patch" | "delete" | "match" | "root" => {
            let spoken = args.first().cloned().unwrap_or_default();
            let target = option(call, "to").map(str::to_string).or_else(|| (verb == "root" && spoken.contains('#')).then(|| spoken.clone()));
            let (controller, action) = match target.as_deref().and_then(|to| to.split_once('#')) {
                Some((controller, action)) => (Some(controller.to_string()), action.to_string()),
                None => {
                    let action = option(call, "action").map(str::to_string).unwrap_or_else(|| spoken.rsplit('/').next().unwrap_or(&spoken).to_string());
                    let controller = option(call, "controller")
                        .map(str::to_string)
                        .or_else(|| within.resource.as_ref().map(|resource| resource.controller.clone()))
                        .or_else(|| within.controller.clone())
                        .or_else(|| spoken.rsplit_once('/').map(|(controller, _)| controller.trim_matches('/').to_string()));
                    (controller, action)
                }
            };
            let Some(controller) = controller else { return found };
            if action.is_empty() || !action.chars().all(|letter| letter.is_alphanumeric() || letter == '_') {
                return found;
            }
            let base = match (&within.resource, within.placing) {
                (Some(resource), Some("member")) if !resource.singular => {
                    joined(&joined(&within.path, &resource.segment), &format!(":{}", resource.param))
                }
                (Some(resource), None) => nested_under(&within.path, resource),
                (Some(resource), _) => joined(&within.path, &resource.segment),
                (None, _) => within.path.clone(),
            };
            let path = match (verb, target.is_some() || spoken.contains('#')) {
                ("root", _) => joined(&within.path, ""),
                (_, _) if spoken.contains('#') => joined(&base, ""),
                _ => joined(&base, &spoken),
            };
            let methods: Vec<String> = match verb {
                "match" => listed(call, "via").unwrap_or_else(|| vec!["get".to_string()]),
                "root" => vec!["get".to_string()],
                other => vec![other.to_string()],
            };
            let module = match controller.contains('/') {
                true => String::new(),
                false => within.module.clone(),
            };
            for method in methods {
                found.push((method.to_ascii_uppercase(), path.clone(), format!("{module}{controller}"), action.clone()));
            }
        }
        _ => {}
    }
    found
}

pub fn derive(nodes: &[IndexNode], calls: &[CallFact], files: &[String]) -> Vec<EntryPoint> {
    let drawing: Vec<bool> = files.iter().map(|path| draws_routes(path)).collect();
    if !drawing.iter().any(|held| *held) {
        return Vec::new();
    }
    let mut made_by: HashMap<(u32, u32, &str), usize> = HashMap::default();
    for (at, call) in calls.iter().enumerate() {
        if drawing[call.file as usize] {
            made_by.entry((call.file, call.line, crate::names::leaf(&call.callee))).or_insert(at);
        }
    }
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let opened_by = |node: &IndexNode| -> Option<usize> {
        let registrar = node.callback_of.as_deref()?;
        made_by.get(&(node.file, node.span.line, crate::names::leaf(registrar))).copied()
    };
    let mut within_of: HashMap<String, Within> = HashMap::default();
    let mut scope_of = |caller: &str| -> Within {
        let mut chain: Vec<usize> = Vec::new();
        let mut current = by_id.get(caller).copied();
        while let Some(node) = current {
            if let Some(held) = within_of.get(node.id.as_str()) {
                let mut within = held.clone();
                for call in chain.iter().rev() {
                    within = entered(&within, &calls[*call]);
                }
                return within;
            }
            if let Some(opened) = opened_by(node) {
                chain.push(opened);
            }
            current = node.parent.as_deref().and_then(|parent| by_id.get(parent).copied());
        }
        let mut within = Within::default();
        for call in chain.iter().rev() {
            within = entered(&within, &calls[*call]);
        }
        within_of.insert(caller.to_string(), within.clone());
        within
    };
    let mut classes: HashMap<String, &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_type()) {
        let path = &files[node.file as usize];
        if path.ends_with("_controller.rb") {
            classes.entry(path.clone()).or_insert(node);
        }
    }
    let mut actions: HashMap<(&str, &str), &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_unit()) {
        if let Some(parent) = node.parent.as_deref() {
            actions.entry((parent, node.name.as_str())).or_insert(node);
        }
    }
    let mut found = Vec::new();
    for call in calls.iter().filter(|call| drawing[call.file as usize]) {
        let verb = crate::names::leaf(&call.callee);
        if !matches!(verb, "resources" | "resource" | "get" | "post" | "put" | "patch" | "delete" | "match" | "root") {
            continue;
        }
        let Some(caller) = call.caller.as_deref() else { continue };
        let within = scope_of(caller);
        let root = app_root(&files[call.file as usize]);
        for (method, path, controller, action) in routed(&within, call) {
            let file = format!("{root}app/controllers/{controller}_controller.rb");
            let Some(class) = classes.get(&file) else { continue };
            let Some(handler) = actions.get(&(class.id.as_str(), action.as_str())) else { continue };
            found.push(EntryPoint {
                id: format!("entry:{}:{method}:{path}", handler.id),
                kind: "http",
                name: path.clone(),
                method: Some(method),
                path: Some(path),
                handler: handler.id.clone(),
                file: call.file,
                line: call.line,
                guards: Vec::new(),
                registrar: format!("rails {verb}"),
                unshipped: None,
            });
        }
    }
    found.sort_by(|left, right| left.id.cmp(&right.id));
    found.dedup_by(|left, right| left.id == right.id);
    found
}

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::{CallFact, ImportFact, IndexNode, LocalBinding};

static TABLE: &str = include_str!("../data/rpc_clients.tsv");

fn held(kind: &'static str) -> impl Iterator<Item = &'static str> {
    TABLE.lines().filter_map(move |line| line.strip_prefix(kind)?.strip_prefix('\t'))
}

fn plain(annotation: &str) -> &str {
    let bare = annotation.trim().trim_end_matches('?');
    let bare = bare.split('<').next().unwrap_or(bare);
    bare.trim()
}

fn service_of<'a>(typed: &str, services: &'a HashMap<String, HashSet<String>>) -> Option<&'a str> {
    let leaf = typed.rsplit(['.', ':']).next().unwrap_or(typed);
    held("client")
        .filter_map(|suffix| leaf.strip_suffix(suffix))
        .find_map(|stem| services.get_key_value(stem).map(|(service, _)| service.as_str()))
}

fn method_of(callee: &str, methods: &HashSet<String>) -> Option<String> {
    let leaf = crate::names::leaf(callee);
    let bare = held("call").find_map(|suffix| leaf.strip_suffix(suffix)).unwrap_or(leaf);
    methods.iter().find(|method| method.eq_ignore_ascii_case(bare)).cloned()
}

pub fn exits(entries: &[EntryPoint], calls: &[CallFact], nodes: &[IndexNode], locals: &[LocalBinding], imports: &[ImportFact], files: &[&str]) -> Vec<ExitPoint> {
    let mut services: HashMap<String, HashSet<String>> = HashMap::default();
    for entry in entries.iter().filter(|entry| entry.kind == "rpc") {
        let Some((service, method)) = entry.path.as_deref().and_then(|path| path.trim_start_matches('/').split_once('/')) else { continue };
        let service = service.rsplit('.').next().unwrap_or(service);
        services.entry(service.to_string()).or_default().insert(method.to_string());
    }
    if services.is_empty() {
        return Vec::new();
    }
    let mut aliased: HashMap<(u32, &str), &str> = HashMap::default();
    for import in imports {
        for name in import.names.iter().filter(|name| name.imported.is_some()) {
            aliased.insert((import.file, name.local.as_str()), import.specifier.as_str());
        }
    }
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut returns_in: HashMap<(u32, &str), &str> = HashMap::default();
    let mut members: HashMap<(&str, &str), &str> = HashMap::default();
    for node in nodes {
        if node.kind.is_unit()
            && let Some(returned) = node.signature.as_ref().and_then(|signature| signature.return_type.as_deref())
        {
            returns_in.entry((node.file, node.name.as_str())).or_insert(returned);
        }
        if node.kind.is_type() {
            for parameter in node.signature.iter().flat_map(|signature| signature.parameters.iter()) {
                if let Some(annotation) = parameter.type_annotation.as_deref() {
                    members.insert((node.id.as_str(), parameter.name.as_str()), annotation);
                }
            }
        }
        if let (Some(parent), Some(annotation)) = (node.parent.as_deref(), node.type_annotation.as_deref())
            && !node.kind.is_unit()
        {
            members.insert((parent, node.name.as_str()), annotation);
        }
    }
    let mut local_type: HashMap<(&str, &str), &str> = HashMap::default();
    for local in locals {
        let typed = local
            .annotation
            .as_deref()
            .or(local.constructed.as_deref())
            .or_else(|| local.from_call.as_deref().and_then(|called| returns_in.get(&(local.file, crate::names::leaf(called))).copied()));
        if let Some(typed) = typed {
            local_type.insert((local.unit.as_str(), local.name.as_str()), typed);
        }
    }
    let mut found = Vec::new();
    for (at, call) in calls.iter().enumerate() {
        let (Some(receiver), Some(caller)) = (call.receiver.as_deref(), call.caller.as_deref()) else { continue };
        let Some(unit) = node_of.get(caller) else { continue };
        let receiver = receiver.trim().trim_start_matches("this.");
        let typed = match receiver.strip_suffix("()") {
            Some(called) => returns_in.get(&(call.file, crate::names::leaf(called))).copied(),
            None => {
                let root = receiver.split(['.', '?', '!']).next().unwrap_or(receiver);
                let bare = root.trim_start_matches('_');
                unit.signature
                    .iter()
                    .flat_map(|signature| signature.parameters.iter())
                    .find(|parameter| parameter.name == root)
                    .and_then(|parameter| parameter.type_annotation.as_deref())
                    .or_else(|| local_type.get(&(caller, root)).copied())
                    .or_else(|| {
                        let owner = unit.parent.as_deref()?;
                        members.get(&(owner, root)).or_else(|| members.get(&(owner, bare))).copied()
                    })
            }
        };
        let Some(typed) = typed.map(plain) else { continue };
        let typed = aliased.get(&(call.file, typed)).copied().unwrap_or(typed);
        let Some(service) = service_of(typed, &services) else { continue };
        let Some(method) = method_of(&call.callee, &services[service]) else { continue };
        let path = files.get(call.file as usize).copied().unwrap_or_default();
        found.push(ExitPoint {
            id: format!("exit:{path}:{at}:rpc"),
            kind: "api",
            name: format!("{receiver}.{}", crate::names::leaf(&call.callee)),
            source: caller.to_string(),
            target: typed.to_string(),
            operation: crate::names::leaf(&call.callee).to_string(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: Some(format!("/{service}/{method}")),
            service: None,
            method: None,
            origin: None,
            action: None,
            does: Some("call"),
        });
    }
    found
}

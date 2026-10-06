use std::path::Path;

use rustc_hash::FxHashMap as HashMap;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::{basename, is_test};

enum Leaf {
    Any,
    Named(&'static str),
}

struct Router {
    package: &'static str,
    directories: &'static [&'static str],
    extensions: &'static [&'static str],
    leaf: Leaf,
    skipped_segments: &'static [&'static str],
}

static ROUTERS: &[Router] = &[
    Router { package: "expo-router", directories: &["app", "src/app"], extensions: &["tsx", "jsx", "ts", "js"], leaf: Leaf::Any, skipped_segments: &[] },
    Router { package: "next", directories: &["app", "src/app"], extensions: &["tsx", "jsx", "ts", "js"], leaf: Leaf::Named("page"), skipped_segments: &[] },
    Router { package: "next", directories: &["pages", "src/pages"], extensions: &["tsx", "jsx", "ts", "js"], leaf: Leaf::Any, skipped_segments: &["api"] },
    Router { package: "nuxt", directories: &["pages", "app/pages"], extensions: &["vue"], leaf: Leaf::Any, skipped_segments: &[] },
    Router { package: "@sveltejs/kit", directories: &["src/routes"], extensions: &["svelte"], leaf: Leaf::Named("+page"), skipped_segments: &[] },
];

fn declared_packages(text: &str) -> Vec<String> {
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(text) else { return Vec::new() };
    ["dependencies", "devDependencies", "peerDependencies"]
        .iter()
        .filter_map(|section| manifest.get(section).and_then(|held| held.as_object()))
        .flat_map(|held| held.keys().cloned())
        .collect()
}

fn segment_of(written: &str) -> Option<String> {
    if (written.starts_with('(') && written.ends_with(')')) || written.starts_with('@') {
        return None;
    }
    if let Some(inner) = written.strip_prefix("[[").and_then(|held| held.strip_suffix("]]")).or_else(|| written.strip_prefix('[').and_then(|held| held.strip_suffix(']'))) {
        return Some(match inner.starts_with("...") {
            true => "*".to_string(),
            false => format!(":{inner}"),
        });
    }
    Some(written.to_string())
}

fn screen_route(router: &Router, within: &str) -> Option<String> {
    let (stem, extension) = basename(within).rsplit_once('.')?;
    if !router.extensions.contains(&extension) || stem.ends_with(".d") {
        return None;
    }
    let reserved = |held: &str| held.starts_with('_') || held.starts_with('+') && !matches!(router.leaf, Leaf::Named(_));
    let leaf_held = match &router.leaf {
        Leaf::Any => !reserved(stem),
        Leaf::Named(named) => stem == *named,
    };
    if !leaf_held {
        return None;
    }
    let directories: Vec<&str> = within.split('/').collect::<Vec<_>>().split_last().map(|(_, held)| held.to_vec()).unwrap_or_default();
    if directories.iter().any(|held| router.skipped_segments.contains(held)) {
        return None;
    }
    let mut route: Vec<String> = directories.iter().filter_map(|held| segment_of(held)).collect();
    if matches!(router.leaf, Leaf::Any) && stem != "index" {
        route.push(segment_of(stem)?);
    }
    Some(format!("/{}", route.join("/")))
}

static ROUTE_VERBS: &[&str] = &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

fn routes_file(path: &str) -> bool {
    let within_conf = path.split('/').rev().nth(1) == Some("conf");
    let name = basename(path);
    within_conf && (name == "routes" || name.ends_with(".routes"))
}

fn placeholder_path(written: &str) -> String {
    let mut path = String::new();
    let mut rest = written;
    while let Some(at) = rest.find('$') {
        path.push_str(&rest[..at]);
        let held = &rest[at + 1..];
        let name_end = held.find('<').unwrap_or(held.len());
        path.push(':');
        path.push_str(&held[..name_end]);
        rest = match held[name_end..].find('>') {
            Some(close) => &held[name_end + close + 1..],
            None => "",
        };
    }
    path.push_str(rest);
    path
}

fn action_of(written: &str) -> Option<(&str, &str)> {
    let call = written.split('(').next()?;
    let (controller, action) = call.rsplit_once('.')?;
    (!controller.is_empty() && !action.is_empty()).then_some((controller, action))
}

fn declared_by_routes_files(root: &Path, files: &[String], nodes: &[IndexNode], module_of: &HashMap<u32, &IndexNode>) -> Vec<EntryPoint> {
    let declaring: Vec<(usize, &String)> = files.iter().enumerate().filter(|(_, path)| routes_file(path)).collect();
    if declaring.is_empty() {
        return Vec::new();
    }
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut members: HashMap<(&str, &str), &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| matches!(node.kind, NodeKind::Method | NodeKind::Function)) {
        if let Some(owner) = node.parent.as_deref().and_then(|parent| by_id.get(parent)) {
            members.insert((owner.name.as_str(), node.name.as_str()), node);
        }
    }
    let mut found = Vec::new();
    for (at, path) in declaring {
        let Some(module) = module_of.get(&(at as u32)) else { continue };
        let Some(text) = crate::paths::read_inside(root, path) else { continue };
        for (position, line) in text.lines().enumerate() {
            let mut words = line.split_whitespace();
            let (Some(verb), Some(written), Some(action)) = (words.next(), words.next(), words.next()) else { continue };
            if !ROUTE_VERBS.contains(&verb) || !written.starts_with('/') {
                continue;
            }
            let route = placeholder_path(written);
            let handler = action_of(action)
                .and_then(|(controller, action)| members.get(&(controller.rsplit('.').next()?, action)))
                .map_or_else(|| module.id.clone(), |member| member.id.clone());
            found.push(EntryPoint {
                id: format!("entry:{}:{verb}:{route}", module.id),
                kind: "http",
                name: route.clone(),
                method: Some(verb.to_string()),
                path: Some(route),
                handler,
                file: at as u32,
                line: position as u32 + 1,
                guards: Vec::new(),
                registrar: "routes_file".to_string(),
                unshipped: None,
            });
        }
    }
    found
}

pub fn drawn(root: &Path, files: &[String], nodes: &[IndexNode]) -> Vec<EntryPoint> {
    let mut module_of: HashMap<u32, &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Module) {
        module_of.entry(node.file).or_insert(node);
    }
    let mut found = declared_by_routes_files(root, files, nodes, &module_of);
    for manifest in files.iter().filter(|path| basename(path) == "package.json") {
        let Some(text) = crate::paths::read_inside(root, manifest) else { continue };
        let declared = declared_packages(&text);
        let base = manifest.strip_suffix("package.json").unwrap_or_default();
        for router in ROUTERS.iter().filter(|router| declared.iter().any(|held| held == router.package)) {
            for directory in router.directories {
                let prefix = format!("{base}{directory}/");
                for (at, path) in files.iter().enumerate() {
                    let Some(within) = path.strip_prefix(prefix.as_str()) else { continue };
                    if is_test(path) {
                        continue;
                    }
                    let Some(route) = screen_route(router, within) else { continue };
                    let Some(module) = module_of.get(&(at as u32)) else { continue };
                    found.push(EntryPoint {
                        id: format!("entry:{}:screen:{route}", module.id),
                        kind: "ui",
                        name: route,
                        method: None,
                        path: None,
                        handler: module.id.clone(),
                        file: at as u32,
                        line: module.span.line,
                        guards: Vec::new(),
                        registrar: format!("file_route:{}", router.package),
                        unshipped: None,
                    });
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(router: usize, within: &str) -> Option<String> {
        screen_route(&ROUTERS[router], within)
    }

    #[test]
    fn a_file_under_the_router_directory_is_a_screen_at_its_path() {
        assert_eq!(route(0, "chat/[id].tsx").as_deref(), Some("/chat/:id"));
        assert_eq!(route(0, "(tabs)/index.tsx").as_deref(), Some("/"));
        assert_eq!(route(0, "sessions.tsx").as_deref(), Some("/sessions"));
    }

    #[test]
    fn a_routes_file_names_the_conf_directory_it_sits_in() {
        assert!(routes_file("conf/routes"));
        assert!(routes_file("app/conf/admin.routes"));
        assert!(!routes_file("app/routes"));
        assert!(!routes_file("conf/routes.rb"));
    }

    #[test]
    fn a_pattern_placeholder_becomes_a_named_parameter() {
        assert_eq!(placeholder_path("/users/$id<[0-9]+>/posts"), "/users/:id/posts");
        assert_eq!(placeholder_path("/users/:id"), "/users/:id");
    }

    #[test]
    fn an_action_is_its_controller_and_member_without_the_arguments() {
        assert_eq!(action_of("controllers.UserController.show(id: Long)"), Some(("controllers.UserController", "show")));
        assert_eq!(action_of("list"), None);
    }

    #[test]
    fn layouts_and_special_files_are_not_screens() {
        assert_eq!(route(0, "_layout.tsx"), None);
        assert_eq!(route(0, "+not-found.tsx"), None);
        assert_eq!(route(2, "api/[...slug].ts"), None);
        assert_eq!(route(2, "_app.tsx"), None);
    }

    #[test]
    fn only_the_page_file_of_an_app_directory_is_a_screen() {
        assert_eq!(route(1, "workspace/[id]/page.tsx").as_deref(), Some("/workspace/:id"));
        assert_eq!(route(1, "workspace/[id]/card.tsx"), None);
        assert_eq!(route(4, "docs/[...rest]/+page.svelte").as_deref(), Some("/docs/*"));
    }
}

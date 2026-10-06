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

pub fn drawn(root: &Path, files: &[String], nodes: &[IndexNode]) -> Vec<EntryPoint> {
    let mut module_of: HashMap<u32, &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Module) {
        module_of.entry(node.file).or_insert(node);
    }
    let mut found = Vec::new();
    for manifest in files.iter().filter(|path| basename(path) == "package.json") {
        let Ok(text) = std::fs::read_to_string(root.join(manifest)) else { continue };
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

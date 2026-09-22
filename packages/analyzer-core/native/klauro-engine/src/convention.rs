use std::collections::HashMap;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::is_test;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Family {
    Next,
    Svelte,
    Nuxt,
    Astro,
    Remix,
    TanStack,
}

static CONFIGURED: &[(&str, Family)] = &[
    ("astro.config", Family::Astro),
    ("next.config", Family::Next),
    ("nuxt.config", Family::Nuxt),
    ("react-router.config", Family::Remix),
    ("remix.config", Family::Remix),
    ("routeTree.gen", Family::TanStack),
    ("svelte.config", Family::Svelte),
];

static METHODS: &[&str] =
    &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"];

enum Members {
    Methods,
    Default(String),
    Named(&'static [(&'static str, &'static str)]),
    Whole(String),
}

struct Routing {
    path: String,
    members: Members,
}

fn base(name: &str) -> &str {
    name.rsplit_once('.').map(|(held, _)| held).unwrap_or(name)
}

fn stem(name: &str) -> &str {
    let held = base(name);
    match held.rsplit_once('.') {
        Some((before, last)) if METHODS.contains(&last.to_ascii_uppercase().as_str()) => before,
        _ => held,
    }
}

fn spoken_method(name: &str) -> Option<String> {
    let last = base(name).rsplit_once('.')?.1.to_ascii_uppercase();
    METHODS.contains(&last.as_str()).then_some(last)
}

fn extension(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, held)| held).unwrap_or("")
}

fn scripted(name: &str) -> bool {
    matches!(extension(name), "js" | "jsx" | "mjs" | "ts" | "tsx")
}

fn drawn(name: &str) -> bool {
    matches!(extension(name), "jsx" | "tsx" | "vue" | "svelte")
}

fn named(inner: &str) -> &str {
    inner.split_once('=').map(|(held, _)| held).unwrap_or(inner)
}

fn segment(held: &str) -> Option<String> {
    if held.starts_with('(') && held.ends_with(')') {
        return None;
    }
    let mut written = String::new();
    let mut rest = held;
    while let Some(at) = rest.find('[') {
        written.push_str(&rest[..at]);
        let opened = rest[at..].chars().take_while(|held| *held == '[').count();
        let closing = "]".repeat(opened);
        let Some(end) = rest[at..].find(&closing) else {
            written.push_str(&rest[at..]);
            return Some(written);
        };
        let inner = named(&rest[at + opened..at + end]);
        match inner.strip_prefix("...") {
            Some(_) => written.push('*'),
            None => {
                written.push(':');
                written.push_str(inner);
            }
        }
        rest = &rest[at + end + opened..];
    }
    written.push_str(rest);
    Some(written)
}

fn route(under: &[&str]) -> String {
    let mut written = String::new();
    for held in under {
        if let Some(part) = segment(held) {
            written.push('/');
            written.push_str(&part);
        }
    }
    match written.is_empty() {
        true => "/".to_string(),
        false => written,
    }
}

fn opened<'a>(parts: &'a [&'a str], tree: &[&str]) -> Option<&'a [&'a str]> {
    parts
        .windows(tree.len())
        .position(|held| held == tree)
        .map(|at| &parts[at + tree.len()..])
}

static SVELTE_PAGE: &[(&str, &str)] = &[("load", "GET")];
static SVELTE_FORM: &[(&str, &str)] = &[("actions", "POST"), ("load", "GET")];
static REMIX_ROUTE: &[(&str, &str)] =
    &[("action", "POST"), ("default", "GET"), ("loader", "GET")];

fn next_routing(parts: &[&str], name: &str) -> Option<Routing> {
    if let Some(under) = opened(parts, &["app"]).or_else(|| opened(parts, &["src", "app"])) {
        let held: Vec<&str> = under[..under.len().saturating_sub(1)]
            .iter()
            .copied()
            .filter(|part| !part.starts_with('@'))
            .collect();
        return match stem(name) {
            "route" if scripted(name) => {
                Some(Routing { path: route(&held), members: Members::Methods })
            }
            "page" if drawn(name) || scripted(name) => {
                Some(Routing { path: route(&held), members: Members::Default("GET".to_string()) })
            }
            _ => None,
        };
    }
    let under = opened(parts, &["pages"]).or_else(|| opened(parts, &["src", "pages"]))?;
    if !scripted(name) || name.starts_with('_') {
        return None;
    }
    let mut held: Vec<&str> =
        under[..under.len() - 1].iter().copied().filter(|part| !part.starts_with('@')).collect();
    let leaf = stem(name);
    if leaf != "index" {
        held.push(leaf);
    }
    let serving = under.first() == Some(&"api");
    Some(Routing {
        path: route(&held),
        members: Members::Default(
            match serving {
                true => "ANY",
                false => "GET",
            }
            .to_string(),
        ),
    })
}

fn svelte_routing(parts: &[&str], name: &str) -> Option<Routing> {
    let under = opened(parts, &["src", "routes"]).or_else(|| opened(parts, &["routes"]))?;
    let held = route(&under[..under.len() - 1]);
    match name {
        "+server.ts" | "+server.js" => Some(Routing { path: held, members: Members::Methods }),
        "+page.server.ts" | "+page.server.js" => {
            Some(Routing { path: held, members: Members::Named(SVELTE_FORM) })
        }
        "+page.ts" | "+page.js" => Some(Routing { path: held, members: Members::Named(SVELTE_PAGE) }),
        "+page.svelte" => Some(Routing { path: held, members: Members::Whole("GET".to_string()) }),
        _ => None,
    }
}

fn nuxt_routing(parts: &[&str], name: &str) -> Option<Routing> {
    if let Some(under) = opened(parts, &["server", "api"]) {
        let mut held: Vec<&str> = vec!["api"];
        held.extend_from_slice(&under[..under.len() - 1]);
        let leaf = stem(name);
        if leaf != "index" {
            held.push(leaf);
        }
        return Some(Routing {
            path: route(&held),
            members: Members::Default(spoken_method(name).unwrap_or_else(|| "ANY".to_string())),
        });
    }
    if let Some(under) = opened(parts, &["server", "routes"]) {
        let mut held: Vec<&str> = under[..under.len() - 1].to_vec();
        let leaf = stem(name);
        if leaf != "index" {
            held.push(leaf);
        }
        return Some(Routing { path: route(&held), members: Members::Default("ANY".to_string()) });
    }
    let under = opened(parts, &["pages"])?;
    if extension(name) != "vue" {
        return None;
    }
    let mut held: Vec<&str> = under[..under.len() - 1].to_vec();
    let leaf = stem(name);
    if leaf != "index" {
        held.push(leaf);
    }
    Some(Routing { path: route(&held), members: Members::Whole("GET".to_string()) })
}

fn astro_routing(parts: &[&str], name: &str) -> Option<Routing> {
    let under = opened(parts, &["src", "pages"]).or_else(|| opened(parts, &["pages"]))?;
    let mut held: Vec<&str> = under[..under.len() - 1].to_vec();
    let leaf = stem(name);
    if leaf != "index" {
        held.push(leaf);
    }
    match extension(name) {
        "astro" => Some(Routing { path: route(&held), members: Members::Whole("GET".to_string()) }),
        held_as if matches!(held_as, "js" | "ts") => {
            Some(Routing { path: route(&held), members: Members::Methods })
        }
        _ => None,
    }
}

fn remix_routing(parts: &[&str], name: &str) -> Option<Routing> {
    let under = opened(parts, &["app", "routes"])?;
    if !scripted(name) {
        return None;
    }
    let mut held: Vec<String> =
        under[..under.len() - 1].iter().map(|part| (*part).to_string()).collect();
    for part in stem(name).split('.') {
        let part = match part.strip_prefix('$') {
            Some("") => "*".to_string(),
            Some(named) => format!(":{named}"),
            None => part.to_string(),
        };
        if part != "_index" && !part.starts_with('_') {
            held.push(part);
        }
    }
    let spoken: Vec<&str> = held.iter().map(String::as_str).collect();
    Some(Routing { path: route(&spoken), members: Members::Named(REMIX_ROUTE) })
}

fn tanstack_routing(parts: &[&str], name: &str) -> Option<Routing> {
    let under = opened(parts, &["routes"])?;
    if !scripted(name) {
        return None;
    }
    let leaf = base(name);
    let spoken: Vec<&str> = leaf.split('.').collect();
    if spoken.iter().all(|part| part.starts_with('_')) {
        return None;
    }
    let mut held: Vec<String> =
        under[..under.len() - 1].iter().map(|part| (*part).to_string()).collect();
    held.extend(spoken.into_iter().map(str::to_string));
    let spoken: Vec<String> = held
        .into_iter()
        .filter(|part| !part.starts_with('_') && part != "index")
        .map(|part| match part.strip_prefix('$') {
            Some("") => "*".to_string(),
            Some(named) => format!(":{named}"),
            None => part,
        })
        .collect();
    let spoken: Vec<&str> = spoken.iter().map(String::as_str).collect();
    Some(Routing { path: route(&spoken), members: Members::Whole("GET".to_string()) })
}

pub fn conventional(
    nodes: &[IndexNode],
    files: &[String],
    exports: &[ExportFact],
) -> Vec<EntryPoint> {
    let mut roots: Vec<(String, Family)> = Vec::new();
    for path in files {
        let (folder, name) = match path.rsplit_once('/') {
            Some((folder, name)) => (folder, name),
            None => ("", path.as_str()),
        };
        for (configured, family) in CONFIGURED {
            if base(name) == *configured && scripted(name) {
                roots.push((folder.to_string(), *family));
            }
        }
    }
    if roots.is_empty() {
        return Vec::new();
    }
    roots.sort();
    roots.dedup();

    let mut exported: HashMap<u32, Vec<&ExportFact>> = HashMap::new();
    for export in exports {
        exported.entry(export.file).or_default().push(export);
    }
    let mut declared: HashMap<u32, Vec<&IndexNode>> = HashMap::new();
    for node in nodes {
        declared.entry(node.file).or_default().push(node);
    }

    let held_paths: std::collections::HashSet<&str> =
        files.iter().map(String::as_str).collect();
    let mut found = Vec::new();
    for (at, path) in files.iter().enumerate() {
        if is_test(path) {
            continue;
        }
        let at = at as u32;
        let (folder, name) = match path.rsplit_once('/') {
            Some((folder, name)) => (folder, name),
            None => ("", path.as_str()),
        };
        let Some((root, family)) = roots
            .iter()
            .filter(|(root, _)| folder == root || folder.starts_with(&format!("{root}/")) || root.is_empty())
            .max_by_key(|(root, _)| root.len())
        else {
            continue;
        };
        let inside = match root.is_empty() {
            true => path.as_str(),
            false => &path[root.len() + 1..],
        };
        let parts: Vec<&str> = inside.split('/').collect();
        if name == "+page.svelte"
            && ["+page.ts", "+page.js", "+page.server.ts", "+page.server.js"]
                .iter()
                .any(|beside| held_paths.contains(format!("{folder}/{beside}").as_str()))
        {
            continue;
        }
        let Some(routing) = (match family {
            Family::Next => next_routing(&parts, name),
            Family::Svelte => svelte_routing(&parts, name),
            Family::Nuxt => nuxt_routing(&parts, name),
            Family::Astro => astro_routing(&parts, name),
            Family::Remix => remix_routing(&parts, name),
            Family::TanStack => tanstack_routing(&parts, name),
        }) else {
            continue;
        };
        let here: &[&IndexNode] = declared.get(&at).map(Vec::as_slice).unwrap_or(&[]);
        let module = here.iter().copied().find(|node| node.kind == NodeKind::Module);
        let named = |wanted: &str| -> Option<&IndexNode> {
            here.iter()
                .copied()
                .find(|node| node.name == wanted && node.kind.is_unit())
                .or(module)
        };
        let at_line = |line: u32| -> Option<&IndexNode> {
            here.iter()
                .copied()
                .find(|node| node.kind.is_unit() && node.span.line == line)
                .or(module)
        };
        let mut serve = |method: String, handler: &IndexNode, member: &str| {
            found.push(EntryPoint {
                id: format!("entry:{}:{member}", handler.id),
                kind: "http",
                name: routing.path.clone(),
                method: Some(method),
                path: Some(routing.path.clone()),
                handler: handler.id.clone(),
                file: at,
                line: handler.span.line,
                registrar: "convention".to_string(),
            });
        };
        match &routing.members {
            Members::Methods => {
                for export in exported.get(&at).into_iter().flatten() {
                    if !METHODS.contains(&export.name.as_str()) {
                        continue;
                    }
                    let Some(handler) = named(&export.name) else { continue };
                    serve(export.name.clone(), handler, &export.name);
                }
            }
            Members::Default(method) => {
                let Some(export) = exported
                    .get(&at)
                    .into_iter()
                    .flatten()
                    .find(|export| export.default_export)
                else {
                    continue;
                };
                let Some(handler) = at_line(export.line) else { continue };
                serve(method.to_string(), handler, "default");
            }
            Members::Named(members) => {
                for (member, method) in *members {
                    let handler = match *member {
                        "default" => exported
                            .get(&at)
                            .into_iter()
                            .flatten()
                            .find(|export| export.default_export)
                            .and_then(|export| at_line(export.line)),
                        wanted => named(wanted),
                    };
                    let Some(handler) = handler else { continue };
                    serve(method.to_string(), handler, member);
                }
            }
            Members::Whole(method) => {
                let Some(handler) = module else { continue };
                serve(method.to_string(), handler, "page");
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_of(parts: &[&str], name: &str, family: Family) -> Option<String> {
        let routing = match family {
            Family::Next => next_routing(parts, name),
            Family::Svelte => svelte_routing(parts, name),
            Family::Nuxt => nuxt_routing(parts, name),
            Family::Astro => astro_routing(parts, name),
            Family::Remix => remix_routing(parts, name),
            Family::TanStack => tanstack_routing(parts, name),
        }?;
        Some(routing.path)
    }

    #[test]
    fn a_route_group_names_no_segment() {
        assert_eq!(
            path_of(&["app", "(marketing)", "about", "page.tsx"], "page.tsx", Family::Next).as_deref(),
            Some("/about")
        );
    }

    #[test]
    fn a_bracketed_segment_is_the_parameter_it_names() {
        assert_eq!(
            path_of(&["app", "[user]", "[type]", "page.tsx"], "page.tsx", Family::Next).as_deref(),
            Some("/:user/:type")
        );
        assert_eq!(
            path_of(&["app", "[[...slug]]", "page.tsx"], "page.tsx", Family::Next).as_deref(),
            Some("/*")
        );
        assert_eq!(
            path_of(&["pages", "api", "[...args].ts"], "[...args].ts", Family::Next).as_deref(),
            Some("/api/*")
        );
    }

    #[test]
    fn a_matcher_is_not_part_of_the_parameter_name() {
        assert_eq!(
            path_of(&["src", "routes", "albums", "[id=uuid]", "+page.ts"], "+page.ts", Family::Svelte)
                .as_deref(),
            Some("/albums/:id")
        );
    }

    #[test]
    fn a_parameter_inside_a_longer_segment_keeps_what_surrounds_it() {
        assert_eq!(
            path_of(&["pages", "[[server]]", "@[account]", "index.vue"], "index.vue", Family::Nuxt)
                .as_deref(),
            Some("/:server/@:account")
        );
    }

    #[test]
    fn an_index_names_the_folder_it_sits_in() {
        assert_eq!(
            path_of(&["pages", "settings", "index.tsx"], "index.tsx", Family::Next).as_deref(),
            Some("/settings")
        );
        assert_eq!(path_of(&["pages", "index.tsx"], "index.tsx", Family::Next).as_deref(), Some("/"));
    }

    #[test]
    fn a_method_suffix_names_the_method_and_leaves_the_path() {
        assert_eq!(spoken_method("event.get.ts").as_deref(), Some("GET"));
        assert_eq!(spoken_method("event.ts"), None);
        assert_eq!(stem("event.get.ts"), "event");
        assert_eq!(stem("[...permalink].vue"), "[...permalink]");
    }

    #[test]
    fn a_pathless_layout_names_no_segment_and_is_not_itself_a_page() {
        assert_eq!(
            path_of(&["routes", "_layout", "items.tsx"], "items.tsx", Family::TanStack).as_deref(),
            Some("/items")
        );
        assert_eq!(
            path_of(&["routes", "_layout", "index.tsx"], "index.tsx", Family::TanStack).as_deref(),
            Some("/")
        );
        assert_eq!(path_of(&["routes", "_layout.tsx"], "_layout.tsx", Family::TanStack), None);
        assert_eq!(path_of(&["routes", "__root.tsx"], "__root.tsx", Family::TanStack), None);
    }

    #[test]
    fn a_tanstack_route_reads_its_dots_as_folders_and_its_dollars_as_parameters() {
        assert_eq!(
            path_of(&["routes", "_layout.items.$itemId.tsx"], "_layout.items.$itemId.tsx", Family::TanStack)
                .as_deref(),
            Some("/items/:itemId")
        );
        assert_eq!(
            path_of(&["routes", "posts", "$postId", "edit.tsx"], "edit.tsx", Family::TanStack).as_deref(),
            Some("/posts/:postId/edit")
        );
    }

    #[test]
    fn a_remix_route_reads_its_dots_as_folders() {
        assert_eq!(
            path_of(&["app", "routes", "posts.$postId.edit.tsx"], "posts.$postId.edit.tsx", Family::Remix)
                .as_deref(),
            Some("/posts/:postId/edit")
        );
    }
}

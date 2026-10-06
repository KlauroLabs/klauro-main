use tree_sitter::Node;

use super::{Extractor, Scope};

static SPOKEN_METHODS: &[&str] = &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
static DIRECTIVE_METHODS: &[&str] = &["delete", "get", "head", "options", "patch", "post", "put"];
static DIRECTIVE_PATHS: &[&str] = &["path", "pathPrefix"];

impl<'a> Extractor<'a> {
    pub(super) fn declare_scala_routes(&mut self, block: Node, scope: &Scope) {
        if self.spec.id != "scala" {
            return;
        }
        let Some(handler) = scope.callable.clone().or_else(|| scope.owner.clone()) else { return };
        let mut cursor = block.walk();
        let clauses: Vec<Node> = block.named_children(&mut cursor).filter(|clause| clause.kind() == "case_clause").collect();
        for clause in clauses {
            let (Some(pattern), Some(body)) = (clause.child_by_field_name("pattern"), clause.child_by_field_name("body")) else {
                continue;
            };
            let Some(label) = matched_route(self.text(pattern)) else { continue };
            self.declare_route_arm(&handler, &label, clause, body, scope);
        }
    }

    pub(super) fn declare_directive_routes(&mut self, call: Node, scope: &Scope) {
        if self.spec.id != "scala" || self.directives_declared.contains(&call.id()) {
            return;
        }
        let Some(handler) = scope.callable.clone().or_else(|| scope.owner.clone()) else { return };
        self.declare_directives_under(call, "", &handler, scope);
    }

    fn directive_named<'t>(&self, call: Node<'t>, wanted: &[&str]) -> Option<(&'a str, Node<'t>)> {
        if call.kind() != "call_expression" {
            return None;
        }
        let function = call.child_by_field_name("function")?;
        let (name, arguments) = match function.kind() {
            "call_expression" => (function.child_by_field_name("function")?, function.child_by_field_name("arguments")),
            _ => (function, None),
        };
        let held = self.text(name);
        (name.kind() == "identifier" && wanted.contains(&held)).then(|| (held, arguments.unwrap_or(function)))
    }

    pub(super) fn opens_a_path_directive(&self, call: Node) -> bool {
        self.directive_named(call, DIRECTIVE_PATHS).is_some_and(|(_, arguments)| arguments.kind() == "arguments")
    }

    fn declare_directives_under(&mut self, call: Node, prefix: &str, handler: &str, scope: &Scope) {
        let Some((_, arguments)) = self.directive_named(call, DIRECTIVE_PATHS) else { return };
        self.directives_declared.insert(call.id());
        let written = self.text(arguments).trim().trim_start_matches('(').trim_end_matches(')').to_string();
        let path = format!("{prefix}{}", path_of(&written));
        let Some(body) = call.child_by_field_name("arguments") else { return };
        let mut pending = vec![body];
        while let Some(held) = pending.pop() {
            let mut cursor = held.walk();
            let children: Vec<Node> = held.named_children(&mut cursor).collect();
            for child in children.into_iter().rev() {
                if let Some((verb, _)) = self.directive_named(child, DIRECTIVE_METHODS)
                    && let Some(block) = child.child_by_field_name("arguments")
                {
                    let label = format!("{} {}", verb.to_ascii_uppercase(), if path.is_empty() { "/" } else { path.as_str() });
                    self.declare_route_arm(handler, &label, child, block, scope);
                    continue;
                }
                if self.directive_named(child, DIRECTIVE_PATHS).is_some() {
                    self.declare_directives_under(child, &path, handler, scope);
                    continue;
                }
                pending.push(child);
            }
        }
    }

    fn declare_route_arm(&mut self, handler: &str, label: &str, site: Node, body: Node, scope: &Scope) {
        let id = self.declare_dispatch_arm_registered_as(handler, label, site, body, "route");
        let mut inner = scope.clone();
        inner.callable = Some(id.clone());
        inner.owner = Some(id);
        inner.registrar = None;
        self.visit_as_an_arm(body, &inner, handler);
    }
}

fn segments_of(written: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut depth = 0u32;
    let mut quoted = false;
    for letter in written.chars() {
        match letter {
            '"' => {
                quoted = !quoted;
                current.push(letter);
            }
            '(' | '[' if !quoted => {
                depth += 1;
                current.push(letter);
            }
            ')' | ']' if !quoted => {
                depth = depth.saturating_sub(1);
                current.push(letter);
            }
            '/' if !quoted && depth == 0 => segments.push(std::mem::take(&mut current)),
            _ => current.push(letter),
        }
    }
    segments.push(current);
    segments.into_iter().map(|held| held.trim().to_string()).collect()
}

fn segment_path(segment: &str) -> Option<String> {
    if let Some(literal) = segment.strip_prefix('"').and_then(|held| held.strip_suffix('"')) {
        return (!literal.is_empty()).then(|| literal.to_string());
    }
    if segment.is_empty() || segment == "Root" || segment == "Path.Root" {
        return None;
    }
    if let Some((_, inner)) = segment.split_once('(') {
        let bound = inner.trim_end_matches(')').trim();
        return Some(format!(":{}", if bound.is_empty() { "param" } else { bound }));
    }
    let named = segment.chars().all(|letter| letter.is_alphanumeric() || letter == '_');
    named.then(|| match segment.starts_with(char::is_uppercase) {
        true => ":param".to_string(),
        false => format!(":{segment}"),
    })
}

fn path_of(written: &str) -> String {
    let parts: Vec<String> = segments_of(written).iter().filter_map(|segment| segment_path(segment)).collect();
    match parts.is_empty() {
        true => String::new(),
        false => format!("/{}", parts.join("/")),
    }
}

fn matched_route(pattern: &str) -> Option<String> {
    let (verb, rest) = pattern.split_once("->")?;
    let verb = verb.trim();
    if !SPOKEN_METHODS.contains(&verb) {
        return None;
    }
    let path = rest.split(" as ").next().unwrap_or(rest);
    let path = path.split(":?").next().unwrap_or(path);
    let path = path.split("+&").next().unwrap_or(path);
    let path = path_of(path);
    Some(format!("{verb} {}", if path.is_empty() { "/" } else { path.as_str() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pattern_names_its_verb_and_path() {
        assert_eq!(matched_route("GET -> Root / \"users\" / IntVar(id)").as_deref(), Some("GET /users/:id"));
        assert_eq!(matched_route("GET -> Root").as_deref(), Some("GET /"));
        assert_eq!(matched_route("DELETE -> Root / \"users\" / IntVar(id) as user").as_deref(), Some("DELETE /users/:id"));
        assert_eq!(matched_route("GET -> Root / \"users\" :? Limit(limit)").as_deref(), Some("GET /users"));
        assert_eq!(matched_route("Some(x)"), None);
    }

    #[test]
    fn a_directive_path_joins_its_segments() {
        assert_eq!(path_of("\"users\" / IntNumber"), "/users/:param");
        assert_eq!(path_of("\"api\" / \"v1\""), "/api/v1");
        assert_eq!(path_of("\"users\""), "/users");
    }
}

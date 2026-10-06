use tree_sitter::Node;

use super::{Extractor, string_literals};

impl<'a> Extractor<'a> {
    pub(super) fn django_label(&self, callee: &str, children: &[Node]) -> Option<String> {
        if self.spec.id != "python" || !matches!(callee, "path" | "re_path" | "url") {
            return None;
        }
        let first = children.first().filter(|first| first.kind().contains("string") || first.kind() == "parenthesized_expression")?;
        let written = string_literals(self.text(*first)).concat();
        Some(django_route(&written, callee != "path"))
    }

    pub(super) fn django_view(&self, argument: Node, callee: &str) -> Option<String> {
        if self.spec.id != "python" || !matches!(callee, "path" | "re_path" | "url") || argument.kind() != "call" {
            return None;
        }
        let function = argument.child_by_field_name("function")?;
        if function.kind() == "attribute"
            && self.text(function.child_by_field_name("attribute")?) == "as_view"
        {
            return Some(self.text(function.child_by_field_name("object")?).to_string());
        }
        let arguments = argument.child_by_field_name("arguments")?;
        let first = arguments.named_child(0)?;
        match first.kind() {
            "call" => self.django_view(first, callee),
            "identifier" | "attribute" => Some(self.text(first).to_string()),
            _ => None,
        }
    }
}

fn django_route(written: &str, expression: bool) -> String {
    let route = match expression {
        true => unexpressed(written),
        false => converted(written),
    };
    match route.starts_with('/') {
        true => route,
        false => format!("/{route}"),
    }
}

fn converted(written: &str) -> String {
    let mut route = String::new();
    let mut rest = written;
    while let Some(open) = rest.find('<') {
        route.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            route.push_str(&rest[open..]);
            return route;
        };
        let inner = &rest[open + 1..open + close];
        let name = inner.rsplit(':').next().unwrap_or(inner);
        route.push_str(&format!("{{{name}}}"));
        rest = &rest[open + close + 1..];
    }
    route.push_str(rest);
    route
}

fn unexpressed(written: &str) -> String {
    let body = written.trim_start_matches('^').trim_end_matches('$');
    let characters: Vec<char> = body.chars().collect();
    let mut route = String::new();
    let mut at = 0;
    while at < characters.len() {
        match characters[at] {
            '(' => {
                let end = group_end(&characters, at);
                let inner: String = characters[at + 1..end.saturating_sub(1).max(at + 1)].iter().collect();
                let optional = characters.get(end) == Some(&'?');
                if let Some(named) = inner.strip_prefix("?P<")
                    && let Some((name, _)) = named.split_once('>')
                {
                    if !optional {
                        route.push_str(&format!("{{{name}}}"));
                    }
                } else if !optional && !inner.starts_with('?') {
                    route.push_str(&unexpressed(&inner));
                } else if !optional && let Some(plain) = inner.strip_prefix("?:") {
                    route.push_str(&unexpressed(plain));
                }
                at = end + usize::from(optional);
            }
            '\\' => {
                if let Some(next) = characters.get(at + 1) {
                    route.push(*next);
                }
                at += 2;
            }
            held => {
                route.push(held);
                at += 1;
            }
        }
    }
    route
}

fn group_end(characters: &[char], open: usize) -> usize {
    let mut depth = 0;
    let mut at = open;
    while at < characters.len() {
        match characters[at] {
            '\\' => at += 1,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return at + 1;
                }
            }
            _ => {}
        }
        at += 1;
    }
    characters.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_converter_becomes_a_placeholder() {
        assert_eq!(django_route("users/<int:id>/posts/<slug>/", false), "/users/{id}/posts/{slug}/");
    }

    #[test]
    fn a_pattern_loses_its_anchors_and_names_its_groups() {
        assert_eq!(django_route("^b/$", true), "/b/");
        assert_eq!(django_route("^plugins/(?P<plugin_id>[.0-9A-Za-z_\\-]+)/", true), "/plugins/{plugin_id}/");
    }

    #[test]
    fn an_optional_group_is_left_out_and_escapes_are_unescaped() {
        assert_eq!(django_route("^thumbnail/(?P<id>\\d+)/(?:(?P<format>[a-z]+)/)?", true), "/thumbnail/{id}/");
        assert_eq!(django_route("^\\.well-known/jwks.json$", true), "/.well-known/jwks.json");
    }
}

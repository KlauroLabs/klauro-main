use tree_sitter::Node;

use super::{Extractor, trim_quotes};

pub(super) struct Scoped {
    pub path: String,
    pub module: String,
}

impl<'a> Extractor<'a> {
    pub(super) fn phoenix_scopes(&self, call: Node) -> Option<Scoped> {
        if self.spec.id != "elixir" {
            return None;
        }
        let mut path = String::new();
        let mut modules: Vec<String> = Vec::new();
        let mut enclosing = call.parent();
        while let Some(held) = enclosing {
            if held.kind() == "call"
                && held.child_by_field_name("target").is_some_and(|target| self.text(target) == "scope")
            {
                let (written, module) = self.scope_arguments(held);
                path = join_segments(&written, &path);
                if let Some(module) = module {
                    modules.push(module);
                }
            }
            enclosing = held.parent();
        }
        modules.reverse();
        Some(Scoped { path, module: modules.join(".") })
    }

    fn scope_arguments(&self, scope: Node) -> (String, Option<String>) {
        let mut cursor = scope.walk();
        let Some(arguments) = scope.named_children(&mut cursor).find(|child| child.kind() == "arguments") else {
            return (String::new(), None);
        };
        let mut path = String::new();
        let mut module = None;
        let mut inner = arguments.walk();
        for argument in arguments.named_children(&mut inner) {
            match argument.kind() {
                "string" if path.is_empty() => path = trim_quotes(self.text(argument)).to_string(),
                "alias" if module.is_none() => module = Some(self.text(argument).to_string()),
                "keywords" => {
                    let mut pairs = argument.walk();
                    for pair in argument.named_children(&mut pairs) {
                        let (Some(key), Some(value)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
                            continue;
                        };
                        match (self.text(key).trim().trim_end_matches(':'), value.kind()) {
                            ("path", "string") => path = trim_quotes(self.text(value)).to_string(),
                            ("alias", "alias") => module = Some(self.text(value).to_string()),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        (path, module)
    }
}

fn join_segments(outer: &str, inner: &str) -> String {
    let outer = outer.trim_matches('/');
    let inner = inner.trim_matches('/');
    match (outer.is_empty(), inner.is_empty()) {
        (true, true) => String::new(),
        (true, false) => format!("/{inner}"),
        (false, true) => format!("/{outer}"),
        (false, false) => format!("/{outer}/{inner}"),
    }
}

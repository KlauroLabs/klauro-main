use tree_sitter::Node;

use super::{Extractor, trim_quotes};
use crate::model::RegistrationFact;

const COMPOJURE_VERBS: &[&str] = &["any", "delete", "get", "head", "options", "patch", "post", "put"];
const DATA_VERBS: &[&str] = &["delete", "get", "head", "options", "patch", "post", "put"];
const SERVED_AS_A_READ: &str = "get";

impl<'a> Extractor<'a> {
    pub(super) fn clojure_route(&mut self, call: Node, callee: &str) -> bool {
        if self.spec.id != "clojure" || callee.is_empty() || !callee.chars().all(|letter| letter.is_ascii_uppercase()) {
            return false;
        }
        let verb = callee.to_ascii_lowercase();
        if !COMPOJURE_VERBS.contains(&verb.as_str()) {
            return false;
        }
        let forms = self.forms_of(call);
        let Some(path) = forms.get(1).and_then(|form| self.route_string(*form)) else { return false };
        let Some(handler) = forms.iter().skip(2).next_back().and_then(|form| self.handler_named(*form)) else { return false };
        let registrar = match verb.as_str() {
            "any" => SERVED_AS_A_READ.to_string(),
            _ => verb,
        };
        self.push_route(call, registrar, self.context_prefix(call), &path, handler);
        true
    }

    pub(super) fn clojure_data_routes(&mut self, vector: Node) {
        if self.spec.id != "clojure" || !self.opens_a_route(vector) || self.inside_a_route(vector) {
            return;
        }
        self.route_vector(vector, "");
    }

    fn route_vector(&mut self, vector: Node, prefix: &str) {
        let forms = self.forms_of(vector);
        let Some(path) = forms.first().and_then(|form| self.route_string(*form)) else { return };
        let full = join_paths(prefix, &path);
        for form in forms.into_iter().skip(1) {
            match form.kind() {
                "vec_lit" if self.opens_a_route(form) => self.route_vector(form, &full),
                "map_lit" => self.route_methods(form, &full),
                _ => {}
            }
        }
    }

    fn route_methods(&mut self, methods: Node, path: &str) {
        let forms = self.forms_of(methods);
        for pair in forms.chunks(2) {
            let [key, value] = pair else { continue };
            let verb = self.keyword_of(*key);
            if !DATA_VERBS.contains(&verb.as_str()) {
                continue;
            }
            let handler = match value.kind() {
                "map_lit" => self.handler_in_a_map(*value),
                _ => self.handler_named(*value),
            };
            if let Some(handler) = handler {
                self.push_route(*value, verb, String::new(), path, handler);
            }
        }
    }

    fn handler_in_a_map(&self, map: Node) -> Option<String> {
        let forms = self.forms_of(map);
        forms
            .chunks(2)
            .find(|pair| pair.len() == 2 && self.keyword_of(pair[0]) == "handler")
            .and_then(|pair| self.handler_named(pair[1]))
    }

    fn handler_named(&self, form: Node) -> Option<String> {
        let head = match form.kind() {
            "sym_lit" => form,
            "list_lit" => self.forms_of(form).first().copied().filter(|head| head.kind() == "sym_lit")?,
            _ => return None,
        };
        Some(self.text(head).trim().to_string())
    }

    fn push_route(&mut self, at: Node, registrar: String, prefix: String, path: &str, handler: String) {
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar,
            label: join_paths(&prefix, path),
            handler,
            line: at.start_position().row as u32 + 1,
            through: Vec::new(),
        });
    }

    fn context_prefix(&self, call: Node) -> String {
        let mut segments: Vec<String> = Vec::new();
        let mut enclosing = call.parent();
        while let Some(held) = enclosing {
            if held.kind() == "list_lit" {
                let forms = self.forms_of(held);
                if forms.first().is_some_and(|head| self.text(*head) == "context")
                    && let Some(path) = forms.get(1).and_then(|form| self.route_string(*form))
                {
                    segments.push(path);
                }
            }
            enclosing = held.parent();
        }
        segments.reverse();
        segments.iter().fold(String::new(), |base, next| join_paths(&base, next))
    }

    fn opens_a_route(&self, vector: Node) -> bool {
        self.forms_of(vector).first().is_some_and(|first| self.route_string(*first).is_some())
    }

    fn inside_a_route(&self, vector: Node) -> bool {
        let mut enclosing = vector.parent();
        while let Some(held) = enclosing {
            if held.kind() == "vec_lit" && self.opens_a_route(held) {
                return true;
            }
            enclosing = held.parent();
        }
        false
    }

    fn route_string(&self, form: Node) -> Option<String> {
        (form.kind() == "str_lit")
            .then(|| trim_quotes(self.text(form)).to_string())
            .filter(|written| written.starts_with('/'))
    }

    fn keyword_of(&self, form: Node) -> String {
        match form.kind() {
            "kwd_lit" => self.text(form).trim().trim_start_matches(':').to_string(),
            _ => String::new(),
        }
    }

    fn forms_of<'t>(&self, form: Node<'t>) -> Vec<Node<'t>> {
        let mut cursor = form.walk();
        form.named_children(&mut cursor).filter(|child| !matches!(child.kind(), "comment" | "meta_lit")).collect()
    }
}

fn join_paths(prefix: &str, path: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match (prefix.is_empty(), path.is_empty()) {
        (true, _) => format!("/{path}"),
        (false, true) => prefix.to_string(),
        (false, false) => format!("{prefix}/{path}"),
    }
}

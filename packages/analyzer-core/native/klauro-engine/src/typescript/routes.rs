use tree_sitter::Node;

use super::{line_of, trim_quotes, Extractor, Scope};
use crate::model::*;
use crate::screens::{imported_handler, DEFAULT_SCREEN, LOADED_SCREEN, MOUNTED_SCREEN, ROUTED_SCREEN};

static COMPONENT_KEYS: &[&str] = &["Component", "component", "element", "lazy", "loadComponent"];
static CHILD_KEYS: &[&str] = &["children", "routes"];
pub(super) const ROUTE_REGISTRAR: &str = "route";
const ANY_METHOD: &str = "*";

fn names_a_component(tag: &str) -> bool {
    tag.chars().next().is_some_and(char::is_uppercase)
}

fn names_an_event_prop(name: &str) -> bool {
    name.strip_prefix("on").and_then(|rest| rest.chars().next()).is_some_and(char::is_uppercase)
}

fn names_a_constant(part: &str) -> bool {
    part.contains('.') && !part.contains('/') && part.chars().next().is_some_and(char::is_uppercase)
}

fn joined(parts: &[String]) -> String {
    if let Some(constant) = parts.last().filter(|part| names_a_constant(part)) {
        return constant.trim().to_string();
    }
    let mut path = String::new();
    for part in parts {
        let part = part.trim();
        if part.starts_with('/') {
            path.clear();
        }
        path.push('/');
        path.push_str(part);
    }
    let mut cleaned = String::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        cleaned.push('/');
        cleaned.push_str(segment);
    }
    match cleaned.is_empty() {
        true => "/".to_string(),
        false => cleaned,
    }
}

fn is_module_stem(literal: &str, specifier: &str) -> bool {
    let stem = specifier.rsplit('/').next().unwrap_or(specifier);
    let stem = stem.rsplit_once('.').map(|(held, _)| held).unwrap_or(stem);
    literal == stem
}

impl<'a> Extractor<'a> {
    fn find_descendant<'t>(&self, node: Node<'t>, wanted: &dyn Fn(Node<'t>) -> bool) -> Option<Node<'t>> {
        if wanted(node) {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if let Some(found) = self.find_descendant(child, wanted) {
                return Some(found);
            }
        }
        None
    }

    fn string_value(&self, node: Node) -> Option<String> {
        match node.kind() {
            "string" => Some(trim_quotes(self.text(node)).to_string()),
            "template_string" if !self.text(node).contains("${") => Some(trim_quotes(self.text(node)).to_string()),
            "jsx_expression" | "parenthesized_expression" => self.string_value(node.named_child(0)?),
            _ => None,
        }
    }

    fn path_text(&self, node: Node) -> Option<String> {
        match node.kind() {
            "jsx_expression" | "parenthesized_expression" => self.path_text(node.named_child(0)?),
            "identifier" => self.remembered.get(self.text(node)).cloned(),
            "member_expression" => Some(self.text_owned(node)),
            _ => self.string_value(node),
        }
    }

    pub(super) fn pair_value<'t>(&self, object: Node<'t>, wanted: &str) -> Option<Node<'t>> {
        let mut cursor = object.walk();
        object
            .named_children(&mut cursor)
            .filter(|member| member.kind() == "pair")
            .find(|member| {
                member
                    .child_by_field_name("key")
                    .is_some_and(|key| trim_quotes(self.text(key)) == wanted)
            })
            .and_then(|member| member.child_by_field_name("value"))
    }

    fn dynamic_import_in(&self, value: Node) -> Option<(String, Option<String>)> {
        let call = self.find_descendant(value, &|held| {
            held.kind() == "call_expression"
                && held.child_by_field_name("function").is_some_and(|function| function.kind() == "import")
        })?;
        let arguments = call.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        let specifier = arguments
            .named_children(&mut cursor)
            .find(|argument| matches!(argument.kind(), "string" | "template_string"))?;
        let specifier = self.string_value(specifier)?;
        Some((specifier, self.export_read_after_import(value)))
    }

    fn dynamic_import(&mut self, value: Node) -> Option<String> {
        let (specifier, wanted) = self.dynamic_import_in(value)?;
        let held = self.facts.imports.iter().any(|fact| fact.specifier == specifier && fact.names.is_empty());
        if !held {
            self.facts.imports.push(ImportFact {
                file: self.file,
                specifier: specifier.clone(),
                line: line_of(value),
                type_only: false,
                everywhere: false,
                names: Vec::new(),
            });
        }
        Some(imported_handler(&specifier, wanted.as_deref()))
    }

    fn export_read_after_import(&self, value: Node) -> Option<String> {
        let continuation = self.find_descendant(value, &|held| {
            held.kind() == "call_expression"
                && held
                    .child_by_field_name("function")
                    .and_then(|function| function.child_by_field_name("property"))
                    .is_some_and(|property| self.text(property) == "then")
        })?;
        let callback = continuation.child_by_field_name("arguments")?.named_child(0)?;
        let parameter = callback
            .child_by_field_name("parameter")
            .or_else(|| callback.child_by_field_name("parameters")?.named_child(0))?;
        let parameter = self.text(parameter).trim();
        let body = callback.child_by_field_name("body")?;
        let read = self.find_descendant(body, &|held| {
            held.kind() == "member_expression"
                && held.child_by_field_name("object").is_some_and(|object| self.text(object) == parameter)
                && held.child_by_field_name("property").is_some_and(|property| self.text(property) != "default")
        })?;
        Some(self.text(read.child_by_field_name("property")?).to_string())
    }

    fn components_drawn(&self, node: Node, into: &mut Vec<String>) {
        match node.kind() {
            "jsx_expression" | "parenthesized_expression" | "as_expression" | "non_null_expression" => {
                if let Some(inner) = node.named_child(0) {
                    self.components_drawn(inner, into);
                }
            }
            "ternary_expression" => {
                for field in ["consequence", "alternative"] {
                    if let Some(branch) = node.child_by_field_name(field) {
                        self.components_drawn(branch, into);
                    }
                }
            }
            "binary_expression" => {
                if let Some(right) = node.child_by_field_name("right") {
                    self.components_drawn(right, into);
                }
            }
            "arrow_function" => {
                if let Some(body) = node.child_by_field_name("body").filter(|body| body.kind() != "statement_block") {
                    self.components_drawn(body, into);
                }
            }
            "jsx_self_closing_element" => {
                if let Some(tag) = self.tag_name(node).filter(|tag| names_a_component(tag)) {
                    into.push(tag);
                }
            }
            "jsx_element" => {
                let before = into.len();
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if matches!(child.kind(), "jsx_element" | "jsx_self_closing_element" | "jsx_expression") {
                        self.components_drawn(child, into);
                    }
                }
                if into.len() == before
                    && let Some(tag) = node
                        .named_child(0)
                        .and_then(|opening| self.tag_name(opening))
                        .filter(|tag| names_a_component(tag))
                {
                    into.push(tag);
                }
            }
            _ => {}
        }
    }

    fn tag_name(&self, tag: Node) -> Option<String> {
        tag.child_by_field_name("name").map(|name| self.text_owned(name))
    }

    fn attribute_named<'t>(&self, tag: Node<'t>, wanted: &str) -> Option<Option<Node<'t>>> {
        let mut cursor = tag.walk();
        tag.named_children(&mut cursor)
            .filter(|child| child.kind() == "jsx_attribute")
            .find(|attribute| attribute.named_child(0).is_some_and(|name| self.text(name) == wanted))
            .map(|attribute| attribute.named_child(1))
    }

    fn handler_of(&mut self, value: Node) -> Option<String> {
        match value.kind() {
            "jsx_expression" | "parenthesized_expression" | "as_expression" | "non_null_expression" => {
                self.handler_of(value.named_child(0)?)
            }
            "identifier" | "member_expression" => Some(self.text_owned(value)),
            "jsx_element" | "jsx_self_closing_element" => {
                let mut drawn = Vec::new();
                self.components_drawn(value, &mut drawn);
                drawn.into_iter().next()
            }
            "arrow_function" | "call_expression" | "function_expression" | "function" => {
                if let Some(imported) = self.dynamic_import(value) {
                    return Some(imported);
                }
                let body = value.child_by_field_name("body").filter(|body| body.kind() != "statement_block")?;
                self.handler_of(body)
            }
            _ => None,
        }
    }

    fn declares_a_route(&mut self, label: String, handler: String, node: Node) {
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: ROUTED_SCREEN.to_string(),
            label,
            handler,
            line: line_of(node),
        });
    }

    fn route_objects<'t>(&self, argument: Node<'t>) -> Vec<Node<'t>> {
        match argument.kind() {
            "object" => vec![argument],
            "array" => {
                let mut cursor = argument.walk();
                argument.named_children(&mut cursor).filter(|element| element.kind() == "object").collect()
            }
            _ => Vec::new(),
        }
    }

    pub(super) fn declared_route_objects(&mut self, callee: &str, arguments: &[Node]) {
        if crate::names::leaf(callee) != ROUTE_REGISTRAR {
            return;
        }
        let objects: Vec<Node> = arguments.iter().flat_map(|argument| self.route_objects(*argument)).collect();
        for object in objects {
            let Some(path) = self.pair_value(object, "path").and_then(|value| self.string_value(value)) else { continue };
            let Some(handler) = self
                .pair_value(object, "handler")
                .filter(|value| matches!(value.kind(), "identifier" | "member_expression"))
            else {
                continue;
            };
            let method = self
                .pair_value(object, "method")
                .and_then(|value| self.string_value(value))
                .filter(|method| method != ANY_METHOD);
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar: callee.to_string(),
                label: match method {
                    Some(method) => format!("{} {path}", method.to_ascii_uppercase()),
                    None => path,
                },
                handler: self.text_owned(handler),
                line: line_of(object),
            });
        }
    }

    fn route_path_of_object(&self, object: Node) -> Option<String> {
        self.path_text(self.pair_value(object, "path")?)
    }

    fn route_prefix_of_object(&self, object: Node) -> Vec<String> {
        let mut parts = Vec::new();
        let mut held = object;
        loop {
            let Some(array) = held.parent().filter(|parent| parent.kind() == "array") else { break };
            let Some(pair) = array.parent().filter(|parent| {
                parent.kind() == "pair"
                    && parent
                        .child_by_field_name("key")
                        .is_some_and(|key| CHILD_KEYS.contains(&trim_quotes(self.text(key))))
            }) else {
                break;
            };
            let Some(parent) = pair.parent().filter(|parent| parent.kind() == "object") else { break };
            if let Some(path) = self.route_path_of_object(parent) {
                parts.push(path);
            }
            held = parent;
        }
        parts.reverse();
        parts
    }

    pub(super) fn route_object(&mut self, object: Node) {
        self.tabulated_route(object);
        let path = self.route_path_of_object(object);
        let indexed = self.pair_value(object, "index").is_some_and(|value| value.kind() == "true");
        if path.is_none() && !indexed {
            return;
        }
        let has_children = CHILD_KEYS.iter().any(|key| {
            self.pair_value(object, key).is_some_and(|value| value.kind() == "array" && value.named_child_count() > 0)
        });
        if has_children {
            return;
        }
        let Some(component) = COMPONENT_KEYS.iter().find_map(|key| self.pair_value(object, key)) else { return };
        let Some(handler) = self.handler_of(component) else { return };
        let mut parts = self.route_prefix_of_object(object);
        parts.extend(path);
        self.declares_a_route(joined(&parts), handler, object);
    }

    fn route_like(&self, tag: Node) -> bool {
        let named_for_it = self.tag_name(tag).is_some_and(|name| name.ends_with("Route"));
        let placed = self.attribute_named(tag, "path").is_some() || self.attribute_named(tag, "index").is_some();
        let drawing = COMPONENT_KEYS.iter().any(|key| self.attribute_named(tag, key).is_some());
        placed && (drawing || named_for_it)
    }

    fn route_prefix_of_tag(&self, tag: Node) -> Vec<String> {
        let mut parts = Vec::new();
        let mut held = tag.parent();
        while let Some(parent) = held {
            if parent.kind() == "jsx_element"
                && let Some(opening) = parent.named_child(0).filter(|opening| opening.id() != tag.id())
                && self.route_like(opening)
                && let Some(path) = self.attribute_named(opening, "path").flatten().and_then(|value| self.path_text(value))
            {
                parts.push(path);
            }
            held = parent.parent();
        }
        parts.reverse();
        parts
    }

    fn route_tag(&mut self, tag: Node) {
        if !self.route_like(tag) {
            return;
        }
        let path = self.attribute_named(tag, "path").flatten().and_then(|value| self.path_text(value));
        let indexed = self.attribute_named(tag, "index").is_some();
        if path.is_none() && !indexed {
            return;
        }
        if tag.kind() == "jsx_opening_element"
            && let Some(element) = tag.parent()
        {
            let mut cursor = element.walk();
            let nested = element.named_children(&mut cursor).any(|child| {
                let opening = match child.kind() {
                    "jsx_element" => child.named_child(0),
                    "jsx_self_closing_element" => Some(child),
                    _ => None,
                };
                opening.is_some_and(|opening| self.route_like(opening))
            });
            if nested {
                return;
            }
        }
        let Some(handler) = COMPONENT_KEYS
            .iter()
            .find_map(|key| self.attribute_named(tag, key).flatten())
            .and_then(|value| self.handler_of(value))
        else {
            return;
        };
        let mut parts = self.route_prefix_of_tag(tag);
        parts.extend(path);
        self.declares_a_route(joined(&parts), handler, tag);
    }

    pub(super) fn jsx_tag(&mut self, tag: Node, scope: &Scope) {
        self.route_tag(tag);
        let Some(name) = self.tag_name(tag) else { return };
        let context = CallContext {
            in_try: scope.context.in_try,
            in_catch: scope.context.in_catch,
            in_finally: scope.context.in_finally,
            awaited: false,
            optional_chained: false,
            conditional_depth: scope.context.conditional_depth,
            loop_depth: scope.context.loop_depth,
        };
        let reference = |this: &mut Self, text: &str, component: bool| {
            let (receiver, callee) = match text.rsplit_once('.') {
                Some((receiver, callee)) => (Some(receiver.to_string()), callee.to_string()),
                None => (None, text.to_string()),
            };
            this.facts.calls.push(CallFact {
                file: this.file,
                caller: scope.enclosing_callable.clone(),
                callee,
                receiver,
                line: line_of(tag),
                column: tag.start_position().column as u32,
                argument_count: 0,
                literals: Vec::new(),
                constructs: component,
                renders: component,
                passes: Vec::new(),
                type_arguments: Vec::new(),
                context: CallContext { ..context },
            });
        };
        if names_a_component(&name) {
            reference(self, &name, true);
        }
        let mut cursor = tag.walk();
        let attributes: Vec<Node> =
            tag.named_children(&mut cursor).filter(|child| child.kind() == "jsx_attribute").collect();
        for attribute in attributes {
            let (Some(name), Some(value)) = (attribute.named_child(0), attribute.named_child(1)) else { continue };
            if !names_an_event_prop(self.text(name)) || value.kind() != "jsx_expression" {
                continue;
            }
            let Some(held) = value.named_child(0).filter(|held| matches!(held.kind(), "identifier" | "member_expression")) else {
                continue;
            };
            let text = self.text_owned(held);
            reference(self, &text, false);
        }
    }

    fn in_the_document(&self, container: Node) -> bool {
        let written = self.text(container);
        written.contains("getElementById")
            || written.contains("querySelector")
            || written.contains("document.body")
            || (container.kind() == "identifier" && self.containers.contains(written))
            || container
                .named_child(0)
                .is_some_and(|inner| matches!(container.kind(), "non_null_expression" | "as_expression" | "parenthesized_expression") && self.in_the_document(inner))
    }

    pub(super) fn remember_a_root(&mut self, name: &str, value: Node) {
        let written = self.text(value);
        if written.contains("getElementById") || written.contains("querySelector") || written.contains("document.body") {
            self.containers.insert(name.to_string());
        }
        let created = value.kind() == "call_expression"
            && value
                .child_by_field_name("function")
                .is_some_and(|function| matches!(crate::names::leaf(self.text(function)), "createRoot" | "hydrateRoot"))
            && value
                .child_by_field_name("arguments")
                .and_then(|arguments| arguments.named_child(0))
                .is_some_and(|container| self.in_the_document(container));
        if created {
            self.roots.insert(name.to_string());
        }
    }

    fn mount(&mut self, node: Node, label: String) {
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: MOUNTED_SCREEN.to_string(),
            label: label.clone(),
            handler: label,
            line: line_of(node),
        });
    }

    fn created_in_the_document(&self, render: Node) -> bool {
        render
            .child_by_field_name("object")
            .filter(|held| held.kind() == "call_expression")
            .filter(|held| {
                held.child_by_field_name("function")
                    .is_some_and(|function| crate::names::leaf(self.text(function)) == "createRoot")
            })
            .and_then(|held| held.child_by_field_name("arguments")?.named_child(0))
            .is_some_and(|container| self.in_the_document(container))
    }

    pub(super) fn mounted_screens(&mut self, node: Node) {
        let Some(arguments) = node.child_by_field_name("arguments") else { return };
        let mut cursor = arguments.walk();
        let given: Vec<Node> = arguments.named_children(&mut cursor).collect();
        if node.kind() == "new_expression" {
            let built = node.child_by_field_name("constructor").filter(|held| held.kind() == "identifier");
            let targeted = given
                .first()
                .is_some_and(|held| held.kind() == "object" && self.pair_value(*held, "target").is_some());
            if let (Some(built), true) = (built, targeted) {
                let name = self.text_owned(built);
                self.mount(node, name);
            }
            return;
        }
        let Some(function) = node.child_by_field_name("function") else { return };
        let (receiver, callee) = match function.kind() {
            "member_expression" => (
                function.child_by_field_name("object").map(|held| self.text_owned(held)),
                function.child_by_field_name("property").map(|held| self.text_owned(held)).unwrap_or_default(),
            ),
            _ => (None, self.text_owned(function)),
        };
        let mut drawn = Vec::new();
        match (receiver.as_deref(), callee.as_str()) {
            (Some(root), "render") if self.roots.contains(root) || self.created_in_the_document(function) => {
                if let Some(element) = given.first() {
                    self.components_drawn(*element, &mut drawn);
                }
            }
            (Some("ReactDOM" | "ReactDom" | "ReactDOM.default"), "render") | (None, "render")
                if given.len() >= 2 && given[1..].iter().any(|held| self.in_the_document(*held)) =>
            {
                self.components_drawn(given[0], &mut drawn);
            }
            (_, "hydrateRoot") if given.first().is_some_and(|held| self.in_the_document(*held)) => {
                if let Some(element) = given.get(1) {
                    self.components_drawn(*element, &mut drawn);
                }
            }
            (_, "createApp" | "bootstrapApplication" | "mount") if !given.is_empty() => {
                if given[0].kind() == "identifier" {
                    drawn.push(self.text_owned(given[0]));
                }
            }
            _ => {}
        }
        drawn.dedup();
        for component in drawn {
            self.mount(node, component);
        }
    }

    pub(super) fn lazy_screens(&mut self, name: &str, declarator: Node, value: Node) {
        if value.kind() != "call_expression" || !names_a_component(name) {
            return;
        }
        let Some((specifier, wanted)) = self.dynamic_import_in(value) else { return };
        let specifier = specifier.as_str();
        let hinted = wanted.or_else(|| {
            let mut cursor = value.child_by_field_name("arguments")?.walk();
            let literals: Vec<String> = value
                .child_by_field_name("arguments")?
                .named_children(&mut cursor)
                .filter(|argument| argument.kind() == "string")
                .map(|argument| trim_quotes(self.text(argument)).to_string())
                .filter(|held| names_a_component(held) && held.chars().all(|letter| letter.is_alphanumeric() || letter == '_'))
                .collect();
            literals
                .iter()
                .find(|held| is_module_stem(held, specifier))
                .cloned()
        });
        self.facts.imports.push(ImportFact {
            file: self.file,
            specifier: specifier.to_string(),
            line: line_of(declarator),
            type_only: false,
            everywhere: false,
            names: vec![ImportSpecifier {
                local: name.to_string(),
                default_import: hinted.is_none(),
                imported: hinted,
                namespace: false,
            }],
        });
    }
}

impl<'a> Extractor<'a> {
    pub(super) fn loader_of(&mut self, callable: Node) {
        let Some(body) = callable.child_by_field_name("body") else { return };
        let returned = match body.kind() {
            "statement_block" => {
                let mut cursor = body.walk();
                let statements: Vec<Node> = body.named_children(&mut cursor).collect();
                match statements.as_slice() {
                    [only] if only.kind() == "return_statement" => only.named_child(0),
                    _ => None,
                }
            }
            _ => Some(body),
        };
        let Some(expression) = returned.filter(|held| self.is_a_dynamic_import_chain(*held)) else { return };
        let Some((specifier, wanted)) = self.dynamic_import_in(expression) else { return };
        if let Some(wanted) = wanted {
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar: LOADED_SCREEN.to_string(),
                label: specifier.clone(),
                handler: wanted,
                line: line_of(expression),
            });
        }
        self.facts.imports.push(ImportFact {
            file: self.file,
            specifier,
            line: line_of(expression),
            type_only: false,
            everywhere: false,
            names: Vec::new(),
        });
    }

    fn component_wrapped_by(&self, expression: Node) -> Option<String> {
        match expression.kind() {
            "identifier" => {
                let named = self.text(expression);
                names_a_component(named).then(|| named.to_string())
            }
            "call_expression" => {
                let arguments = expression.child_by_field_name("arguments")?;
                let mut cursor = arguments.walk();
                let held: Vec<Node> = arguments.named_children(&mut cursor).collect();
                held.into_iter().find_map(|argument| self.component_wrapped_by(argument)).or_else(|| {
                    expression.child_by_field_name("function").filter(|inner| inner.kind() == "call_expression").and_then(|inner| self.component_wrapped_by(inner))
                })
            }
            _ => None,
        }
    }

    pub(super) fn remember_the_default_export(&mut self, statement: Node) {
        let Some(value) = statement.child_by_field_name("value") else { return };
        let Some(named) = self.component_wrapped_by(value) else { return };
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: DEFAULT_SCREEN.to_string(),
            label: named.clone(),
            handler: named,
            line: line_of(statement),
        });
    }

    fn is_a_dynamic_import_chain(&self, expression: Node) -> bool {
        let mut held = expression;
        while held.kind() == "call_expression" {
            let Some(function) = held.child_by_field_name("function") else { return false };
            if function.kind() == "import" {
                return true;
            }
            match function.child_by_field_name("object") {
                Some(inner) => held = inner,
                None => return false,
            }
        }
        false
    }

    pub(super) fn remember_a_table_of_paths(&mut self, name: &str, value: Node, line: u32) {
        let mut value = value;
        while matches!(value.kind(), "as_expression" | "parenthesized_expression" | "satisfies_expression") {
            let Some(inner) = value.named_child(0) else { return };
            value = inner;
        }
        if value.kind() != "object" {
            return;
        }
        let mut cursor = value.walk();
        let pairs: Vec<Node> = value.named_children(&mut cursor).filter(|member| member.kind() == "pair").collect();
        let mut held = Vec::new();
        for pair in pairs {
            let (Some(key), Some(written)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else { return };
            let Some(path) = self.string_value(written).filter(|path| path.starts_with('/')) else { return };
            held.push((trim_quotes(self.text(key)).to_string(), path));
        }
        for (key, path) in held {
            self.facts.locals.push(LocalBinding {
                file: self.file,
                unit: String::new(),
                name: format!("{name}.{key}"),
                annotation: None,
                constructed: None,
                from_call: None,
                written: Some(path),
                stands_for: None,
                from_values: Vec::new(),
                line,
                ..Default::default()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(held: &[&str]) -> Vec<String> {
        held.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn a_relative_path_joins_under_its_parents_and_an_absolute_one_starts_over() {
        assert_eq!(joined(&parts(&["/", "orders/:id"])), "/orders/:id");
        assert_eq!(joined(&parts(&["codebases/:id", "flows"])), "/codebases/:id/flows");
        assert_eq!(joined(&parts(&["/admin", "/login"])), "/login");
        assert_eq!(joined(&parts(&["/"])), "/");
        assert_eq!(joined(&[]), "/");
    }

    #[test]
    fn a_named_constant_stands_for_its_path_until_the_table_it_belongs_to_is_read() {
        assert_eq!(joined(&parts(&["RoutePaths.Home"])), "RoutePaths.Home");
        assert!(!names_a_constant("v1.0/items"));
        assert!(!names_a_constant("settings"));
    }

    #[test]
    fn only_a_capitalised_tag_is_a_component_and_only_prefixed_props_bind_a_handler() {
        assert!(names_a_component("OrderPage"));
        assert!(!names_a_component("div"));
        assert!(names_an_event_prop("onClick"));
        assert!(!names_an_event_prop("once"));
        assert!(!names_an_event_prop("on"));
    }
}

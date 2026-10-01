use rustc_hash::FxHashMap as HashMap;

use tree_sitter::{Node, Tree};

use crate::language::LanguageSpec;
use crate::model::*;

static COLUMNS_OF: &[&str] = &[
    "appends", "attributes", "casts", "columns", "dates", "fields", "fillable", "guarded",
    "hidden", "visible",
];

fn names_code(text: &str) -> bool {
    let mut characters = text.chars();
    characters.next().is_some_and(|first| first.is_alphabetic() || first == '_' || first == ':')
        && text.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, '_' | '.' | ':' | '\\')
        })
}

static REQUEST_METHODS: &[&str] =
    &["delete", "get", "head", "options", "patch", "post", "put", "trace"];

const REFERENCE_DEPTH: u8 = 3;
const REFERENCE_WIDTH: usize = 4;

fn bare_type(annotation: &str) -> Option<String> {
    let named = annotation
        .trim_start_matches([':', ' ', '&'])
        .split(['<', '[', '(', '{', '>', ' ', ',', '&'])
        .next()
        .unwrap_or(annotation)
        .rsplit([':', '.'])
        .next()
        .unwrap_or(annotation)
        .trim();
    named
        .chars()
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_')
        .then(|| named.to_string())
}

fn settled(receiver: &str) -> Option<String> {
    let path: Vec<&str> = receiver
        .split('.')
        .filter(|segment| !segment.trim().is_empty() && segment.trim() != "await")
        .collect();
    match path.is_empty() {
        true => None,
        false => Some(path.join(".")),
    }
}

static PASSES_ITS_VALUE_THROUGH: &[&str] = &[
    "argument",
    "await_expression",
    "expression_list",
    "parenthesized_expression",
    "try_expression",
];

fn unwrapped(node: Node) -> Node {
    match matches!(node.kind(), "argument" | "expression_list") && node.named_child_count() == 1 {
        true => node.named_child(0).unwrap_or(node),
        false => node,
    }
}

fn unwrapped_for<'t>(node: Node<'t>, language: &str) -> Node<'t> {
    let mut current = unwrapped(node);
    if language != "rust" {
        return current;
    }
    for _ in 0..8 {
        if current.kind() == "reference_expression"
            && let Some(value) = current.child_by_field_name("value")
        {
            current = value;
            continue;
        }
        if !PASSES_ITS_VALUE_THROUGH.contains(&current.kind()) || current.named_child_count() != 1 {
            break;
        }
        current = current.named_child(0).unwrap_or(current);
    }
    current
}

pub struct Extractor<'a> {
    source: &'a [u8],
    file: u32,
    module_id: String,
    spec: &'static LanguageSpec,
    facts: FileFacts,
    metrics: HashMap<String, UnitMetrics>,
    types_by_name: HashMap<String, String>,
    remembered: HashMap<String, String>,
    labelled: HashMap<usize, (String, String)>,
}

#[derive(Clone)]
struct Scope {
    owner: Option<String>,
    extends: Option<String>,
    in_catch: bool,
    in_finally: bool,
    callable: Option<String>,
    registrar: Option<String>,
    type_owner: Option<String>,
    self_binding: Option<String>,
    in_try: bool,
    conditional_depth: u16,
    loop_depth: u16,
    awaited: bool,
    dispatch_param: Option<String>,
    argv_param: Option<String>,
}

fn span_of(node: Node) -> Span {
    Span {
        line: node.start_position().row as u32 + 1,
        column: node.start_position().column as u32,
        end_line: node.end_position().row as u32 + 1,
        end_column: node.end_position().column as u32,
    }
}

impl<'a> Extractor<'a> {
    pub fn new(source: &'a [u8], file: u32, path: &str, spec: &'static LanguageSpec) -> Self {
        Extractor {
            source,
            file,
            module_id: path.to_string(),
            spec,
            facts: FileFacts::default(),
            metrics: HashMap::default(),
            types_by_name: HashMap::default(),
            remembered: HashMap::default(),
            labelled: HashMap::default(),
        }
    }

    fn collect_types(&mut self, node: Node) {
        let mut cursor = node.walk();
        let mut descend = true;
        loop {
            let current = cursor.node();
            if self
                .spec
                .declares.type_kinds
                .iter()
                .any(|(kind, _)| *kind == current.kind())
                && (!self.spec.declares.type_requires_body
                    || self
                        .spec
                        .signature.body_fields
                        .iter()
                        .any(|field| current.child_by_field_name(field).is_some()))
                && let Some(name) = self.name_of(current)
            {
                let id = self.id("type", &name, current);
                self.types_by_name.entry(name).or_insert(id);
            }
            if descend && cursor.goto_first_child() {
                continue;
            }
            descend = true;
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return;
                }
            }
        }
    }

    fn owner_for_type_name(&self, name: &str) -> Option<String> {
        self.types_by_name.get(base_name(name)).cloned()
    }

    fn handed_over<'b>(&self, node: Node<'b>, found: &mut Vec<(String, Node<'b>)>) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind().contains("string") || configures_the_call(child.kind()) {
                continue;
            }
            if matches!(child.kind(), "arguments" | "argument_list") {
                let mut inner = child.walk();
                for argument in child.named_children(&mut inner) {
                    if configures_the_call(argument.kind()) {
                        continue;
                    }
                    for handler in self.referenced_names(unwrapped(argument), 0) {
                        found.push((handler, argument));
                    }
                }
            }
            self.handed_over(child, found);
        }
    }

    fn registers_an_mcp_tool(&mut self, receiver: &Option<String>, callee: &str, children: &[Node]) -> bool {
        if callee != "AddTool" || children.len() < 2 {
            return false;
        }
        let Some(name) = self.named_by_a_new_tool_call(children[0]) else { return false };
        let registrar = match receiver {
            Some(receiver) => format!("{receiver}.{callee}"),
            None => callee.to_string(),
        };
        if let Some(inline) = self.handled_inline(children[1]) {
            self.labelled.insert(inline.id(), (registrar, name));
            return true;
        }
        for handler in self.referenced_names(children[1], 0) {
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar: registrar.clone(),
                label: name.clone(),
                handler,
                line: children[1].start_position().row as u32 + 1,
            });
        }
        true
    }

    fn named_by_a_new_tool_call(&self, node: Node) -> Option<String> {
        if !node.kind().contains("call") {
            return None;
        }
        let function = node.child_by_field_name("function")?;
        let member = function
            .child_by_field_name("field")
            .or_else(|| function.child_by_field_name("name"))
            .or_else(|| function.child_by_field_name("property"))
            .map(|found| self.text(found))
            .unwrap_or_else(|| self.text(function));
        if crate::names::leaf(member) != "NewTool" {
            return None;
        }
        let arguments = node.child_by_field_name("arguments").or_else(|| {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .find(|child| child.kind() == "arguments" || child.kind() == "argument_list")
        })?;
        let mut cursor = arguments.walk();
        arguments
            .named_children(&mut cursor)
            .find(|argument| argument.kind().contains("string"))
            .map(|argument| trim_quotes(self.text(argument)).to_string())
    }

    fn mounted_route(&self, node: Node) -> Option<String> {
        let path = self.mounted_path(node)?;
        match self.mounted_method(node) {
            Some(method) => Some(format!("{method} {path}")),
            None => Some(path),
        }
    }

    fn mounted_path(&self, node: Node) -> Option<String> {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind().contains("string") {
                let text = trim_quotes(self.text(child));
                if text.starts_with('/') {
                    return Some(text.to_string());
                }
                continue;
            }
            if let Some(found) = self.mounted_path(child) {
                return Some(found);
            }
        }
        None
    }

    fn mounted_method(&self, node: Node) -> Option<String> {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.spec.calls.kinds.contains(&child.kind())
                && let Some(function) = child.child_by_field_name("function")
            {
                let verb = crate::names::leaf(self.text(function)).to_ascii_lowercase();
                if REQUEST_METHODS.binary_search(&verb.as_str()).is_ok() {
                    return Some(verb.to_ascii_uppercase());
                }
            }
            if let Some(found) = self.mounted_method(child) {
                return Some(found);
            }
        }
        None
    }

    fn referenced_names(&self, node: Node, depth: u8) -> Vec<String> {
        if self.spec.names.leaf_kinds.contains(&node.kind()) || node.kind().contains("selector") {
            return vec![self.text(node).to_string()];
        }
        if node.kind().contains("string") {
            let text = trim_quotes(self.text(node));
            return match text.contains('#') || text.contains('@') {
                true => vec![text.to_string()],
                false => Vec::new(),
            };
        }
        if node.named_child_count() == 0 {
            let text = self.text(node);
            return match names_code(text) {
                true => vec![text.to_string()],
                false => Vec::new(),
            };
        }
        if depth >= REFERENCE_DEPTH {
            return Vec::new();
        }
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .flat_map(|child| self.referenced_names(child, depth + 1))
            .take(REFERENCE_WIDTH)
            .collect()
    }

    fn text(&self, node: Node) -> &'a str {
        std::str::from_utf8(&self.source[node.byte_range()]).unwrap_or("")
    }

    fn id(&self, kind: &str, name: &str, node: Node) -> String {
        format!(
            "{}:{kind}:{name}:{}:{}",
            self.module_id,
            node.start_position().row + 1,
            node.start_position().column + 1
        )
    }

    fn unit(&mut self, scope: &Scope) -> Option<&mut UnitMetrics> {
        let callable = scope.callable.clone()?;
        Some(self.metrics.entry(callable).or_default())
    }

    fn namespace_of(&self, node: Node) -> Option<String> {
        let named = node.child_by_field_name("name").or_else(|| {
            let mut cursor = node.walk();
            node.named_children(&mut cursor).next()
        })?;
        let text = self.text(named).trim().trim_end_matches(';').trim();
        (!text.is_empty() && !text.contains(char::is_whitespace)).then(|| text.to_string())
    }

    fn name_of(&self, node: Node) -> Option<String> {
        if self.spec.names.whole_kinds.contains(&node.kind()) {
            return Some(self.text(node).trim().to_string());
        }
        for field in self.spec.names.fields {
            if let Some(found) = node.child_by_field_name(field) {
                if self.spec.names.whole_kinds.contains(&found.kind()) {
                    return Some(self.text(found).trim().to_string());
                }
                if let Some(name) = self.leaf_name(found) {
                    return Some(name);
                }
            }
        }
        if self.spec.names.require_field {
            return None;
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.spec.names.descend.contains(&child.kind())
                && let Some(name) = self.leaf_name(child)
            {
                return Some(name);
            }
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.spec.names.leaf_kinds.contains(&child.kind()) && !self.skipped_word(child) {
                return Some(self.text(child).to_string());
            }
        }
        None
    }

    fn skipped_word(&self, node: Node) -> bool {
        !self.spec.names.skip_words.is_empty()
            && self.spec.names.skip_words.contains(&self.text(node).trim())
    }

    fn leaf_name(&self, node: Node) -> Option<String> {
        if self.spec.names.leaf_kinds.contains(&node.kind()) && !self.skipped_word(node) {
            return Some(self.text(node).to_string());
        }
        if !self.spec.names.descend.contains(&node.kind()) {
            if let Some(named) = node.child_by_field_name("name")
                && self.spec.names.leaf_kinds.contains(&named.kind())
                && !self.skipped_word(named)
            {
                return Some(self.text(named).to_string());
            }
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if self.spec.names.leaf_kinds.contains(&child.kind()) && !self.skipped_word(child) {
                    return Some(self.text(child).to_string());
                }
            }
            return None;
        }
        for field in ["declarator", "name"] {
            if let Some(found) = node.child_by_field_name(field) {
                if self.spec.names.whole_kinds.contains(&found.kind()) {
                    return Some(self.text(found).trim().to_string());
                }
                if let Some(name) = self.leaf_name(found) {
                    return Some(name);
                }
            }
        }
        if self.spec.names.require_field {
            return None;
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if let Some(name) = self.leaf_name(child) {
                return Some(name);
            }
        }
        None
    }

    fn parameter_list<'t>(&self, node: Node<'t>) -> Option<Node<'t>> {
        for field in self.spec.signature.parameter_fields {
            if let Some(found) = node.child_by_field_name(field) {
                return Some(found);
            }
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.spec.signature.parameter_fields.contains(&child.kind()) {
                return Some(child);
            }
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.spec.names.descend.contains(&child.kind())
                && let Some(found) = self.parameter_list(child)
            {
                return Some(found);
            }
        }
        None
    }

    fn parameters_in(&self, list: Node) -> Vec<Parameter> {
        let mut parameters = Vec::new();
        let mut cursor = list.walk();
        for parameter in list.named_children(&mut cursor) {
            if !self.spec.signature.parameter_kinds.contains(&parameter.kind()) {
                continue;
            }
            let name = self
                .name_of(parameter)
                .unwrap_or_else(|| self.text(parameter).to_string());
            let type_annotation = parameter
                .child_by_field_name("type")
                .map(|annotation| self.text(annotation).to_string())
                .or_else(|| self.trailing_type(parameter))
                .or_else(|| self.declared_type(parameter));
            parameters.push(Parameter {
                name,
                type_annotation,
                optional: false,
                default_value: parameter
                    .child_by_field_name("value")
                    .or_else(|| parameter.child_by_field_name("default_value"))
                    .map(|value| self.text(value).to_string()),
            });
        }
        parameters
    }

    fn declared_type(&self, parameter: Node) -> Option<String> {
        if self.spec.signature.parameter_type_kinds.is_empty() {
            return None;
        }
        let mut cursor = parameter.walk();
        parameter
            .named_children(&mut cursor)
            .find(|child| self.spec.signature.parameter_type_kinds.contains(&child.kind()))
            .map(|found| self.text(found).trim().to_string())
            .filter(|found| !found.is_empty())
    }

    fn constructor_parameters(&self, node: Node) -> Vec<Parameter> {
        let mut at = node;
        for step in self.spec.signature.constructor_parameter_path {
            let mut cursor = at.walk();
            let Some(found) = at.named_children(&mut cursor).find(|child| child.kind() == *step)
            else {
                return Vec::new();
            };
            at = found;
        }
        if std::ptr::eq(&at, &node) {
            return Vec::new();
        }
        self.parameters_in(at)
    }

    fn trailing_type(&self, parameter: Node) -> Option<String> {
        let mut cursor = parameter.walk();
        let children: Vec<Node> = parameter.named_children(&mut cursor).collect();
        children
            .iter()
            .rev()
            .find(|child| self.spec.signature.return_child_kinds.contains(&child.kind()))
            .map(|child| self.text(*child).trim().to_string())
    }

    fn signature_of(&self, node: Node) -> Signature {
        let parameters = match self.parameter_list(node) {
            Some(list) => self.parameters_in(list),
            None => self.parameters_in(node),
        };
        let return_type = self
            .spec
            .signature.return_fields
            .iter()
            .find_map(|field| node.child_by_field_name(field))
            .map(|found| self.text(found).trim().to_string())
            .filter(|found| !found.is_empty())
            .or_else(|| self.trailing_return(node));
        let receiver = self
            .extension_receiver(node)
            .or_else(|| self.extended_parameter(node, &parameters));
        Signature { parameters, return_type, type_parameters: Vec::new(), receiver }
    }

    fn type_kind(&self, kind: &str) -> NodeKind {
        self.spec
            .declares
            .type_kinds
            .iter()
            .find(|(known, _)| *known == kind)
            .map(|(_, node_kind)| *node_kind)
            .unwrap_or(NodeKind::Class)
    }

    fn extended_type(&self, node: Node) -> Option<String> {
        let required = self
            .spec
            .signature
            .extension_container_kinds
            .iter()
            .find(|(kind, _)| *kind == node.kind())
            .map(|(_, word)| *word)?;
        if !required.is_empty() {
            let mut cursor = node.walk();
            let written = node
                .named_children(&mut cursor)
                .find(|child| child.kind() == "modifiers")
                .map(|found| self.text(found).to_string())
                .unwrap_or_default();
            if !written.split_whitespace().any(|word| word == required) {
                return None;
            }
        }
        let parameters = self.parameter_list(node)?;
        self.parameters_in(parameters).into_iter().next()?.type_annotation
    }

    fn extended_parameter(&self, node: Node, parameters: &[Parameter]) -> Option<String> {
        let word = self.spec.signature.extension_parameter_word;
        if word.is_empty() {
            return None;
        }
        let first = parameters.first()?;
        let declared = self
            .spec
            .signature
            .parameter_fields
            .iter()
            .find_map(|field| node.child_by_field_name(field))?;
        let mut cursor = declared.walk();
        let written = declared.named_children(&mut cursor).next()?;
        self.text(written)
            .trim_start()
            .strip_prefix(word)
            .filter(|rest| rest.starts_with(char::is_whitespace))?;
        first.type_annotation.clone()
    }

    fn extension_receiver(&self, node: Node) -> Option<String> {
        if self.spec.signature.extension_receiver_kinds.is_empty() {
            return None;
        }
        let name = self
            .spec
            .names.fields
            .iter()
            .find_map(|field| node.child_by_field_name(field))?;
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .take_while(|child| child.start_byte() < name.start_byte())
            .find(|child| self.spec.signature.extension_receiver_kinds.contains(&child.kind()))
            .map(|found| self.text(found).trim().to_string())
            .filter(|found| !found.is_empty())
    }

    fn trailing_return(&self, node: Node) -> Option<String> {
        if self.spec.signature.return_child_kinds.is_empty() {
            return None;
        }
        let mut cursor = node.walk();
        let children: Vec<Node> = node.named_children(&mut cursor).collect();
        children
            .iter()
            .rev()
            .find(|child| self.spec.signature.return_child_kinds.contains(&child.kind()))
            .map(|child| self.text(*child).trim().to_string())
    }

    fn published(&self, node: Node) -> Modifiers {
        let mut cursor = node.walk();
        let open = node.children(&mut cursor).any(|child| match child.kind() {
            "visibility_modifier" => !self.text(child).contains("crate") && !self.text(child).contains("super"),
            "modifiers" | "modifier" | "access_modifier" | "accessibility_modifier" | "member_modifiers" => {
                let held = self.text(child);
                held.contains("public") || held.contains("open")
            }
            held => held == "public" || held == "open",
        });
        Modifiers { exported: open, ..Modifiers::default() }
    }

    pub fn run(mut self, tree: &Tree, path: &str, line_count: u32) -> FileFacts {
        let root = tree.root_node();
        self.facts.lines = line_count;
        self.facts.parse_errors = crate::typescript::count_errors(root);
        self.facts.nodes.push(IndexNode {
            id: self.module_id.clone(),
            name: path.to_string(),
            kind: NodeKind::Module,
            file: self.file,
            span: span_of(root),
            parent: None,
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
        callback_of: None,
            registration_label: None,
        });
        self.collect_types(root);
        let scope = Scope {
            owner: Some(self.module_id.clone()),
            extends: None,
            in_catch: false,
            in_finally: false,
            callable: None,
            registrar: None,
            type_owner: None,
            self_binding: None,
            in_try: false,
            conditional_depth: 0,
            loop_depth: 0,
            awaited: false,
            dispatch_param: None,
            argv_param: None,
        };
        self.walk(root, &scope);

        let mut metrics: Vec<UnitMetricsEntry> = std::mem::take(&mut self.metrics)
            .into_iter()
            .map(|(unit, mut metrics)| {
                metrics.reads.sort();
                metrics.reads.dedup();
                metrics.writes.sort();
                metrics.writes.dedup();
                metrics.throws.sort();
                metrics.throws.dedup();
                UnitMetricsEntry { unit, metrics }
            })
            .collect();
        metrics.sort_by(|left, right| left.unit.cmp(&right.unit));
        self.facts.metrics = metrics;
        self.facts
    }

    fn walk(&mut self, node: Node, scope: &Scope) {
        let mut cursor = node.walk();
        if !cursor.goto_first_child() {
            return;
        }
        loop {
            self.visit(cursor.node(), scope);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }

    fn visit(&mut self, node: Node, scope: &Scope) {
        if !node.is_named() {
            return;
        }
        let kind = node.kind();

        if let Some(extended) = self.extended_type(node) {
            let mut inner = scope.clone();
            inner.extends = Some(extended);
            let handled = self.spec.declares.type_kinds.iter().any(|(known, _)| *known == kind);
            match handled {
                true => self.declare_type(node, &inner, self.type_kind(kind)),
                false => self.walk(node, &inner),
            }
            return;
        }

        if self.spec.declares.namespace_kinds.contains(&kind) && self.facts.namespace.is_none() {
            self.facts.namespace = self.namespace_of(node);
        }

        if let Some((_, node_kind)) = self.spec.declares.type_kinds.iter().find(|(name, _)| *name == kind) {
            let declared = !self.spec.declares.type_requires_body
                || self
                    .spec
                    .signature.body_fields
                    .iter()
                    .any(|field| node.child_by_field_name(field).is_some());
            if declared {
                self.declare_type(node, scope, *node_kind);
            } else {
                self.walk(node, scope);
            }
            return;
        }
        if let Some((_, node_kind)) = self
            .spec
            .declares.function_kinds
            .iter()
            .find(|(name, _)| *name == kind)
        {
            self.declare_function(node, scope, *node_kind);
            return;
        }
        if self.spec.declares.impl_kinds.contains(&kind) {
            let owner = node
                .child_by_field_name(self.spec.declares.impl_type_field)
                .map(|found| self.text(found).to_string())
                .and_then(|name| self.owner_for_type_name(&name));
            let mut inner = scope.clone();
            if owner.is_some() {
                inner.owner = owner.clone();
                inner.type_owner = owner;
            }
            self.walk(node, &inner);
            return;
        }
        if self.spec.declares.field_kinds.contains(&kind) && scope.type_owner.is_some() {
            self.declare_field(node, scope);
            self.declare_its_table(node, scope);
            for value in self.given_to_a_field(node) {
                self.visit(value, scope);
            }
            return;
        }
        if self.spec.declares.import_kinds.contains(&kind) {
            self.declare_import(node);
            return;
        }
        if !self.spec.keywords.kind.is_empty() && kind == self.spec.keywords.kind {
            let keyword = node
                .child_by_field_name(self.spec.keywords.target_field)
                .or_else(|| node.named_child(0))
                .map(|target| self.text(target).trim().to_string())
                .unwrap_or_default();
            if crate::language::role_keywords(self.spec.id).contains(&keyword.as_str()) {
                self.declare_role(node, scope);
                return;
            }
            if self.spec.keywords.types.contains(&keyword.as_str()) {
                self.keyword_declaration(node, scope, NodeKind::Class);
                return;
            }
            if keyword.rsplit('/').next() == Some("defendpoint")
                && let Some((verb, path)) = self.endpoint_declared(node)
            {
                self.declare_endpoint(node, scope, verb, path);
                return;
            }
            if self.spec.keywords.functions.contains(&keyword.as_str()) {
                self.keyword_declaration(node, scope, NodeKind::Function);
                return;
            }
        }
        if crate::language::taken_apart_kinds(self.spec.id).contains(&kind) {
            self.declare_taken_apart(node, scope);
            self.declare_routed_by_hand(node, scope);
            if scope.dispatch_param.is_some() {
                self.declare_channel_dispatch_match(node, scope);
            }
        }
        if self.spec.id == "rust" && kind == "if_expression" && scope.dispatch_param.is_some() {
            self.declare_channel_dispatch_if(node, scope);
        }
        if kind.starts_with("if_") && scope.argv_param.is_some() {
            self.declare_cli_dispatch_if(node, scope);
        }
        if self.spec.id == "rust" && kind == "const_item" {
            self.declare_rust_const(node, scope);
        }
        if self.spec.id == "rust" && kind == "mod_item" {
            self.declare_module_alias(node);
        }
        if self.spec.declares.binding_kinds.contains(&kind) {
            if !self.declare_binding(node, scope) {
                self.walk(node, scope);
            }
            return;
        }
        if kind.ends_with("composite_literal")
            || kind == "struct_expression"
            || kind == "object_creation_expression"
        {
            self.declare_command(node, scope);
        }
        if INDEXES_A_HOLDER.contains(&kind) {
            let target = self.text(node).to_string();
            if let Some(named) = crate::model::a_setting_read(&target) {
                self.facts.settings.push(crate::model::SettingRead {
                    file: self.file,
                    unit: scope.callable.clone(),
                    name: named.to_string(),
                    line: node.start_position().row as u32 + 1,
                });
            }
        }
        if self.spec.calls.kinds.contains(&kind) {
            let registrar = self.record_call(node, scope);
            let mut inner = scope.clone();
            inner.registrar = registrar;
            self.walk(node, &inner);
            return;
        }
        if let Some(arm) = crate::arms::dispatched(self.spec.id, node, |held| self.text(held)) {
            self.declare_arm(node, scope, arm);
            return;
        }
        if self.spec.declares.lambda_kinds.contains(&kind) {
            self.declare_callback(node, scope);
            return;
        }
        if ASSIGNS.contains(&kind) {
            let left = node.child_by_field_name("left").or_else(|| node.named_child(0));
            if let Some(indexed) = left.filter(|left| INDEXES_A_HOLDER.contains(&left.kind())) {
                self.record_an_indexed_write(indexed, node, scope);
            }
            if let Some(member) = left.and_then(|left| own_member(self.text(left))) {
                if let Some(unit) = self.unit(scope) {
                    unit.writes.push(member);
                }
            }
        }
        if self.spec.flow.branch_kinds.contains(&kind) {
            if let Some(unit) = self.unit(scope) {
                unit.branches += 1;
            }
            let mut inner = scope.clone();
            inner.conditional_depth += 1;
            self.walk(node, &inner);
            return;
        }
        if self.spec.flow.loop_kinds.contains(&kind) {
            if let Some(unit) = self.unit(scope) {
                unit.loops += 1;
            }
            let mut inner = scope.clone();
            inner.loop_depth += 1;
            self.walk(node, &inner);
            return;
        }
        if self.spec.flow.return_kinds.contains(&kind) {
            if let Some(unit) = self.unit(scope) {
                unit.returns += 1;
            }
            self.walk(node, scope);
            return;
        }
        if self.spec.flow.try_kinds.contains(&kind) {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                let mut inner = scope.clone();
                if self.spec.flow.catch_kinds.contains(&child.kind()) {
                    inner.in_catch = true;
                } else if self.spec.flow.finally_kinds.contains(&child.kind()) {
                    inner.in_finally = true;
                } else {
                    inner.in_try = true;
                }
                self.visit(child, &inner);
            }
            return;
        }
        if self.spec.flow.assert_kinds.contains(&kind) {
            if let Some(unit) = self.unit(scope) {
                unit.asserts += 1;
            }
            self.walk(node, scope);
            return;
        }
        if self.spec.flow.throw_kinds.contains(&kind) {
            let thrown = node
                .named_child(0)
                .map(|value| throw_name(self.text(value)))
                .unwrap_or_default();
            if let Some(unit) = self.unit(scope) {
                unit.throws.push(thrown);
            }
            self.walk(node, scope);
            return;
        }
        if self.spec.flow.await_kinds.contains(&kind) {
            if let Some(unit) = self.unit(scope) {
                unit.awaits += 1;
            }
            let mut inner = scope.clone();
            inner.awaited = true;
            self.walk(node, &inner);
            return;
        }
        self.walk(node, scope);
    }

    fn decorators_within(&self, node: Node, found: &mut Vec<Decorator>) {
        if self.spec.declares.decorator_kinds.contains(&node.kind()) {
            found.push(self.decorator(node));
        } else if self.spec.declares.decorator_container_kinds.contains(&node.kind()) {
            let mut cursor = node.walk();
            for entry in node.named_children(&mut cursor) {
                self.decorators_within(entry, found);
            }
        }
    }

    fn decorators_of(&self, node: Node) -> Vec<Decorator> {
        if self.spec.declares.decorator_kinds.is_empty() {
            return Vec::new();
        }
        let mut found = Vec::new();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.decorators_within(child, &mut found);
        }
        let mut preceding = node.prev_named_sibling();
        while let Some(written) = preceding.filter(|found| {
            self.spec.declares.decorator_kinds.contains(&found.kind()) || found.kind().contains("comment")
        }) {
            if !written.kind().contains("comment") {
                found.push(self.decorator(written));
            }
            preceding = written.prev_named_sibling();
        }
        found
    }

    fn decorator(&self, node: Node) -> Decorator {
        let text = self.text(node);
        let name = text
            .trim()
            .trim_start_matches(['@', '#', '['])
            .trim_start();
        let name_end = name.find(['(', ' ', '\n', ']']).unwrap_or(name.len());
        Decorator {
            name: name[..name_end].trim().to_string(),
            arguments: written_arguments(text),
        }
    }

    fn arguments_of<'t>(&self, node: Node<'t>) -> Option<Node<'t>> {
        if let Some(found) = node.child_by_field_name("arguments") {
            return Some(found);
        }
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .find(|child| child.kind() == "arguments" || child.kind() == "argument_list")
    }

    fn keyword_name(&self, node: Node) -> Option<String> {
        let Some(arguments) = self.arguments_of(node) else {
            return self.name_of(node.named_child(1)?);
        };
        let first = arguments.named_child(0)?;
        if first.kind() == self.spec.keywords.kind {
            return first
                .child_by_field_name(self.spec.keywords.target_field)
                .map(|target| self.text(target).trim().to_string());
        }
        Some(self.text(first).trim().to_string())
    }

    fn endpoint_declared(&self, node: Node) -> Option<(String, String)> {
        let mut cursor = node.walk();
        let parts: Vec<Node> = node.named_children(&mut cursor).skip(1).take(3).collect();
        let verb = parts
            .iter()
            .map(|part| self.text(*part).trim().trim_start_matches(':').to_ascii_uppercase())
            .find(|word| matches!(word.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"))?;
        let path = parts
            .iter()
            .map(|part| trim_quotes(self.text(*part).trim()).to_string())
            .find(|written| written.starts_with('/'))?;
        Some((verb, path))
    }

    fn declare_endpoint(&mut self, node: Node, scope: &Scope, verb: String, path: String) {
        let name = format!("{verb} {path}");
        let id = self.id("function", &name, node);
        let owner = scope.type_owner.clone().or_else(|| scope.owner.clone());
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: Some(self.keyword_signature(node)),
            modifiers: self.published(node),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: Some(format!("defendpoint.{}", verb.to_ascii_lowercase())),
            registration_label: Some(path),
        });
        if let Some(owner) = owner.as_deref() {
            self.facts.edges.push(IndexEdge { source: owner.to_string(), target: id.clone(), kind: EdgeKind::Contains });
        }
        let mut inner = scope.clone();
        inner.owner = Some(id.clone());
        inner.callable = Some(id);
        inner.type_owner = None;
        self.walk(node, &inner);
    }

    fn keyword_declaration(&mut self, node: Node, scope: &Scope, kind: NodeKind) {
        let Some(name) = self.keyword_name(node) else {
            self.walk(node, scope);
            return;
        };
        let id = self.id(
            if kind == NodeKind::Class { "type" } else { "function" },
            &name,
            node,
        );
        let owner = if kind == NodeKind::Class {
            scope.owner.clone()
        } else {
            scope.type_owner.clone().or_else(|| scope.owner.clone())
        };
        let member = kind == NodeKind::Function && scope.type_owner.is_some();
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: if member { NodeKind::Method } else { kind },
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: Some(self.keyword_signature(node)),
            modifiers: self.published(node),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.facts.edges.push(IndexEdge {
                source: owner.to_string(),
                target: id.clone(),
                kind: if member { EdgeKind::HasMethod } else { EdgeKind::Contains },
            });
        }
        let mut inner = scope.clone();
        inner.owner = Some(id.clone());
        if kind == NodeKind::Class {
            inner.type_owner = Some(id);
        } else {
            inner.callable = Some(id);
            inner.type_owner = None;
        }
        self.walk(node, &inner);
    }

    fn keyword_signature(&self, node: Node) -> Signature {
        let mut parameters = Vec::new();
        if let Some(arguments) = self.arguments_of(node)
            && let Some(first) = arguments.named_child(0)
            && first.kind() == self.spec.keywords.kind
            && let Some(inner) = self.arguments_of(first)
        {
            let mut cursor = inner.walk();
            for parameter in inner.named_children(&mut cursor) {
                parameters.push(Parameter {
                    name: self.text(parameter).trim().to_string(),
                    type_annotation: None,
                    optional: false,
                    default_value: None,
                });
            }
        }
        Signature { parameters, return_type: None, type_parameters: Vec::new(), receiver: None }
    }

    fn declare_type(&mut self, node: Node, scope: &Scope, kind: NodeKind) {
        let Some(name) = self.name_of(node) else {
            self.walk(node, scope);
            return;
        };
        let id = self.id("type", &name, node);
        let owner = scope.owner.clone();
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: match self.constructor_parameters(node) {
                parameters if parameters.is_empty() => None,
                parameters => Some(Signature {
                    parameters,
                    return_type: None,
                    type_parameters: Vec::new(),
                    receiver: None,
                }),
            },
            modifiers: self.published(node),
            decorators: self.decorators_of(node),
            type_annotation: self.text_content(node),
            documentation: None,
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.facts.edges.push(IndexEdge {
                source: owner.to_string(),
                target: id.clone(),
                kind: EdgeKind::Contains,
            });
        }
        self.record_heritage(node, &id);

        let mut inner = scope.clone();
        inner.owner = Some(id.clone());
        inner.type_owner = Some(id);
        self.walk(node, &inner);
    }

    fn text_content(&self, node: Node) -> Option<String> {
        if self.spec.declares.text_kinds.is_empty() {
            return None;
        }
        let mut cursor = node.walk();
        let holder = node
            .named_children(&mut cursor)
            .find(|child| self.spec.declares.text_kinds.contains(&child.kind()))?;
        let mut inner = holder.walk();
        if holder
            .named_children(&mut inner)
            .any(|child| self.spec.declares.type_kinds.iter().any(|(kind, _)| *kind == child.kind()))
        {
            return None;
        }
        let text = self.text(holder).trim();
        (!text.is_empty() && text.len() <= 200).then(|| text.to_string())
    }

    fn record_heritage(&mut self, node: Node, owner: &str) {
        let mut cursor = node.walk();
        let mut declared: Vec<Node> = node.named_children(&mut cursor).collect();
        for field in self.spec.signature.body_fields {
            if let Some(body) = node.child_by_field_name(field) {
                let mut inside = body.walk();
                declared.extend(body.named_children(&mut inside));
            }
        }
        for child in declared {
            if !self.spec.declares.heritage_kinds.contains(&child.kind()) {
                continue;
            }
            let mut names = child.walk();
            let mut found = false;
            for entry in child.named_children(&mut names) {
                let written = self.text(entry);
                let name = base_name(written);
                if name.is_empty() {
                    continue;
                }
                found = true;
                self.facts.type_references.push(TypeReferenceFact {
                    file: self.file,
                    source: owner.to_string(),
                    name: name.to_string(),
                    kind: EdgeKind::Extends,
                    arguments: crate::model::type_arguments(written),
                });
            }
            if !found {
                let written = self.text(child);
                let name = base_name(written);
                if !name.is_empty() {
                    self.facts.type_references.push(TypeReferenceFact {
                        file: self.file,
                        source: owner.to_string(),
                        name: name.to_string(),
                        kind: EdgeKind::Extends,
                        arguments: crate::model::type_arguments(written),
                    });
                }
            }
        }
    }

    fn declare_function(&mut self, node: Node, scope: &Scope, kind: NodeKind) {
        match self.name_of(node) {
            Some(name) => self.declare_named_function(node, scope, kind, name),
            None => self.walk(node, scope),
        }
    }

    fn declare_named_function(&mut self, node: Node, scope: &Scope, kind: NodeKind, name: String) {
        let receiver_node = if self.spec.calls.receiver_type_field.is_empty() {
            None
        } else {
            node.child_by_field_name(self.spec.calls.receiver_type_field)
        };
        let receiver_type = receiver_node.and_then(|receiver| self.receiver_type_name(receiver));
        let receiver_owner = receiver_type
            .as_deref()
            .and_then(|name| self.owner_for_type_name(name));
        let self_binding = receiver_node.and_then(|receiver| self.receiver_binding(receiver));
        let scope = &{
            let mut inner = scope.clone();
            if let Some(owner) = receiver_owner.clone() {
                inner.type_owner = Some(owner);
            }
            if self_binding.is_some() {
                inner.self_binding = self_binding;
            }
            inner
        };
        let kind = if self.spec.declares.constructor_kinds.contains(&name.as_str()) {
            NodeKind::Constructor
        } else if scope.type_owner.is_some() && kind == NodeKind::Function {
            NodeKind::Method
        } else {
            kind
        };
        let id = self.id("function", &name, node);
        let owner = scope.type_owner.clone().or_else(|| scope.owner.clone());
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: Some({
                let mut signature = self.signature_of(node);
                if signature.receiver.is_none() {
                    signature.receiver = scope.extends.clone();
                }
                signature
            }),
            modifiers: self.published(node),
            decorators: self.decorators_of(node),
            type_annotation: None,
            documentation: None,
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.facts.edges.push(IndexEdge {
                source: owner.to_string(),
                target: id.clone(),
                kind: if scope.type_owner.is_some() {
                    EdgeKind::HasMethod
                } else {
                    EdgeKind::Contains
                },
            });
        }
        if receiver_owner.is_none()
            && let Some(name) = receiver_type
        {
            self.facts.type_references.push(TypeReferenceFact {
                file: self.file,
                source: id.clone(),
                name,
                kind: EdgeKind::HasMethod,
                arguments: Vec::new(),
            });
        }

        let mut inner = scope.clone();
        inner.owner = Some(id.clone());
        inner.callable = Some(id);
        inner.type_owner = None;
        inner.dispatch_param = (self.spec.id == "rust").then(|| self.dispatch_parameter(node)).flatten();
        inner.argv_param = self.argv_local(node);
        self.walk(node, &inner);
    }

    fn argv_local(&self, node: Node) -> Option<String> {
        fn looks_like_argv(text: &str) -> bool {
            let held = text.trim();
            let lowered = held.to_ascii_lowercase();
            if !(lowered.contains("argv") || lowered.contains("args") || held.contains("flag.Arg")) {
                return false;
            }
            let numeric_after = |probe: &str| {
                held.find(probe).is_some_and(|at| {
                    held[at + probe.len()..].trim_start().chars().next().is_some_and(|held| held.is_ascii_digit())
                })
            };
            numeric_after("[") || numeric_after(".nth(") || numeric_after(".get(") || numeric_after("flag.Arg(")
        }
        let body = self.spec.signature.body_fields.iter().find_map(|field| node.child_by_field_name(field))?;
        let statements = match body.named_child_count() {
            1 => body.named_child(0).unwrap_or(body),
            _ => body,
        };
        let mut cursor = statements.walk();
        for statement in statements.named_children(&mut cursor) {
            let child = if self.spec.declares.binding_kinds.contains(&statement.kind()) {
                statement
            } else if statement.named_child_count() == 1
                && let Some(only) = statement.named_child(0)
                && self.spec.declares.binding_kinds.contains(&only.kind())
            {
                only
            } else {
                continue;
            };
            let Some(value) = child.child_by_field_name(self.spec.declares.binding_value_field) else { continue };
            if !looks_like_argv(self.text(value)) {
                continue;
            }
            let Some(name_node) = child.child_by_field_name(self.spec.declares.binding_name_field) else { continue };
            let name = self.text(name_node).trim();
            if !name.is_empty() && name.chars().all(|held| held.is_alphanumeric() || held == '_') {
                return Some(name.to_string());
            }
        }
        None
    }

    fn dispatch_parameter(&self, node: Node) -> Option<String> {
        static DISPATCH_PARAMETER_NAMES: &[&str] = &["channel"];
        let parameters = match self.parameter_list(node) {
            Some(list) => self.parameters_in(list),
            None => return None,
        };
        parameters.into_iter().find_map(|parameter| {
            let name = parameter.name.trim().to_string();
            if !DISPATCH_PARAMETER_NAMES.contains(&name.as_str()) {
                return None;
            }
            parameter
                .type_annotation
                .as_deref()
                .is_some_and(|held| held.to_ascii_lowercase().contains("str"))
                .then_some(name)
        })
    }

    fn literals_of<'t>(&self, arguments: impl Iterator<Item = Node<'t>>) -> Vec<String> {
        arguments
            .take(8)
            .filter_map(|argument| {
                let raw = self.text(argument).trim();
                if let Some(keyed) = keyed_symbols(raw) {
                    return Some(keyed);
                }
                if let Some(addressed) = addressed_in_an_object(raw) {
                    return Some(addressed);
                }
                if let Some((named, written)) = named_as_text(raw) {
                    return (written.len() <= TEXT_AT_MOST).then(|| format!("{named}={written}"));
                }
                if let Some(begins) = text_it_begins_with(raw) {
                    return (begins.len() <= TEXT_AT_MOST).then(|| format!("{begins}${{}}"));
                }
                let value = trim_quotes(raw).trim();
                if value.is_empty() {
                    return None;
                }
                match written_as_text(raw) {
                    true => (value.len() <= TEXT_AT_MOST).then(|| value.to_string()),
                    false => match self.remembered.get(value) {
                        Some(written) => Some(written.clone()),
                        None => (value.len() <= WORD_AT_MOST
                            && !value.contains(char::is_whitespace))
                        .then(|| value.to_string()),
                    },
                }
            })
            .take(4)
            .collect()
    }

    fn receiver_binding(&self, receiver: Node) -> Option<String> {
        let mut cursor = receiver.walk();
        let mut descend = true;
        loop {
            let current = cursor.node();
            if let Some(name) = current.child_by_field_name("name")
                && self.spec.names.leaf_kinds.contains(&name.kind())
            {
                return Some(self.text(name).to_string());
            }
            if descend && cursor.goto_first_child() {
                continue;
            }
            descend = true;
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return None;
                }
            }
        }
    }

    fn receiver_type_name(&self, receiver: Node) -> Option<String> {
        let mut cursor = receiver.walk();
        let mut descend = true;
        loop {
            let current = cursor.node();
            if current.kind() == "type_identifier" {
                return Some(self.text(current).to_string());
            }
            if descend && cursor.goto_first_child() {
                continue;
            }
            descend = true;
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return None;
                }
            }
        }
    }

    fn columns_of(&self, node: Node) -> Vec<String> {
        let mut held = Vec::new();
        let Some(listed) = self.listed_in(node) else { return held };
        let mut cursor = listed.walk();
        for element in listed.named_children(&mut cursor) {
            if let Some(spoken) = self.first_string(element) {
                let named = spoken.trim();
                if !named.is_empty() && named.len() < 64 && !held.iter().any(|kept| kept == named) {
                    held.push(named.to_string());
                }
            }
        }
        held
    }

    fn listed_in<'held>(&self, node: Node<'held>) -> Option<Node<'held>> {
        let mut cursor = node.walk();
        let mut waiting = vec![node];
        while let Some(held) = waiting.pop() {
            let kind = held.kind();
            if held.id() != node.id() && (kind.contains("array") || kind == "list") {
                return Some(held);
            }
            waiting.extend(held.named_children(&mut cursor));
        }
        None
    }

    fn first_string(&self, node: Node) -> Option<String> {
        let mut cursor = node.walk();
        let mut waiting = vec![node];
        while let Some(held) = waiting.pop() {
            let kind = held.kind();
            if kind.contains("string") || kind == "simple_symbol" {
                return Some(trim_quotes(self.text(held)).to_string());
            }
            waiting.extend(held.named_children(&mut cursor));
        }
        None
    }

    fn declare_its_table(&mut self, node: Node, scope: &Scope) {
        let Some(owner) = scope.type_owner.clone() else { return };
        let Some(name) = self.name_of(node) else { return };
        if !crate::tables::NAMES_ITS_TABLE.contains(&name.as_str()) {
            return;
        }
        let Some(written) = self
            .given_to_a_field(node)
            .into_iter()
            .map(|value| self.text(value).trim().to_string())
            .find(|value| written_as_text(value))
        else {
            return;
        };
        let named = trim_quotes(&written).trim().to_string();
        if named.is_empty() || named.contains(char::is_whitespace) {
            return;
        }
        self.facts.tables.push(crate::tables::Table {
            named: named.to_ascii_lowercase(),
            columns: Vec::new(),
            points_at: Vec::new(),
            file: self.file,
            line: node.start_position().row as u32 + 1,
            declared_by: Some(owner),
            change: crate::tables::Change::Created,
        });
    }

    fn given_to_a_field<'t>(&self, node: Node<'t>) -> Vec<Node<'t>> {
        let declarators = std::iter::once(node).chain(node.child_by_field_name("declarator"));
        declarators
            .flat_map(|held| {
                ["right", "value", "default_value"]
                    .into_iter()
                    .filter_map(move |field| held.child_by_field_name(field))
            })
            .collect()
    }

    fn declared_through<'t>(&self, node: Node<'t>) -> Option<(Node<'t>, Option<Node<'t>>)> {
        let mut cursor = node.walk();
        let declaration = node
            .named_children(&mut cursor)
            .find(|child| DECLARES_VARIABLES.contains(&child.kind()))?;
        let mut cursor = declaration.walk();
        let declarator = declaration
            .named_children(&mut cursor)
            .find(|child| NAMES_A_VARIABLE.contains(&child.kind()))
            .unwrap_or(declaration);
        let named = declarator.child_by_field_name("name").or_else(|| {
            let mut cursor = declarator.walk();
            declarator
                .named_children(&mut cursor)
                .find(|child| self.spec.names.leaf_kinds.contains(&child.kind()))
        })?;
        let typed = declaration
            .child_by_field_name("type")
            .or_else(|| (declarator.id() == declaration.id()).then(|| self.typed_child(declaration)).flatten());
        Some((named, typed))
    }

    fn declare_field(&mut self, node: Node, scope: &Scope) {
        let Some(owner) = scope.type_owner.clone() else { return };
        let through = self.declared_through(node);
        let Some(name) = through
            .map(|(named, _)| self.text(named).to_string())
            .or_else(|| self.name_of(node))
        else {
            return;
        };
        let held = name.clone();
        if let Some((_, assigned)) = self.text(node).split_once('=') {
            let raw = assigned.trim().trim_end_matches(';').trim();
            if written_as_text(raw) {
                let written = trim_quotes(raw).trim().to_string();
                if !written.is_empty() && written.len() <= TEXT_AT_MOST {
                    self.remembered.insert(name.clone(), written.clone());
                    self.facts.locals.push(LocalBinding {
                        file: self.file,
                        unit: owner.clone(),
                        name: name.clone(),
                        annotation: None,
                        constructed: None,
                        from_call: None,
                        written: Some(written),
                stands_for: None,
                from_values: Vec::new(),
                        line: node.start_position().row as u32 + 1,
                    });
                }
            }
        }
        let id = self.id("field", &name, node);
        let type_annotation = through
            .and_then(|(_, typed)| typed)
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| self.typed_child(node))
            .map(|annotation| self.text(annotation).trim().to_string())
            .or_else(|| self.text_content(node));
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Property,
            file: self.file,
            span: span_of(node),
            parent: Some(owner.clone()),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation,
            documentation: None,
            project: None,
        callback_of: None,
            registration_label: None,
        });
        self.facts.edges.push(IndexEdge {
            source: owner.clone(),
            target: id,
            kind: EdgeKind::HasField,
        });
        if !COLUMNS_OF.contains(&held.as_str()) {
            return;
        }
        for column in self.columns_of(node) {
            let held = self.id("field", &column, node);
            if self.facts.nodes.iter().any(|node| node.id == held) {
                continue;
            }
            self.facts.nodes.push(IndexNode {
                id: held.clone(),
                name: column,
                kind: NodeKind::Property,
                file: self.file,
                span: span_of(node),
                parent: Some(owner.clone()),
                signature: None,
                modifiers: Modifiers::default(),
                decorators: Vec::new(),
                type_annotation: None,
                documentation: None,
                project: None,
                callback_of: None,
                registration_label: None,
            });
            self.facts.edges.push(IndexEdge {
                source: owner.clone(),
                target: held,
                kind: EdgeKind::HasField,
            });
        }
    }

    fn declare_import(&mut self, node: Node) {
        let text = self.text(node);
        let literals = string_literals(text);
        if literals.len() > 1 {
            for literal in literals {
                self.record_import(&literal, node);
            }
            return;
        }
        let specifier = import_specifier(text);
        self.record_import(&specifier, node);
    }

    fn record_import(&mut self, specifier: &str, node: Node) {
        let specifier = specifier.trim().to_string();
        if specifier.is_empty() || !reads_as_a_module(&specifier) {
            return;
        }
        let text = self.text(node);
        let mut names = Vec::new();
        if string_literals(text).len() == 1
            && let Some(alias) = import_alias(text)
        {
            names.push(ImportSpecifier {
                local: alias,
                imported: None,
                namespace: true,
                default_import: false,
            });
        }
        let bound = binding_of(&specifier);
        if !bound.is_empty() && !names.iter().any(|name| name.local == bound) {
            names.push(ImportSpecifier {
                local: bound,
                imported: None,
                namespace: true,
                default_import: false,
            });
        }
        let mut cursor = node.walk();
        for child in node.children_by_field_name("name", &mut cursor) {
            let held = self.text(child).trim();
            let (imported, local) = match held.split_once(" as ") {
                Some((imported, alias)) => (imported.trim(), alias.trim()),
                None => (held, held),
            };
            let local = local.rsplit('.').next().unwrap_or(local).trim().to_string();
            if local.is_empty() || names.iter().any(|name| name.local == local) {
                continue;
            }
            names.push(ImportSpecifier {
                local,
                imported: Some(imported.to_string()),
                namespace: false,
                default_import: false,
            });
        }
        let everywhere = {
            let mut cursor = node.walk();
            let global = node.children(&mut cursor).any(|child| child.kind() == "global");
            global
        };
        self.facts.imports.push(ImportFact {
            file: self.file,
            specifier,
            line: node.start_position().row as u32 + 1,
            type_only: false,
            everywhere,
            names,
        });
    }

    fn declare_role(&mut self, node: Node, scope: &Scope) {
        let Some(owner) = scope.owner.clone() else { return };
        let arguments = node.child_by_field_name("arguments").or_else(|| {
            let mut cursor = node.walk();
            node.named_children(&mut cursor).find(|child| child.kind() == "arguments")
        });
        let mut cursor = node.walk();
        let held: Vec<Node> = match arguments {
            Some(arguments) => {
                let mut inner = arguments.walk();
                arguments.named_children(&mut inner).collect()
            }
            None => node.named_children(&mut cursor).skip(1).collect(),
        };
        for argument in held {
            let written = self.text(argument);
            let name = base_name(written).trim().to_string();
            if name.is_empty() {
                continue;
            }
            self.facts.type_references.push(TypeReferenceFact {
                file: self.file,
                source: owner.clone(),
                name,
                kind: EdgeKind::Implements,
                arguments: crate::model::type_arguments(written),
            });
        }
    }

    fn declare_command(&mut self, node: Node, scope: &Scope) {
        let Some(named) = node
            .child_by_field_name("type")
            .or_else(|| node.named_child(0))
            .map(|held| self.text(held).trim().trim_start_matches('&').to_string())
        else {
            return;
        };
        let leaf = named.rsplit(['.', ':']).next().unwrap_or(&named).to_ascii_lowercase();
        if !leaf.ends_with("command") && !leaf.ends_with("cmd") {
            return;
        }
        let mut cursor = node.walk();
        let mut fields: Vec<(String, Node)> = Vec::new();
        for held in node.named_children(&mut cursor) {
            let mut inner = held.walk();
            for element in held.named_children(&mut inner) {
                let mut keyed = element.walk();
                let parts: Vec<Node> = element.named_children(&mut keyed).collect();
                if parts.len() == 2 {
                    fields.push((self.text(parts[0]).trim().to_ascii_lowercase(), parts[1]));
                }
            }
        }
        let spoken = fields
            .iter()
            .find(|(key, _)| matches!(key.as_str(), "name" | "use" | "command"))
            .map(|(_, value)| trim_quotes(self.text(*value)).trim().to_string())
            .filter(|held| !held.is_empty() && !held.contains(' '));
        let running = fields.iter().find(|(key, _)| {
            matches!(key.as_str(), "run" | "rune" | "runfunc" | "action" | "execute" | "handler")
        });
        let (Some(spoken), Some((held, target))) = (spoken, running) else { return };
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: format!("{named}.{held}"),
            label: spoken,
            handler: scope
                .callable
                .clone()
                .or_else(|| scope.owner.clone())
                .unwrap_or_else(|| self.module_id.clone()),
            line: target.start_position().row as u32 + 1,
        });
    }

    fn handled_inline<'t>(&self, argument: Node<'t>) -> Option<Node<'t>> {
        let lambdas = self.spec.declares.lambda_kinds;
        if lambdas.contains(&argument.kind()) {
            return Some(argument);
        }
        let mut found: Vec<Node<'t>> = Vec::new();
        let mut frontier: Vec<(Node<'t>, u8)> = vec![(argument, 0)];
        while let Some((node, depth)) = frontier.pop() {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if lambdas.contains(&child.kind()) {
                    found.push(child);
                } else if depth < 4 {
                    frontier.push((child, depth + 1));
                }
            }
            if found.len() > 1 {
                return None;
            }
        }
        found.pop()
    }

    fn declare_callback(&mut self, node: Node, scope: &Scope) {
        let registrar = scope.registrar.clone().unwrap_or_else(|| "lambda".to_string());
        let name = format!("{registrar}#{}", node.start_position().row + 1);
        let id = self.id("callback", &name, node);
        if scope.callable.as_deref() == Some(id.as_str()) {
            self.walk(node, scope);
            return;
        }
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(node),
            parent: scope.callable.clone().or_else(|| scope.owner.clone()),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: scope.registrar.clone(),
            registration_label: None,
        });
        if let Some((registrar, label)) = self.labelled.remove(&node.id()) {
            self.facts.registrations.push(RegistrationFact {
                file: self.file,
                registrar,
                label,
                handler: id.clone(),
                line: node.start_position().row as u32 + 1,
            });
        }
        if let Some(owner) = scope.callable.clone().or_else(|| scope.owner.clone()) {
            self.facts.edges.push(IndexEdge {
                source: owner,
                target: id.clone(),
                kind: EdgeKind::Contains,
            });
        }
        let mut inner = scope.clone();
        inner.callable = Some(id);
        inner.registrar = None;
        self.walk(node, &inner);
    }

    fn declare_arm(&mut self, node: Node, scope: &Scope, arm: crate::arms::Dispatched) {
        let id = self.id("callback", &arm.case, node);
        let holder = scope.callable.clone().or_else(|| scope.owner.clone());
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name: arm.case,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(node),
            parent: holder.clone(),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: Some(format!("dispatch:{}", arm.kind)),
            registration_label: Some(arm.label),
        });
        if let Some(owner) = holder {
            self.facts.edges.push(IndexEdge { source: owner, target: id.clone(), kind: EdgeKind::Contains });
        }
        let mut inner = scope.clone();
        inner.callable = Some(id);
        inner.registrar = None;
        self.walk(node, &inner);
    }

    fn bound_by(&self, pattern: Node) -> Vec<String> {
        let held = self.text(pattern).trim();
        if !held.contains(['(', ')', '{', '}', ',', '[']) {
            return vec![held.to_string()];
        }
        let mut names = Vec::new();
        let mut pending = vec![pattern];
        while let Some(held) = pending.pop() {
            let mut cursor = held.walk();
            let children: Vec<Node> = held.named_children(&mut cursor).collect();
            if children.is_empty() {
                let word = self.text(held).trim();
                if !word.is_empty()
                    && word != "_"
                    && word.chars().all(|letter| letter.is_alphanumeric() || letter == '_')
                    && word.chars().next().is_some_and(|letter| !letter.is_uppercase())
                {
                    names.push(word.to_string());
                }
                continue;
            }
            pending.extend(children);
        }
        names.sort();
        names.dedup();
        names
    }

    fn declare_routed_by_hand(&mut self, node: Node, scope: &Scope) {
        static SPOKEN_METHODS: &[&str] =
            &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
        let Some(handler) = scope.callable.clone().or_else(|| scope.owner.clone()) else {
            return;
        };
        let mut pending: Vec<Node> = vec![node];
        while let Some(held) = pending.pop() {
            let mut cursor = held.walk();
            for child in held.named_children(&mut cursor) {
                let Some(pattern) = child.child_by_field_name("pattern") else {
                    pending.push(child);
                    continue;
                };
                let mut spoken: Vec<String> = Vec::new();
                let mut inner = vec![pattern];
                while let Some(part) = inner.pop() {
                    if part.kind().contains("string") {
                        spoken.push(trim_quotes(self.text(part)).trim().to_string());
                    }
                    let mut walk = part.walk();
                    inner.extend(part.named_children(&mut walk));
                }
                let method = spoken
                    .iter()
                    .find(|held| SPOKEN_METHODS.contains(&held.as_str()))
                    .cloned();
                let Some(path) = spoken.iter().find(|held| held.starts_with('/')).cloned() else {
                    continue;
                };
                let label = match method {
                    Some(method) => format!("{method} {path}"),
                    None => path,
                };
                self.facts.registrations.push(RegistrationFact {
                    file: self.file,
                    registrar: "route".to_string(),
                    label,
                    handler: handler.clone(),
                    line: child.start_position().row as u32 + 1,
                });
            }
        }
    }

    fn channel_literal(&self, pattern: Node) -> Option<String> {
        if pattern.kind().contains("string") {
            let value = trim_quotes(self.text(pattern)).trim().to_string();
            return (!value.is_empty()).then_some(value);
        }
        if matches!(pattern.kind(), "identifier" | "scoped_identifier") {
            let text = self.text(pattern).trim();
            let leaf = text.rsplit("::").next().unwrap_or(text).trim();
            let shouted = !leaf.is_empty()
                && leaf.chars().any(|held| held.is_alphabetic())
                && leaf
                    .chars()
                    .all(|held| held.is_ascii_uppercase() || held == '_' || held.is_ascii_digit());
            return shouted.then(|| format!("{}{leaf}", crate::entry_exit::DISPATCH_CONST_MARKER));
        }
        None
    }

    fn first_channel_literal(&self, node: Node) -> Option<String> {
        if let Some(value) = self.channel_literal(node) {
            return Some(value);
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if let Some(value) = self.first_channel_literal(child) {
                return Some(value);
            }
        }
        None
    }

    fn declare_dispatch_arm(&mut self, handler: &str, label: &str, site: Node, body: Node) -> String {
        self.declare_dispatch_arm_registered_as(handler, label, site, body, crate::entry_exit::HAND_ROLLED_DISPATCH_REGISTRAR)
    }

    fn declare_dispatch_arm_registered_as(
        &mut self,
        handler: &str,
        label: &str,
        site: Node,
        body: Node,
        registrar: &str,
    ) -> String {
        let name = format!("{label}#{}", site.start_position().row + 1);
        let id = self.id("callback", &name, body);
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(body),
            parent: Some(handler.to_string()),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        });
        self.facts.edges.push(IndexEdge {
            source: handler.to_string(),
            target: id.clone(),
            kind: EdgeKind::Contains,
        });
        self.facts.registrations.push(RegistrationFact {
            file: self.file,
            registrar: registrar.to_string(),
            label: label.to_string(),
            handler: id.clone(),
            line: site.start_position().row as u32 + 1,
        });
        id
    }

    fn declare_channel_dispatch_match(&mut self, node: Node, scope: &Scope) {
        let Some(handler) = scope.callable.clone().or_else(|| scope.owner.clone()) else {
            return;
        };
        let mut pending: Vec<Node> = vec![node];
        while let Some(held) = pending.pop() {
            let mut cursor = held.walk();
            for child in held.named_children(&mut cursor) {
                let Some(pattern) = child.child_by_field_name("pattern") else {
                    pending.push(child);
                    continue;
                };
                let Some(value) = child.child_by_field_name("value") else { continue };
                let Some(label) = self.first_channel_literal(pattern) else { continue };
                let id = self.declare_dispatch_arm(&handler, &label, child, value);
                let mut inner = scope.clone();
                inner.callable = Some(id.clone());
                inner.owner = Some(id);
                inner.registrar = None;
                self.visit(value, &inner);
            }
        }
    }

    fn channel_dispatch_condition<'t>(&self, condition: Node<'t>, dispatch_param: &str) -> Option<(Node<'t>, String)> {
        let mut pending: Vec<Node> = vec![condition];
        while let Some(held) = pending.pop() {
            if held.kind() == "binary_expression"
                && held.child_by_field_name("operator").is_some_and(|operator| self.text(operator) == "==")
                && let (Some(left), Some(right)) = (held.child_by_field_name("left"), held.child_by_field_name("right"))
            {
                let named_by = |candidate: Node| self.text(candidate).trim() == dispatch_param;
                let literal = if named_by(left) {
                    Some(right)
                } else if named_by(right) {
                    Some(left)
                } else {
                    None
                };
                if let Some(label) = literal.and_then(|held| self.channel_literal(held)) {
                    return Some((held, label));
                }
            }
            let mut cursor = held.walk();
            pending.extend(held.named_children(&mut cursor));
        }
        None
    }

    fn declare_channel_dispatch_if(&mut self, node: Node, scope: &Scope) {
        let Some(dispatch_param) = scope.dispatch_param.as_deref() else { return };
        let Some(handler) = scope.callable.clone().or_else(|| scope.owner.clone()) else {
            return;
        };
        let Some(condition) = node.child_by_field_name("condition") else { return };
        let Some(consequence) = node.child_by_field_name("consequence") else { return };
        let Some((site, label)) = self.channel_dispatch_condition(condition, dispatch_param) else {
            return;
        };
        let id = self.declare_dispatch_arm(&handler, &label, site, consequence);
        let mut inner = scope.clone();
        inner.callable = Some(id.clone());
        inner.owner = Some(id);
        inner.registrar = None;
        self.visit(consequence, &inner);
    }

    fn leading_quoted_literal(text: &str) -> Option<String> {
        let mut chars = text.chars();
        let quote = chars.next()?;
        if !matches!(quote, '\'' | '"' | '`') {
            return None;
        }
        let rest = &text[quote.len_utf8()..];
        let end = rest.find(quote)?;
        Some(rest[..end].to_string())
    }

    fn trailing_quoted_literal(text: &str) -> Option<String> {
        let quote = text.chars().last()?;
        if !matches!(quote, '\'' | '"' | '`') {
            return None;
        }
        let without_end = &text[..text.len() - quote.len_utf8()];
        let start = without_end.rfind(quote)?;
        Some(without_end[start + quote.len_utf8()..].to_string())
    }

    fn argv_compared_literal(condition_text: &str, param: &str) -> Option<String> {
        let is_ident = |held: char| held.is_alphanumeric() || held == '_';
        for (at, _) in condition_text.match_indices(param) {
            let before_ok = condition_text[..at].chars().next_back().is_none_or(|held| !is_ident(held));
            let after_at = at + param.len();
            let after_ok = condition_text[after_at..].chars().next().is_none_or(|held| !is_ident(held));
            if !before_ok || !after_ok {
                continue;
            }
            let after = condition_text[after_at..].trim_start();
            if let Some(stripped) = after.strip_prefix("==")
                && let Some(label) = Self::leading_quoted_literal(stripped.trim_start())
            {
                return Some(label);
            }
            let before = condition_text[..at].trim_end();
            if let Some(stripped) = before.strip_suffix("==")
                && let Some(label) = Self::trailing_quoted_literal(stripped.trim_end())
            {
                return Some(label);
            }
        }
        None
    }

    fn declare_cli_dispatch_if(&mut self, node: Node, scope: &Scope) {
        let Some(argv_param) = scope.argv_param.as_deref() else { return };
        let Some(handler) = scope.callable.clone().or_else(|| scope.owner.clone()) else {
            return;
        };
        let Some(condition) = node.child_by_field_name("condition") else { return };
        let Some(consequence) = node.child_by_field_name("consequence") else { return };
        let Some(label) = Self::argv_compared_literal(self.text(condition), argv_param) else {
            return;
        };
        let id = self.declare_dispatch_arm_registered_as(
            &handler,
            &label,
            condition,
            consequence,
            crate::entry_exit::HAND_ROLLED_CLI_REGISTRAR,
        );
        let mut inner = scope.clone();
        inner.callable = Some(id.clone());
        inner.owner = Some(id);
        inner.registrar = None;
        self.visit(consequence, &inner);
    }

    fn declare_rust_const(&mut self, node: Node, scope: &Scope) {
        let Some(name_node) = node.child_by_field_name("name") else { return };
        let Some(value_node) = node.child_by_field_name("value") else { return };
        if !value_node.kind().contains("string") {
            return;
        }
        let value = trim_quotes(self.text(value_node)).trim().to_string();
        if value.is_empty() {
            return;
        }
        let _ = scope;
        self.facts.locals.push(LocalBinding {
            file: self.file,
            unit: String::new(),
            name: self.text(name_node).trim().to_string(),
            annotation: None,
            constructed: None,
            from_call: None,
            written: Some(value),
            stands_for: None,
            from_values: Vec::new(),
            line: node.start_position().row as u32 + 1,
        });
    }

    fn declare_module_alias(&mut self, node: Node) {
        if node.child_by_field_name("body").is_some() {
            return;
        }
        let Some(name_node) = node.child_by_field_name("name") else { return };
        let name = self.text(name_node).trim().to_string();
        if name.is_empty() {
            return;
        }
        self.facts.imports.push(ImportFact {
            file: self.file,
            specifier: format!("self::{name}"),
            line: node.start_position().row as u32 + 1,
            type_only: false,
            everywhere: false,
            names: vec![ImportSpecifier {
                local: name,
                imported: None,
                namespace: true,
                default_import: false,
            }],
        });
    }

    fn declare_taken_apart(&mut self, node: Node, scope: &Scope) {
        let Some(value) = node.child_by_field_name(self.spec.declares.binding_value_field) else {
            return;
        };
        let from_call = self
            .spec
            .calls
            .kinds
            .contains(&value.kind())
            .then(|| self.called_name(value))
            .flatten();
        if from_call.is_none() {
            return;
        }
        let mut pending: Vec<Node> = vec![node];
        while let Some(held) = pending.pop() {
            let mut cursor = held.walk();
            for child in held.named_children(&mut cursor) {
                if let Some(pattern) = child.child_by_field_name("pattern") {
                    for name in self.bound_by(pattern) {
                        self.facts.locals.push(LocalBinding {
                            file: self.file,
                            unit: scope.callable.clone().unwrap_or_default(),
                            name,
                            annotation: None,
                            constructed: None,
                            from_call: from_call.clone(),
                            written: None,
                stands_for: None,
                from_values: Vec::new(),
                            line: node.start_position().row as u32 + 1,
                        });
                    }
                    continue;
                }
                if child.id() != value.id() {
                    pending.push(child);
                }
            }
        }
    }

    fn declare_binding(&mut self, node: Node, scope: &Scope) -> bool {
        let declarator = node.child_by_field_name(self.spec.declares.binding_name_field);
        let name = match declarator {
            Some(declarator) => {
                let named = declarator.child_by_field_name("name").unwrap_or(declarator);
                self.text(named).trim().to_string()
            }
            None => self.name_of(node).unwrap_or_default(),
        };
        let pattern =
            declarator.and_then(|held| without_its_value(held, self.spec.declares.binding_value_field));
        let taken_apart = match pattern {
            Some(pattern)
                if self.text(pattern).contains(['(', '{', ',']) && !signs_for_a_call(pattern) =>
            {
                self.bound_by(pattern)
            }
            _ => Vec::new(),
        };
        if taken_apart.is_empty() && (name.is_empty() || name.contains(char::is_whitespace)) {
            return false;
        }
        let annotation = node
            .child_by_field_name(self.spec.declares.binding_type_field)
            .or_else(|| self.typed_child(node))
            .and_then(|found| bare_type(self.text(found)))
            .filter(|written| !INFERS_ITS_TYPE.contains(&written.as_str()));
        let value = node
            .child_by_field_name(self.spec.declares.binding_value_field)
            .or_else(|| declarator.and_then(|d| d.child_by_field_name(self.spec.declares.binding_value_field)))
            .or_else(|| self.assigned_child(node))
            .or_else(|| declarator.and_then(|d| self.assigned_child(d)))
            .or_else(|| {
                let mut cursor = node.walk();
                let named = node.named_children(&mut cursor).find(|child| NAMES_A_VARIABLE.contains(&child.kind()));
                named.and_then(|held| {
                    self.assigned_child(held).or_else(|| {
                        let mut inner = held.walk();
                        held.named_children(&mut inner).find(|child| child.kind().contains("string"))
                    })
                })
            })
            .map(|held| unwrapped_for(held, self.spec.id));
        let written_value = value
            .map(|held| self.text(held).trim())
            .filter(|raw| written_as_text(raw))
            .map(|raw| trim_quotes(raw).trim().to_string())
            .filter(|written: &String| !written.is_empty() && written.len() <= TEXT_AT_MOST);
        if let Some(written) = written_value.clone() {
            self.remembered.insert(name.clone(), written);
        }
        if let Some(value) = value
            && let Some((_, kind)) = self
                .spec
                .declares.function_kinds
                .iter()
                .find(|(declares, _)| *declares == value.kind())
        {
            self.declare_named_function(value, scope, *kind, name);
            return true;
        }
        let constructed = value
            .filter(|value| self.spec.declares.constructor_kinds.contains(&value.kind()))
            .and_then(|value| self.name_of(value))
            .or_else(|| {
                value
                    .filter(|value| CONSTRUCTS_A_VALUE.contains(&value.kind()))
                    .and_then(|value| value.child_by_field_name("type").or_else(|| value.child_by_field_name("constructor")))
                    .and_then(|typed| bare_type(self.text(typed)))
            });
        let from_call = value
            .filter(|value| self.spec.calls.kinds.contains(&value.kind()))
            .and_then(|value| self.called_name(value));
        let from_values = value
            .map(|held| crate::entities::built_from(self.text(held)))
            .unwrap_or_default();
        if annotation.is_none()
            && constructed.is_none()
            && from_call.is_none()
            && written_value.is_none()
            && from_values.is_empty()
        {
            return false;
        }
        for held in taken_apart.iter() {
            self.facts.locals.push(LocalBinding {
                file: self.file,
                unit: scope.callable.clone().unwrap_or_default(),
                name: held.clone(),
                annotation: annotation.clone(),
                constructed: constructed.clone(),
                from_call: from_call.clone(),
                written: None,
                stands_for: None,
                from_values: from_values.clone(),
                line: node.start_position().row as u32 + 1,
            });
        }
        if !taken_apart.is_empty() {
            return false;
        }
        let stands_for = value
            .filter(|_| from_call.as_deref().is_some_and(|called| KEEPS_WHAT_IT_RETURNS.contains(&crate::names::leaf(called))))
            .and_then(|value| self.returned_by_its_lambda(value));
        self.facts.locals.push(LocalBinding {
            file: self.file,
            unit: scope.callable.clone().unwrap_or_default(),
            name,
            annotation,
            constructed,
            from_call,
            written: written_value,
                stands_for,
            from_values: from_values.clone(),
            line: node.start_position().row as u32 + 1,
        });
        false
    }

    fn returned_by_its_lambda(&self, call: Node) -> Option<String> {
        let mut pending = vec![call];
        let mut lambda = None;
        while let Some(held) = pending.pop() {
            if self.spec.declares.lambda_kinds.contains(&held.kind()) && held.id() != call.id() {
                lambda = Some(held);
                break;
            }
            let mut cursor = held.walk();
            pending.extend(held.named_children(&mut cursor));
        }
        let text = self.text(lambda?).trim();
        let body = text.strip_prefix('{')?.strip_suffix('}')?;
        let body = body.split_once("->").map(|(_, rest)| rest).unwrap_or(body);
        let last = body.lines().map(str::trim).filter(|line| !line.is_empty()).last()?;
        let plain = last.chars().all(|held| held.is_alphanumeric() || matches!(held, '_' | '.'));
        (plain && !last.is_empty()).then(|| last.to_string())
    }

    fn typed_child<'t>(&self, node: Node<'t>) -> Option<Node<'t>> {
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .find(|child| child.kind().ends_with("type") || child.kind() == "type_identifier")
    }

    fn assigned_child<'t>(&self, node: Node<'t>) -> Option<Node<'t>> {
        let mut cursor = node.walk();
        node.named_children(&mut cursor).find(|child| {
            self.spec.calls.kinds.contains(&child.kind())
                || self.spec.declares.constructor_kinds.contains(&child.kind())
                || CONSTRUCTS_A_VALUE.contains(&child.kind())
        })
    }

    fn called_name(&self, node: Node) -> Option<String> {
        if self.spec.id != "rust" {
            let function = node
                .child_by_field_name("function")
                .or_else(|| node.child_by_field_name("name"))
                .or_else(|| node.named_child(0))?;
            let text = base_name(self.text(function)).trim();
            return (!text.is_empty()).then(|| text.to_string());
        }
        let mut current = node;
        for _ in 0..6 {
            let function = current
                .child_by_field_name("function")
                .or_else(|| current.child_by_field_name("name"))
                .or_else(|| current.named_child(0))?;
            let Some(receiver) = self
                .spec
                .calls.receiver_fields
                .iter()
                .find_map(|field| function.child_by_field_name(field))
            else {
                let text = base_name(self.text(function)).trim();
                return (!text.is_empty()).then(|| text.to_string());
            };
            let member = function
                .child_by_field_name("field")
                .or_else(|| function.child_by_field_name("name"))
                .or_else(|| function.child_by_field_name("property"));
            let member_text = member.map(|found| self.text(found).trim()).unwrap_or_default();
            if self.spec.calls.kinds.contains(&receiver.kind())
                && HANDS_BACK_ITS_RECEIVER.contains(&member_text)
            {
                current = receiver;
                continue;
            }
            let member_text = base_name(member_text).trim();
            if member_text.is_empty() {
                return None;
            }
            let root = settled(self.text(receiver).trim()).unwrap_or_default();
            return Some(match root.is_empty() {
                true => member_text.to_string(),
                false => format!("{root}.{member_text}"),
            });
        }
        None
    }

    fn mutating_its_own(&mut self, node: Node, scope: &Scope) {
        let Some(function) = node.child_by_field_name("function").or_else(|| node.child_by_field_name("method")) else {
            return;
        };
        let text = self.text(function).trim().to_string();
        let Some((receiver, verb)) = text.rsplit_once(['.', '>']) else { return };
        let verb = verb.split('<').next().unwrap_or(verb).to_ascii_lowercase();
        if !MUTATES_A_COLLECTION.contains(&verb.as_str()) {
            return;
        }
        let receiver = receiver.trim_end_matches('-');
        if let Some(member) = own_member(receiver)
            && let Some(unit) = self.unit(scope)
        {
            unit.writes.push(member);
        }
    }

    fn type_arguments_of(&self, node: Node, function: Option<Node>) -> Vec<String> {
        let named = function.map(|function| {
            function
                .child_by_field_name("name")
                .or_else(|| function.child_by_field_name("field"))
                .or_else(|| function.child_by_field_name("property"))
                .unwrap_or(function)
        });
        let mut frontier: Vec<(Node, u8)> = Vec::new();
        frontier.extend(node.child_by_field_name("type_arguments").map(|found| (found, 0)));
        frontier.extend(named.map(|found| (found, 0)));
        while let Some((at, depth)) = frontier.pop() {
            if matches!(at.kind(), "type_argument_list" | "type_arguments") {
                let mut cursor = at.walk();
                return at.named_children(&mut cursor).map(|held| self.text(held).trim().to_string()).collect();
            }
            if depth < 2 {
                let mut cursor = at.walk();
                frontier.extend(at.named_children(&mut cursor).map(|child| (child, depth + 1)));
            }
        }
        Vec::new()
    }

    fn record_an_indexed_write(&mut self, indexed: Node, assignment: Node, scope: &Scope) {
        let written = self.text(indexed);
        let Some(open) = written.find('[') else { return };
        let holder = written[..open].trim();
        if holder.is_empty() || !holder.chars().all(|held| held.is_alphanumeric() || matches!(held, '_' | '.' | '$')) {
            return;
        }
        let key = written[open + 1..].trim_end_matches(']').trim();
        self.facts.calls.push(CallFact {
            file: self.file,
            caller: scope.callable.clone().or_else(|| scope.owner.clone()),
            callee: "set".to_string(),
            receiver: Some(holder.to_string()),
            line: assignment.start_position().row as u32 + 1,
            column: assignment.start_position().column as u32,
            argument_count: 2,
            literals: vec![trim_quotes(key).to_string()],
            constructs: false,
            type_arguments: Vec::new(),
            context: CallContext {
                in_try: scope.in_try,
                in_catch: scope.in_catch,
                in_finally: scope.in_finally,
                awaited: scope.awaited,
                optional_chained: false,
                conditional_depth: scope.conditional_depth,
                loop_depth: scope.loop_depth,
            },
            passes: Vec::new(),
        });
    }

    fn record_call(&mut self, node: Node, scope: &Scope) -> Option<String> {
        self.mutating_its_own(node, scope);
        let function = node
            .child_by_field_name("function")
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.child_by_field_name("method"))
            .or_else(|| node.child_by_field_name("constructor"))
            .or_else(|| node.child_by_field_name("type"));
        let (receiver, callee) = match function {
            Some(function) => {
                let receiver = self
                    .spec
                    .calls.receiver_fields
                    .iter()
                    .find_map(|field| function.child_by_field_name(field))
                    .or_else(|| {
                        self.spec
                            .calls.call_receiver_fields
                            .iter()
                            .find_map(|field| node.child_by_field_name(field))
                    })
                    .map(|found| self.text(found).to_string());
                let callee = match receiver.is_some() {
                    true => function
                        .child_by_field_name("field")
                        .or_else(|| function.child_by_field_name("name"))
                        .or_else(|| function.child_by_field_name("property"))
                        .map(|found| self.text(found).to_string())
                        .unwrap_or_else(|| self.text(function).to_string()),
                    false => self.text(function).to_string(),
                };
                (receiver, callee)
            }
            None => {
                let receiver = self
                    .spec
                    .calls.receiver_fields
                    .iter()
                    .find_map(|field| node.child_by_field_name(field))
                    .map(|found| self.text(found).to_string());
                match node.named_child(0) {
                    Some(first) => (receiver, self.text(first).to_string()),
                    None => return None,
                }
            }
        };
        let callee = match callee.strip_prefix(['!', '~']) {
            Some(bare) if !bare.is_empty() => bare.to_string(),
            _ => callee,
        };
        let callee = base_name(&callee).to_string();
        if callee.is_empty() || STATEMENT_KEYWORDS.binary_search(&callee.as_str()).is_ok() {
            return None;
        }
        let (receiver, callee) = match (&receiver, callee.rfind('.')) {
            (None, Some(at)) if at > 0 && at + 1 < callee.len() => (
                Some(callee[..at].to_string()),
                callee[at + 1..].to_string(),
            ),
            (Some(receiver), Some(_)) => {
                let called = callee
                    .strip_prefix(receiver.as_str())
                    .and_then(|rest| rest.strip_prefix('.'))
                    .unwrap_or(&callee)
                    .to_string();
                (Some(receiver.clone()), called)
            }
            _ => (receiver, callee),
        };
        let receiver = receiver.as_deref().and_then(settled);
        let receiver = match (&receiver, &scope.self_binding) {
            (Some(receiver), Some(binding)) if crate::names::root(receiver) == binding => {
                Some(format!("this{}", &receiver[binding.len()..]))
            }
            _ => receiver.clone(),
        };
        let arguments = node.child_by_field_name("arguments").or_else(|| {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .find(|child| child.kind() == "arguments" || child.kind() == "argument_list")
        });
        if let Some(arguments) = arguments {
            let mut cursor = arguments.walk();
            let children: Vec<Node> = arguments.named_children(&mut cursor).map(unwrapped).collect();
            let already_an_mcp_tool = self.registers_an_mcp_tool(&receiver, &callee, &children);
            let nested = if already_an_mcp_tool { None } else { self.mounted_route(arguments) };
            let direct = (!already_an_mcp_tool)
                .then(|| {
                    children
                        .iter()
                        .find(|argument| argument.kind().contains("string"))
                        .map(|argument| trim_quotes(self.text(*argument)).to_string())
                })
                .flatten();
            let label = match direct {
                Some(path) => Some(match self.mounted_method(arguments) {
                    Some(method) if path.starts_with('/') => format!("{method} {path}"),
                    _ => path,
                }),
                None => nested.clone(),
            };
            if let Some(label) = label {
                let registrar = match &receiver {
                    Some(receiver) => format!("{receiver}.{callee}"),
                    None => callee.clone(),
                };
                let mut handlers: Vec<(String, Node)> = Vec::new();
                for argument in children.iter() {
                    if argument.kind().contains("string") || configures_the_call(argument.kind()) {
                        continue;
                    }
                    if let Some(handler) = self.handled_inline(*argument) {
                        self.labelled.insert(handler.id(), (registrar.clone(), label.clone()));
                        continue;
                    }
                    for handler in self.referenced_names(*argument, 0) {
                        handlers.push((handler, *argument));
                    }
                    if argument.kind().contains("array") || argument.kind() == "list" {
                        let mut cursor = argument.walk();
                        let named: Vec<Node> = argument
                            .named_children(&mut cursor)
                            .map(unwrapped)
                            .map(|element| match element.kind() {
                                "array_element_initializer" | "element" | "list_element" => element.named_child(0).unwrap_or(element),
                                _ => element,
                            })
                            .collect();
                        let action = named
                            .iter()
                            .find(|element| element.kind().contains("string"))
                            .map(|element| trim_quotes(self.text(*element)).trim().to_string())
                            .filter(|action| !action.is_empty() && action.chars().all(|letter| letter.is_alphanumeric() || letter == '_'));
                        if let Some(action) = action.filter(|_| named.len() == 2) {
                            handlers.push((format!(":{action}"), *argument));
                        }
                    }
                }
                if nested.is_some() {
                    self.handed_over(arguments, &mut handlers);
                }
                for (handler, at) in handlers {
                    self.facts.registrations.push(RegistrationFact {
                        file: self.file,
                        registrar: registrar.clone(),
                        label: label.clone(),
                        handler,
                        line: at.start_position().row as u32 + 1,
                    });
                }
            }
        }
        let argument_count = arguments
            .map(|arguments| {
                let mut cursor = arguments.walk();
                arguments.named_children(&mut cursor).count() as u16
            })
            .unwrap_or(0);
        let literals = match arguments {
            Some(arguments) => {
                let mut cursor = arguments.walk();
                self.literals_of(arguments.named_children(&mut cursor))
            }
            None => {
                let mut cursor = node.walk();
                let direct: Vec<Node> = node
                    .named_children(&mut cursor)
                    .filter(|child| Some(child.id()) != function.map(|found| found.id()))
                    .collect();
                self.literals_of(direct.into_iter())
            }
        };
        let mut literals = literals;
        let member_named = node.prev_named_sibling().and_then(|held| match held.kind() {
            "name_equals" => held.named_child(0),
            "identifier" if node.parent().is_some_and(|parent| parent.kind() == "anonymous_object_creation_expression") => {
                Some(held)
            }
            _ => None,
        });
        if let Some(named) = member_named {
            literals.insert(0, format!("name={}", self.text(named).trim()));
        }

        let registrar = callee.clone();
        let passes = match arguments {
            Some(arguments) => {
                let mut cursor = arguments.walk();
                crate::entities::passed(arguments.named_children(&mut cursor).map(|argument| self.text(argument)))
            }
            None => Vec::new(),
        };
        self.facts.calls.push(CallFact {
            file: self.file,
            caller: scope.callable.clone().or_else(|| scope.owner.clone()),
            callee,
            receiver,
            line: node.start_position().row as u32 + 1,
            column: node.start_position().column as u32,
            argument_count,
            literals,
            constructs: node.kind().contains("new") || node.kind().contains("creation"),
            type_arguments: self.type_arguments_of(node, function),
            context: CallContext {
                in_try: scope.in_try,
                in_catch: scope.in_catch,
                in_finally: scope.in_finally,
                awaited: scope.awaited,
                optional_chained: false,
                conditional_depth: scope.conditional_depth,
                loop_depth: scope.loop_depth,
            },
            passes,
        });
        Some(registrar)
    }
}

fn string_prefix(text: &str) -> usize {
    let bytes = text.as_bytes();
    let prefix = bytes
        .iter()
        .take(2)
        .take_while(|letter| letter.is_ascii_alphabetic() || matches!(letter, b'$' | b'@'))
        .count();
    match bytes.get(prefix) {
        Some(b'"' | b'\'' | b'`') => prefix,
        _ => 0,
    }
}

fn trim_quotes(text: &str) -> &str {
    let trimmed = text.trim();
    let unprefixed = &trimmed[string_prefix(trimmed)..];
    let bytes = unprefixed.as_bytes();
    if bytes.len() >= 2
        && matches!(bytes[0], b'"' | b'\'' | b'`')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        return &unprefixed[1..unprefixed.len() - 1];
    }
    trimmed
}

const ARGUMENTS_AT_MOST: usize = 16;
const ARGUMENT_AT_LONGEST: usize = 64;

fn inside_call(text: &str) -> Option<&str> {
    let open = text.find('(')?;
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    for (at, letter) in text[open..].char_indices() {
        if let Some(mark) = quote {
            if letter == mark {
                quote = None;
            }
            continue;
        }
        match letter {
            '"' | '\'' => quote = Some(letter),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open + 1..open + at]);
                }
            }
            _ => {}
        }
    }
    None
}

fn by_comma(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut start = 0usize;
    for (at, letter) in text.char_indices() {
        if let Some(mark) = quote {
            if letter == mark {
                quote = None;
            }
            continue;
        }
        match letter {
            '"' | '\'' => quote = Some(letter),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                found.push(&text[start..at]);
                start = at + 1;
            }
            _ => {}
        }
    }
    found.push(&text[start..]);
    found
}

fn written_arguments(text: &str) -> Vec<DecoratorArgument> {
    let Some(spoken) = inside_call(text) else {
        return string_literals(text)
            .into_iter()
            .map(|value| DecoratorArgument { value, literal: true })
            .collect();
    };
    let mut found = Vec::new();
    for piece in by_comma(spoken) {
        let quoted = string_literals(piece);
        if !quoted.is_empty() {
            for value in quoted {
                found.push(DecoratorArgument { value, literal: true });
            }
            continue;
        }
        let piece = piece.trim();
        if piece.is_empty()
            || piece.len() > ARGUMENT_AT_LONGEST
            || !piece.contains(|letter: char| letter.is_alphabetic())
        {
            continue;
        }
        found.push(DecoratorArgument { value: piece.to_string(), literal: false });
    }
    found.truncate(ARGUMENTS_AT_MOST);
    found
}

fn without_its_value<'t>(held: Node<'t>, value_field: &str) -> Option<Node<'t>> {
    let valued = held.child_by_field_name(value_field).is_some()
        || held.child_by_field_name("value").is_some();
    if !valued {
        return Some(held);
    }
    ["declarator", "name", "pattern"]
        .into_iter()
        .find_map(|field| held.child_by_field_name(field))
}

fn signs_for_a_call(declarator: Node) -> bool {
    let mut held = Some(declarator);
    while let Some(found) = held {
        if found.kind().contains("function") || found.child_by_field_name("parameters").is_some() {
            return true;
        }
        held = found.child_by_field_name("declarator");
    }
    false
}

const WORD_AT_MOST: usize = 200;
const TEXT_AT_MOST: usize = 400;

fn configures_the_call(kind: &str) -> bool {
    matches!(kind, "keyword_argument" | "named_argument" | "value_argument_label" | "labeled_argument")
}

static DECLARES_VARIABLES: &[&str] = &["variable_declaration"];
static KEEPS_WHAT_IT_RETURNS: &[&str] = &[
    "coroutineScope", "lazy", "remember", "rememberRetained", "rememberSaveable", "run", "runBlocking", "synchronized",
    "with", "withContext",
];
static INFERS_ITS_TYPE: &[&str] = &["auto", "dynamic", "let", "val", "var"];
static CONSTRUCTS_A_VALUE: &[&str] = &["new_expression", "object_creation_expression"];
static HANDS_BACK_ITS_RECEIVER: &[&str] = &[
    "as_mut", "as_ref", "borrow", "borrow_mut", "clone", "deref", "expect", "to_owned", "unwrap", "unwrap_or_default",
];
static NAMES_A_VARIABLE: &[&str] = &["variable_declarator"];

static INDEXES_A_HOLDER: &[&str] =
    &["element_access_expression", "element_reference", "index_expression", "subscript", "subscript_expression"];

fn text_it_begins_with(raw: &str) -> Option<&str> {
    let unprefixed = &raw[string_prefix(raw)..];
    let opened = unprefixed.chars().next().filter(|letter| matches!(letter, '"' | '\''))?;
    let closes = unprefixed[1..].find(opened)? + 1;
    let after = unprefixed[closes + 1..].trim_start();
    let joined = after.starts_with('+') || after.starts_with('.') && !after.starts_with("..") || after.starts_with("..");
    (joined && !unprefixed[1..closes].contains('\\')).then(|| &unprefixed[1..closes])
}

fn named_as_text(raw: &str) -> Option<(&str, &str)> {
    let (named, written) = raw.split_once(':')?;
    let named = named.trim();
    let written = written.trim();
    let plainly = !named.is_empty()
        && named.chars().all(|letter| letter.is_alphanumeric() || letter == '_');
    (plainly && written_as_text(written)).then_some((named, written))
}

fn written_as_text(raw: &str) -> bool {
    let unprefixed = &raw[string_prefix(raw)..];
    let Some(opened) = unprefixed.chars().next().filter(|letter| matches!(letter, '"' | '\'' | '`'))
    else {
        return false;
    };
    unprefixed.chars().count() > 1 && unprefixed.ends_with(opened)
}

fn string_literals(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut position = 0;
    while position < bytes.len() {
        let quote = bytes[position];
        if quote == b'"' || quote == b'\'' {
            let start = position + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end] != quote {
                end += 1;
            }
            if end < bytes.len()
                && let Ok(literal) = std::str::from_utf8(&bytes[start..end])
            {
                found.push(literal.to_string());
            }
            position = end + 1;
            continue;
        }
        position += 1;
    }
    found
}

fn base_name(text: &str) -> &str {
    let text = text.trim();
    let end = text.find(['<', '(', '[', '{', '\n', ' ']).unwrap_or(text.len());
    text[..end].trim()
}

fn throw_name(text: &str) -> String {
    let text = text.trim().strip_prefix("new ").unwrap_or(text.trim());
    let end = text.find(['(', ' ', ';', '\n']).unwrap_or(text.len());
    text[..end].trim().to_string()
}

static STATEMENT_KEYWORDS: &[&str] = &[
    "await", "defer", "do", "else", "go", "if", "return", "spawn", "switch", "throw", "try",
    "unsafe", "while", "yield",
];

static SOURCE_SUFFIXES: &[&str] = &[
    ".c", ".cc", ".cpp", ".cs", ".dart", ".ex", ".exs", ".go", ".h", ".hpp", ".java", ".js",
    ".jsx", ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".scala", ".sol", ".svelte", ".swift",
    ".ts", ".tsx", ".vue",
];

fn binding_of(specifier: &str) -> String {
    let trimmed = specifier.trim_end_matches(['/', '.', ';', '"', '>']);
    let trimmed = SOURCE_SUFFIXES
        .iter()
        .find_map(|suffix| trimmed.strip_suffix(suffix))
        .unwrap_or(trimmed);
    let last = trimmed
        .rsplit(['/', '.', ':', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("");
    let cleaned: String = last
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if cleaned == "h" || cleaned == "hpp" || cleaned == "*" {
        return String::new();
    }
    cleaned
}

fn import_alias(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix("import ")?;
    let mut parts = rest.split_whitespace();
    let first = parts.next()?;
    if first.starts_with('"') || first.starts_with('\'') {
        return None;
    }
    let alias = parts.next()?;
    if alias.starts_with('"') || alias.starts_with('\'') {
        return Some(first.trim_matches(|c: char| !c.is_alphanumeric() && c != '_').to_string());
    }
    None
}

static IMPORT_WORDS: &[&str] = &[
    "#include", "const", "extern", "from", "function", "global", "import", "pub", "qualified", "static",
    "type", "use", "using",
];

fn reads_as_a_module(specifier: &str) -> bool {
    specifier
        .chars()
        .all(|letter| !letter.is_whitespace() && !matches!(letter, '"' | '\'' | '!' | '=' | '<' | '>'))
}

fn import_specifier(text: &str) -> String {
    let text = text.trim();
    if let Some(start) = text.find(['"', '\'', '<']) {
        let closing = match text.as_bytes()[start] {
            b'<' => '>',
            b'\'' => '\'',
            _ => '"',
        };
        if let Some(end) = text[start + 1..].find(closing) {
            return text[start + 1..start + 1 + end].to_string();
        }
    }
    let mut cleaned = text;
    while let Some(rest) = IMPORT_WORDS
        .iter()
        .find_map(|word| cleaned.strip_prefix(word))
        .filter(|rest| rest.starts_with(|next: char| next.is_whitespace()))
    {
        cleaned = rest.trim_start();
    }
    let end = cleaned.find([' ', ';', '\n']).unwrap_or(cleaned.len());
    let specifier = cleaned[..end].trim();
    let specifier = match specifier.find('{') {
        Some(at) => specifier[..at].trim_end_matches([':', '.', '/']),
        None => specifier,
    };
    match specifier.starts_with(['{', '(']) {
        true => String::new(),
        false => specifier.to_string(),
    }
}

#[cfg(test)]
mod arguments {
    use super::written_arguments;

    #[test]
    fn a_derive_names_the_traits_it_carries() {
        let found = written_arguments("#[derive(Debug, Clone, Encode, Decode)]");
        let held: Vec<&str> = found.iter().map(|argument| argument.value.as_str()).collect();
        assert_eq!(held, vec!["Debug", "Clone", "Encode", "Decode"]);
        assert!(found.iter().all(|argument| !argument.literal));
    }

    #[test]
    fn a_route_still_reads_as_the_path_it_serves() {
        let found = written_arguments("@app.route(\"/users/:id\", methods=[\"GET\"])");
        let held: Vec<(&str, bool)> = found
            .iter()
            .map(|argument| (argument.value.as_str(), argument.literal))
            .collect();
        assert_eq!(held, vec![("/users/:id", true), ("GET", true)]);
    }

    #[test]
    fn a_decorator_with_nothing_in_parentheses_names_nothing() {
        assert!(written_arguments("@property").is_empty());
        assert!(written_arguments("#[test]").is_empty());
    }
}

static ASSIGNS: &[&str] = &[
    "assignment",
    "assignment_expression",
    "assignment_statement",
    "augmented_assignment",
    "augmented_assignment_expression",
    "compound_assignment_expr",
    "operator_assignment",
];

static MUTATES_A_COLLECTION: &[&str] = &[
    "add", "addrange", "append", "clear", "delete", "extend", "insert", "push", "put", "remove", "removeall",
    "removeat", "removerange", "set", "unshift",
];

fn own_member(written: &str) -> Option<String> {
    let written = written.trim();
    let (bare, owned) = match ["this.", "self.", "$this->", "this->", "@"].iter().find_map(|prefix| written.strip_prefix(prefix)) {
        Some(rest) => (rest, true),
        None => (written, false),
    };
    let plain = !bare.is_empty()
        && bare.chars().all(|letter| letter.is_alphanumeric() || letter == '_')
        && bare.chars().next().is_some_and(|letter| letter.is_alphabetic() || letter == '_');
    if !plain {
        return None;
    }
    let looks_like_a_member = owned || bare.starts_with('_') && bare.len() > 1
        || bare.chars().next().is_some_and(char::is_uppercase) && bare.chars().any(char::is_lowercase);
    looks_like_a_member.then(|| bare.trim_start_matches('_').to_string())
}

fn addressed_in_an_object(raw: &str) -> Option<String> {
    let inner = raw.strip_prefix('{')?.trim_start();
    for key in ["url", "path", "endpoint"] {
        let mut rest = inner;
        while let Some(at) = rest.find(key) {
            let before = rest[..at].chars().last();
            let after = rest[at + key.len()..].trim_start();
            rest = &rest[at + key.len()..];
            if before.is_some_and(|letter| letter.is_alphanumeric() || letter == '_') {
                continue;
            }
            let Some(value) = after.strip_prefix(':') else { continue };
            let value = value.trim_start();
            let Some(quote) = value.chars().next().filter(|letter| matches!(letter, '\'' | '"' | '`')) else { continue };
            let body = &value[1..];
            let end = body.find(quote)?;
            let written = &body[..end];
            if written.starts_with('/') && written.len() <= TEXT_AT_MOST {
                return Some(format!("{key}={written}"));
            }
        }
    }
    None
}

fn keyed_symbols(raw: &str) -> Option<String> {
    let (named, value) = match raw.split_once("=>") {
        Some((named, value)) => (named.trim().trim_start_matches(':'), value.trim()),
        None => {
            let (named, value) = raw.split_once(':')?;
            (named.trim(), value.trim())
        }
    };
    if named.is_empty() || !named.chars().all(|letter| letter.is_alphanumeric() || letter == '_') || value.is_empty() {
        return None;
    }
    let listed = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .map(|inner| inner.split(',').map(str::trim).collect::<Vec<_>>())
        .or_else(|| {
            ["%i[", "%w[", "%i(", "%w("].iter().find_map(|opened| {
                let inner = value.strip_prefix(opened)?;
                let inner = inner.strip_suffix([']', ')'])?;
                Some(inner.split_whitespace().collect::<Vec<_>>())
            })
        })
        .unwrap_or_else(|| vec![value]);
    let words: Vec<&str> = listed
        .iter()
        .map(|word| word.trim_start_matches(':').trim_matches(['"', '\'']))
        .collect();
    let plain = words.iter().all(|word| {
        !word.is_empty() && word.len() <= 64 && word.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | '#' | '/' | '-' | ':' | '.' | '@' | '?' | '!'))
    });
    let symbolic = value.starts_with([':', '[', '%']) || written_as_text(value);
    (plain && symbolic).then(|| format!("{named}={}", words.join(",")))
}

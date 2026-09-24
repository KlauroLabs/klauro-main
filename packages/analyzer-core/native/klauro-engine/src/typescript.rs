use tree_sitter::{Node, Parser, Tree};

use crate::model::*;

const LITERAL_LIMIT: usize = 4;

const TEXT_REMEMBERED: usize = 400;

pub struct Extractor<'a> {
    source: &'a [u8],
    file: u32,
    module_id: String,
    facts: FileFacts,
    metrics: rustc_hash::FxHashMap<String, UnitMetrics>,
    remembered: rustc_hash::FxHashMap<String, String>,
    placed: Option<Placed>,
}

#[derive(Clone, Copy)]
struct Placed {
    written: bool,
    called: bool,
}

struct Scope {
    owner: Option<String>,
    enclosing_callable: Option<String>,
    class_name: Option<String>,
    exported: bool,
    inside_callable: bool,
    context: CallContext,
}

impl Scope {
    fn root(module: &str) -> Self {
        Scope {
            owner: Some(module.to_string()),
            enclosing_callable: None,
            class_name: None,
            exported: false,
            inside_callable: false,
            context: CallContext::default(),
        }
    }

    fn child(&self, owner: Option<String>, callable: Option<String>) -> Scope {
        Scope {
            owner: owner.or_else(|| self.owner.clone()),
            inside_callable: self.inside_callable || callable.is_some(),
            enclosing_callable: callable.or_else(|| self.enclosing_callable.clone()),
            class_name: self.class_name.clone(),
            exported: false,
            context: CallContext {
                in_try: self.context.in_try,
                in_catch: self.context.in_catch,
                in_finally: self.context.in_finally,
                awaited: false,
                optional_chained: false,
                conditional_depth: self.context.conditional_depth,
                loop_depth: self.context.loop_depth,
            },
        }
    }
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
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
    pub fn new(source: &'a [u8], file: u32, path: &str) -> Self {
        let module_id = path.to_string();
        Extractor {
            source,
            file,
            module_id,
            facts: FileFacts::default(),
            metrics: rustc_hash::FxHashMap::default(),
            remembered: rustc_hash::FxHashMap::default(),
            placed: None,
        }
    }

    fn unit(&mut self, scope: &Scope) -> Option<&mut UnitMetrics> {
        let callable = scope.enclosing_callable.clone()?;
        Some(self.metrics.entry(callable).or_default())
    }

    fn text(&self, node: Node) -> &'a str {
        std::str::from_utf8(&self.source[node.byte_range()]).unwrap_or("")
    }

    fn text_owned(&self, node: Node) -> String {
        self.text(node).to_string()
    }

    fn id(&self, kind: &str, name: &str, node: Node) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            self.module_id,
            kind,
            name,
            line_of(node),
            node.start_position().column + 1
        )
    }

    fn push_edge(&mut self, source: &str, target: &str, kind: EdgeKind) {
        self.facts.edges.push(IndexEdge {
            source: source.to_string(),
            target: target.to_string(),
            kind,
        });
    }

    pub fn run(mut self, tree: &Tree, path: &str, line_count: u32) -> FileFacts {
        let root = tree.root_node();
        self.facts.lines = line_count;
        self.facts.parse_errors = count_errors(root);
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
        let scope = Scope::root(&self.module_id.clone());
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
        let assigned = match node.kind() {
            "assignment_expression" | "augmented_assignment_expression" => {
                node.child_by_field_name("left").map(|left| left.id())
            }
            _ => None,
        };
        let invoked = match node.kind() {
            "call_expression" => node.child_by_field_name("function").map(|function| function.id()),
            _ => None,
        };
        loop {
            let child = cursor.node();
            self.placed = Some(Placed {
                written: assigned == Some(child.id()),
                called: invoked == Some(child.id()),
            });
            self.visit(child, scope);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }

    fn visit(&mut self, node: Node, scope: &Scope) {
        let placed = self.placed.take();
        match node.kind() {
            "import_statement" => self.import_statement(node),
            "export_statement" => self.export_statement(node, scope),
            "class_declaration" | "abstract_class_declaration" | "class" => {
                self.class_like(node, scope, NodeKind::Class)
            }
            "interface_declaration" => self.class_like(node, scope, NodeKind::Interface),
            "type_alias_declaration" => self.type_alias(node, scope),
            "enum_declaration" => self.enum_declaration(node, scope),
            "function_declaration" | "generator_function_declaration" => {
                self.function_declaration(node, scope)
            }
            "lexical_declaration" | "variable_declaration" => self.variable_declaration(node, scope),
            "call_expression" | "new_expression" => self.call_expression(node, scope),
            "try_statement" => self.try_statement(node, scope),
            "throw_statement" => {
                let thrown = node
                    .named_child(0)
                    .map(|value| throw_name(self.text(value)))
                    .unwrap_or_default();
                if let Some(unit) = self.unit(scope) {
                    unit.throws.push(thrown);
                }
                self.walk(node, scope);
            }
            "return_statement" => {
                if let Some(unit) = self.unit(scope) {
                    unit.returns += 1;
                }
                self.walk(node, scope);
            }
            "binary_expression" => {
                let operator = node
                    .child_by_field_name("operator")
                    .map(|operator| self.text_owned(operator))
                    .unwrap_or_default();
                if matches!(operator.as_str(), "&&" | "||" | "??")
                    && let Some(unit) = self.unit(scope)
                {
                    unit.branches += 1;
                }
                self.walk(node, scope);
            }
            "assignment_expression" | "augmented_assignment_expression" => {
                if let Some(left) = node.child_by_field_name("left") {
                    let target = self.text_owned(left);
                    self.keep(&target, true, left, scope);
                    if let Some(member) = member_of_this(&target)
                        && let Some(unit) = self.unit(scope)
                    {
                        unit.writes.push(member);
                    }
                }
                self.walk(node, scope);
            }
            "member_expression" => {
                let target = self.text_owned(node);
                let (written, called) = match placed {
                    Some(placed) => (placed.written, placed.called),
                    None => {
                        let parent = node.parent();
                        let written = parent.is_some_and(|parent| {
                            matches!(parent.kind(), "assignment_expression" | "augmented_assignment_expression")
                                && parent.child_by_field_name("left") == Some(node)
                        });
                        let called = parent.is_some_and(|parent| {
                            parent.kind() == "call_expression"
                                && parent.child_by_field_name("function") == Some(node)
                        });
                        (written, called)
                    }
                };
                if !written && !called {
                    self.keep(&target, false, node, scope);
                    self.read_a_setting(&target, node, scope);
                }
                if let Some(member) = member_of_this(&target)
                    && let Some(unit) = self.unit(scope)
                {
                    unit.reads.push(member);
                }
                self.walk(node, scope);
            }
            "if_statement" | "ternary_expression" | "switch_statement" => {
                if let Some(unit) = self.unit(scope) {
                    unit.branches += 1;
                }
                let mut inner = scope.child(None, None);
                inner.context.conditional_depth = scope.context.conditional_depth + 1;
                inner.enclosing_callable = scope.enclosing_callable.clone();
                self.walk(node, &inner);
            }
            "for_statement" | "for_in_statement" | "while_statement" | "do_statement" => {
                if let Some(unit) = self.unit(scope) {
                    unit.loops += 1;
                }
                let mut inner = scope.child(None, None);
                inner.context.loop_depth = scope.context.loop_depth + 1;
                inner.enclosing_callable = scope.enclosing_callable.clone();
                self.walk(node, &inner);
            }
            "await_expression" => {
                if let Some(unit) = self.unit(scope) {
                    unit.awaits += 1;
                }
                let mut inner = scope.child(None, None);
                inner.context.awaited = true;
                inner.enclosing_callable = scope.enclosing_callable.clone();
                self.walk(node, &inner);
            }
            "subscript_expression" => {
                let target = self.text_owned(node);
                self.read_a_setting(&target, node, scope);
                self.walk(node, scope);
            }
            _ => self.walk(node, scope),
        }
    }

    fn try_statement(&mut self, node: Node, scope: &Scope) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            let mut inner = scope.child(None, None);
            inner.enclosing_callable = scope.enclosing_callable.clone();
            match child.kind() {
                "statement_block" => inner.context.in_try = true,
                "catch_clause" => inner.context.in_catch = true,
                "finally_clause" => inner.context.in_finally = true,
                _ => {}
            }
            self.visit(child, &inner);
        }
    }

    fn import_statement(&mut self, node: Node) {
        let Some(source) = node.child_by_field_name("source") else {
            return;
        };
        let specifier = trim_quotes(self.text(source)).to_string();
        let mut names = Vec::new();
        let type_only = self
            .text(node)
            .trim_start()
            .starts_with("import type");

        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind() != "import_clause" {
                continue;
            }
            let mut clause = child.walk();
            for part in child.named_children(&mut clause) {
                match part.kind() {
                    "identifier" => names.push(ImportSpecifier {
                        local: self.text_owned(part),
                        imported: None,
                        namespace: false,
                        default_import: true,
                    }),
                    "namespace_import" => {
                        if let Some(alias) = part.named_child(0) {
                            names.push(ImportSpecifier {
                                local: self.text_owned(alias),
                                imported: None,
                                namespace: true,
                                default_import: false,
                            });
                        }
                    }
                    "named_imports" => {
                        let mut named = part.walk();
                        for entry in part.named_children(&mut named) {
                            if entry.kind() != "import_specifier" {
                                continue;
                            }
                            let imported = entry
                                .child_by_field_name("name")
                                .map(|n| self.text_owned(n));
                            let alias = entry.child_by_field_name("alias").map(|n| self.text_owned(n));
                            let Some(imported) = imported else { continue };
                            names.push(ImportSpecifier {
                                local: alias.clone().unwrap_or_else(|| imported.clone()),
                                imported: Some(imported),
                                namespace: false,
                                default_import: false,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        self.facts.imports.push(ImportFact {
            file: self.file,
            specifier,
            line: line_of(node),
            type_only,
            names,
        });
    }

    fn export_statement(&mut self, node: Node, scope: &Scope) {
        let reexport = node
            .child_by_field_name("source")
            .map(|source| trim_quotes(self.text(source)).to_string());
        let default_export = node
            .children(&mut node.walk())
            .any(|child| child.kind() == "default");

        if let Some(declaration) = node.child_by_field_name("declaration") {
            let mut exported = scope.child(None, None);
            exported.enclosing_callable = scope.enclosing_callable.clone();
            exported.exported = true;
            self.visit(declaration, &exported);
            for name in self.declared_names(declaration) {
                self.facts.exports.push(ExportFact {
                    file: self.file,
                    name,
                    line: line_of(node),
                    default_export,
                    reexport_from: reexport.clone(),
                });
            }
            return;
        }

        let mut cursor = node.walk();
        let mut recorded = false;
        for child in node.named_children(&mut cursor) {
            if child.kind() != "export_clause" {
                continue;
            }
            let mut clause = child.walk();
            for entry in child.named_children(&mut clause) {
                let Some(name) = entry.child_by_field_name("name") else {
                    continue;
                };
                let alias = entry.child_by_field_name("alias");
                self.facts.exports.push(ExportFact {
                    file: self.file,
                    name: self.text_owned(alias.unwrap_or(name)),
                    line: line_of(node),
                    default_export: false,
                    reexport_from: reexport.clone(),
                });
                recorded = true;
            }
        }
        if !recorded && default_export {
            self.facts.exports.push(ExportFact {
                file: self.file,
                name: "default".to_string(),
                line: line_of(node),
                default_export: true,
                reexport_from: reexport,
            });
        }
        if !recorded {
            self.walk(node, scope);
        }
    }

    fn declared_names(&self, declaration: Node) -> Vec<String> {
        if let Some(name) = declaration.child_by_field_name("name") {
            return vec![self.text_owned(name)];
        }
        let mut cursor = declaration.walk();
        declaration
            .named_children(&mut cursor)
            .filter(|child| child.kind() == "variable_declarator")
            .filter_map(|child| child.child_by_field_name("name"))
            .map(|name| self.text_owned(name))
            .collect()
    }

    fn decorators_of(&self, node: Node) -> Vec<Decorator> {
        let mut found = Vec::new();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind() == "decorator"
                && let Some(decorator) = self.decorator(child)
            {
                found.push(decorator);
            }
        }
        if !found.is_empty() {
            return found;
        }
        let mut sibling = node.prev_sibling();
        while let Some(current) = sibling {
            if current.kind() == "decorator" {
                if let Some(decorator) = self.decorator(current) {
                    found.push(decorator);
                }
            } else if !current.is_extra() && !matches!(current.kind(), "export" | "default") {
                break;
            }
            sibling = current.prev_sibling();
        }
        found.reverse();
        found
    }

    fn decorator(&self, node: Node) -> Option<Decorator> {
        let inner = node.named_child(0)?;
        let (name_node, arguments) = match inner.kind() {
            "call_expression" => (
                inner.child_by_field_name("function")?,
                inner.child_by_field_name("arguments"),
            ),
            _ => (inner, None),
        };
        let mut argument_values = Vec::new();
        if let Some(arguments) = arguments {
            let mut cursor = arguments.walk();
            for argument in arguments.named_children(&mut cursor) {
                let literal = matches!(
                    argument.kind(),
                    "string" | "number" | "true" | "false" | "null" | "template_string"
                );
                argument_values.push(DecoratorArgument {
                    value: trim_quotes(self.text(argument)).to_string(),
                    literal,
                });
            }
        }
        Some(Decorator {
            name: self.text_owned(name_node),
            arguments: argument_values,
        })
    }

    fn class_like(&mut self, node: Node, scope: &Scope, kind: NodeKind) {
        let Some(name_node) = node.child_by_field_name("name") else {
            self.walk(node, scope);
            return;
        };
        let name = self.text_owned(name_node);
        let id = self.id(
            if kind == NodeKind::Class { "class" } else { "interface" },
            &name,
            node,
        );
        let owner = scope.owner.clone();

        let mut modifiers = Modifiers {
            exported: scope.exported,
            abstract_member: node.kind() == "abstract_class_declaration",
            ..Modifiers::default()
        };
        modifiers.default_export = false;

        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: type_parameters_of(node).map(|parameters| Signature {
                parameters: Vec::new(),
                return_type: None,
                type_parameters: self.type_parameter_names(parameters),
                receiver: None,
            }),
            modifiers,
            decorators: self.decorators_of(node),
            type_annotation: None,
            documentation: self.documentation_of(node),
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.push_edge(owner, &id, EdgeKind::Contains);
        }

        self.heritage(node, &id);

        let mut inner = scope.child(Some(id.clone()), None);
        inner.class_name = Some(self.text_owned(name_node));
        if let Some(body) = node.child_by_field_name("body") {
            self.class_body(body, &inner, &id);
        }
    }

    fn type_parameter_names(&self, node: Node) -> Vec<String> {
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .filter(|child| child.kind() == "type_parameter")
            .filter_map(|child| child.child_by_field_name("name"))
            .map(|name| self.text_owned(name))
            .collect()
    }

    fn heritage(&mut self, node: Node, owner: &str) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            match child.kind() {
                "class_heritage" => {
                    let mut heritage = child.walk();
                    for clause in child.named_children(&mut heritage) {
                        let kind = match clause.kind() {
                            "extends_clause" => EdgeKind::Extends,
                            "implements_clause" => EdgeKind::Implements,
                            _ => continue,
                        };
                        self.heritage_names(clause, owner, kind);
                    }
                }
                "extends_type_clause" => self.heritage_names(child, owner, EdgeKind::Extends),
                _ => {}
            }
        }
    }

    fn heritage_names(&mut self, clause: Node, owner: &str, kind: EdgeKind) {
        let mut cursor = clause.walk();
        for entry in clause.named_children(&mut cursor) {
            if entry.kind() == "type_arguments" {
                continue;
            }
            let name = base_type_name(self.text(entry));
            if name.is_empty() {
                continue;
            }
            let written = match entry.next_named_sibling().filter(|next| next.kind() == "type_arguments") {
                Some(arguments) => format!("{}{}", self.text(entry), self.text(arguments)),
                None => self.text(entry).to_string(),
            };
            self.facts.type_references.push(TypeReferenceFact {
                file: self.file,
                source: owner.to_string(),
                name: name.to_string(),
                kind,
                arguments: crate::model::type_arguments(&written),
            });
        }
    }

    fn class_body(&mut self, body: Node, scope: &Scope, owner: &str) {
        let mut cursor = body.walk();
        for member in body.named_children(&mut cursor) {
            match member.kind() {
                "method_definition" | "method_signature" | "abstract_method_signature" => {
                    self.method(member, scope, owner)
                }
                "public_field_definition" | "property_signature" => {
                    self.property(member, scope, owner)
                }
                _ => {}
            }
        }
    }

    fn member_modifiers(&self, node: Node) -> Modifiers {
        let mut modifiers = Modifiers::default();
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "static" => modifiers.is_static = true,
                "readonly" => modifiers.readonly = true,
                "abstract" => modifiers.abstract_member = true,
                "async" => modifiers.is_async = true,
                "accessibility_modifier" => match self.text(child) {
                    "private" => modifiers.private_member = true,
                    "protected" => modifiers.protected_member = true,
                    _ => {}
                },
                "?" => modifiers.optional = true,
                "*" => modifiers.generator = true,
                _ => {}
            }
        }
        modifiers
    }

    fn method(&mut self, node: Node, scope: &Scope, owner: &str) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text_owned(name_node);
        let kind = match self.text(node).trim_start() {
            text if text.starts_with("get ") => NodeKind::Getter,
            text if text.starts_with("set ") => NodeKind::Setter,
            _ if name == "constructor" => NodeKind::Constructor,
            _ => NodeKind::Method,
        };
        let id = self.id("method", &name, node);
        let mut modifiers = self.member_modifiers(node);
        if name.starts_with('#') {
            modifiers.private_member = true;
        }

        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind,
            file: self.file,
            span: span_of(node),
            parent: Some(owner.to_string()),
            signature: Some(self.signature_of(node)),
            modifiers,
            decorators: self.decorators_of(node),
            type_annotation: None,
            documentation: self.documentation_of(node),
            project: None,
        callback_of: None,
            registration_label: None,
        });
        self.push_edge(owner, &id, EdgeKind::HasMethod);
        if kind == NodeKind::Constructor
            && let Some(parameters) = node.child_by_field_name("parameters")
        {
            self.fields_it_is_given(parameters, owner);
        }

        let mut inner = scope.child(Some(id.clone()), Some(id));
        inner.class_name = scope.class_name.clone();
        if let Some(body) = node.child_by_field_name("body") {
            self.walk(body, &inner);
        }
        if let Some(parameters) = node.child_by_field_name("parameters") {
            self.parameter_initializers(parameters, &inner);
        }
    }

    fn property(&mut self, node: Node, _scope: &Scope, owner: &str) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text_owned(name_node);
        let id = self.id("property", &name, node);
        let mut modifiers = self.member_modifiers(node);
        if name.starts_with('#') {
            modifiers.private_member = true;
        }
        let annotation = node
            .child_by_field_name("type")
            .and_then(|annotation| annotation.named_child(0))
            .map(|annotation| self.text_owned(annotation))
            .or_else(|| {
                let value = unwrap_value(node.child_by_field_name("value")?);
                value
                    .child_by_field_name("constructor")
                    .map(|found| self.text_owned(found))
                    .or_else(|| literal_type(value.kind()))
            });

        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Property,
            file: self.file,
            span: span_of(node),
            parent: Some(owner.to_string()),
            signature: None,
            modifiers,
            decorators: self.decorators_of(node),
            type_annotation: annotation,
            documentation: self.documentation_of(node),
            project: None,
        callback_of: None,
            registration_label: None,
        });
        self.push_edge(owner, &id, EdgeKind::HasField);

        if let Some(value) = node.child_by_field_name("value") {
            let mut inner = Scope::root(owner);
            inner.enclosing_callable = Some(id);
            self.visit(value, &inner);
        }
    }

    fn signature_of(&self, node: Node) -> Signature {
        let parameters = node
            .child_by_field_name("parameters")
            .map(|parameters| self.parameters_of(parameters))
            .unwrap_or_default();
        let return_type = node
            .child_by_field_name("return_type")
            .and_then(|annotation| annotation.named_child(0))
            .map(|annotation| self.text_owned(annotation));
        let type_parameters = type_parameters_of(node)
            .map(|parameters| self.type_parameter_names(parameters))
            .unwrap_or_default();
        Signature {
            parameters,
            return_type,
            type_parameters,
            receiver: None,
        }
    }

    fn parameters_of(&self, node: Node) -> Vec<Parameter> {
        let mut cursor = node.walk();
        let mut found = Vec::new();
        for parameter in node.named_children(&mut cursor) {
            if !matches!(
                parameter.kind(),
                "required_parameter" | "optional_parameter" | "rest_pattern" | "identifier"
            ) {
                continue;
            }
            let pattern = parameter
                .child_by_field_name("pattern")
                .unwrap_or(parameter);
            found.push(Parameter {
                name: self.text_owned(pattern),
                type_annotation: parameter
                    .child_by_field_name("type")
                    .and_then(|annotation| annotation.named_child(0))
                    .map(|annotation| self.text_owned(annotation)),
                optional: parameter.kind() == "optional_parameter",
                default_value: parameter
                    .child_by_field_name("value")
                    .map(|value| self.text_owned(value)),
            });
        }
        found
    }

    fn fields_it_is_given(&mut self, parameters: Node, owner: &str) {
        let mut cursor = parameters.walk();
        for parameter in parameters.named_children(&mut cursor) {
            let mut inner = parameter.walk();
            let kept = parameter
                .children(&mut inner)
                .any(|held| matches!(held.kind(), "accessibility_modifier" | "readonly" | "override_modifier"));
            if !kept {
                continue;
            }
            let Some(named) = parameter.child_by_field_name("pattern") else { continue };
            if named.kind() != "identifier" {
                continue;
            }
            let name = self.text_owned(named);
            let id = self.id("property", &name, parameter);
            let annotation = parameter
                .child_by_field_name("type")
                .and_then(|annotation| annotation.named_child(0))
                .map(|annotation| self.text_owned(annotation));
            self.facts.nodes.push(IndexNode {
                id: id.clone(),
                name,
                kind: NodeKind::Property,
                file: self.file,
                span: span_of(parameter),
                parent: Some(owner.to_string()),
                signature: None,
                modifiers: self.member_modifiers(parameter),
                decorators: self.decorators_of(parameter),
                type_annotation: annotation,
                documentation: None,
                project: None,
                callback_of: None,
                registration_label: None,
            });
            self.push_edge(owner, &id, EdgeKind::HasField);
        }
    }

    fn parameter_initializers(&mut self, parameters: Node, scope: &Scope) {
        let mut cursor = parameters.walk();
        for parameter in parameters.named_children(&mut cursor) {
            if let Some(value) = parameter.child_by_field_name("value") {
                self.visit(value, scope);
            }
        }
    }

    fn type_alias(&mut self, node: Node, scope: &Scope) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text_owned(name_node);
        let id = self.id("type", &name, node);
        let owner = scope.owner.clone();
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::TypeAlias,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: None,
            modifiers: Modifiers {
                exported: scope.exported,
                ..Modifiers::default()
            },
            decorators: Vec::new(),
            type_annotation: node
                .child_by_field_name("value")
                .map(|value| self.text_owned(value)),
            documentation: self.documentation_of(node),
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.push_edge(owner, &id, EdgeKind::Contains);
        }
        if let Some(value) = node.child_by_field_name("value") {
            self.object_type_members(value, &id);
        }
    }

    fn object_type_members(&mut self, value: Node, owner: &str) {
        if value.kind() != "object_type" {
            return;
        }
        let mut cursor = value.walk();
        for member in value.named_children(&mut cursor) {
            if member.kind() != "property_signature" {
                continue;
            }
            let scope = Scope::root(owner);
            self.property(member, &scope, owner);
        }
    }

    fn enum_declaration(&mut self, node: Node, scope: &Scope) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text_owned(name_node);
        let id = self.id("enum", &name, node);
        let owner = scope.owner.clone();
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Enum,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: None,
            modifiers: Modifiers {
                exported: scope.exported,
                ..Modifiers::default()
            },
            decorators: Vec::new(),
            type_annotation: None,
            documentation: self.documentation_of(node),
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.push_edge(owner, &id, EdgeKind::Contains);
        }
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let mut cursor = body.walk();
        for member in body.named_children(&mut cursor) {
            let member_name = match member.kind() {
                "property_identifier" => self.text_owned(member),
                "enum_assignment" => match member.child_by_field_name("name") {
                    Some(name) => self.text_owned(name),
                    None => continue,
                },
                _ => continue,
            };
            let member_id = self.id("enum_member", &member_name, member);
            self.facts.nodes.push(IndexNode {
                id: member_id.clone(),
                name: member_name,
                kind: NodeKind::Property,
                file: self.file,
                span: span_of(member),
                parent: Some(id.clone()),
                signature: None,
                modifiers: Modifiers::default(),
                decorators: Vec::new(),
                type_annotation: None,
                documentation: None,
                project: None,
        callback_of: None,
                registration_label: None,
            });
            self.push_edge(&id, &member_id, EdgeKind::HasField);
        }
    }

    fn function_declaration(&mut self, node: Node, scope: &Scope) {
        let Some(name_node) = node.child_by_field_name("name") else {
            self.walk(node, scope);
            return;
        };
        let name = self.text_owned(name_node);
        let id = self.id("function", &name, node);
        let owner = scope.owner.clone();
        let mut modifiers = self.member_modifiers(node);
        modifiers.exported = scope.exported;
        modifiers.generator = node.kind() == "generator_function_declaration";

        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(node),
            parent: owner.clone(),
            signature: Some(self.signature_of(node)),
            modifiers,
            decorators: self.decorators_of(node),
            type_annotation: None,
            documentation: self.documentation_of(node),
            project: None,
        callback_of: None,
            registration_label: None,
        });
        if let Some(owner) = owner.as_deref() {
            self.push_edge(owner, &id, EdgeKind::Contains);
        }

        let inner = scope.child(Some(id.clone()), Some(id));
        if let Some(body) = node.child_by_field_name("body") {
            self.walk(body, &inner);
        }
        if let Some(parameters) = node.child_by_field_name("parameters") {
            self.parameter_initializers(parameters, &inner);
        }
    }

    fn variable_declaration(&mut self, node: Node, scope: &Scope) {
        let mut cursor = node.walk();
        for declarator in node.named_children(&mut cursor) {
            if declarator.kind() != "variable_declarator" {
                continue;
            }
            let Some(name_node) = declarator.child_by_field_name("name") else {
                continue;
            };
            let name = self.text_owned(name_node);
            let value = declarator.child_by_field_name("value");
            if let Some(written) = value
                .filter(|value| matches!(value.kind(), "string" | "template_string"))
                .map(|value| trim_quotes(self.text(value)).trim().to_string())
                .filter(|written| !written.is_empty() && written.len() <= TEXT_REMEMBERED)
            {
                self.remembered.insert(name.clone(), written);
            }
            let callable = value.filter(|value| {
                matches!(value.kind(), "arrow_function" | "function_expression" | "function")
            });

            if callable.is_none() {
                let unit = scope.enclosing_callable.clone().unwrap_or_default();
                {
                    let annotation = declarator
                        .child_by_field_name("type")
                        .and_then(|annotation| annotation.named_child(0))
                        .map(|annotation| self.text_owned(annotation));
                    let initializer = value.map(|value| unwrap_value(value));
                    let constructed = initializer
                        .filter(|value| value.kind() == "new_expression")
                        .and_then(|value| value.child_by_field_name("constructor"))
                        .map(|found| self.text_owned(found))
                        .or_else(|| {
                            initializer
                                .filter(|value| value.kind() != "object")
                                .and_then(|value| literal_type(value.kind()))
                        })
                        ;
                    let from_call = initializer
                        .filter(|value| value.kind() == "call_expression")
                        .and_then(|value| value.child_by_field_name("function"))
                        .and_then(|function| match function.kind() {
                            "identifier" => Some(function),
                            "member_expression" => function.child_by_field_name("property"),
                            _ => None,
                        })
                        .map(|found| self.text_owned(found));
                    if annotation.is_some() || constructed.is_some() || from_call.is_some() {
                        self.facts.locals.push(LocalBinding {
                            file: self.file,
                            unit,
                            name: name.clone(),
                            annotation,
                            constructed,
                            from_call,
                            line: node.start_position().row as u32 + 1,
                        });
                    }
                }
                if scope.inside_callable {
                    if let Some(value) = value {
                        self.visit(value, scope);
                    }
                    continue;
                }
            }
            let kind = if callable.is_some() {
                NodeKind::Function
            } else {
                NodeKind::Variable
            };
            let id = self.id(
                if callable.is_some() { "function" } else { "variable" },
                &name,
                declarator,
            );
            let owner = scope.owner.clone();
            let mut modifiers = Modifiers {
                exported: scope.exported,
                ..Modifiers::default()
            };
            if let Some(callable) = callable {
                modifiers.is_async = callable
                    .children(&mut callable.walk())
                    .any(|child| child.kind() == "async");
            }

            self.facts.nodes.push(IndexNode {
                id: id.clone(),
                name,
                kind,
                file: self.file,
                span: span_of(declarator),
                parent: owner.clone(),
                signature: callable.map(|callable| self.signature_of(callable)),
                modifiers,
                decorators: Vec::new(),
                type_annotation: declarator
                    .child_by_field_name("type")
                    .and_then(|annotation| annotation.named_child(0))
                    .map(|annotation| self.text_owned(annotation)),
                documentation: self.documentation_of(node),
                project: None,
        callback_of: None,
                registration_label: None,
            });
            if let Some(owner) = owner.as_deref() {
                self.push_edge(owner, &id, EdgeKind::Contains);
            }

            let held_by = id.clone();
            let inner = scope.child(Some(id.clone()), Some(id));
            match callable {
                Some(callable) => {
                    if let Some(body) = callable.child_by_field_name("body") {
                        self.visit(body, &inner);
                    }
                    if let Some(parameters) = callable.child_by_field_name("parameters") {
                        self.parameter_initializers(parameters, &inner);
                    }
                }
                None => match value.map(unwrap_value).filter(|held| held.kind() == "object") {
                    Some(object) => self.object_members(object, &inner, &held_by),
                    None => {
                        if let Some(value) = value {
                            self.visit(value, &inner);
                        }
                    }
                },
            }
        }
    }

    fn keep(&mut self, target: &str, writes: bool, node: Node, scope: &Scope) {
        let Some(place) = kept_by_the_browser(target) else { return };
        let Some(unit) = scope.enclosing_callable.clone() else { return };
        self.facts.kept.push(crate::model::Kept {
            file: self.file,
            unit,
            place: place.to_string(),
            writes,
            line: span_of(node).line,
        });
    }

    fn read_a_setting(&mut self, target: &str, node: Node, scope: &Scope) {
        let Some(named) = crate::model::a_setting_read(target) else { return };
        self.facts.settings.push(crate::model::SettingRead {
            file: self.file,
            unit: scope.enclosing_callable.clone(),
            name: named.to_string(),
            line: span_of(node).line,
        });
    }

    fn object_members(&mut self, object: Node, scope: &Scope, owner: &str) {
        let mut cursor = object.walk();
        for member in object.named_children(&mut cursor) {
            match member.kind() {
                "method_definition" => self.method(member, scope, owner),
                "pair" => match member.child_by_field_name("value").filter(|held| {
                    matches!(held.kind(), "arrow_function" | "function_expression" | "function")
                }) {
                    Some(callable) => self.member_function(member, callable, scope, owner),
                    None => self.visit(member, scope),
                },
                _ => self.visit(member, scope),
            }
        }
    }

    fn member_function(&mut self, pair: Node, callable: Node, scope: &Scope, owner: &str) {
        let Some(key) = pair.child_by_field_name("key") else { return };
        let name = trim_quotes(self.text(key)).to_string();
        let id = self.id("method", &name, pair);
        let modifiers = Modifiers {
            is_async: callable.children(&mut callable.walk()).any(|child| child.kind() == "async"),
            ..Modifiers::default()
        };
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Method,
            file: self.file,
            span: span_of(pair),
            parent: Some(owner.to_string()),
            signature: Some(self.signature_of(callable)),
            modifiers,
            decorators: Vec::new(),
            type_annotation: None,
            documentation: self.documentation_of(pair),
            project: None,
            callback_of: None,
            registration_label: None,
        });
        self.push_edge(owner, &id, EdgeKind::HasMethod);
        let inner = scope.child(Some(id.clone()), Some(id));
        if let Some(body) = callable.child_by_field_name("body") {
            self.walk(body, &inner);
        }
        if let Some(parameters) = callable.child_by_field_name("parameters") {
            self.parameter_initializers(parameters, &inner);
        }
    }

    fn call_expression(&mut self, node: Node, scope: &Scope) {
        let constructs = node.kind() == "new_expression";
        let Some(function) = node
            .child_by_field_name("function")
            .or_else(|| node.child_by_field_name("constructor"))
        else {
            return;
        };
        let mut function = function;
        let mut awaited_callee = false;
        loop {
            match function.kind() {
                "await_expression" => {
                    awaited_callee = true;
                    match function.named_child(0) {
                        Some(inner) => function = inner,
                        None => break,
                    }
                }
                "parenthesized_expression" | "non_null_expression" | "as_expression" => {
                    match function.named_child(0) {
                        Some(inner) => function = inner,
                        None => break,
                    }
                }
                _ => break,
            }
        }
        let arguments = node.child_by_field_name("arguments");
        let argument_count = arguments
            .map(|arguments| {
                let mut cursor = arguments.walk();
                arguments.named_children(&mut cursor).count() as u16
            })
            .unwrap_or(0);
        let literals = arguments
            .map(|arguments| self.literal_arguments(arguments))
            .unwrap_or_default();

        let (receiver, callee) = match function.kind() {
            "member_expression" => {
                let object = function.child_by_field_name("object");
                let property = function.child_by_field_name("property");
                (
                    object.map(|object| self.text_owned(object)),
                    property
                        .map(|property| self.text_owned(property))
                        .unwrap_or_else(|| self.text_owned(function)),
                )
            }
            _ => (None, self.text_owned(function)),
        };

        let optional_chained = function.kind() == "member_expression"
            && function
                .children(&mut function.walk())
                .any(|child| child.kind() == "?.");

        if let Some(arguments) = arguments {
            let registrar = match receiver.as_deref() {
                Some(receiver) => format!("{receiver}.{callee}"),
                None => callee.clone(),
            };
            self.callback_arguments(arguments, scope, &registrar);
            let mut cursor = arguments.walk();
            for argument in arguments.named_children(&mut cursor) {
                if !matches!(argument.kind(), "arrow_function" | "function_expression" | "function") {
                    self.visit(argument, scope);
                }
            }
        }
        if function.kind() != "identifier" {
            self.visit(function, scope);
        }

        self.facts.calls.push(CallFact {
            file: self.file,
            caller: scope.enclosing_callable.clone(),
            callee,
            receiver,
            line: line_of(node),
            column: node.start_position().column as u32,
            argument_count,
            literals,
            constructs,
            context: CallContext {
                in_try: scope.context.in_try,
                in_catch: scope.context.in_catch,
                in_finally: scope.context.in_finally,
                awaited: scope.context.awaited || awaited_callee,
                optional_chained,
                conditional_depth: scope.context.conditional_depth,
                loop_depth: scope.context.loop_depth,
            },
        });
    }

    fn property_holding(&self, arguments: Node) -> Option<String> {
        let mut held = arguments.parent()?;
        while matches!(held.kind(), "call_expression" | "member_expression" | "arguments") {
            held = held.parent()?;
        }
        let named = match held.kind() {
            "pair" => held.child_by_field_name("key")?,
            "variable_declarator" => held.child_by_field_name("name")?,
            _ => return None,
        };
        Some(trim_quotes(self.text(named)).to_string())
    }

    fn callback_arguments(&mut self, arguments: Node, scope: &Scope, callee: &str) {
        let mut cursor = arguments.walk();
        let children: Vec<Node> = arguments.named_children(&mut cursor).collect();
        let label = children
            .iter()
            .find(|argument| argument.kind() == "string")
            .map(|argument| trim_quotes(self.text(*argument)).to_string())
            .or_else(|| self.property_holding(arguments));

        if let Some(label) = label.as_deref() {
            for argument in children.iter() {
                if !matches!(argument.kind(), "identifier" | "member_expression") {
                    continue;
                }
                self.facts.registrations.push(RegistrationFact {
                    file: self.file,
                    registrar: callee.to_string(),
                    label: label.to_string(),
                    handler: self.text_owned(*argument),
                    line: line_of(*argument),
                });
            }
        }

        for (position, argument) in children.iter().enumerate() {
            if !matches!(argument.kind(), "arrow_function" | "function_expression" | "function") {
                continue;
            }
            let name = format!("{callee}#{position}");
            let id = self.id("callback", &name, *argument);
            let modifiers = Modifiers {
                is_async: argument
                    .children(&mut argument.walk())
                    .any(|child| child.kind() == "async"),
                ..Modifiers::default()
            };

            self.facts.nodes.push(IndexNode {
                id: id.clone(),
                name,
                kind: NodeKind::Function,
                file: self.file,
                span: span_of(*argument),
                parent: scope.enclosing_callable.clone().or_else(|| scope.owner.clone()),
                signature: Some(self.signature_of(*argument)),
                modifiers,
                decorators: Vec::new(),
                type_annotation: None,
                documentation: None,
                project: None,
            callback_of: Some(callee.to_string()),
                registration_label: label.clone(),
            });
            if let Some(owner) = scope.enclosing_callable.clone().or_else(|| scope.owner.clone()) {
                self.push_edge(&owner, &id, EdgeKind::Contains);
            }

            let inner = scope.child(Some(id.clone()), Some(id));
            if let Some(body) = argument.child_by_field_name("body") {
                self.visit(body, &inner);
            }
            if let Some(parameters) = argument.child_by_field_name("parameters") {
                self.parameter_initializers(parameters, &inner);
            }
        }
    }

    fn literal_arguments(&self, arguments: Node) -> Vec<String> {
        let mut cursor = arguments.walk();
        arguments
            .named_children(&mut cursor)
            .filter(|argument| {
                matches!(
                    argument.kind(),
                    "string" | "template_string" | "number" | "identifier" | "binary_expression"
                )
            })
            .take(LITERAL_LIMIT)
            .filter_map(|argument| match argument.kind() {
                "identifier" => self.remembered.get(self.text(argument)).cloned(),
                "binary_expression" => self.text_it_begins_with(argument).map(|begins| format!("{begins}${{}}")),
                _ => Some(trim_quotes(self.text(argument)).to_string()),
            })
            .filter(|value| !value.is_empty() && value.len() <= TEXT_REMEMBERED)
            .collect()
    }

    fn text_it_begins_with(&self, joined: Node) -> Option<String> {
        let mut held = joined;
        while held.kind() == "binary_expression" {
            let operator = held.child_by_field_name("operator").map(|found| self.text(found));
            if operator != Some("+") {
                return None;
            }
            held = held.child_by_field_name("left")?;
        }
        matches!(held.kind(), "string" | "template_string").then(|| trim_quotes(self.text(held)).to_string())
    }

    fn documentation_of(&self, node: Node) -> Option<String> {
        let mut sibling = node.prev_sibling();
        while let Some(current) = sibling {
            if current.kind() == "comment" {
                let text = self.text(current);
                if text.starts_with("/**") {
                    return Some(clean_doc_comment(text));
                }
                return None;
            }
            if current.kind() != "decorator" {
                return None;
            }
            sibling = current.prev_sibling();
        }
        None
    }
}

static KEPT_BY_THE_BROWSER: &[&str] = &["localStorage", "sessionStorage"];

fn kept_by_the_browser(target: &str) -> Option<&'static str> {
    let bare = target.strip_prefix("window.").unwrap_or(target);
    if bare == "document.cookie" {
        return Some("cookie");
    }
    let (held, _) = bare.split_once(['.', '['])?;
    KEPT_BY_THE_BROWSER.iter().find(|place| **place == held).copied()
}

fn literal_type(kind: &str) -> Option<String> {
    Some(
        match kind {
            "array" => "Array",
            "object" => "Object",
            "string" | "template_string" => "String",
            "number" => "Number",
            "true" | "false" => "Boolean",
            "regex" => "RegExp",
            _ => return None,
        }
        .to_string(),
    )
}

fn unwrap_value(value: Node) -> Node {
    let mut current = value;
    for _ in 0..4 {
        match current.kind() {
            "await_expression" | "parenthesized_expression" | "non_null_expression"
            | "as_expression" => match current.named_child(0) {
                Some(inner) => current = inner,
                None => return current,
            },
            _ => return current,
        }
    }
    current
}

fn member_of_this(target: &str) -> Option<String> {
    let rest = target.strip_prefix("this.")?;
    let end = rest.find(['.', '[', '(', ' ']).unwrap_or(rest.len());
    let member = &rest[..end];
    if member.is_empty() { None } else { Some(member.to_string()) }
}

fn throw_name(text: &str) -> String {
    let text = text.trim().strip_prefix("new ").unwrap_or(text.trim());
    let end = text.find(['(', ' ', ';']).unwrap_or(text.len());
    text[..end].trim().to_string()
}

fn type_parameters_of(node: Node) -> Option<Node> {
    node.child_by_field_name("type_parameters")
}

fn base_type_name(text: &str) -> &str {
    let text = text.trim();
    let end = text
        .find(['<', '('])
        .unwrap_or(text.len());
    text[..end].trim()
}

fn trim_quotes(text: &str) -> &str {
    let trimmed = text.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2
        && matches!(bytes[0], b'"' | b'\'' | b'`')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        return &trimmed[1..trimmed.len() - 1];
    }
    trimmed
}

fn clean_doc_comment(text: &str) -> String {
    let mut cleaned = String::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line
            .trim_start_matches("/**")
            .trim_start_matches("*/")
            .trim_start_matches('*')
            .trim_end_matches("*/")
            .trim();
        if line.is_empty() {
            continue;
        }
        if !cleaned.is_empty() {
            cleaned.push(' ');
        }
        cleaned.push_str(line);
    }
    cleaned
}

pub fn first_error(root: Node) -> Option<(u32, String)> {
    if !root.has_error() {
        return None;
    }
    let mut cursor = root.walk();
    let mut descend = true;
    loop {
        let node = cursor.node();
        if node.is_error() || node.is_missing() {
            return Some((
                node.start_position().row as u32 + 1,
                node.kind().to_string(),
            ));
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

pub fn count_errors(root: Node) -> u32 {
    if !root.has_error() {
        return 0;
    }
    let mut errors = 0;
    let mut cursor = root.walk();
    let mut descend = true;
    loop {
        let node = cursor.node();
        if node.is_error() || node.is_missing() {
            errors += 1;
            descend = false;
        }
        if descend && cursor.goto_first_child() {
            continue;
        }
        descend = true;
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return errors;
            }
        }
    }
}

pub fn wraps_script(id: &str) -> bool {
    matches!(id, "svelte" | "vue")
}

pub fn reads(id: &str) -> bool {
    matches!(id, "typescript" | "javascript" | "svelte" | "vue")
}

pub fn parser_for_language(id: &str) -> Option<Parser> {
    let language: tree_sitter::Language = match id {
        "typescript" | "svelte" | "vue" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        _ => return None,
    };
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    Some(parser)
}

pub fn parser_for(path: &str) -> Option<Parser> {
    let language = if path.ends_with(".tsx") {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else if path.ends_with(".ts") || path.ends_with(".mts") || path.ends_with(".cts") {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    } else if path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mjs")
        || path.ends_with(".cjs")
    {
        tree_sitter_javascript::LANGUAGE.into()
    } else {
        return None;
    };
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    Some(parser)
}

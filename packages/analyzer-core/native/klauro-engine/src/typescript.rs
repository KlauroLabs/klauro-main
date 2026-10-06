use tree_sitter::{Node, Parser, Tree};

use crate::model::*;

mod addressing;
mod dispatch;
mod messages;
mod routes;

const LITERAL_LIMIT: usize = 4;

const TEXT_REMEMBERED: usize = 400;

pub struct Extractor<'a> {
    source: &'a [u8],
    file: u32,
    module_id: String,
    facts: FileFacts,
    metrics: rustc_hash::FxHashMap<String, UnitMetrics>,
    remembered: rustc_hash::FxHashMap<String, String>,
    option_bags: rustc_hash::FxHashSet<String>,
    placed: Option<Placed>,
    speaks_the_mcp_sdk: bool,
    tool_registrar_aliases: rustc_hash::FxHashSet<String>,
    field_defaults: rustc_hash::FxHashMap<String, String>,
    roots: rustc_hash::FxHashSet<String>,
    containers: rustc_hash::FxHashSet<String>,
    returned_paths: std::cell::OnceCell<rustc_hash::FxHashMap<String, String>>,
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
    dispatches_mcp_tools: bool,
    argv_param: Option<String>,
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
            dispatches_mcp_tools: false,
            argv_param: None,
        }
    }

    fn child(&self, owner: Option<String>, callable: Option<String>) -> Scope {
        Scope {
            owner: owner.or_else(|| self.owner.clone()),
            inside_callable: self.inside_callable || callable.is_some(),
            enclosing_callable: callable.or_else(|| self.enclosing_callable.clone()),
            class_name: self.class_name.clone(),
            exported: false,
            dispatches_mcp_tools: self.dispatches_mcp_tools,
            argv_param: self.argv_param.clone(),
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
            option_bags: rustc_hash::FxHashSet::default(),
            placed: None,
            speaks_the_mcp_sdk: false,
            tool_registrar_aliases: rustc_hash::FxHashSet::default(),
            field_defaults: rustc_hash::FxHashMap::default(),
            roots: rustc_hash::FxHashSet::default(),
            containers: rustc_hash::FxHashSet::default(),
            returned_paths: std::cell::OnceCell::new(),
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
            via: Via::Structure,
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
                self.note_handled_tags(node, scope);
                if node.kind() == "if_statement" && self.routed_branch(node, scope) {
                    return;
                }
                if node.kind() == "if_statement" && self.cli_routed_branch(node, scope) {
                    return;
                }
                if node.kind() == "switch_statement"
                    && scope.dispatches_mcp_tools
                    && self.mcp_tool_switch(node, scope)
                {
                    return;
                }
                if node.kind() == "switch_statement" && scope.argv_param.is_some() && self.cli_switch(node, scope) {
                    return;
                }
                if node.kind() == "switch_statement" && self.routed_switch(node, scope) {
                    return;
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
                self.loop_element(node, scope);
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
            "jsx_self_closing_element" | "jsx_opening_element" => {
                self.jsx_tag(node, scope);
                self.walk(node, scope);
            }
            "object" => {
                self.route_object(node);
                self.walk(node, scope);
            }
            _ => self.walk(node, scope),
        }
    }

    fn mcp_tool_switch(&mut self, node: Node, scope: &Scope) -> bool {
        let Some(value) = node.child_by_field_name("value") else { return false };
        let discriminant = value.named_child(0).unwrap_or(value);
        let written = self.text(discriminant);
        if !written.rsplit(['.', '?']).next().is_some_and(|last| last == "name") {
            return false;
        }
        let Some(body) = node.child_by_field_name("body") else { return false };
        let mut matched = false;
        let mut cases = body.walk();
        for case in body.named_children(&mut cases) {
            if case.kind() != "switch_case" {
                continue;
            }
            let Some(case_value) = case.child_by_field_name("value") else { continue };
            if case_value.kind() != "string" {
                continue;
            }
            let label = trim_quotes(self.text(case_value)).to_string();
            matched = true;
            let name = format!("tool.{label}");
            let id = self.id("callback", &name, case);
            let holder = scope.enclosing_callable.clone().or_else(|| scope.owner.clone());
            self.facts.nodes.push(IndexNode {
                id: id.clone(),
                name,
                kind: NodeKind::Function,
                file: self.file,
                span: span_of(case),
                parent: holder.clone(),
                signature: None,
                modifiers: Modifiers::default(),
                decorators: Vec::new(),
                type_annotation: None,
                documentation: None,
                project: None,
                callback_of: Some("dispatch:tool".to_string()),
                registration_label: Some(label),
            });
            if let Some(owner) = holder.as_deref() {
                self.push_edge(owner, &id, EdgeKind::Contains);
            }
            let mut inner = scope.child(Some(id.clone()), Some(id));
            inner.dispatches_mcp_tools = false;
            let mut statements = case.walk();
            for statement in case.children_by_field_name("body", &mut statements) {
                self.visit(statement, &inner);
            }
        }
        matched
    }

    fn cli_switch(&mut self, node: Node, scope: &Scope) -> bool {
        let Some(argv_param) = scope.argv_param.as_deref() else { return false };
        let Some(value) = node.child_by_field_name("value") else { return false };
        let discriminant = value.named_child(0).unwrap_or(value);
        if self.text(discriminant).trim() != argv_param {
            return false;
        }
        let Some(body) = node.child_by_field_name("body") else { return false };
        let mut matched = false;
        let mut cases = body.walk();
        for case in body.named_children(&mut cases) {
            if case.kind() != "switch_case" {
                continue;
            }
            let Some(case_value) = case.child_by_field_name("value") else { continue };
            if case_value.kind() != "string" {
                continue;
            }
            let label = trim_quotes(self.text(case_value)).to_string();
            matched = true;
            let name = format!("{label}#{}", line_of(case));
            let id = self.id("callback", &name, case);
            let holder = scope.enclosing_callable.clone().or_else(|| scope.owner.clone());
            self.facts.nodes.push(IndexNode {
                id: id.clone(),
                name,
                kind: NodeKind::Function,
                file: self.file,
                span: span_of(case),
                parent: holder.clone(),
                signature: None,
                modifiers: Modifiers::default(),
                decorators: Vec::new(),
                type_annotation: None,
                documentation: None,
                project: None,
                callback_of: Some("dispatch:cli".to_string()),
                registration_label: Some(label),
            });
            if let Some(owner) = holder.as_deref() {
                self.push_edge(owner, &id, EdgeKind::Contains);
            }
            let inner = scope.child(Some(id.clone()), Some(id));
            let mut statements = case.walk();
            for statement in case.children_by_field_name("body", &mut statements) {
                self.visit(statement, &inner);
            }
        }
        matched
    }

    fn cli_routed_branch(&mut self, node: Node, scope: &Scope) -> bool {
        let (Some(condition), Some(consequence)) =
            (node.child_by_field_name("condition"), node.child_by_field_name("consequence"))
        else {
            return false;
        };
        let asked = self.text_owned(condition);
        let Some(label) = cli_dispatched_on(&asked, scope.argv_param.as_deref()) else { return false };
        let name = format!("{label}#{}", line_of(node));
        let id = self.id("callback", &name, consequence);
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name,
            kind: NodeKind::Function,
            file: self.file,
            span: span_of(consequence),
            parent: scope.enclosing_callable.clone().or_else(|| scope.owner.clone()),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: Some("dispatch:cli".to_string()),
            registration_label: Some(label),
        });
        if let Some(owner) = scope.enclosing_callable.clone().or_else(|| scope.owner.clone()) {
            self.push_edge(&owner, &id, EdgeKind::Contains);
        }
        let mut conditioned = scope.child(None, None);
        conditioned.enclosing_callable = scope.enclosing_callable.clone();
        conditioned.context.conditional_depth = scope.context.conditional_depth + 1;
        self.visit(condition, &conditioned);
        let inner = scope.child(Some(id.clone()), Some(id));
        self.visit(consequence, &inner);
        if let Some(alternative) = node.child_by_field_name("alternative") {
            self.visit(alternative, &conditioned);
        }
        true
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
        if specifier == "@modelcontextprotocol/sdk" || specifier.starts_with("@modelcontextprotocol/sdk/") {
            self.speaks_the_mcp_sdk = true;
        }
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
            everywhere: false,
            names,
        });
    }

    fn export_statement(&mut self, node: Node, scope: &Scope) {
        self.remember_the_default_export(node);
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
                if let Some(from) = reexport.as_ref() {
                    self.facts.forwards.push(crate::model::Forward {
                        file: self.file,
                        name: self.text_owned(alias.unwrap_or(name)),
                        original: self.text_owned(name),
                        from: from.clone(),
                    });
                }
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
        if !recorded && !default_export
            && let Some(from) = reexport.as_ref()
            && !node.named_children(&mut node.walk()).any(|child| child.kind() == "namespace_export")
        {
            self.facts.forwards.push(crate::model::Forward {
                file: self.file,
                name: "*".to_string(),
                original: "*".to_string(),
                from: from.clone(),
            });
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

    fn defaults_the_fields_hold(&self, body: Node) -> rustc_hash::FxHashMap<String, String> {
        let mut held = rustc_hash::FxHashMap::default();
        let mut cursor = body.walk();
        let Some(constructor) = body.named_children(&mut cursor).find(|member| {
            member.kind() == "method_definition"
                && member.child_by_field_name("name").is_some_and(|name| self.text(name) == "constructor")
        }) else {
            return held;
        };
        let mut defaults: rustc_hash::FxHashMap<String, String> = rustc_hash::FxHashMap::default();
        if let Some(parameters) = constructor.child_by_field_name("parameters") {
            let mut parameter_cursor = parameters.walk();
            for parameter in parameters.named_children(&mut parameter_cursor) {
                let (Some(name), Some(value)) = (parameter.child_by_field_name("pattern"), parameter.child_by_field_name("value")) else {
                    continue;
                };
                if name.kind() != "identifier" || !matches!(value.kind(), "identifier" | "member_expression") {
                    continue;
                }
                let name = self.text_owned(name);
                let kept = parameter.children(&mut parameter.walk()).any(|child| child.kind() == "accessibility_modifier" || child.kind() == "readonly");
                if kept {
                    held.insert(name.clone(), self.text_owned(value));
                }
                defaults.insert(name, self.text_owned(value));
            }
        }
        let mut pending: Vec<Node> = constructor.child_by_field_name("body").into_iter().collect();
        while let Some(node) = pending.pop() {
            if node.kind() == "assignment_expression"
                && let (Some(left), Some(right)) = (node.child_by_field_name("left"), node.child_by_field_name("right"))
                && left.kind() == "member_expression"
                && left.child_by_field_name("object").is_some_and(|object| self.text(object) == "this")
                && right.kind() == "identifier"
                && let Some(default) = defaults.get(self.text(right))
                && let Some(property) = left.child_by_field_name("property")
            {
                held.insert(self.text_owned(property), default.clone());
            }
            let mut inner = node.walk();
            pending.extend(node.named_children(&mut inner));
        }
        held
    }

    fn class_body(&mut self, body: Node, scope: &Scope, owner: &str) {
        let held = self.defaults_the_fields_hold(body);
        let before = std::mem::replace(&mut self.field_defaults, held);
        self.class_members(body, scope, owner);
        self.field_defaults = before;
    }

    fn class_members(&mut self, body: Node, scope: &Scope, owner: &str) {
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
                    .map(|found| match value.child_by_field_name("type_arguments") {
                        Some(arguments) => format!("{}{}", self.text(found), self.text(arguments)),
                        None => self.text_owned(found),
                    })
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
            .or_else(|| {
                node.child_by_field_name("parameter").map(|single| {
                    vec![Parameter {
                        name: self.text_owned(single),
                        type_annotation: None,
                        optional: false,
                        default_value: None,
                    }]
                })
            })
            .unwrap_or_default();
        let return_type = node
            .child_by_field_name("return_type")
            .and_then(|annotation| annotation.named_child(0))
            .map(|annotation| self.text_owned(annotation))
            .or_else(|| self.inferred_return(node));
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

    fn returned_value(&self, expression: Node) -> Option<String> {
        let expression = unwrap_value(expression);
        match expression.kind() {
            "this" => Some("Self".to_string()),
            "new_expression" => {
                let constructor = expression.child_by_field_name("constructor")?;
                let written = self.text(constructor).trim();
                (!written.is_empty() && written.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | '$' | '.')))
                    .then(|| written.to_string())
            }
            _ => None,
        }
    }

    fn inferred_return(&self, node: Node) -> Option<String> {
        if node.children(&mut node.walk()).any(|child| child.kind() == "async") {
            return None;
        }
        let body = node.child_by_field_name("body")?;
        if body.kind() != "statement_block" {
            return self.returned_value(body);
        }
        let mut agreed: Option<String> = None;
        let mut pending: Vec<Node> = vec![body];
        while let Some(held) = pending.pop() {
            let mut cursor = held.walk();
            for child in held.named_children(&mut cursor) {
                match child.kind() {
                    "function_declaration" | "function_expression" | "arrow_function" | "method_definition" | "class_declaration"
                    | "class" | "function" | "generator_function" | "generator_function_declaration" => {}
                    "return_statement" => {
                        let value = self.returned_value(child.named_child(0)?)?;
                        match agreed.as_deref() {
                            Some(existing) if existing != value => return None,
                            _ => agreed = Some(value),
                        }
                    }
                    _ => pending.push(child),
                }
            }
        }
        agreed
    }

    fn destructured(&mut self, pattern: Node, value: Node, scope: &Scope) {
        let initializer = unwrap_value(value);
        if !matches!(initializer.kind(), "identifier" | "member_expression" | "call_expression" | "this") {
            return;
        }
        let expression = self.text(initializer).trim().to_string();
        if expression.is_empty() || expression.len() > 200 {
            return;
        }
        let mut cursor = pattern.walk();
        for child in pattern.named_children(&mut cursor) {
            let (property, local) = match child.kind() {
                "shorthand_property_identifier_pattern" => (self.text_owned(child), self.text_owned(child)),
                "pair_pattern" => {
                    let (Some(key), Some(bound)) = (child.child_by_field_name("key"), child.child_by_field_name("value")) else {
                        continue;
                    };
                    if bound.kind() != "identifier" {
                        continue;
                    }
                    (self.text_owned(key), self.text_owned(bound))
                }
                _ => continue,
            };
            self.facts.locals.push(LocalBinding {
                file: self.file,
                unit: scope.enclosing_callable.clone().unwrap_or_default(),
                name: local,
                stands_for: Some(format!("{expression}.{property}")),
                line: line_of(pattern),
                ..Default::default()
            });
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

        self.loader_of(node);
        let mut inner = scope.child(Some(id.clone()), Some(id));
        if let Some(body) = node.child_by_field_name("body") {
            inner.argv_param = self.argv_local(body);
            self.walk(body, &inner);
        }
        if let Some(parameters) = node.child_by_field_name("parameters") {
            self.parameter_initializers(parameters, &inner);
        }
    }

    fn argv_local(&self, body: Node) -> Option<String> {
        fn looks_like_argv(text: &str) -> bool {
            let held = text.trim();
            if !held.contains("argv") {
                return false;
            }
            let numeric_index = held
                .find('[')
                .is_some_and(|at| held[at + 1..].trim_start().chars().next().is_some_and(|held| held.is_ascii_digit()));
            numeric_index || held.contains(".slice(")
        }
        let mut cursor = body.walk();
        for statement in body.named_children(&mut cursor) {
            if !matches!(statement.kind(), "lexical_declaration" | "variable_declaration") {
                continue;
            }
            let mut declarators = statement.walk();
            for declarator in statement.named_children(&mut declarators) {
                if declarator.kind() != "variable_declarator" {
                    continue;
                }
                let (Some(name_node), Some(value)) =
                    (declarator.child_by_field_name("name"), declarator.child_by_field_name("value"))
                else {
                    continue;
                };
                let value_text = self.text(value);
                if name_node.kind() == "array_pattern" && value_text.trim().ends_with(".argv") {
                    let mut elements = name_node.walk();
                    let last = name_node
                        .named_children(&mut elements)
                        .filter(|element| element.kind() == "identifier")
                        .last();
                    if let Some(last) = last {
                        return Some(self.text(last).trim().to_string());
                    }
                    continue;
                }
                if looks_like_argv(value_text) {
                    let name = self.text(name_node).trim();
                    if !name.is_empty() && name.chars().all(|held| held.is_alphanumeric() || held == '_') {
                        return Some(name.to_string());
                    }
                }
            }
        }
        None
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
            if let Some(value) = value.filter(|_| name_node.kind() == "object_pattern") {
                self.destructured(name_node, value, scope);
            }
            if let Some(value) = value.filter(|_| name_node.kind() == "identifier") {
                self.remember_a_root(&name, value);
                self.lazy_screens(&name, declarator, value);
                if !scope.inside_callable {
                    self.remember_a_table_of_paths(&name, value, line_of(declarator));
                }
            }
            if self.speaks_the_mcp_sdk
                && name_node.kind() == "identifier"
                && value.is_some_and(|value| self.forwards_tool_registration(value))
            {
                self.tool_registrar_aliases.insert(name.clone());
            }
            if name_node.kind() == "identifier" && value.is_some_and(|value| unwrap_value(value).kind() == "object") {
                self.option_bags.insert(name.clone());
            }
            let written_here = value.and_then(|value| self.constant_value(value));
            if let Some(written) = written_here.clone() {
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
                        .map(|annotation| self.text_owned(annotation))
                        .or_else(|| value.and_then(|value| self.cast_to(value)));
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
                        .filter(|function| matches!(function.kind(), "identifier" | "member_expression"))
                        .map(|found| self.text_owned(found))
                        .filter(|written| written.len() <= 200);
                    let from_values = initializer
                        .map(|held| crate::entities::built_from(self.text(held)))
                        .unwrap_or_default();
                    let stands_for = initializer
                        .filter(|held| self.reads_the_global_fetch(*held))
                        .map(|_| crate::entry_exit::FETCH_FUNCTION.to_string())
                        .or_else(|| {
                            let plain = annotation.is_none() && constructed.is_none() && from_call.is_none();
                            initializer.filter(|_| plain).and_then(|held| self.read_path(held, &name))
                        });
                    if annotation.is_some() || constructed.is_some() || from_call.is_some() || !from_values.is_empty() || written_here.is_some() || stands_for.is_some() {
                        self.facts.locals.push(LocalBinding {
                            file: self.file,
                            unit,
                            name: name.clone(),
                            annotation,
                            constructed,
                            from_call,
                            written: written_here,
                            stands_for,
                            from_values,
                            line: node.start_position().row as u32 + 1,
                            ..Default::default()
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
                    self.loader_of(callable);
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

    fn cast_over(&self, call: Node) -> Option<String> {
        let mut current = call;
        for _ in 0..4 {
            let parent = current.parent()?;
            match parent.kind() {
                "as_expression" | "satisfies_expression" => {
                    let cast = self.text_owned(parent.named_child(1)?);
                    return (parent.named_child(0)?.id() == current.id() && cast != "const").then_some(cast);
                }
                "await_expression" | "parenthesized_expression" | "non_null_expression" => current = parent,
                _ => return None,
            }
        }
        None
    }

    fn cast_to(&self, value: Node) -> Option<String> {
        let mut current = value;
        for _ in 0..4 {
            match current.kind() {
                "as_expression" | "satisfies_expression" => {
                    let cast = self.text_owned(current.named_child(1)?);
                    return (cast != "const").then_some(cast);
                }
                "await_expression" | "parenthesized_expression" | "non_null_expression" => {
                    current = current.named_child(0)?;
                }
                _ => return None,
            }
        }
        None
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
        self.route_object(object);
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
            match body.kind() {
                "statement_block" => self.walk(body, &inner),
                _ => self.visit(body, &inner),
            }
        }
        if let Some(parameters) = callable.child_by_field_name("parameters") {
            self.parameter_initializers(parameters, &inner);
        }
    }

    fn call_expression(&mut self, node: Node, scope: &Scope) {
        self.mounted_screens(node);
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
        let mut literals = arguments
            .map(|arguments| self.literal_arguments(arguments))
            .unwrap_or_default();
        let passes = arguments
            .map(|arguments| {
                let mut cursor = arguments.walk();
                crate::entities::passed(arguments.named_children(&mut cursor).map(|argument| self.text(argument)))
            })
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
        let (receiver, callee) = match (receiver.as_deref(), self.field_defaults.get(&callee)) {
            (Some("this"), Some(default)) => match default.rsplit_once('.') {
                Some((object, property)) => (Some(object.to_string()), property.to_string()),
                None => (None, default.clone()),
            },
            _ => (receiver, callee),
        };

        if let Some(arguments) = arguments.filter(|_| crate::messages::a_delivery(&callee)) {
            let mut cursor = arguments.walk();
            for object in arguments.named_children(&mut cursor).filter(|argument| argument.kind() == "object") {
                self.note_sent_tag(object, scope);
            }
        }
        if callee == "register"
            && let Some(prefix) = arguments.and_then(|held| self.prefix_option(held))
        {
            literals.push(format!("prefix={prefix}"));
        }
        literals.extend(self.listed_program_words(&callee, arguments));

        let optional_chained = function.kind() == "member_expression"
            && function
                .children(&mut function.walk())
                .any(|child| child.kind() == "?.");

        if let Some(arguments) = arguments {
            let registrar = match receiver.as_deref() {
                Some(receiver) => format!("{receiver}.{callee}"),
                None if self.tool_registrar_aliases.contains(&callee) && !self.shadowed_by_a_parameter(node, &callee) => crate::entry_exit::MCP_TOOL_REGISTRAR.to_string(),
                None => callee.clone(),
            };
            let dispatches_mcp_tools = self.speaks_the_mcp_sdk
                && callee == "setRequestHandler"
                && self.text(arguments).contains("CallToolRequestSchema");
            self.callback_arguments(arguments, scope, &registrar, dispatches_mcp_tools);
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
            renders: false,
            type_arguments: node
                .child_by_field_name("type_arguments")
                .map(|found| {
                    let mut cursor = found.walk();
                    found.named_children(&mut cursor).map(|held| self.text_owned(held)).collect()
                })
                .unwrap_or_else(|| self.cast_over(node).into_iter().collect()),
            context: CallContext {
                in_try: scope.context.in_try,
                in_catch: scope.context.in_catch,
                in_finally: scope.context.in_finally,
                awaited: scope.context.awaited || awaited_callee,
                optional_chained,
                conditional_depth: scope.context.conditional_depth,
                loop_depth: scope.context.loop_depth,
            },
            passes,
        });
    }

    fn shadowed_by_a_parameter(&self, node: Node, name: &str) -> bool {
        let mut above = node.parent();
        while let Some(held) = above {
            if let Some(parameters) = held.child_by_field_name("parameters").or_else(|| held.child_by_field_name("parameter")) {
                let mut pending = vec![parameters];
                while let Some(candidate) = pending.pop() {
                    if candidate.kind() == "identifier" && self.text(candidate) == name {
                        return true;
                    }
                    let mut cursor = candidate.walk();
                    pending.extend(candidate.named_children(&mut cursor).filter(|child| child.kind() != "type_annotation"));
                }
            }
            above = held.parent();
        }
        false
    }

    fn forwards_tool_registration(&self, value: Node) -> bool {
        let mut pending = vec![value];
        while let Some(node) = pending.pop() {
            let calls_it_directly = node.parent().is_some_and(|parent| {
                parent.kind() == "call_expression" && parent.child_by_field_name("function") == Some(node)
            });
            match node.kind() {
                "member_expression" if !calls_it_directly => {
                    let property = node.child_by_field_name("property").map(|held| self.text(held));
                    if property.is_some_and(crate::entry_exit::names_an_mcp_tool_registrar) {
                        return true;
                    }
                }
                "call_expression" => {
                    let forwarded = node.child_by_field_name("function").is_some_and(|function| {
                        function.kind() == "identifier" && self.tool_registrar_aliases.contains(self.text(function))
                    });
                    let named_by_a_parameter = node
                        .child_by_field_name("arguments")
                        .and_then(|arguments| arguments.named_child(0))
                        .is_some_and(|first| first.kind() == "identifier");
                    if forwarded && named_by_a_parameter {
                        return true;
                    }
                }
                _ => {}
            }
            let mut cursor = node.walk();
            pending.extend(node.named_children(&mut cursor));
        }
        false
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

    fn middleware_through(&self, children: &[Node], label_argument: Option<usize>) -> Vec<(usize, String)> {
        let carried: Vec<&Node> = children
            .iter()
            .filter(|argument| Some(argument.id()) != label_argument && argument.kind() != "string")
            .collect();
        if carried.len() < 2 {
            return Vec::new();
        }
        let guarding: Vec<(usize, String)> = carried
            .iter()
            .filter_map(|argument| {
                let written = match argument.kind() {
                    "call_expression" => self.text(argument.child_by_field_name("function")?),
                    "identifier" | "member_expression" => self.text(**argument),
                    _ => return None,
                };
                crate::entry_exit::guarding(written)?;
                Some((argument.id(), written.to_string()))
            })
            .collect();
        match guarding.len() < carried.len() {
            true => guarding,
            false => Vec::new(),
        }
    }

    fn callback_arguments(&mut self, arguments: Node, scope: &Scope, callee: &str, dispatches_mcp_tools: bool) {
        let mut cursor = arguments.walk();
        let children: Vec<Node> = arguments.named_children(&mut cursor).collect();
        let named_by_a_literal = children.iter().find(|argument| argument.kind() == "string");
        let registered_as_an_mcp_tool = self.speaks_the_mcp_sdk
            && matches!(crate::names::leaf(callee).to_ascii_lowercase().as_str(), "tool" | "registertool");
        let named_by_a_remembered_constant = (named_by_a_literal.is_none() && registered_as_an_mcp_tool).then(|| {
            children
                .iter()
                .find(|argument| argument.kind() == "identifier" && self.remembered.contains_key(self.text(**argument)))
        }).flatten();
        let label = named_by_a_literal
            .map(|argument| trim_quotes(self.text(*argument)).to_string())
            .or_else(|| named_by_a_remembered_constant.and_then(|argument| self.remembered.get(self.text(*argument)).cloned()))
            .or_else(|| self.property_holding(arguments).filter(|held| crate::rules::registrar_kind(callee, Some(held), false) != Some("http")));
        let label_argument_id = named_by_a_literal.or(named_by_a_remembered_constant).map(|argument| argument.id());
        self.declared_route_objects(callee, &children);

        let through = match label {
            Some(_) => self.middleware_through(&children, label_argument_id),
            None => Vec::new(),
        };
        let through_names: Vec<String> = through.iter().map(|(_, name)| name.clone()).collect();
        if let Some(label) = label.as_deref() {
            for argument in children.iter() {
                if !matches!(argument.kind(), "identifier" | "member_expression")
                    || Some(argument.id()) == label_argument_id
                    || self.option_bags.contains(self.text(*argument))
                    || through.iter().any(|(held, _)| *held == argument.id())
                {
                    continue;
                }
                self.facts.registrations.push(RegistrationFact {
                    file: self.file,
                    registrar: callee.to_string(),
                    label: label.to_string(),
                    handler: self.text_owned(*argument),
                    line: line_of(*argument),
                    through: through_names.clone(),
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
                decorators: through_names
                    .iter()
                    .map(|name| Decorator { name: name.clone(), arguments: Vec::new() })
                    .collect(),
                type_annotation: None,
                documentation: None,
                project: None,
            callback_of: Some(callee.to_string()),
                registration_label: label.clone(),
            });
            if let Some(owner) = scope.enclosing_callable.clone().or_else(|| scope.owner.clone()) {
                self.push_edge(&owner, &id, EdgeKind::Contains);
            }

            let mut inner = scope.child(Some(id.clone()), Some(id));
            inner.dispatches_mcp_tools = dispatches_mcp_tools;
            if let Some(body) = argument.child_by_field_name("body") {
                self.visit(body, &inner);
            }
            if let Some(parameters) = argument.child_by_field_name("parameters") {
                self.parameter_initializers(parameters, &inner);
            }
        }
    }

    fn loop_element(&mut self, node: Node, scope: &Scope) {
        if node.kind() != "for_in_statement" {
            return;
        }
        let (Some(left), Some(right)) = (node.child_by_field_name("left"), node.child_by_field_name("right")) else {
            return;
        };
        let over = node.child_by_field_name("operator").map(|held| self.text(held)).unwrap_or("");
        let name = self.text(left).trim();
        if over != "of" || left.kind() != "identifier" || name.is_empty() {
            return;
        }
        let expression = self.text(right).trim();
        if expression.is_empty() || expression.len() > 200 {
            return;
        }
        self.facts.locals.push(LocalBinding {
            file: self.file,
            unit: scope.enclosing_callable.clone().unwrap_or_default(),
            name: name.to_string(),
            element_of: Some(expression.to_string()),
            line: line_of(node),
            ..Default::default()
        });
    }

    fn prefix_option(&self, arguments: Node) -> Option<String> {
        let mut cursor = arguments.walk();
        for argument in arguments.named_children(&mut cursor) {
            if argument.kind() != "object" {
                continue;
            }
            let mut inner = argument.walk();
            for pair in argument.named_children(&mut inner) {
                let Some(key) = pair.child_by_field_name("key") else { continue };
                if trim_quotes(self.text(key)) != "prefix" {
                    continue;
                }
                let Some(value) = pair.child_by_field_name("value") else { continue };
                if value.kind() == "string" || (value.kind() == "template_string" && !self.text(value).contains("${")) {
                    return Some(trim_quotes(self.text(value)).to_string());
                }
            }
        }
        None
    }

    fn literal_arguments(&self, arguments: Node) -> Vec<String> {
        let mut cursor = arguments.walk();
        arguments
            .named_children(&mut cursor)
            .filter(|argument| {
                matches!(
                    argument.kind(),
                    "string"
                        | "template_string"
                        | "number"
                        | "identifier"
                        | "binary_expression"
                        | "object"
                        | "call_expression"
                        | "new_expression"
                )
            })
            .take(LITERAL_LIMIT)
            .flat_map(|argument| match argument.kind() {
                "object" => vec![self.addressed_in(argument), self.base_in(argument), self.channel_in(argument)],
                "identifier" => vec![self
                    .remembered
                    .get(self.text(argument))
                    .cloned()
                    .or_else(|| addressing::a_named_constant(self.text(argument).trim()))],
                "call_expression" | "new_expression" => vec![self.path_given_to(argument)],
                "binary_expression" => vec![self
                    .text_it_begins_with(argument)
                    .map(|begins| format!("{begins}${{}}"))
                    .or_else(|| self.concatenated(argument))],
                _ => vec![Some(trim_quotes(self.text(argument)).to_string())],
            })
            .flatten()
            .filter(|value| !value.is_empty() && value.len() <= TEXT_REMEMBERED)
            .collect()
    }

    fn read_path(&self, expression: Node, name: &str) -> Option<String> {
        if !matches!(expression.kind(), "member_expression" | "subscript_expression") {
            return None;
        }
        let text = self.text(expression).trim();
        let spoken = text.len() <= 120
            && text.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | '.' | '[' | ']' | '$' | '?' | '!'));
        (spoken && crate::names::root(text) != name).then(|| text.to_string())
    }

    fn reads_the_global_fetch(&self, expression: Node) -> bool {
        let expression = unwrap_value(expression);
        match expression.kind() {
            "identifier" => self.text(expression).trim() == crate::entry_exit::FETCH_FUNCTION,
            "member_expression" => {
                let object = expression.child_by_field_name("object").map(|held| self.text(held).trim());
                let property = expression.child_by_field_name("property").map(|held| self.text(held).trim());
                property == Some(crate::entry_exit::FETCH_FUNCTION) && matches!(object, Some("globalThis" | "window" | "self" | "global"))
            }
            "binary_expression" => {
                let operator = expression.child_by_field_name("operator").map(|held| self.text(held)).unwrap_or("");
                matches!(operator, "||" | "??")
                    && [expression.child_by_field_name("left"), expression.child_by_field_name("right")]
                        .into_iter()
                        .flatten()
                        .any(|operand| self.reads_the_global_fetch(operand))
            }
            _ => false,
        }
    }

    fn path_given_to(&self, call: Node) -> Option<String> {
        let arguments = call.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        let given = arguments
            .named_children(&mut cursor)
            .filter(|argument| matches!(argument.kind(), "string" | "template_string"))
            .map(|argument| trim_quotes(self.text(argument)).to_string())
            .find(|written| written.starts_with('/'));
        given.or_else(|| self.path_returned_by(call))
    }

    fn path_returned_by(&self, call: Node) -> Option<String> {
        let function = call.child_by_field_name("function")?;
        let named = match function.kind() {
            "identifier" => self.text(function),
            "member_expression" if self.text(function.child_by_field_name("object")?) == "this" => {
                self.text(function.child_by_field_name("property")?)
            }
            _ => return None,
        };
        let mut root = call;
        while let Some(parent) = root.parent() {
            root = parent;
        }
        self.returned_paths.get_or_init(|| self.paths_returned_in(root)).get(named).cloned()
    }

    fn paths_returned_in(&self, root: Node) -> rustc_hash::FxHashMap<String, String> {
        let mut found: rustc_hash::FxHashMap<String, String> = rustc_hash::FxHashMap::default();
        let mut pending = vec![root];
        while let Some(held) = pending.pop() {
            let named = match held.kind() {
                "method_definition" | "function_declaration" => held.child_by_field_name("name"),
                _ => None,
            };
            let returned = named.and_then(|name| {
                let body = held.child_by_field_name("body")?;
                let mut cursor = body.walk();
                let mut statements = body.named_children(&mut cursor);
                let only = statements.next().filter(|_| statements.next().is_none())?;
                let value = match only.kind() {
                    "return_statement" => only.named_child(0)?,
                    _ => return None,
                };
                let written = match value.kind() {
                    "template_string" | "string" => trim_quotes(self.text(value)).to_string(),
                    "binary_expression" => self.concatenated(value)?,
                    _ => return None,
                };
                Some((self.text(name).to_string(), written))
            });
            if let Some((name, written)) = returned.filter(|(_, written)| written.contains('/')) {
                found.entry(name).or_insert(written);
            }
            let mut cursor = held.walk();
            pending.extend(held.named_children(&mut cursor));
        }
        found
    }

    fn addressed_in(&self, object: Node) -> Option<String> {
        let mut cursor = object.walk();
        let pairs: Vec<Node> = object.named_children(&mut cursor).filter(|pair| pair.kind() == "pair").collect();
        let address = pairs.iter().find_map(|pair| {
            let key = trim_quotes(self.text(pair.child_by_field_name("key")?)).to_string();
            if !matches!(key.as_str(), "url" | "path" | "endpoint") {
                return None;
            }
            let value = pair.child_by_field_name("value")?;
            matches!(value.kind(), "string" | "template_string")
                .then(|| trim_quotes(self.text(value)).to_string())
                .filter(|written| written.starts_with('/'))
                .map(|written| format!("{key}={written}"))
        });
        address.or_else(|| {
            pairs.iter().find_map(|pair| {
                let key = trim_quotes(self.text(pair.child_by_field_name("key")?));
                let value = pair.child_by_field_name("value").filter(|value| value.kind() == "string")?;
                let verb = trim_quotes(self.text(value)).to_ascii_uppercase();
                (key == "method" && ASKED_METHODS.contains(&verb.as_str())).then(|| format!("method={verb}"))
            })
        })
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

static ASKED_METHODS: &[&str] = &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

fn quoted_after(text: &str, at: usize) -> Option<&str> {
    let rest = text[at..].trim_start();
    let quote = rest.chars().next().filter(|held| matches!(held, '\'' | '"' | '`'))?;
    let inner = &rest[1..];
    let end = inner.find(quote)?;
    Some(&inner[..end])
}

fn cli_dispatched_on(condition: &str, param: Option<&str>) -> Option<String> {
    if let Some(param) = param {
        let is_ident = |held: char| held.is_alphanumeric() || held == '_';
        for (at, _) in condition.match_indices(param) {
            let before_ok = condition[..at].chars().next_back().is_none_or(|held| !is_ident(held));
            let after_at = at + param.len();
            let after_ok = condition[after_at..].chars().next().is_none_or(|held| !is_ident(held));
            if !before_ok || !after_ok {
                continue;
            }
            let rest = condition[after_at..].trim_start();
            let Some(stripped) = rest.strip_prefix("===").or_else(|| rest.strip_prefix("==")) else {
                continue;
            };
            if let Some(label) = quoted_after(stripped, 0) {
                return Some(label.to_string());
            }
        }
    }
    for (at, _) in condition.match_indices("argv[") {
        let after = &condition[at + "argv[".len()..];
        let digits = after.chars().take_while(|held| held.is_ascii_digit()).count();
        if digits == 0 {
            continue;
        }
        let Some(rest) = after[digits..].strip_prefix(']') else { continue };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix("===").or_else(|| rest.strip_prefix("==")) else {
            continue;
        };
        if let Some(label) = quoted_after(rest, 0) {
            return Some(label.to_string());
        }
    }
    None
}

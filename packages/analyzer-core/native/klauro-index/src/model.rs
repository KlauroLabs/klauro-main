use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Module,
    Class,
    Interface,
    TypeAlias,
    Enum,
    Function,
    Method,
    Constructor,
    Getter,
    Setter,
    Property,
    Variable,
    Parameter,
    External,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Contains,
    HasField,
    HasMethod,
    Extends,
    Implements,
    Calls,
    Imports,
    Exports,
    Instantiates,
    References,
}

#[derive(Debug, Default, Serialize)]
pub struct Parameter {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_annotation: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct Signature {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<Parameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub type_parameters: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct Modifiers {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub exported: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default_export: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_async: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub generator: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_static: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub abstract_member: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub readonly: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub private_member: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub protected_member: bool,
}

impl Modifiers {
    pub fn is_default(&self) -> bool {
        !(self.exported
            || self.default_export
            || self.is_async
            || self.generator
            || self.is_static
            || self.abstract_member
            || self.readonly
            || self.optional
            || self.private_member
            || self.protected_member)
    }
}

#[derive(Debug, Serialize)]
pub struct DecoratorArgument {
    pub value: String,
    pub literal: bool,
}

#[derive(Debug, Serialize)]
pub struct Decorator {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<DecoratorArgument>,
}

#[derive(Debug, Serialize)]
pub struct Span {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Serialize)]
pub struct IndexNode {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub file: u32,
    pub span: Span,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<Signature>,
    #[serde(skip_serializing_if = "Modifiers::is_default")]
    pub modifiers: Modifiers,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub decorators: Vec<Decorator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IndexEdge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Serialize)]
pub struct ImportSpecifier {
    pub local: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub namespace: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default_import: bool,
}

#[derive(Debug, Serialize)]
pub struct ImportFact {
    pub file: u32,
    pub specifier: String,
    pub line: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub type_only: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<ImportSpecifier>,
}

#[derive(Debug, Serialize)]
pub struct ExportFact {
    pub file: u32,
    pub name: String,
    pub line: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default_export: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reexport_from: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct CallContext {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub in_try: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub in_catch: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub in_finally: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub awaited: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional_chained: bool,
    pub conditional_depth: u16,
    pub loop_depth: u16,
}

#[derive(Debug, Serialize)]
pub struct CallFact {
    pub file: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub callee: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
    pub line: u32,
    pub column: u32,
    pub argument_count: u16,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub constructs: bool,
    pub context: CallContext,
}

#[derive(Debug, Serialize)]
pub struct TypeReferenceFact {
    pub file: u32,
    pub source: String,
    pub name: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Serialize)]
pub struct LocalBinding {
    pub file: u32,
    pub unit: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constructed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_call: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegistrationFact {
    pub file: u32,
    pub registrar: String,
    pub label: String,
    pub handler: String,
    pub line: u32,
}

#[derive(Debug, Default, Serialize)]
pub struct UnitMetrics {
    pub branches: u16,
    pub loops: u16,
    pub returns: u16,
    pub awaits: u16,
    pub throws: Vec<String>,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct UnitMetricsEntry {
    pub unit: String,
    #[serde(flatten)]
    pub metrics: UnitMetrics,
}

#[derive(Debug, Default, Serialize)]
pub struct FileFacts {
    pub nodes: Vec<IndexNode>,
    pub edges: Vec<IndexEdge>,
    pub imports: Vec<ImportFact>,
    pub exports: Vec<ExportFact>,
    pub calls: Vec<CallFact>,
    pub type_references: Vec<TypeReferenceFact>,
    pub metrics: Vec<UnitMetricsEntry>,
    pub registrations: Vec<RegistrationFact>,
    pub locals: Vec<LocalBinding>,
    pub lines: u32,
    pub parse_errors: u32,
}

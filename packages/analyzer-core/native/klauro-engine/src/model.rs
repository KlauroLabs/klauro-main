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
    External,
}

impl NodeKind {
    pub fn is_type(self) -> bool {
        matches!(
            self,
            NodeKind::Class | NodeKind::Interface | NodeKind::TypeAlias | NodeKind::Enum
        )
    }

    pub fn is_unit(self) -> bool {
        matches!(
            self,
            NodeKind::Function
                | NodeKind::Method
                | NodeKind::Constructor
                | NodeKind::Getter
                | NodeKind::Setter
        )
    }

    pub fn is_declaration(self) -> bool {
        self.is_type() || self.is_unit()
    }
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
    Instantiates,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
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
    pub project: Option<String>,
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
    #[serde(skip_serializing_if = "is_zero")]
    pub conditional_depth: u16,
    #[serde(skip_serializing_if = "is_zero")]
    pub loop_depth: u16,
}

fn is_zero(value: &u16) -> bool {
    *value == 0
}

impl CallContext {
    fn is_empty(&self) -> bool {
        !self.in_try
            && !self.in_catch
            && !self.in_finally
            && !self.awaited
            && !self.optional_chained
            && self.conditional_depth == 0
            && self.loop_depth == 0
    }
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
    #[serde(skip_serializing_if = "is_zero")]
    pub argument_count: u16,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub literals: Vec<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub constructs: bool,
    #[serde(skip_serializing_if = "CallContext::is_empty")]
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
    #[serde(skip)]
    pub line: u32,
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
    #[serde(skip_serializing_if = "is_zero")]
    pub asserts: u16,
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

#[derive(Debug, Clone)]
pub struct Kept {
    pub file: u32,
    pub unit: String,
    pub place: String,
    pub writes: bool,
    pub line: u32,
}

#[derive(Debug, Serialize)]
pub struct SettingRead {
    pub file: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    pub name: String,
    pub line: u32,
}

static READ_FROM_THE_ENVIRONMENT: &[&str] = &[
    "$_ENV", "$_SERVER", "ENV", "Deno.env", "Environment", "import.meta.env", "os.environ", "process.env",
];

pub fn a_setting_read(target: &str) -> Option<&str> {
    let target = target.trim();
    let (holder, named) = match target.strip_suffix(']') {
        Some(indexed) => {
            let (holder, inner) = indexed.split_once('[')?;
            let inner = inner.trim();
            let quoted = inner.len() > 2
                && ['"', '\'', '`'].iter().any(|quote| inner.starts_with(*quote) && inner.ends_with(*quote));
            if !quoted {
                return None;
            }
            (holder.trim(), &inner[1..inner.len() - 1])
        }
        None => target.rsplit_once('.')?,
    };
    let named_plainly = !named.is_empty()
        && named.chars().all(|letter| letter.is_ascii_alphanumeric() || letter == '_');
    (named_plainly && READ_FROM_THE_ENVIRONMENT.contains(&holder)).then_some(named)
}

#[cfg(test)]
mod settings {
    use super::a_setting_read;

    #[test]
    fn a_setting_is_read_however_the_language_spells_the_environment() {
        assert_eq!(a_setting_read("process.env.STRIPE_KEY"), Some("STRIPE_KEY"));
        assert_eq!(a_setting_read("import.meta.env.VITE_API_URL"), Some("VITE_API_URL"));
        assert_eq!(a_setting_read("os.environ[\"DATABASE_URL\"]"), Some("DATABASE_URL"));
        assert_eq!(a_setting_read("ENV['REDIS_URL']"), Some("REDIS_URL"));
        assert_eq!(a_setting_read("process.env[name]"), None);
        assert_eq!(a_setting_read("process.env"), None);
        assert_eq!(a_setting_read("config.env.KEY"), None);
    }
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
    #[serde(skip)]
    pub tables: Vec<crate::tables::Table>,
    #[serde(skip)]
    pub kept: Vec<Kept>,
    #[serde(skip)]
    pub settings: Vec<SettingRead>,
    pub lines: u32,
    pub parse_errors: u32,
    pub namespace: Option<String>,
}

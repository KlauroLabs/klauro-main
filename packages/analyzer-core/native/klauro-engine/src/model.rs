use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
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

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Parameter {
    pub name: String,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub type_annotation: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub optional: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub default_value: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Signature {
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub parameters: Vec<Parameter>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub return_type: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub type_parameters: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub receiver: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Modifiers {
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub exported: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub default_export: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub is_async: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub generator: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub is_static: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub abstract_member: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub readonly: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub optional: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub private_member: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
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

#[derive(Debug, Serialize, Deserialize)]
pub struct DecoratorArgument {
    pub value: String,
    pub literal: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Decorator {
    pub name: String,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub arguments: Vec<DecoratorArgument>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Span {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexNode {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub file: u32,
    pub span: Span,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub signature: Option<Signature>,
    #[serde(skip_serializing_if = "crate::facts_cache::default_modifiers")]
    pub modifiers: Modifiers,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub decorators: Vec<Decorator>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub type_annotation: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub documentation: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub callback_of: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub registration_label: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    #[default]
    Structure,
    Name,
    Rule,
}

impl Via {
    pub fn is_structure(&self) -> bool {
        *self == Via::Structure
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexEdge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
    #[serde(default, skip_serializing_if = "Via::is_structure")]
    pub via: Via,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportSpecifier {
    pub local: String,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub imported: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub namespace: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub default_import: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportFact {
    pub file: u32,
    pub specifier: String,
    pub line: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub type_only: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub everywhere: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub names: Vec<ImportSpecifier>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportFact {
    pub file: u32,
    pub name: String,
    pub line: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub default_export: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub reexport_from: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CallContext {
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub in_try: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub in_catch: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub in_finally: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub awaited: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub optional_chained: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::zero")]
    pub conditional_depth: u16,
    #[serde(skip_serializing_if = "crate::facts_cache::zero")]
    pub loop_depth: u16,
}

impl CallContext {
    pub(crate) fn is_empty(&self) -> bool {
        !self.in_try
            && !self.in_catch
            && !self.in_finally
            && !self.awaited
            && !self.optional_chained
            && self.conditional_depth == 0
            && self.loop_depth == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallFact {
    pub file: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub caller: Option<String>,
    pub callee: String,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub receiver: Option<String>,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::zero")]
    pub argument_count: u16,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub literals: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::not")]
    pub constructs: bool,
    #[serde(default, skip_serializing_if = "crate::facts_cache::not")]
    pub renders: bool,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub type_arguments: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty_context")]
    pub context: CallContext,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub passes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TypeReferenceFact {
    pub file: u32,
    pub source: String,
    pub name: String,
    pub kind: EdgeKind,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub arguments: Vec<String>,
}

pub fn type_arguments(written: &str) -> Vec<String> {
    let Some(opened) = written.find('<') else { return Vec::new() };
    let Some(closed) = written.rfind('>') else { return Vec::new() };
    if closed <= opened {
        return Vec::new();
    }
    let mut depth = 0i32;
    let mut held = Vec::new();
    let mut from = opened + 1;
    for (at, letter) in written[opened + 1..closed].char_indices() {
        let at = at + opened + 1;
        match letter {
            '<' | '[' | '(' => depth += 1,
            '>' | ']' | ')' => depth -= 1,
            ',' if depth == 0 => {
                held.push(&written[from..at]);
                from = at + 1;
            }
            _ => {}
        }
    }
    held.push(&written[from..closed]);
    held.into_iter()
        .map(|argument| {
            let argument = argument.trim();
            let argument = argument.split('<').next().unwrap_or(argument).trim();
            crate::names::leaf(argument).trim_end_matches('?').to_string()
        })
        .filter(|argument| !argument.is_empty())
        .collect()
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LocalBinding {
    pub file: u32,
    pub unit: String,
    pub name: String,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub annotation: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub constructed: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub from_call: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub written: Option<String>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::none")]
    pub stands_for: Option<String>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub from_values: Vec<String>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub line: u32,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub slot: u8,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub element_of: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegistrationFact {
    pub file: u32,
    pub registrar: String,
    pub label: String,
    pub handler: String,
    pub line: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BundlerBuild {
    pub file: u32,
    pub entries: Vec<String>,
    pub output: String,
    pub output_is_dir: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UnitMetrics {
    pub branches: u16,
    #[serde(skip_serializing_if = "crate::facts_cache::zero")]
    pub asserts: u16,
    pub loops: u16,
    pub returns: u16,
    pub awaits: u16,
    pub throws: Vec<String>,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnitMetricsEntry {
    pub unit: String,
    #[serde(flatten)]
    pub metrics: UnitMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Kept {
    pub file: u32,
    pub unit: String,
    pub place: String,
    pub writes: bool,
    pub line: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SettingRead {
    pub file: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
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

#[derive(Debug, Default, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub tables: Vec<crate::tables::Table>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub kept: Vec<Kept>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub settings: Vec<SettingRead>,
    pub lines: u32,
    pub parse_errors: u32,
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub forwards: Vec<Forward>,
    #[serde(default, skip_serializing_if = "crate::facts_cache::hidden")]
    pub bundler_builds: Vec<BundlerBuild>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Forward {
    pub file: u32,
    pub name: String,
    pub original: String,
    pub from: String,
}

impl FileFacts {
    pub fn refile(&mut self, file: u32) {
        self.nodes.iter_mut().for_each(|held| held.file = file);
        self.imports.iter_mut().for_each(|held| held.file = file);
        self.exports.iter_mut().for_each(|held| held.file = file);
        self.calls.iter_mut().for_each(|held| held.file = file);
        self.type_references.iter_mut().for_each(|held| held.file = file);
        self.locals.iter_mut().for_each(|held| held.file = file);
        self.registrations.iter_mut().for_each(|held| held.file = file);
        self.kept.iter_mut().for_each(|held| held.file = file);
        self.settings.iter_mut().for_each(|held| held.file = file);
        self.tables.iter_mut().for_each(|held| held.file = file);
        self.forwards.iter_mut().for_each(|held| held.file = file);
        self.bundler_builds.iter_mut().for_each(|held| held.file = file);
    }
}

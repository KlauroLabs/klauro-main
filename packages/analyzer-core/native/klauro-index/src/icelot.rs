use std::collections::HashMap;

use serde::Serialize;

use crate::entry_exit::ExitPoint;
use crate::model::*;

#[derive(Debug, Default, Serialize)]
pub struct Input {
    pub parameters: u16,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct Constraints {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub throws: Vec<String>,
    pub guards: u16,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional_parameters: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct Effects {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub exits: Vec<String>,
    pub external_calls: u16,
}

#[derive(Debug, Default, Serialize)]
pub struct Logic {
    pub branches: u16,
    pub loops: u16,
    pub awaits: u16,
    pub complexity: u16,
    pub calls: u16,
}

#[derive(Debug, Default, Serialize)]
pub struct Output {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
    pub returns: u16,
}

#[derive(Debug, Serialize)]
pub struct TelemetrySite {
    pub kind: &'static str,
    pub callee: String,
    pub line: u32,
}

#[derive(Debug, Serialize)]
pub struct Icelot {
    pub unit: String,
    pub input: Input,
    pub constraints: Constraints,
    pub effects: Effects,
    pub logic: Logic,
    pub output: Output,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub telemetry: Vec<TelemetrySite>,
}

static LOG_OPERATIONS: &[&str] = &[
    "debug", "error", "fatal", "info", "log", "silly", "trace", "verbose", "warn",
];
static METRIC_OPERATIONS: &[&str] = &[
    "counter", "gauge", "histogram", "increment", "observe", "record", "summary", "timing",
];
static SPAN_OPERATIONS: &[&str] = &[
    "startActiveSpan", "startSpan", "withSpan",
];

fn telemetry_kind(receiver: Option<&str>, callee: &str) -> Option<&'static str> {
    if SPAN_OPERATIONS.binary_search(&callee).is_ok() {
        return Some("span");
    }
    if METRIC_OPERATIONS.binary_search(&callee).is_ok() {
        return Some("metric");
    }
    if LOG_OPERATIONS.binary_search(&callee).is_ok() {
        let receiver = receiver?;
        let lowered = receiver.to_ascii_lowercase();
        if lowered.contains("log") || lowered.contains("console") || lowered.contains("runtime") {
            return Some("log");
        }
        return None;
    }
    None
}

pub fn derive(
    nodes: &[IndexNode],
    metrics: &[UnitMetricsEntry],
    calls: &[CallFact],
    exits: &[ExitPoint],
    external: &HashMap<String, ()>,
) -> Vec<Icelot> {
    let by_unit: HashMap<&str, &UnitMetrics> = metrics
        .iter()
        .map(|entry| (entry.unit.as_str(), &entry.metrics))
        .collect();

    let mut call_counts: HashMap<&str, (u16, u16)> = HashMap::new();
    let mut telemetry: HashMap<&str, Vec<TelemetrySite>> = HashMap::new();
    for call in calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        let entry = call_counts.entry(caller).or_insert((0, 0));
        entry.0 = entry.0.saturating_add(1);
        if call.receiver.is_some() || external.contains_key(call.callee.as_str()) {
            entry.1 = entry.1.saturating_add(1);
        }
        if let Some(kind) = telemetry_kind(call.receiver.as_deref(), &call.callee) {
            telemetry.entry(caller).or_default().push(TelemetrySite {
                kind,
                callee: match call.receiver.as_deref() {
                    Some(receiver) => format!("{receiver}.{}", call.callee),
                    None => call.callee.clone(),
                },
                line: call.line,
            });
        }
    }

    let mut exits_by_unit: HashMap<&str, Vec<String>> = HashMap::new();
    for exit in exits {
        exits_by_unit
            .entry(exit.source.as_str())
            .or_default()
            .push(exit.id.clone());
    }

    let mut derived = Vec::new();
    for node in nodes {
        if !matches!(
            node.kind,
            NodeKind::Function
                | NodeKind::Method
                | NodeKind::Constructor
                | NodeKind::Getter
                | NodeKind::Setter
        ) {
            continue;
        }
        let unit = node.id.as_str();
        let metrics = by_unit.get(unit).copied();
        let signature = node.signature.as_ref();
        let (calls_made, external_calls) = call_counts.get(unit).copied().unwrap_or((0, 0));
        let branches = metrics.map(|m| m.branches).unwrap_or(0);
        let loops = metrics.map(|m| m.loops).unwrap_or(0);

        derived.push(Icelot {
            unit: node.id.clone(),
            input: Input {
                parameters: signature.map(|s| s.parameters.len() as u16).unwrap_or(0),
                types: signature
                    .map(|s| {
                        s.parameters
                            .iter()
                            .filter_map(|parameter| parameter.type_annotation.clone())
                            .collect()
                    })
                    .unwrap_or_default(),
                reads: metrics.map(|m| m.reads.clone()).unwrap_or_default(),
            },
            constraints: Constraints {
                throws: metrics.map(|m| m.throws.clone()).unwrap_or_default(),
                guards: branches,
                optional_parameters: signature
                    .is_some_and(|s| s.parameters.iter().any(|parameter| parameter.optional)),
            },
            effects: Effects {
                writes: metrics.map(|m| m.writes.clone()).unwrap_or_default(),
                exits: exits_by_unit.get(unit).cloned().unwrap_or_default(),
                external_calls,
            },
            logic: Logic {
                branches,
                loops,
                awaits: metrics.map(|m| m.awaits).unwrap_or(0),
                complexity: 1 + branches + loops,
                calls: calls_made,
            },
            output: Output {
                return_type: signature.and_then(|s| s.return_type.clone()),
                returns: metrics.map(|m| m.returns).unwrap_or(0),
            },
            telemetry: telemetry.remove(unit).unwrap_or_default(),
        });
    }
    derived
}

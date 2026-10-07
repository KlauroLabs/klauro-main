use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::{CallFact, EdgeKind, IndexEdge, LocalBinding};

static OUTPUTS: &str = include_str!("../data/program_outputs.tsv");

fn listed(how: &str) -> impl Iterator<Item = &'static str> + '_ {
    OUTPUTS.lines().filter_map(move |line| {
        let mut fields = line.split('\t');
        let (_, listed_how, value) = (fields.next()?, fields.next()?, fields.next()?);
        (listed_how == how).then_some(value)
    })
}

fn names_a_stream(text: &str) -> bool {
    listed("stream").any(|stream| text == stream || text.starts_with(&format!("{stream}(")) || text.starts_with(&format!("{stream}.")))
}

fn prints(call: &CallFact) -> bool {
    let spoken = match call.receiver.as_deref() {
        Some(receiver) => format!("{receiver}.{}", call.callee),
        None => call.callee.clone(),
    };
    listed("print").any(|print| spoken == print)
}

pub struct Sources<'a> {
    pub calls: &'a [CallFact],
    pub locals: &'a [LocalBinding],
    pub edges: &'a [IndexEdge],
    pub entry_points: &'a [EntryPoint],
}

pub fn written_to_standard_output(sources: &Sources) -> Vec<ExitPoint> {
    let mut next: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in sources.edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Calls | EdgeKind::Contains | EdgeKind::HasMethod)) {
        next.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
    }
    let mut commanded: HashSet<&str> = HashSet::default();
    let mut pending: Vec<&str> = sources
        .entry_points
        .iter()
        .filter(|entry| entry.kind == "cli" && !crate::unshipped::is_set_aside(entry.unshipped.as_ref()))
        .map(|entry| entry.handler.as_str())
        .collect();
    while let Some(current) = pending.pop() {
        if commanded.insert(current) {
            pending.extend(next.get(current).into_iter().flatten().copied().filter(|target| !commanded.contains(target)));
        }
    }
    let streams: HashSet<(&str, &str)> = sources
        .locals
        .iter()
        .filter(|local| local.from_call.as_deref().or(local.constructed.as_deref()).is_some_and(names_a_stream))
        .map(|local| (local.unit.as_str(), local.name.as_str()))
        .collect();
    sources
        .calls
        .iter()
        .filter_map(|call| {
            let caller = call.caller.as_deref()?;
            if !commanded.contains(caller) {
                return None;
            }
            let on_a_stream = call.receiver.as_deref().is_some_and(|receiver| {
                names_a_stream(receiver) || streams.contains(&(caller, crate::names::root(receiver)))
            }) && call.callee.starts_with("write");
            (on_a_stream || prints(call)).then(|| ExitPoint {
                id: format!("exit:{caller}:{}:output", call.line),
                kind: "output",
                name: "standard output".to_string(),
                source: caller.to_string(),
                target: "stdout".to_string(),
                operation: call.callee.clone(),
                file: call.file,
                line: call.line,
                awaited: false,
                addressed: None,
                service: None,
                method: None,
                origin: None,
                action: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_output_is_named_by_its_runtime() {
        assert!(names_a_stream("std::io::stdout()"));
        assert!(names_a_stream("std::io::stdout().lock"));
        assert!(names_a_stream("process.stdout"));
        assert!(!names_a_stream("process.stderr"));
        assert!(!names_a_stream("stdout_path"));
    }
}

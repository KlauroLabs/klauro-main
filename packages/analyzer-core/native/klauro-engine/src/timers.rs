use crate::entry_exit::EntryPoint;
use crate::model::CallFact;

static TABLE: &str = include_str!("../data/timer_waits.tsv");

fn waits(call: &CallFact) -> bool {
    let callee = call.callee.as_str();
    let (owner, member) = match callee.rsplit_once(['.', ':']) {
        Some((owner, member)) => (owner.trim_end_matches(':'), member),
        None => (call.receiver.as_deref().unwrap_or("-"), callee),
    };
    let owner = call.receiver.as_deref().unwrap_or(owner);
    TABLE.lines().filter_map(|line| line.split_once('\t')).any(|(receiver, members)| {
        let receiver_held = receiver == "-" || owner == receiver || owner.ends_with(&format!("::{receiver}")) || owner.ends_with(&format!(".{receiver}"));
        receiver_held && members.split(',').any(|held| held == member)
    })
}

pub fn recurring(entries: &mut [EntryPoint], calls: &[CallFact]) {
    let looping: rustc_hash::FxHashSet<&str> = calls
        .iter()
        .filter(|call| call.context.loop_depth > 0 && waits(call))
        .filter_map(|call| call.caller.as_deref())
        .collect();
    for entry in entries.iter_mut().filter(|entry| matches!(entry.kind, "background" | "lifecycle")) {
        if looping.contains(entry.handler.as_str()) {
            entry.kind = "schedule";
        }
    }
}

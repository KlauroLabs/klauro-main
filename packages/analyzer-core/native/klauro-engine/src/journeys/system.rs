use crate::entry_exit::ExitPoint;

const FORWARDER_STEPS: usize = 3;

pub(super) fn a_product_effect(exit: &ExitPoint, reads_only: bool) -> bool {
    match exit.kind {
        "database" | "message" => true,
        "process" => !reads_only,
        "file" | "network" | "api" => crate::comprehend::changes_something(exit),
        _ => false,
    }
}

pub(super) fn forwards_only(exits: &[&ExitPoint], steps: usize, crossings: usize) -> bool {
    crossings == 0
        && steps <= FORWARDER_STEPS
        && !exits.is_empty()
        && exits.iter().all(|exit| matches!(exit.kind, "api" | "network"))
}

pub(super) fn is_system(exits: &[&ExitPoint], steps: usize, crossings: usize, reads_only: bool) -> bool {
    forwards_only(exits, steps, crossings) || !exits.iter().any(|exit| a_product_effect(exit, reads_only))
}

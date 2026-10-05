use crate::author::Grounding;

pub const AI_UNANSWERED: &str = "ai-unanswered";

const NAME_RESOLVED_HOP: f64 = 0.5;
const RESOLUTION_SHARE: f64 = 0.5;
const COMPLETENESS_SHARE: f64 = 0.3;
const STANDING_SHARE: f64 = 0.2;
const CUT_FLOW: f64 = 0.85;
const GROUNDING_SHARE: f64 = 0.5;
const UNGRADED: f64 = 0.85;
const PARENT_ORIGINATED: f64 = 0.85;
const UNSETTLED: f64 = 0.5;
const NO_FLOW_EVIDENCE: f64 = 0.5;

pub struct Reach {
    pub hops: u32,
    pub by_name: u32,
    pub units: u32,
    pub open: u32,
    pub cut: bool,
    pub standing: &'static str,
}

pub struct Backing<'a> {
    pub grounding: Option<&'a Grounding>,
    pub flows: &'a [f64],
    pub parent_originated_alone: bool,
    pub unsettled: bool,
}

fn rounded(score: f64) -> f64 {
    (score.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

fn standing_weight(standing: &str) -> f64 {
    match standing {
        "terminal" => 1.0,
        "proximal" => 0.85,
        "reading" => 0.7,
        _ => 0.4,
    }
}

pub fn of_flow(reach: &Reach) -> f64 {
    let named = match reach.hops {
        0 => 0.0,
        hops => f64::from(reach.by_name) / f64::from(hops),
    };
    let resolution = 1.0 - (1.0 - NAME_RESOLVED_HOP) * named;
    let completeness = match reach.units + reach.open {
        0 => 1.0,
        total => f64::from(reach.units) / f64::from(total),
    };
    let score = RESOLUTION_SHARE * resolution
        + COMPLETENESS_SHARE * completeness
        + STANDING_SHARE * standing_weight(reach.standing);
    rounded(match reach.cut {
        true => score * CUT_FLOW,
        false => score,
    })
}

pub fn left_unsettled(score: f64) -> f64 {
    rounded(score * UNSETTLED)
}

pub fn of_capability(backing: &Backing) -> f64 {
    let flows = match backing.flows.is_empty() {
        true => NO_FLOW_EVIDENCE,
        false => backing.flows.iter().sum::<f64>() / backing.flows.len() as f64,
    };
    let mut score = match backing.grounding.filter(|grounding| grounding.graded) {
        Some(grounding) => GROUNDING_SHARE * grounding.confidence() + (1.0 - GROUNDING_SHARE) * flows,
        None => UNGRADED * flows,
    };
    if backing.parent_originated_alone {
        score *= PARENT_ORIGINATED;
    }
    match backing.unsettled {
        true => left_unsettled(score),
        false => rounded(score),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reach() -> Reach {
        Reach { hops: 10, by_name: 0, units: 11, open: 0, cut: false, standing: "terminal" }
    }

    fn grounding(supported: f64, invented: f64, graded: bool) -> Grounding {
        Grounding {
            supported,
            invented,
            specific: 1.0,
            outcome: supported,
            universal: None,
            mechanism: None,
            scope: None,
            hollow: None,
            graded,
        }
    }

    #[test]
    fn a_flow_resolved_wholly_by_structure_and_ending_in_a_change_is_certain() {
        assert_eq!(of_flow(&reach()), 1.0);
    }

    #[test]
    fn hops_resolved_by_name_lower_a_flow_in_proportion() {
        let some = of_flow(&Reach { by_name: 4, ..reach() });
        let all = of_flow(&Reach { by_name: 10, ..reach() });
        assert_eq!(some, 0.9);
        assert_eq!(all, 0.75);
    }

    #[test]
    fn open_ends_a_cut_and_a_weak_standing_each_lower_a_flow() {
        let open = of_flow(&Reach { open: 11, ..reach() });
        let cut = of_flow(&Reach { cut: true, ..reach() });
        let reading = of_flow(&Reach { standing: "open", ..reach() });
        assert_eq!(open, 0.85);
        assert_eq!(cut, 0.85);
        assert_eq!(reading, 0.88);
    }

    #[test]
    fn a_flow_with_no_hops_still_scores_from_what_it_holds() {
        let alone = of_flow(&Reach { hops: 0, units: 1, ..reach() });
        assert_eq!(alone, 1.0);
    }

    #[test]
    fn a_capability_blends_what_the_grounding_found_with_what_its_flows_resolved() {
        let held = grounding(1.0, 0.0, true);
        let score = of_capability(&Backing { grounding: Some(&held), flows: &[0.8, 1.0], parent_originated_alone: false, unsettled: false });
        assert_eq!(score, 0.95);
    }

    #[test]
    fn an_ungraded_capability_rests_on_its_flows_alone_and_is_capped() {
        let held = grounding(1.0, 0.0, false);
        let score = of_capability(&Backing { grounding: Some(&held), flows: &[1.0], parent_originated_alone: false, unsettled: false });
        assert_eq!(score, 0.85);
    }

    #[test]
    fn a_parent_originated_capability_with_no_child_behind_it_is_lowered() {
        let held = grounding(1.0, 0.0, true);
        let child_backed = of_capability(&Backing { grounding: Some(&held), flows: &[1.0], parent_originated_alone: false, unsettled: false });
        let alone = of_capability(&Backing { grounding: Some(&held), flows: &[1.0], parent_originated_alone: true, unsettled: false });
        assert_eq!(child_backed, 1.0);
        assert_eq!(alone, 0.85);
    }

    #[test]
    fn an_unsettled_capability_scores_half_of_what_it_would_have() {
        let score = of_capability(&Backing { grounding: None, flows: &[0.8], parent_originated_alone: false, unsettled: true });
        assert_eq!(score, 0.34);
    }

    #[test]
    fn a_capability_with_no_flow_evidence_scores_from_the_neutral_middle() {
        let none = of_capability(&Backing { grounding: None, flows: &[], parent_originated_alone: false, unsettled: false });
        let middle = of_capability(&Backing { grounding: None, flows: &[0.5], parent_originated_alone: false, unsettled: false });
        assert_eq!(none, middle);
    }
}

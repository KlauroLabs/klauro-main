use crate::author::Grounding;

pub const AI_UNANSWERED: &str = "ai-unanswered";

const NAME_RESOLVED_HOP: f64 = 0.35;
const OPEN_END_PENALTY: f64 = 2.0;
const MASS_HALF_AT: f64 = 6.0;
const MASS_FULL: f64 = 30.0;
const STORY_FULL_AT: f64 = 4.0;
const FLOW_SHARE: f64 = 0.2;
const CUT_FLOW: f64 = 0.8;
const GROUNDING_SHARE: f64 = 0.45;
const MEMBER_FLOWS_SHARE: f64 = 0.35;
const MEMBER_COUNT_SHARE: f64 = 0.2;
const MEMBER_COUNT_HALF_AT: f64 = 2.0;
const UNGRADED_GROUNDING: f64 = 0.5;
const UNGRADED_CEILING: f64 = 0.75;
const PARENT_ORIGINATED: f64 = 0.85;
const UNSETTLED: f64 = 0.5;
const NO_FLOW_EVIDENCE: f64 = 0.5;

pub struct Reach {
    pub hops: u32,
    pub by_name: u32,
    pub units: u32,
    pub open: u32,
    pub steps: u32,
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
        "proximal" => 0.8,
        "reading" => 0.55,
        _ => 0.3,
    }
}

fn saturating(amount: f64, half_at: f64) -> f64 {
    amount / (amount + half_at)
}

pub fn of_flow(reach: &Reach) -> f64 {
    let named = match reach.hops {
        0 => 0.0,
        hops => f64::from(reach.by_name) / f64::from(hops),
    };
    let resolution = 1.0 - (1.0 - NAME_RESOLVED_HOP) * named;
    let units = f64::from(reach.units);
    let open = f64::from(reach.open);
    let completeness = match reach.units + reach.open {
        0 => 1.0,
        _ => (1.0 - OPEN_END_PENALTY * open / (units + open)).max(0.0),
    };
    let mass = saturating(units, MASS_HALF_AT) / saturating(MASS_FULL, MASS_HALF_AT);
    let story = (f64::from(reach.steps) / STORY_FULL_AT).min(1.0);
    let score = FLOW_SHARE
        * (resolution + completeness + standing_weight(reach.standing) + mass.min(1.0) + story);
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
    let members = saturating(backing.flows.len() as f64, MEMBER_COUNT_HALF_AT);
    let graded = backing.grounding.filter(|grounding| grounding.graded);
    let grounding = graded.map_or(UNGRADED_GROUNDING, Grounding::confidence);
    let mut score = GROUNDING_SHARE * grounding + MEMBER_FLOWS_SHARE * flows + MEMBER_COUNT_SHARE * members;
    if graded.is_none() {
        score = score.min(UNGRADED_CEILING);
    }
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
        Reach { hops: 10, by_name: 0, units: 40, open: 0, steps: 5, cut: false, standing: "terminal" }
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

    fn backing<'a>(grounding: Option<&'a Grounding>, flows: &'a [f64]) -> Backing<'a> {
        Backing { grounding, flows, parent_originated_alone: false, unsettled: false }
    }

    #[test]
    fn a_flow_resolved_wholly_by_structure_read_deeply_and_ending_in_a_change_is_certain() {
        assert_eq!(of_flow(&reach()), 1.0);
    }

    #[test]
    fn hops_resolved_by_name_lower_a_flow_in_proportion() {
        let some = of_flow(&Reach { by_name: 4, ..reach() });
        let all = of_flow(&Reach { by_name: 10, ..reach() });
        assert_eq!(some, 0.95);
        assert_eq!(all, 0.87);
    }

    #[test]
    fn open_ends_a_cut_and_a_weak_standing_each_lower_a_flow() {
        let open = of_flow(&Reach { open: 40, ..reach() });
        let cut = of_flow(&Reach { cut: true, ..reach() });
        let weak = of_flow(&Reach { standing: "open", ..reach() });
        assert_eq!(open, 0.8);
        assert_eq!(cut, 0.8);
        assert_eq!(weak, 0.86);
    }

    #[test]
    fn open_ends_weigh_by_how_many_there_are_beside_what_was_reached() {
        let few = of_flow(&Reach { open: 2, ..reach() });
        let many = of_flow(&Reach { open: 20, ..reach() });
        assert!(few > many, "{few} {many}");
        assert!(few > 0.95 && many < 0.9, "{few} {many}");
    }

    #[test]
    fn a_flow_that_reached_almost_nothing_and_told_no_story_reads_far_below_a_well_read_one() {
        let thin = of_flow(&Reach { hops: 1, units: 2, steps: 0, standing: "reading", ..reach() });
        assert!(thin < 0.6, "{thin}");
        assert!(of_flow(&reach()) - thin > 0.35);
    }

    #[test]
    fn a_flow_with_no_hops_still_scores_from_what_it_holds() {
        let alone = of_flow(&Reach { hops: 0, units: 1, steps: 0, ..reach() });
        assert!(alone > 0.0 && alone < 0.8, "{alone}");
    }

    #[test]
    fn a_well_evidenced_capability_reads_high_and_a_thin_one_reads_low() {
        let strong = grounding(1.0, 0.0, true);
        let weak = grounding(0.4, 0.5, true);
        let well = of_capability(&backing(Some(&strong), &[0.9, 0.9, 0.9, 0.9]));
        let thin = of_capability(&backing(Some(&weak), &[0.55]));
        assert_eq!(well, 0.9);
        assert_eq!(thin, 0.54);
    }

    #[test]
    fn an_invented_capability_scores_below_a_supported_one_on_the_same_flows() {
        let supported = grounding(1.0, 0.0, true);
        let invented = grounding(0.5, 0.6, true);
        let flows = [0.9, 0.9];
        assert!(of_capability(&backing(Some(&supported), &flows)) > of_capability(&backing(Some(&invented), &flows)) + 0.1);
    }

    #[test]
    fn more_member_flows_raise_a_capability() {
        let held = grounding(1.0, 0.0, true);
        assert!(of_capability(&backing(Some(&held), &[0.9; 6])) > of_capability(&backing(Some(&held), &[0.9])));
    }

    #[test]
    fn an_ungraded_capability_rests_on_its_flows_and_is_capped() {
        let held = grounding(1.0, 0.0, false);
        let score = of_capability(&backing(Some(&held), &[1.0; 100]));
        assert_eq!(score, 0.75);
    }

    #[test]
    fn a_parent_originated_capability_with_no_child_behind_it_is_lowered() {
        let held = grounding(1.0, 0.0, true);
        let flows = [1.0; 8];
        let child_backed = of_capability(&backing(Some(&held), &flows));
        let alone = of_capability(&Backing { parent_originated_alone: true, ..backing(Some(&held), &flows) });
        assert_eq!(child_backed, 0.96);
        assert_eq!(alone, 0.82);
    }

    #[test]
    fn an_unsettled_capability_scores_half_of_what_it_would_have() {
        let settled = of_capability(&backing(None, &[0.8]));
        let unsettled = of_capability(&Backing { unsettled: true, ..backing(None, &[0.8]) });
        assert!((unsettled - settled * 0.5).abs() < 0.011, "{unsettled} {settled}");
    }

    #[test]
    fn a_capability_with_no_flow_evidence_scores_from_the_neutral_middle() {
        let none = of_capability(&backing(None, &[]));
        let one_neutral = of_capability(&backing(None, &[0.5]));
        assert!((one_neutral - none - MEMBER_COUNT_SHARE * saturating(1.0, MEMBER_COUNT_HALF_AT)).abs() < 0.011);
    }
}

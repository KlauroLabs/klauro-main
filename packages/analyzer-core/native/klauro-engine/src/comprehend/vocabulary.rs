use std::collections::BTreeSet;

use rustc_hash::FxHashMap as HashMap;

use super::{Capability, Entity, Flow, PROVISIONAL};
use crate::model::{IndexNode, NodeKind};

const LEAST_TOKEN_LENGTH: usize = 3;
const EVIDENCE_SHOWN: usize = 1500;

pub struct Vocabulary {
    identifiers: BTreeSet<String>,
    domain: BTreeSet<String>,
}

fn tokens_of(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut previous: Option<char> = None;
    for letter in text.chars() {
        let breaks = !letter.is_alphanumeric()
            || (letter.is_uppercase() && previous.is_some_and(|before| before.is_lowercase() || before.is_ascii_digit()));
        if breaks && !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
        if letter.is_alphanumeric() {
            current.push(letter.to_ascii_lowercase());
        }
        previous = Some(letter);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
        .into_iter()
        .map(|token| crate::capabilities::name_key(&token))
        .filter(|token| token.chars().count() >= LEAST_TOKEN_LENGTH)
        .collect()
}

fn is_a_type_name(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
}

impl Vocabulary {
    pub fn of(nodes: &[IndexNode], entities: &[Entity], flows: &[Flow], frameworks: &[String]) -> Vocabulary {
        let mut identifiers: BTreeSet<String> = frameworks.iter().flat_map(|named| tokens_of(named)).collect();
        for node in nodes.iter().filter(|node| node.kind == NodeKind::External) {
            if let Some(package) = node.type_annotation.as_deref() {
                identifiers.extend(tokens_of(package));
            }
            if is_a_type_name(&node.name) {
                identifiers.extend(tokens_of(&node.name));
            }
        }
        let mut domain: BTreeSet<String> = BTreeSet::new();
        for entity in entities {
            domain.extend(tokens_of(&entity.declared_as));
            domain.extend(entity.named_fields.iter().flat_map(|field| tokens_of(&field.name)));
        }
        let node_at: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
        for flow in flows {
            domain.extend(flow.writes.iter().chain(flow.reads.iter()).flat_map(|record| tokens_of(record)));
            let answered = flow
                .path
                .first()
                .and_then(|step| node_at.get(step.unit.as_str()))
                .and_then(|node| node.signature.as_ref())
                .and_then(|signature| signature.return_type.as_deref());
            domain.extend(answered.into_iter().flat_map(tokens_of));
        }
        Vocabulary { identifiers, domain }
    }

    pub fn mechanism_in(&self, name: &str) -> Vec<String> {
        let mut found: Vec<String> = tokens_of(name)
            .into_iter()
            .filter(|token| self.identifiers.contains(token) && !self.domain.contains(token))
            .collect();
        found.sort();
        found.dedup();
        found
    }
}

pub fn keep_readable(capabilities: &mut [Capability], vocabulary: &Vocabulary, spoken: &str) {
    let failing: Vec<(usize, Vec<String>)> = capabilities
        .iter()
        .enumerate()
        .map(|(at, capability)| (at, vocabulary.mechanism_in(capability.name.as_deref().unwrap_or_default())))
        .filter(|(_, mechanism)| !mechanism.is_empty())
        .collect();
    if failing.is_empty() {
        return;
    }
    let told: Vec<(String, String)> = failing
        .iter()
        .map(|(at, mechanism)| {
            let capability = &capabilities[*at];
            (
                capability.id.clone(),
                format!(
                    "  it is called: {}\n  what someone gets: {}\n  words to leave out of the name: {}\n  what it delivers:\n{}",
                    capability.name.as_deref().unwrap_or_default(),
                    capability.description.as_deref().unwrap_or_default(),
                    mechanism.join(", "),
                    capability.evidence.chars().take(EVIDENCE_SHOWN).collect::<String>()
                ),
            )
        })
        .collect();
    let named = crate::memory::each("renamed", spoken, &told, |missing| {
        crate::author::name_the_outcome(spoken, missing)
            .into_iter()
            .map(|renamed| (renamed.id, (renamed.name.trim().to_string(), renamed.description.trim().to_string())))
            .collect()
    });
    for (at, _) in failing {
        let capability = &mut capabilities[at];
        let answered = named.get(&capability.id).cloned();
        if let Some((name, description)) = &answered {
            capability.id = format!("capability:{}", super::carved_name(name));
            capability.name = Some(name.clone());
            if !description.is_empty() {
                capability.description = Some(description.clone());
            }
        }
        if !vocabulary.mechanism_in(capability.name.as_deref().unwrap_or_default()).is_empty() {
            capability.standing = PROVISIONAL;
            if answered.is_none() && crate::author::asked() {
                capability.unsettled = Some(crate::confidence::AI_UNANSWERED);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocabulary(identifiers: &[&str], domain: &[&str]) -> Vocabulary {
        Vocabulary {
            identifiers: identifiers.iter().flat_map(|held| tokens_of(held)).collect(),
            domain: domain.iter().flat_map(|held| tokens_of(held)).collect(),
        }
    }

    #[test]
    fn a_token_only_among_the_identifiers_is_mechanism_under_the_audience_test_of_section_0_7_1() {
        let held = vocabulary(&["WebAuthn", "kafka-client"], &["Order", "Customer"]);
        assert_eq!(held.mechanism_in("Authenticate with WebAuthn"), vec!["authn", "web"]);
        assert_eq!(held.mechanism_in("Sync via Kafka"), vec!["kafka"]);
    }

    #[test]
    fn a_token_that_is_also_domain_vocabulary_is_purpose_not_mechanism() {
        let held = vocabulary(&["messages", "order-client"], &["Order", "Message"]);
        assert!(held.mechanism_in("Place an order").is_empty());
        assert!(held.mechanism_in("Send a message").is_empty());
    }

    #[test]
    fn words_in_neither_vocabulary_pass_without_any_word_list() {
        let held = vocabulary(&["react"], &["Order"]);
        assert!(held.mechanism_in("Track a delivery").is_empty());
    }

    #[test]
    fn a_name_still_carrying_mechanism_words_is_provisional_but_never_marked_unanswered_when_nothing_was_asked() {
        let held = vocabulary(&["telemetry"], &["Order"]);
        let mut capability = super::super::tests::capability_of(&["flow:a"]);
        capability.name = Some("Emit telemetry".to_string());
        let mut capabilities = vec![capability];
        keep_readable(&mut capabilities, &held, "a system");
        assert_eq!(capabilities[0].standing, PROVISIONAL);
        assert_eq!(capabilities[0].unsettled, None);
    }

    #[test]
    fn camel_case_and_separators_split_into_tokens() {
        assert_eq!(tokens_of("OrderLineItem_ids"), vec!["order", "line", "item", "ids"]);
    }
}

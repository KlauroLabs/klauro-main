mod common;

#[test]
fn a_token_reports_its_guards_its_standard_and_its_external_call_ordering() {
    let index = common::read("security/token");
    let mut facts: Vec<&str> = index["security"].as_array().unwrap().iter().map(|fact| fact["fact"].as_str().unwrap()).collect();
    facts.sort();
    assert_eq!(
        facts,
        vec![
            "access-control:inherits:SecureToken",
            "access-control:onlyOwner:mint",
            "access-control:onlyOwner:transferOwnership",
            "erc20-conformance",
            "external-call-before-state-write:riskyWithdraw",
            "external-call-before-state-write:withdraw",
            "reentrancy-guard:withdraw",
        ]
    );
}

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::OnceLock;

use serde::Serialize;
use tree_sitter::Node;

static TABLE: &str = include_str!("../data/solidity_security.tsv");

struct Library {
    lists: BTreeMap<&'static str, BTreeSet<&'static str>>,
    standards: Vec<(&'static str, Vec<&'static str>)>,
}

fn library() -> &'static Library {
    static HELD: OnceLock<Library> = OnceLock::new();
    HELD.get_or_init(|| {
        let mut lists: BTreeMap<&'static str, BTreeSet<&'static str>> = BTreeMap::new();
        let mut standards = Vec::new();
        for row in TABLE.lines().filter(|row| !row.trim().is_empty()) {
            let cells: Vec<&'static str> = row.split('\t').collect();
            match cells.as_slice() {
                ["standard", name, required] => standards.push((*name, required.split(',').collect())),
                [role, names] => lists.entry(*role).or_default().extend(names.split(',')),
                _ => {}
            }
        }
        Library { lists, standards }
    })
}

fn listed(role: &str, name: &str) -> bool {
    library().lists.get(role).is_some_and(|names| names.contains(name))
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct SecurityFact {
    pub fact: String,
    pub kind: &'static str,
    pub contract: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
    pub file: u32,
    pub line: u32,
    pub end_line: u32,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mechanism: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_variable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_call_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_write_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected: Option<bool>,
}

struct Call {
    member: String,
    line: u32,
    checked: bool,
}

struct Write {
    variable: String,
    line: u32,
}

struct Function {
    name: String,
    line: u32,
    end_line: u32,
    modifiers: Vec<String>,
    calls: Vec<Call>,
    writes: Vec<Write>,
    sender_checked: bool,
}

struct Contract {
    name: String,
    line: u32,
    end_line: u32,
    bases: Vec<String>,
    functions: Vec<Function>,
}

struct Modifier {
    guards_access: bool,
    locks: bool,
}

fn text<'s>(node: Node, source: &'s [u8]) -> &'s str {
    std::str::from_utf8(&source[node.start_byte()..node.end_byte()]).unwrap_or("")
}

fn first_identifier<'s>(node: Node, source: &'s [u8]) -> Option<&'s str> {
    if node.kind() == "identifier" {
        return Some(text(node, source));
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor).find_map(|child| first_identifier(child, source))
}

fn the_sender(node: Node, source: &[u8]) -> bool {
    let held = text(node, source).replace(' ', "");
    matches!(held.as_str(), "msg.sender" | "_msgSender()" | "tx.origin")
}

fn compares_the_sender(node: Node, source: &[u8]) -> bool {
    if node.kind() == "binary_expression" {
        let operator = node.child_by_field_name("operator").map(|held| text(held, source)).unwrap_or("");
        if matches!(operator, "==" | "!=") {
            let sides = [node.child_by_field_name("left"), node.child_by_field_name("right")];
            if sides.iter().flatten().any(|side| the_sender(*side, source)) {
                return true;
            }
        }
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor).any(|child| compares_the_sender(child, source))
}

fn asks_a_role_check(node: Node, source: &[u8]) -> bool {
    if node.kind() == "call_expression"
        && let Some(function) = node.child_by_field_name("function")
    {
        let callee = text(function, source);
        let callee = callee.rsplit('.').next().unwrap_or(callee);
        if listed("access_check", callee) {
            return true;
        }
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor).any(|child| asks_a_role_check(child, source))
}

fn is_a_condition_check(node: Node, source: &[u8]) -> bool {
    match node.kind() {
        "if_statement" => node.child_by_field_name("condition").is_some_and(|held| rejects_the_sender(held, source)),
        "call_expression" => {
            let callee = node.child_by_field_name("function").map(|held| text(held, source)).unwrap_or("");
            matches!(callee, "require" | "assert") && rejects_the_sender(node, source)
        }
        _ => false,
    }
}

fn rejects_the_sender(node: Node, source: &[u8]) -> bool {
    compares_the_sender(node, source) || asks_a_role_check(node, source)
}

fn contains_check(node: Node, source: &[u8]) -> bool {
    is_a_condition_check(node, source) || {
        let mut cursor = node.walk();
        node.named_children(&mut cursor).any(|child| contains_check(child, source))
    }
}

fn the_root_variable<'s>(node: Node, source: &'s [u8]) -> Option<&'s str> {
    match node.kind() {
        "identifier" => Some(text(node, source)),
        "expression" | "array_access" | "member_expression" | "parenthesized_expression" => {
            let held = node.child_by_field_name("base").or_else(|| node.child_by_field_name("object")).or_else(|| node.named_child(0))?;
            the_root_variable(held, source)
        }
        _ => None,
    }
}

fn the_member_chain_ends_in<'s>(node: Node, source: &'s [u8]) -> Option<&'s str> {
    match node.kind() {
        "member_expression" => node.child_by_field_name("property").map(|held| text(held, source)),
        "expression" | "parenthesized_expression" | "struct_expression" => {
            let inner = node.child_by_field_name("type").or_else(|| node.named_child(0))?;
            the_member_chain_ends_in(inner, source)
        }
        _ => None,
    }
}

fn the_checked_names(node: Node, source: &[u8], names: &mut BTreeSet<String>, after: usize) {
    if node.start_byte() >= after && node.kind() == "identifier" {
        names.insert(text(node, source).to_string());
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        the_checked_names(child, source, names, after);
    }
}

struct Walk<'a> {
    source: &'a [u8],
    state: &'a BTreeSet<String>,
    calls: Vec<Call>,
    writes: Vec<Write>,
    sender_checked: bool,
}

impl Walk<'_> {
    fn line(node: Node) -> u32 {
        node.start_position().row as u32 + 1
    }

    fn visit(&mut self, node: Node, body: Node) {
        match node.kind() {
            "call_expression" => {
                if let Some(function) = node.child_by_field_name("function")
                    && let Some(member) = the_member_chain_ends_in(function, self.source)
                    && listed("external_call", member)
                {
                    let discarded = Self::discarded(node);
                    let checked = !listed("low_level_call", member) || !discarded && self.tuple_checked(node, body);
                    self.calls.push(Call { member: member.to_string(), line: Self::line(node), checked });
                }
            }
            "assignment_expression" | "augmented_assignment_expression" => {
                if let Some(left) = node.child_by_field_name("left")
                    && let Some(root) = the_root_variable(left, self.source)
                    && self.state.contains(root)
                {
                    self.writes.push(Write { variable: root.to_string(), line: Self::line(node) });
                }
            }
            _ => {}
        }
        if is_a_condition_check(node, self.source) {
            self.sender_checked = true;
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.visit(child, body);
        }
    }

    fn discarded(call: Node) -> bool {
        let mut held = call.parent();
        while let Some(parent) = held {
            match parent.kind() {
                "expression" => held = parent.parent(),
                "expression_statement" => return true,
                _ => return false,
            }
        }
        false
    }

    fn tuple_checked(&self, call: Node, body: Node) -> bool {
        let mut held = call.parent();
        while let Some(parent) = held {
            if parent.kind() == "variable_declaration_statement" {
                let Some(tuple) = parent.named_child(0).filter(|first| first.kind() == "variable_declaration_tuple") else {
                    return true;
                };
                let Some(first) = tuple.named_child(0) else { return true };
                let Some(name) = first_identifier(first, self.source) else { return true };
                let mut used = BTreeSet::new();
                the_checked_names(body, self.source, &mut used, parent.end_byte());
                return used.contains(name);
            }
            if matches!(parent.kind(), "statement" | "function_body") {
                return true;
            }
            held = parent.parent();
        }
        true
    }
}

fn function_of(node: Node, source: &[u8], state: &BTreeSet<String>) -> Option<Function> {
    let name = text(node.child_by_field_name("name")?, source).to_string();
    let mut modifiers = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "modifier_invocation"
            && let Some(held) = first_identifier(child, source)
        {
            modifiers.push(held.to_string());
        }
    }
    let mut walk = Walk { source, state, calls: Vec::new(), writes: Vec::new(), sender_checked: false };
    if let Some(body) = node.child_by_field_name("body") {
        walk.visit(body, body);
    }
    Some(Function {
        name,
        line: node.start_position().row as u32 + 1,
        end_line: node.end_position().row as u32 + 1,
        modifiers,
        calls: walk.calls,
        writes: walk.writes,
        sender_checked: walk.sender_checked,
    })
}

fn state_variables(body: Node, source: &[u8]) -> BTreeSet<String> {
    let mut held = BTreeSet::new();
    let mut cursor = body.walk();
    for child in body.named_children(&mut cursor) {
        if child.kind() == "state_variable_declaration"
            && let Some(name) = child.child_by_field_name("name")
        {
            held.insert(text(name, source).to_string());
        }
    }
    held
}

fn locks(body: Node, source: &[u8], state: &BTreeSet<String>) -> bool {
    let mut cursor = body.walk();
    let statements: Vec<Node> = body.named_children(&mut cursor).collect();
    let Some(placeholder) = statements.iter().position(|statement| text(*statement, source).trim() == "_;") else {
        return false;
    };
    let written = |statement: &Node| -> Option<String> {
        let mut found = None;
        let mut stack = vec![*statement];
        while let Some(node) = stack.pop() {
            if matches!(node.kind(), "assignment_expression" | "augmented_assignment_expression")
                && let Some(root) = node.child_by_field_name("left").and_then(|left| the_root_variable(left, source))
                && state.contains(root)
            {
                found = Some(root.to_string());
            }
            let mut inner = node.walk();
            stack.extend(node.named_children(&mut inner));
        }
        found
    };
    let before: BTreeSet<String> = statements[..placeholder].iter().filter_map(written).collect();
    statements[placeholder + 1..].iter().filter_map(written).any(|variable| before.contains(&variable))
}

fn modifier_of(node: Node, source: &[u8], state: &BTreeSet<String>) -> Option<(String, Modifier)> {
    let name = text(node.child_by_field_name("name")?, source).to_string();
    let body = node.child_by_field_name("body");
    Some((
        name,
        Modifier {
            guards_access: body.is_some_and(|held| contains_check(held, source)),
            locks: body.is_some_and(|held| locks(held, source, state)),
        },
    ))
}

fn the_line_of(node: Node) -> (u32, u32) {
    (node.start_position().row as u32 + 1, node.end_position().row as u32 + 1)
}

struct Parsed {
    file: u32,
    contracts: Vec<Contract>,
    modifiers: Vec<(String, Modifier)>,
}

fn parse(source: &[u8], file: u32) -> Option<Parsed> {
    let (language, _) = crate::language::language_for("solidity")?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let mut contracts = Vec::new();
    let mut modifiers = Vec::new();
    let mut cursor = root.walk();
    for declaration in root.named_children(&mut cursor) {
        if declaration.kind() != "contract_declaration" {
            continue;
        }
        let Some(name) = declaration.child_by_field_name("name") else { continue };
        let mut bases = Vec::new();
        let mut inner = declaration.walk();
        for child in declaration.named_children(&mut inner) {
            if child.kind() == "inheritance_specifier"
                && let Some(base) = first_identifier(child, source)
            {
                bases.push(base.to_string());
            }
        }
        let mut functions = Vec::new();
        if let Some(body) = declaration.child_by_field_name("body") {
            let state = state_variables(body, source);
            let mut members = body.walk();
            for member in body.named_children(&mut members) {
                match member.kind() {
                    "function_definition" => functions.extend(function_of(member, source, &state)),
                    "modifier_definition" => modifiers.extend(modifier_of(member, source, &state)),
                    _ => {}
                }
            }
        }
        let (line, end_line) = the_line_of(declaration);
        contracts.push(Contract { name: text(name, source).to_string(), line, end_line, bases, functions });
    }
    Some(Parsed { file, contracts, modifiers })
}

pub fn derive(root: &Path, paths: &[String]) -> Vec<SecurityFact> {
    let mut parsed = Vec::new();
    for (file, path) in paths.iter().enumerate() {
        if !path.to_ascii_lowercase().ends_with(".sol") || crate::paths::is_test(path) {
            continue;
        }
        let Some(source) = crate::paths::read_inside(root, path) else { continue };
        parsed.extend(parse(source.as_bytes(), file as u32));
    }
    let modifiers: BTreeMap<&str, &Modifier> =
        parsed.iter().flat_map(|held| held.modifiers.iter().map(|(name, modifier)| (name.as_str(), modifier))).collect();
    let access = |name: &str| modifiers.get(name).map_or_else(|| listed("access_modifier", name), |held| held.guards_access);
    let guard = |name: &str| modifiers.get(name).map_or_else(|| listed("reentrancy_modifier", name), |held| held.locks);

    let mut facts = Vec::new();
    for held in &parsed {
        for contract in &held.contracts {
            facts.extend(facts_of(contract, held.file, &access, &guard));
        }
    }
    facts
}

fn facts_of(contract: &Contract, file: u32, access: &dyn Fn(&str) -> bool, guard: &dyn Fn(&str) -> bool) -> Vec<SecurityFact> {
    let mut facts = Vec::new();
    let of_function = |function: &Function, fact: String, kind: &'static str, description: String| SecurityFact {
        fact,
        kind,
        contract: contract.name.clone(),
        function: Some(function.name.clone()),
        file,
        line: function.line,
        end_line: function.end_line,
        description,
        ..SecurityFact::default()
    };
    let of_contract = |fact: String, kind: &'static str, description: String| SecurityFact {
        fact,
        kind,
        contract: contract.name.clone(),
        function: None,
        file,
        line: contract.line,
        end_line: contract.end_line,
        description,
        ..SecurityFact::default()
    };

    for function in &contract.functions {
        for modifier in function.modifiers.iter().filter(|name| access(name)) {
            facts.push(SecurityFact {
                guard: Some(modifier.clone()),
                mechanism: Some("modifier"),
                ..of_function(
                    function,
                    format!("access-control:{modifier}:{}", function.name),
                    "access-control",
                    format!("Function {}.{} is gated by {modifier} (access control)", contract.name, function.name),
                )
            });
        }
        if function.sender_checked && !function.modifiers.iter().any(|name| access(name)) && !function.writes.is_empty() {
            facts.push(SecurityFact {
                mechanism: Some("sender check"),
                ..of_function(
                    function,
                    format!("access-control:sender-check:{}", function.name),
                    "access-control",
                    format!("Function {}.{} checks who is calling before it writes state (access control)", contract.name, function.name),
                )
            });
        }
    }

    if let Some(base) = contract.bases.iter().find(|base| listed("access_base", base)) {
        facts.push(SecurityFact {
            mechanism: Some("inheritance"),
            guard: Some(base.clone()),
            ..of_contract(
                format!("access-control:inherits:{}", contract.name),
                "access-control",
                format!("Contract {} inherits {base} (access control via inheritance)", contract.name),
            )
        });
    }

    for function in &contract.functions {
        if let Some(modifier) = function.modifiers.iter().find(|name| guard(name)) {
            facts.push(SecurityFact {
                guard: Some(modifier.clone()),
                mechanism: Some("modifier"),
                ..of_function(
                    function,
                    format!("reentrancy-guard:{}", function.name),
                    "reentrancy-guard",
                    format!("Function {}.{} is guarded against reentrancy by {modifier}", contract.name, function.name),
                )
            });
        }
    }

    let names: BTreeSet<&str> = contract.functions.iter().map(|function| function.name.as_str()).collect();
    for (standard, required) in &library().standards {
        if required.iter().all(|name| names.contains(name)) {
            facts.push(of_contract(
                format!("{}-conformance", standard.to_ascii_lowercase()),
                "erc-conformance",
                format!("Contract {} implements the full {standard} function set", contract.name),
            ));
        }
    }

    for function in &contract.functions {
        let Some(first) = function.calls.iter().map(|call| call.line).min() else { continue };
        let Some(write) = function.writes.iter().filter(|write| write.line > first).min_by_key(|write| write.line) else { continue };
        facts.push(SecurityFact {
            state_variable: Some(write.variable.clone()),
            external_call_line: Some(first),
            state_write_line: Some(write.line),
            protected: Some(function.modifiers.iter().any(|name| guard(name))),
            ..of_function(
                function,
                format!("external-call-before-state-write:{}", function.name),
                "cei-violation",
                format!(
                    "Function {}.{} makes an external call (line {first}) then writes state variable \"{}\" afterward (line {}) -- checks-effects-interactions violation, reentrancy risk",
                    contract.name, function.name, write.variable, write.line
                ),
            )
        });
    }

    for function in &contract.functions {
        if let Some(call) = function.calls.iter().find(|call| !call.checked) {
            facts.push(SecurityFact {
                external_call_line: Some(call.line),
                ..of_function(
                    function,
                    format!("unchecked-external-call:{}", function.name),
                    "unchecked-call",
                    format!(
                        "Function {}.{} makes a low-level {} call (line {}) and never checks whether it succeeded",
                        contract.name, function.name, call.member, call.line
                    ),
                )
            });
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts_in(source: &str) -> Vec<String> {
        let parsed = parse(source.as_bytes(), 0).expect("solidity parses");
        let modifiers: BTreeMap<&str, &Modifier> =
            parsed.modifiers.iter().map(|(name, modifier)| (name.as_str(), modifier)).collect();
        let access = |name: &str| modifiers.get(name).map_or_else(|| listed("access_modifier", name), |held| held.guards_access);
        let guard = |name: &str| modifiers.get(name).map_or_else(|| listed("reentrancy_modifier", name), |held| held.locks);
        let mut facts: Vec<String> =
            parsed.contracts.iter().flat_map(|contract| facts_of(contract, 0, &access, &guard)).map(|fact| fact.fact).collect();
        facts.sort();
        facts.dedup();
        facts
    }

    const TOKEN: &str = r#"
contract SecureToken is Ownable, ReentrancyGuard {
    mapping(address => uint256) private _balances;
    uint256 private _totalSupply;
    function totalSupply() public view returns (uint256) { return _totalSupply; }
    function balanceOf(address a) public view returns (uint256) { return _balances[a]; }
    function transfer(address to, uint256 amount) public returns (bool) { _balances[to] += amount; return true; }
    function approve(address s, uint256 amount) public returns (bool) { return true; }
    function transferFrom(address f, address to, uint256 amount) public returns (bool) { _balances[to] += amount; return true; }
    function allowance(address o, address s) public view returns (uint256) { return 0; }
    function withdraw(uint256 amount) external nonReentrant {
        require(_balances[msg.sender] >= amount, "insufficient balance");
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "transfer failed");
        _balances[msg.sender] -= amount;
    }
    function mint(address to, uint256 amount) public onlyOwner {
        _totalSupply += amount;
        _balances[to] += amount;
    }
    function riskyWithdraw(uint256 amount) external {
        require(_balances[msg.sender] >= amount, "insufficient balance");
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "transfer failed");
        _balances[msg.sender] -= amount;
    }
}
"#;

    #[test]
    fn a_token_names_its_guards_its_standard_and_its_unsafe_ordering() {
        assert_eq!(
            facts_in(TOKEN),
            vec![
                "access-control:inherits:SecureToken",
                "access-control:onlyOwner:mint",
                "erc20-conformance",
                "external-call-before-state-write:riskyWithdraw",
                "external-call-before-state-write:withdraw",
                "reentrancy-guard:withdraw",
            ]
        );
    }

    #[test]
    fn a_modifier_defined_here_guards_by_what_its_body_does() {
        let held = facts_in(
            r#"
contract Vault {
    address owner;
    uint256 locked;
    uint256 total;
    modifier restricted() { require(msg.sender == owner, "no"); _; }
    modifier lock() { locked = 1; _; locked = 0; }
    modifier notEmpty() { require(total > 0); _; }
    function drain() external restricted lock { total = 0; }
    function peek() external notEmpty { total = total; }
}
"#,
        );
        assert_eq!(held, vec!["access-control:restricted:drain", "reentrancy-guard:drain"]);
    }

    #[test]
    fn a_discarded_low_level_call_is_unchecked_and_a_tested_one_is_not() {
        let held = facts_in(
            r#"
contract Pay {
    function loose(address to) external { to.call{value: 1}(""); }
    function tight(address to) external { (bool ok, ) = to.call{value: 1}(""); require(ok); }
    function forgotten(address to) external { (bool ok, ) = to.call{value: 1}(""); }
}
"#,
        );
        assert_eq!(held, vec!["unchecked-external-call:forgotten", "unchecked-external-call:loose"]);
    }

    #[test]
    fn a_balance_requirement_naming_the_sender_is_not_access_control() {
        let held = facts_in("contract A { uint256 total; function f() external { require(total >= 1); total = 2; } }");
        assert!(held.is_empty());
    }
}

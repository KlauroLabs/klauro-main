import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { SoliditySecurityAnalyzer } from './security-analyzer';

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../../../apps/mcp-server/fixtures/security-facts/erc20-ownable'
);

test('SoliditySecurityAnalyzer: emits the exact security-fact set against the erc20-ownable fixture', async () => {
  const analyzer = new SoliditySecurityAnalyzer();
  assert.equal(await analyzer.canAnalyze(FIXTURE_DIR), true, 'canAnalyze should detect the .sol file');

  const contribution = await analyzer.analyze({ projectPath: FIXTURE_DIR });
  const factNames = contribution.nodes.filter(n => n.type === 'security-fact').map(n => n.name).sort();

  const truth = await fs.readJson(path.join(FIXTURE_DIR, 'truth.json'));
  assert.deepEqual(factNames, [...truth.true_facts].sort(), 'emitted security-fact ids must exactly match truth.json');
});

test('SoliditySecurityAnalyzer: detects onlyOwner access-control and nonReentrant guard on an inline snippet', async () => {
  const analyzer = new SoliditySecurityAnalyzer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'solsec-unit-'));
  try {
    const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Simple is Ownable {
    mapping(address => uint256) private balances;

    function setAdmin(address a) public onlyOwner {
        balances[a] = 0;
    }

    function withdraw(uint256 amount) external nonReentrant {
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "failed");
        balances[msg.sender] -= amount;
    }
}
`;
    await fs.writeFile(path.join(tmpDir, 'Simple.sol'), source, 'utf-8');
    const contribution = await analyzer.analyze({ projectPath: tmpDir });
    const factNames = contribution.nodes.filter(n => n.type === 'security-fact').map(n => n.name).sort();

    assert.ok(factNames.includes('access-control:onlyOwner:setAdmin'), 'must detect onlyOwner-gated function');
    assert.ok(factNames.includes('access-control:inherits:Simple'), 'must detect Ownable inheritance');
    assert.ok(factNames.includes('reentrancy-guard:withdraw'), 'must detect nonReentrant-gated function');
    assert.ok(factNames.includes('external-call-before-state-write:withdraw'), 'must detect the CEI violation ordering');
    // No ERC20 function set declared in this snippet -> no conformance fact.
    assert.ok(!factNames.includes('erc20-conformance'), 'must NOT claim ERC20 conformance without the full function set');
  } finally {
    await fs.remove(tmpDir);
  }
});

test('SoliditySecurityAnalyzer: does not flag a safe CEI-ordered function (state write before external call)', async () => {
  const analyzer = new SoliditySecurityAnalyzer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'solsec-unit-safe-'));
  try {
    const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Safe {
    mapping(address => uint256) private balances;

    function withdraw(uint256 amount) external {
        balances[msg.sender] -= amount;
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "failed");
    }
}
`;
    await fs.writeFile(path.join(tmpDir, 'Safe.sol'), source, 'utf-8');
    const contribution = await analyzer.analyze({ projectPath: tmpDir });
    const factNames = contribution.nodes.filter(n => n.type === 'security-fact').map(n => n.name);

    assert.ok(
      !factNames.some(n => n.startsWith('external-call-before-state-write')),
      'must NOT flag a function that writes state BEFORE the external call (correct CEI ordering)'
    );
  } finally {
    await fs.remove(tmpDir);
  }
});

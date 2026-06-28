import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SolidityAnalyzer } from './solidity-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidity-analyzer-test-'));

  // IERC20.sol: an interface that Token imports.
  const iface = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.0;',
    '',
    'interface IERC20 {',
    '    function transfer(address to, uint256 amt) external returns (bool);',
    '}',
    '',
    'abstract contract ERC20 is IERC20 {',
    '    mapping(address => uint256) public balanceOf;',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'IERC20.sol'), iface);

  // Token.sol: contract Token is ERC20, imports IERC20.
  const token = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.0;',
    '',
    'import {IERC20} from "./IERC20.sol";',
    '',
    'contract Token is ERC20 {',
    '    uint256 public totalSupply;',
    '    event Transfer(address indexed from, address indexed to, uint256 amt);',
    '',
    '    constructor() {',
    '        totalSupply = 0;',
    '    }',
    '',
    '    function transfer(address to, uint256 amt) public returns (bool) {',
    '        _move(msg.sender, to, amt);',
    '        emit Transfer(msg.sender, to, amt);',
    '        return true;',
    '    }',
    '',
    '    function _move(address from, address to, uint256 amt) internal {',
    '        balanceOf[from] -= amt;',
    '        balanceOf[to] += amt;',
    '    }',
    '',
    '    function withdraw(address payable who) external {',
    '        who.transfer(1 ether);',
    '    }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'Token.sol'), token);

  return dir;
}

test('SolidityAnalyzer extracts contracts, functions, inheritance, imports, calls, entry points', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new SolidityAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true with .sol files');

    const cas = await analyzer.analyze({ projectPath: dir });
    const nodes = cas.nodes || [];
    const edges = cas.edges || [];
    const entryPoints = cas.entry_points || [];

    // Contract + interface nodes (both emitted as 'class').
    const classNodes = nodes.filter(n => n.type === 'class');
    const names = classNodes.map(n => n.name);
    assert.ok(names.includes('Token'), 'Token contract node present');
    assert.ok(names.includes('IERC20'), 'IERC20 interface node present');
    assert.ok(names.includes('ERC20'), 'ERC20 abstract contract node present');

    const ierc20 = classNodes.find(n => n.name === 'IERC20');
    assert.equal(ierc20?.metadata?.attributes?.kind, 'interface', 'IERC20 kind is interface');

    // Function nodes for transfer / _move / constructor.
    const fnNodes = nodes.filter(n => n.type === 'method' || n.type === 'function');
    const fnNames = fnNodes.map(n => n.name);
    assert.ok(fnNames.includes('transfer'), 'transfer function node present');
    assert.ok(fnNames.includes('_move'), '_move function node present');
    assert.ok(fnNames.includes('constructor'), 'constructor node present');

    // Inheritance edge Token -> ERC20.
    const tokenNode = classNodes.find(n => n.name === 'Token')!;
    const erc20Node = classNodes.find(n => n.name === 'ERC20')!;
    const inheritEdge = edges.find(e =>
      e.type === 'inherits' && e.source === tokenNode.id && e.target === erc20Node.id
    );
    assert.ok(inheritEdge, 'inheritance edge Token -> ERC20 present');

    // Import edge Token.sol -> IERC20.sol.
    const importEdge = edges.find(e => e.type === 'imports');
    assert.ok(importEdge, 'import edge present');

    // Calls edge transfer -> _move.
    const transferNode = fnNodes.find(n => n.name === 'transfer' && n.metadata?.attributes?.contract === 'Token')!;
    const moveNode = fnNodes.find(n => n.name === '_move')!;
    const callEdge = edges.find(e =>
      e.type === 'calls' && e.source === transferNode.id && e.target === moveNode.id
    );
    assert.ok(callEdge, 'calls edge transfer -> _move present');

    // transfer marked as an entry point (public).
    const transferEntry = entryPoints.find(ep => ep.source_node === transferNode.id);
    assert.ok(transferEntry, 'transfer is an entry point');

    // external call .transfer() in withdraw -> exit point.
    const exitPoints = cas.exit_points || [];
    assert.ok(exitPoints.some(xp => /transfer/.test(xp.name)), 'external transfer exit point present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

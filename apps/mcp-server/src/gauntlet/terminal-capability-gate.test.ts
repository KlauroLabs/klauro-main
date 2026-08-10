/**
 * Terminal-capability-absorption gate — validated on GENERIC, synthetic
 * fixtures only (never real corpus/client names — see spec-purity-gate.ts).
 *
 * The fixture shapes below mirror, in structure only, a real pair of
 * analyzed repos checked in a live session (a company-tree subject with
 * several repos): one support/identity-shaped leaf service whose own
 * capability list legitimately includes account/auth management, and one
 * product-purpose leaf service (a finance/trading domain) that consumes the
 * identity service's message/command contract (26 verbatim-shared declared
 * type names) and whose own capability list contains zero identity/auth-
 * shaped entries BY HAND-INSPECTION of the full capability list.
 *
 * IMPORTANT, HONEST CAVEAT: running this module's directional heuristic
 * against the REAL pair's full capability/entity data (not the trimmed
 * fixtures below) did NOT cleanly reproduce that hand-checked result — it
 * flagged BOTH repos as substrate and returned a vacuous empty-composed-list
 * pass, because the compact `get_summary`/`product_map.capabilities[].entities`
 * shape does not reliably list every type a capability *produces* (e.g. an
 * emitted event), only what it primarily queries/manages, which breaks the
 * anchored-vs-referenced-only asymmetry this heuristic depends on. See the
 * findings doc for the full real-data run and the resulting limitation this
 * exposed. The fixtures below are deliberately clean synthetic stand-ins
 * (complete, non-noisy entity anchoring) that exercise the intended logic
 * correctly and deterministically in CI — they demonstrate the algorithm is
 * right in principle, not that it is robust to real-world data noise yet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findSubstrateRepoIds,
  composeParentCapabilities,
  runTerminalCapabilityGate,
  type RepoCapabilityFacts,
} from './terminal-capability-gate';

function identityShapedLeaf(): RepoCapabilityFacts {
  return {
    repoId: 'fixture-identity-leaf',
    capabilities: [
      { name: 'Register and manage user identities', category: 'core', entities: ['UserLoggedInMessage', 'RegisterUserCommand'] },
      { name: 'Authenticate and authorize users', category: 'core', entities: ['ValidateApiTokenQuery'] },
      { name: 'Manage user security settings', category: 'supporting', entities: [] },
      { name: 'Manage user tokens', category: 'supporting', entities: ['PersonalInfoUpdateMessage'] },
    ],
    declaredTypeNames: [
      'UserLoggedInMessage',
      'RegisterUserCommand',
      'ValidateApiTokenQuery',
      'PersonalInfoUpdateMessage',
    ],
  };
}

function productShapedLeaf(): RepoCapabilityFacts {
  return {
    repoId: 'fixture-product-leaf',
    capabilities: [
      { name: 'Manage portfolio positions', category: 'core', entities: ['PortfolioPosition'] },
      { name: 'Execute crypto trades', category: 'core', entities: ['TradeOrder'] },
      { name: 'Sync custodial account balances', category: 'core', entities: [] },
      // Domain-specific "user intents" (a trade/transfer intent, not an
      // account concept) — deliberately included to prove the shape check
      // does not false-positive on the bare word "user".
      { name: 'Manage user intents', category: 'supporting', entities: [] },
    ],
    // Verbatim overlap with the identity leaf's declared types == the
    // structural evidence of a consumed wire contract (this repo depends
    // on the identity repo): it DECLARES these types (e.g. as DTOs to call
    // out with / messages to subscribe to) but none of ITS OWN capabilities
    // anchor to them — it only references, never manages, the identity
    // repo's contract. That asymmetry is what makes the identity repo
    // non-terminal and this repo terminal.
    declaredTypeNames: [
      'UserLoggedInMessage',
      'ValidateApiTokenQuery',
      'PersonalInfoUpdateMessage',
      'PortfolioPosition',
      'TradeOrder',
    ],
  };
}

function unrelatedIsolatedLeaf(): RepoCapabilityFacts {
  return {
    repoId: 'fixture-isolated-leaf',
    capabilities: [{ name: 'Generate KYC compliance reports', category: 'supporting', entities: ['ComplianceReport'] }],
    declaredTypeNames: ['ComplianceReport'], // no overlap with anything
  };
}

test('substrate detection: identity-shaped leaf is flagged non-terminal when its types are consumed elsewhere', () => {
  const repos = [identityShapedLeaf(), productShapedLeaf()];
  const substrate = findSubstrateRepoIds(repos);
  assert.equal(substrate.has('fixture-identity-leaf'), true);
  assert.equal(substrate.has('fixture-product-leaf'), false);
});

test('an isolated leaf with no overlap is terminal, not substrate', () => {
  const repos = [identityShapedLeaf(), productShapedLeaf(), unrelatedIsolatedLeaf()];
  const substrate = findSubstrateRepoIds(repos);
  assert.equal(substrate.has('fixture-isolated-leaf'), false);
});

test('composed parent capabilities exclude the substrate leaf entirely', () => {
  const repos = [identityShapedLeaf(), productShapedLeaf()];
  const composed = composeParentCapabilities(repos);
  assert.ok(composed.every(c => c.fromRepoId !== 'fixture-identity-leaf'));
  assert.ok(composed.some(c => c.fromRepoId === 'fixture-product-leaf'));
  assert.equal(composed.length, productShapedLeaf().capabilities.length);
});

test('gate PASSES: leaf may legitimately show "manage users", composed parent must not', () => {
  const identity = identityShapedLeaf();
  // Sanity check on the scenario itself, mirroring the owner's example
  // exactly: the leaf's OWN capability list legitimately contains user
  // management. This is acceptable at leaf scope.
  assert.ok(identity.capabilities.some(c => /manage user identities/i.test(c.name)));

  const result = runTerminalCapabilityGate([identity, productShapedLeaf()]);
  assert.equal(result.pass, true);
  assert.deepEqual(result.violations, []);
  assert.ok(result.substrateRepoIds.includes('fixture-identity-leaf'));
  assert.ok(result.terminalRepoIds.includes('fixture-product-leaf'));
  // The composed list must contain product-purpose capabilities...
  assert.ok(result.composedCapabilities.some(c => /crypto trades/i.test(c.name)));
  // ...and must not contain the word-level false positive: "user intents"
  // is a financial workflow trigger, not an account/identity capability,
  // and must survive composition unflagged.
  assert.ok(result.composedCapabilities.some(c => c.name === 'Manage user intents'));
});

test('gate FAILS hard when an identity-shaped capability has no substrate cover (no dependency evidence)', () => {
  // If nothing depends on the identity leaf's contract (no other repo
  // references its anchoring types), it is NOT classified substrate, so its
  // own capabilities legitimately survive composition — and since one of
  // those capabilities is identity/auth-shaped, the gate must fail. This
  // proves the gate is not vacuously green: it only absorbs a leaf when
  // there is real directional dependency evidence, never by default.
  const result = runTerminalCapabilityGate([identityShapedLeaf(), unrelatedIsolatedLeaf()]);
  assert.equal(result.pass, false);
  assert.ok(result.violations.length > 0);
  assert.ok(result.violations[0].includes('fixture-identity-leaf'));
});

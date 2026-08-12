import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

const corpus: Array<{ repo: string; capabilities: any[] }> =
  require('../fixtures/production-capability-corpus.json');

// systemCapabilityProductPriority is the SORT KEY for the capability list a
// customer reads, and it had no characterization at all — so its behaviour could
// change with nothing going red. Recorded here from the real 215-capability
// corpus: every capability whose priority is not the default 3, by name.
//
// Its literals are a per-repo tuning table (~65 phrases drawn from a scheduling
// product, a commerce product, a docs product, an analytics product, a healthcare
// product, a fleet product, Klauro itself, a trading product, and specific ML
// model names). Measured: 14 of 215 capabilities are boosted to top priority by a
// literal, across 10 repositories. Replacing that with evidence is #149; this
// baseline exists so the replacement is visible per capability instead of being a
// silent reordering of what the customer sees first.
// The fixture stores evidence as COUNTS (ops, ents), so a capability must be
// materialized into the shape production passes before its priority means
// anything. My first version of this file read the raw fixture objects, where
// operations/related_entities are undefined — so it characterized a code path
// production never takes. Same class as the other measurement bugs this session:
// the tool was wrong, and it looked green.
const materialize = (capability: any) => ({
  name: capability.name,
  category: capability.category,
  description_source: capability.description_source,
  description: capability.desc || '',
  criticality: capability.criticality,
  operations: Array.from({ length: capability.ops }, (_, index) => ({ name: `op${index}` })),
  related_entities: Array.from({ length: capability.ents }, (_, index) => `ent${index}`),
  related_domains: capability.domains || [],
});

describe('capability priority characterization', () => {
  const orch = new (AnalyzerOrchestrator as any)() as any;

  const BASELINE: Record<string, Record<string, number>> = {
      "Klauro Proof Of Concept": {
            "Provide Agent Context": 0
      },
      "OpenClaw Node (Android) (internal)": {
            "Manage Session and Device Data": 6
      },
      "OpenClaw macOS app (dev + signing)": {
            "Manage Session": 6
      },
      "WashUp": {
            "Track and manage car wash equipment": 0
      },
      "app": {
            "Manages codebase analysis and revisions": 0
      },
      "backend": {
            "Manage and track inventory and warehouse": 0,
            "Manage and track location and address information": 0,
            "Manage customer and user information": 6,
            "Track and manage deliveries": 0
      },
      "klauro-self": {
            "Tracks incremental analysis": 0
      },
      "openclaw": {
            "Manages fleet operations": 0,
            "Manages vehicle maintenance": 0,
            "Provides driver communication": 0
      },
      "soon": {
            "Manages market data and trade execution": 0,
            "Manages user identity and access": 6,
            "Manages user portfolios and holdings": 6,
            "Manages user settings and preferences": 6,
            "Tracks and optimizes portfolio performance": 1
      },
      "soon-bos": {
            "Manages billing recovery": 2
      },
      "soon-lens": {
            "Manages exchange and market data": 1,
            "Manages market data and trade execution": 0,
            "Manages user portfolios and holdings": 6,
            "Manages user settings and preferences": 6,
            "Manages user subscriptions and payments": 6,
            "Provides portfolio performance and analysis": 1
      },
      "soon-link": {
            "Manages Solana trading and portfolio automation": 1,
            "Manages user automation and adapters": 6,
            "Manages user credentials and consent": 6,
            "Manages user deposits and withdrawals": 6,
            "Manages user positions and balances": 6,
            "Manages user transactions and orders": 6,
            "Tracks market data and trade execution": 0
      },
      "soon-sync": {
            "Manages user accounts": 6,
            "Manages user activity": 6,
            "Manages user connections": 6,
            "Manages user portfolios": 6,
            "Manages user subscriptions": 6
      },
      "soon-ui": {
            "Automate portfolio management": 1,
            "Manage portfolio": 1,
            "Manage user profile": 6,
            "Monitor portfolio performance": 1,
            "Verify user identity": 6
      },
      "spring-petclinic-microservices": {
            "Exposes pet clinic data through API": 5
      },
      "truckspy": {
            "Manage user profiles and authentication": 6
      },
      "v2": {
            "Manage API keys": 5,
            "Manage user accounts": 6,
            "Secure user authentication": 6,
            "Track and manage feed counters": 0
      }
};

  it('assigns the recorded priority to every non-default capability', () => {
    const actual: Record<string, Record<string, number>> = {};
    for (const repo of corpus) {
      for (const capability of repo.capabilities) {
        const priority = orch.systemCapabilityProductPriority(materialize(capability));
        if (priority !== 3) {
          actual[repo.repo] = actual[repo.repo] || {};
          actual[repo.repo][capability.name] = priority;
        }
      }
    }
    expect(actual).toEqual(BASELINE);
  });

  it.failing('does not demote a capability merely for naming its user', () => {
    // isCrossCuttingCapabilityName matches the bare word `user`, so ANY name
    // mentioning one lands at 6 — second-worst. "Manages user accounts" is a real
    // outcome a real person gets. Asserted as it.failing: this is the defect, and
    // the day the vocabulary goes, this test turns green and says so.
    const demoted = Object.values(BASELINE)
      .flatMap(byName => Object.entries(byName))
      .filter(([name, priority]) => priority === 6 && /\buser\b/i.test(name));
    expect(demoted).toEqual([]);
  });
});

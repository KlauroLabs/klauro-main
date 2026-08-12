import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

const corpus: Array<{ repo: string; capabilities: any[] }> =
  require('../fixtures/production-capability-corpus.json');

// systemCapabilityProductPriority is the SORT KEY for the capability list a
// customer reads first, and it had no characterization at all — so its behaviour
// could change with nothing going red. Recorded here from the real 215-capability
// corpus: every capability whose priority is not the default 3, by name.
//
// MEASURED SCALE: 69 of 215 capabilities (32%) receive a non-default priority and
// effectively all of it comes from vocabulary rather than evidence:
//   24 demoted to 6  — isCrossCuttingCapabilityName, which matches the word `user`
//   26 at 1          — the portfolio/trading token sets
//   14 at 0 (top)    — the ~65 product-phrase tables (a scheduling product, a
//                      commerce product, a docs product, an analytics product, a
//                      healthcare product, a fleet product, Klauro itself, a
//                      trading product, and specific ML model names)
//    2 at 2, 3 at 5  — the billing and demo/framework word sets
// On a customer repo none of those phrases match, so ranking collapses to the
// constant 3. Replacing this with evidence is #149; the baseline exists so that
// replacement is visible per capability instead of silently reordering what the
// customer sees first.
//
// The fixture stores evidence as COUNTS (ops, ents), so a capability must be
// materialized into the shape production passes before its priority means
// anything. The first version of this file read raw fixture objects, where
// operations/related_entities are undefined, and so characterized a path
// production never takes.
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
    "Sundered World - Simulation Server": {
      "Manage game economy": 1
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
      "Process invoices and payments": 2,
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
      "Analyzes and optimizes trading strategies": 1,
      "Manages market data and trade execution": 0,
      "Manages user identity and access": 6,
      "Manages user portfolios and holdings": 6,
      "Manages user settings and preferences": 6,
      "Provides backtesting and stress testing": 1,
      "Provides market intelligence and insights": 1,
      "Provides risk analysis and hedging": 1,
      "Surfaces predictive metrics and analysis": 1,
      "Tracks and optimizes portfolio performance": 1
    },
    "soon-bos": {
      "Manages billing recovery": 2
    },
    "soon-lens": {
      "Manages exchange and market data": 1,
      "Manages market data and trade execution": 0,
      "Manages risk and security": 1,
      "Manages user portfolios and holdings": 6,
      "Manages user settings and preferences": 6,
      "Manages user subscriptions and payments": 6,
      "Provides analysis and insights": 1,
      "Provides portfolio performance and analysis": 1,
      "Provides technical indicators and analysis": 1,
      "Provides usage and analytics": 1
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
      "Executes trades": 1,
      "Manages user accounts": 6,
      "Manages user activity": 6,
      "Manages user connections": 6,
      "Manages user portfolios": 6,
      "Manages user subscriptions": 6,
      "Provides market metrics": 1
    },
    "soon-ui": {
      "Automate portfolio management": 1,
      "Execute trades": 1,
      "Manage portfolio": 1,
      "Manage risk": 1,
      "Manage user profile": 6,
      "Monitor portfolio performance": 1,
      "Set up automation rules": 1,
      "Verify user identity": 6,
      "View decision log": 1,
      "View market data": 1
    },
    "spring-petclinic-microservices": {
      "Exposes pet clinic data through API": 5
    },
    "truckspy": {
      "Manage api tokens and customer profiles": 1,
      "Manage company and customer data": 5,
      "Manage devices and vehicle profiles": 1,
      "Manage user profiles and authentication": 6
    },
    "v2": {
      "Manage API keys": 5,
      "Manage user accounts": 6,
      "Secure user authentication": 6,
      "Track and manage feed counters": 0
    }
  };

describe('capability priority characterization', () => {
  const orch = new (AnalyzerOrchestrator as any)() as any;

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
    // mentioning one lands at 6 — second-worst of six. "Manages user accounts" is
    // a real outcome a real person gets. Asserted as failing because it IS the
    // defect: the day the vocabulary goes, this turns green and says so.
    const demoted = Object.values(BASELINE)
      .flatMap(byName => Object.entries(byName))
      .filter(([name, priority]) => priority === 6 && /\buser\b/i.test(name));
    expect(demoted).toEqual([]);
  });
});

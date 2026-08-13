import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

const corpus: Array<{ repo: string; capabilities: any[] }> =
  require('../fixtures/production-capability-corpus.json');

// systemCapabilityProductPriority is the SORT KEY for the capability list a
// customer reads first. It used to rank by matching ~65 literal phrases drawn from
// other people's repositories; it now ranks by the capability's own evidence.
//
// The fixture stores evidence as COUNTS (ops, ents), so a capability must be
// materialized into the shape production passes before its priority means
// anything — an earlier version of this file read raw fixture objects, where
// operations/related_entities are undefined, and characterized a path production
// never takes.
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
    "0bb67916fc886363fde41eed": {
      "Quantity Management": 1
    },
    "Hoggan Scientific": {
      "Evaluate Evaluator": 0,
      "Manage Evaluator": 2,
      "Manage Patient Data": 0,
      "Manage Standard Muscles": 2,
      "Update Norm Values": 0
    },
    "Klauro Proof Of Concept": {
      "Analyze Codebase Architecture": 0,
      "Detect Code Patterns": 0,
      "Plan Greenfield Projects": 2
    },
    "OpenClaw Node (Android) (internal)": {
      "Capture and Display Images": 2,
      "Manage Gateway Connections": 0,
      "Manage Session and Device Data": 2,
      "Manage Tool Calls": 2,
      "Secure Chat Sessions": 0,
      "Validate and Verify Connections": 2
    },
    "OpenClaw macOS app (dev + signing)": {
      "Manage Agent": 2,
      "Manage Agents": 2,
      "Manage Canvas": 2,
      "Manage Channels": 2,
      "Manage Connect": 2,
      "Manage Cron": 2,
      "Manage Device": 2,
      "Manage Discovery": 2,
      "Manage Exec": 2,
      "Manage Exec Approval": 2,
      "Manage Frame": 2,
      "Manage Gateway": 0,
      "Manage Gateway Environment": 2,
      "Manage Hint": 2,
      "Manage Pair": 2,
      "Manage Poll": 2,
      "Manage Sessions": 2,
      "Manage Snapshot": 2,
      "Manage Wizard": 2
    },
    "Sundered World - Simulation Server": {
      "Create and manage organizations": 0,
      "Create and manage quests": 0,
      "Manage game economy": 2,
      "Manage player inventory": 0,
      "Manage player relationships": 0,
      "Manage world state": 0
    },
    "WashUp": {
      "Create and manage car wash schedules": 0,
      "Manage car wash customer and account information": 0,
      "Monitor and manage car wash operations": 2,
      "Provide car wash operations management insights": 2,
      "Track and manage car wash equipment": 0
    },
    "Zerac: Zero Trust Network Access Platform": {
      "Deploy and manage secure resources": 2,
      "Enforce zero-trust network access": 0,
      "Establish secure peer-to-peer connections": 0,
      "Manage secure agent connections": 2,
      "Manage secure agent connections and access": 2,
      "Manage secure connections and access": 0,
      "Monitor and manage secure agent connections": 2,
      "Provide secure access to protected resources": 1,
      "Provide secure access to protected resources and connections": 1,
      "Provide secure access to resources": 1,
      "Securely manage and monitor access": 0,
      "Securely manage and monitor secure connections": 0,
      "Securely sign and verify binaries": 2
    },
    "app": {
      "Manages codebase member and activity management": 2,
      "Manages codebase onboarding and overview": 2,
      "Provides codebase map and frame management": 2,
      "Tracks codebase complexity and architectural conflicts": 1
    },
    "backend": {
      "Create and manage orders": 0,
      "Manage and track inventory and warehouse": 2,
      "Manage and track location and address information": 2,
      "Manage customer and user information": 2,
      "Manage products and pricing": 2,
      "Mutation Surface": 0,
      "Process invoices and payments": 0,
      "Track and manage deliveries": 2
    },
    "klauro-self": {
      "Manages mcp management": 2,
      "Manages scratch build reports": 2,
      "Manages workspace": 2,
      "Provides competitor analysis": 0,
      "Provides seeded scenario data": 0,
      "Surfaces cross analysis data": 0,
      "Surfaces quality trial reports": 2,
      "Tracks coverage analysis data": 0,
      "Tracks incremental analysis": 0
    },
    "kontinuum": {
      "Enforces delegation plans": 0,
      "Manages conversation import runs": 0,
      "Manages project brain packets": 1,
      "Manages remote memory": 0,
      "Secures remote task reports": 0,
      "Surfaces kernel operational summary": 0,
      "Surfaces klauro CAS import summary": 2,
      "Surfaces task reports": 2,
      "Tracks epistemic correctness": 2,
      "Tracks memory traces": 0
    },
    "openclaw": {
      "Manages fleet operations": 5,
      "Manages vehicle maintenance": 5,
      "Provides driver communication": 5,
      "Surfaces operational records": 5,
      "Tracks fuel and IFTA reporting": 5
    },
    "proof-of-concept": {
      "Generates element descriptions and updates analysis": 0,
      "Previews codebase iterations and updates analysis": 0,
      "Previews greenfield codebases and updates analysis": 0,
      "Runs analysis layers and updates analysis": 0,
      "Tracks agent revisions and project data": 2,
      "Tracks codebase changes and updates analysis": 0
    },
    "soon": {
      "Analyzes and optimizes trading strategies": 0,
      "Manages market data and trade execution": 0,
      "Manages user identity and access": 2,
      "Manages user portfolios and holdings": 0,
      "Provides backtesting and stress testing": 0,
      "Provides market intelligence and insights": 1,
      "Provides risk analysis and hedging": 0,
      "Surfaces predictive metrics and analysis": 0,
      "Tracks and optimizes portfolio performance": 0
    },
    "soon-bos": {
      "Manages acquisition leads": 0,
      "Manages billing recovery": 0,
      "Manages delivery": 0,
      "Manages growth initiatives": 0,
      "Manages lifecycle flows": 0,
      "Manages marketing campaigns": 1,
      "Manages operating systems": 0,
      "Manages profit initiatives": 0,
      "Manages staff coverage": 0,
      "Manages staff slack plans": 2,
      "Manages vision coverage": 2
    },
    "soon-lens": {
      "Manages exchange and market data": 2,
      "Manages market data and trade execution": 0,
      "Manages risk and security": 0,
      "Manages user portfolios and holdings": 2,
      "Manages user settings and preferences": 2,
      "Manages user subscriptions and payments": 2,
      "Provides analysis and insights": 2,
      "Provides portfolio performance and analysis": 0,
      "Provides technical indicators and analysis": 2,
      "Provides usage and analytics": 2
    },
    "soon-link": {
      "Manages Solana trading and portfolio automation": 0,
      "Manages user automation and adapters": 2,
      "Manages user credentials and consent": 0,
      "Manages user deposits and withdrawals": 0,
      "Manages user positions and balances": 0,
      "Manages user transactions and orders": 0,
      "Tracks market data and trade execution": 0
    },
    "soon-sync": {
      "Executes trades": 0,
      "Manages user activity": 2,
      "Manages user connections": 2,
      "Provides market metrics": 2
    },
    "soon-ui": {
      "Automate portfolio management": 0,
      "Manage portfolio": 0,
      "Monitor portfolio performance": 0,
      "Set up automation rules": 0,
      "View decision log": 2,
      "View market data": 2
    },
    "spring-petclinic-microservices": {
      "Create and manage visits": 0,
      "Exposes pet clinic data through API": 2,
      "Manage pet types and specialties": 2,
      "Provides a distributed architecture": 2,
      "View pet details": 0
    },
    "truckspy": {
      "Create and manage companies": 0,
      "Manage api tokens and customer profiles": 0,
      "Manage company and customer data": 2,
      "Manage devices and vehicle profiles": 0,
      "Manage drive alerts and drive history": 0,
      "Manage drive and vehicle data": 2,
      "Manage inspections and inspection configurations": 0,
      "Manage reporting profiles and configurations": 2,
      "Manage user profiles and authentication": 2
    },
    "v2": {
      "Manage API keys": 2,
      "Manage categories": 2,
      "Manage feed creation": 0,
      "Manage job scheduling": 2,
      "Manage user accounts": 0,
      "Manage web sessions": 2,
      "Secure user authentication": 0,
      "Track and manage feed counters": 2
    }
  };

describe('capability priority characterization', () => {
  const orch = new (AnalyzerOrchestrator as any)() as any;
  const priorityOf = (capability: any) => orch.systemCapabilityProductPriority(materialize(capability));

  it('assigns the recorded priority to every non-default capability', () => {
    const actual: Record<string, Record<string, number>> = {};
    for (const repo of corpus) {
      for (const capability of repo.capabilities) {
        const priority = priorityOf(capability);
        if (priority !== 3) {
          actual[repo.repo] = actual[repo.repo] || {};
          actual[repo.repo][capability.name] = priority;
        }
      }
    }
    expect(actual).toEqual(BASELINE);
  });

  it('spreads real capabilities across tiers instead of collapsing to a constant', () => {
    // The vocabulary version decided 69 of 215 ranks by wording and left every
    // repo it had not seen on a single value. Evidence produces a real spread, and
    // only the 5 capabilities with NO operations and NO entities land last.
    const distribution: Record<number, number> = {};
    for (const repo of corpus) {
      for (const capability of repo.capabilities) {
        const priority = priorityOf(capability);
        distribution[priority] = (distribution[priority] || 0) + 1;
      }
    }
    expect(distribution).toEqual({0: 72, 0.5: 7, 1: 8, 2: 67, 2.5: 10, 3: 39, 3.5: 7, 4: 5});
  });

  it('never demotes a capability for naming its user', () => {
    // Was it.failing: isCrossCuttingCapabilityName matched the bare word `user`
    // and returned 6, so "Manages user accounts", "Manages user portfolios" and
    // "Manages user subscriptions" — real outcomes real people get — were ranked
    // second-worst of six. Computed live, not read from the baseline, so it is the
    // BEHAVIOUR being asserted and not a copy of it.
    const demoted: string[] = [];
    for (const repo of corpus) {
      for (const capability of repo.capabilities) {
        if (/\buser\b/i.test(capability.name) && priorityOf(capability) >= 5) {
          demoted.push(`${repo.repo}: ${capability.name}`);
        }
      }
    }
    expect(demoted).toEqual([]);
  });
});

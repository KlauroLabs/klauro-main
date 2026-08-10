# UI Rebuild — Common Lane Charter

Every UI build lane reads this FIRST, follows it exactly, and treats deviations as defects.

## The product being built
apps/app is Klauro's production web app (served at app.klauro.com, built by Vite, deployed by
infrastructure/vps/deploy.sh). It lets a user explore an entire WORKSPACE → CODEBASE (CAS) →
DEPLOYABLE (DAS) → down to the finest detail (entry points, flows, capabilities, entities,
functions, integrations), with progressive disclosure at every level.

## Design language (from the Klauro Design Language file — binding)
- Philosophy: **Reveal structure before detail.** Every pixel reduces cognitive load. Construct,
  don't decorate. Progressive disclosure. Relationships are first-class. One visual language.
- Colors (dark, luminance creates hierarchy — hue stays constant):
  `#13141B` foundation/navigation · `#191A22` canvas/workspace · `#20212A` surface/cards ·
  `#2A2B36` construction/borders · `#B7BCC7` wireframe/icons · `#F5F5F5` text/primary ·
  `#E6414B` focus/accent (≈5% usage — neutral 95%).
- Stroke system: 0.75px construction · 1px secondary · 1.25px primary · 1.5px focus. Consistent
  stroke weights; never many weights.
- Geometry system: every concept has its own geometry (entity/capability/service/flow/
  relationship/dependency/architecture) — icons are engineered symbols, outlined, consistent
  stroke, never filled illustrations.
- Layout: 8px base unit (4/8/12/16/24/32/48/64). Spacing creates hierarchy, not color.
  No shadows, no gradients, no decorative motion. Motion explains state transitions only.
- Information density: high information, low visual noise — few pills/badges, restraint.
- Progressive disclosure ladder: Overview (what exists) → Capabilities (what can it do) →
  Flows (how does it move) → Entities (important objects) → Architecture (how built) →
  Dependencies (what it relies on).
- The Klauro Test before shipping anything: does it reduce cognitive load / reveal structure /
  teach / make relationships easier / can something be removed / is it explanation not
  decoration / would an engineer describe it this way?

## Architecture (binding)
- **MUI v7** (@mui/material, @emotion) with ALL styling via the central theme
  (`src/theme/`) — component defaults + variants via theme overrides. `sx` allowed only for
  a truly unique one-off element; NEVER inline `style=`; no new CSS files.
- **react-router-dom v7** — real page components under `src/pages/<area>/`, routes declared in
  `src/router.tsx`. Deep-linkable: every drilldown level is a route
  (`/workspaces/:wsId`, `/codebases/:projectId`, `/codebases/:projectId/entry-points/:epId`,
  `/codebases/:projectId/deployables/:subCasNodeId`, etc).
- **@tanstack/react-query** for ALL server state (no useEffect-fetch): query hooks live in
  `src/hooks/` (one file per API area), keyed consistently, envelope-aware.
- **Auth**: token from the existing auth flow lives in the AuthProvider (`src/auth/`);
  unauthenticated → auth routes only (the gate is a route guard now, not an if in a monolith).
- **API client**: `src/api.ts` stays the single typed fetch layer. CRITICAL ENVELOPE RULE:
  `GET /api/workspaces/:id/analysis` nests the graph under `analysis:` (top level =
  status/enrichment/last_attempt). Destructure the envelope in the hook layer ONCE — a past
  live incident came from reading fields at the response root.
- **File discipline**: no file over ~200 lines; components single-purpose; shared primitives go
  in `src/shared/components/` (NOT per-page copies). Structure follows the admin-ui exemplar:
  `src/app/<Feature>/` for pages, `src/shared/{api,auth,hooks,components,lib,layout}` for
  cross-feature code, `src/theme/{colors,palette,typography,components/*}.ts` split per concern.
- **Comments**: constraint comments ONLY (things the code cannot express: envelope rules,
  load-bearing invariants, honest-gap markers). NO lane narration, NO Figma-node citations
  (those live in docs/DESIGN-NOTES.md), NO provenance, NO restating the next line.
- **Tests live in apps/app/tests/** mirroring the src path — never colocated in src/.
- Tests: vitest + @testing-library/react (harness exists). Each lane ships tests for its pages
  (loading/empty/error/data states minimum).

## Fabric protocol (MANDATORY — this build is a coordination-fabric proof)
Auth token for API calls: `node -e "console.log(require('/Users/michaelshattuck/.klauro/auth.json').accounts['https://mcp.klauro.com'].token)"` (NEVER `klauro login`).
1. CLAIM before editing: POST https://mcp.klauro.com/v1/coordination/claim body
   `{workspace:'wsp_PWXpXfnPgDnf6lBC', agent_id:'<your-lane-id>', mode:'advisory', agent_kind:'other',
   intent:'<lane> + components you will CREATE (name them: e.g. creating src/components/NodeKindIcon.tsx)',
   paths:[<your dirs> plus each shared component file you intend to create]}`.
2. BEFORE creating ANY shared component/hook: GET /v1/coordination/active and READ peers'
   intents. If a peer's claim names a component you need (even unfinished), IMPORT IT anyway
   (write your code against its declared name/props), note the dependency in your report, and
   coordinate via the file itself — do NOT create a duplicate. This in-flight reuse is an
   explicit goal of the build.
3. Re-claim (same agent_id) when your file set grows. Release when done:
   POST /v1/coordination/release {workspace, agent_id}.
4. DOGFOOD KLAURO before writing code: the Klauro MCP server is available (ToolSearch
   "select:mcp__klauro__find_similar_code,mcp__klauro__get_codebase_idioms" etc; project path
   /Users/michaelshattuck/dev/unravl/proof-of-concept). Run find_similar_code for each component
   you're about to write; get_codebase_idioms once. If tools are unavailable, say so in the
   report — never silently skip.

## DESIGN FIDELITY RULE (user directive — binding, overrides anything else here)
**Figma is the bible.** For screens that exist in Figma, fidelity is BIDIRECTIONAL:
1. Do NOT add anything the design doesn't show — no extra elements, sections, badges, buttons,
   or data, even when the API offers more.
2. EVERY element that DOES appear in the Figma MUST be in the build. Pull get_design_context for
   your screen, inventory its elements, and verify each one exists in your implementation before
   reporting — your report includes this element-coverage checklist (element → built ✓). A
   designed element you can't populate from the API yet still gets BUILT (with an honest empty/
   placeholder state) and a DESIGN-NOTES.md entry naming the data gap.
Things you believe are MISSING from a designed page → apps/app/docs/DESIGN-NOTES.md (screen,
what's missing, why it matters, data fields affected) — never invented UI.
Pages WE create ourselves (no Figma) → derive from the design language + closest designed screen
AND write a full DESIGN BRIEF for them (apps/app/docs/briefs/<section>.md) following the
entry-points brief exactly — it is the exemplar of the thought process: plain-language,
describes what the data IS and the shape it comes in, ICELOT concepts (what a flow takes in,
the data it touches, outside services it calls, what it returns, where it ends), progressive
disclosure (each level answers one question; overview → detail as deliberate steps), who-looks-
and-why, data realities. The brief is the design contract for the page you built.

## Figma
File key `Ux2aXXgq4jzD9T4TZaDAw8`. Screens (node-ids): 1698-13626, 1748-6595, 1647-37709,
1982-5977, 2030-31178. Load the Figma MCP via ToolSearch ("figma get_design_context get_metadata"
keyword search; the server name is an id-prefixed mcp__ecf6ba6e…). Pull get_design_context for
YOUR screen (the scaffold lane publishes apps/app/docs/SCREEN-MAP.md mapping node→screen; if it
doesn't exist yet, pull get_metadata to identify yours). Match the design language above; where
your section has NO Figma design, derive it from the design language + the closest designed
screen, and say so in your report.

## Data sources (real API, read the route bodies in apps/mcp-server/src/remote-analyzer-service.ts)
Projects list, project analysis summary + /cas, workspace analysis (envelope!), reanalyze POSTs,
attach POST /api/workspaces/:id/projects {project_id}, DAS: get_summary-style scoped data comes
through /cas fields (sub_cas_nodes on promoted repos; applications carry source_sub_cas_node_id).
The entry-points data model: apps/app/docs/briefs/entry-points-design-brief.pdf is the CANONICAL
brief (15 pages — Read with the pages parameter; the .html file is a summary, the PDF wins where
they differ). Every NEW brief you write follows ITS tone: plain-language, describes what the data
IS and the shape it comes in (never the layout), audience: design, numbers from a live analysis,
"who looks at this and why" framing, data-reality callouts (count ranges, skew, raw-token names,
empty states as real cases). Binding structural rules from it: entry points are PER DEPLOYABLE
(one deployable at a time with a switcher); an entry-point view is a STARTING surface — the step
INTO the flow it opens matters as much as the catalog; capability lenses must hold one/many/none
shapes at once (cross-cutting auth = many, infrastructure = none, both correct); input/output
containers handle named-type links-deeper, loose objects, lists, plain values, nothing, and
outcome codes; the family MIX is the system's character — show the shape before the rows.

## Verification (every lane, before reporting)
`cd apps/app && npm run typecheck && npm run build && npm test` all green. NUL byte check == 0 on
every file you touched. Report: what you built, components created/reused (name which peer's
in-flight component you adopted, if any), Figma fidelity notes, klauro dogfood calls made + what
they prevented/found, test list, gate output. Do NOT commit — the orchestrator commits.

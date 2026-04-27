# Unravl Platform Plan

## Product Direction

Unravl is the visibility layer for AI-built software. The platform exists to make CAS analyses durable, shareable, inspectable, and governed by teams.

The full product is coherent when each layer supports the same truth:

- **CAS:** authoritative relationship graph.
- **UI:** human inspection and verification.
- **MCP:** agent access to the same graph.
- **SaaS platform:** saved analyses, workspaces, permissions, collaboration, history, billing, and private repository support.
- **Telemetry:** runtime validation of static understanding.

## Current State

### Backend

- NestJS API.
- MikroORM with PostgreSQL.
- Existing entities for users, organizations, memberships, projects, workspaces, and workspace access.
- Workspace restructure migration exists at `backend/src/database/migrations/Migration20250920000000_phase1-workspace-codebase-restructure.ts`.
- Auth currently exposes register/login only.

### Frontend

- Next.js, React, TypeScript.
- Product focus is visual inspection of CAS output and saved project/workspace workflows.

### MCP

- `mcp-server/` exposes local CAS analysis and query tools.
- MCP is the agent-facing product surface and should stay consistent with the UI's interpretation of CAS.

## Platform Model

```text
User
  -> Membership
  -> Organization
  -> Workspace
  -> Project / Codebase
  -> CAS Analysis
```

The codebase still has a `Project` entity/table in active code. The migration includes a future `codebases` table, but documentation and implementation must not pretend the rename is complete until the application code uses it end to end.

## Database Change Rule

All database changes must be implemented through migrations.

Do not document or run direct table changes as operational instructions. If a schema change is needed:

1. Update MikroORM entities.
2. Create or edit a migration.
3. Run migration checks locally.
4. Verify rollback behavior when possible.
5. Update docs to reference the migration file, not ad hoc SQL.

## Implemented Workspace Pieces

- `backend/src/database/entities/workspace.entity.ts`
- `backend/src/database/entities/workspace-access.entity.ts`
- `backend/src/workspaces/workspaces.controller.ts`
- `backend/src/workspaces/workspaces.service.ts`
- `backend/src/workspaces/workspaces.module.ts`
- Workspace DTOs under `backend/src/workspaces/dto/`
- Workspace/codebase restructure migration under `backend/src/database/migrations/`

## Near-Term Implementation Priorities

### 1. Make Saved Analyses Trustworthy

- Ensure projects/workspaces link cleanly to CAS analysis records.
- Make stale analysis state visible.
- Preserve change history and snapshots for inspection.
- Never hide analyzer errors from the UI or MCP.

### 2. Align UI and MCP Around CAS

- Same CAS fields should drive both surfaces.
- UI drilldown should use CAS relationships, not client-derived graph logic.
- MCP tools should expose the same relationships agents need for code changes.

### 3. Clarify Auth and Access Control

- Keep docs honest about currently implemented auth.
- Protect workspace routes consistently with `JwtAuthGuard`.
- Add refresh/logout/OAuth/API-key flows only when implemented and tested.
- Make workspace roles explicit in service logic and docs.

### 4. Productize the UI

- System overview for quick inspection.
- Drilldown by framework role, flow, data entity, test coverage, and risk.
- Clear empty/error states when CAS data is missing.
- Saved analysis history and snapshots.

### 5. Productize MCP

- Keep high-signal tools easy to discover.
- Document every implemented tool.
- Add usage patterns for coding, review, onboarding, and recent-change analysis.
- Treat tool errors as critical product feedback.

## Acceptance Criteria

- A user can create or access a workspace.
- A user can attach or analyze a project/codebase.
- The UI can inspect the CAS graph without computing missing relationships.
- MCP can query the same CAS graph for agent workflows.
- Analysis errors are visible.
- Database changes are represented by migrations.
- Docs accurately distinguish implemented behavior from planned behavior.

## Current Risks

| Risk | Why It Matters | Response |
| --- | --- | --- |
| CAS graph inaccuracy | UI and MCP both depend on graph trust | Prioritize relationship correctness and visible analyzer errors |
| Docs overstating features | Agents and humans will rely on false behavior | Keep implemented/planned sections separate |
| Split UI/MCP semantics | Two surfaces could disagree about the same codebase | Share CAS fields and query helpers wherever possible |
| Direct schema guidance | Violates project rule and risks data loss | Migrations only |
| Auth gaps | Workspace/private repo features need real access control | Finish auth flows before gating paid/private features |

## Next Steps

1. Verify workspace endpoints against current auth behavior.
2. Connect saved CAS analyses to workspace/project records.
3. Add UI states for analysis errors, stale analysis, and missing relationships.
4. Keep MCP docs synchronized with `mcp-server/src/server.ts`.
5. Add tests for workspace access and auth-protected analysis workflows.

# Dependencies: what the system relies on

A plain-language guide to a body of data Klauro produces, written so you can decide how and
where to present it. It describes what the information *is* and the shape it comes in — the
presentation is yours to design.

`Audience: design` · `Scope: one codebase at a time, repo-wide` · `Tests: out of scope` ·
`Numbers: from a live analysis (once wired — see below)` · `Counts: unknown until wired`

No Figma screen covers the full `/dependencies` page — the Repo overview screen (node
1647:37709, section 05) shows a preview row of external-service chips (Stripe, Postgres, Auth0,
SendGrid, Sentry, Segment in the mock). This brief is the design contract for the full page,
derived from that section plus the design language — written ahead of the data existing, so the
shape is ready the moment a backend lane wires it up.

---

## Start here: what we're describing (once wired)

An external service is anything the codebase's own logic calls out to but doesn't own the
implementation of — a payment processor, a managed database, an auth provider, an email/SMS
gateway, an observability sink. This is distinct from the codebase's own internal dependency
graph (libraries/packages it imports) and from Key Entities (data shapes it defines) — it's the
system's edge, the boundary where its behavior depends on someone else's service being up and
correct.

> **Who looks at this, and why**
> A new engineer asking *"what does this thing actually depend on to function?"* · An SRE
> asking *"what's our blast radius if Stripe/Auth0 goes down?"* · A security reviewer asking
> *"what third parties does our data actually reach?"*

## Current data reality — this section has no live source yet

Checked every REST route in `apps/mcp-server/src/remote-analyzer-service.ts`: no route serves
external-service or dependency data today. The underlying computation exists as MCP-only tools
(`get_external_services`, `get_dependencies`) but nothing joins it onto `GET /api/projects/:id/
analysis`, `/conceptual`, or `/cas`. The built `/dependencies` page and its Repo-overview preview
both render a genuine, permanent-until-wired empty state — not sample data, not a fabricated
chip row — per LANE-COMMON's DESIGN FIDELITY RULE ("a designed element you can't populate from
the API yet still gets built with an honest empty/placeholder state").

## What the shape will likely be, once wired

Based on the Figma mock and the MCP tool's evidence model: a per-service chip/card with the
service's name and a recognizable icon (a small fixed icon set, matching the geometry system —
never a filled logo illustration), plus (not shown in the mock, worth considering) the kind of
dependency (payment/auth/messaging/observability/storage) and the evidence that established the
link (an SDK import, an env var pattern, an API host in config). Treat the mock's 6-chip example
as illustrative, not a target count — a small service might have one dependency, a platform
integration hub could have dozens.

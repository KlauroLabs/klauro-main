# Scale Survivability Gate — Trend Log

Appended to by `apps/mcp-server/scripts/scale-survivability-gate.sh` on every
scheduled run (see infrastructure/vps/klauro-scale-gate.timer). A `fail` row
means the production-survivability rotation owner acts: see
apps/mcp-server/src/scale-survivability-gate.ts for the budgets and the
"red means someone acts" failure-surface note.

| Run (UTC) | Status | Reasons | Wall time | Peak RSS | Nodes |
|---|---|---|---|---|---|

# Current State Notes

## Status

This file is a historical CAS quality assessment. It should not be treated as the current product state without re-running analysis against the latest code.

The important product lesson remains valid: CAS quality is the foundation. If the graph cannot trace real behavior, both the UI and MCP lose trust.

## Historical Assessment

The assessment found useful HTTP entry point extraction and framework classification, but critical graph problems:

- Many call edges referenced missing nodes.
- Controller to service to repository traversal did not work reliably.
- File path and parent relationships were missing on important nodes.
- Auth detection was incomplete for guarded endpoints.

The specific failure mode was inconsistent node ID generation between node creation and call edge creation.

## Product Implication

Klauro must expose analyzer errors and graph uncertainty instead of hiding them. A user should be able to see when CAS is incomplete, stale, or internally inconsistent.

For the current product direction:

- The UI should make missing relationships visible.
- MCP tools should return structured errors or empty-state explanations when graph data is absent.
- Analyzer work should prioritize relationship correctness before visual polish.

## Re-Verification Checklist

Run a fresh analysis and answer these questions before using this file as evidence:

1. Can a real HTTP route be traced from controller to service to repository or external exit?
2. Do call edges reference existing nodes?
3. Do method nodes have correct parent relationships?
4. Do entry points include full paths and auth metadata?
5. Do node source locations include usable file and line information?
6. Does MCP expose enough context for an agent to change code without reading the whole repo first?

If any answer is no, the error is product-critical.

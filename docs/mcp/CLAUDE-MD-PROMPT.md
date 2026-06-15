# Klauro MCP Agent Prompt

Add this block to `CLAUDE.md`, `AGENTS.md`, or another agent instruction file
for any repository that has Klauro MCP configured. The goal is not to make the
agent ask Klauro for everything. The goal is to make the agent use the CAS graph
before broad file exploration, then read only the files Klauro identifies.

```markdown
## Codebase Intelligence (Klauro)

Use the Klauro MCP server before broad source-file exploration whenever an
analysis exists for this repository.

### Default Agent Loop

1. Call `resolve_agent_analysis` with the handed repository path and current
   task. If it returns `selected_path`, use that path for every follow-up call.
2. Call `get_agent_start_context` for the selected path before broad file reads.
3. Call `get_agent_tool_plan` with the task type: `orient`, `modify`, `debug`,
   `review`, `trace`, `cross-repo`, or `runtime`.
4. For concrete work, call `get_agent_work_packet` with:

   ```json
   {
     "path": "<selected_path>",
     "task": {
       "task_type": "modify",
       "target": "<user target>",
       "instructions": "<user request>",
       "success_criteria": [],
       "response_profile": "capsule-only"
     }
   }
   ```

5. Read the returned `K15` context capsule, then execute the returned `K5`
   capsule before any broad grep/read pass. Retry with `first-turn` only if
   capsule-only leaves a concrete gap.
6. Read source files only after the capsules or file plan narrow the target.
7. Before multi-file plans or refactors, call `preflight_agent_change`.
8. After edits, call `validate_agent_change`. When behavior or idioms are
   affected, also call `validate_behavioral_invariants` and
   `validate_codebase_idioms`.

### K15/K5 Capsule Rules

The `context_capsule.capsule` is Klauro's token-minimal context/cache format.

```text
K15mts target
As src ts tests
Es file ts file.test
Os reader
Cs candidate
@SelectedNode type 1 12
Iidiom/convention
Ureuse existing capability
Rrisk/invariant
Vvalidation command
!expansion rule
```

Expand aliases, restore header default extensions, and expand numeric file references before opening files. Read `K15` first for orientation, selected
node, file roles, local conventions, reuse constraints, risks, validation, and
the expansion rule.

The `capsule` / `execution_brief.capsule` is Klauro's token-minimal first-turn
execution format.

```text
K5|m|target
F|1*:src/owner.ts;2:src/dependency.ts;3*:tests/owner.test.ts
O|1:file-scoped operation;3:test operation
Q|required proof
N|forbidden shortcut
P|preserve boundary or idiom
V|validation command
B|f2,w40
S|val-stop
```

- `F` is the exact file dictionary. No sigil means read-only, `*` means read
  then edit, and `!` means edit-only.
- `O` is the file-scoped operation to perform. If `O` is absent, use `A` action
  lines.
- `Q` is required proof or test evidence.
- `N` is what not to touch or do.
- `P` is what must be preserved.
- `V|klauro-post-edit` means edit and stop; Klauro validates outside the model
  loop.
- `S|val-stop` means stop after focused validation instead of re-surveying the
  repository.

Do not expand beyond the `F` files unless the capsule is contradictory,
validation proves a concrete missing file, or the source proves the target moved.

### Fallback

If Klauro reports no analysis, stale analysis, a failed doctor check, missing
evidence, or a tool error, report that clearly and then fall back to direct code
reading for the current task.
```

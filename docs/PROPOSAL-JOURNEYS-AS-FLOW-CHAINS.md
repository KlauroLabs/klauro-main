# Proposal: Journeys as a query-time chain of flows

Status: proposal to the owner (2026-10-06). The specification text is unchanged by this document; the owner decides whether and how to amend it.

## What the code does now

- An entry-point flow is a flow: one program's entry point followed to its effects. It is stored once, as a member of tier-3 `flows`.
- The engine emits no journeys. It stores flows (entry point, steps, effects) and crossings: the ipc, event, network and queue links between a point that sends and the point that receives.
- Each crossing is stored as a seam in `communication_seams`. Its metadata names the flow that sends, the flow that receives, the boundary kind, the channel, the exit unit and the receiving entry point id. Chaining flows therefore never walks the call graph.
- A journey is computed when `get_user_journeys` or the product map's journeys section is requested. It starts at a user-facing flow, follows a stored crossing from that flow to the flow whose entry point receives it, and continues until a flow has no onward crossing.
- A journey's steps are the chained flows' own steps in order, with the boundary kind between flows. Its label is read through from the first and last flow names, and its ending is the last flow's own effect. Ranking reads flow facts: programs crossed, capability linkage of the chained flows, whether the last flow ends in an effect, and chain length.
- A flow with no crossing is a one-flow journey only when it is user-facing and ends in an effect.
- Responses state the bounds (flows per journey, branches per flow, journeys enumerated) and the true total. Nothing is persisted as a second structure, so a journey cannot drift from the flows it reads.

## Why the current wording does not match

`docs/cas/SPECIFICATION.md` section 0.5.1 says a journey exists in a query response if and only if a flow exists whose entry point is user-facing, and that its name, steps and capability linkage are that flow's facts. That describes an entry-point flow, not an end-to-end action. The `CASOutput` comment names `causal_journeys`, a stored field the code no longer has. The owner's distinction holds in the code: a flow is one program's entry point followed to its effects; a journey chains flows across program boundaries.

## Proposed amendment

1. In section 0.5.1, say that `workflows` and `entry_point_flows` are named views over `flows`, and that they are flows. Say that a journey is a distinct presentation projection that chains flows across crossings, computed at request time and never stored.
2. In the normative paragraph, replace the "if and only if a flow exists whose entry point is user-facing" sentence with: an entry-point flow exists in a response if and only if a user-facing flow exists; a journey exists in a response if and only if a user-facing flow can be chained, through one or more stored crossings, to a flow that ends in an effect, or is itself user-facing and ends in an effect. A journey's label, steps and capability linkage are read through from the chained flows. No second builder walks the graph to produce them.
3. In section 0.8, state that a crossing between flows is stored as a seam whose metadata names the sending flow, the receiving flow, the boundary kind, the exit unit and the receiving entry point, so a projection can chain flows from stored facts alone.
4. In the `CASOutput` comment, remove `causal_journeys` and describe `product_map` as carrying `entry_point_flows` and a journeys section computed from flows.
5. In section 0.5.2, keep the closed four-member list and name journeys explicitly as the example of a presentation projection that is not a member.

## Decisions for the owner

- Whether the journeys section of the product map stays or becomes only a pointer to `get_user_journeys`.
- Whether a crossing whose receiver is not an entry point (a queue consumer started inside a flow's own reach) should stay inside that flow, as it does now, or whether the receiving loop should become a flow of its own.
- Whether set-aside (unshipped) flows may start a journey, or only rank last as they do now.

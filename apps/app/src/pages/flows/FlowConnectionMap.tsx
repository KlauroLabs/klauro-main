import { useMemo } from 'react';
import { Box, Grid, Paper, Stack, Typography } from '@mui/material';
import type { FlowConcept } from '../../api';
import { GraphCanvas } from '../../components/diagram/GraphCanvas';
import { computeGraphNodeLayout, filterEdgesToKnownNodes, type GraphNode } from '../../components/diagram/graphLayout';

/**
 * "System Connection Map" (Figma node 1982:6611 inside Flow Overview,
 * reusing the same "Architecture Diagram" panel component the Repo overview
 * screen uses — confirmed via get_metadata: both carry the same 40px icon +
 * 164px labeled button pair top-right; the badge-title header variant is a
 * `hidden="true"` Figma layer in both places, so the real visible header is
 * the plain "Last updated" one this build already used).
 *
 * FULL-DIAGRAM VIEW (clickables-diagrams lane): this panel is already
 * rendered at full width inline on the Flow Overview page — Figma shows no
 * separate route for it (unlike the Architecture section, which has an
 * explicit, separately-labeled "See full Architecture" link elsewhere on
 * its card). The button pair's own label text isn't resolvable from Figma
 * metadata (component-instance text override, not captured at this file's
 * size), but by position/reuse it matches the Architecture panel's in-place
 * action pair, not a "navigate away" affordance — elsewhere in this file,
 * navigation always has its own distinct, clearly-labeled link. So "the
 * fuller rendering" this lane owes is upgrading the diagram FROM the static
 * hub-spoke SVG TO the same real zoom/pan GraphCanvas every other diagram in
 * the app now uses (see apps/app/docs/briefs/diagrams.md) — in place, no new
 * route invented. See apps/app/docs/DESIGN-NOTES.md for this reasoning.
 *
 * The legend groups Figma showed alongside the map — Entities, Used by,
 * Services, External Systems, Downstream Flows — map onto FlowConcept as
 * follows: Entities <- flow.entities, External Systems <-
 * contract.side_effects.external_integrations. "Used by", "Services", and
 * "Downstream Flows" have no backing field on FlowConcept (no flow-to-flow
 * or flow-to-internal-service relationship exists in the API today) — built
 * with an honest "not available yet" state per the DESIGN FIDELITY RULE,
 * logged as a data gap.
 */
export function FlowConnectionMap({ flow }: { flow: FlowConcept }) {
  const entities = flow.entities;
  const externalSystems = flow.contract.side_effects.external_integrations;

  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">System Connection Map</Typography>
        <Typography variant="caption" color="text.secondary">
          Explore how this flow connects with the system.
        </Typography>
      </Box>
      <Grid container>
        <Grid size={{ xs: 12, md: 6 }} sx={{ p: 3, borderRight: { md: '1px solid' }, borderColor: 'divider' }}>
          <ConnectionDiagram flowName={flow.name} entities={entities} externalSystems={externalSystems} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <LegendGroup label="Entities" items={entities} />
            <LegendGroup label="External systems" items={externalSystems} />
            <LegendGroup label="Used by" items={[]} gapNote="Flow-to-flow caller links are not in the API yet." />
            <LegendGroup label="Downstream flows" items={[]} gapNote="Flow-to-flow forward links are not in the API yet." />
          </Stack>
        </Grid>
      </Grid>
    </Paper>
  );
}

function LegendGroup({ label, items, gapNote }: { label: string; items: string[]; gapNote?: string }) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">{label}</Typography>
      {items.length > 0 ? (
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {items.map(item => <Typography key={item} variant="body2">{item}</Typography>)}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
          {gapNote ?? 'None recorded'}
        </Typography>
      )}
    </Box>
  );
}

/** Hub-and-spoke node/edge diagram — flow node in its own column, entity and
 *  external-system satellites in theirs, real zoom/pan via the shared
 *  GraphCanvas (graphLayout.ts's column layout used as a 3-column hub/spoke
 *  shape: flow / entities / external systems). No click-through: `entities`
 *  and `external_integrations` are plain name strings on FlowConcept, not
 *  ids, so there's nowhere real to navigate — see the module doc above. */
function ConnectionDiagram({ flowName, entities, externalSystems }: { flowName: string; entities: string[]; externalSystems: string[] }) {
  const nodes: GraphNode[] = useMemo(() => {
    const flowNode: GraphNode = { id: '__flow__', label: flowName, cluster: 'Flow' };
    const entityNodes: GraphNode[] = entities.map((name, i) => ({ id: `entity:${i}:${name}`, label: name, cluster: 'Entities' }));
    const externalNodes: GraphNode[] = externalSystems.map((name, i) => ({ id: `external:${i}:${name}`, label: name, cluster: 'External systems' }));
    return [flowNode, ...entityNodes, ...externalNodes];
  }, [flowName, entities, externalSystems]);

  const edges = useMemo(
    () => [
      ...entities.map((name, i) => ({ id: `e:${i}`, source: '__flow__', target: `entity:${i}:${name}` })),
      ...externalSystems.map((name, i) => ({ id: `x:${i}`, source: '__flow__', target: `external:${i}:${name}` })),
    ],
    [entities, externalSystems],
  );

  const layout = useMemo(
    () => computeGraphNodeLayout(nodes, { nodeWidth: 140, minHeight: 44, maxHeight: 44, clusterThreshold: 0 }),
    [nodes],
  );
  const nodeIds = useMemo(() => new Set(layout.nodes.map(n => n.id)), [layout.nodes]);
  const visibleEdges = useMemo(() => filterEdgesToKnownNodes(edges, nodeIds), [edges, nodeIds]);

  return (
    <Box sx={{ height: 320 }}>
      <GraphCanvas
        nodes={layout.nodes}
        edges={visibleEdges}
        clusters={layout.clusters}
        contentWidth={layout.width}
        contentHeight={layout.height}
        ariaLabel={`Connections for ${flowName}`}
      />
    </Box>
  );
}

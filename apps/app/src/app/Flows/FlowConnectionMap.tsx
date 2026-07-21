import { useMemo } from 'react';
import { Box, Grid, Paper, Stack, Typography } from '@mui/material';
import type { FlowConcept } from '@/shared/api/index';
import { GraphCanvas } from '@/shared/components/diagram/GraphCanvas';
import { computeGraphNodeLayout, filterEdgesToKnownNodes, type GraphNode } from '@/shared/components/diagram/graphLayout';

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

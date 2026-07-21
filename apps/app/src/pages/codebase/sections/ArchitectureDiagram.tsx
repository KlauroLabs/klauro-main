// Shared renderer behind BOTH the Architecture card's diagram panel
// (ArchitectureSection.tsx, Repo overview node 1647:38159, "Architecture
// Diagram") and the full /architecture view (CodebaseArchitecture.tsx,
// "See full Architecture"). Same node/edge set, two sizes — `compact`
// drops the perspective switcher and zoom controls and makes the whole
// canvas one click target (per LANE-COMMON's diagram brief: the card is
// the preview, the full view answers "how is it connected?").
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { GraphCanvas } from '../../../components/diagram/GraphCanvas';
import { computeGraphNodeLayout, filterEdgesToKnownNodes } from '../../../components/diagram/graphLayout';
import {
  buildArchitectureDiagramEdges,
  buildArchitectureDiagramNodes,
  promotedUnitIdForEvidence,
  type ArchitectureDiagramPerspectiveId,
} from '../architectureDiagramData';
import type { DeployableEvidence } from '../../deployable/dasTypes';

const PERSPECTIVES: Array<{ id: ArchitectureDiagramPerspectiveId; label: string; description: string }> = [
  { id: 'structural', label: 'Structural', description: 'Grouped by ship-artifact kind (container, package, binary…).' },
  { id: 'exposure', label: 'Exposure', description: 'Grouped by whether the artifact declares any listening ports.' },
];

export function ArchitectureDiagram({
  projectId,
  evidence,
  compact = false,
  onOpenFull,
}: {
  projectId: string;
  evidence: DeployableEvidence[];
  compact?: boolean;
  onOpenFull?: () => void;
}) {
  const navigate = useNavigate();
  const [perspective, setPerspective] = useState<ArchitectureDiagramPerspectiveId>('structural');

  const nodes = useMemo(() => buildArchitectureDiagramNodes(evidence, perspective), [evidence, perspective]);
  const edges = useMemo(() => buildArchitectureDiagramEdges(evidence), [evidence]);
  const layout = useMemo(() => computeGraphNodeLayout(nodes, { nodeWidth: 180, minHeight: 52, maxHeight: 68, clusterThreshold: 6 }), [nodes]);
  const nodeIds = useMemo(() => new Set(layout.nodes.map(n => n.id)), [layout.nodes]);
  const visibleEdges = useMemo(() => filterEdgesToKnownNodes(edges, nodeIds), [edges, nodeIds]);

  if (evidence.length === 0) {
    return (
      <Box
        sx={{
          height: compact ? 220 : 320,
          border: '0.75px dashed',
          borderColor: 'divider',
          borderRadius: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.disabled',
        }}
      >
        <Typography variant="caption">No deployable/ship evidence detected yet for this codebase.</Typography>
      </Box>
    );
  }

  const canvas = (
    <GraphCanvas
      nodes={layout.nodes}
      edges={visibleEdges}
      clusters={layout.clusters}
      contentWidth={layout.width}
      contentHeight={layout.height}
      ariaLabel="Codebase architecture diagram"
      interactive={!compact}
      onNodeClick={nodeId => {
        if (compact) {
          onOpenFull?.();
          return;
        }
        const dasUnitId = promotedUnitIdForEvidence(evidence, nodeId);
        if (dasUnitId) navigate(`/codebases/${projectId}/deployables/${dasUnitId}`);
      }}
      isNodeNavigable={nodeId => compact || Boolean(promotedUnitIdForEvidence(evidence, nodeId))}
    />
  );

  if (compact) {
    return (
      <Box onClick={onOpenFull} sx={{ height: 220, cursor: onOpenFull ? 'pointer' : 'default' }}>
        {canvas}
      </Box>
    );
  }

  return (
    <Stack spacing={2}>
      <ToggleButtonGroup size="small" exclusive value={perspective} onChange={(_, value) => value && setPerspective(value)}>
        {PERSPECTIVES.map(p => (
          <ToggleButton key={p.id} value={p.id}>{p.label}</ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.disabled">
        {PERSPECTIVES.find(p => p.id === perspective)?.description}
      </Typography>
      <Box sx={{ height: 420 }}>{canvas}</Box>
    </Stack>
  );
}

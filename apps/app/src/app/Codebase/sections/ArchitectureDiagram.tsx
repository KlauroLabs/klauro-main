import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { GraphCanvas } from '@/shared/components/diagram/GraphCanvas';
import { computeGraphNodeLayout, filterEdgesToKnownNodes } from '@/shared/components/diagram/graphLayout';
import { ARCHITECTURE_CONCEPTS_PERSPECTIVE, ARCHITECTURE_DEPLOYABLES_PERSPECTIVE } from '@/shared/components/diagram/perspectives';
import {
  buildArchitectureDiagramEdges,
  buildArchitectureDiagramNodes,
  buildConceptDiagramEdges,
  buildConceptDiagramNodes,
  buildConceptGroups,
  promotedUnitIdForEvidence,
  type ArchitectureDiagramPerspectiveId,
} from '@/app/Codebase/architectureDiagramData';
import type { DeployableEvidence } from '@/app/Deployable/dasTypes';
import type { RawCallEdge } from '@/shared/hooks/useArchitectureConcepts';

type ArchitectureLensId = 'concepts' | 'deployables';

const LENSES = [ARCHITECTURE_CONCEPTS_PERSPECTIVE, ARCHITECTURE_DEPLOYABLES_PERSPECTIVE];

const DEPLOYABLE_PERSPECTIVES: Array<{ id: ArchitectureDiagramPerspectiveId; label: string; description: string }> = [
  { id: 'structural', label: 'Structural', description: 'Grouped by ship-artifact kind (container, package, binary…).' },
  { id: 'exposure', label: 'Exposure', description: 'Grouped by whether the artifact declares any listening ports.' },
];

const MAX_LINKED_NODE_IDS = 300;

export function ArchitectureDiagram({
  projectId,
  evidence,
  conceptInventory,
  conceptEdges,
  compact = false,
  onOpenFull,
}: {
  projectId: string;
  evidence: DeployableEvidence[];
  conceptInventory: Record<string, string[]> | undefined;
  conceptEdges: RawCallEdge[];
  compact?: boolean;
  onOpenFull?: () => void;
}) {
  const navigate = useNavigate();
  const [lens, setLens] = useState<ArchitectureLensId>('concepts');
  const [deployablePerspective, setDeployablePerspective] = useState<ArchitectureDiagramPerspectiveId>('structural');

  const conceptGroups = useMemo(() => buildConceptGroups(conceptInventory), [conceptInventory]);
  const conceptNodes = useMemo(() => buildConceptDiagramNodes(conceptGroups), [conceptGroups]);
  const conceptDiagramEdges = useMemo(() => buildConceptDiagramEdges(conceptGroups, conceptEdges), [conceptGroups, conceptEdges]);

  const deployableNodes = useMemo(
    () => buildArchitectureDiagramNodes(evidence, deployablePerspective),
    [evidence, deployablePerspective],
  );
  const deployableEdges = useMemo(() => buildArchitectureDiagramEdges(evidence), [evidence]);

  const nodes = lens === 'concepts' ? conceptNodes : deployableNodes;
  const rawEdges = lens === 'concepts' ? conceptDiagramEdges : deployableEdges;

  const layout = useMemo(() => computeGraphNodeLayout(nodes, { nodeWidth: 180, minHeight: 52, maxHeight: 68, clusterThreshold: 6 }), [nodes]);
  const nodeIds = useMemo(() => new Set(layout.nodes.map(n => n.id)), [layout.nodes]);
  const visibleEdges = useMemo(() => filterEdgesToKnownNodes(rawEdges, nodeIds), [rawEdges, nodeIds]);

  const isEmpty = lens === 'concepts' ? conceptGroups.length === 0 : evidence.length === 0;

  if (isEmpty && compact) {
    return (
      <Box
        sx={{
          height: 220,
          border: '0.75px dashed',
          borderColor: 'divider',
          borderRadius: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.disabled',
        }}
      >
        <Typography variant="caption">No architectural concept evidence detected yet for this codebase.</Typography>
      </Box>
    );
  }

  const handleNodeClick = (nodeId: string) => {
    if (compact) {
      onOpenFull?.();
      return;
    }
    if (lens === 'concepts') {
      const group = conceptGroups.find(g => `concept:${g.id}` === nodeId);
      if (!group) return;
      const nodeIdsParam = group.nodeIds.slice(0, MAX_LINKED_NODE_IDS).join(',');
      navigate(`/codebases/${projectId}/functions?concept=${encodeURIComponent(group.id)}&nodeIds=${encodeURIComponent(nodeIdsParam)}`);
      return;
    }
    const dasUnitId = promotedUnitIdForEvidence(evidence, nodeId);
    if (dasUnitId) navigate(`/codebases/${projectId}/deployables/${dasUnitId}`);
  };

  const canvas = (
    <GraphCanvas
      nodes={layout.nodes}
      edges={visibleEdges}
      clusters={layout.clusters}
      contentWidth={layout.width}
      contentHeight={layout.height}
      ariaLabel="Codebase architecture diagram"
      interactive={!compact}
      onNodeClick={handleNodeClick}
      isNodeNavigable={nodeId => compact || (lens === 'concepts' ? true : Boolean(promotedUnitIdForEvidence(evidence, nodeId)))}
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
      <ToggleButtonGroup size="small" exclusive value={lens} onChange={(_, value) => value && setLens(value)}>
        {LENSES.map(l => (
          <ToggleButton key={l.id} value={l.id}>{l.label}</ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.disabled">
        {LENSES.find(l => l.id === lens)?.description}
      </Typography>

      {lens === 'deployables' ? (
        <Stack spacing={1}>
          <ToggleButtonGroup size="small" exclusive value={deployablePerspective} onChange={(_, value) => value && setDeployablePerspective(value)}>
            {DEPLOYABLE_PERSPECTIVES.map(p => (
              <ToggleButton key={p.id} value={p.id}>{p.label}</ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.disabled">
            {DEPLOYABLE_PERSPECTIVES.find(p => p.id === deployablePerspective)?.description}
          </Typography>
        </Stack>
      ) : null}

      {isEmpty ? (
        <Box
          sx={{
            height: 320,
            border: '0.75px dashed',
            borderColor: 'divider',
            borderRadius: 1.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.disabled',
          }}
        >
          <Typography variant="caption">
            {lens === 'concepts'
              ? 'No architectural concept evidence detected yet for this codebase.'
              : 'No deployable/ship evidence detected yet for this codebase.'}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ height: 420 }}>{canvas}</Box>
      )}
    </Stack>
  );
}

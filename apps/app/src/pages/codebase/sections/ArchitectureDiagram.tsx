// Shared renderer behind BOTH the Architecture card's diagram panel
// (ArchitectureSection.tsx, Repo overview node 1647:38159, "Architecture
// Diagram") and the full /architecture view (CodebaseArchitecture.tsx,
// "See full Architecture"). Same two lenses, two sizes — `compact` drops the
// lens switcher/zoom controls and makes the whole canvas one click target
// (per LANE-COMMON's diagram brief: the card is the preview, the full view
// answers "how is it connected?").
//
// Lenses (src/components/diagram/perspectives.ts): CONCEPTS is the DEFAULT —
// framework concepts (Services, Controllers, Repositories…) grouped from
// architecture_summary.architectural_inventory, not raw deployable rows (see
// architectureDiagramData.ts's file header for why "show everything" was
// wrong). DEPLOYABLES is the prior lens, kept as the second option, with its
// own structural/exposure sub-toggle.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { GraphCanvas } from '../../../components/diagram/GraphCanvas';
import { computeGraphNodeLayout, filterEdgesToKnownNodes } from '../../../components/diagram/graphLayout';
import { ARCHITECTURE_CONCEPTS_PERSPECTIVE, ARCHITECTURE_DEPLOYABLES_PERSPECTIVE } from '../../../components/diagram/perspectives';
import {
  buildArchitectureDiagramEdges,
  buildArchitectureDiagramNodes,
  buildConceptDiagramEdges,
  buildConceptDiagramNodes,
  buildConceptGroups,
  promotedUnitIdForEvidence,
  type ArchitectureDiagramPerspectiveId,
} from '../architectureDiagramData';
import type { DeployableEvidence } from '../../deployable/dasTypes';
import type { RawCallEdge } from '../../../hooks/useArchitectureConcepts';

type ArchitectureLensId = 'concepts' | 'deployables';

const LENSES = [ARCHITECTURE_CONCEPTS_PERSPECTIVE, ARCHITECTURE_DEPLOYABLES_PERSPECTIVE];

const DEPLOYABLE_PERSPECTIVES: Array<{ id: ArchitectureDiagramPerspectiveId; label: string; description: string }> = [
  { id: 'structural', label: 'Structural', description: 'Grouped by ship-artifact kind (container, package, binary…).' },
  { id: 'exposure', label: 'Exposure', description: 'Grouped by whether the artifact declares any listening ports.' },
];

/** Functions page click-through contract for a concept node: the id list is
 *  capped so the URL stays a reasonable length — FunctionsPage.tsx (a
 *  different lane's file) does not read these params yet, so this is a
 *  documented, deep-linkable contract for that wiring rather than a full
 *  round trip today; see DESIGN-NOTES.md "Architecture concepts -> Functions". */
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

  // In compact mode there is no lens switcher (see below), so an empty
  // default (concepts) lens must return here — nothing else would render.
  // In the full view, an empty lens still needs the switcher visible so a
  // reader can flip to the OTHER lens instead of hitting a dead end (a real
  // bug caught by CodebaseArchitecture.test.tsx: the switcher used to be
  // rendered only after this check, so an empty concepts lens hid the way to
  // reach a non-empty deployables lens entirely).
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

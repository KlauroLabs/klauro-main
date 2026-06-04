import React, { useMemo, useState } from 'react';
import { Box, Paper, Typography, Stack, Chip, Card, CardContent, IconButton, Tooltip } from '@mui/material';
import {
  ViewModule,
  GridView,
  AccountTree,
  FilterList,
} from '@mui/icons-material';
import { CASNode, CASEdge, CASOutput, CASPattern } from '../types';
import { ArchitectureCanvas, LayoutType } from '../canvas/ArchitectureCanvas';
import { getNodeColor } from '../canvas/NodeCard';
import { PatternsWidget } from '../components/PatternsWidget';

export interface ArchitectureOverviewProps {
  cas: CASOutput | null;
  nodes: CASNode[];
  edges: CASEdge[];
  patterns?: CASPattern[];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  onViewPatterns?: () => void;
}

export const ArchitectureOverview: React.FC<ArchitectureOverviewProps> = ({
  cas,
  nodes,
  edges,
  patterns = [],
  selectedNodeId,
  onNodeSelect,
  onNodeDoubleClick,
  onViewPatterns,
}) => {
  const [layout, setLayout] = useState<LayoutType>('grouped');
  const [groupBy, setGroupBy] = useState<'type' | 'level'>('type');
  const [showConnections, setShowConnections] = useState(true);

  const stats = useMemo(() => {
    const nodesByType = new Map<string, number>();
    nodes.forEach(n => {
      const count = nodesByType.get(n.type) || 0;
      nodesByType.set(n.type, count + 1);
    });

    const sortedTypes = Array.from(nodesByType.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      nodesByType: sortedTypes,
      entryPoints: cas?.entry_points?.length || 0,
      exitPoints: cas?.exit_points?.length || 0,
    };
  }, [nodes, edges, cas]);

  const systemInfo = cas?.system;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Paper sx={{ p: 2, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={3} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={2} alignItems="center">
            {systemInfo && (
              <>
                <Typography variant="h6" fontWeight={600}>
                  {systemInfo.name}
                </Typography>
                {systemInfo.type && (
                  <Chip label={systemInfo.type} size="small" color="primary" variant="outlined" />
                )}
              </>
            )}
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              {stats.totalNodes} nodes | {stats.totalEdges} connections
            </Typography>
            <Tooltip title="Toggle connections">
              <IconButton
                size="small"
                onClick={() => setShowConnections(!showConnections)}
                color={showConnections ? 'primary' : 'default'}
              >
                <AccountTree fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Group by type">
              <IconButton
                size="small"
                onClick={() => setGroupBy(groupBy === 'type' ? 'level' : 'type')}
                color="primary"
              >
                <ViewModule fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap">
          {stats.nodesByType.map(([type, count]) => (
            <Chip
              key={type}
              label={`${type} (${count})`}
              size="small"
              sx={{
                bgcolor: `${getNodeColor(type)}15`,
                color: getNodeColor(type),
                fontWeight: 500,
                mb: 0.5,
              }}
            />
          ))}
        </Stack>
      </Paper>

      <Box sx={{ flex: 1, position: 'relative' }}>
        <ArchitectureCanvas
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNodeId}
          onNodeSelect={onNodeSelect}
          onNodeDoubleClick={onNodeDoubleClick}
          layout={layout}
          groupBy={groupBy}
          showConnections={showConnections}
        />

        {patterns.length > 0 && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 16,
              right: 16,
              width: 360,
              maxHeight: 'calc(100% - 32px)',
              zIndex: 10,
            }}
          >
            <PatternsWidget
              patterns={patterns}
              nodes={nodes}
              onNodeClick={onNodeSelect}
              onViewAll={onViewPatterns}
            />
          </Box>
        )}
      </Box>

      <Paper sx={{ p: 1.5, borderRadius: 0, borderTop: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={3} justifyContent="center">
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'success.main' }} />
            <Typography variant="caption">Entry Points ({stats.entryPoints})</Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'error.main' }} />
            <Typography variant="caption">Exit Points ({stats.exitPoints})</Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ width: 12, height: 2, bgcolor: 'primary.main' }} />
            <Typography variant="caption">Calls ({stats.totalEdges})</Typography>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
};

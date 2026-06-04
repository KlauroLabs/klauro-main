import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { Box, Typography, Chip, Stack } from '@mui/material';
import { CASNode, CASEdge, NodePosition } from '../types';
import { NodeCard, getNodeColor } from './NodeCard';
import { ConnectionLines } from './ConnectionLine';
import { usePanZoom } from '../hooks/usePanZoom';

export type LayoutType = 'force' | 'grid' | 'hierarchical' | 'grouped';

export interface ArchitectureCanvasProps {
  nodes: CASNode[];
  edges: CASEdge[];
  selectedNodeId?: string | null;
  highlightedNodeIds?: Set<string>;
  dimmedNodeIds?: Set<string>;
  onNodeSelect?: (nodeId: string) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  layout?: LayoutType;
  groupBy?: 'type' | 'level';
  showConnections?: boolean;
  showLabels?: boolean;
  compactMode?: boolean;
}

interface GroupedNodes {
  [key: string]: CASNode[];
}

const CARD_WIDTH = 200;
const CARD_HEIGHT = 100;
const CARD_SPACING = 30;
const GROUP_PADDING = 40;
const GROUP_HEADER_HEIGHT = 40;

export const ArchitectureCanvas: React.FC<ArchitectureCanvasProps> = ({
  nodes,
  edges,
  selectedNodeId,
  highlightedNodeIds = new Set(),
  dimmedNodeIds = new Set(),
  onNodeSelect,
  onNodeDoubleClick,
  layout = 'grouped',
  groupBy = 'type',
  showConnections = true,
  showLabels = true,
  compactMode = false,
}) => {
  const {
    viewTransform,
    isDragging,
    containerRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
  } = usePanZoom();

  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());

  const groupedNodes = useMemo(() => {
    const groups: GroupedNodes = {};

    nodes.forEach(node => {
      const key = groupBy === 'type' ? node.type : String(node.level ?? 0);
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(node);
    });

    return groups;
  }, [nodes, groupBy]);

  const sortedGroupKeys = useMemo(() => {
    const keys = Object.keys(groupedNodes);

    if (groupBy === 'type') {
      const typeOrder = ['controller', 'service', 'repository', 'module', 'entity', 'class', 'function'];
      return keys.sort((a, b) => {
        const aIndex = typeOrder.indexOf(a);
        const bIndex = typeOrder.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      });
    }

    return keys.sort((a, b) => Number(a) - Number(b));
  }, [groupedNodes, groupBy]);

  useEffect(() => {
    const positions = new Map<string, NodePosition>();
    const cardWidth = compactMode ? 150 : CARD_WIDTH;
    const cardHeight = compactMode ? 60 : CARD_HEIGHT;
    const spacing = compactMode ? 20 : CARD_SPACING;

    let currentY = GROUP_PADDING;

    sortedGroupKeys.forEach(groupKey => {
      const groupNodes = groupedNodes[groupKey];
      const nodesPerRow = Math.ceil(Math.sqrt(groupNodes.length * 2));
      const rows = Math.ceil(groupNodes.length / nodesPerRow);

      let currentX = GROUP_PADDING;

      groupNodes.forEach((node, index) => {
        const row = Math.floor(index / nodesPerRow);
        const col = index % nodesPerRow;

        positions.set(node.id, {
          x: currentX + col * (cardWidth + spacing),
          y: currentY + GROUP_HEADER_HEIGHT + row * (cardHeight + spacing),
          width: cardWidth,
          height: cardHeight,
        });
      });

      const groupHeight = rows * (cardHeight + spacing) + GROUP_HEADER_HEIGHT + GROUP_PADDING;
      currentY += groupHeight + GROUP_PADDING;
    });

    setNodePositions(positions);
  }, [groupedNodes, sortedGroupKeys, compactMode]);

  const visibleEdges = useMemo(() => {
    if (!showConnections) return [];

    const visibleNodeIds = new Set(nodes.map(n => n.id));
    return edges.filter(
      e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    );
  }, [edges, nodes, showConnections]);

  const selectedEdgeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    return new Set(
      visibleEdges
        .filter(e => e.source === selectedNodeId || e.target === selectedNodeId)
        .map(e => e.id)
    );
  }, [visibleEdges, selectedNodeId]);

  const handleNodeClick = useCallback((node: CASNode) => {
    onNodeSelect?.(node.id);
  }, [onNodeSelect]);

  const handleNodeDoubleClick = useCallback((node: CASNode) => {
    onNodeDoubleClick?.(node.id);
  }, [onNodeDoubleClick]);

  const renderGroup = (groupKey: string, groupNodes: CASNode[]) => {
    if (groupNodes.length === 0) return null;

    const cardWidth = compactMode ? 150 : CARD_WIDTH;
    const cardHeight = compactMode ? 60 : CARD_HEIGHT;
    const spacing = compactMode ? 20 : CARD_SPACING;
    const nodesPerRow = Math.ceil(Math.sqrt(groupNodes.length * 2));
    const rows = Math.ceil(groupNodes.length / nodesPerRow);

    const groupWidth = nodesPerRow * (cardWidth + spacing) + GROUP_PADDING;
    const groupHeight = rows * (cardHeight + spacing) + GROUP_HEADER_HEIGHT + GROUP_PADDING;

    const firstNode = groupNodes[0];
    const firstPos = nodePositions.get(firstNode.id);
    if (!firstPos) return null;

    const groupX = firstPos.x - GROUP_PADDING / 2;
    const groupY = firstPos.y - GROUP_HEADER_HEIGHT - GROUP_PADDING / 2;
    const color = getNodeColor(groupKey);

    return (
      <Box
        key={groupKey}
        sx={{
          position: 'absolute',
          left: groupX,
          top: groupY,
          width: groupWidth,
          minHeight: groupHeight,
          bgcolor: `${color}08`,
          borderRadius: 2,
          border: 1,
          borderColor: `${color}30`,
          p: 2,
        }}
      >
        {showLabels && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
            <Chip
              label={groupKey.toUpperCase()}
              size="small"
              sx={{
                bgcolor: `${color}20`,
                color: color,
                fontWeight: 600,
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {groupNodes.length} items
            </Typography>
          </Stack>
        )}
      </Box>
    );
  };

  return (
    <Box
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        bgcolor: 'background.default',
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
          transformOrigin: '0 0',
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
        }}
      >
        {sortedGroupKeys.map(groupKey => renderGroup(groupKey, groupedNodes[groupKey]))}

        <ConnectionLines
          edges={visibleEdges}
          nodePositions={nodePositions}
          selectedEdgeIds={selectedEdgeIds}
          highlightedEdgeIds={new Set()}
          dimmedEdgeIds={new Set()}
        />

        {nodes.map(node => {
          const pos = nodePositions.get(node.id);
          if (!pos) return null;

          return (
            <Box
              key={node.id}
              sx={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                width: pos.width,
                zIndex: selectedNodeId === node.id ? 10 : 1,
              }}
            >
              <NodeCard
                node={node}
                selected={selectedNodeId === node.id}
                highlighted={highlightedNodeIds.has(node.id)}
                dimmed={dimmedNodeIds.has(node.id)}
                compact={compactMode}
                onClick={handleNodeClick}
                onDoubleClick={handleNodeDoubleClick}
              />
            </Box>
          );
        })}
      </Box>

      <Box
        sx={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          bgcolor: 'background.paper',
          px: 1.5,
          py: 0.5,
          borderRadius: 1,
          boxShadow: 1,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {nodes.length} nodes | {visibleEdges.length} connections | Zoom: {Math.round(viewTransform.scale * 100)}%
        </Typography>
      </Box>
    </Box>
  );
};

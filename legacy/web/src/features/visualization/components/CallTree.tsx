import React, { useState, useMemo } from 'react';
import {
  Box,
  Stack,
  Typography,
  IconButton,
  Collapse,
  Chip,
  Paper,
  Card,
} from '@mui/material';
import {
  ChevronRight,
  ExpandMore,
  PlayArrow,
  Code,
  Storage,
  Cloud,
} from '@mui/icons-material';
import { CASNode, CASEdge, ExitPoint } from '../types';
import { getNodeColor } from '../canvas/NodeCard';

export interface CallTreeNode {
  id: string;
  nodeId: string;
  name: string;
  type: string;
  depth: number;
  source?: { file: string; line: number };
  children: CallTreeNode[];
  isDatabase?: boolean;
  isExternal?: boolean;
  isExitPoint?: boolean;
  exitPointData?: ExitPoint;
}

interface CallTreeProps {
  rootNodeId: string;
  nodes: CASNode[];
  edges: CASEdge[];
  exitPoints?: ExitPoint[];
  onNodeClick: (nodeId: string) => void;
  onExitPointClick?: (exitPoint: ExitPoint, sourceNodeId: string) => void;
  maxDepth?: number;
}

export const CallTree: React.FC<CallTreeProps> = ({
  rootNodeId,
  nodes,
  edges,
  exitPoints = [],
  onNodeClick,
  onExitPointClick,
  maxDepth = 10,
}) => {
  const nodeMap = useMemo(
    () => new Map(nodes.map(n => [n.id, n])),
    [nodes]
  );

  const exitPointsBySourceNode = useMemo(() => {
    const map = new Map<string, ExitPoint[]>();
    exitPoints.forEach(ep => {
      const sourceNodeId = ep.source_node || ep.source?.node_id;
      if (sourceNodeId) {
        const existing = map.get(sourceNodeId) || [];
        existing.push(ep);
        map.set(sourceNodeId, existing);
      }
    });
    return map;
  }, [exitPoints]);

  const tree = useMemo(() => {
    const visited = new Set<string>();
    const nodeChildrenMap = new Map<string, string[]>();

    edges.forEach(edge => {
      if (edge.type === 'calls') {
        const children = nodeChildrenMap.get(edge.source) || [];
        children.push(edge.target);
        nodeChildrenMap.set(edge.source, children);
      }
    });

    function buildTree(nodeId: string, depth: number): CallTreeNode | null {
      if (depth > maxDepth || visited.has(nodeId)) {
        return null;
      }

      visited.add(nodeId);
      const node = nodeMap.get(nodeId);

      if (!node) return null;

      const outgoingEdges = edges.filter(e => e.source === nodeId && e.type === 'calls');

      const directChildren = nodeChildrenMap.get(nodeId) || [];
      const allDescendants = new Set<string>(directChildren);
      const findAllDescendants = (nId: string) => {
        const kids = nodeChildrenMap.get(nId) || [];
        kids.forEach(kid => {
          if (!allDescendants.has(kid)) {
            allDescendants.add(kid);
            findAllDescendants(kid);
          }
        });
      };
      directChildren.forEach(findAllDescendants);

      type ChildItem = { type: 'edge', edge: typeof outgoingEdges[0], line: number } |
                       { type: 'exit', exitPoint: ExitPoint, idx: number, line: number };

      const childItems: ChildItem[] = [];

      outgoingEdges.forEach(edge => {
        const line = edge.metadata?.attributes?.line || 0;
        childItems.push({ type: 'edge', edge, line });
      });

      const nodeExitPoints = exitPointsBySourceNode.get(nodeId) || [];
      nodeExitPoints.forEach((ep, idx) => {
        const epSourceNodeId = ep.source_node || ep.source?.node_id;
        if (epSourceNodeId && epSourceNodeId !== nodeId && allDescendants.has(epSourceNodeId)) {
          return;
        }

        if (ep.type === 'sdk') {
          return;
        }

        const line = ep.metadata?.line || ep.source?.line || 0;
        childItems.push({ type: 'exit', exitPoint: ep, idx, line });
      });

      childItems.sort((a, b) => a.line - b.line);

      const children: CallTreeNode[] = [];
      const childNodeIds = new Set<string>();

      childItems.forEach(item => {
        if (item.type === 'edge') {
          const child = buildTree(item.edge.target, depth + 1);
          if (child) {
            children.push(child);
            childNodeIds.add(item.edge.target);
          }
        } else {
          const ep = item.exitPoint;
          const sourceLine = ep.metadata?.line || ep.source?.line;
          const sourceFile = ep.metadata?.file || ep.source?.file || '';

          children.push({
            id: `${nodeId}_exit_${item.idx}`,
            nodeId: nodeId,
            name: ep.name,
            type: ep.type,
            depth: depth + 1,
            source: sourceLine ? { file: sourceFile, line: sourceLine } : undefined,
            children: [],
            isDatabase: ep.type === 'database',
            isExternal: ep.type === 'api',
            isExitPoint: true,
            exitPointData: ep,
          });
        }
      });

      return {
        id: nodeId,
        nodeId,
        name: node.name,
        type: node.type,
        depth,
        source: node.source,
        children,
        isDatabase: node.type === 'repository',
        isExternal: false,
      };
    }

    return buildTree(rootNodeId, 0);
  }, [rootNodeId, nodeMap, edges, exitPointsBySourceNode, maxDepth]);

  if (!tree) {
    return (
      <Paper sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          No call tree available
        </Typography>
      </Paper>
    );
  }

  return (
    <Box>
      <CallTreeNodeComponent
        node={tree}
        onNodeClick={onNodeClick}
        onExitPointClick={onExitPointClick}
        isRoot
      />
    </Box>
  );
};

interface CallTreeNodeComponentProps {
  node: CallTreeNode;
  onNodeClick: (nodeId: string) => void;
  onExitPointClick?: (exitPoint: ExitPoint, sourceNodeId: string) => void;
  isRoot?: boolean;
}

const CallTreeNodeComponent: React.FC<CallTreeNodeComponentProps> = ({
  node,
  onNodeClick,
  onExitPointClick,
  isRoot = false,
}) => {
  const [expanded, setExpanded] = useState(isRoot || node.depth < 2);
  const hasChildren = node.children.length > 0;
  const isClickable = true;

  const handleClick = () => {
    if (node.isExitPoint && node.exitPointData && onExitPointClick) {
      onExitPointClick(node.exitPointData, node.nodeId);
    } else {
      onNodeClick(node.nodeId);
    }
  };

  const nodeColor = getNodeColor(node.type);
  const indent = node.depth * 32;

  return (
    <Box sx={{ mb: 1.5, position: 'relative' }}>
      {node.depth > 0 && (
        <Box
          sx={{
            position: 'absolute',
            left: indent - 24,
            top: 0,
            bottom: hasChildren && expanded ? '50%' : 0,
            width: 2,
            bgcolor: 'divider',
          }}
        />
      )}

      <Box sx={{ pl: `${indent}px`, position: 'relative' }}>
        {node.depth > 0 && (
          <Box
            sx={{
              position: 'absolute',
              left: indent - 24,
              top: 28,
              width: 20,
              height: 2,
              bgcolor: 'divider',
            }}
          />
        )}

        <Card
          variant="outlined"
          sx={{
            transition: 'all 0.2s ease',
            borderColor: isRoot ? 'success.main' : undefined,
            borderWidth: isRoot ? 2 : 1,
            '&:hover': isClickable ? {
              boxShadow: 2,
              borderColor: nodeColor,
              bgcolor: 'action.hover',
            } : {},
            opacity: node.isExitPoint ? 0.85 : 1,
          }}
        >
          <Stack direction="row" sx={{ p: 1.5 }}>
            {hasChildren && (
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
                sx={{ mr: 1, alignSelf: 'flex-start' }}
              >
                {expanded ? <ExpandMore /> : <ChevronRight />}
              </IconButton>
            )}

            <Box
              sx={{
                width: 48,
                height: 48,
                borderRadius: 1,
                bgcolor: `${nodeColor}15`,
                color: nodeColor,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                mr: 2,
                cursor: isClickable ? 'pointer' : 'default',
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (isClickable) {
                  handleClick();
                }
              }}
            >
              {isRoot ? (
                <PlayArrow sx={{ fontSize: 24 }} />
              ) : node.isDatabase ? (
                <Storage sx={{ fontSize: 24 }} />
              ) : node.isExternal ? (
                <Cloud sx={{ fontSize: 24 }} />
              ) : (
                <Code sx={{ fontSize: 24 }} />
              )}
            </Box>

            <Box
              sx={{
                flex: 1,
                cursor: isClickable ? 'pointer' : 'default',
              }}
              onClick={() => {
                if (isClickable) {
                  handleClick();
                }
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  {node.name}
                </Typography>
                <Chip
                  label={node.type}
                  size="small"
                  sx={{
                    bgcolor: `${nodeColor}20`,
                    color: nodeColor,
                    height: 20,
                    fontSize: '0.65rem',
                  }}
                />
                {hasChildren && (
                  <Chip
                    label={`${node.children.length} call${node.children.length !== 1 ? 's' : ''}`}
                    size="small"
                    variant="outlined"
                    sx={{
                      height: 20,
                      fontSize: '0.65rem',
                    }}
                  />
                )}
              </Stack>

              {node.isExitPoint && node.exitPointData && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  {node.exitPointData.type === 'database'
                    ? `Database: ${node.exitPointData.target.resource || node.exitPointData.target.system || 'query'}`
                    : `External: ${node.exitPointData.target.endpoint || node.exitPointData.name}`}
                </Typography>
              )}

              {node.source && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontFamily="monospace"
                  sx={{ display: 'block' }}
                >
                  {node.source.file.split('/').pop()}:{node.source.line}
                </Typography>
              )}
            </Box>
          </Stack>
        </Card>
      </Box>

      {hasChildren && (
        <Collapse in={expanded}>
          <Box sx={{ mt: 1.5 }}>
            {node.children.map(child => (
              <CallTreeNodeComponent
                key={child.id}
                node={child}
                onNodeClick={onNodeClick}
                onExitPointClick={onExitPointClick}
              />
            ))}
          </Box>
        </Collapse>
      )}
    </Box>
  );
};

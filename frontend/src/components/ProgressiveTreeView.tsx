import React, { useState, useCallback } from 'react';
import {
  Box,
  CircularProgress,
  IconButton,
  Typography,
  Chip,
  Tooltip,
  Paper,
  LinearProgress
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ChevronRight as ChevronRightIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Code as CodeIcon,
  Memory as MemoryIcon,
  Speed as SpeedIcon
} from '@mui/icons-material';
import { useProgressiveData } from '../hooks/useProgressiveData';

interface ComponentSummary {
  id: string;
  name: string;
  type: string;
  complexity: number;
  connections: number;
  hasChildren?: boolean;
  childCount?: number;
  children?: ComponentSummary[];
}

interface ProgressiveTreeViewProps {
  projectId: string;
  onSelectComponent?: (componentId: string) => void;
  onExpandComponent?: (componentId: string) => void;
}

export const ProgressiveTreeView: React.FC<ProgressiveTreeViewProps> = ({
  projectId,
  onSelectComponent,
  onExpandComponent
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>('');
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());

  const {
    data,
    children,
    isLoading,
    error,
    loadMore,
    expandComponent,
    preload,
    cacheStats
  } = useProgressiveData({
    projectId,
    autoLoad: true,
    depth: 2
  });

  const handleToggle = useCallback(async (nodeId: string) => {
    const newExpanded = new Set(expanded);

    if (expanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);

      // Load children if needed
      const node = findNode(nodeId, children);
      if (node?.hasChildren && !(node as any).children) {
        setLoadingNodes(prev => new Set(prev).add(nodeId));

        try {
          await expandComponent(nodeId);
          onExpandComponent?.(nodeId);
        } finally {
          setLoadingNodes(prev => {
            const next = new Set(prev);
            next.delete(nodeId);
            return next;
          });
        }
      }
    }

    setExpanded(newExpanded);
  }, [expanded, children, expandComponent, onExpandComponent]);

  const handleSelect = useCallback((nodeId: string) => {
    setSelected(nodeId);
    onSelectComponent?.(nodeId);

    // Preload adjacent nodes for smooth navigation
    preload(nodeId);
  }, [onSelectComponent, preload]);

  const findNode = (id: string, nodes: ComponentSummary[]): ComponentSummary | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if ((node as any).children) {
        const found = findNode(id, (node as any).children);
        if (found) return found;
      }
    }
    return null;
  };

  const renderNode = (node: ComponentSummary, depth: number = 0) => {
    const isNodeLoading = loadingNodes.has(node.id);
    const isExpanded = expanded.has(node.id);
    const nodeIcon = node.hasChildren
      ? (isExpanded ? <FolderOpenIcon /> : <FolderIcon />)
      : <CodeIcon />;

    return (
      <Box key={node.id} sx={{ ml: depth * 2 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            py: 0.5,
            px: 1,
            cursor: 'pointer',
            bgcolor: selected === node.id ? 'action.selected' : 'transparent',
            '&:hover': { bgcolor: 'action.hover' },
            borderRadius: 1
          }}
          onClick={() => {
            handleSelect(node.id);
            if (node.hasChildren) {
              handleToggle(node.id);
            }
          }}
        >
          {node.hasChildren && (
            <IconButton size="small" sx={{ p: 0 }}>
              {isExpanded ? <ExpandMoreIcon /> : <ChevronRightIcon />}
            </IconButton>
          )}
          {isNodeLoading ? (
            <CircularProgress size={16} />
          ) : (
            nodeIcon
          )}
          <Typography variant="body2" sx={{ flexGrow: 1 }}>
            {node.name}
          </Typography>
          {(node.childCount || 0) > 0 && (
            <Chip
              label={`${node.childCount || 0}`}
              size="small"
              variant="outlined"
              sx={{ height: 20 }}
            />
          )}
          {node.connections > 0 && (
            <Tooltip title={`${node.connections} connections`}>
              <Chip
                label={node.connections}
                size="small"
                color="primary"
                sx={{ height: 20 }}
              />
            </Tooltip>
          )}
        </Box>

        {isExpanded && node.hasChildren && (
          <Box>
            {(node as any).children ? (
              (node as any).children.map((child: ComponentSummary) =>
                renderNode(child, depth + 1)
              )
            ) : !isNodeLoading && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ ml: (depth + 1) * 2 + 4, display: 'block' }}
              >
                Click to load {node.childCount} children...
              </Typography>
            )}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Paper sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Cache Stats Header */}
      <Box sx={{ mb: 2, p: 1, bgcolor: 'background.default', borderRadius: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
          <MemoryIcon fontSize="small" />
          <Typography variant="caption">
            Cache: {cacheStats.entries} items
          </Typography>
          <SpeedIcon fontSize="small" />
          <Typography variant="caption">
            {(cacheStats.sizeBytes / 1024).toFixed(1)} KB
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={cacheStats.utilization * 100}
          sx={{ height: 4 }}
        />
      </Box>

      {/* Tree View */}
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {isLoading && !children.length ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Typography color="error" sx={{ p: 2 }}>
            {error}
          </Typography>
        ) : (
          <Box>
            {children.map((node) => renderNode(node))}
          </Box>
        )}
      </Box>

      {/* Load More Button */}
      {data?.hasChildren && (
        <Box sx={{ mt: 2, textAlign: 'center' }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ cursor: 'pointer' }}
            onClick={() => loadMore(data.id, 3)}
          >
            Load deeper levels...
          </Typography>
        </Box>
      )}
    </Paper>
  );
};
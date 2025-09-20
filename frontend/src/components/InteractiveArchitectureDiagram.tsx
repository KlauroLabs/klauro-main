import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  IconButton,
  Zoom,
  Breadcrumbs,
  Link,
  Stack,
  Paper,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  OutlinedInput,
  SelectChangeEvent
} from '@mui/material';
import {
  ArrowBack,
  CallMade,
  CallReceived,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  CenterFocusStrong,
  Info,
  ViewModule
} from '@mui/icons-material';

import { Component, ConnectionGroup } from '../types/diagram.types';
import { CASNode, CASEdge } from '../types/cas.types';
import { formatTypeLabel, getTypeIcon, getTypeColor } from '../utils/diagram.utils';
import { useDragAndZoom } from '../hooks/useDragAndZoom';

interface InteractiveArchitectureDiagramProps {
  nodes: CASNode[];
  edges: CASEdge[];
  onNodeSelect?: (nodeId: string) => void;
  showSelectionView?: boolean; // Force selection view instead of auto-focusing
  allNodes?: CASNode[]; // All nodes for edge resolution
  onInfoPanelOpen?: () => void; // Callback to open info panel
  groupName?: string; // Name of the group we're viewing
}

const InteractiveArchitectureDiagram: React.FC<InteractiveArchitectureDiagramProps> = ({
  nodes,
  edges,
  onNodeSelect,
  showSelectionView = false,
  allNodes,
  onInfoPanelOpen,
  groupName
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedNode, setFocusedNode] = useState<CASNode | null>(null);
  const [connectionHistory, setConnectionHistory] = useState<CASNode[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [visibleConnections, setVisibleConnections] = useState<string[]>(['incoming', 'outgoing']);
  const [filteredBundleTypes, setFilteredBundleTypes] = useState<string[]>([]);
  const [isInSelectionMode, setIsInSelectionMode] = useState(showSelectionView);
  const { viewTransform, isDragging, handleMouseDown, handleMouseMove, handleMouseUp, handleZoom, handleResetView } = useDragAndZoom();

  // Get connections for the focused node
  const getConnections = (nodeId: string) => {
    const nodePool = allNodes || nodes; // Use allNodes if provided for finding connected nodes
    const outgoing = edges.filter(edge => edge.source === nodeId);
    const incoming = edges.filter(edge => edge.target === nodeId);

    const outgoingNodes = outgoing.map(edge =>
      nodePool.find(node => node.id === edge.target)
    ).filter(Boolean) as CASNode[];

    const incomingNodes = incoming.map(edge =>
      nodePool.find(node => node.id === edge.source)
    ).filter(Boolean) as CASNode[];

    return { outgoing: outgoingNodes, incoming: incomingNodes };
  };

  // Group connections by type and deduplicate
  const groupConnectionsByType = (connectionNodes: CASNode[]): ConnectionGroup[] => {
    const groups = new Map<string, Map<string, { node: CASNode; count: number }>>();

    // Count occurrences of each node
    connectionNodes.forEach(node => {
      const type = node.type || 'unknown';
      if (!groups.has(type)) {
        groups.set(type, new Map());
      }
      const typeGroup = groups.get(type)!;

      if (typeGroup.has(node.id)) {
        typeGroup.get(node.id)!.count++;
      } else {
        typeGroup.set(node.id, { node, count: 1 });
      }
    });

    return Array.from(groups.entries()).map(([type, nodeMap]) => ({
      type,
      label: formatTypeLabel(type),
      icon: getTypeIcon(type),
      color: getTypeColor(type),
      components: Array.from(nodeMap.values())
    }));
  };

  const handleNodeClick = (node: CASNode) => {
    setIsAnimating(true);

    // Add to history if this is a new focus
    if (focusedNode && focusedNode.id !== node.id) {
      setConnectionHistory(prev => [...prev, focusedNode]);
    }

    setTimeout(() => {
      setFocusedNode(node);
      setIsInSelectionMode(false); // Exit selection mode when a node is clicked
      setIsAnimating(false);
      onNodeSelect?.(node.id);
    }, 300);
  };

  const handleBackClick = () => {
    if (connectionHistory.length > 0) {
      const previousNode = connectionHistory[connectionHistory.length - 1];
      setConnectionHistory(prev => prev.slice(0, -1));
      setFocusedNode(previousNode);
    } else {
      // If no history and we started in selection view, go back to selection mode
      if (showSelectionView) {
        setIsInSelectionMode(true);
        setFocusedNode(null);
      } else {
        setFocusedNode(null);
      }
    }
  };

  // Auto-focus logic - only if not in selection mode
  useEffect(() => {
    // If we're in selection mode, don't auto-focus
    if (isInSelectionMode) {
      setFocusedNode(null);
      return;
    }

    // Otherwise, auto-focus on first suitable node if none selected and not initially in selection view
    if (!focusedNode && nodes.length > 0 && !showSelectionView) {
      const entryPoint = nodes.find(node =>
        node.type === 'controller' ||
        node.tags?.includes('controller') ||
        node.tags?.includes('entry-point') ||
        (node.level !== undefined && node.level === 0)
      ) || nodes[0];
      setFocusedNode(entryPoint);
    }
  }, [nodes, focusedNode, isInSelectionMode, showSelectionView]);

  // Show all nodes as cards if no focused node (progressive disclosure)
  if (!focusedNode) {
    return (
      <Box sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        p: 4
      }}>
        <Typography variant="h4" sx={{ mb: 4, color: 'text.primary', fontWeight: 600 }}>
          {nodes.length > 0 ? 'Select a component to explore' : 'No components available'}
        </Typography>

        {nodes.length > 0 && (
          <Box sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
            gap: 3,
            width: '100%',
            maxWidth: '1200px'
          }}>
            {nodes.map((node) => (
              <Card
                key={node.id}
                onClick={() => handleNodeClick(node)}
                sx={{
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  border: 2,
                  borderColor: 'transparent',
                  '&:hover': {
                    transform: 'translateY(-4px)',
                    boxShadow: 4,
                    borderColor: 'primary.main'
                  }
                }}
              >
                <CardContent>
                  <Stack spacing={1}>
                    <Typography variant="h6" fontWeight={600}>
                      {node.name}
                    </Typography>
                    {node.type && (
                      <Chip label={node.type} size="small" color="primary" variant="outlined" />
                    )}
                    {node.source && (
                      <Typography variant="caption" color="text.secondary">
                        {node.source.file.split('/').pop()}:{node.source.line}
                      </Typography>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  const { outgoing, incoming } = getConnections(focusedNode.id);
  const outgoingGroups = groupConnectionsByType(outgoing).filter(group => !filteredBundleTypes.includes(group.type));
  const incomingGroups = groupConnectionsByType(incoming).filter(group => !filteredBundleTypes.includes(group.type));

  // Get all available bundle types for the filter
  const allBundleTypes = Array.from(new Set([
    ...groupConnectionsByType(outgoing).map(g => g.type),
    ...groupConnectionsByType(incoming).map(g => g.type)
  ]));

  // Calculate spatial positions for connection groups
  const calculateGroupPositions = (groups: ConnectionGroup[], side: 'left' | 'right') => {
    const groupData: Array<{
      group: ConnectionGroup;
      x: number;
      y: number;
      width: number;
      height: number;
      nodes: Array<{ node: CASNode; x: number; y: number; count?: number }>;
    }> = [];

    const gridSize = 160; // Size of each grid cell (wider for bigger cards)
    const groupSpacing = 180; // Space between groups
    let currentY = -250; // Start position

    groups.forEach((group) => {
      const itemsPerRow = Math.ceil(Math.sqrt(group.components.length));
      const rows = Math.ceil(group.components.length / itemsPerRow);
      const groupWidth = itemsPerRow * gridSize;
      const groupHeight = rows * gridSize + 40; // Add space for header

      const baseX = side === 'right' ? 350 : -350 - groupWidth;

      const nodes: Array<{ node: CASNode; x: number; y: number; count?: number }> = [];

      group.components.forEach((item, nodeIndex) => {
        const row = Math.floor(nodeIndex / itemsPerRow);
        const col = nodeIndex % itemsPerRow;

        const nodeX = baseX + (col * gridSize) + 70; // Center in cell
        const nodeY = currentY + (row * gridSize) + 50; // Center in cell

        nodes.push({ node: item.node, x: nodeX, y: nodeY, count: item.count });
      });

      groupData.push({
        group,
        x: baseX,
        y: currentY,
        width: groupWidth,
        height: groupHeight,
        nodes
      });

      currentY += groupHeight + groupSpacing;
    });

    return groupData;
  };

  const outgoingGroupData = calculateGroupPositions(outgoingGroups, 'right');
  const incomingGroupData = calculateGroupPositions(incomingGroups, 'left');

  return (
    <Box
      ref={containerRef}
      sx={{
        height: '100vh',
        overflow: 'hidden',
        background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
        position: 'relative',
        cursor: isDragging ? 'grabbing' : 'grab'
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Navigation Header */}
      <Paper
        elevation={2}
        sx={{
          position: 'absolute',
          top: 16,
          left: 16,
          right: 16,
          p: 2,
          zIndex: 10,
          borderRadius: 2
        }}
      >
        <Stack direction="row" alignItems="center" spacing={2} justifyContent="space-between">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {(connectionHistory.length > 0 || showSelectionView) && (
              <IconButton
                onClick={handleBackClick}
                size="small"
                title={showSelectionView && connectionHistory.length === 0 ? `Back to ${groupName || 'selection'}` : 'Back'}
              >
                <ArrowBack />
              </IconButton>
            )}

            {showSelectionView && connectionHistory.length === 0 && groupName && (
              <Chip
                icon={<ViewModule />}
                label={groupName}
                size="small"
                variant="outlined"
                sx={{ mr: 1 }}
              />
            )}

            <Breadcrumbs separator={<ChevronRight fontSize="small" />}>
              {connectionHistory.map((node, index) => (
                <Link
                  key={node.id}
                  color="inherit"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    const newHistory = connectionHistory.slice(0, index);
                    setConnectionHistory(newHistory);
                    setFocusedNode(node);
                  }}
                  sx={{ cursor: 'pointer' }}
                >
                  {node.name}
                </Link>
              ))}
              <Typography color="text.primary" fontWeight={600}>
                {focusedNode.name}
              </Typography>
            </Breadcrumbs>
          </Box>

          <Box sx={{ ml: 'auto', display: 'flex', gap: 2, alignItems: 'center' }}>
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="bundle-filter-label" size="small">Hide Types</InputLabel>
              <Select
                labelId="bundle-filter-label"
                multiple
                value={filteredBundleTypes}
                onChange={(event: SelectChangeEvent<typeof filteredBundleTypes>) => {
                  const value = typeof event.target.value === 'string'
                    ? event.target.value.split(',')
                    : event.target.value;
                  setFilteredBundleTypes(value);
                }}
                input={<OutlinedInput label="Hide Types" />}
                renderValue={(selected) => (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {selected.map((value) => (
                      <Chip key={value} label={formatTypeLabel(value)} size="small" />
                    ))}
                  </Box>
                )}
                MenuProps={{
                  PaperProps: {
                    style: {
                      maxHeight: 48 * 4.5 + 8,
                      width: 250,
                    },
                  },
                }}
              >
                {allBundleTypes.map((type) => (
                  <MenuItem key={type} value={type}>
                    {formatTypeLabel(type)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {onInfoPanelOpen && (
                <Tooltip title="Analysis Info">
                  <IconButton size="small" onClick={onInfoPanelOpen}>
                    <Info />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="Zoom In">
                <IconButton size="small" onClick={() => handleZoom('in')}>
                  <ZoomIn />
                </IconButton>
              </Tooltip>
              <Tooltip title="Zoom Out">
                <IconButton size="small" onClick={() => handleZoom('out')}>
                  <ZoomOut />
                </IconButton>
              </Tooltip>
              <Tooltip title="Reset View">
                <IconButton size="small" onClick={handleResetView}>
                  <CenterFocusStrong />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        </Stack>
      </Paper>

      {/* Main Visualization Area */}
      <Box
        sx={{
          height: '100vh',
          width: '100vw',
          position: 'relative',
          overflow: 'hidden',
          transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
          transformOrigin: 'center center',
          transition: isDragging ? 'none' : 'transform 0.2s ease-out'
        }}
      >
        <Box
          sx={{
            height: '100vh',
            width: '100vw',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative'
          }}
        >
          {/* Center Card - Focused Node */}
          <Zoom in={!isAnimating} timeout={300}>
            <Card
              sx={{
                width: 380,
                minHeight: 240,
                position: 'absolute',
                zIndex: 5,
                transform: 'scale(1.1)',
                boxShadow: 6,
                border: 3,
                borderColor: getTypeColor(focusedNode.type || 'unknown'),
                cursor: 'default',
                borderRadius: 3
              }}
            >
              <CardContent sx={{ p: 3 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
                  {getTypeIcon(focusedNode.type || 'unknown')}
                  <Typography variant="h5" fontWeight={700}>
                    {focusedNode.name}
                  </Typography>
                </Stack>

                <Chip
                  label={formatTypeLabel(focusedNode.type || 'unknown')}
                  sx={{
                    mb: 2,
                    bgcolor: getTypeColor(focusedNode.type || 'unknown'),
                    color: 'white',
                    fontWeight: 600
                  }}
                  size="small"
                />

                {focusedNode.source && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {focusedNode.source.file}:{focusedNode.source.line}
                  </Typography>
                )}

                {focusedNode.level_name && (
                  <Typography variant="body2" sx={{ mb: 2 }}>
                    Level: {focusedNode.level_name}
                  </Typography>
                )}

                {focusedNode.metadata?.description && (
                  <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
                    {focusedNode.metadata.description}
                  </Typography>
                )}

                <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
                  <Chip
                    label={`${outgoing.length} calls`}
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                  <Chip
                    label={`${incoming.length} callers`}
                    size="small"
                    color="info"
                    variant="outlined"
                  />
                </Box>
              </CardContent>
            </Card>
          </Zoom>

          {/* Outgoing Connections - Grouped Bundles */}
          {visibleConnections.includes('outgoing') && outgoingGroupData.map((groupData) => (
            <Box
              key={`out-group-${groupData.group.type}`}
              sx={{
                position: 'absolute',
                left: `calc(50% + ${groupData.x}px)`,
                top: `calc(50% + ${groupData.y}px)`,
                width: groupData.width,
                height: groupData.height,
                border: 2,
                borderColor: groupData.group.color,
                borderRadius: 2,
                bgcolor: 'rgba(255, 255, 255, 0.05)',
                p: 1
              }}
            >
              {/* Group Header */}
              <Box sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                mb: 1,
                p: 1,
                bgcolor: groupData.group.color,
                color: 'white',
                borderRadius: 1,
                fontSize: '0.75rem',
                fontWeight: 600
              }}>
                {groupData.group.icon}
                {groupData.group.label} ({groupData.group.components.length})
              </Box>

              {/* Individual Cards */}
              {groupData.nodes.map(({ node, x, y, count }) => (
                <Card
                  key={node.id}
                  onClick={() => handleNodeClick(node)}
                  sx={{
                    position: 'absolute',
                    left: x - groupData.x - 70,
                    top: y - groupData.y + 20,
                    width: 140,
                    height: 80,
                    cursor: 'pointer',
                    border: 1,
                    borderColor: groupData.group.color,
                    bgcolor: 'white',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      transform: 'scale(1.05)',
                      boxShadow: 3,
                      zIndex: 10
                    }
                  }}
                >
                  {count && count > 1 && (
                    <Chip
                      label={count}
                      size="small"
                      sx={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        minWidth: 20,
                        height: 20,
                        fontSize: '0.65rem',
                        bgcolor: groupData.group.color,
                        color: 'white',
                        zIndex: 1
                      }}
                    />
                  )}
                  <CardContent sx={{ p: 1, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                    <Box sx={{ mb: 0.5, color: groupData.group.color }}>
                      {groupData.group.icon}
                    </Box>
                    <Typography
                      variant="caption"
                      fontWeight={500}
                      sx={{
                        fontSize: '0.7rem',
                        lineHeight: 1.2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical'
                      }}
                      title={node.name}
                    >
                      {node.name}
                    </Typography>
                  </CardContent>
                </Card>
              ))}
            </Box>
          ))}

          {/* Incoming Connections - Grouped Bundles */}
          {visibleConnections.includes('incoming') && incomingGroupData.map((groupData) => (
            <Box
              key={`in-group-${groupData.group.type}`}
              sx={{
                position: 'absolute',
                left: `calc(50% + ${groupData.x}px)`,
                top: `calc(50% + ${groupData.y}px)`,
                width: groupData.width,
                height: groupData.height,
                border: 2,
                borderColor: groupData.group.color,
                borderRadius: 2,
                bgcolor: 'rgba(255, 255, 255, 0.05)',
                p: 1
              }}
            >
              {/* Group Header */}
              <Box sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                mb: 1,
                p: 1,
                bgcolor: groupData.group.color,
                color: 'white',
                borderRadius: 1,
                fontSize: '0.75rem',
                fontWeight: 600
              }}>
                {groupData.group.icon}
                {groupData.group.label} ({groupData.group.components.length})
              </Box>

              {/* Individual Cards */}
              {groupData.nodes.map(({ node, x, y, count }) => (
                <Card
                  key={node.id}
                  onClick={() => handleNodeClick(node)}
                  sx={{
                    position: 'absolute',
                    left: x - groupData.x - 70,
                    top: y - groupData.y + 20,
                    width: 140,
                    height: 80,
                    cursor: 'pointer',
                    border: 1,
                    borderColor: groupData.group.color,
                    bgcolor: 'white',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      transform: 'scale(1.05)',
                      boxShadow: 3,
                      zIndex: 10
                    }
                  }}
                >
                  {count && count > 1 && (
                    <Chip
                      label={count}
                      size="small"
                      sx={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        minWidth: 20,
                        height: 20,
                        fontSize: '0.65rem',
                        bgcolor: groupData.group.color,
                        color: 'white',
                        zIndex: 1
                      }}
                    />
                  )}
                  <CardContent sx={{ p: 1, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                    <Box sx={{ mb: 0.5, color: groupData.group.color }}>
                      {groupData.group.icon}
                    </Box>
                    <Typography
                      variant="caption"
                      fontWeight={500}
                      sx={{
                        fontSize: '0.7rem',
                        lineHeight: 1.2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical'
                      }}
                      title={node.name}
                    >
                      {node.name}
                    </Typography>
                  </CardContent>
                </Card>
              ))}
            </Box>
          ))}

          {/* Connection Lines */}
          <svg
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              zIndex: 1
            }}
          >
            <defs>
              <marker
                id="arrowhead-out"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 10 3.5, 0 7"
                  fill="#10b981"
                />
              </marker>
              <marker
                id="arrowhead-in"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 10 3.5, 0 7"
                  fill="#3b82f6"
                />
              </marker>
            </defs>

            {/* Lines for outgoing connections - Point to group borders */}
            {visibleConnections.includes('outgoing') && outgoingGroupData.map((groupData) => {
              // Calculate intersection with left border of group (since arrows come from center-left)
              const borderX = groupData.x; // Left edge of group
              const centerY = groupData.y + groupData.height / 2; // Vertical center of group

              return (
                <line
                  key={`out-group-${groupData.group.type}`}
                  x1="50%"
                  y1="50%"
                  x2={`calc(50% + ${borderX}px)`} // Point to left border of group
                  y2={`calc(50% + ${centerY}px)`} // Point to vertical center
                  stroke="#10b981"
                  strokeWidth="3"
                  strokeDasharray="8,4"
                  opacity="0.8"
                  markerEnd="url(#arrowhead-out)"
                />
              );
            })}

            {/* Lines for incoming connections - Point to group borders */}
            {visibleConnections.includes('incoming') && incomingGroupData.map((groupData) => {
              // Calculate intersection with right border of group (since arrows come from center-right)
              const borderX = groupData.x + groupData.width; // Right edge of group
              const centerY = groupData.y + groupData.height / 2; // Vertical center of group

              return (
                <line
                  key={`in-group-${groupData.group.type}`}
                  x1="50%"
                  y1="50%"
                  x2={`calc(50% + ${borderX}px)`} // Point to right border of group
                  y2={`calc(50% + ${centerY}px)`} // Point to vertical center
                  stroke="#3b82f6"
                  strokeWidth="3"
                  strokeDasharray="8,4"
                  opacity="0.8"
                  markerEnd="url(#arrowhead-in)"
                />
              );
            })}
          </svg>
        </Box>
      </Box>
    </Box>
  );
};

export default InteractiveArchitectureDiagram;

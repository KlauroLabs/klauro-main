import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  Chip,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Card,
  CardContent,
  Tooltip,
  Alert,
  AlertTitle,
  Badge,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Collapse,
  Divider
} from '@mui/material';
import {
  Timeline,
  CallSplit,
  Loop,
  Warning,
  Error,
  CheckCircle,
  Speed,
  Security,
  Storage,
  Cloud,
  Code,
  ExpandMore,
  ExpandLess,
  ZoomIn,
  ZoomOut,
  CenterFocusStrong,
  PlayArrow,
  Pause,
  SkipNext,
  Replay,
  FilterList,
  Visibility,
  VisibilityOff,
  AccountTree,
  DeviceHub
} from '@mui/icons-material';
import { CASCallChain, CASMethodCall, CASNode } from '../../types/cas.types';

interface CallChainVisualizationProps {
  callChains: CASCallChain[];
  methodCalls: CASMethodCall[];
  nodes: CASNode[];
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
  onMethodClick?: (call: CASMethodCall) => void;
}

interface FlowNode {
  id: string;
  nodeId: string;
  name: string;
  type: 'entry' | 'exit' | 'internal' | 'external';
  depth: number;
  x: number;
  y: number;
  calls: CASMethodCall[];
  isAsync?: boolean;
  isConditional?: boolean;
  isLoop?: boolean;
  isHotPath?: boolean;
  isBottleneck?: boolean;
}

interface FlowEdge {
  source: string;
  target: string;
  type: 'sync' | 'async' | 'recursive' | 'external';
  callCount: number;
}

const FLOW_COLORS = {
  entry: '#4caf50',
  exit: '#f44336',
  internal: '#2196f3',
  external: '#ff9800',
  async: '#9c27b0',
  recursive: '#e91e63',
  hotPath: '#ff5722',
  bottleneck: '#d32f2f'
};

export const CallChainVisualization: React.FC<CallChainVisualizationProps> = ({
  callChains,
  methodCalls,
  nodes,
  selectedNodeId,
  onNodeClick,
  onMethodClick
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedChain, setSelectedChain] = useState<CASCallChain | null>(null);
  const [viewMode, setViewMode] = useState<'chains' | 'flow' | 'timeline'>('chains');
  const [filterMode, setFilterMode] = useState<'all' | 'critical' | 'hotPath' | 'recursive'>('all');
  const [showExternalCalls, setShowExternalCalls] = useState(true);
  const [showAsyncCalls, setShowAsyncCalls] = useState(true);
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());
  const [zoomLevel, setZoomLevel] = useState(1);
  const [isAnimating, setIsAnimating] = useState(false);

  const filteredChains = useMemo(() => {
    let filtered = [...callChains];

    switch (filterMode) {
      case 'critical':
        filtered = filtered.filter(chain => chain.risk_analysis.risk_level === 'critical' || chain.risk_analysis.risk_level === 'high');
        break;
      case 'hotPath':
        filtered = filtered.filter(chain => chain.chain_type === 'hot-path' || chain.chain_type === 'critical-path');
        break;
      case 'recursive':
        filtered = filtered.filter(chain => chain.characteristics.is_recursive || chain.chain_type === 'recursive');
        break;
    }

    if (!showExternalCalls) {
      filtered = filtered.filter(chain => !chain.characteristics.has_external_calls);
    }

    if (!showAsyncCalls) {
      filtered = filtered.filter(chain => !chain.characteristics.has_async_calls);
    }

    return filtered;
  }, [callChains, filterMode, showExternalCalls, showAsyncCalls]);

  const buildFlowGraph = (chain: CASCallChain): { nodes: FlowNode[], edges: FlowEdge[] } => {
    const flowNodes: FlowNode[] = [];
    const flowEdges: FlowEdge[] = [];
    const nodeMap = new Map<string, FlowNode>();

    chain.call_path.forEach((call, index) => {
      const methodCall = methodCalls.find(mc => mc.id === call.call_id);
      if (!methodCall) return;

      const flowNode: FlowNode = {
        id: call.call_id,
        nodeId: call.node_id,
        name: call.method_name,
        type: index === 0 ? 'entry' :
               index === chain.call_path.length - 1 ? 'exit' :
               methodCall.target_node ? 'internal' : 'external',
        depth: call.depth,
        x: 100 + (call.depth * 200),
        y: 100 + (index * 100),
        calls: [methodCall],
        isAsync: methodCall.execution_context.is_async,
        isConditional: methodCall.execution_context.is_conditional,
        isLoop: methodCall.execution_context.is_in_loop,
        isHotPath: methodCall.performance_hints.is_hot_path,
        isBottleneck: methodCall.performance_hints.is_potential_bottleneck
      };

      flowNodes.push(flowNode);
      nodeMap.set(call.call_id, flowNode);

      if (index > 0) {
        const prevCall = chain.call_path[index - 1];
        flowEdges.push({
          source: prevCall.call_id,
          target: call.call_id,
          type: methodCall.execution_context.is_async ? 'async' :
                methodCall.execution_context.is_recursive ? 'recursive' :
                methodCall.target_node ? 'sync' : 'external',
          callCount: 1
        });
      }
    });

    return { nodes: flowNodes, edges: flowEdges };
  };

  const getRiskBadge = (riskLevel: string) => {
    const color = riskLevel === 'critical' ? 'error' :
                  riskLevel === 'high' ? 'error' :
                  riskLevel === 'medium' ? 'warning' : 'success';

    const icon = riskLevel === 'critical' || riskLevel === 'high' ? <Error /> :
                 riskLevel === 'medium' ? <Warning /> : <CheckCircle />;

    return (
      <Chip
        label={riskLevel.toUpperCase()}
        color={color}
        size="small"
        icon={icon}
      />
    );
  };

  const getChainTypeBadge = (chainType: string) => {
    const config: Record<string, { color: any; icon: JSX.Element }> = {
      'entry-to-exit': { color: 'primary', icon: <Timeline /> },
      'circular': { color: 'warning', icon: <Loop /> },
      'recursive': { color: 'error', icon: <Loop /> },
      'dead-end': { color: 'default', icon: <Warning /> },
      'hot-path': { color: 'error', icon: <Speed /> },
      'critical-path': { color: 'error', icon: <Security /> }
    };

    const { color, icon } = config[chainType] || { color: 'default', icon: <Code /> };

    return (
      <Chip
        label={chainType.replace('-', ' ').toUpperCase()}
        color={color}
        size="small"
        icon={icon}
        variant="outlined"
      />
    );
  };

  const renderChainsList = () => {
    return (
      <List>
        {filteredChains.map(chain => {
          const isExpanded = expandedChains.has(chain.id);

          return (
            <React.Fragment key={chain.id}>
              <ListItem
                button
                onClick={() => {
                  setExpandedChains(prev => {
                    const newSet = new Set(prev);
                    if (newSet.has(chain.id)) {
                      newSet.delete(chain.id);
                    } else {
                      newSet.add(chain.id);
                    }
                    return newSet;
                  });
                  setSelectedChain(chain);
                }}
                selected={selectedChain?.id === chain.id}
                sx={{
                  borderLeft: 4,
                  borderLeftColor: chain.risk_analysis.risk_level === 'critical' ? 'error.main' :
                                   chain.risk_analysis.risk_level === 'high' ? 'warning.main' :
                                   'primary.main'
                }}
              >
                <ListItemIcon>
                  <AccountTree color={chain.chain_type === 'hot-path' ? 'error' : 'primary'} />
                </ListItemIcon>

                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle2">
                        {chain.entry_point.method_name}
                      </Typography>
                      {chain.exit_point && (
                        <>
                          <Typography variant="caption" color="text.secondary">→</Typography>
                          <Typography variant="subtitle2">
                            {chain.exit_point.method_name}
                          </Typography>
                        </>
                      )}
                      {getChainTypeBadge(chain.chain_type)}
                      {getRiskBadge(chain.risk_analysis.risk_level)}
                    </Stack>
                  }
                  secondary={
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Typography variant="caption" color="text.secondary">
                        Calls: {chain.characteristics.total_calls}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Depth: {chain.characteristics.max_depth}
                      </Typography>
                      {chain.characteristics.has_external_calls && (
                        <Chip label="External" size="small" icon={<Cloud />} />
                      )}
                      {chain.characteristics.has_database_calls && (
                        <Chip label="Database" size="small" icon={<Storage />} />
                      )}
                      {chain.characteristics.has_async_calls && (
                        <Badge badgeContent="async" color="secondary">
                          <Chip label="Async" size="small" />
                        </Badge>
                      )}
                    </Stack>
                  }
                />

                <IconButton edge="end">
                  {isExpanded ? <ExpandLess /> : <ExpandMore />}
                </IconButton>
              </ListItem>

              <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                <Box sx={{ pl: 7, pr: 2, py: 2, backgroundColor: 'action.hover' }}>
                  <Stack spacing={2}>
                    {chain.business_context && (
                      <Card variant="outlined">
                        <CardContent>
                          <Typography variant="subtitle2" gutterBottom>
                            Business Context
                          </Typography>
                          <Stack spacing={1}>
                            {chain.business_context.user_action && (
                              <Typography variant="body2">
                                User Action: {chain.business_context.user_action}
                              </Typography>
                            )}
                            {chain.business_context.business_process && (
                              <Typography variant="body2">
                                Process: {chain.business_context.business_process}
                              </Typography>
                            )}
                            {chain.business_context.feature_area && (
                              <Typography variant="body2">
                                Feature: {chain.business_context.feature_area}
                              </Typography>
                            )}
                          </Stack>
                        </CardContent>
                      </Card>
                    )}

                    <Card variant="outlined">
                      <CardContent>
                        <Typography variant="subtitle2" gutterBottom>
                          Characteristics
                        </Typography>
                        <Stack direction="row" spacing={2} flexWrap="wrap">
                          <Typography variant="caption">
                            Complexity: {chain.characteristics.complexity_score}
                          </Typography>
                          {chain.characteristics.is_circular && (
                            <Chip label="Circular" size="small" color="warning" />
                          )}
                          {chain.characteristics.is_recursive && (
                            <Chip label="Recursive" size="small" color="error" />
                          )}
                        </Stack>
                      </CardContent>
                    </Card>

                    {chain.risk_analysis.bottlenecks && chain.risk_analysis.bottlenecks.length > 0 && (
                      <Card variant="outlined" sx={{ borderColor: 'error.main' }}>
                        <CardContent>
                          <Typography variant="subtitle2" color="error" gutterBottom>
                            Bottlenecks Detected
                          </Typography>
                          <List dense>
                            {chain.risk_analysis.bottlenecks.map((bottleneck, index) => (
                              <ListItem key={index}>
                                <ListItemText
                                  primary={bottleneck.method_name}
                                  secondary={
                                    <Stack spacing={0.5}>
                                      <Typography variant="caption">
                                        {bottleneck.reason}
                                      </Typography>
                                      <Chip
                                        label={`Impact: ${bottleneck.impact}`}
                                        size="small"
                                        color={bottleneck.impact === 'high' ? 'error' :
                                               bottleneck.impact === 'medium' ? 'warning' : 'default'}
                                      />
                                    </Stack>
                                  }
                                />
                              </ListItem>
                            ))}
                          </List>
                        </CardContent>
                      </Card>
                    )}

                    <Typography variant="subtitle2">Call Path</Typography>
                    <List dense>
                      {chain.call_path.map((call, index) => (
                        <ListItem
                          key={index}
                          button
                          onClick={() => onNodeClick?.(call.node_id)}
                          sx={{ pl: call.depth * 2 }}
                        >
                          <ListItemIcon>
                            <Code fontSize="small" />
                          </ListItemIcon>
                          <ListItemText
                            primary={call.method_name}
                            secondary={`Depth: ${call.depth}${call.execution_branch ? ` | Branch: ${call.execution_branch}` : ''}`}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Stack>
                </Box>
              </Collapse>
            </React.Fragment>
          );
        })}
      </List>
    );
  };

  const renderFlowVisualization = () => {
    if (!selectedChain) {
      return (
        <Alert severity="info">
          <AlertTitle>No Chain Selected</AlertTitle>
          Select a call chain from the list to visualize its flow.
        </Alert>
      );
    }

    const { nodes: flowNodes, edges: flowEdges } = buildFlowGraph(selectedChain);

    return (
      <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 1200 ${flowNodes.length * 120 + 200}`}
          style={{ transform: `scale(${zoomLevel})` }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
            >
              <polygon
                points="0 0, 10 3, 0 6"
                fill="#666"
              />
            </marker>

            <marker
              id="arrowhead-async"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
            >
              <polygon
                points="0 0, 10 3, 0 6"
                fill="#9c27b0"
              />
            </marker>
          </defs>

          {flowEdges.map((edge, index) => {
            const sourceNode = flowNodes.find(n => n.id === edge.source);
            const targetNode = flowNodes.find(n => n.id === edge.target);
            if (!sourceNode || !targetNode) return null;

            const isAsync = edge.type === 'async';
            const strokeColor = isAsync ? FLOW_COLORS.async :
                               edge.type === 'recursive' ? FLOW_COLORS.recursive :
                               edge.type === 'external' ? FLOW_COLORS.external : '#666';

            return (
              <g key={index}>
                <path
                  d={`M ${sourceNode.x + 80} ${sourceNode.y + 25}
                      Q ${(sourceNode.x + targetNode.x) / 2 + 100} ${(sourceNode.y + targetNode.y) / 2}
                      ${targetNode.x} ${targetNode.y + 25}`}
                  stroke={strokeColor}
                  strokeWidth={2}
                  strokeDasharray={isAsync ? '5,5' : undefined}
                  fill="none"
                  markerEnd={isAsync ? 'url(#arrowhead-async)' : 'url(#arrowhead)'}
                />
              </g>
            );
          })}

          {flowNodes.map(node => {
            const fillColor = node.type === 'entry' ? FLOW_COLORS.entry :
                             node.type === 'exit' ? FLOW_COLORS.exit :
                             node.type === 'external' ? FLOW_COLORS.external :
                             node.isBottleneck ? FLOW_COLORS.bottleneck :
                             node.isHotPath ? FLOW_COLORS.hotPath :
                             FLOW_COLORS.internal;

            return (
              <g key={node.id}>
                <rect
                  x={node.x}
                  y={node.y}
                  width={160}
                  height={50}
                  rx={5}
                  fill={fillColor}
                  fillOpacity={0.9}
                  stroke={node.nodeId === selectedNodeId ? '#000' : fillColor}
                  strokeWidth={node.nodeId === selectedNodeId ? 3 : 1}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onNodeClick?.(node.nodeId)}
                />

                <text
                  x={node.x + 80}
                  y={node.y + 25}
                  textAnchor="middle"
                  fill="white"
                  fontSize="12"
                  fontWeight="bold"
                >
                  {node.name.length > 20 ? node.name.substring(0, 17) + '...' : node.name}
                </text>

                {node.isAsync && (
                  <text
                    x={node.x + 150}
                    y={node.y + 10}
                    fill="white"
                    fontSize="10"
                  >
                    async
                  </text>
                )}

                {node.isLoop && (
                  <circle
                    cx={node.x + 10}
                    cy={node.y + 10}
                    r={5}
                    fill="white"
                  />
                )}

                {node.isBottleneck && (
                  <text
                    x={node.x + 80}
                    y={node.y + 40}
                    textAnchor="middle"
                    fill="white"
                    fontSize="10"
                  >
                    BOTTLENECK
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <Stack
          direction="row"
          spacing={1}
          sx={{
            position: 'absolute',
            top: 10,
            right: 10
          }}
        >
          <IconButton onClick={() => setZoomLevel(prev => Math.max(0.5, prev - 0.1))}>
            <ZoomOut />
          </IconButton>
          <IconButton onClick={() => setZoomLevel(1)}>
            <CenterFocusStrong />
          </IconButton>
          <IconButton onClick={() => setZoomLevel(prev => Math.min(2, prev + 0.1))}>
            <ZoomIn />
          </IconButton>
        </Stack>
      </Box>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Paper elevation={0} sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={(_, value) => value && setViewMode(value)}
            size="small"
          >
            <ToggleButton value="chains">
              <Tooltip title="Call Chains List">
                <AccountTree />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="flow">
              <Tooltip title="Flow Visualization">
                <DeviceHub />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="timeline">
              <Tooltip title="Timeline View">
                <Timeline />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>

          <ToggleButtonGroup
            value={filterMode}
            exclusive
            onChange={(_, value) => value && setFilterMode(value)}
            size="small"
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="critical">Critical</ToggleButton>
            <ToggleButton value="hotPath">Hot Paths</ToggleButton>
            <ToggleButton value="recursive">Recursive</ToggleButton>
          </ToggleButtonGroup>

          <Stack direction="row" spacing={1}>
            <IconButton
              color={showExternalCalls ? 'primary' : 'default'}
              onClick={() => setShowExternalCalls(!showExternalCalls)}
            >
              <Cloud />
            </IconButton>
            <IconButton
              color={showAsyncCalls ? 'primary' : 'default'}
              onClick={() => setShowAsyncCalls(!showAsyncCalls)}
            >
              <Loop />
            </IconButton>
          </Stack>
        </Stack>
      </Paper>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {viewMode === 'chains' && renderChainsList()}
        {viewMode === 'flow' && renderFlowVisualization()}
        {viewMode === 'timeline' && (
          <Alert severity="info" sx={{ m: 2 }}>
            <AlertTitle>Timeline View</AlertTitle>
            Timeline visualization coming soon.
          </Alert>
        )}
      </Box>
    </Box>
  );
};

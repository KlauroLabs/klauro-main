import React, { useMemo } from 'react';
import {
  Box,
  Typography,
  Stack,
  IconButton,
  Paper,
  Chip,
  Card,
  CardContent,
  CardActionArea,
  Divider,
  Alert,
  AlertTitle,
} from '@mui/material';
import {
  ArrowBack,
  Lock,
  LockOpen,
  ArrowDownward,
  Storage,
  Cloud,
  Code,
  PlayArrow,
  Stop,
} from '@mui/icons-material';
import { CASNode, CASEdge, ExitPoint } from '../types';
import { Capability, FlowStep, buildFlowSteps } from '../utils/domainExtractor';
import { CallTree } from '../components/CallTree';
import { NodeStyle, getStyleForNodeType } from '../utils/dynamicStyling';

export interface FlowViewProps {
  capability: Capability;
  nodes: CASNode[];
  edges: CASEdge[];
  exitPoints?: ExitPoint[];
  nodeStyles?: Map<string, NodeStyle>;
  onBack: () => void;
  onStepClick: (step: FlowStep) => void;
  onNodeClick: (nodeId: string) => void;
  onExitPointClick?: (exitPoint: ExitPoint, sourceNodeId: string) => void;
}

function getStepColor(nodeType: string, nodeStyles?: Map<string, NodeStyle>): string {
  if (nodeStyles?.has(nodeType)) {
    return nodeStyles.get(nodeType)!.color;
  }
  return getStyleForNodeType(nodeType).color;
}

export const FlowView: React.FC<FlowViewProps> = ({
  capability,
  nodes,
  edges,
  exitPoints = [],
  nodeStyles,
  onBack,
  onStepClick,
  onNodeClick,
  onExitPointClick,
}) => {
  const flow = capability.flow;
  const precomputedSteps = capability.flowSteps;

  const steps = useMemo(() => {
    if (precomputedSteps && precomputedSteps.length > 0) {
      return precomputedSteps;
    }
    if (!flow) return [];
    return buildFlowSteps(flow, nodes);
  }, [flow, precomputedSteps, nodes]);

  const entryNodeId = useMemo(() => {
    if (flow && flow.entry_point?.node_id) {
      return flow.entry_point.node_id;
    }
    if (steps.length > 0) {
      return steps[0].nodeId;
    }
    const handlerMethod = capability.entryPoint?.handler?.method_name;
    const entryNode = nodes.find(n => n.name === handlerMethod);
    return entryNode?.id;
  }, [flow, steps, nodes, capability.entryPoint?.handler?.method_name]);

  const hasFlow = !!entryNodeId || steps.length > 0;

  const flowStats = useMemo(() => {
    if (flow) {
      return {
        totalSteps: flow.characteristics.total_calls,
        maxDepth: flow.characteristics.max_depth,
        hasDatabase: flow.characteristics.has_database_calls,
        hasAsync: flow.characteristics.has_async_calls,
        hasExternal: flow.characteristics.has_external_calls,
        riskLevel: flow.risk_analysis.risk_level,
        bottlenecks: flow.risk_analysis.bottlenecks || [],
      };
    }
    if (steps.length > 0) {
      const maxDepth = Math.max(...steps.map(s => s.depth));
      return {
        totalSteps: steps.length,
        maxDepth,
        hasDatabase: steps.some(s => s.nodeType === 'repository'),
        hasAsync: false,
        hasExternal: steps.some(s => s.isExit && s.nodeType !== 'repository'),
        riskLevel: 'low' as const,
        bottlenecks: [],
      };
    }
    return null;
  }, [flow, steps]);

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Paper sx={{ p: 3, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="flex-start">
          <IconButton onClick={onBack}>
            <ArrowBack />
          </IconButton>
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h5" fontWeight={700}>
                {capability.name}
              </Typography>
              {capability.requiresAuth ? (
                <Chip icon={<Lock />} label="Authenticated" color="success" size="small" />
              ) : (
                <Chip icon={<LockOpen />} label="Public" color="warning" size="small" />
              )}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip
                label={capability.method}
                size="small"
                color="primary"
                sx={{ fontWeight: 600 }}
              />
              <Typography variant="body1" fontFamily="monospace" color="text.secondary">
                {capability.path}
              </Typography>
            </Stack>
          </Box>
        </Stack>

        {flowStats && (
          <Stack direction="row" spacing={3} sx={{ mt: 3 }}>
            <Box>
              <Typography variant="h6" fontWeight={600}>
                {flowStats.totalSteps}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Steps
              </Typography>
            </Box>
            <Divider orientation="vertical" flexItem />
            <Box>
              <Typography variant="h6" fontWeight={600}>
                {flowStats.maxDepth}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Max Depth
              </Typography>
            </Box>
            {flowStats.hasDatabase && (
              <>
                <Divider orientation="vertical" flexItem />
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Storage color="secondary" fontSize="small" />
                  <Typography variant="body2">Database</Typography>
                </Stack>
              </>
            )}
            {flowStats.hasAsync && (
              <>
                <Divider orientation="vertical" flexItem />
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Cloud color="info" fontSize="small" />
                  <Typography variant="body2">Async</Typography>
                </Stack>
              </>
            )}
          </Stack>
        )}
      </Paper>

      <Box sx={{ p: 3 }}>
        {!hasFlow ? (
          <Alert severity="info">
            <AlertTitle>Flow Not Available</AlertTitle>
            The call chain for this operation has not been analyzed yet.
            This could mean the operation is simple or the analysis is incomplete.
          </Alert>
        ) : (
          <>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
              How does this work?
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Follow the journey of a request from when it arrives to when it completes.
              Click any step to see more details.
            </Typography>

            {flowStats && flowStats.bottlenecks.length > 0 && (
              <Alert severity="warning" sx={{ mb: 3 }}>
                <AlertTitle>Potential Bottlenecks Detected</AlertTitle>
                <Stack spacing={1}>
                  {flowStats.bottlenecks.map((b, i) => (
                    <Box key={i}>
                      <Typography variant="body2" fontWeight={500}>
                        {b.method_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {b.reason}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </Alert>
            )}

            <Paper variant="outlined" sx={{ p: 2 }}>
              {entryNodeId ? (
                <CallTree
                  rootNodeId={entryNodeId}
                  nodes={nodes}
                  edges={edges}
                  exitPoints={exitPoints}
                  onNodeClick={onNodeClick}
                  onExitPointClick={onExitPointClick}
                  maxDepth={15}
                />
              ) : (
                <Alert severity="info">
                  <AlertTitle>No Entry Point Found</AlertTitle>
                  Unable to determine the starting point for this flow.
                </Alert>
              )}
            </Paper>
          </>
        )}
      </Box>
    </Box>
  );
};

interface FlowStepCardProps {
  step: FlowStep;
  index: number;
  totalSteps: number;
  nodeStyles?: Map<string, NodeStyle>;
  onClick: () => void;
}

const FlowStepCard: React.FC<FlowStepCardProps> = ({
  step,
  index,
  totalSteps,
  nodeStyles,
  onClick,
}) => {
  const stepColor = getStepColor(step.nodeType, nodeStyles);
  const isFirst = index === 0;
  const isLast = index === totalSteps - 1;

  return (
    <Box sx={{ position: 'relative', mb: 2 }}>
      <Box
        sx={{
          position: 'absolute',
          left: -25,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 24,
          height: 24,
          borderRadius: '50%',
          bgcolor: isFirst ? 'success.main' : isLast ? 'error.main' : stepColor,
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1,
        }}
      >
        {isFirst ? (
          <PlayArrow sx={{ fontSize: 14 }} />
        ) : isLast ? (
          <Stop sx={{ fontSize: 14 }} />
        ) : (
          <Typography variant="caption" fontWeight={600}>
            {index + 1}
          </Typography>
        )}
      </Box>

      <Card
        variant="outlined"
        sx={{
          ml: 2,
          transition: 'all 0.2s ease',
          '&:hover': {
            boxShadow: 2,
            borderColor: stepColor,
          },
        }}
      >
        <CardActionArea onClick={onClick}>
          <CardContent>
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <Box
                sx={{
                  width: 40,
                  height: 40,
                  borderRadius: 1,
                  bgcolor: `${stepColor}15`,
                  color: stepColor,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Code />
              </Box>
              <Box sx={{ flex: 1 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="subtitle1" fontWeight={600}>
                    {step.nodeName}
                  </Typography>
                  <Chip
                    label={step.nodeType}
                    size="small"
                    sx={{
                      bgcolor: `${stepColor}20`,
                      color: stepColor,
                      height: 20,
                      fontSize: '0.65rem',
                    }}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {step.name}
                </Typography>
                {step.description && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {step.description}
                  </Typography>
                )}
                {step.source && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    fontFamily="monospace"
                    sx={{ display: 'block', mt: 1 }}
                  >
                    {step.source.file.split('/').pop()}:{step.source.line}
                  </Typography>
                )}
              </Box>
            </Stack>
          </CardContent>
        </CardActionArea>
      </Card>

      {!isLast && (
        <Box
          sx={{
            position: 'absolute',
            left: -13,
            bottom: -8,
            color: 'text.disabled',
          }}
        >
          <ArrowDownward fontSize="small" />
        </Box>
      )}
    </Box>
  );
};

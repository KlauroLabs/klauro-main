import React, { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Chip,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Collapse,
  LinearProgress,
  TextField,
  InputAdornment,
  Tooltip,
} from '@mui/material';
import {
  ArrowBack,
  Timeline,
  Search,
  ExpandMore,
  ExpandLess,
  Speed,
  ErrorOutline,
  CheckCircle,
  Warning,
  Science,
  Hub,
  Storage,
  Cloud,
  PlayArrow,
} from '@mui/icons-material';
import { CASOutput, CASCallChain, CASNode, EntryPoint } from '../types';

export interface CriticalFlowsViewProps {
  cas: CASOutput;
  onBack: () => void;
  onNodeSelect?: (nodeId: string) => void;
  onFlowSelect?: (chain: CASCallChain) => void;
}

const CRITICALITY_COLORS: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

const CRITICALITY_ORDER = ['critical', 'high', 'medium', 'low'];

export const CriticalFlowsView: React.FC<CriticalFlowsViewProps> = ({
  cas,
  onBack,
  onNodeSelect,
  onFlowSelect,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFlows, setExpandedFlows] = useState<Set<string>>(new Set());
  const [criticalityFilter, setCriticalityFilter] = useState<string | null>(null);

  const callChains = cas.call_chains || [];
  const nodes = cas.nodes || [];
  const entryPoints = cas.entry_points || [];
  const flowSummary = cas.flow_summary;
  const flowCoverage = cas.flow_coverage || [];

  const nodeMap = useMemo(() => {
    const map = new Map<string, CASNode>();
    nodes.forEach(n => map.set(n.id, n));
    return map;
  }, [nodes]);

  const entryPointMap = useMemo(() => {
    const map = new Map<string, EntryPoint>();
    entryPoints.forEach(ep => map.set(ep.id, ep));
    return map;
  }, [entryPoints]);

  const flowCoverageMap = useMemo(() => {
    const map = new Map<string, typeof flowCoverage[0]>();
    flowCoverage.forEach(fc => map.set(fc.call_chain_id, fc));
    return map;
  }, [flowCoverage]);

  const flowsByCategory = useMemo(() => {
    const filtered = callChains.filter(chain => {
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const entryNode = nodeMap.get(chain.entry_point.node_id);
        const entryPointData = chain.entry_point.entry_point_id
          ? entryPointMap.get(chain.entry_point.entry_point_id)
          : null;

        const matchesQuery =
          chain.entry_point.method_name.toLowerCase().includes(query) ||
          entryNode?.name.toLowerCase().includes(query) ||
          entryPointData?.protocol_details?.path?.toLowerCase().includes(query) ||
          chain.business_context?.user_action?.toLowerCase().includes(query) ||
          chain.business_context?.feature_area?.toLowerCase().includes(query);

        if (!matchesQuery) return false;
      }

      if (criticalityFilter && chain.criticality !== criticalityFilter) {
        return false;
      }

      return true;
    });

    const grouped: Record<string, CASCallChain[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    filtered.forEach(chain => {
      const crit = chain.criticality || 'low';
      grouped[crit].push(chain);
    });

    return grouped;
  }, [callChains, searchQuery, criticalityFilter, nodeMap, entryPointMap]);

  const toggleExpanded = (chainId: string) => {
    const newExpanded = new Set(expandedFlows);
    if (newExpanded.has(chainId)) {
      newExpanded.delete(chainId);
    } else {
      newExpanded.add(chainId);
    }
    setExpandedFlows(newExpanded);
  };

  const getFlowCounts = () => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    callChains.forEach(chain => {
      const crit = chain.criticality || 'low';
      counts[crit as keyof typeof counts]++;
      counts.total++;
    });
    return counts;
  };

  const counts = getFlowCounts();

  return (
    <Box sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 3, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <IconButton onClick={onBack}>
            <ArrowBack />
          </IconButton>
          <Timeline color="primary" />
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5" fontWeight={700}>
              Critical Flows
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {counts.total} call chains analyzed
            </Typography>
          </Box>
        </Stack>

        {flowSummary && (
          <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
            <Box>
              <Typography variant="h4" fontWeight={700} color="error.main">
                {flowSummary.total_critical_flows}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Critical Flows
              </Typography>
            </Box>
            {flowSummary.untested_critical_flows.length > 0 && (
              <Box>
                <Typography variant="h4" fontWeight={700} color="warning.main">
                  {flowSummary.untested_critical_flows.length}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Untested Critical
                </Typography>
              </Box>
            )}
            {flowSummary.high_error_rate_flows.length > 0 && (
              <Box>
                <Typography variant="h4" fontWeight={700} color="error.dark">
                  {flowSummary.high_error_rate_flows.length}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  High Error Rate
                </Typography>
              </Box>
            )}
          </Stack>
        )}

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          {counts.critical > 0 && (
            <Chip
              label={`${counts.critical} Critical`}
              color="error"
              variant={criticalityFilter === 'critical' ? 'filled' : 'outlined'}
              onClick={() => setCriticalityFilter(criticalityFilter === 'critical' ? null : 'critical')}
            />
          )}
          {counts.high > 0 && (
            <Chip
              label={`${counts.high} High`}
              color="warning"
              variant={criticalityFilter === 'high' ? 'filled' : 'outlined'}
              onClick={() => setCriticalityFilter(criticalityFilter === 'high' ? null : 'high')}
            />
          )}
          {counts.medium > 0 && (
            <Chip
              label={`${counts.medium} Medium`}
              color="info"
              variant={criticalityFilter === 'medium' ? 'filled' : 'outlined'}
              onClick={() => setCriticalityFilter(criticalityFilter === 'medium' ? null : 'medium')}
            />
          )}
          {counts.low > 0 && (
            <Chip
              label={`${counts.low} Low`}
              variant={criticalityFilter === 'low' ? 'filled' : 'outlined'}
              onClick={() => setCriticalityFilter(criticalityFilter === 'low' ? null : 'low')}
            />
          )}
        </Stack>

        <TextField
          size="small"
          placeholder="Search by method, path, or feature area..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          sx={{ width: 350 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <Search fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      </Paper>

      <Box sx={{ p: 3 }}>
        {CRITICALITY_ORDER.map(criticality => {
          const chains = flowsByCategory[criticality];
          if (chains.length === 0) return null;

          return (
            <Box key={criticality} sx={{ mb: 4 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Chip
                  label={criticality.charAt(0).toUpperCase() + criticality.slice(1)}
                  color={CRITICALITY_COLORS[criticality]}
                  size="small"
                />
                <Typography variant="body2" color="text.secondary">
                  {chains.length} flow{chains.length !== 1 ? 's' : ''}
                </Typography>
              </Stack>

              <List disablePadding>
                {chains.map(chain => (
                  <FlowItem
                    key={chain.id}
                    chain={chain}
                    nodeMap={nodeMap}
                    entryPointMap={entryPointMap}
                    flowCoverage={flowCoverageMap.get(chain.id)}
                    expanded={expandedFlows.has(chain.id)}
                    onToggle={() => toggleExpanded(chain.id)}
                    onNodeSelect={onNodeSelect}
                    onFlowSelect={onFlowSelect}
                  />
                ))}
              </List>
            </Box>
          );
        })}

        {Object.values(flowsByCategory).every(arr => arr.length === 0) && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Timeline sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              No Flows Found
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {searchQuery || criticalityFilter
                ? 'No flows match your current filters.'
                : 'No call chains have been analyzed for this codebase.'}
            </Typography>
          </Paper>
        )}
      </Box>
    </Box>
  );
};

interface FlowItemProps {
  chain: CASCallChain;
  nodeMap: Map<string, CASNode>;
  entryPointMap: Map<string, EntryPoint>;
  flowCoverage?: {
    coverage_status: string;
    coverage_percentage?: number;
    tested_segments: Array<{ node_id: string; test_ids: string[]; assertion_count: number }>;
    untested_segments: Array<{ node_id: string; importance: string; reason: string }>;
    test_quality: { has_unit_tests: boolean; has_integration_tests: boolean; has_e2e_tests: boolean };
  };
  expanded: boolean;
  onToggle: () => void;
  onNodeSelect?: (nodeId: string) => void;
  onFlowSelect?: (chain: CASCallChain) => void;
}

const FlowItem: React.FC<FlowItemProps> = ({
  chain,
  nodeMap,
  entryPointMap,
  flowCoverage,
  expanded,
  onToggle,
  onNodeSelect,
  onFlowSelect,
}) => {
  const entryNode = nodeMap.get(chain.entry_point.node_id);
  const entryPointData = chain.entry_point.entry_point_id
    ? entryPointMap.get(chain.entry_point.entry_point_id)
    : null;

  const httpMethod = entryPointData?.protocol_details?.method;
  const httpPath = entryPointData?.protocol_details?.path;

  return (
    <Paper variant="outlined" sx={{ mb: 1 }}>
      <ListItemButton onClick={onToggle}>
        <ListItemIcon sx={{ minWidth: 40 }}>
          {expanded ? <ExpandLess /> : <ExpandMore />}
        </ListItemIcon>
        <ListItemText
          primary={
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              {httpMethod && httpPath ? (
                <>
                  <Chip
                    label={httpMethod}
                    size="small"
                    sx={{
                      height: 20,
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      bgcolor: httpMethod === 'GET' ? 'success.light' :
                               httpMethod === 'POST' ? 'info.light' :
                               httpMethod === 'PUT' ? 'warning.light' :
                               httpMethod === 'DELETE' ? 'error.light' : 'grey.300',
                    }}
                  />
                  <Typography variant="subtitle2" fontFamily="monospace">
                    {httpPath}
                  </Typography>
                </>
              ) : (
                <Typography variant="subtitle2">
                  {chain.entry_point.method_name}
                </Typography>
              )}
              {chain.criticality && (
                <Chip
                  label={chain.criticality}
                  size="small"
                  color={CRITICALITY_COLORS[chain.criticality]}
                  sx={{ height: 18, fontSize: '0.6rem' }}
                />
              )}
            </Stack>
          }
          secondary={
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {chain.characteristics.total_calls} calls, depth {chain.characteristics.max_depth}
              </Typography>
              {chain.runtime_stats && (
                <>
                  {chain.runtime_stats.traffic_volume && (
                    <Tooltip title="Traffic Volume">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Speed sx={{ fontSize: 14 }} color="action" />
                        <Typography variant="caption">
                          {chain.runtime_stats.traffic_volume}
                        </Typography>
                      </Stack>
                    </Tooltip>
                  )}
                  {chain.runtime_stats.error_rate_percent !== undefined && (
                    <Tooltip title="Error Rate">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <ErrorOutline
                          sx={{ fontSize: 14 }}
                          color={chain.runtime_stats.error_rate_percent > 5 ? 'error' : 'action'}
                        />
                        <Typography variant="caption">
                          {chain.runtime_stats.error_rate_percent.toFixed(1)}%
                        </Typography>
                      </Stack>
                    </Tooltip>
                  )}
                </>
              )}
              {flowCoverage && (
                <Tooltip title={`Test Coverage: ${flowCoverage.coverage_status}`}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Science
                      sx={{ fontSize: 14 }}
                      color={flowCoverage.coverage_status === 'fully-covered' ? 'success' :
                             flowCoverage.coverage_status === 'partially-covered' ? 'warning' : 'error'}
                    />
                    {flowCoverage.coverage_percentage !== undefined && (
                      <Typography variant="caption">
                        {flowCoverage.coverage_percentage}%
                      </Typography>
                    )}
                  </Stack>
                </Tooltip>
              )}
              {chain.characteristics.has_database_calls && (
                <Tooltip title="Has Database Calls">
                  <Storage sx={{ fontSize: 14 }} color="action" />
                </Tooltip>
              )}
              {chain.characteristics.has_external_calls && (
                <Tooltip title="Has External Calls">
                  <Cloud sx={{ fontSize: 14 }} color="action" />
                </Tooltip>
              )}
            </Stack>
          }
        />
      </ListItemButton>

      <Collapse in={expanded}>
        <Box sx={{ px: 3, pb: 2 }}>
          {chain.business_context && (
            <Box sx={{ mb: 2 }}>
              {chain.business_context.user_action && (
                <Typography variant="body2" color="text.secondary">
                  <strong>User Action:</strong> {chain.business_context.user_action}
                </Typography>
              )}
              {chain.business_context.feature_area && (
                <Typography variant="body2" color="text.secondary">
                  <strong>Feature Area:</strong> {chain.business_context.feature_area}
                </Typography>
              )}
            </Box>
          )}

          {chain.criticality_factors && chain.criticality_factors.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                Criticality Factors
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {chain.criticality_factors.map((factor, idx) => (
                  <Chip key={idx} label={factor} size="small" variant="outlined" sx={{ height: 20 }} />
                ))}
              </Stack>
            </Box>
          )}

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Call Path ({chain.call_path.length} steps)
          </Typography>
          <Stack spacing={0.5}>
            {chain.call_path.slice(0, 8).map((step, idx) => {
              const stepNode = nodeMap.get(step.node_id);
              return (
                <Stack
                  key={step.call_id || idx}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{
                    pl: step.depth,
                    cursor: onNodeSelect ? 'pointer' : 'default',
                    '&:hover': onNodeSelect ? { bgcolor: 'action.hover' } : {},
                    borderRadius: 1,
                    py: 0.25,
                  }}
                  onClick={() => onNodeSelect?.(step.node_id)}
                >
                  <PlayArrow sx={{ fontSize: 12, color: 'text.disabled' }} />
                  <Typography variant="caption" fontFamily="monospace">
                    {step.method_name}
                  </Typography>
                  {stepNode && (
                    <Typography variant="caption" color="text.secondary">
                      ({stepNode.type})
                    </Typography>
                  )}
                </Stack>
              );
            })}
            {chain.call_path.length > 8 && (
              <Typography variant="caption" color="text.secondary" sx={{ pl: 2 }}>
                ... and {chain.call_path.length - 8} more steps
              </Typography>
            )}
          </Stack>

          {chain.risk_analysis.risk_level !== 'low' && (
            <Box sx={{ mt: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Warning sx={{ fontSize: 16 }} color={chain.risk_analysis.risk_level === 'critical' ? 'error' : 'warning'} />
                <Typography variant="caption" fontWeight={600}>
                  Risk: {chain.risk_analysis.risk_level}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {chain.risk_analysis.risk_factors.map((factor, idx) => (
                  <Chip
                    key={idx}
                    label={factor}
                    size="small"
                    color={chain.risk_analysis.risk_level === 'critical' ? 'error' : 'warning'}
                    variant="outlined"
                    sx={{ height: 18, fontSize: '0.6rem' }}
                  />
                ))}
              </Stack>
            </Box>
          )}

          {flowCoverage && (
            <Box sx={{ mt: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Science sx={{ fontSize: 16 }} color="info" />
                <Typography variant="caption" fontWeight={600}>
                  Test Coverage
                </Typography>
                <Chip
                  label={flowCoverage.coverage_status.replace('-', ' ')}
                  size="small"
                  color={flowCoverage.coverage_status === 'fully-covered' ? 'success' :
                         flowCoverage.coverage_status === 'partially-covered' ? 'warning' : 'error'}
                  sx={{ height: 18, fontSize: '0.6rem' }}
                />
              </Stack>
              {flowCoverage.coverage_percentage !== undefined && (
                <Box sx={{ width: '100%', mb: 1 }}>
                  <LinearProgress
                    variant="determinate"
                    value={flowCoverage.coverage_percentage}
                    color={flowCoverage.coverage_percentage >= 80 ? 'success' :
                           flowCoverage.coverage_percentage >= 50 ? 'warning' : 'error'}
                    sx={{ height: 6, borderRadius: 1 }}
                  />
                </Box>
              )}
              <Stack direction="row" spacing={1}>
                {flowCoverage.test_quality.has_unit_tests && (
                  <Chip label="Unit" size="small" variant="outlined" sx={{ height: 16, fontSize: '0.55rem' }} />
                )}
                {flowCoverage.test_quality.has_integration_tests && (
                  <Chip label="Integration" size="small" variant="outlined" sx={{ height: 16, fontSize: '0.55rem' }} />
                )}
                {flowCoverage.test_quality.has_e2e_tests && (
                  <Chip label="E2E" size="small" variant="outlined" sx={{ height: 16, fontSize: '0.55rem' }} />
                )}
              </Stack>
            </Box>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

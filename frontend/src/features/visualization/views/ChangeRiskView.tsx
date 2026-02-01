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
  TextField,
  InputAdornment,
  Tooltip,
  Divider,
} from '@mui/material';
import {
  ArrowBack,
  Security,
  Search,
  ExpandMore,
  ExpandLess,
  Warning,
  Error as ErrorIcon,
  CheckCircle,
  BugReport,
  Science,
  Code,
  CallSplit,
  Timeline,
  TrendingUp,
  Group,
} from '@mui/icons-material';
import { CASOutput, CASChangeRisk, CASNode, CASCallChain } from '../types';

export interface ChangeRiskViewProps {
  cas: CASOutput;
  onBack: () => void;
  onNodeSelect?: (nodeId: string) => void;
}

const RISK_COLORS: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

const RISK_ORDER = ['critical', 'high', 'medium', 'low'];

export const ChangeRiskView: React.FC<ChangeRiskViewProps> = ({
  cas,
  onBack,
  onNodeSelect,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [riskFilter, setRiskFilter] = useState<string | null>(null);

  const changeRisks = cas.change_risks || [];
  const changeRiskSummary = cas.change_risk_summary;
  const nodes = cas.nodes || [];
  const callChains = cas.call_chains || [];

  const nodeMap = useMemo(() => {
    const map = new Map<string, CASNode>();
    nodes.forEach(n => map.set(n.id, n));
    return map;
  }, [nodes]);

  const callChainMap = useMemo(() => {
    const map = new Map<string, CASCallChain>();
    callChains.forEach(c => map.set(c.id, c));
    return map;
  }, [callChains]);

  const risksByLevel = useMemo(() => {
    const filtered = changeRisks.filter(risk => {
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const node = nodeMap.get(risk.node_id);

        const matchesQuery =
          node?.name.toLowerCase().includes(query) ||
          node?.source?.file?.toLowerCase().includes(query) ||
          risk.risk_factors.some(f => f.details.toLowerCase().includes(query));

        if (!matchesQuery) return false;
      }

      if (riskFilter && risk.risk_level !== riskFilter) {
        return false;
      }

      return true;
    });

    const grouped: Record<string, CASChangeRisk[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    filtered.forEach(risk => {
      grouped[risk.risk_level].push(risk);
    });

    return grouped;
  }, [changeRisks, searchQuery, riskFilter, nodeMap]);

  const toggleExpanded = (nodeId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
  };

  const getRiskCounts = () => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    changeRisks.forEach(risk => {
      counts[risk.risk_level as keyof typeof counts]++;
      counts.total++;
    });
    return counts;
  };

  const counts = getRiskCounts();

  return (
    <Box sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 3, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <IconButton onClick={onBack}>
            <ArrowBack />
          </IconButton>
          <Security color="warning" />
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5" fontWeight={700}>
              Change Impact & Risk
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {counts.total} nodes analyzed for change risk
            </Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h4" fontWeight={700} color="error.main">
              {counts.critical + counts.high}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              High Risk Nodes
            </Typography>
          </Box>
          {changeRiskSummary?.untested_critical_paths && (
            <Box>
              <Typography variant="h4" fontWeight={700} color="warning.main">
                {changeRiskSummary.untested_critical_paths.length}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Untested Critical Paths
              </Typography>
            </Box>
          )}
          {changeRiskSummary?.recent_hotspots && (
            <Box>
              <Typography variant="h4" fontWeight={700} color="info.main">
                {changeRiskSummary.recent_hotspots.length}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Recent Hotspots
              </Typography>
            </Box>
          )}
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          {counts.critical > 0 && (
            <Chip
              icon={<ErrorIcon />}
              label={`${counts.critical} Critical`}
              color="error"
              variant={riskFilter === 'critical' ? 'filled' : 'outlined'}
              onClick={() => setRiskFilter(riskFilter === 'critical' ? null : 'critical')}
            />
          )}
          {counts.high > 0 && (
            <Chip
              icon={<Warning />}
              label={`${counts.high} High`}
              color="warning"
              variant={riskFilter === 'high' ? 'filled' : 'outlined'}
              onClick={() => setRiskFilter(riskFilter === 'high' ? null : 'high')}
            />
          )}
          {counts.medium > 0 && (
            <Chip
              label={`${counts.medium} Medium`}
              color="info"
              variant={riskFilter === 'medium' ? 'filled' : 'outlined'}
              onClick={() => setRiskFilter(riskFilter === 'medium' ? null : 'medium')}
            />
          )}
          {counts.low > 0 && (
            <Chip
              label={`${counts.low} Low`}
              variant={riskFilter === 'low' ? 'filled' : 'outlined'}
              onClick={() => setRiskFilter(riskFilter === 'low' ? null : 'low')}
            />
          )}
        </Stack>

        <TextField
          size="small"
          placeholder="Search by node name, file, or risk factor..."
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
        {RISK_ORDER.map(riskLevel => {
          const risks = risksByLevel[riskLevel];
          if (risks.length === 0) return null;

          return (
            <Box key={riskLevel} sx={{ mb: 4 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                {riskLevel === 'critical' && <ErrorIcon color="error" />}
                {riskLevel === 'high' && <Warning color="warning" />}
                {riskLevel === 'medium' && <Warning color="info" />}
                {riskLevel === 'low' && <CheckCircle color="success" />}
                <Typography variant="h6" fontWeight={600}>
                  {riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1)} Risk
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  ({risks.length} node{risks.length !== 1 ? 's' : ''})
                </Typography>
              </Stack>

              <List disablePadding>
                {risks.map(risk => (
                  <RiskNodeItem
                    key={risk.node_id}
                    risk={risk}
                    node={nodeMap.get(risk.node_id)}
                    callChainMap={callChainMap}
                    nodeMap={nodeMap}
                    expanded={expandedNodes.has(risk.node_id)}
                    onToggle={() => toggleExpanded(risk.node_id)}
                    onNodeSelect={onNodeSelect}
                  />
                ))}
              </List>
            </Box>
          );
        })}

        {Object.values(risksByLevel).every(arr => arr.length === 0) && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            {changeRisks.length === 0 ? (
              <>
                <Security sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
                <Typography variant="h6" gutterBottom>
                  No Risk Data Available
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Change risk analysis has not been performed for this codebase.
                </Typography>
              </>
            ) : (
              <>
                <CheckCircle sx={{ fontSize: 48, color: 'success.main', mb: 2 }} />
                <Typography variant="h6" gutterBottom>
                  No Matches Found
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  No nodes match your current filters.
                </Typography>
              </>
            )}
          </Paper>
        )}
      </Box>
    </Box>
  );
};

interface RiskNodeItemProps {
  risk: CASChangeRisk;
  node?: CASNode;
  callChainMap: Map<string, CASCallChain>;
  nodeMap: Map<string, CASNode>;
  expanded: boolean;
  onToggle: () => void;
  onNodeSelect?: (nodeId: string) => void;
}

const RiskNodeItem: React.FC<RiskNodeItemProps> = ({
  risk,
  node,
  callChainMap,
  nodeMap,
  expanded,
  onToggle,
  onNodeSelect,
}) => {
  const directCallerCount = risk.downstream_impact.direct_callers.length;
  const transitiveCallerCount = risk.downstream_impact.transitive_callers.length;
  const affectedChains = risk.downstream_impact.affected_call_chains.length;

  return (
    <Paper variant="outlined" sx={{ mb: 1 }}>
      <ListItemButton onClick={onToggle}>
        <ListItemIcon sx={{ minWidth: 40 }}>
          {expanded ? <ExpandLess /> : <ExpandMore />}
        </ListItemIcon>
        <ListItemText
          primary={
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2">
                {node?.name || risk.node_id}
              </Typography>
              <Chip
                label={risk.risk_level}
                size="small"
                color={RISK_COLORS[risk.risk_level]}
                sx={{ height: 20, fontSize: '0.65rem' }}
              />
            </Stack>
          }
          secondary={
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 0.5 }}>
              {node && (
                <>
                  <Typography variant="caption" color="text.secondary">
                    {node.type}
                  </Typography>
                  {node.source?.file && (
                    <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                      {node.source.file.split('/').pop()}
                    </Typography>
                  )}
                </>
              )}
              <Tooltip title="Direct Callers">
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <CallSplit sx={{ fontSize: 14 }} color="action" />
                  <Typography variant="caption">{directCallerCount}</Typography>
                </Stack>
              </Tooltip>
              <Tooltip title="Affected Call Chains">
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Timeline sx={{ fontSize: 14 }} color="action" />
                  <Typography variant="caption">{affectedChains}</Typography>
                </Stack>
              </Tooltip>
              {!risk.test_protection.has_direct_tests && (
                <Tooltip title="No Direct Tests">
                  <BugReport sx={{ fontSize: 14 }} color="warning" />
                </Tooltip>
              )}
            </Stack>
          }
        />
      </ListItemButton>

      <Collapse in={expanded}>
        <Box sx={{ px: 3, pb: 2 }}>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Risk Factors
          </Typography>
          <Stack spacing={0.5} sx={{ mb: 2 }}>
            {risk.risk_factors.map((factor, idx) => (
              <Stack key={idx} direction="row" spacing={1} alignItems="center">
                <Chip
                  label={factor.factor.replace(/-/g, ' ')}
                  size="small"
                  color={factor.severity === 'high' ? 'error' :
                         factor.severity === 'medium' ? 'warning' : 'default'}
                  variant="outlined"
                  sx={{ height: 20, fontSize: '0.6rem' }}
                />
                <Typography variant="caption" color="text.secondary">
                  {factor.details}
                </Typography>
              </Stack>
            ))}
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Downstream Impact
          </Typography>
          <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
            <Box>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Group sx={{ fontSize: 16 }} color="action" />
                <Typography variant="body2" fontWeight={600}>
                  {directCallerCount}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Direct Callers
              </Typography>
            </Box>
            <Box>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <TrendingUp sx={{ fontSize: 16 }} color="action" />
                <Typography variant="body2" fontWeight={600}>
                  {transitiveCallerCount}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Transitive Callers
              </Typography>
            </Box>
            <Box>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Timeline sx={{ fontSize: 16 }} color="action" />
                <Typography variant="body2" fontWeight={600}>
                  {affectedChains}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Affected Flows
              </Typography>
            </Box>
          </Stack>

          {risk.downstream_impact.direct_callers.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                Direct Callers
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {risk.downstream_impact.direct_callers.slice(0, 6).map(callerId => {
                  const callerNode = nodeMap.get(callerId);
                  return (
                    <Chip
                      key={callerId}
                      label={callerNode?.name || callerId}
                      size="small"
                      variant="outlined"
                      onClick={() => onNodeSelect?.(callerId)}
                      sx={{ height: 20, fontSize: '0.6rem', cursor: 'pointer' }}
                    />
                  );
                })}
                {risk.downstream_impact.direct_callers.length > 6 && (
                  <Typography variant="caption" color="text.secondary">
                    +{risk.downstream_impact.direct_callers.length - 6} more
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Test Protection
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <Chip
              icon={risk.test_protection.has_direct_tests ? <CheckCircle /> : <Warning />}
              label={risk.test_protection.has_direct_tests ? 'Has Direct Tests' : 'No Direct Tests'}
              size="small"
              color={risk.test_protection.has_direct_tests ? 'success' : 'warning'}
              variant="outlined"
              sx={{ height: 24 }}
            />
            <Chip
              icon={risk.test_protection.has_integration_tests ? <CheckCircle /> : <Warning />}
              label={risk.test_protection.has_integration_tests ? 'Has Integration Tests' : 'No Integration Tests'}
              size="small"
              color={risk.test_protection.has_integration_tests ? 'success' : 'default'}
              variant="outlined"
              sx={{ height: 24 }}
            />
          </Stack>

          {risk.test_protection.untested_callers && risk.test_protection.untested_callers.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="warning.main" display="block" sx={{ mb: 0.5 }}>
                Untested Callers ({risk.test_protection.untested_callers.length})
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {risk.test_protection.untested_callers.slice(0, 4).map(callerId => {
                  const callerNode = nodeMap.get(callerId);
                  return (
                    <Chip
                      key={callerId}
                      label={callerNode?.name || callerId}
                      size="small"
                      color="warning"
                      variant="outlined"
                      onClick={() => onNodeSelect?.(callerId)}
                      sx={{ height: 18, fontSize: '0.55rem', cursor: 'pointer' }}
                    />
                  );
                })}
              </Stack>
            </Box>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Stability Context
          </Typography>
          <Stack direction="row" spacing={2}>
            {risk.stability_context.recent_churn && (
              <Chip
                label="Recent Changes"
                size="small"
                color="warning"
                variant="outlined"
                sx={{ height: 20 }}
              />
            )}
            <Typography variant="caption" color="text.secondary">
              {risk.stability_context.commit_count_30d} commits in 30 days
            </Typography>
            {risk.stability_context.bug_fix_density > 0.3 && (
              <Chip
                label={`${(risk.stability_context.bug_fix_density * 100).toFixed(0)}% bug fixes`}
                size="small"
                color="error"
                variant="outlined"
                sx={{ height: 20 }}
              />
            )}
          </Stack>

          {risk.recommendations && risk.recommendations.length > 0 && (
            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'info.50', borderRadius: 1 }}>
              <Typography variant="caption" fontWeight={600} color="info.main" display="block" sx={{ mb: 0.5 }}>
                Recommendations
              </Typography>
              <Stack spacing={0.5}>
                {risk.recommendations.map((rec, idx) => (
                  <Typography key={idx} variant="caption">
                    {rec}
                  </Typography>
                ))}
              </Stack>
            </Box>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

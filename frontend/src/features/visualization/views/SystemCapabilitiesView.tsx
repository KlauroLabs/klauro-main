import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Tabs,
  Tab,
  Card,
  CardContent,
  CardActionArea,
  LinearProgress,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  Lightbulb as LightbulbIcon,
  AccountTree as AccountTreeIcon,
  Api as ApiIcon,
  Warning as WarningIcon,
  Build as BuildIcon,
  BugReport as BugReportIcon,
  Code as CodeIcon,
  Comment as CommentIcon,
  History as HistoryIcon,
  MergeType as MergeTypeIcon,
  ArrowForward as ArrowForwardIcon,
} from '@mui/icons-material';
import type { CASOutput, CASIntent, CASCallChain, SystemCapability, SystemPurpose } from '../../../types/cas.types';

export interface SystemCapabilitiesViewProps {
  data: CASOutput;
  onNodeSelect?: (nodeId: string) => void;
  onViewCriticalFlows?: () => void;
}

const confidenceColors: Record<string, 'success' | 'warning' | 'default'> = {
  'high': 'success',
  'medium': 'warning',
  'low': 'default',
};

const criticalityColors: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  'critical': 'error',
  'high': 'warning',
  'medium': 'info',
  'low': 'default',
};

const categoryIcons: Record<string, React.ReactNode> = {
  'core': <ApiIcon color="primary" />,
  'supporting': <BuildIcon color="action" />,
  'admin': <WarningIcon color="warning" />,
  'internal': <CodeIcon color="disabled" />,
};

const evidenceTypeIcons: Record<string, React.ReactNode> = {
  'commit_message': <HistoryIcon fontSize="small" />,
  'pr_description': <MergeTypeIcon fontSize="small" />,
  'code_comment': <CommentIcon fontSize="small" />,
  'pattern_deviation': <CodeIcon fontSize="small" />,
  'naming_convention': <CodeIcon fontSize="small" />,
};

export const SystemCapabilitiesView: React.FC<SystemCapabilitiesViewProps> = ({
  data,
  onNodeSelect,
  onViewCriticalFlows,
}) => {
  const [activeTab, setActiveTab] = useState(0);
  const [expandedIntent, setExpandedIntent] = useState<string | false>(false);

  const intents = data.intents || [];
  const callChains = data.call_chains || [];
  const flowSummary = data.flow_summary;
  const systemCapabilities = data.system_capabilities || [];
  const systemPurpose = data.system_purpose;

  const nodeMap = useMemo(() => {
    const map = new Map<string, { name: string; file?: string; type?: string }>();
    data.nodes?.forEach(node => {
      map.set(node.id, { name: node.name, file: node.source?.file, type: node.type });
    });
    return map;
  }, [data.nodes]);

  const getNodeName = (nodeId: string) => {
    const node = nodeMap.get(nodeId);
    return node?.name || nodeId;
  };

  const criticalFlows = useMemo(() =>
    callChains.filter(chain =>
      chain.criticality === 'critical' || chain.criticality === 'high'
    ),
    [callChains]
  );

  const workarounds = useMemo(() =>
    intents.filter(intent => intent.workaround_indicator?.is_workaround),
    [intents]
  );

  const architecturalDecisions = useMemo(() =>
    intents.filter(intent => intent.architectural_decision),
    [intents]
  );

  const highConfidenceIntents = useMemo(() =>
    intents.filter(intent => intent.confidence === 'high'),
    [intents]
  );

  const systemPurposes = useMemo(() => {
    const purposes = new Map<string, { count: number; nodes: string[] }>();
    intents.forEach(intent => {
      if (intent.inferred_purpose) {
        const existing = purposes.get(intent.inferred_purpose) || { count: 0, nodes: [] };
        existing.count++;
        existing.nodes.push(intent.node_id);
        purposes.set(intent.inferred_purpose, existing);
      }
    });
    return Array.from(purposes.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);
  }, [intents]);

  const handleAccordionChange = (intentId: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedIntent(isExpanded ? intentId : false);
  };

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <LightbulbIcon sx={{ fontSize: 32, color: 'primary.main' }} />
        <Box>
          <Typography variant="h5">System Capabilities</Typography>
          <Typography variant="body2" color="text.secondary">
            What this system does, inferred from code patterns, comments, and history
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2, mb: 3 }}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h4" color="primary.main">{criticalFlows.length}</Typography>
          <Typography variant="body2" color="text.secondary">Critical Flows</Typography>
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h4" color="info.main">{highConfidenceIntents.length}</Typography>
          <Typography variant="body2" color="text.secondary">High Confidence Intents</Typography>
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h4" color="secondary.main">{architecturalDecisions.length}</Typography>
          <Typography variant="body2" color="text.secondary">Architectural Decisions</Typography>
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h4" color="warning.main">{workarounds.length}</Typography>
          <Typography variant="body2" color="text.secondary">Workarounds</Typography>
        </Paper>
      </Box>

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="What It Does" />
          <Tab label="Core Flows" />
          <Tab label="Why Decisions" />
          <Tab label="Workarounds" />
          <Tab label="All Intents" />
        </Tabs>
      </Box>

      {activeTab === 0 && (
        <Box>
          {systemPurpose && (
            <Paper sx={{ p: 2, mb: 3, bgcolor: 'primary.dark', color: 'primary.contrastText' }}>
              <Typography variant="overline">System Type</Typography>
              <Typography variant="h5" sx={{ textTransform: 'capitalize', mb: 1 }}>
                {systemPurpose.primary_type.replace(/-/g, ' ')}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <LinearProgress
                  variant="determinate"
                  value={systemPurpose.confidence * 100}
                  sx={{ flex: 1, height: 6, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.2)' }}
                />
                <Typography variant="caption">
                  {Math.round(systemPurpose.confidence * 100)}% confidence
                </Typography>
              </Box>
              {systemPurpose.secondary_types && systemPurpose.secondary_types.length > 0 && (
                <Box sx={{ mt: 1, display: 'flex', gap: 0.5 }}>
                  <Typography variant="caption">Also:</Typography>
                  {systemPurpose.secondary_types.map(type => (
                    <Chip
                      key={type}
                      label={type.replace(/-/g, ' ')}
                      size="small"
                      sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: 'inherit' }}
                    />
                  ))}
                </Box>
              )}
              {systemPurpose.evidence.length > 0 && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="caption" sx={{ opacity: 0.8 }}>
                    {systemPurpose.evidence.slice(0, 3).join(' | ')}
                  </Typography>
                </Box>
              )}
            </Paper>
          )}

          <Typography variant="h6" gutterBottom>System Capabilities</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            What this system can do, grouped by resource domain
          </Typography>

          {systemCapabilities.length === 0 ? (
            <Alert severity="info">
              No system capabilities could be identified. Capabilities are inferred from
              entry points, data entities, and code patterns.
            </Alert>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {systemCapabilities.map(capability => (
                <Paper
                  key={capability.id}
                  sx={{
                    p: 2,
                    borderLeft: '4px solid',
                    borderLeftColor: capability.criticality === 'critical' ? 'error.main' :
                                     capability.criticality === 'high' ? 'warning.main' :
                                     capability.criticality === 'medium' ? 'info.main' : 'grey.400'
                  }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {categoryIcons[capability.category] || <ApiIcon />}
                      <Box>
                        <Typography variant="subtitle1">{capability.name}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {capability.description}
                        </Typography>
                      </Box>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Chip
                        size="small"
                        label={capability.category}
                        variant="outlined"
                      />
                      <Chip
                        size="small"
                        label={capability.criticality}
                        color={criticalityColors[capability.criticality]}
                      />
                    </Box>
                  </Box>

                  <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {capability.operations.slice(0, 6).map((op, idx) => (
                      <Chip
                        key={idx}
                        label={`${op.action}${op.path_or_command ? ` ${op.path_or_command}` : ''}`}
                        size="small"
                        variant="outlined"
                      />
                    ))}
                    {capability.operations.length > 6 && (
                      <Chip label={`+${capability.operations.length - 6} more`} size="small" />
                    )}
                  </Box>

                  {capability.criticality_factors.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {capability.criticality_factors.join(' | ')}
                      </Typography>
                    </Box>
                  )}
                </Paper>
              ))}
            </Box>
          )}

          {flowSummary && (
            <Box sx={{ mt: 4 }}>
              <Typography variant="h6" gutterBottom>Flow Summary</Typography>
              <Paper sx={{ p: 2 }}>
                <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  <Box>
                    <Typography variant="h5">{flowSummary.total_critical_flows}</Typography>
                    <Typography variant="body2" color="text.secondary">Total Critical Flows</Typography>
                  </Box>
                  {flowSummary.by_criticality && Object.entries(flowSummary.by_criticality).map(([level, count]) => (
                    <Box key={level}>
                      <Typography variant="h5">{count}</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
                        {level}
                      </Typography>
                    </Box>
                  ))}
                </Box>
                {(flowSummary.untested_critical_flows?.length || 0) > 0 && (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    {flowSummary.untested_critical_flows?.length} critical flows lack test coverage
                  </Alert>
                )}
              </Paper>
            </Box>
          )}
        </Box>
      )}

      {activeTab === 1 && (
        <Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">Critical System Flows</Typography>
            {onViewCriticalFlows && (
              <Chip
                label="View All Flows"
                color="primary"
                onClick={onViewCriticalFlows}
                onDelete={onViewCriticalFlows}
                deleteIcon={<ArrowForwardIcon />}
                sx={{ cursor: 'pointer' }}
              />
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The core user journeys and business-critical paths through the system
          </Typography>

          {criticalFlows.length === 0 ? (
            <Alert severity="info">
              No critical flows have been identified yet. Critical flows are detected from
              high-traffic entry points, business-critical annotations, and transaction patterns.
            </Alert>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {criticalFlows.slice(0, 10).map(flow => (
                <Card key={flow.id} variant="outlined">
                  <CardActionArea onClick={() => onNodeSelect?.(flow.entry_point.node_id)}>
                    <CardContent>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Box>
                          <Typography variant="subtitle1">
                            {flow.entry_point.method_name || getNodeName(flow.entry_point.node_id)}
                          </Typography>
                          {flow.business_context?.user_action && (
                            <Typography variant="body2" color="text.secondary">
                              {flow.business_context.user_action}
                            </Typography>
                          )}
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <Chip
                            size="small"
                            label={flow.criticality || 'critical'}
                            color={flow.criticality === 'critical' ? 'error' : 'warning'}
                          />
                          {flow.runtime_stats && (
                            <Chip
                              size="small"
                              label={flow.runtime_stats.traffic_volume}
                              variant="outlined"
                            />
                          )}
                        </Box>
                      </Box>

                      {flow.criticality_factors && flow.criticality_factors.length > 0 && (
                        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {flow.criticality_factors.map((factor, idx) => (
                            <Chip key={idx} label={factor} size="small" variant="outlined" />
                          ))}
                        </Box>
                      )}

                      {flow.test_coverage && (
                        <Box sx={{ mt: 1 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="caption">
                              Test Coverage: {flow.test_coverage.covered ? 'Covered' : 'Not Covered'}
                            </Typography>
                            {flow.test_coverage.coverage_percentage !== undefined && (
                              <Typography variant="caption">
                                {flow.test_coverage.coverage_percentage}%
                              </Typography>
                            )}
                          </Box>
                          <LinearProgress
                            variant="determinate"
                            value={flow.test_coverage.coverage_percentage || 0}
                            color={
                              (flow.test_coverage.coverage_percentage || 0) >= 80 ? 'success' :
                              (flow.test_coverage.coverage_percentage || 0) >= 50 ? 'warning' : 'error'
                            }
                          />
                        </Box>
                      )}
                    </CardContent>
                  </CardActionArea>
                </Card>
              ))}
              {criticalFlows.length > 10 && (
                <Typography variant="body2" color="text.secondary" align="center">
                  +{criticalFlows.length - 10} more critical flows
                </Typography>
              )}
            </Box>
          )}
        </Box>
      )}

      {activeTab === 2 && (
        <Box>
          <Typography variant="h6" gutterBottom>Architectural Decisions</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Key design decisions inferred from code patterns and documentation
          </Typography>

          {architecturalDecisions.length === 0 ? (
            <Alert severity="info">
              No architectural decisions could be identified. Document important decisions
              in comments or PR descriptions to help future developers understand the codebase.
            </Alert>
          ) : (
            architecturalDecisions.map(intent => (
              <Paper key={intent.node_id} sx={{ p: 2, mb: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
                  <BuildIcon color="secondary" />
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="subtitle1">
                      {intent.architectural_decision?.decision}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      at {getNodeName(intent.node_id)}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    label={intent.confidence}
                    color={confidenceColors[intent.confidence]}
                  />
                </Box>

                {intent.architectural_decision?.rationale && (
                  <Typography variant="body2" sx={{ ml: 4, mb: 1 }}>
                    <strong>Rationale:</strong> {intent.architectural_decision.rationale}
                  </Typography>
                )}

                {intent.architectural_decision?.evidence && intent.architectural_decision.evidence.length > 0 && (
                  <Box sx={{ ml: 4 }}>
                    <Typography variant="caption" color="text.secondary">Evidence:</Typography>
                    <List dense>
                      {intent.architectural_decision.evidence.slice(0, 3).map((ev, idx) => (
                        <ListItem key={idx} sx={{ py: 0.5 }}>
                          <ListItemIcon sx={{ minWidth: 32 }}>
                            {evidenceTypeIcons[ev.type] || <CodeIcon fontSize="small" />}
                          </ListItemIcon>
                          <ListItemText
                            primary={ev.excerpt}
                            secondary={`${ev.type.replace(/_/g, ' ')} - ${ev.source}`}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Box>
                )}
              </Paper>
            ))
          )}
        </Box>
      )}

      {activeTab === 3 && (
        <Box>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Workarounds are temporary solutions that may need attention. These are detected from
            comments, naming patterns, and commit messages.
          </Alert>

          {workarounds.length === 0 ? (
            <Typography color="text.secondary">No workarounds detected</Typography>
          ) : (
            workarounds.map(intent => (
              <Paper
                key={intent.node_id}
                sx={{ p: 2, mb: 1.5, borderLeft: '4px solid #ff9800', cursor: 'pointer' }}
                onClick={() => onNodeSelect?.(intent.node_id)}
              >
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
                  <BugReportIcon color="warning" />
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="subtitle1">{getNodeName(intent.node_id)}</Typography>
                    {intent.workaround_indicator?.workaround_for && (
                      <Typography variant="body2" color="text.secondary">
                        Workaround for: {intent.workaround_indicator.workaround_for}
                      </Typography>
                    )}
                  </Box>
                </Box>
                {intent.workaround_indicator?.expected_resolution && (
                  <Typography variant="body2" sx={{ ml: 4 }}>
                    <strong>Expected resolution:</strong> {intent.workaround_indicator.expected_resolution}
                  </Typography>
                )}
              </Paper>
            ))
          )}
        </Box>
      )}

      {activeTab === 4 && (
        <Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            All inferred intents from code analysis
          </Typography>

          {intents.length === 0 ? (
            <Alert severity="info">
              No intents could be inferred. Intent inference uses code comments, naming patterns,
              commit messages, and PR descriptions.
            </Alert>
          ) : (
            intents.slice(0, 50).map(intent => (
              <Accordion
                key={intent.node_id}
                expanded={expandedIntent === intent.node_id}
                onChange={handleAccordionChange(intent.node_id)}
                sx={{ mb: 1 }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                    <LightbulbIcon
                      sx={{
                        color: intent.confidence === 'high' ? 'success.main' :
                               intent.confidence === 'medium' ? 'warning.main' : 'text.secondary'
                      }}
                    />
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="subtitle2">{getNodeName(intent.node_id)}</Typography>
                      {intent.inferred_purpose && (
                        <Typography variant="body2" color="text.secondary" noWrap>
                          {intent.inferred_purpose}
                        </Typography>
                      )}
                    </Box>
                    <Chip
                      size="small"
                      label={intent.confidence}
                      color={confidenceColors[intent.confidence]}
                    />
                  </Box>
                </AccordionSummary>
                <AccordionDetails>
                  {intent.inferred_purpose && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle2">Purpose</Typography>
                      <Typography variant="body2">{intent.inferred_purpose}</Typography>
                    </Box>
                  )}

                  {intent.inferred_constraints && intent.inferred_constraints.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle2">Constraints</Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {intent.inferred_constraints.map((constraint, idx) => (
                          <Chip key={idx} label={constraint} size="small" variant="outlined" />
                        ))}
                      </Box>
                    </Box>
                  )}

                  {intent.architectural_decision && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle2">Decision</Typography>
                      <Typography variant="body2">{intent.architectural_decision.decision}</Typography>
                      {intent.architectural_decision.rationale && (
                        <Typography variant="body2" color="text.secondary">
                          Rationale: {intent.architectural_decision.rationale}
                        </Typography>
                      )}
                    </Box>
                  )}

                  {intent.workaround_indicator?.is_workaround && (
                    <Alert severity="warning" sx={{ mb: 2 }}>
                      This is a workaround
                      {intent.workaround_indicator.workaround_for && `: ${intent.workaround_indicator.workaround_for}`}
                    </Alert>
                  )}

                  <Chip
                    label="View Node"
                    size="small"
                    color="primary"
                    onClick={() => onNodeSelect?.(intent.node_id)}
                    sx={{ cursor: 'pointer' }}
                  />
                </AccordionDetails>
              </Accordion>
            ))
          )}
          {intents.length > 50 && (
            <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 2 }}>
              Showing 50 of {intents.length} intents
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
};

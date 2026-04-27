import React, { useState, useMemo } from 'react';
import {
  Box,
  Grid,
  Paper,
  Typography,
  Card,
  CardContent,
  Stack,
  Chip,
  LinearProgress,
  CircularProgress,
  Avatar,
  List,
  ListItem,
  ListItemText,
  ListItemAvatar,
  ListItemSecondaryAction,
  IconButton,
  Divider,
  Alert,
  AlertTitle,
  Tooltip,
  Button,
  ToggleButton,
  ToggleButtonGroup,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow
} from '@mui/material';
import {
  Assessment,
  Code,
  Description,
  Warning,
  Error,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  Security,
  Speed,
  BugReport,
  Assignment,
  CallSplit,
  Cloud,
  Storage,
  Api,
  Input,
  Output,
  Architecture,
  Insights,
  BarChart,
  PieChart,
  Timeline,
  OpenInNew,
  Refresh,
  MoreVert
} from '@mui/icons-material';
import {
  CASOutput,
  CASDocumentationSummary,
  CASTodoSummary,
  CASImplementationHealth,
  AnalyzerContribution
} from '../../types/cas.types';

interface ProjectDashboardProps {
  casData: CASOutput;
  onNodeClick?: (nodeId: string) => void;
  onRefresh?: () => void;
}

interface MetricCard {
  title: string;
  value: number | string;
  subtitle?: string;
  icon: JSX.Element;
  color: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';
  trend?: 'up' | 'down' | 'stable';
  trendValue?: string;
}

const getImplementationBreakdown = (health: CASImplementationHealth) => ({
  complete: health.complete_implementations ?? health.status_breakdown?.complete ?? 0,
  partial: health.partial_implementations ?? health.status_breakdown?.partial ?? 0,
  stub: health.stubs ?? health.status_breakdown?.stub ?? 0,
  not_implemented: health.not_implemented ?? health.status_breakdown?.not_implemented ?? 0,
  deprecated: health.deprecated ?? health.status_breakdown?.deprecated ?? 0,
  experimental: health.experimental ?? health.status_breakdown?.experimental ?? 0,
});

const calculateHealthScore = (health?: CASImplementationHealth): number => {
  if (!health) return 0;

  const score = health.health_score ?? health.overall_score ?? 0;
  return Math.max(0, Math.min(100, score <= 1 ? score * 100 : score));
};

const getHealthColor = (score: number): 'success' | 'warning' | 'error' => {
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'error';
};

export const ProjectDashboard: React.FC<ProjectDashboardProps> = ({
  casData,
  onNodeClick,
  onRefresh
}) => {
  const [selectedView, setSelectedView] = useState<'overview' | 'documentation' | 'technical-debt' | 'architecture'>('overview');

  const metrics = useMemo(() => {
    const healthScore = calculateHealthScore(casData.implementation_health);
    const docCoverage = casData.documentation_summary?.documentation_coverage || 0;
    const todoCount = casData.todos_summary?.total_todos || 0;
    const criticalTodos = (casData.todos_summary?.by_priority?.critical || 0) +
                          (casData.todos_summary?.by_priority?.high || 0);

    const cards: MetricCard[] = [
      {
        title: 'System Health',
        value: `${healthScore.toFixed(0)}%`,
        icon: <Assessment />,
        color: getHealthColor(healthScore),
        subtitle: 'Overall implementation quality'
      },
      {
        title: 'Documentation',
        value: `${docCoverage.toFixed(0)}%`,
        icon: <Description />,
        color: docCoverage >= 70 ? 'success' : docCoverage >= 40 ? 'warning' : 'error',
        subtitle: `${casData.documentation_summary?.total_documented_nodes ?? casData.documentation_summary?.documented_nodes ?? 0} / ${casData.documentation_summary?.total_nodes ?? casData.nodes.length} nodes`
      },
      {
        title: 'Technical Debt',
        value: todoCount,
        icon: <Assignment />,
        color: todoCount > 50 ? 'error' : todoCount > 20 ? 'warning' : 'success',
        subtitle: `${criticalTodos} critical items`
      },
      {
        title: 'Components',
        value: casData.nodes.length,
        icon: <Code />,
        color: 'primary',
        subtitle: `${casData.edges.length} connections`
      },
      {
        title: 'Entry Points',
        value: casData.entry_points.length,
        icon: <Input />,
        color: 'info',
        subtitle: 'System access points'
      },
      {
        title: 'Exit Points',
        value: casData.exit_points.length,
        icon: <Output />,
        color: 'info',
        subtitle: 'External connections'
      },
      {
        title: 'External Services',
        value: casData.external_services.length,
        icon: <Cloud />,
        color: 'secondary',
        subtitle: 'Third-party dependencies'
      },
      {
        title: 'Call Chains',
        value: casData.call_chains?.length || 0,
        icon: <CallSplit />,
        color: 'primary',
        subtitle: 'Execution paths analyzed'
      }
    ];

    return cards;
  }, [casData]);

  const renderMetricCard = (metric: MetricCard) => (
    <Grid item xs={12} sm={6} md={3} key={metric.title}>
      <Card>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Box>
              <Typography variant="h4" component="div" color={`${metric.color}.main`}>
                {metric.value}
              </Typography>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {metric.title}
              </Typography>
              {metric.subtitle && (
                <Typography variant="caption" color="text.secondary">
                  {metric.subtitle}
                </Typography>
              )}
            </Box>
            <Avatar sx={{ bgcolor: `${metric.color}.light`, color: `${metric.color}.main` }}>
              {metric.icon}
            </Avatar>
          </Stack>

          {metric.trend && (
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 1 }}>
              {metric.trend === 'up' ? (
                <TrendingUp color="success" fontSize="small" />
              ) : metric.trend === 'down' ? (
                <TrendingDown color="error" fontSize="small" />
              ) : null}
              {metric.trendValue && (
                <Typography variant="caption" color={metric.trend === 'up' ? 'success.main' : 'error.main'}>
                  {metric.trendValue}
                </Typography>
              )}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Grid>
  );

  const renderAnalyzerBreakdown = () => (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Analyzer Contributions
        </Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Analyzer</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="center">Confidence</TableCell>
                <TableCell>Perspectives</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {casData.analyzer_contributions.map((contrib, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <Typography variant="body2" fontWeight="bold">
                      {contrib.analyzer_name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={contrib.analyzer_type} size="small" />
                  </TableCell>
                  <TableCell align="center">
                    <LinearProgress
                      variant="determinate"
                      value={contrib.confidence * 100}
                      sx={{ width: 60, mx: 'auto' }}
                    />
                    <Typography variant="caption">
                      {(contrib.confidence * 100).toFixed(0)}%
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {contrib.provided_perspectives?.map((p, i) => (
                      <Chip key={i} label={p} size="small" sx={{ mr: 0.5 }} />
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  );

  const renderImplementationHealth = () => {
    if (!casData.implementation_health) return null;

    const health = casData.implementation_health;
    const breakdown = getImplementationBreakdown(health);
    const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
    const healthScore = calculateHealthScore(health);

    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Implementation Health
          </Typography>

          <Box sx={{ mb: 3 }}>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="body2">Overall Score</Typography>
              <Typography variant="body2" fontWeight="bold">
                {healthScore.toFixed(0)}%
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={healthScore}
              color={getHealthColor(healthScore)}
              sx={{ height: 8, borderRadius: 4 }}
            />
          </Box>

          <Typography variant="subtitle2" gutterBottom>
            Status Breakdown
          </Typography>
          <Grid container spacing={1} sx={{ mb: 2 }}>
            {Object.entries(breakdown).map(([status, count]) => {
              const percentage = total > 0 ? (count / total) * 100 : 0;
              const color = status === 'complete' ? 'success' :
                           status === 'partial' ? 'warning' :
                           status === 'stub' || status === 'not_implemented' ? 'error' :
                           'primary';

              return (
                <Grid item xs={6} key={status}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="caption" textTransform="capitalize">
                        {status.replace('_', ' ')}
                      </Typography>
                      <Typography variant="caption" fontWeight="bold">
                        {count}
                      </Typography>
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={percentage}
                      color={color}
                      sx={{ height: 4 }}
                    />
                  </Stack>
                </Grid>
              );
            })}
          </Grid>

          <Typography variant="subtitle2" gutterBottom>
            Risk Areas
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            {(health.risk_areas || []).length > 0 ? (health.risk_areas || []).slice(0, 8).map(risk => (
              <Chip
                key={`${risk.node_id}-${risk.risk_type}`}
                label={`${risk.node_name}: ${risk.risk_type.replace(/-/g, ' ')}`}
                size="small"
                color={risk.risk_level === 'high' ? 'error' : risk.risk_level === 'medium' ? 'warning' : 'default'}
                variant="outlined"
              />
            )) : (
              <Chip label="No implementation risks" size="small" color="success" variant="outlined" />
            )}
          </Stack>
        </CardContent>
      </Card>
    );
  };

  const renderDocumentationSummary = () => {
    if (!casData.documentation_summary) return null;

    const docs = casData.documentation_summary;

    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Documentation Coverage
          </Typography>

          <Box sx={{ mb: 3, textAlign: 'center' }}>
            <Box sx={{ position: 'relative', display: 'inline-flex' }}>
              <CircularProgress
                variant="determinate"
                value={docs.documentation_coverage}
                size={120}
                thickness={4}
                color={docs.documentation_coverage >= 70 ? 'success' :
                       docs.documentation_coverage >= 40 ? 'warning' : 'error'}
              />
              <Box
                sx={{
                  top: 0,
                  left: 0,
                  bottom: 0,
                  right: 0,
                  position: 'absolute',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Typography variant="h4" component="div">
                  {docs.documentation_coverage.toFixed(0)}%
                </Typography>
              </Box>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {docs.total_documented_nodes ?? docs.documented_nodes ?? 0} / {docs.total_nodes ?? casData.nodes.length} nodes documented
            </Typography>
          </Box>

          {docs.by_type && Object.keys(docs.by_type).length > 0 && (
            <>
              <Typography variant="subtitle2" gutterBottom>
                By Component Type
              </Typography>
              <List dense>
                {Object.entries(docs.by_type).map(([type, stats]) => (
                  <ListItem key={type}>
                    <ListItemText
                      primary={type}
                      secondary={`${stats.documented} / ${stats.total}`}
                    />
                    <ListItemSecondaryAction>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Typography variant="caption">
                          {stats.coverage.toFixed(0)}%
                        </Typography>
                        <LinearProgress
                          variant="determinate"
                          value={stats.coverage}
                          sx={{ width: 60, height: 4 }}
                          color={stats.coverage >= 70 ? 'success' :
                                stats.coverage >= 40 ? 'warning' : 'error'}
                        />
                      </Stack>
                    </ListItemSecondaryAction>
                  </ListItem>
                ))}
              </List>
            </>
          )}

          {docs.quality_metrics && (
            <Stack spacing={1} sx={{ mt: 2 }}>
              <Typography variant="subtitle2">Quality Metrics</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Chip
                  label={`${docs.quality_metrics.examples_provided ?? docs.quality_metrics.nodes_with_examples ?? 0} examples`}
                  size="small"
                  color="success"
                  variant="outlined"
                />
                <Chip
                  label={`${docs.quality_metrics.parameters_documented ?? docs.quality_metrics.nodes_with_parameters ?? 0} parameters`}
                  size="small"
                  color="info"
                  variant="outlined"
                />
                <Chip
                  label={`${docs.quality_metrics.returns_documented ?? docs.quality_metrics.nodes_with_returns ?? 0} returns`}
                  size="small"
                  color="info"
                  variant="outlined"
                />
              </Stack>
            </Stack>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderTodoSummary = () => {
    if (!casData.todos_summary) return null;

    const todos = casData.todos_summary;
    const priorityColors = {
      critical: 'error',
      high: 'error',
      medium: 'warning',
      low: 'info'
    };

    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Technical Debt Overview
          </Typography>

          <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
            <Paper sx={{ p: 2, flex: 1, textAlign: 'center' }}>
              <Typography variant="h4">{todos.total_todos}</Typography>
              <Typography variant="body2" color="text.secondary">
                Total TODOs
              </Typography>
            </Paper>
            <Paper sx={{ p: 2, flex: 1, textAlign: 'center', borderColor: 'error.main', borderWidth: 2, borderStyle: 'solid' }}>
              <Typography variant="h4" color="error">
                {todos.blocking_items}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Blocking Issues
              </Typography>
            </Paper>
            <Paper sx={{ p: 2, flex: 1, textAlign: 'center' }}>
              <Typography variant="h4" color="warning.main">
                {todos.technical_debt_items}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Tech Debt Items
              </Typography>
            </Paper>
          </Stack>

          <Typography variant="subtitle2" gutterBottom>
            Priority Distribution
          </Typography>
          <Stack spacing={1} sx={{ mb: 2 }}>
            {Object.entries(todos.by_priority).map(([priority, count]) => {
              const percentage = todos.total_todos > 0 ? (count / todos.total_todos) * 100 : 0;
              return (
                <Stack key={priority} spacing={0.5}>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="caption" textTransform="capitalize">
                      {priority}
                    </Typography>
                    <Typography variant="caption" fontWeight="bold">
                      {count}
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={percentage}
                    color={priorityColors[priority as keyof typeof priorityColors] as any}
                    sx={{ height: 6 }}
                  />
                </Stack>
              );
            })}
          </Stack>

          {todos.by_type && (
            <>
              <Typography variant="subtitle2" gutterBottom>
                By Type
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap">
                {Object.entries(todos.by_type).map(([type, count]) => (
                  <Chip
                    key={type}
                    label={`${type}: ${count}`}
                    size="small"
                    variant="outlined"
                  />
                ))}
              </Stack>
            </>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderPerspectivesOverview = () => {
    if (!casData.perspectives || casData.perspectives.length === 0) return null;

    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Available Perspectives
          </Typography>
          <Grid container spacing={2}>
            {casData.perspectives.map(perspective => (
              <Grid item xs={12} md={6} key={perspective.id}>
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="subtitle1" fontWeight="bold">
                        {perspective.name}
                      </Typography>
                      <Chip label={perspective.type} size="small" color="primary" />
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {perspective.description}
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      <Chip
                        label={`Analyzer: ${perspective.analyzer_id}`}
                        size="small"
                        variant="outlined"
                      />
                      {perspective.layout_hints && (
                        <Chip
                          label={`Layout: ${perspective.layout_hints.style}`}
                          size="small"
                          variant="outlined"
                        />
                      )}
                    </Stack>
                  </Stack>
                </Paper>
              </Grid>
            ))}
          </Grid>
        </CardContent>
      </Card>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%', overflow: 'auto' }}>
      <Box sx={{ p: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
          <Box>
            <Typography variant="h4" gutterBottom>
              {casData.system.name}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Analysis ID: {casData.analysis_id}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {new Date(casData.analysis_timestamp).toLocaleString()}
            </Typography>
          </Box>

          <Stack direction="row" spacing={2}>
            {onRefresh && (
              <Button
                variant="outlined"
                startIcon={<Refresh />}
                onClick={onRefresh}
              >
                Refresh Analysis
              </Button>
            )}
            <IconButton>
              <MoreVert />
            </IconButton>
          </Stack>
        </Stack>

        <ToggleButtonGroup
          value={selectedView}
          exclusive
          onChange={(_, value) => value && setSelectedView(value)}
          sx={{ mb: 3 }}
        >
          <ToggleButton value="overview">Overview</ToggleButton>
          <ToggleButton value="documentation">Documentation</ToggleButton>
          <ToggleButton value="technical-debt">Technical Debt</ToggleButton>
          <ToggleButton value="architecture">Architecture</ToggleButton>
        </ToggleButtonGroup>

        {selectedView === 'overview' && (
          <>
            <Grid container spacing={3} sx={{ mb: 3 }}>
              {metrics.map(renderMetricCard)}
            </Grid>

            <Grid container spacing={3}>
              <Grid item xs={12} md={6}>
                {renderImplementationHealth()}
              </Grid>
              <Grid item xs={12} md={6}>
                {renderDocumentationSummary()}
              </Grid>
              <Grid item xs={12}>
                {renderAnalyzerBreakdown()}
              </Grid>
            </Grid>
          </>
        )}

        {selectedView === 'documentation' && (
          <Grid container spacing={3}>
            <Grid item xs={12}>
              {renderDocumentationSummary()}
            </Grid>
          </Grid>
        )}

        {selectedView === 'technical-debt' && (
          <Grid container spacing={3}>
            <Grid item xs={12}>
              {renderTodoSummary()}
            </Grid>
          </Grid>
        )}

        {selectedView === 'architecture' && (
          <Grid container spacing={3}>
            <Grid item xs={12}>
              {renderPerspectivesOverview()}
            </Grid>
          </Grid>
        )}
      </Box>
    </Box>
  );
};

import React, { useMemo } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  CardActionArea,
  Grid,
  Stack,
  Chip,
  Paper,
  Divider,
  LinearProgress,
} from '@mui/material';
import {
  Lock,
  Folder,
  Code,
  Analytics,
  People,
  AdminPanelSettings,
  MonitorHeart,
  Category,
  Storage,
  Cloud,
  Security,
  Api,
  Hub,
  Dns,
  Memory,
  Layers,
  AccountTree,
  Warning,
  CheckCircle,
  Build,
  BugReport,
  Pattern,
  Error as ErrorIcon,
  Terminal,
  Web,
  Schedule,
  Notifications,
  ViewModule,
  Science,
  SyncAlt,
  Timeline,
  Shield,
  TrendingUp,
  DataObject,
  Lightbulb,
} from '@mui/icons-material';
import { CASOutput, CASPattern } from '../types';
import { Domain, extractDomains } from '../utils/domainExtractor';
import { Section, SECTION_TYPE_CONFIG, SectionType } from '../types/sections';
import { UICapabilities, getSectionTitle, hasSections } from '../utils/uiCapabilities';
import { NodeStyle, getEntryPointTypeConfig } from '../utils/dynamicStyling';
import { extractTestSummary, extractTestAreas, TestSummaryData, TestArea } from '../utils/testExtractor';
import TestTypeBreakdown from '../components/TestTypeBreakdown';

export interface SystemOverviewProps {
  cas: CASOutput;
  patterns?: CASPattern[];
  capabilities?: UICapabilities;
  sections?: Section[];
  nodeStyles?: Map<string, NodeStyle>;
  onDomainSelect: (domain: Domain) => void;
  onSectionSelect?: (section: Section) => void;
  onViewArchitecture?: () => void;
  onViewImplementationHealth?: () => void;
  onViewArchitectureItems?: (itemType: string) => void;
  onViewPatterns?: () => void;
  onViewTests?: () => void;
  onTestAreaSelect?: (area: TestArea) => void;
  onViewCriticalFlows?: () => void;
  onViewChangeRisk?: () => void;
  onViewSecurityBoundaries?: () => void;
  onViewCodeStability?: () => void;
  onViewDataEntities?: () => void;
  onViewSystemCapabilities?: () => void;
  onViewEntryPoints?: () => void;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  lock: <Lock />,
  folder: <Folder />,
  code: <Code />,
  analytics: <Analytics />,
  people: <People />,
  admin_panel_settings: <AdminPanelSettings />,
  monitor_heart: <MonitorHeart />,
  category: <Category />,
};

const FRAMEWORK_COLORS: Record<string, string> = {
  NestJS: '#e0234e',
  Express: '#000000',
  React: '#61dafb',
  Angular: '#dd0031',
  Vue: '#4fc08d',
  Django: '#092e20',
  Flask: '#000000',
  FastAPI: '#009688',
  Spring: '#6db33f',
  Laravel: '#ff2d20',
};

const SECTION_ICONS: Record<string, React.ReactNode> = {
  api: <Api />,
  terminal: <Terminal />,
  web: <Web />,
  schedule: <Schedule />,
  notifications: <Notifications />,
  view_module: <ViewModule />,
  science: <Science />,
  sync_alt: <SyncAlt />,
  account_tree: <AccountTree />,
};

const ENTRY_POINT_ICONS: Record<string, React.ReactNode> = {
  http: <Hub fontSize="small" color="action" />,
  websocket: <Dns fontSize="small" color="action" />,
  message: <Memory fontSize="small" color="action" />,
  cli: <Terminal fontSize="small" color="action" />,
  event: <Notifications fontSize="small" color="action" />,
  scheduled: <Schedule fontSize="small" color="action" />,
  grpc: <Cloud fontSize="small" color="action" />,
  graphql: <Hub fontSize="small" color="action" />,
  page: <Web fontSize="small" color="action" />,
  route: <Web fontSize="small" color="action" />,
};

export const SystemOverview: React.FC<SystemOverviewProps> = ({
  cas,
  patterns = [],
  capabilities,
  sections = [],
  nodeStyles,
  onDomainSelect,
  onSectionSelect,
  onViewArchitecture,
  onViewImplementationHealth,
  onViewArchitectureItems,
  onViewPatterns,
  onViewTests,
  onTestAreaSelect,
  onViewCriticalFlows,
  onViewChangeRisk,
  onViewSecurityBoundaries,
  onViewCodeStability,
  onViewDataEntities,
  onViewSystemCapabilities,
  onViewEntryPoints,
}) => {
  const domains = useMemo(() => extractDomains(cas), [cas]);
  const useSections = sections.length > 0;
  const sectionTitle = capabilities ? getSectionTitle(capabilities) : 'API Domains';
  const showSectionsArea = capabilities ? hasSections(capabilities) : domains.length > 0;

  const techStack = useMemo(() => {
    const system = cas.system as any;
    const languages = system?.technologies?.languages || [];
    const frameworks = system?.technologies?.frameworks || [];
    return { languages, frameworks };
  }, [cas]);

  const architectureSummary = useMemo(() => {
    const summary = (cas as any).architecture_summary;
    if (!summary) return null;
    return {
      systemType: summary.system_type,
      layers: summary.layers,
      apiSurface: summary.api_surface,
      security: summary.security,
    };
  }, [cas]);

  const entryPointsByType = useMemo(() => {
    const eps = cas.entry_points || [];
    const grouped: Record<string, number> = {};
    eps.forEach(ep => {
      grouped[ep.type] = (grouped[ep.type] || 0) + 1;
    });
    return Object.entries(grouped)
      .sort((a, b) => b[1] - a[1]);
  }, [cas]);

  const externalServices = useMemo(() => {
    return (cas.external_services || []).slice(0, 6);
  }, [cas]);

  const implementationHealth = useMemo(() => {
    const nodes = cas.nodes || [];
    const nodesWithStatus = nodes.filter(n => n.implementation_status);

    if (nodesWithStatus.length === 0) return null;

    const statusCounts = {
      complete: 0,
      partial: 0,
      stub: 0,
      'not-implemented': 0,
      deprecated: 0,
      experimental: 0,
    };

    const qualityIndicators = {
      hasTodos: 0,
      hasStubReturns: 0,
      hasHardcodedValues: 0,
      hasPlaceholderCode: 0,
    };

    const incompleteNodes: Array<{
      id: string;
      name: string;
      type: string;
      status: string;
      file?: string;
    }> = [];

    nodesWithStatus.forEach(n => {
      const status = n.implementation_status!.status;
      if (status in statusCounts) {
        statusCounts[status as keyof typeof statusCounts]++;
      }

      const indicators = n.implementation_status!.indicators;
      if (indicators.has_todo_markers) qualityIndicators.hasTodos++;
      if (indicators.has_stub_returns) qualityIndicators.hasStubReturns++;
      if (indicators.has_hardcoded_values) qualityIndicators.hasHardcodedValues++;
      if (indicators.has_placeholder_code) qualityIndicators.hasPlaceholderCode++;

      if (status !== 'complete') {
        incompleteNodes.push({
          id: n.id,
          name: n.name,
          type: n.type,
          status,
          file: n.source?.file,
        });
      }
    });

    const totalIncomplete = nodesWithStatus.length - statusCounts.complete;
    const healthPercentage = nodesWithStatus.length > 0
      ? Math.round((statusCounts.complete / nodesWithStatus.length) * 100)
      : 100;

    return {
      total: nodesWithStatus.length,
      statusCounts,
      qualityIndicators,
      incompleteNodes,
      totalIncomplete,
      healthPercentage,
    };
  }, [cas.nodes]);

  const patternStats = useMemo(() => {
    if (patterns.length === 0) return null;

    const designPatterns = patterns.filter(p => !p.id.includes('anti-pattern'));
    const antiPatterns = patterns.filter(p => p.id.includes('anti-pattern'));

    const allDeviations = patterns.flatMap(p =>
      (p.deviations || []).map(d => ({ ...d, patternName: p.name }))
    );
    const criticalDeviations = allDeviations.filter(d => d.severity === 'error');
    const warningDeviations = allDeviations.filter(d => d.severity === 'warning');

    const topPatterns = designPatterns
      .sort((a, b) => b.instances.length - a.instances.length)
      .slice(0, 4);

    return {
      total: patterns.length,
      designPatterns: designPatterns.length,
      antiPatterns: antiPatterns.length,
      criticalDeviations: criticalDeviations.length,
      warningDeviations: warningDeviations.length,
      topPatterns,
      allDeviations: allDeviations.slice(0, 3),
    };
  }, [patterns]);

  const testSummary = useMemo(() => {
    const testEntryPoints = (cas.entry_points || []).filter(ep => ep.type === 'test');
    if (testEntryPoints.length === 0) return null;
    return extractTestSummary(cas);
  }, [cas]);

  const testAreas = useMemo(() => {
    if (!testSummary) return [];
    return extractTestAreas(cas);
  }, [cas, testSummary]);

  const flowSummary = cas.flow_summary;
  const changeRiskSummary = cas.change_risk_summary;
  const stabilitySummary = cas.stability_summary;
  const securitySummary = cas.security_summary;
  const dataEntities = cas.data_entities || [];

  const criticalFlowStats = useMemo(() => {
    const callChains = cas.call_chains || [];
    if (callChains.length === 0) return null;

    const byCriticality = { critical: 0, high: 0, medium: 0, low: 0 };
    callChains.forEach(chain => {
      const crit = chain.criticality || 'low';
      byCriticality[crit as keyof typeof byCriticality]++;
    });

    return {
      total: callChains.length,
      byCriticality,
      untested: flowSummary?.untested_critical_flows?.length || 0,
      highErrorRate: flowSummary?.high_error_rate_flows?.length || 0,
    };
  }, [cas.call_chains, flowSummary]);

  const changeRiskStats = useMemo(() => {
    const risks = cas.change_risks || [];
    if (risks.length === 0) return null;

    const byLevel = { critical: 0, high: 0, medium: 0, low: 0 };
    risks.forEach(risk => {
      byLevel[risk.risk_level as keyof typeof byLevel]++;
    });

    return {
      total: risks.length,
      byLevel,
      highRisk: byLevel.critical + byLevel.high,
      recentHotspots: changeRiskSummary?.recent_hotspots?.length || 0,
    };
  }, [cas.change_risks, changeRiskSummary]);

  const systemName = cas.system?.name || 'System';
  const systemType = architectureSummary?.systemType || cas.system?.type || 'Application';

  return (
    <Box sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.default' }}>
      <Box sx={{ maxWidth: 1400, mx: 'auto', p: 4 }}>
        <Stack direction="row" spacing={4} alignItems="flex-start" sx={{ mb: 4 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h3" fontWeight={700} gutterBottom>
              {systemName}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Chip
                label={systemType}
                color="primary"
                size="small"
                sx={{ fontWeight: 600 }}
              />
              {architectureSummary?.security?.auth_strategy && (
                <Chip
                  icon={<Lock sx={{ fontSize: 14 }} />}
                  label={architectureSummary.security.auth_strategy}
                  size="small"
                  color="success"
                />
              )}
            </Stack>
          </Box>
        </Stack>

        {onViewSystemCapabilities && (cas.intents?.length || cas.call_chains?.length) && (
          <Paper
            sx={{
              p: 3,
              mb: 3,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              background: 'linear-gradient(135deg, #667eea15 0%, #764ba215 100%)',
              borderLeft: '4px solid #667eea',
              '&:hover': {
                boxShadow: 3,
              },
            }}
            onClick={onViewSystemCapabilities}
          >
            <Stack direction="row" spacing={2} alignItems="center">
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: 2,
                  bgcolor: '#667eea20',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Lightbulb sx={{ color: '#667eea', fontSize: 28 }} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6" fontWeight={600}>
                  What Does This System Do?
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {(cas.intents?.length || 0) > 0
                    ? `${cas.intents?.length} inferred intents, ${cas.call_chains?.filter(c => c.criticality === 'critical' || c.criticality === 'high').length || 0} critical flows discovered`
                    : `${cas.call_chains?.length || 0} call chains analyzed for capabilities`
                  }
                </Typography>
              </Box>
              <Typography variant="body2" color="primary">
                Explore system capabilities
              </Typography>
            </Stack>
          </Paper>
        )}

        <Grid container spacing={3}>
          <Grid item xs={12} md={4}>
            <Paper sx={{ p: 3, height: '100%' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Code color="primary" />
                <Typography variant="h6" fontWeight={600}>
                  Tech Stack
                </Typography>
              </Stack>

              {techStack.languages.length > 0 && (
                <Box sx={{ mb: 3 }}>
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                    Languages
                  </Typography>
                  {techStack.languages.map((lang: any) => (
                    <Box key={lang.name} sx={{ mb: 1 }}>
                      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                        <Typography variant="body2">{lang.name}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {lang.percentage?.toFixed(1)}%
                        </Typography>
                      </Stack>
                      <LinearProgress
                        variant="determinate"
                        value={lang.percentage || 0}
                        sx={{ height: 6, borderRadius: 1 }}
                      />
                    </Box>
                  ))}
                </Box>
              )}

              {techStack.frameworks.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                    Frameworks
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {techStack.frameworks.map((fw: any) => (
                      <Chip
                        key={fw.name}
                        label={fw.name}
                        size="small"
                        sx={{
                          bgcolor: FRAMEWORK_COLORS[fw.name] ? `${FRAMEWORK_COLORS[fw.name]}20` : undefined,
                          color: FRAMEWORK_COLORS[fw.name] || 'text.primary',
                          fontWeight: 500,
                        }}
                      />
                    ))}
                  </Stack>
                </Box>
              )}
            </Paper>
          </Grid>

          <Grid item xs={12} md={4}>
            <Paper sx={{ p: 3, height: '100%' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Layers color="primary" />
                <Typography variant="h6" fontWeight={600}>
                  Architecture
                </Typography>
              </Stack>

              {capabilities?.architectureLayers && capabilities.architectureLayers.length > 0 ? (
                <Stack spacing={2}>
                  {capabilities.architectureLayers.map(layer => (
                    <Box key={layer.id}>
                      <Typography variant="subtitle2" color="text.secondary">
                        {layer.name}
                      </Typography>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {Object.entries(layer.counts).map(([nodeType, count]) => {
                          const style = nodeStyles?.get(nodeType);
                          const label = style?.label || nodeType;
                          return (
                            <Chip
                              key={nodeType}
                              label={`${count} ${label}${count !== 1 ? 's' : ''}`}
                              size="small"
                              variant="outlined"
                              onClick={onViewArchitectureItems ? () => onViewArchitectureItems(nodeType) : undefined}
                              sx={{
                                cursor: onViewArchitectureItems ? 'pointer' : 'default',
                                borderColor: style?.color,
                                '&:hover': style?.color ? { bgcolor: `${style.color}10` } : {},
                              }}
                            />
                          );
                        })}
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              ) : architectureSummary?.layers ? (
                <Stack spacing={2}>
                  {architectureSummary.layers.presentation && (
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary">
                        Presentation Layer
                      </Typography>
                      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                        {architectureSummary.layers.presentation.controllers > 0 && (
                          <Chip
                            label={`${architectureSummary.layers.presentation.controllers} Controllers`}
                            size="small"
                            variant="outlined"
                            onClick={onViewArchitectureItems ? () => onViewArchitectureItems('controller') : undefined}
                            sx={onViewArchitectureItems ? { cursor: 'pointer' } : {}}
                          />
                        )}
                        {architectureSummary.layers.presentation.guards > 0 && (
                          <Chip
                            label={`${architectureSummary.layers.presentation.guards} Guards`}
                            size="small"
                            variant="outlined"
                            onClick={onViewArchitectureItems ? () => onViewArchitectureItems('guard') : undefined}
                            sx={onViewArchitectureItems ? { cursor: 'pointer' } : {}}
                          />
                        )}
                      </Stack>
                    </Box>
                  )}
                  {architectureSummary.layers.business && (
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary">
                        Business Layer
                      </Typography>
                      <Chip
                        label={`${architectureSummary.layers.business.services} Services`}
                        size="small"
                        variant="outlined"
                        onClick={onViewArchitectureItems ? () => onViewArchitectureItems('service') : undefined}
                        sx={onViewArchitectureItems ? { cursor: 'pointer' } : {}}
                      />
                    </Box>
                  )}
                  {architectureSummary.layers.data && (
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary">
                        Data Layer
                      </Typography>
                      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                        {architectureSummary.layers.data.repositories > 0 && (
                          <Chip
                            label={`${architectureSummary.layers.data.repositories} Repositories`}
                            size="small"
                            variant="outlined"
                            onClick={onViewArchitectureItems ? () => onViewArchitectureItems('repository') : undefined}
                            sx={onViewArchitectureItems ? { cursor: 'pointer' } : {}}
                          />
                        )}
                      </Stack>
                    </Box>
                  )}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Architecture analysis not available
                </Typography>
              )}

              {onViewArchitecture && (
                <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                    onClick={onViewArchitecture}
                  >
                    View Architecture Diagram
                  </Typography>
                </Box>
              )}
            </Paper>
          </Grid>

          <Grid item xs={12} md={4}>
            <Paper
              sx={{
                p: 3,
                height: '100%',
                cursor: onViewEntryPoints ? 'pointer' : 'default',
                transition: 'all 0.2s ease',
                '&:hover': onViewEntryPoints ? {
                  boxShadow: 2,
                  borderColor: 'primary.main',
                } : {},
              }}
              onClick={onViewEntryPoints}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Api color="primary" />
                <Typography variant="h6" fontWeight={600}>
                  Entry Points
                </Typography>
              </Stack>

              <Stack spacing={1.5}>
                {entryPointsByType.map(([type, count]) => {
                  const config = getEntryPointTypeConfig(type);
                  return (
                    <Stack key={type} direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={1} alignItems="center">
                        {ENTRY_POINT_ICONS[type] || <Code fontSize="small" color="action" />}
                        <Typography variant="body2">
                          {config.label}
                        </Typography>
                      </Stack>
                      <Chip label={count} size="small" />
                    </Stack>
                  );
                })}
              </Stack>

              {architectureSummary?.apiSurface && (
                <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                  <Stack direction="row" spacing={2}>
                    <Box>
                      <Typography variant="h6" color="success.main">
                        {architectureSummary.apiSurface.by_auth?.authenticated || 0}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Protected
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="h6" color="warning.main">
                        {architectureSummary.apiSurface.by_auth?.public || 0}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Public
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
              )}

              {onViewEntryPoints && (
                <Typography
                  variant="body2"
                  color="primary"
                  sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                >
                  View all entry points
                </Typography>
              )}
            </Paper>
          </Grid>

          {testSummary && testSummary.totalTests > 0 && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewTests ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewTests ? {
                    boxShadow: 2,
                    borderColor: 'info.main',
                  } : {},
                }}
                onClick={onViewTests}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Science color="info" />
                  <Typography variant="h6" fontWeight={600}>
                    Testing
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
                  <Box>
                    <Typography variant="h5" fontWeight={700} color="info.main">
                      {testSummary.totalTests}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Total Tests
                    </Typography>
                  </Box>
                  {testSummary.coveragePercent !== undefined && (
                    <Box>
                      <Typography variant="h5" fontWeight={700} color="success.main">
                        {testSummary.coveragePercent}%
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Coverage
                      </Typography>
                    </Box>
                  )}
                </Stack>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                    By Type
                  </Typography>
                  <TestTypeBreakdown
                    byType={testSummary.byType}
                    height={8}
                    showLegend={false}
                    showLabels={true}
                  />
                </Box>

                <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
                  {testSummary.byType.bdd > 0 && (
                    <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', textAlign: 'center' }}>
                      <Typography variant="h6" fontWeight={600}>
                        {testSummary.byType.bdd}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        BDD
                      </Typography>
                    </Box>
                  )}
                  {testSummary.mockCount > 0 && (
                    <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', textAlign: 'center' }}>
                      <Typography variant="h6" fontWeight={600}>
                        {testSummary.mockCount}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        With Mocks
                      </Typography>
                    </Box>
                  )}
                </Stack>

                {testSummary.topAreas.length > 0 && (
                  <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                      Top Test Areas
                    </Typography>
                    <Stack spacing={0.5}>
                      {testSummary.topAreas.slice(0, 3).map((area, idx) => (
                        <Stack key={idx} direction="row" justifyContent="space-between" alignItems="center">
                          <Typography
                            variant="body2"
                            noWrap
                            sx={{
                              maxWidth: 160,
                              cursor: onTestAreaSelect ? 'pointer' : 'default',
                              '&:hover': onTestAreaSelect ? { color: 'primary.main' } : {},
                            }}
                            onClick={(e) => {
                              if (onTestAreaSelect) {
                                e.stopPropagation();
                                const areaData = testAreas.find(a => a.name === area.name);
                                if (areaData) onTestAreaSelect(areaData);
                              }
                            }}
                          >
                            {area.name}
                          </Typography>
                          <Chip label={area.count} size="small" variant="outlined" />
                        </Stack>
                      ))}
                    </Stack>
                  </Box>
                )}

                {onViewTests && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                  >
                    View all tests
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {patternStats && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewPatterns ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewPatterns ? {
                    boxShadow: 2,
                    borderColor: 'primary.main',
                  } : {},
                }}
                onClick={onViewPatterns}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Pattern color="primary" />
                  <Typography variant="h6" fontWeight={600}>
                    Patterns
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
                  <Box>
                    <Typography variant="h5" fontWeight={700} color="primary.main">
                      {patternStats.designPatterns}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Design Patterns
                    </Typography>
                  </Box>
                  {patternStats.antiPatterns > 0 && (
                    <Box>
                      <Typography variant="h5" fontWeight={700} color="warning.main">
                        {patternStats.antiPatterns}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Anti-Patterns
                      </Typography>
                    </Box>
                  )}
                </Stack>

                <Stack spacing={1}>
                  {patternStats.topPatterns.slice(0, 3).map(pattern => (
                    <Stack key={pattern.id} direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" noWrap sx={{ maxWidth: 180 }}>
                        {pattern.name}
                      </Typography>
                      <Chip label={pattern.instances.length} size="small" variant="outlined" />
                    </Stack>
                  ))}
                </Stack>

                {(patternStats.criticalDeviations > 0 || patternStats.warningDeviations > 0) && (
                  <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                    <Stack direction="row" spacing={2}>
                      {patternStats.criticalDeviations > 0 && (
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <ErrorIcon fontSize="small" color="error" />
                          <Typography variant="body2" color="error.main">
                            {patternStats.criticalDeviations} critical
                          </Typography>
                        </Stack>
                      )}
                      {patternStats.warningDeviations > 0 && (
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Warning fontSize="small" color="warning" />
                          <Typography variant="body2" color="warning.main">
                            {patternStats.warningDeviations} warnings
                          </Typography>
                        </Stack>
                      )}
                    </Stack>
                  </Box>
                )}

                {onViewPatterns && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: patternStats.criticalDeviations > 0 || patternStats.warningDeviations > 0 ? 0 : 2, borderTop: patternStats.criticalDeviations > 0 || patternStats.warningDeviations > 0 ? 0 : 1, borderColor: 'divider' }}
                  >
                    View all {patternStats.total} patterns
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {implementationHealth && implementationHealth.totalIncomplete > 0 && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewImplementationHealth ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewImplementationHealth ? {
                    boxShadow: 2,
                    borderColor: 'warning.main',
                  } : {},
                }}
                onClick={onViewImplementationHealth}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Build color="warning" />
                  <Typography variant="h6" fontWeight={600}>
                    Needs Attention
                  </Typography>
                </Stack>

                <Stack spacing={1.5}>
                  {implementationHealth.statusCounts.partial > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Warning fontSize="small" color="warning" />
                        <Typography variant="body2">Partial</Typography>
                      </Stack>
                      <Chip label={implementationHealth.statusCounts.partial} size="small" color="warning" />
                    </Stack>
                  )}
                  {implementationHealth.statusCounts.stub > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={1} alignItems="center">
                        <BugReport fontSize="small" color="error" />
                        <Typography variant="body2">Stub</Typography>
                      </Stack>
                      <Chip label={implementationHealth.statusCounts.stub} size="small" color="error" />
                    </Stack>
                  )}
                  {implementationHealth.statusCounts['not-implemented'] > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={1} alignItems="center">
                        <BugReport fontSize="small" color="error" />
                        <Typography variant="body2">Not Implemented</Typography>
                      </Stack>
                      <Chip label={implementationHealth.statusCounts['not-implemented']} size="small" color="error" />
                    </Stack>
                  )}
                  {implementationHealth.qualityIndicators.hasTodos > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2">Contains TODOs</Typography>
                      <Chip label={implementationHealth.qualityIndicators.hasTodos} size="small" variant="outlined" />
                    </Stack>
                  )}
                </Stack>

                {onViewImplementationHealth && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                  >
                    View all {implementationHealth.totalIncomplete} items
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {criticalFlowStats && criticalFlowStats.total > 0 && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewCriticalFlows ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewCriticalFlows ? {
                    boxShadow: 2,
                    borderColor: 'secondary.main',
                  } : {},
                }}
                onClick={onViewCriticalFlows}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Timeline color="secondary" />
                  <Typography variant="h6" fontWeight={600}>
                    Critical Flows
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
                  <Box>
                    <Typography variant="h5" fontWeight={700} color="secondary.main">
                      {criticalFlowStats.total}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Total Flows
                    </Typography>
                  </Box>
                  {criticalFlowStats.byCriticality.critical > 0 && (
                    <Box>
                      <Typography variant="h5" fontWeight={700} color="error.main">
                        {criticalFlowStats.byCriticality.critical}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Critical
                      </Typography>
                    </Box>
                  )}
                </Stack>

                <Stack spacing={1}>
                  {criticalFlowStats.byCriticality.high > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2">High Priority</Typography>
                      <Chip label={criticalFlowStats.byCriticality.high} size="small" color="warning" />
                    </Stack>
                  )}
                  {criticalFlowStats.untested > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Warning fontSize="small" color="warning" />
                        <Typography variant="body2">Untested Critical</Typography>
                      </Stack>
                      <Chip label={criticalFlowStats.untested} size="small" color="warning" />
                    </Stack>
                  )}
                  {criticalFlowStats.highErrorRate > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <ErrorIcon fontSize="small" color="error" />
                        <Typography variant="body2">High Error Rate</Typography>
                      </Stack>
                      <Chip label={criticalFlowStats.highErrorRate} size="small" color="error" />
                    </Stack>
                  )}
                </Stack>

                {onViewCriticalFlows && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                  >
                    View all critical flows
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {changeRiskStats && changeRiskStats.total > 0 && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewChangeRisk ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewChangeRisk ? {
                    boxShadow: 2,
                    borderColor: 'error.main',
                  } : {},
                }}
                onClick={onViewChangeRisk}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Shield color="error" />
                  <Typography variant="h6" fontWeight={600}>
                    Change Risk
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
                  <Box>
                    <Typography variant="h5" fontWeight={700} color="error.main">
                      {changeRiskStats.highRisk}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      High Risk
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="h5" fontWeight={700} color="text.secondary">
                      {changeRiskStats.total}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Total Nodes
                    </Typography>
                  </Box>
                </Stack>

                <Stack spacing={1}>
                  {changeRiskStats.byLevel.critical > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <ErrorIcon fontSize="small" color="error" />
                        <Typography variant="body2">Critical</Typography>
                      </Stack>
                      <Chip label={changeRiskStats.byLevel.critical} size="small" color="error" />
                    </Stack>
                  )}
                  {changeRiskStats.byLevel.high > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Warning fontSize="small" color="warning" />
                        <Typography variant="body2">High</Typography>
                      </Stack>
                      <Chip label={changeRiskStats.byLevel.high} size="small" color="warning" />
                    </Stack>
                  )}
                  {changeRiskStats.recentHotspots > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <TrendingUp fontSize="small" color="info" />
                        <Typography variant="body2">Recent Hotspots</Typography>
                      </Stack>
                      <Chip label={changeRiskStats.recentHotspots} size="small" color="info" />
                    </Stack>
                  )}
                </Stack>

                {onViewChangeRisk && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                  >
                    View change risk analysis
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {securitySummary && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewSecurityBoundaries ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewSecurityBoundaries ? {
                    boxShadow: 2,
                    borderColor: 'success.main',
                  } : {},
                }}
                onClick={onViewSecurityBoundaries}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Security color="success" />
                  <Typography variant="h6" fontWeight={600}>
                    Security Boundaries
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
                  <Box>
                    <Typography variant="h5" fontWeight={700} color="success.main">
                      {securitySummary.assumed_vs_enforced.enforced}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Enforced
                    </Typography>
                  </Box>
                  {securitySummary.assumed_vs_enforced.assumed > 0 && (
                    <Box>
                      <Typography variant="h5" fontWeight={700} color="warning.main">
                        {securitySummary.assumed_vs_enforced.assumed}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Assumed
                      </Typography>
                    </Box>
                  )}
                  {securitySummary.assumed_vs_enforced.missing > 0 && (
                    <Box>
                      <Typography variant="h5" fontWeight={700} color="error.main">
                        {securitySummary.assumed_vs_enforced.missing}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Missing
                      </Typography>
                    </Box>
                  )}
                </Stack>

                {securitySummary.unprotected_sensitive_ops.length > 0 && (
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1 }}>
                    <Warning fontSize="small" color="warning" />
                    <Typography variant="body2" color="warning.main">
                      {securitySummary.unprotected_sensitive_ops.length} unprotected operations
                    </Typography>
                  </Stack>
                )}

                {onViewSecurityBoundaries && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                  >
                    View security analysis
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {stabilitySummary && Object.keys(stabilitySummary.by_stability_class).length > 0 && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewCodeStability ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewCodeStability ? {
                    boxShadow: 2,
                    borderColor: 'info.main',
                  } : {},
                }}
                onClick={onViewCodeStability}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <TrendingUp color="info" />
                  <Typography variant="h6" fontWeight={600}>
                    Code Stability
                  </Typography>
                </Stack>

                <Stack spacing={1}>
                  {stabilitySummary.by_stability_class['stable'] > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <CheckCircle fontSize="small" color="success" />
                        <Typography variant="body2">Stable</Typography>
                      </Stack>
                      <Chip label={stabilitySummary.by_stability_class['stable']} size="small" color="success" />
                    </Stack>
                  )}
                  {stabilitySummary.by_stability_class['evolving'] > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2">Evolving</Typography>
                      <Chip label={stabilitySummary.by_stability_class['evolving']} size="small" color="info" />
                    </Stack>
                  )}
                  {stabilitySummary.by_stability_class['volatile'] > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Warning fontSize="small" color="warning" />
                        <Typography variant="body2">Volatile</Typography>
                      </Stack>
                      <Chip label={stabilitySummary.by_stability_class['volatile']} size="small" color="warning" />
                    </Stack>
                  )}
                  {stabilitySummary.by_stability_class['fragile'] > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <ErrorIcon fontSize="small" color="error" />
                        <Typography variant="body2">Fragile</Typography>
                      </Stack>
                      <Chip label={stabilitySummary.by_stability_class['fragile']} size="small" color="error" />
                    </Stack>
                  )}
                </Stack>

                {stabilitySummary.hotspots.length > 0 && (
                  <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                    <Typography variant="caption" color="text.secondary">
                      {stabilitySummary.hotspots.length} code hotspot{stabilitySummary.hotspots.length !== 1 ? 's' : ''} detected
                    </Typography>
                  </Box>
                )}

                {onViewCodeStability && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: stabilitySummary.hotspots.length > 0 ? 0 : 2, borderTop: stabilitySummary.hotspots.length > 0 ? 0 : 1, borderColor: 'divider' }}
                  >
                    View stability analysis
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {dataEntities.length > 0 && (
            <Grid item xs={12} md={4}>
              <Paper
                sx={{
                  p: 3,
                  height: '100%',
                  cursor: onViewDataEntities ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  '&:hover': onViewDataEntities ? {
                    boxShadow: 2,
                    borderColor: 'primary.main',
                  } : {},
                }}
                onClick={onViewDataEntities}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <DataObject color="primary" />
                  <Typography variant="h6" fontWeight={600}>
                    Data Entities
                  </Typography>
                </Stack>

                <Typography variant="h5" fontWeight={700} color="primary.main" sx={{ mb: 2 }}>
                  {dataEntities.length}
                </Typography>

                <Stack spacing={0.5}>
                  {dataEntities.slice(0, 4).map(entity => (
                    <Stack key={entity.id} direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" noWrap sx={{ maxWidth: 150 }}>
                        {entity.name}
                      </Typography>
                      <Stack direction="row" spacing={0.5}>
                        {entity.fields?.some(f => f.is_sensitive) && (
                          <Chip label="PII" size="small" color="warning" sx={{ height: 16, fontSize: '0.55rem' }} />
                        )}
                        <Chip
                          label={`${(entity.fields?.length || 0)} fields`}
                          size="small"
                          variant="outlined"
                          sx={{ height: 16, fontSize: '0.55rem' }}
                        />
                      </Stack>
                    </Stack>
                  ))}
                  {dataEntities.length > 4 && (
                    <Typography variant="caption" color="text.secondary">
                      +{dataEntities.length - 4} more entities
                    </Typography>
                  )}
                </Stack>

                {onViewDataEntities && (
                  <Typography
                    variant="body2"
                    color="primary"
                    sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}
                  >
                    View all data entities
                  </Typography>
                )}
              </Paper>
            </Grid>
          )}

          {externalServices.length > 0 && (
            <Grid item xs={12}>
              <Paper sx={{ p: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Cloud color="primary" />
                  <Typography variant="h6" fontWeight={600}>
                    External Integrations
                  </Typography>
                </Stack>

                <Grid container spacing={2}>
                  {externalServices.map((svc: any) => (
                    <Grid item xs={12} sm={6} md={4} key={svc.id}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        {svc.type === 'database' && <Storage color="secondary" />}
                        {svc.type === 'sdk' && <Code color="info" />}
                        {!['database', 'sdk'].includes(svc.type) && <Cloud color="action" />}
                        <Box>
                          <Typography variant="body2" fontWeight={500}>
                            {svc.name.replace(/via.*$/, '').trim()}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {svc.type}
                          </Typography>
                        </Box>
                      </Stack>
                    </Grid>
                  ))}
                </Grid>
              </Paper>
            </Grid>
          )}

          {showSectionsArea && (
            <Grid item xs={12}>
              <Divider sx={{ my: 2 }} />
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
                {capabilities?.systemType === 'cli-application' ? (
                  <Terminal color="primary" />
                ) : capabilities?.systemType === 'frontend-app' ? (
                  <Web color="primary" />
                ) : (
                  <AccountTree color="primary" />
                )}
                <Typography variant="h5" fontWeight={600}>
                  {sectionTitle}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  ({useSections ? sections.length : domains.length} areas)
                </Typography>
              </Stack>

              {useSections && sections.length > 0 ? (
                <Grid container spacing={2}>
                  {sections.map(section => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={section.id}>
                      <Card
                        variant="outlined"
                        sx={{
                          height: '100%',
                          transition: 'all 0.2s ease',
                          '&:hover': {
                            borderColor: section.color,
                            boxShadow: 2,
                          },
                        }}
                      >
                        <CardActionArea
                          onClick={() => onSectionSelect?.(section)}
                          sx={{ height: '100%' }}
                        >
                          <CardContent>
                            <Stack spacing={1.5}>
                              <Stack direction="row" spacing={1.5} alignItems="center">
                                <Box
                                  sx={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: 1,
                                    bgcolor: `${section.color}15`,
                                    color: section.color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                  }}
                                >
                                  {SECTION_ICONS[section.icon] || <Category fontSize="small" />}
                                </Box>
                                <Box>
                                  <Typography variant="subtitle1" fontWeight={600}>
                                    {section.name}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {section.stats.entryPoints} {section.stats.entryPoints === 1 ? 'entry' : 'entries'}
                                  </Typography>
                                </Box>
                              </Stack>

                              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                                {section.stats.hasAuth && (
                                  <Chip
                                    icon={<Security sx={{ fontSize: 12 }} />}
                                    label="Auth"
                                    size="small"
                                    sx={{ height: 20, fontSize: '0.65rem' }}
                                  />
                                )}
                                {section.stats.hasDatabase && (
                                  <Chip
                                    icon={<Storage sx={{ fontSize: 12 }} />}
                                    label="DB"
                                    size="small"
                                    sx={{ height: 20, fontSize: '0.65rem' }}
                                  />
                                )}
                                {section.stats.hasExternalCalls && (
                                  <Chip
                                    icon={<Cloud sx={{ fontSize: 12 }} />}
                                    label="External"
                                    size="small"
                                    sx={{ height: 20, fontSize: '0.65rem' }}
                                  />
                                )}
                              </Stack>
                            </Stack>
                          </CardContent>
                        </CardActionArea>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              ) : domains.length > 0 ? (
                <Grid container spacing={2}>
                  {domains.map(domain => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={domain.id}>
                      <Card
                        variant="outlined"
                        sx={{
                          height: '100%',
                          transition: 'all 0.2s ease',
                          '&:hover': {
                            borderColor: domain.color,
                            boxShadow: 2,
                          },
                        }}
                      >
                        <CardActionArea
                          onClick={() => onDomainSelect(domain)}
                          sx={{ height: '100%' }}
                        >
                          <CardContent>
                            <Stack spacing={1.5}>
                              <Stack direction="row" spacing={1.5} alignItems="center">
                                <Box
                                  sx={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: 1,
                                    bgcolor: `${domain.color}15`,
                                    color: domain.color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                  }}
                                >
                                  {ICON_MAP[domain.icon] || <Category fontSize="small" />}
                                </Box>
                                <Box>
                                  <Typography variant="subtitle1" fontWeight={600}>
                                    {domain.name}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {domain.stats.entryPoints} endpoints
                                  </Typography>
                                </Box>
                              </Stack>

                              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                                {domain.stats.hasAuth && (
                                  <Chip
                                    icon={<Security sx={{ fontSize: 12 }} />}
                                    label="Auth"
                                    size="small"
                                    sx={{ height: 20, fontSize: '0.65rem' }}
                                  />
                                )}
                                {domain.stats.hasDatabase && (
                                  <Chip
                                    icon={<Storage sx={{ fontSize: 12 }} />}
                                    label="DB"
                                    size="small"
                                    sx={{ height: 20, fontSize: '0.65rem' }}
                                  />
                                )}
                              </Stack>
                            </Stack>
                          </CardContent>
                        </CardActionArea>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              ) : (
                <Paper sx={{ p: 4, textAlign: 'center' }}>
                  <Typography color="text.secondary">
                    No entry points detected.
                  </Typography>
                </Paper>
              )}
            </Grid>
          )}
        </Grid>
      </Box>
    </Box>
  );
};

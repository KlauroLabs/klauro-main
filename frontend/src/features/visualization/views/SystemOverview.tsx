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
} from '@mui/icons-material';
import { CASOutput, CASPattern } from '../types';
import { Domain, extractDomains } from '../utils/domainExtractor';

export type ArchitectureItemType = 'controller' | 'guard' | 'service' | 'repository' | 'gateway';

export interface SystemOverviewProps {
  cas: CASOutput;
  patterns?: CASPattern[];
  onDomainSelect: (domain: Domain) => void;
  onViewArchitecture?: () => void;
  onViewImplementationHealth?: () => void;
  onViewArchitectureItems?: (itemType: ArchitectureItemType) => void;
  onViewPatterns?: () => void;
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

export const SystemOverview: React.FC<SystemOverviewProps> = ({
  cas,
  patterns = [],
  onDomainSelect,
  onViewArchitecture,
  onViewImplementationHealth,
  onViewArchitectureItems,
  onViewPatterns,
}) => {
  const domains = useMemo(() => extractDomains(cas), [cas]);

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
      .filter(([type]) => ['http', 'websocket', 'message', 'scheduled', 'event'].includes(type))
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

              {architectureSummary?.layers ? (
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
            <Paper sx={{ p: 3, height: '100%' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Api color="primary" />
                <Typography variant="h6" fontWeight={600}>
                  Entry Points
                </Typography>
              </Stack>

              <Stack spacing={1.5}>
                {entryPointsByType.map(([type, count]) => (
                  <Stack key={type} direction="row" justifyContent="space-between" alignItems="center">
                    <Stack direction="row" spacing={1} alignItems="center">
                      {type === 'http' && <Hub fontSize="small" color="action" />}
                      {type === 'websocket' && <Dns fontSize="small" color="action" />}
                      {type === 'message' && <Memory fontSize="small" color="action" />}
                      <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>
                        {type === 'http' ? 'HTTP/REST' : type}
                      </Typography>
                    </Stack>
                    <Chip label={count} size="small" />
                  </Stack>
                ))}
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
            </Paper>
          </Grid>

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

          <Grid item xs={12}>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
              <AccountTree color="primary" />
              <Typography variant="h5" fontWeight={600}>
                API Domains
              </Typography>
              <Typography variant="body2" color="text.secondary">
                ({domains.length} areas)
              </Typography>
            </Stack>

            {domains.length > 0 ? (
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
                  No HTTP API domains detected.
                </Typography>
              </Paper>
            )}
          </Grid>
        </Grid>
      </Box>
    </Box>
  );
};

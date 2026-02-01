import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Chip,
  LinearProgress,
  Tabs,
  Tab,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
} from '@mui/material';
import {
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
  CheckCircle as CheckCircleIcon,
  Warning as WarningIcon,
  Error as ErrorIcon,
  Schedule as ScheduleIcon,
  BugReport as BugReportIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import type { CASOutput, CASTemporalStability } from '../../../types/cas.types';

export interface CodeStabilityViewProps {
  data: CASOutput;
  onNodeSelect?: (nodeId: string) => void;
}

const stabilityColors: Record<string, string> = {
  'stable': '#4caf50',
  'evolving': '#2196f3',
  'volatile': '#ff9800',
  'fragile': '#f44336',
};

const stabilityIcons: Record<string, React.ReactNode> = {
  'stable': <CheckCircleIcon sx={{ color: '#4caf50' }} />,
  'evolving': <TrendingUpIcon sx={{ color: '#2196f3' }} />,
  'volatile': <WarningIcon sx={{ color: '#ff9800' }} />,
  'fragile': <ErrorIcon sx={{ color: '#f44336' }} />,
};

type SortField = 'name' | 'stability_score' | 'commits_30d' | 'bug_fix_rate';
type SortDirection = 'asc' | 'desc';

export const CodeStabilityView: React.FC<CodeStabilityViewProps> = ({
  data,
  onNodeSelect,
}) => {
  const [activeTab, setActiveTab] = useState(0);
  const [sortField, setSortField] = useState<SortField>('stability_score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const stabilityData = data.temporal_stability || [];
  const summary = data.stability_summary;

  const nodeMap = useMemo(() => {
    const map = new Map<string, { name: string; file?: string }>();
    data.nodes?.forEach(node => {
      map.set(node.id, { name: node.name, file: node.source?.file });
    });
    return map;
  }, [data.nodes]);

  const getNodeName = (nodeId: string) => {
    const node = nodeMap.get(nodeId);
    return node?.name || nodeId;
  };

  const getNodeFile = (nodeId: string) => {
    const node = nodeMap.get(nodeId);
    return node?.file;
  };

  const byStabilityClass = useMemo(() => {
    const grouped: Record<string, CASTemporalStability[]> = {
      stable: [],
      evolving: [],
      volatile: [],
      fragile: [],
    };
    stabilityData.forEach(item => {
      if (grouped[item.stability_class]) {
        grouped[item.stability_class].push(item);
      }
    });
    return grouped;
  }, [stabilityData]);

  const sortedData = useMemo(() => {
    const sorted = [...stabilityData].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortField) {
        case 'name':
          aVal = getNodeName(a.node_id);
          bVal = getNodeName(b.node_id);
          break;
        case 'stability_score':
          aVal = a.stability_score;
          bVal = b.stability_score;
          break;
        case 'commits_30d':
          aVal = a.churn_metrics.commits_30d;
          bVal = b.churn_metrics.commits_30d;
          break;
        case 'bug_fix_rate':
          aVal = a.quality_signals.bug_fix_rate;
          bVal = b.quality_signals.bug_fix_rate;
          break;
        default:
          return 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      return sortDirection === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [stabilityData, sortField, sortDirection, getNodeName]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const hotspots = summary?.hotspots || [];
  const legacyAreas = summary?.legacy_areas || [];

  if (stabilityData.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          No temporal stability data available. Stability metrics are calculated from git history,
          including commit frequency, author count, and bug fix patterns.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <HistoryIcon sx={{ fontSize: 32, color: 'primary.main' }} />
        <Box>
          <Typography variant="h5">Code Stability</Typography>
          <Typography variant="body2" color="text.secondary">
            Temporal analysis of code churn, bug fixes, and volatility
          </Typography>
        </Box>
      </Box>

      {summary?.by_stability_class && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle2" gutterBottom>Distribution by Stability Class</Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {Object.entries(summary.by_stability_class).map(([cls, count]) => (
              <Box
                key={cls}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: `${stabilityColors[cls]}15`,
                  border: `1px solid ${stabilityColors[cls]}40`,
                }}
              >
                {stabilityIcons[cls]}
                <Box>
                  <Typography variant="h6" sx={{ color: stabilityColors[cls], lineHeight: 1 }}>
                    {count}
                  </Typography>
                  <Typography variant="caption" sx={{ textTransform: 'capitalize' }}>
                    {cls}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Paper>
      )}

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="Overview" />
          <Tab label={`Hotspots (${hotspots.length})`} />
          <Tab label={`Legacy (${legacyAreas.length})`} />
          <Tab label="All Nodes" />
        </Tabs>
      </Box>

      {activeTab === 0 && (
        <Box>
          {['fragile', 'volatile', 'evolving', 'stable'].map(stabilityClass => {
            const items = byStabilityClass[stabilityClass];
            if (items.length === 0) return null;

            return (
              <Box key={stabilityClass} sx={{ mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                  {stabilityIcons[stabilityClass]}
                  <Typography variant="h6" sx={{ textTransform: 'capitalize' }}>
                    {stabilityClass}
                  </Typography>
                  <Chip label={items.length} size="small" />
                </Box>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {items.slice(0, 5).map(item => (
                    <Paper
                      key={item.node_id}
                      sx={{
                        p: 2,
                        cursor: 'pointer',
                        '&:hover': { bgcolor: 'action.hover' },
                        borderLeft: `4px solid ${stabilityColors[item.stability_class]}`,
                      }}
                      onClick={() => onNodeSelect?.(item.node_id)}
                    >
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Box>
                          <Typography variant="subtitle2">{getNodeName(item.node_id)}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {getNodeFile(item.node_id)}
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Box sx={{ width: 60, textAlign: 'right' }}>
                            <Typography variant="caption" color="text.secondary">Score</Typography>
                            <Typography variant="body2" fontWeight={500}>
                              {item.stability_score}
                            </Typography>
                          </Box>
                          <LinearProgress
                            variant="determinate"
                            value={item.stability_score}
                            sx={{
                              width: 60,
                              height: 8,
                              borderRadius: 4,
                              bgcolor: 'grey.200',
                              '& .MuiLinearProgress-bar': {
                                bgcolor: stabilityColors[item.stability_class],
                              },
                            }}
                          />
                        </Box>
                      </Box>

                      <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <ScheduleIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                          <Typography variant="caption">
                            {item.churn_metrics.commits_30d} commits/30d
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <BugReportIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                          <Typography variant="caption">
                            {Math.round(item.quality_signals.bug_fix_rate * 100)}% bug fixes
                          </Typography>
                        </Box>
                        {item.age_context.is_legacy && (
                          <Chip label="Legacy" size="small" color="warning" variant="outlined" />
                        )}
                      </Box>
                    </Paper>
                  ))}
                  {items.length > 5 && (
                    <Typography variant="body2" color="text.secondary" sx={{ pl: 2 }}>
                      +{items.length - 5} more {stabilityClass} nodes
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {activeTab === 1 && (
        <Box>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Hotspots are areas with high code churn combined with quality issues like frequent bug fixes.
          </Alert>
          {hotspots.length === 0 ? (
            <Typography color="text.secondary">No hotspots detected</Typography>
          ) : (
            hotspots.map((hotspot, idx) => (
              <Paper
                key={idx}
                sx={{
                  p: 2,
                  mb: 1,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover' },
                  borderLeft: '4px solid #f44336',
                }}
                onClick={() => onNodeSelect?.(hotspot.node_id)}
              >
                <Typography variant="subtitle2">{getNodeName(hotspot.node_id)}</Typography>
                <Typography variant="body2" color="text.secondary">{hotspot.reason}</Typography>
              </Paper>
            ))
          )}
        </Box>
      )}

      {activeTab === 2 && (
        <Box>
          <Alert severity="info" sx={{ mb: 2 }}>
            Legacy areas are identified from code comments, naming patterns, and age indicators.
          </Alert>
          {legacyAreas.length === 0 ? (
            <Typography color="text.secondary">No legacy areas detected</Typography>
          ) : (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {legacyAreas.map(nodeId => (
                <Chip
                  key={nodeId}
                  label={getNodeName(nodeId)}
                  onClick={() => onNodeSelect?.(nodeId)}
                  sx={{ cursor: 'pointer' }}
                />
              ))}
            </Box>
          )}
        </Box>
      )}

      {activeTab === 3 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>
                  <TableSortLabel
                    active={sortField === 'name'}
                    direction={sortField === 'name' ? sortDirection : 'asc'}
                    onClick={() => handleSort('name')}
                  >
                    Node
                  </TableSortLabel>
                </TableCell>
                <TableCell>Class</TableCell>
                <TableCell align="right">
                  <TableSortLabel
                    active={sortField === 'stability_score'}
                    direction={sortField === 'stability_score' ? sortDirection : 'asc'}
                    onClick={() => handleSort('stability_score')}
                  >
                    Score
                  </TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel
                    active={sortField === 'commits_30d'}
                    direction={sortField === 'commits_30d' ? sortDirection : 'asc'}
                    onClick={() => handleSort('commits_30d')}
                  >
                    Commits (30d)
                  </TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel
                    active={sortField === 'bug_fix_rate'}
                    direction={sortField === 'bug_fix_rate' ? sortDirection : 'asc'}
                    onClick={() => handleSort('bug_fix_rate')}
                  >
                    Bug Fix Rate
                  </TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedData.slice(0, 100).map(item => (
                <TableRow
                  key={item.node_id}
                  hover
                  onClick={() => onNodeSelect?.(item.node_id)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Typography variant="body2">{getNodeName(item.node_id)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {getNodeFile(item.node_id)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={item.stability_class}
                      sx={{
                        bgcolor: `${stabilityColors[item.stability_class]}20`,
                        color: stabilityColors[item.stability_class],
                        textTransform: 'capitalize',
                      }}
                    />
                  </TableCell>
                  <TableCell align="right">{item.stability_score}</TableCell>
                  <TableCell align="right">{item.churn_metrics.commits_30d}</TableCell>
                  <TableCell align="right">{Math.round(item.quality_signals.bug_fix_rate * 100)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {sortedData.length > 100 && (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                Showing 100 of {sortedData.length} nodes
              </Typography>
            </Box>
          )}
        </TableContainer>
      )}
    </Box>
  );
};

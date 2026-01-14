import React, { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Chip,
  Stack,
  Card,
  CardContent,
  Collapse,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  InputAdornment,
  Alert,
  AlertTitle,
  Divider,
  Tooltip,
  Badge,
} from '@mui/material';
import {
  Search,
  Timeline,
  Warning,
  Error as ErrorIcon,
  CheckCircle,
  Speed,
  Loop,
  ExpandMore,
  ExpandLess,
  Storage,
  Cloud,
  Code,
  ArrowForward,
  Security,
} from '@mui/icons-material';
import { CASCallChain, CASMethodCall, CASNode } from '../types';

export interface CallChainsViewProps {
  callChains: CASCallChain[];
  methodCalls: CASMethodCall[];
  nodes: CASNode[];
  onChainSelect?: (chain: CASCallChain) => void;
  onNodeClick?: (nodeId: string) => void;
}

type FilterType = 'all' | 'critical' | 'hot-path' | 'recursive' | 'database' | 'async';
type SortType = 'risk' | 'depth' | 'calls';

const RISK_COLORS: Record<string, string> = {
  critical: '#d32f2f',
  high: '#f57c00',
  medium: '#fbc02d',
  low: '#4caf50',
};

const CHAIN_TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  'entry-to-exit': { color: '#2196f3', icon: <Timeline /> },
  'critical-path': { color: '#d32f2f', icon: <Security /> },
  'hot-path': { color: '#ff5722', icon: <Speed /> },
  circular: { color: '#ff9800', icon: <Loop /> },
  recursive: { color: '#e91e63', icon: <Loop /> },
  'dead-end': { color: '#9e9e9e', icon: <Warning /> },
};

export const CallChainsView: React.FC<CallChainsViewProps> = ({
  callChains,
  methodCalls,
  nodes,
  onChainSelect,
  onNodeClick,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [sortType, setSortType] = useState<SortType>('risk');
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);

  const stats = useMemo(() => ({
    total: callChains.length,
    critical: callChains.filter(c => c.risk_analysis.risk_level === 'critical').length,
    high: callChains.filter(c => c.risk_analysis.risk_level === 'high').length,
    hotPaths: callChains.filter(c => c.chain_type === 'hot-path').length,
    withDatabase: callChains.filter(c => c.characteristics.has_database_calls).length,
    withAsync: callChains.filter(c => c.characteristics.has_async_calls).length,
    recursive: callChains.filter(c => c.characteristics.is_recursive).length,
  }), [callChains]);

  const filteredAndSorted = useMemo(() => {
    let result = [...callChains];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        c =>
          c.entry_point.method_name.toLowerCase().includes(query) ||
          c.exit_point?.method_name?.toLowerCase().includes(query) ||
          c.call_path.some(p => p.method_name.toLowerCase().includes(query))
      );
    }

    switch (filterType) {
      case 'critical':
        result = result.filter(
          c => c.risk_analysis.risk_level === 'critical' || c.risk_analysis.risk_level === 'high'
        );
        break;
      case 'hot-path':
        result = result.filter(c => c.chain_type === 'hot-path' || c.chain_type === 'critical-path');
        break;
      case 'recursive':
        result = result.filter(c => c.characteristics.is_recursive || c.characteristics.is_circular);
        break;
      case 'database':
        result = result.filter(c => c.characteristics.has_database_calls);
        break;
      case 'async':
        result = result.filter(c => c.characteristics.has_async_calls);
        break;
    }

    const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    result.sort((a, b) => {
      switch (sortType) {
        case 'risk':
          return riskOrder[a.risk_analysis.risk_level] - riskOrder[b.risk_analysis.risk_level];
        case 'depth':
          return b.characteristics.max_depth - a.characteristics.max_depth;
        case 'calls':
          return b.characteristics.total_calls - a.characteristics.total_calls;
        default:
          return 0;
      }
    });

    return result;
  }, [callChains, searchQuery, filterType, sortType]);

  const toggleExpand = (chainId: string) => {
    setExpandedChains(prev => {
      const next = new Set(prev);
      if (next.has(chainId)) {
        next.delete(chainId);
      } else {
        next.add(chainId);
      }
      return next;
    });
  };

  const handleChainClick = (chain: CASCallChain) => {
    setSelectedChainId(chain.id);
    onChainSelect?.(chain);
  };

  const renderChainPath = (chain: CASCallChain) => {
    return (
      <Box sx={{ pl: 2, py: 1 }}>
        <Stack spacing={1}>
          {chain.call_path.map((step, index) => {
            const isFirst = index === 0;
            const isLast = index === chain.call_path.length - 1;
            const nodeData = nodes.find(n => n.id === step.node_id);

            return (
              <Stack
                key={index}
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ pl: step.depth * 2 }}
              >
                <Box
                  sx={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    bgcolor: isFirst ? 'success.main' : isLast ? 'error.main' : 'primary.main',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}
                >
                  {step.depth}
                </Box>
                <Typography
                  variant="body2"
                  sx={{
                    cursor: 'pointer',
                    '&:hover': { textDecoration: 'underline' },
                  }}
                  onClick={() => onNodeClick?.(step.node_id)}
                >
                  {step.method_name}
                </Typography>
                {step.execution_branch && (
                  <Chip label={step.execution_branch} size="small" variant="outlined" />
                )}
                {index < chain.call_path.length - 1 && (
                  <ArrowForward fontSize="small" color="action" />
                )}
              </Stack>
            );
          })}
        </Stack>

        {chain.risk_analysis.bottlenecks && chain.risk_analysis.bottlenecks.length > 0 && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            <AlertTitle>Bottlenecks Detected</AlertTitle>
            <Stack spacing={1}>
              {chain.risk_analysis.bottlenecks.map((b, i) => (
                <Box key={i}>
                  <Typography variant="body2" fontWeight={500}>
                    {b.method_name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {b.reason} (Impact: {b.impact})
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Alert>
        )}

        {chain.business_context && (
          <Card variant="outlined" sx={{ mt: 2 }}>
            <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
              <Typography variant="subtitle2" gutterBottom>Business Context</Typography>
              <Stack spacing={0.5}>
                {chain.business_context.user_action && (
                  <Typography variant="body2">
                    Action: {chain.business_context.user_action}
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
      </Box>
    );
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 2, gap: 2 }}>
      <Stack direction="row" spacing={2} flexWrap="wrap">
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Typography variant="h5" fontWeight={600}>{stats.total}</Typography>
            <Typography variant="caption" color="text.secondary">Total Chains</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="error.main">
                {stats.critical + stats.high}
              </Typography>
              <ErrorIcon fontSize="small" color="error" />
            </Stack>
            <Typography variant="caption" color="text.secondary">High Risk</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="warning.main">{stats.hotPaths}</Typography>
              <Speed fontSize="small" color="warning" />
            </Stack>
            <Typography variant="caption" color="text.secondary">Hot Paths</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="secondary.main">{stats.withDatabase}</Typography>
              <Storage fontSize="small" color="secondary" />
            </Stack>
            <Typography variant="caption" color="text.secondary">Database Calls</Typography>
          </CardContent>
        </Card>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <TextField
            size="small"
            placeholder="Search call chains..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Search fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ minWidth: 250 }}
          />

          <ToggleButtonGroup
            value={filterType}
            exclusive
            onChange={(_, val) => val && setFilterType(val)}
            size="small"
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="critical">
              <Badge badgeContent={stats.critical + stats.high} color="error" max={99}>
                <ErrorIcon fontSize="small" />
              </Badge>
            </ToggleButton>
            <ToggleButton value="hot-path">
              <Speed fontSize="small" />
            </ToggleButton>
            <ToggleButton value="database">
              <Storage fontSize="small" />
            </ToggleButton>
            <ToggleButton value="async">
              <Cloud fontSize="small" />
            </ToggleButton>
            <ToggleButton value="recursive">
              <Loop fontSize="small" />
            </ToggleButton>
          </ToggleButtonGroup>

          <ToggleButtonGroup
            value={sortType}
            exclusive
            onChange={(_, val) => val && setSortType(val)}
            size="small"
          >
            <ToggleButton value="risk">Risk</ToggleButton>
            <ToggleButton value="depth">Depth</ToggleButton>
            <ToggleButton value="calls">Calls</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Paper>

      <Paper sx={{ flex: 1, overflow: 'auto' }}>
        <List disablePadding>
          {filteredAndSorted.map((chain, index) => {
            const isExpanded = expandedChains.has(chain.id);
            const isSelected = selectedChainId === chain.id;
            const typeConfig = CHAIN_TYPE_CONFIG[chain.chain_type] || CHAIN_TYPE_CONFIG['entry-to-exit'];
            const riskColor = RISK_COLORS[chain.risk_analysis.risk_level];

            return (
              <React.Fragment key={chain.id}>
                {index > 0 && <Divider />}
                <ListItem
                  disablePadding
                  secondaryAction={
                    <IconButton onClick={() => toggleExpand(chain.id)}>
                      {isExpanded ? <ExpandLess /> : <ExpandMore />}
                    </IconButton>
                  }
                  sx={{
                    borderLeft: 4,
                    borderLeftColor: riskColor,
                    bgcolor: isSelected ? 'action.selected' : 'transparent',
                  }}
                >
                  <ListItemButton onClick={() => handleChainClick(chain)}>
                    <ListItemIcon sx={{ color: typeConfig.color }}>
                      {typeConfig.icon}
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="subtitle2">
                            {chain.entry_point.method_name}
                          </Typography>
                          {chain.exit_point && (
                            <>
                              <ArrowForward fontSize="small" color="action" />
                              <Typography variant="subtitle2">
                                {chain.exit_point.method_name}
                              </Typography>
                            </>
                          )}
                        </Stack>
                      }
                      secondary={
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                          <Chip
                            label={chain.chain_type.replace('-', ' ').toUpperCase()}
                            size="small"
                            sx={{ bgcolor: `${typeConfig.color}20`, color: typeConfig.color }}
                          />
                          <Chip
                            label={chain.risk_analysis.risk_level.toUpperCase()}
                            size="small"
                            sx={{ bgcolor: `${riskColor}20`, color: riskColor }}
                          />
                          <Typography variant="caption" color="text.secondary">
                            Depth: {chain.characteristics.max_depth} | Calls: {chain.characteristics.total_calls}
                          </Typography>
                          {chain.characteristics.has_database_calls && (
                            <Tooltip title="Has database calls">
                              <Storage fontSize="small" color="secondary" />
                            </Tooltip>
                          )}
                          {chain.characteristics.has_async_calls && (
                            <Tooltip title="Has async calls">
                              <Cloud fontSize="small" color="info" />
                            </Tooltip>
                          )}
                          {chain.characteristics.is_recursive && (
                            <Tooltip title="Recursive">
                              <Loop fontSize="small" color="warning" />
                            </Tooltip>
                          )}
                        </Stack>
                      }
                    />
                  </ListItemButton>
                </ListItem>
                <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                  <Box sx={{ bgcolor: 'action.hover' }}>
                    {renderChainPath(chain)}
                  </Box>
                </Collapse>
              </React.Fragment>
            );
          })}
        </List>

        {filteredAndSorted.length === 0 && (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography color="text.secondary">
              No call chains match the current filters
            </Typography>
          </Box>
        )}
      </Paper>
    </Box>
  );
};

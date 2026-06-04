import React, { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Chip,
  IconButton,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  InputAdornment,
} from '@mui/material';
import {
  ArrowBack,
  Warning,
  CheckCircle,
  BugReport,
  Build,
  Search,
  Code,
  FilterList,
} from '@mui/icons-material';
import { CASNode } from '../types';
import { Domain } from '../utils/domainExtractor';

export interface ImplementationHealthViewProps {
  nodes: CASNode[];
  domains?: Domain[];
  onBack: () => void;
  onNodeSelect?: (nodeId: string) => void;
}

type StatusFilter = 'all' | 'partial' | 'stub' | 'not-implemented' | 'has-todos';

const STATUS_LABELS: Record<string, string> = {
  complete: 'Complete',
  partial: 'Partial',
  stub: 'Stub',
  'not-implemented': 'Not Implemented',
  deprecated: 'Deprecated',
  experimental: 'Experimental',
};

const STATUS_COLORS: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  complete: 'success',
  partial: 'warning',
  stub: 'error',
  'not-implemented': 'error',
  deprecated: 'default',
  experimental: 'default',
};

export const ImplementationHealthView: React.FC<ImplementationHealthViewProps> = ({
  nodes,
  domains = [],
  onBack,
  onNodeSelect,
}) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const healthData = useMemo(() => {
    const nodesWithStatus = nodes.filter(n => n.implementation_status);

    const statusCounts = {
      complete: 0,
      partial: 0,
      stub: 0,
      'not-implemented': 0,
      deprecated: 0,
      experimental: 0,
      hasTodos: 0,
    };

    nodesWithStatus.forEach(n => {
      const status = n.implementation_status!.status;
      if (status in statusCounts) {
        statusCounts[status as keyof typeof statusCounts]++;
      }
      if (n.implementation_status!.indicators.has_todo_markers) {
        statusCounts.hasTodos++;
      }
    });

    return {
      total: nodesWithStatus.length,
      statusCounts,
      nodes: nodesWithStatus,
    };
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    let filtered = healthData.nodes;

    if (statusFilter === 'has-todos') {
      filtered = filtered.filter(n => n.implementation_status?.indicators.has_todo_markers);
    } else if (statusFilter !== 'all') {
      filtered = filtered.filter(n => n.implementation_status?.status === statusFilter);
    } else {
      filtered = filtered.filter(n => n.implementation_status?.status !== 'complete');
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(n =>
        n.name.toLowerCase().includes(query) ||
        n.source?.file?.toLowerCase().includes(query) ||
        n.type.toLowerCase().includes(query)
      );
    }

    return filtered.sort((a, b) => {
      const statusOrder = ['stub', 'not-implemented', 'partial', 'deprecated', 'experimental', 'complete'];
      const aOrder = statusOrder.indexOf(a.implementation_status?.status || 'complete');
      const bOrder = statusOrder.indexOf(b.implementation_status?.status || 'complete');
      return aOrder - bOrder;
    });
  }, [healthData.nodes, statusFilter, searchQuery]);

  const nodesByDomain = useMemo(() => {
    if (domains.length === 0) return new Map<string, CASNode[]>();

    const domainNodeMap = new Map<string, Set<string>>();
    domains.forEach(domain => {
      const nodeIds = new Set<string>();
      domain.capabilities.forEach(cap => {
        if (cap.entryPoint.handler?.node_id) {
          nodeIds.add(cap.entryPoint.handler.node_id);
        }
        cap.flow?.call_path.forEach(step => nodeIds.add(step.node_id));
        cap.flowSteps?.forEach(step => nodeIds.add(step.nodeId));
      });
      domainNodeMap.set(domain.id, nodeIds);
    });

    const result = new Map<string, CASNode[]>();
    filteredNodes.forEach(node => {
      for (const [domainId, nodeIds] of domainNodeMap) {
        if (nodeIds.has(node.id)) {
          const existing = result.get(domainId) || [];
          existing.push(node);
          result.set(domainId, existing);
          return;
        }
      }
      const existing = result.get('unassigned') || [];
      existing.push(node);
      result.set('unassigned', existing);
    });

    return result;
  }, [filteredNodes, domains]);

  const getDomainName = (domainId: string): string => {
    if (domainId === 'unassigned') return 'Other Components';
    const domain = domains.find(d => d.id === domainId);
    return domain?.name || domainId;
  };

  return (
    <Box sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 3, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <IconButton onClick={onBack}>
            <ArrowBack />
          </IconButton>
          <Build color="warning" />
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5" fontWeight={700}>
              Implementation Health
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {healthData.total} analyzed items, {filteredNodes.length} shown
            </Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          {healthData.statusCounts.partial > 0 && (
            <Chip
              icon={<Warning />}
              label={`${healthData.statusCounts.partial} Partial`}
              color="warning"
              variant={statusFilter === 'partial' ? 'filled' : 'outlined'}
              onClick={() => setStatusFilter(statusFilter === 'partial' ? 'all' : 'partial')}
            />
          )}
          {healthData.statusCounts.stub > 0 && (
            <Chip
              icon={<BugReport />}
              label={`${healthData.statusCounts.stub} Stub`}
              color="error"
              variant={statusFilter === 'stub' ? 'filled' : 'outlined'}
              onClick={() => setStatusFilter(statusFilter === 'stub' ? 'all' : 'stub')}
            />
          )}
          {healthData.statusCounts['not-implemented'] > 0 && (
            <Chip
              icon={<BugReport />}
              label={`${healthData.statusCounts['not-implemented']} Not Implemented`}
              color="error"
              variant={statusFilter === 'not-implemented' ? 'filled' : 'outlined'}
              onClick={() => setStatusFilter(statusFilter === 'not-implemented' ? 'all' : 'not-implemented')}
            />
          )}
          {healthData.statusCounts.hasTodos > 0 && (
            <Chip
              label={`${healthData.statusCounts.hasTodos} With TODOs`}
              variant={statusFilter === 'has-todos' ? 'filled' : 'outlined'}
              onClick={() => setStatusFilter(statusFilter === 'has-todos' ? 'all' : 'has-todos')}
            />
          )}
        </Stack>

        <TextField
          size="small"
          placeholder="Search by name, file, or type..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          sx={{ width: 300 }}
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
        {domains.length > 0 ? (
          Array.from(nodesByDomain.entries()).map(([domainId, domainNodes]) => (
            <Box key={domainId} sx={{ mb: 4 }}>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                {getDomainName(domainId)}
                <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                  ({domainNodes.length} items)
                </Typography>
              </Typography>
              <List disablePadding>
                {domainNodes.map(node => (
                  <HealthNodeItem
                    key={node.id}
                    node={node}
                    onClick={() => onNodeSelect?.(node.id)}
                  />
                ))}
              </List>
            </Box>
          ))
        ) : (
          <List disablePadding>
            {filteredNodes.map(node => (
              <HealthNodeItem
                key={node.id}
                node={node}
                onClick={() => onNodeSelect?.(node.id)}
              />
            ))}
          </List>
        )}

        {filteredNodes.length === 0 && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <CheckCircle color="success" sx={{ fontSize: 48, mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              All Clear
            </Typography>
            <Typography variant="body2" color="text.secondary">
              No incomplete implementations found matching your filters.
            </Typography>
          </Paper>
        )}
      </Box>
    </Box>
  );
};

interface HealthNodeItemProps {
  node: CASNode;
  onClick?: () => void;
}

const HealthNodeItem: React.FC<HealthNodeItemProps> = ({ node, onClick }) => {
  const status = node.implementation_status?.status || 'complete';
  const indicators = node.implementation_status?.indicators;
  const percentage = node.implementation_status?.completeness?.estimated_percentage;

  return (
    <Paper variant="outlined" sx={{ mb: 1 }}>
      <ListItemButton onClick={onClick} disabled={!onClick}>
        <ListItemIcon sx={{ minWidth: 40 }}>
          <Code fontSize="small" color="action" />
        </ListItemIcon>
        <ListItemText
          primary={
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2">{node.name}</Typography>
              <Chip
                label={STATUS_LABELS[status] || status}
                size="small"
                color={STATUS_COLORS[status] || 'default'}
                sx={{ height: 20, fontSize: '0.65rem' }}
              />
              {percentage !== undefined && percentage < 100 && (
                <Chip
                  label={`${percentage}%`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 18, fontSize: '0.6rem' }}
                />
              )}
            </Stack>
          }
          secondary={
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {node.type}
              </Typography>
              {node.source?.file && (
                <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                  {node.source.file.split('/').pop()}:{node.source.line}
                </Typography>
              )}
              {indicators?.has_todo_markers && (
                <Chip label="TODO" size="small" sx={{ height: 16, fontSize: '0.6rem' }} />
              )}
              {indicators?.has_stub_returns && (
                <Chip label="Stub Return" size="small" color="warning" sx={{ height: 16, fontSize: '0.6rem' }} />
              )}
              {indicators?.has_placeholder_code && (
                <Chip label="Placeholder" size="small" color="warning" sx={{ height: 16, fontSize: '0.6rem' }} />
              )}
            </Stack>
          }
        />
      </ListItemButton>
    </Paper>
  );
};

import React from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  CardActionArea,
  Stack,
  Chip,
  IconButton,
  Paper,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  ArrowBack,
  Lock,
  LockOpen,
  Storage,
  Cloud,
  Timeline,
  Code,
  Visibility,
  Edit,
  Add,
  Delete,
  List as ListIcon,
  Warning,
  CheckCircle,
  Build,
} from '@mui/icons-material';
import { CASNode } from '../types';
import { Domain, Capability } from '../utils/domainExtractor';

export interface DomainViewProps {
  domain: Domain;
  nodes?: CASNode[];
  onBack: () => void;
  onCapabilitySelect: (capability: Capability) => void;
}

const METHOD_COLORS: Record<string, string> = {
  GET: '#4caf50',
  POST: '#2196f3',
  PUT: '#ff9800',
  PATCH: '#ff9800',
  DELETE: '#f44336',
};

const ACTION_ICONS: Record<string, React.ReactNode> = {
  'List all': <ListIcon fontSize="small" />,
  'View details': <Visibility fontSize="small" />,
  'Create new': <Add fontSize="small" />,
  'Update': <Edit fontSize="small" />,
  'Delete': <Delete fontSize="small" />,
  'Manage': <Code fontSize="small" />,
};

export const DomainView: React.FC<DomainViewProps> = ({
  domain,
  nodes = [],
  onBack,
  onCapabilitySelect,
}) => {
  const domainNodeIds = React.useMemo(() => {
    const ids = new Set<string>();
    domain.capabilities.forEach(cap => {
      if (cap.entryPoint.handler?.node_id) {
        ids.add(cap.entryPoint.handler.node_id);
      }
      cap.flow?.call_path.forEach(step => {
        ids.add(step.node_id);
      });
      cap.flowSteps?.forEach(step => {
        ids.add(step.nodeId);
      });
    });
    return ids;
  }, [domain]);

  const implementationHealth = React.useMemo(() => {
    const domainNodes = nodes.filter(n => domainNodeIds.has(n.id) && n.implementation_status);
    if (domainNodes.length === 0) return null;

    const statusCounts = {
      complete: 0,
      partial: 0,
      stub: 0,
      'not-implemented': 0,
    };

    const incompleteNodes: Array<{
      id: string;
      name: string;
      type: string;
      status: string;
    }> = [];

    domainNodes.forEach(n => {
      const status = n.implementation_status!.status;
      if (status in statusCounts) {
        statusCounts[status as keyof typeof statusCounts]++;
      }
      if (status !== 'complete') {
        incompleteNodes.push({
          id: n.id,
          name: n.name,
          type: n.type,
          status,
        });
      }
    });

    const healthPercentage = domainNodes.length > 0
      ? Math.round((statusCounts.complete / domainNodes.length) * 100)
      : 100;

    return {
      total: domainNodes.length,
      statusCounts,
      incompleteNodes,
      healthPercentage,
    };
  }, [nodes, domainNodeIds]);

  const groupedCapabilities = React.useMemo(() => {
    const groups: Record<string, Capability[]> = {
      read: [],
      write: [],
      delete: [],
    };

    domain.capabilities.forEach(cap => {
      const method = cap.method?.toUpperCase() || '';
      if (method === 'GET') {
        groups.read.push(cap);
      } else if (method === 'DELETE') {
        groups.delete.push(cap);
      } else {
        groups.write.push(cap);
      }
    });

    return groups;
  }, [domain.capabilities]);

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Paper
        sx={{
          p: 3,
          borderRadius: 0,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: `${domain.color}08`,
        }}
      >
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <IconButton onClick={onBack}>
            <ArrowBack />
          </IconButton>
          <Box
            sx={{
              width: 56,
              height: 56,
              borderRadius: 2,
              bgcolor: `${domain.color}15`,
              color: domain.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
            }}
          >
            {domain.name.charAt(0)}
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h4" fontWeight={700}>
              {domain.name}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              {domain.description}
            </Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={3}>
          <Box>
            <Typography variant="h5" fontWeight={600}>
              {domain.stats.entryPoints}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Operations
            </Typography>
          </Box>
          <Divider orientation="vertical" flexItem />
          <Box>
            <Typography variant="h5" fontWeight={600}>
              {domain.stats.components}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Components
            </Typography>
          </Box>
          {domain.stats.hasDatabase && (
            <>
              <Divider orientation="vertical" flexItem />
              <Stack direction="row" spacing={1} alignItems="center">
                <Storage color="secondary" />
                <Typography variant="body2">Database Access</Typography>
              </Stack>
            </>
          )}
          {domain.stats.hasAuth && (
            <>
              <Divider orientation="vertical" flexItem />
              <Stack direction="row" spacing={1} alignItems="center">
                <Lock color="success" />
                <Typography variant="body2">Requires Auth</Typography>
              </Stack>
            </>
          )}
        </Stack>

        {implementationHealth && (
          <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Build fontSize="small" color="action" />
              <Typography variant="subtitle2">
                Implementation Health
              </Typography>
              <Chip
                label={`${implementationHealth.healthPercentage}%`}
                size="small"
                color={implementationHealth.healthPercentage === 100 ? 'success' : implementationHealth.healthPercentage >= 80 ? 'warning' : 'error'}
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            </Stack>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {implementationHealth.statusCounts.complete > 0 && (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <CheckCircle fontSize="small" color="success" sx={{ fontSize: 16 }} />
                  <Typography variant="body2">{implementationHealth.statusCounts.complete} complete</Typography>
                </Stack>
              )}
              {implementationHealth.statusCounts.partial > 0 && (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Warning fontSize="small" color="warning" sx={{ fontSize: 16 }} />
                  <Typography variant="body2">{implementationHealth.statusCounts.partial} partial</Typography>
                </Stack>
              )}
              {implementationHealth.statusCounts.stub > 0 && (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Warning fontSize="small" color="error" sx={{ fontSize: 16 }} />
                  <Typography variant="body2">{implementationHealth.statusCounts.stub} stub</Typography>
                </Stack>
              )}
              {implementationHealth.statusCounts['not-implemented'] > 0 && (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Warning fontSize="small" color="error" sx={{ fontSize: 16 }} />
                  <Typography variant="body2">{implementationHealth.statusCounts['not-implemented']} not implemented</Typography>
                </Stack>
              )}
            </Stack>
            {implementationHealth.incompleteNodes.length > 0 && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  Incomplete: {implementationHealth.incompleteNodes.map(n => n.name).slice(0, 3).join(', ')}
                  {implementationHealth.incompleteNodes.length > 3 && ` +${implementationHealth.incompleteNodes.length - 3} more`}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Paper>

      <Box sx={{ p: 3 }}>
        <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
          What can you do here?
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Click any operation to see how it works - from the moment a request arrives to the final response.
        </Typography>

        {groupedCapabilities.read.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: 1 }}
            >
              Read Operations
            </Typography>
            <List disablePadding>
              {groupedCapabilities.read.map(cap => (
                <CapabilityItem
                  key={cap.id}
                  capability={cap}
                  onClick={() => onCapabilitySelect(cap)}
                />
              ))}
            </List>
          </Box>
        )}

        {groupedCapabilities.write.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: 1 }}
            >
              Create / Update Operations
            </Typography>
            <List disablePadding>
              {groupedCapabilities.write.map(cap => (
                <CapabilityItem
                  key={cap.id}
                  capability={cap}
                  onClick={() => onCapabilitySelect(cap)}
                />
              ))}
            </List>
          </Box>
        )}

        {groupedCapabilities.delete.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: 1 }}
            >
              Delete Operations
            </Typography>
            <List disablePadding>
              {groupedCapabilities.delete.map(cap => (
                <CapabilityItem
                  key={cap.id}
                  capability={cap}
                  onClick={() => onCapabilitySelect(cap)}
                />
              ))}
            </List>
          </Box>
        )}
      </Box>
    </Box>
  );
};

interface CapabilityItemProps {
  capability: Capability;
  onClick: () => void;
}

const CapabilityItem: React.FC<CapabilityItemProps> = ({ capability, onClick }) => {
  const methodColor = METHOD_COLORS[capability.method?.toUpperCase() || ''] || '#757575';
  const hasFlow = !!capability.flow;

  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      <CardActionArea onClick={onClick}>
        <ListItem>
          <ListItemIcon>
            {ACTION_ICONS[capability.action] || <Code fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary={
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="subtitle1" fontWeight={500}>
                  {capability.name}
                </Typography>
                {capability.requiresAuth ? (
                  <Lock fontSize="small" color="success" />
                ) : (
                  <LockOpen fontSize="small" color="warning" />
                )}
              </Stack>
            }
            secondary={
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                <Chip
                  label={capability.method}
                  size="small"
                  sx={{
                    bgcolor: `${methodColor}20`,
                    color: methodColor,
                    fontWeight: 600,
                    height: 22,
                    fontSize: '0.7rem',
                  }}
                />
                <Typography variant="caption" fontFamily="monospace" color="text.secondary">
                  {capability.path}
                </Typography>
                {hasFlow && (
                  <Chip
                    icon={<Timeline sx={{ fontSize: 12 }} />}
                    label={`${capability.flow?.characteristics.total_calls || 0} steps`}
                    size="small"
                    variant="outlined"
                    sx={{ height: 22, fontSize: '0.65rem' }}
                  />
                )}
                {capability.flow?.characteristics.has_database_calls && (
                  <Storage fontSize="small" color="secondary" sx={{ ml: 1 }} />
                )}
              </Stack>
            }
          />
        </ListItem>
      </CardActionArea>
    </Card>
  );
};

import React, { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Grid,
  Card,
  CardContent,
  CardActions,
  Button,
  Chip,
  Stack,
  Avatar,
  Badge,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Divider,
  Alert,
  AlertTitle,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  InputAdornment,
  Tooltip,
  LinearProgress
} from '@mui/material';
import {
  Storage,
  Cloud,
  Api,
  Email,
  Queue,
  Cached,
  Folder,
  ArrowUpward,
  ArrowDownward,
  SwapVert,
  OpenInNew,
  Security,
  Speed,
  Warning,
  Error,
  CheckCircle,
  Info,
  Search,
  FilterList,
  Visibility,
  Code,
  Http,
  Dns,
  CloudQueue,
  AttachFile,
  MailOutline
} from '@mui/icons-material';
import { ExternalService, ExitPoint, EntryPoint, CASNode } from '../../types/cas.types';

interface ExternalServicesViewProps {
  externalServices: ExternalService[];
  exitPoints: ExitPoint[];
  entryPoints: EntryPoint[];
  nodes: CASNode[];
  onNodeClick?: (nodeId: string) => void;
  onServiceClick?: (service: ExternalService) => void;
}

type ServiceCategory = 'all' | 'database' | 'api' | 'storage' | 'messaging' | 'email' | 'cache' | 'other';
type DirectionFilter = 'all' | 'consumption' | 'production' | 'bidirectional';

const getServiceIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case 'database': return <Storage />;
    case 'api': return <Api />;
    case 'http': return <Http />;
    case 'grpc': return <Dns />;
    case 'graphql': return <Api />;
    case 'websocket': return <SwapVert />;
    case 'queue': return <CloudQueue />;
    case 'cache': return <Cached />;
    case 'storage': return <Cloud />;
    case 'file': return <AttachFile />;
    case 'email': return <MailOutline />;
    default: return <Cloud />;
  }
};

const getDirectionIcon = (direction: string) => {
  switch (direction) {
    case 'consumption': return <ArrowDownward color="primary" />;
    case 'production': return <ArrowUpward color="success" />;
    case 'bidirectional': return <SwapVert color="warning" />;
    default: return <SwapVert />;
  }
};

const getServiceColor = (type: string): 'default' | 'primary' | 'secondary' | 'error' | 'warning' | 'info' | 'success' => {
  switch (type.toLowerCase()) {
    case 'database': return 'primary';
    case 'api': return 'secondary';
    case 'cache': return 'info';
    case 'queue': return 'warning';
    case 'email': return 'success';
    case 'storage': return 'default';
    default: return 'default';
  }
};

export const ExternalServicesView: React.FC<ExternalServicesViewProps> = ({
  externalServices,
  exitPoints,
  entryPoints,
  nodes,
  onNodeClick,
  onServiceClick
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ServiceCategory>('all');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'flow'>('grid');
  const [expandedServices, setExpandedServices] = useState<Set<string>>(new Set());

  const categorizedServices = useMemo(() => {
    const categories: Record<string, ExternalService[]> = {
      database: [],
      api: [],
      storage: [],
      messaging: [],
      email: [],
      cache: [],
      other: []
    };

    externalServices.forEach(service => {
      const exitPoint = exitPoints.find(ep => ep.source?.node_id === service.connection_node);
      const serviceType = exitPoint?.type || service.type;

      switch (serviceType.toLowerCase()) {
        case 'database':
          categories.database.push(service);
          break;
        case 'api':
        case 'http':
        case 'grpc':
        case 'graphql':
        case 'websocket':
          categories.api.push(service);
          break;
        case 'storage':
        case 'file':
          categories.storage.push(service);
          break;
        case 'queue':
        case 'messaging':
          categories.messaging.push(service);
          break;
        case 'email':
          categories.email.push(service);
          break;
        case 'cache':
          categories.cache.push(service);
          break;
        default:
          categories.other.push(service);
      }
    });

    return categories;
  }, [externalServices, exitPoints]);

  const filteredServices = useMemo(() => {
    let filtered = [...externalServices];

    if (searchTerm) {
      filtered = filtered.filter(service =>
        service.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        service.type.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (categoryFilter !== 'all') {
      const categoryServices = categorizedServices[categoryFilter] || [];
      filtered = filtered.filter(service => categoryServices.includes(service));
    }

    if (directionFilter !== 'all') {
      filtered = filtered.filter(service => service.direction === directionFilter);
    }

    return filtered;
  }, [externalServices, searchTerm, categoryFilter, directionFilter, categorizedServices]);

  const getServiceDetails = (service: ExternalService) => {
    const connectedNode = nodes.find(n => n.id === service.connection_node);
    const relatedExitPoints = exitPoints.filter(ep => ep.source?.node_id === service.connection_node);
    const relatedEntryPoints = entryPoints.filter(ep => ep.handler?.node_id === service.connection_node);

    return {
      node: connectedNode,
      exitPoints: relatedExitPoints,
      entryPoints: relatedEntryPoints
    };
  };

  const renderServiceCard = (service: ExternalService) => {
    const { node, exitPoints: serviceExitPoints, entryPoints: serviceEntryPoints } = getServiceDetails(service);
    const isExpanded = expandedServices.has(service.id);

    return (
      <Card key={service.id} elevation={2}>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Avatar sx={{ bgcolor: `${getServiceColor(service.type)}.main` }}>
                {getServiceIcon(service.type)}
              </Avatar>
              <Box>
                <Typography variant="h6">{service.name}</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label={service.type} size="small" color={getServiceColor(service.type)} />
                  <Tooltip title={`Direction: ${service.direction}`}>
                    {getDirectionIcon(service.direction)}
                  </Tooltip>
                </Stack>
              </Box>
            </Stack>
          </Stack>

          {node && (
            <Stack spacing={1} sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Connected via: <strong>{node.name}</strong>
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {node.source?.file}:{node.source?.line}
              </Typography>
            </Stack>
          )}

          <Stack direction="row" spacing={1} flexWrap="wrap">
            {serviceExitPoints.length > 0 && (
              <Chip
                label={`${serviceExitPoints.length} Exit Points`}
                size="small"
                icon={<ArrowUpward fontSize="small" />}
                variant="outlined"
              />
            )}
            {serviceEntryPoints.length > 0 && (
              <Chip
                label={`${serviceEntryPoints.length} Entry Points`}
                size="small"
                icon={<ArrowDownward fontSize="small" />}
                variant="outlined"
              />
            )}
          </Stack>

          {service.metadata && Object.keys(service.metadata).length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                Metadata
              </Typography>
              <Stack spacing={0.5}>
                {Object.entries(service.metadata).map(([key, value]) => (
                  <Typography key={key} variant="caption" color="text.secondary">
                    <strong>{key}:</strong> {JSON.stringify(value)}
                  </Typography>
                ))}
              </Stack>
            </Box>
          )}
        </CardContent>

        <CardActions>
          <Button
            size="small"
            onClick={() => {
              setExpandedServices(prev => {
                const newSet = new Set(prev);
                if (newSet.has(service.id)) {
                  newSet.delete(service.id);
                } else {
                  newSet.add(service.id);
                }
                return newSet;
              });
            }}
          >
            {isExpanded ? 'Show Less' : 'Show More'}
          </Button>
          {node && (
            <Button
              size="small"
              startIcon={<Code />}
              onClick={() => onNodeClick?.(node.id)}
            >
              View Code
            </Button>
          )}
          <IconButton
            size="small"
            onClick={() => onServiceClick?.(service)}
          >
            <OpenInNew fontSize="small" />
          </IconButton>
        </CardActions>

        {isExpanded && (
          <Box sx={{ px: 2, pb: 2 }}>
            <Divider sx={{ mb: 2 }} />

            {serviceExitPoints.length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Exit Points
                </Typography>
                <List dense>
                  {serviceExitPoints.map(ep => (
                    <ListItem key={ep.id}>
                      <ListItemAvatar>
                        <Avatar sx={{ width: 32, height: 32 }}>
                          {getServiceIcon(ep.type)}
                        </Avatar>
                      </ListItemAvatar>
                      <ListItemText
                        primary={ep.name}
                        secondary={
                          <Stack spacing={0.5}>
                            <Typography variant="caption">
                              {ep.target?.endpoint || ep.target?.system || 'Unknown target'}
                            </Typography>
                            {ep.operations && (
                              <Stack direction="row" spacing={0.5}>
                                {ep.operations.map(op => (
                                  <Chip key={op} label={op} size="small" variant="outlined" />
                                ))}
                              </Stack>
                            )}
                          </Stack>
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}

            {serviceEntryPoints.length > 0 && (
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Entry Points
                </Typography>
                <List dense>
                  {serviceEntryPoints.map(ep => (
                    <ListItem key={ep.id}>
                      <ListItemAvatar>
                        <Avatar sx={{ width: 32, height: 32 }}>
                          {getServiceIcon(ep.type)}
                        </Avatar>
                      </ListItemAvatar>
                      <ListItemText
                        primary={ep.name}
                        secondary={
                          <Stack spacing={0.5}>
                            {ep.protocol_details?.path && (
                              <Typography variant="caption">
                                {ep.protocol_details.method} {ep.protocol_details.path}
                              </Typography>
                            )}
                            {ep.authentication && (
                              <Chip
                                label={ep.authentication.required ? 'Auth Required' : 'No Auth'}
                                size="small"
                                color={ep.authentication.required ? 'warning' : 'default'}
                                variant="outlined"
                              />
                            )}
                          </Stack>
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}
          </Box>
        )}
      </Card>
    );
  };

  const renderStatsSummary = () => {
    const stats = {
      total: externalServices.length,
      consumption: externalServices.filter(s => s.direction === 'consumption').length,
      production: externalServices.filter(s => s.direction === 'production').length,
      bidirectional: externalServices.filter(s => s.direction === 'bidirectional').length
    };

    return (
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">{stats.total}</Typography>
                <Cloud color="primary" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Total Services
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">{stats.consumption}</Typography>
                <ArrowDownward color="primary" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Consumed
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">{stats.production}</Typography>
                <ArrowUpward color="success" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Produced
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">{stats.bidirectional}</Typography>
                <SwapVert color="warning" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Bidirectional
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    );
  };

  const renderCategoryBreakdown = () => {
    return (
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Service Categories
          </Typography>
          <Grid container spacing={2}>
            {Object.entries(categorizedServices).map(([category, services]) => {
              if (services.length === 0) return null;

              const percentage = (services.length / externalServices.length) * 100;

              return (
                <Grid item xs={12} md={6} key={category}>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" textTransform="capitalize">
                        {category}
                      </Typography>
                      <Typography variant="body2" fontWeight="bold">
                        {services.length}
                      </Typography>
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={percentage}
                      sx={{ height: 8, borderRadius: 4 }}
                    />
                  </Stack>
                </Grid>
              );
            })}
          </Grid>
        </CardContent>
      </Card>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {renderStatsSummary()}
      {renderCategoryBreakdown()}

      <Paper elevation={2} sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack spacing={2}>
            <TextField
              fullWidth
              size="small"
              placeholder="Search services..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search />
                  </InputAdornment>
                ),
              }}
            />

            <Stack direction="row" spacing={2} justifyContent="space-between">
              <ToggleButtonGroup
                value={categoryFilter}
                exclusive
                onChange={(_, value) => value && setCategoryFilter(value)}
                size="small"
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="database">Database</ToggleButton>
                <ToggleButton value="api">API</ToggleButton>
                <ToggleButton value="storage">Storage</ToggleButton>
                <ToggleButton value="messaging">Queue</ToggleButton>
                <ToggleButton value="cache">Cache</ToggleButton>
              </ToggleButtonGroup>

              <ToggleButtonGroup
                value={directionFilter}
                exclusive
                onChange={(_, value) => value && setDirectionFilter(value)}
                size="small"
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="consumption">
                  <ArrowDownward fontSize="small" />
                </ToggleButton>
                <ToggleButton value="production">
                  <ArrowUpward fontSize="small" />
                </ToggleButton>
                <ToggleButton value="bidirectional">
                  <SwapVert fontSize="small" />
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          {filteredServices.length === 0 ? (
            <Alert severity="info">
              <AlertTitle>No External Services Found</AlertTitle>
              {externalServices.length === 0
                ? 'No external services detected in this codebase.'
                : 'No services match the current filters.'}
            </Alert>
          ) : (
            <Grid container spacing={2}>
              {filteredServices.map(service => (
                <Grid item xs={12} md={6} lg={4} key={service.id}>
                  {renderServiceCard(service)}
                </Grid>
              ))}
            </Grid>
          )}
        </Box>
      </Paper>
    </Box>
  );
};
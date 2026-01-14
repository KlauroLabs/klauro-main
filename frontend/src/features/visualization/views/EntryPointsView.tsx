import React, { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Chip,
  Stack,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  IconButton,
  Tooltip,
  Card,
  CardContent,
} from '@mui/material';
import {
  Search,
  Lock,
  LockOpen,
  Http,
  Terminal,
  Schedule,
  PlayArrow,
  Webhook,
  Code,
  FilterList,
} from '@mui/icons-material';
import { EntryPoint, CASNode } from '../types';

export interface EntryPointsViewProps {
  entryPoints: EntryPoint[];
  nodes: CASNode[];
  onEntryPointClick?: (entryPoint: EntryPoint) => void;
  onNodeClick?: (nodeId: string) => void;
}

type SortField = 'method' | 'path' | 'name' | 'type' | 'auth';
type SortOrder = 'asc' | 'desc';
type FilterType = 'all' | 'http' | 'cli' | 'event' | 'scheduled';
type AuthFilter = 'all' | 'authenticated' | 'public';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  http: <Http fontSize="small" />,
  cli: <Terminal fontSize="small" />,
  event: <Webhook fontSize="small" />,
  scheduled: <Schedule fontSize="small" />,
  startup: <PlayArrow fontSize="small" />,
  grpc: <Code fontSize="small" />,
  graphql: <Code fontSize="small" />,
  websocket: <Webhook fontSize="small" />,
};

const METHOD_COLORS: Record<string, string> = {
  GET: '#4caf50',
  POST: '#2196f3',
  PUT: '#ff9800',
  PATCH: '#ff9800',
  DELETE: '#f44336',
  HEAD: '#9e9e9e',
  OPTIONS: '#9e9e9e',
};

export const EntryPointsView: React.FC<EntryPointsViewProps> = ({
  entryPoints,
  nodes,
  onEntryPointClick,
  onNodeClick,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [authFilter, setAuthFilter] = useState<AuthFilter>('all');
  const [sortField, setSortField] = useState<SortField>('path');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const stats = useMemo(() => {
    const httpEndpoints = entryPoints.filter(ep => ep.type === 'http');
    const authenticated = httpEndpoints.filter(ep => ep.authentication?.required).length;
    return {
      total: entryPoints.length,
      http: httpEndpoints.length,
      cli: entryPoints.filter(ep => ep.type === 'cli').length,
      event: entryPoints.filter(ep => ep.type === 'event').length,
      scheduled: entryPoints.filter(ep => ep.type === 'scheduled').length,
      authenticated,
      public: httpEndpoints.length - authenticated,
    };
  }, [entryPoints]);

  const filteredAndSorted = useMemo(() => {
    let result = [...entryPoints];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        ep =>
          ep.name.toLowerCase().includes(query) ||
          ep.protocol_details?.path?.toLowerCase().includes(query) ||
          ep.handler.method_name?.toLowerCase().includes(query)
      );
    }

    if (typeFilter !== 'all') {
      result = result.filter(ep => ep.type === typeFilter);
    }

    if (authFilter !== 'all') {
      result = result.filter(ep => {
        const isAuth = ep.authentication?.required ?? false;
        return authFilter === 'authenticated' ? isAuth : !isAuth;
      });
    }

    result.sort((a, b) => {
      let aVal: string | boolean = '';
      let bVal: string | boolean = '';

      switch (sortField) {
        case 'method':
          aVal = a.protocol_details?.method || '';
          bVal = b.protocol_details?.method || '';
          break;
        case 'path':
          aVal = a.protocol_details?.path || a.name;
          bVal = b.protocol_details?.path || b.name;
          break;
        case 'name':
          aVal = a.handler.method_name || a.name;
          bVal = b.handler.method_name || b.name;
          break;
        case 'type':
          aVal = a.type;
          bVal = b.type;
          break;
        case 'auth':
          aVal = a.authentication?.required ?? false;
          bVal = b.authentication?.required ?? false;
          break;
      }

      if (typeof aVal === 'boolean') {
        return sortOrder === 'asc' ? (aVal ? 1 : -1) : (aVal ? -1 : 1);
      }

      const comparison = String(aVal).localeCompare(String(bVal));
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [entryPoints, searchQuery, typeFilter, authFilter, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleRowClick = (ep: EntryPoint) => {
    onEntryPointClick?.(ep);
    if (ep.handler.node_id) {
      onNodeClick?.(ep.handler.node_id);
    }
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 2, gap: 2 }}>
      <Stack direction="row" spacing={2} flexWrap="wrap">
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Typography variant="h5" fontWeight={600}>{stats.total}</Typography>
            <Typography variant="caption" color="text.secondary">Total Entry Points</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="success.main">{stats.authenticated}</Typography>
              <Lock fontSize="small" color="success" />
            </Stack>
            <Typography variant="caption" color="text.secondary">Authenticated</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="warning.main">{stats.public}</Typography>
              <LockOpen fontSize="small" color="warning" />
            </Stack>
            <Typography variant="caption" color="text.secondary">Public</Typography>
          </CardContent>
        </Card>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <TextField
            size="small"
            placeholder="Search endpoints..."
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
            value={typeFilter}
            exclusive
            onChange={(_, val) => val && setTypeFilter(val)}
            size="small"
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="http">HTTP ({stats.http})</ToggleButton>
            <ToggleButton value="cli">CLI ({stats.cli})</ToggleButton>
            <ToggleButton value="event">Event ({stats.event})</ToggleButton>
          </ToggleButtonGroup>

          <ToggleButtonGroup
            value={authFilter}
            exclusive
            onChange={(_, val) => val && setAuthFilter(val)}
            size="small"
          >
            <ToggleButton value="all">All Auth</ToggleButton>
            <ToggleButton value="authenticated">
              <Lock fontSize="small" sx={{ mr: 0.5 }} /> Auth
            </ToggleButton>
            <ToggleButton value="public">
              <LockOpen fontSize="small" sx={{ mr: 0.5 }} /> Public
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Paper>

      <TableContainer component={Paper} sx={{ flex: 1 }}>
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 80 }}>
                <TableSortLabel
                  active={sortField === 'method'}
                  direction={sortField === 'method' ? sortOrder : 'asc'}
                  onClick={() => handleSort('method')}
                >
                  Method
                </TableSortLabel>
              </TableCell>
              <TableCell>
                <TableSortLabel
                  active={sortField === 'path'}
                  direction={sortField === 'path' ? sortOrder : 'asc'}
                  onClick={() => handleSort('path')}
                >
                  Path
                </TableSortLabel>
              </TableCell>
              <TableCell>
                <TableSortLabel
                  active={sortField === 'name'}
                  direction={sortField === 'name' ? sortOrder : 'asc'}
                  onClick={() => handleSort('name')}
                >
                  Handler
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: 100 }}>
                <TableSortLabel
                  active={sortField === 'type'}
                  direction={sortField === 'type' ? sortOrder : 'asc'}
                  onClick={() => handleSort('type')}
                >
                  Type
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: 80 }}>
                <TableSortLabel
                  active={sortField === 'auth'}
                  direction={sortField === 'auth' ? sortOrder : 'asc'}
                  onClick={() => handleSort('auth')}
                >
                  Auth
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: 120 }}>Location</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredAndSorted.map(ep => {
              const method = ep.protocol_details?.method?.toUpperCase() || '-';
              const methodColor = METHOD_COLORS[method] || '#9e9e9e';

              return (
                <TableRow
                  key={ep.id}
                  hover
                  onClick={() => handleRowClick(ep)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    {ep.type === 'http' && method !== '-' ? (
                      <Chip
                        label={method}
                        size="small"
                        sx={{
                          bgcolor: `${methodColor}20`,
                          color: methodColor,
                          fontWeight: 600,
                          minWidth: 60,
                        }}
                      />
                    ) : (
                      <Typography variant="caption" color="text.secondary">-</Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" fontFamily="monospace">
                      {ep.protocol_details?.path || ep.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {ep.handler.method_name || ep.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      icon={(TYPE_ICONS[ep.type] || <Code fontSize="small" />) as React.ReactElement}
                      label={ep.type}
                      size="small"
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>
                    {ep.authentication?.required ? (
                      <Tooltip title="Authentication required">
                        <Lock fontSize="small" color="success" />
                      </Tooltip>
                    ) : (
                      <Tooltip title="Public endpoint">
                        <LockOpen fontSize="small" color="warning" />
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {ep.handler.file.split('/').pop()}:{ep.handler.line}
                    </Typography>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {filteredAndSorted.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Typography color="text.secondary">
            No entry points match the current filters
          </Typography>
        </Box>
      )}
    </Box>
  );
};

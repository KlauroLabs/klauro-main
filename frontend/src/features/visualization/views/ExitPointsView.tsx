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
  Card,
  CardContent,
  Tooltip,
} from '@mui/material';
import {
  Search,
  Storage,
  Api,
  Cloud,
  Email,
  Cached,
  FolderOpen,
  Queue,
  Code,
} from '@mui/icons-material';
import { ExitPoint, CASNode } from '../types';

export interface ExitPointsViewProps {
  exitPoints: ExitPoint[];
  nodes: CASNode[];
  onExitPointClick?: (exitPoint: ExitPoint) => void;
  onNodeClick?: (nodeId: string) => void;
}

type SortField = 'name' | 'type' | 'target' | 'source';
type SortOrder = 'asc' | 'desc';
type FilterType = 'all' | 'database' | 'api' | 'cache' | 'file' | 'other';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  database: <Storage fontSize="small" />,
  api: <Api fontSize="small" />,
  cache: <Cached fontSize="small" />,
  file: <FolderOpen fontSize="small" />,
  storage: <Cloud fontSize="small" />,
  queue: <Queue fontSize="small" />,
  email: <Email fontSize="small" />,
};

const TYPE_COLORS: Record<string, string> = {
  database: '#9c27b0',
  api: '#2196f3',
  cache: '#ff9800',
  file: '#4caf50',
  storage: '#607d8b',
  queue: '#e91e63',
  email: '#00bcd4',
};

export const ExitPointsView: React.FC<ExitPointsViewProps> = ({
  exitPoints,
  nodes,
  onExitPointClick,
  onNodeClick,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [sortField, setSortField] = useState<SortField>('type');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const stats = useMemo(() => ({
    total: exitPoints.length,
    database: exitPoints.filter(ep => ep.type === 'database').length,
    api: exitPoints.filter(ep => ep.type === 'api').length,
    cache: exitPoints.filter(ep => ep.type === 'cache').length,
    file: exitPoints.filter(ep => ep.type === 'file' || ep.type === 'storage').length,
    other: exitPoints.filter(
      ep => !['database', 'api', 'cache', 'file', 'storage'].includes(ep.type)
    ).length,
  }), [exitPoints]);

  const filteredAndSorted = useMemo(() => {
    let result = [...exitPoints];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        ep =>
          ep.name.toLowerCase().includes(query) ||
          ep.target?.system?.toLowerCase().includes(query) ||
          ep.target?.endpoint?.toLowerCase().includes(query) ||
          ep.source?.method_name?.toLowerCase().includes(query)
      );
    }

    if (typeFilter !== 'all') {
      if (typeFilter === 'other') {
        result = result.filter(
          ep => !['database', 'api', 'cache', 'file', 'storage'].includes(ep.type)
        );
      } else if (typeFilter === 'file') {
        result = result.filter(ep => ep.type === 'file' || ep.type === 'storage');
      } else {
        result = result.filter(ep => ep.type === typeFilter);
      }
    }

    result.sort((a, b) => {
      let aVal = '';
      let bVal = '';

      switch (sortField) {
        case 'name':
          aVal = a.name;
          bVal = b.name;
          break;
        case 'type':
          aVal = a.type;
          bVal = b.type;
          break;
        case 'target':
          aVal = a.target?.system || a.target?.endpoint || '';
          bVal = b.target?.system || b.target?.endpoint || '';
          break;
        case 'source':
          aVal = a.source?.method_name || '';
          bVal = b.source?.method_name || '';
          break;
      }

      const comparison = aVal.localeCompare(bVal);
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [exitPoints, searchQuery, typeFilter, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleRowClick = (ep: ExitPoint) => {
    onExitPointClick?.(ep);
    if (ep.source?.node_id) {
      onNodeClick?.(ep.source.node_id);
    }
  };

  const operationsByType = useMemo(() => {
    const ops: Record<string, Set<string>> = {};
    exitPoints.forEach(ep => {
      if (!ops[ep.type]) ops[ep.type] = new Set();
      ep.operations?.forEach(op => ops[ep.type].add(op));
    });
    return ops;
  }, [exitPoints]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 2, gap: 2 }}>
      <Stack direction="row" spacing={2} flexWrap="wrap">
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Typography variant="h5" fontWeight={600}>{stats.total}</Typography>
            <Typography variant="caption" color="text.secondary">Total Exit Points</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="secondary.main">{stats.database}</Typography>
              <Storage fontSize="small" color="secondary" />
            </Stack>
            <Typography variant="caption" color="text.secondary">Database</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="primary.main">{stats.api}</Typography>
              <Api fontSize="small" color="primary" />
            </Stack>
            <Typography variant="caption" color="text.secondary">External API</Typography>
          </CardContent>
        </Card>
        <Card sx={{ minWidth: 120 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={600} color="warning.main">{stats.cache}</Typography>
              <Cached fontSize="small" color="warning" />
            </Stack>
            <Typography variant="caption" color="text.secondary">Cache</Typography>
          </CardContent>
        </Card>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <TextField
            size="small"
            placeholder="Search exit points..."
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
            <ToggleButton value="database">
              <Storage fontSize="small" sx={{ mr: 0.5 }} /> DB ({stats.database})
            </ToggleButton>
            <ToggleButton value="api">
              <Api fontSize="small" sx={{ mr: 0.5 }} /> API ({stats.api})
            </ToggleButton>
            <ToggleButton value="cache">
              <Cached fontSize="small" sx={{ mr: 0.5 }} /> Cache ({stats.cache})
            </ToggleButton>
            <ToggleButton value="file">
              <FolderOpen fontSize="small" sx={{ mr: 0.5 }} /> File ({stats.file})
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Paper>

      <TableContainer component={Paper} sx={{ flex: 1 }}>
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 100 }}>
                <TableSortLabel
                  active={sortField === 'type'}
                  direction={sortField === 'type' ? sortOrder : 'asc'}
                  onClick={() => handleSort('type')}
                >
                  Type
                </TableSortLabel>
              </TableCell>
              <TableCell>
                <TableSortLabel
                  active={sortField === 'name'}
                  direction={sortField === 'name' ? sortOrder : 'asc'}
                  onClick={() => handleSort('name')}
                >
                  Name
                </TableSortLabel>
              </TableCell>
              <TableCell>
                <TableSortLabel
                  active={sortField === 'target'}
                  direction={sortField === 'target' ? sortOrder : 'asc'}
                  onClick={() => handleSort('target')}
                >
                  Target
                </TableSortLabel>
              </TableCell>
              <TableCell>Operations</TableCell>
              <TableCell>
                <TableSortLabel
                  active={sortField === 'source'}
                  direction={sortField === 'source' ? sortOrder : 'asc'}
                  onClick={() => handleSort('source')}
                >
                  Called From
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ width: 120 }}>Location</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredAndSorted.map(ep => {
              const typeColor = TYPE_COLORS[ep.type] || '#9e9e9e';
              const typeIcon = TYPE_ICONS[ep.type] || <Code fontSize="small" />;

              return (
                <TableRow
                  key={ep.id}
                  hover
                  onClick={() => handleRowClick(ep)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Chip
                      icon={typeIcon as React.ReactElement}
                      label={ep.type}
                      size="small"
                      sx={{
                        bgcolor: `${typeColor}20`,
                        color: typeColor,
                        fontWeight: 500,
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {ep.name}
                    </Typography>
                    {ep.description && (
                      <Typography variant="caption" color="text.secondary">
                        {ep.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.5}>
                      {ep.target?.system && (
                        <Typography variant="body2" fontFamily="monospace">
                          {ep.target.system}
                        </Typography>
                      )}
                      {ep.target?.endpoint && (
                        <Typography variant="caption" color="text.secondary">
                          {ep.target.endpoint}
                        </Typography>
                      )}
                      {ep.target?.protocol && (
                        <Chip label={ep.target.protocol} size="small" variant="outlined" />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap">
                      {ep.operations?.slice(0, 3).map(op => (
                        <Chip key={op} label={op} size="small" variant="outlined" />
                      ))}
                      {(ep.operations?.length || 0) > 3 && (
                        <Tooltip title={ep.operations?.slice(3).join(', ')}>
                          <Chip label={`+${ep.operations!.length - 3}`} size="small" />
                        </Tooltip>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {ep.source?.method_name || '-'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {ep.source?.file.split('/').pop()}:{ep.source?.line}
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
            No exit points match the current filters
          </Typography>
        </Box>
      )}
    </Box>
  );
};

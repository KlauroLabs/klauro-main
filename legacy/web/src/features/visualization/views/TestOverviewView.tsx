import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  IconButton,
  Grid,
  Card,
  CardContent,
  CardActionArea,
  Chip,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Divider,
} from '@mui/material';
import {
  ArrowBack,
  Search,
  Science,
  Memory,
  PlayArrow,
  Code,
  FilterList,
} from '@mui/icons-material';
import { CASOutput } from '../types';
import {
  extractTestSummary,
  extractTestAreas,
  TestArea,
  TestSummaryData,
} from '../utils/testExtractor';
import TestTypeBreakdown from '../components/TestTypeBreakdown';

export interface TestOverviewViewProps {
  cas: CASOutput;
  onBack: () => void;
  onAreaSelect: (area: TestArea) => void;
}

type FilterType = 'all' | 'unit' | 'integration' | 'e2e' | 'bdd' | 'mocks';

export const TestOverviewView: React.FC<TestOverviewViewProps> = ({
  cas,
  onBack,
  onAreaSelect,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const summary = useMemo(() => extractTestSummary(cas), [cas]);
  const allAreas = useMemo(() => extractTestAreas(cas), [cas]);

  const filteredAreas = useMemo(() => {
    let areas = allAreas;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      areas = areas.filter(area =>
        area.name.toLowerCase().includes(query) ||
        area.tests.some(t => t.name.toLowerCase().includes(query))
      );
    }

    if (filter !== 'all') {
      areas = areas.filter(area => {
        switch (filter) {
          case 'unit':
            return area.stats.byType.unit > 0;
          case 'integration':
            return area.stats.byType.integration > 0;
          case 'e2e':
            return area.stats.byType.e2e > 0;
          case 'bdd':
            return area.stats.bddCount > 0;
          case 'mocks':
            return area.stats.mockCount > 0;
          default:
            return true;
        }
      });
    }

    return areas;
  }, [allAreas, searchQuery, filter]);

  const handleFilterChange = (
    _event: React.MouseEvent<HTMLElement>,
    newFilter: FilterType | null,
  ) => {
    if (newFilter !== null) {
      setFilter(newFilter);
    }
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Paper sx={{ px: 3, py: 2, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <IconButton onClick={onBack} size="small">
            <ArrowBack />
          </IconButton>
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Science color="info" />
              <Typography variant="h6" fontWeight={600}>
                Test Coverage
              </Typography>
              <Chip label={summary.totalTests} size="small" />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Test areas and coverage overview
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
        <Grid container spacing={3} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                BY TEST TYPE
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Unit</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.byType.unit}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Integration</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.byType.integration}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">E2E</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.byType.e2e}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Acceptance</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.byType.acceptance}</Typography>
                </Stack>
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                BY CATEGORY
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <PlayArrow fontSize="small" color="info" />
                    <Typography variant="body2">BDD Tests</Typography>
                  </Stack>
                  <Typography variant="body2" fontWeight={600}>{summary.byType.bdd}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Code fontSize="small" color="action" />
                    <Typography variant="body2">Property-based</Typography>
                  </Stack>
                  <Typography variant="body2" fontWeight={600}>0</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Memory fontSize="small" color="action" />
                    <Typography variant="body2">Snapshot</Typography>
                  </Stack>
                  <Typography variant="body2" fontWeight={600}>0</Typography>
                </Stack>
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                MOCK USAGE
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Tests with mocks</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.mockCount}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Mock targets</Typography>
                  <Typography variant="body2" fontWeight={600}>-</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Spy usage</Typography>
                  <Typography variant="body2" fontWeight={600}>-</Typography>
                </Stack>
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                COVERAGE
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Overall</Typography>
                  <Typography variant="body2" fontWeight={600}>
                    {summary.coveragePercent !== undefined ? `${summary.coveragePercent}%` : '-'}
                  </Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2">Fixtures</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.fixtureCount}</Typography>
                </Stack>
              </Stack>
            </Paper>
          </Grid>
        </Grid>

        <Divider sx={{ mb: 3 }} />

        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
          <Typography variant="h6" fontWeight={600}>
            Test Areas
          </Typography>
          <Chip label={filteredAreas.length} size="small" />
          <Box sx={{ flex: 1 }} />
          <TextField
            size="small"
            placeholder="Search tests..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ width: 250 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Search fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
          <FilterList fontSize="small" color="action" />
          <ToggleButtonGroup
            value={filter}
            exclusive
            onChange={handleFilterChange}
            size="small"
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="unit">Unit</ToggleButton>
            <ToggleButton value="integration">Integration</ToggleButton>
            <ToggleButton value="e2e">E2E</ToggleButton>
            <ToggleButton value="bdd">BDD</ToggleButton>
            <ToggleButton value="mocks">With Mocks</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {filteredAreas.length === 0 ? (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">
              {searchQuery || filter !== 'all'
                ? 'No test areas match your filter criteria'
                : 'No test areas found'}
            </Typography>
          </Paper>
        ) : (
          <Grid container spacing={2}>
            {filteredAreas.map((area) => (
              <Grid item xs={12} sm={6} md={4} lg={3} key={area.id}>
                <Card
                  variant="outlined"
                  sx={{
                    height: '100%',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      borderColor: 'info.main',
                      boxShadow: 2,
                    },
                  }}
                >
                  <CardActionArea
                    onClick={() => onAreaSelect(area)}
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
                              bgcolor: 'info.main',
                              color: 'white',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              opacity: 0.8,
                            }}
                          >
                            <Science fontSize="small" />
                          </Box>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="subtitle1" fontWeight={600} noWrap>
                              {area.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {area.stats.total} tests
                            </Typography>
                          </Box>
                        </Stack>

                        <TestTypeBreakdown
                          byType={area.stats.byType}
                          height={6}
                          showLegend={false}
                        />

                        <Stack direction="row" spacing={0.5} flexWrap="wrap">
                          {area.stats.bddCount > 0 && (
                            <Chip
                              label={`${area.stats.bddCount} BDD`}
                              size="small"
                              sx={{ height: 20, fontSize: '0.65rem' }}
                              color="info"
                              variant="outlined"
                            />
                          )}
                          {area.stats.mockCount > 0 && (
                            <Chip
                              label={`${area.stats.mockCount} mocks`}
                              size="small"
                              sx={{ height: 20, fontSize: '0.65rem' }}
                              variant="outlined"
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
        )}
      </Box>
    </Box>
  );
};

export default TestOverviewView;

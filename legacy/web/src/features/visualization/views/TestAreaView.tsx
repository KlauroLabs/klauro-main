import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  IconButton,
  Chip,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Divider,
  List,
} from '@mui/material';
import {
  ArrowBack,
  Search,
  Science,
  FilterList,
} from '@mui/icons-material';
import { TestArea, TestEntry } from '../utils/testExtractor';
import { TestCard } from '../components/TestCard';
import { TestDetailPanel } from '../components/TestDetailPanel';
import TestTypeBreakdown from '../components/TestTypeBreakdown';

export interface TestAreaViewProps {
  area: TestArea;
  onBack: () => void;
  onTestSelect?: (test: TestEntry) => void;
  onTargetClick?: (targetId: string) => void;
}

type FilterType = 'all' | 'unit' | 'integration' | 'e2e' | 'bdd' | 'mocks';

export const TestAreaView: React.FC<TestAreaViewProps> = ({
  area,
  onBack,
  onTestSelect,
  onTargetClick,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedTest, setSelectedTest] = useState<TestEntry | null>(null);

  const filteredTests = useMemo(() => {
    let tests = area.tests;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      tests = tests.filter(test =>
        test.name.toLowerCase().includes(query) ||
        test.file?.toLowerCase().includes(query) ||
        test.description?.toLowerCase().includes(query)
      );
    }

    if (filter !== 'all') {
      tests = tests.filter(test => {
        switch (filter) {
          case 'unit':
            return test.testType === 'unit';
          case 'integration':
            return test.testType === 'integration';
          case 'e2e':
            return test.testType === 'e2e';
          case 'bdd':
            return test.testStyle === 'bdd' || (test.bddSteps && test.bddSteps.length > 0);
          case 'mocks':
            return test.usesMocks;
          default:
            return true;
        }
      });
    }

    return tests;
  }, [area.tests, searchQuery, filter]);

  const testsByType = useMemo(() => {
    const grouped: Record<string, TestEntry[]> = {
      unit: [],
      integration: [],
      e2e: [],
      acceptance: [],
      other: [],
    };

    filteredTests.forEach(test => {
      const type = test.testType in grouped ? test.testType : 'other';
      grouped[type].push(test);
    });

    return grouped;
  }, [filteredTests]);

  const handleFilterChange = (
    _event: React.MouseEvent<HTMLElement>,
    newFilter: FilterType | null,
  ) => {
    if (newFilter !== null) {
      setFilter(newFilter);
    }
  };

  const handleTestClick = (test: TestEntry) => {
    setSelectedTest(test);
    onTestSelect?.(test);
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Paper sx={{ px: 3, py: 2, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <IconButton onClick={onBack} size="small">
              <ArrowBack />
            </IconButton>
            <Box sx={{ flex: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Science color="info" />
                <Typography variant="h6" fontWeight={600}>
                  {area.name} Tests
                </Typography>
                <Chip label={filteredTests.length} size="small" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {area.description}
              </Typography>
            </Box>
          </Stack>
        </Paper>

        <Box sx={{ px: 3, py: 2 }}>
          <TestTypeBreakdown
            byType={area.stats.byType}
            height={8}
            showLegend={true}
          />
        </Box>

        <Stack direction="row" spacing={2} alignItems="center" sx={{ px: 3, pb: 2 }}>
          <TextField
            size="small"
            placeholder="Search tests..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ flex: 1, maxWidth: 400 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Search fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <FilterList fontSize="small" color="action" />
          <ToggleButtonGroup
            value={filter}
            exclusive
            onChange={handleFilterChange}
            size="small"
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="unit">Unit</ToggleButton>
            <ToggleButton value="integration">Int</ToggleButton>
            <ToggleButton value="e2e">E2E</ToggleButton>
            <ToggleButton value="bdd">BDD</ToggleButton>
            <ToggleButton value="mocks">Mocks</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        <Box sx={{ flex: 1, overflow: 'auto', px: 3, pb: 3 }}>
          {filteredTests.length === 0 ? (
            <Paper sx={{ p: 4, textAlign: 'center' }}>
              <Typography color="text.secondary">
                {searchQuery || filter !== 'all'
                  ? 'No tests match your filter criteria'
                  : 'No tests found in this area'}
              </Typography>
            </Paper>
          ) : filter === 'all' ? (
            <Stack spacing={3}>
              {Object.entries(testsByType)
                .filter(([, tests]) => tests.length > 0)
                .map(([type, tests]) => (
                  <Box key={type}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                      <Typography
                        variant="subtitle2"
                        fontWeight={600}
                        textTransform="capitalize"
                      >
                        {type} Tests
                      </Typography>
                      <Chip label={tests.length} size="small" variant="outlined" />
                    </Stack>
                    <Stack spacing={1}>
                      {tests.map((test) => (
                        <TestCard
                          key={test.id}
                          test={test}
                          onClick={handleTestClick}
                          compact
                        />
                      ))}
                    </Stack>
                  </Box>
                ))}
            </Stack>
          ) : (
            <Stack spacing={1}>
              {filteredTests.map((test) => (
                <TestCard
                  key={test.id}
                  test={test}
                  onClick={handleTestClick}
                  showFile
                />
              ))}
            </Stack>
          )}
        </Box>
      </Box>

      {selectedTest && (
        <TestDetailPanel
          test={selectedTest}
          onClose={() => setSelectedTest(null)}
          onTargetClick={onTargetClick}
        />
      )}
    </Box>
  );
};

export default TestAreaView;

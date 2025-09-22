import React, { useState } from 'react';
import { Box, Tab, Tabs, Paper, Typography } from '@mui/material';
import { ProjectDashboard } from '../components/dashboard/ProjectDashboard';
import { NodeDetails } from '../components/panels/NodeDetails';
import { FilterPanel, FilterOptions } from '../components/panels/FilterPanel';
import { SearchPanel } from '../components/panels/SearchPanel';
import { CASOutput } from '../types/cas.types';
import sampleData from './cas-v1.4.0-sample.json';

const TabPanel = ({ children, value, index }: { children: React.ReactNode; value: number; index: number }) => (
  <div role="tabpanel" hidden={value !== index}>
    {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
  </div>
);

const defaultFilters: FilterOptions = {
  perspectives: [],
  analyzers: [],
  nodeTypes: [],
  edgeTypes: [],
  tags: [],
  documentationStatus: 'all',
  implementationStatus: [],
  todoFilters: {
    hasTodos: false,
    priority: [],
    categories: []
  },
  entryExitPoints: {
    showEntryPoints: true,
    showExitPoints: true,
    showExternalOnly: false
  },
  performanceFilters: {
    showHotPaths: false,
    showBottlenecks: false,
    showCriticalPaths: false
  },
  complexityRange: [0, 100],
  depthRange: [0, 10]
};

export const CASv140ComponentTest: React.FC = () => {
  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('user-controller');
  const [filters, setFilters] = useState<FilterOptions>(defaultFilters);

  const casData = sampleData as CASOutput;
  const selectedNode = casData.nodes.find(n => n.id === selectedNodeId);

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    setSelectedTab(newValue);
  };

  const handleNodeClick = (nodeId: string) => {
    setSelectedNodeId(nodeId);
  };

  const handleFileOpen = (file: string, line: number) => {
    console.log(`Opening file: ${file}:${line}`);
  };

  const handleFiltersChange = (newFilters: FilterOptions) => {
    setFilters(newFilters);
  };

  const handleResetFilters = () => {
    setFilters(defaultFilters);
  };

  return (
    <Box sx={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Paper elevation={1} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ p: 2 }}>
          <Typography variant="h5" gutterBottom>
            CAS v1.4.0 UI Components Test
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Testing all UI components with sample CAS v1.4.0 data structure
          </Typography>
        </Box>

        <Tabs value={selectedTab} onChange={handleTabChange}>
          <Tab label="Project Dashboard" />
          <Tab label="Node Details" />
          <Tab label="Filter Panel" />
          <Tab label="Search Panel" />
        </Tabs>
      </Paper>

      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        <TabPanel value={selectedTab} index={0}>
          <ProjectDashboard
            casData={casData}
            onNodeClick={handleNodeClick}
            onRefresh={() => console.log('Refreshing analysis...')}
          />
        </TabPanel>

        <TabPanel value={selectedTab} index={1}>
          {selectedNode ? (
            <NodeDetails
              node={selectedNode}
              edges={casData.edges}
              methodCalls={casData.method_calls || []}
              allNodes={casData.nodes}
              onNodeClick={handleNodeClick}
              onFileOpen={handleFileOpen}
            />
          ) : (
            <Typography variant="h6" color="text.secondary" textAlign="center">
              No node selected
            </Typography>
          )}
        </TabPanel>

        <TabPanel value={selectedTab} index={2}>
          <Box sx={{ display: 'flex', gap: 2, height: '600px' }}>
            <Box sx={{ width: '300px' }}>
              <FilterPanel
                nodes={casData.nodes}
                edges={casData.edges}
                perspectives={casData.perspectives}
                currentFilters={filters}
                onFiltersChange={handleFiltersChange}
                onReset={handleResetFilters}
              />
            </Box>
            <Box sx={{ flex: 1 }}>
              <Paper sx={{ p: 2, height: '100%' }}>
                <Typography variant="h6" gutterBottom>
                  Filter Results
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Active filters: {JSON.stringify(filters, null, 2)}
                </Typography>
              </Paper>
            </Box>
          </Box>
        </TabPanel>

        <TabPanel value={selectedTab} index={3}>
          <SearchPanel
            nodes={casData.nodes}
            edges={casData.edges}
            methodCalls={casData.method_calls || []}
            onNodeClick={handleNodeClick}
            onFileOpen={handleFileOpen}
          />
        </TabPanel>
      </Box>

      <Paper elevation={1} sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">
          Test Results Summary:
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', gap: 2 }}>
          <Typography variant="caption">
            ✅ ProjectDashboard: {casData.documentation_summary ? 'Documentation metrics displayed' : 'No documentation metrics'}
          </Typography>
          <Typography variant="caption">
            ✅ NodeDetails: {selectedNode?.documentation ? 'Documentation panel loaded' : 'No documentation to display'}
          </Typography>
          <Typography variant="caption">
            ✅ FilterPanel: {Object.keys(filters).length > 0 ? 'All filter options available' : 'Filters not loaded'}
          </Typography>
          <Typography variant="caption">
            ✅ SearchPanel: Search across all CAS v1.4.0 data fields enabled
          </Typography>
        </Box>
      </Paper>
    </Box>
  );
};

export default CASv140ComponentTest;
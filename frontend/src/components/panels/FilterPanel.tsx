import React, { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  FormControl,
  FormLabel,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Radio,
  RadioGroup,
  Select,
  MenuItem,
  InputLabel,
  Chip,
  Stack,
  Divider,
  Button,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Badge,
  Switch,
  Slider,
  TextField,
  InputAdornment,
  IconButton,
  Tooltip,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction
} from '@mui/material';
import {
  ExpandMore,
  FilterList,
  Clear,
  Visibility,
  VisibilityOff,
  Layers,
  Code,
  Description,
  Warning,
  CheckCircle,
  Error,
  Input,
  Output,
  Cloud,
  Loop,
  Speed,
  Security,
  BugReport
} from '@mui/icons-material';
import { CASPerspective, CASNode, CASEdge } from '../../types/cas.types';

export interface FilterOptions {
  perspectives: string[];
  analyzers: string[];
  nodeTypes: string[];
  edgeTypes: string[];
  tags: string[];
  documentationStatus: 'all' | 'documented' | 'undocumented';
  implementationStatus: string[];
  todoFilters: {
    hasTodos: boolean;
    priority: string[];
    categories: string[];
  };
  entryExitPoints: {
    showEntryPoints: boolean;
    showExitPoints: boolean;
    showExternalOnly: boolean;
  };
  performanceFilters: {
    showHotPaths: boolean;
    showBottlenecks: boolean;
    showCriticalPaths: boolean;
  };
  complexityRange: [number, number];
  depthRange: [number, number];
}

interface FilterPanelProps {
  nodes: CASNode[];
  edges: CASEdge[];
  perspectives?: CASPerspective[];
  currentFilters: FilterOptions;
  onFiltersChange: (filters: FilterOptions) => void;
  onReset?: () => void;
}

export const FilterPanel: React.FC<FilterPanelProps> = ({
  nodes,
  edges,
  perspectives = [],
  currentFilters,
  onFiltersChange,
  onReset
}) => {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['perspective', 'nodeTypes'])
  );

  const availableAnalyzers = React.useMemo(() => {
    const analyzers = new Set<string>();
    nodes.forEach(node => {
      node.analyzers?.forEach(analyzer => analyzers.add(analyzer));
    });
    return Array.from(analyzers);
  }, [nodes]);

  const availableNodeTypes = React.useMemo(() => {
    const types = new Set<string>();
    nodes.forEach(node => {
      if (node.type) types.add(node.type);
    });
    return Array.from(types).sort();
  }, [nodes]);

  const availableEdgeTypes = React.useMemo(() => {
    const types = new Set<string>();
    edges.forEach(edge => {
      if (edge.type) types.add(edge.type);
    });
    return Array.from(types).sort();
  }, [edges]);

  const availableTags = React.useMemo(() => {
    const tags = new Set<string>();
    nodes.forEach(node => {
      node.tags?.forEach(tag => tags.add(tag));
    });
    return Array.from(tags).sort();
  }, [nodes]);

  const handleSectionToggle = (section: string) => {
    setExpandedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(section)) {
        newSet.delete(section);
      } else {
        newSet.add(section);
      }
      return newSet;
    });
  };

  const handlePerspectiveChange = (perspectiveId: string, checked: boolean) => {
    const newPerspectives = checked
      ? [...currentFilters.perspectives, perspectiveId]
      : currentFilters.perspectives.filter(p => p !== perspectiveId);

    onFiltersChange({
      ...currentFilters,
      perspectives: newPerspectives
    });
  };

  const handleAnalyzerChange = (analyzer: string, checked: boolean) => {
    const newAnalyzers = checked
      ? [...currentFilters.analyzers, analyzer]
      : currentFilters.analyzers.filter(a => a !== analyzer);

    onFiltersChange({
      ...currentFilters,
      analyzers: newAnalyzers
    });
  };

  const handleNodeTypeChange = (type: string, checked: boolean) => {
    const newTypes = checked
      ? [...currentFilters.nodeTypes, type]
      : currentFilters.nodeTypes.filter(t => t !== type);

    onFiltersChange({
      ...currentFilters,
      nodeTypes: newTypes
    });
  };

  const handleTagChange = (tag: string, checked: boolean) => {
    const newTags = checked
      ? [...currentFilters.tags, tag]
      : currentFilters.tags.filter(t => t !== tag);

    onFiltersChange({
      ...currentFilters,
      tags: newTags
    });
  };

  const handleImplementationStatusChange = (status: string, checked: boolean) => {
    const newStatuses = checked
      ? [...currentFilters.implementationStatus, status]
      : currentFilters.implementationStatus.filter(s => s !== status);

    onFiltersChange({
      ...currentFilters,
      implementationStatus: newStatuses
    });
  };

  const getActiveFilterCount = () => {
    let count = 0;
    if (currentFilters.perspectives.length > 0) count += currentFilters.perspectives.length;
    if (currentFilters.analyzers.length > 0) count += currentFilters.analyzers.length;
    if (currentFilters.nodeTypes.length > 0) count += currentFilters.nodeTypes.length;
    if (currentFilters.tags.length > 0) count += currentFilters.tags.length;
    if (currentFilters.documentationStatus !== 'all') count++;
    if (currentFilters.implementationStatus.length > 0) count += currentFilters.implementationStatus.length;
    if (currentFilters.todoFilters.hasTodos) count++;
    if (!currentFilters.entryExitPoints.showEntryPoints || !currentFilters.entryExitPoints.showExitPoints) count++;
    if (currentFilters.performanceFilters.showHotPaths || currentFilters.performanceFilters.showBottlenecks) count++;
    return count;
  };

  return (
    <Paper elevation={2} sx={{ height: '100%', overflow: 'auto' }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Stack direction="row" spacing={1} alignItems="center">
            <FilterList />
            <Typography variant="h6">Filters</Typography>
            {getActiveFilterCount() > 0 && (
              <Badge badgeContent={getActiveFilterCount()} color="primary" />
            )}
          </Stack>
          {onReset && (
            <Button
              size="small"
              startIcon={<Clear />}
              onClick={onReset}
              disabled={getActiveFilterCount() === 0}
            >
              Reset
            </Button>
          )}
        </Stack>
      </Box>

      <Box sx={{ p: 2 }}>
        <Stack spacing={1}>
          {perspectives.length > 0 && (
            <Accordion
              expanded={expandedSections.has('perspective')}
              onChange={() => handleSectionToggle('perspective')}
            >
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Layers />
                  <Typography>Perspectives</Typography>
                  <Badge badgeContent={currentFilters.perspectives.length} color="primary" />
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <FormControl component="fieldset">
                  <RadioGroup
                    value={currentFilters.perspectives[0] || ''}
                    onChange={(e) => {
                      onFiltersChange({
                        ...currentFilters,
                        perspectives: e.target.value ? [e.target.value] : []
                      });
                    }}
                  >
                    <FormControlLabel
                      value=""
                      control={<Radio size="small" />}
                      label="All Perspectives"
                    />
                    {perspectives.map(perspective => (
                      <FormControlLabel
                        key={perspective.id}
                        value={perspective.id}
                        control={<Radio size="small" />}
                        label={
                          <Stack>
                            <Typography variant="body2">{perspective.name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {perspective.description}
                            </Typography>
                          </Stack>
                        }
                      />
                    ))}
                  </RadioGroup>
                </FormControl>
              </AccordionDetails>
            </Accordion>
          )}

          <Accordion
            expanded={expandedSections.has('nodeTypes')}
            onChange={() => handleSectionToggle('nodeTypes')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Code />
                <Typography>Component Types</Typography>
                <Badge badgeContent={currentFilters.nodeTypes.length} color="primary" />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <FormGroup>
                {availableNodeTypes.map(type => (
                  <FormControlLabel
                    key={type}
                    control={
                      <Checkbox
                        size="small"
                        checked={currentFilters.nodeTypes.includes(type)}
                        onChange={(e) => handleNodeTypeChange(type, e.target.checked)}
                      />
                    }
                    label={type}
                  />
                ))}
              </FormGroup>
            </AccordionDetails>
          </Accordion>

          <Accordion
            expanded={expandedSections.has('documentation')}
            onChange={() => handleSectionToggle('documentation')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Description />
                <Typography>Documentation</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <FormControl component="fieldset">
                <RadioGroup
                  value={currentFilters.documentationStatus}
                  onChange={(e) => {
                    onFiltersChange({
                      ...currentFilters,
                      documentationStatus: e.target.value as any
                    });
                  }}
                >
                  <FormControlLabel
                    value="all"
                    control={<Radio size="small" />}
                    label="All Components"
                  />
                  <FormControlLabel
                    value="documented"
                    control={<Radio size="small" />}
                    label={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <CheckCircle color="success" fontSize="small" />
                        <Typography variant="body2">Documented Only</Typography>
                      </Stack>
                    }
                  />
                  <FormControlLabel
                    value="undocumented"
                    control={<Radio size="small" />}
                    label={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Warning color="warning" fontSize="small" />
                        <Typography variant="body2">Undocumented Only</Typography>
                      </Stack>
                    }
                  />
                </RadioGroup>
              </FormControl>
            </AccordionDetails>
          </Accordion>

          <Accordion
            expanded={expandedSections.has('implementation')}
            onChange={() => handleSectionToggle('implementation')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CheckCircle />
                <Typography>Implementation Status</Typography>
                <Badge badgeContent={currentFilters.implementationStatus.length} color="primary" />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <FormGroup>
                {['complete', 'partial', 'stub', 'not-implemented', 'deprecated', 'experimental'].map(status => (
                  <FormControlLabel
                    key={status}
                    control={
                      <Checkbox
                        size="small"
                        checked={currentFilters.implementationStatus.includes(status)}
                        onChange={(e) => handleImplementationStatusChange(status, e.target.checked)}
                      />
                    }
                    label={
                      <Stack direction="row" spacing={1} alignItems="center">
                        {status === 'complete' && <CheckCircle color="success" fontSize="small" />}
                        {status === 'partial' && <Warning color="warning" fontSize="small" />}
                        {(status === 'stub' || status === 'not-implemented') && <Error color="error" fontSize="small" />}
                        <Typography variant="body2" textTransform="capitalize">
                          {status.replace('-', ' ')}
                        </Typography>
                      </Stack>
                    }
                  />
                ))}
              </FormGroup>
            </AccordionDetails>
          </Accordion>

          <Accordion
            expanded={expandedSections.has('todos')}
            onChange={() => handleSectionToggle('todos')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <BugReport />
                <Typography>Technical Debt</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={currentFilters.todoFilters.hasTodos}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          todoFilters: {
                            ...currentFilters.todoFilters,
                            hasTodos: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label="Show components with TODOs only"
                />

                <FormControl size="small">
                  <InputLabel>Priority</InputLabel>
                  <Select
                    multiple
                    value={currentFilters.todoFilters.priority}
                    onChange={(e) => {
                      onFiltersChange({
                        ...currentFilters,
                        todoFilters: {
                          ...currentFilters.todoFilters,
                          priority: e.target.value as string[]
                        }
                      });
                    }}
                    renderValue={(selected) => (
                      <Stack direction="row" spacing={0.5}>
                        {selected.map(value => (
                          <Chip key={value} label={value} size="small" />
                        ))}
                      </Stack>
                    )}
                  >
                    {['critical', 'high', 'medium', 'low'].map(priority => (
                      <MenuItem key={priority} value={priority}>
                        {priority}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            </AccordionDetails>
          </Accordion>

          <Accordion
            expanded={expandedSections.has('entryExit')}
            onChange={() => handleSectionToggle('entryExit')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Input />
                <Typography>Entry/Exit Points</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={currentFilters.entryExitPoints.showEntryPoints}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          entryExitPoints: {
                            ...currentFilters.entryExitPoints,
                            showEntryPoints: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Input color="success" fontSize="small" />
                      <Typography variant="body2">Show Entry Points</Typography>
                    </Stack>
                  }
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={currentFilters.entryExitPoints.showExitPoints}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          entryExitPoints: {
                            ...currentFilters.entryExitPoints,
                            showExitPoints: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Output color="error" fontSize="small" />
                      <Typography variant="body2">Show Exit Points</Typography>
                    </Stack>
                  }
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={currentFilters.entryExitPoints.showExternalOnly}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          entryExitPoints: {
                            ...currentFilters.entryExitPoints,
                            showExternalOnly: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Cloud fontSize="small" />
                      <Typography variant="body2">External Only</Typography>
                    </Stack>
                  }
                />
              </FormGroup>
            </AccordionDetails>
          </Accordion>

          <Accordion
            expanded={expandedSections.has('performance')}
            onChange={() => handleSectionToggle('performance')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Speed />
                <Typography>Performance</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={currentFilters.performanceFilters.showHotPaths}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          performanceFilters: {
                            ...currentFilters.performanceFilters,
                            showHotPaths: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Speed color="error" fontSize="small" />
                      <Typography variant="body2">Hot Paths</Typography>
                    </Stack>
                  }
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={currentFilters.performanceFilters.showBottlenecks}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          performanceFilters: {
                            ...currentFilters.performanceFilters,
                            showBottlenecks: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Warning color="warning" fontSize="small" />
                      <Typography variant="body2">Bottlenecks</Typography>
                    </Stack>
                  }
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={currentFilters.performanceFilters.showCriticalPaths}
                      onChange={(e) => {
                        onFiltersChange({
                          ...currentFilters,
                          performanceFilters: {
                            ...currentFilters.performanceFilters,
                            showCriticalPaths: e.target.checked
                          }
                        });
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Security color="error" fontSize="small" />
                      <Typography variant="body2">Critical Paths</Typography>
                    </Stack>
                  }
                />
              </FormGroup>
            </AccordionDetails>
          </Accordion>

          {availableTags.length > 0 && (
            <Accordion
              expanded={expandedSections.has('tags')}
              onChange={() => handleSectionToggle('tags')}
            >
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Typography>Tags</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {availableTags.map(tag => (
                    <Chip
                      key={tag}
                      label={tag}
                      size="small"
                      onClick={() => handleTagChange(tag, !currentFilters.tags.includes(tag))}
                      color={currentFilters.tags.includes(tag) ? 'primary' : 'default'}
                      variant={currentFilters.tags.includes(tag) ? 'filled' : 'outlined'}
                    />
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          )}
        </Stack>
      </Box>
    </Paper>
  );
};
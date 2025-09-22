import React, { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Alert,
  AlertTitle,
  Tabs,
  Tab,
  Stack,
  Divider,
  IconButton,
  Tooltip,
  Card,
  CardContent,
  LinearProgress,
  Badge
} from '@mui/material';
import {
  ExpandMore,
  Code,
  Description,
  Warning,
  CheckCircle,
  Error,
  Info,
  ContentCopy,
  OpenInNew,
  Functions,
  Input,
  Output,
  BugReport
} from '@mui/icons-material';
import { CASDocumentation, CASNode, CASImplementationStatus } from '../../types/cas.types';

interface DocumentationPanelProps {
  node: CASNode;
  documentation?: CASDocumentation;
  implementationStatus?: CASImplementationStatus;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

const TabPanel: React.FC<TabPanelProps> = ({ children, value, index }) => {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ p: 2 }}>{children}</Box>}
    </div>
  );
};

const getStatusColor = (status?: string): 'success' | 'warning' | 'error' | 'info' | 'default' => {
  switch (status) {
    case 'complete': return 'success';
    case 'partial': return 'warning';
    case 'stub': return 'error';
    case 'not-implemented': return 'error';
    case 'deprecated': return 'warning';
    case 'experimental': return 'info';
    default: return 'default';
  }
};

const getStatusIcon = (status?: string) => {
  switch (status) {
    case 'complete': return <CheckCircle color="success" fontSize="small" />;
    case 'partial': return <Warning color="warning" fontSize="small" />;
    case 'stub': return <Error color="error" fontSize="small" />;
    case 'not-implemented': return <Error color="error" fontSize="small" />;
    case 'deprecated': return <Warning color="warning" fontSize="small" />;
    case 'experimental': return <Info color="info" fontSize="small" />;
    default: return <Info fontSize="small" />;
  }
};

export const DocumentationPanel: React.FC<DocumentationPanelProps> = ({
  node,
  documentation,
  implementationStatus
}) => {
  const [tabValue, setTabValue] = useState(0);
  const [expandedAccordions, setExpandedAccordions] = useState<string[]>(['summary']);

  const handleAccordionChange = (panel: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedAccordions(prev =>
      isExpanded ? [...prev, panel] : prev.filter(p => p !== panel)
    );
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
  };

  const renderImplementationStatus = () => {
    if (!implementationStatus) return null;

    const completeness = implementationStatus.completeness?.estimated_percentage || 0;

    return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
            {getStatusIcon(implementationStatus.status)}
            <Typography variant="h6">
              Implementation Status
            </Typography>
            <Chip
              label={implementationStatus.status}
              color={getStatusColor(implementationStatus.status)}
              size="small"
            />
          </Stack>

          {completeness > 0 && (
            <Box sx={{ mb: 2 }}>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Completeness
                </Typography>
                <Typography variant="body2" fontWeight="bold">
                  {completeness}%
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={completeness}
                color={completeness >= 80 ? 'success' : completeness >= 50 ? 'warning' : 'error'}
              />
            </Box>
          )}

          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
            {implementationStatus.indicators.has_todo_markers && (
              <Chip label="Has TODOs" size="small" color="warning" variant="outlined" />
            )}
            {implementationStatus.indicators.has_stub_returns && (
              <Chip label="Stub Returns" size="small" color="error" variant="outlined" />
            )}
            {implementationStatus.indicators.has_placeholder_code && (
              <Chip label="Placeholder Code" size="small" color="warning" variant="outlined" />
            )}
            {implementationStatus.indicators.has_hardcoded_values && (
              <Chip label="Hardcoded Values" size="small" color="info" variant="outlined" />
            )}
            {implementationStatus.indicators.has_commented_out_code && (
              <Chip label="Commented Code" size="small" color="default" variant="outlined" />
            )}
          </Stack>

          {implementationStatus.deprecation?.is_deprecated && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <AlertTitle>Deprecated</AlertTitle>
              {implementationStatus.deprecation.deprecated_since && (
                <Typography variant="body2">
                  Since: {implementationStatus.deprecation.deprecated_since}
                </Typography>
              )}
              {implementationStatus.deprecation.alternative && (
                <Typography variant="body2">
                  Use instead: <code>{implementationStatus.deprecation.alternative}</code>
                </Typography>
              )}
            </Alert>
          )}

          {implementationStatus.experimental?.is_experimental && (
            <Alert severity="info" sx={{ mt: 2 }}>
              <AlertTitle>Experimental</AlertTitle>
              <Typography variant="body2">
                Stability: {implementationStatus.experimental.stability_level}
                {implementationStatus.experimental.api_may_change && ' - API may change'}
              </Typography>
            </Alert>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderDocumentation = () => {
    if (!documentation) {
      return (
        <Alert severity="info">
          <AlertTitle>No Documentation</AlertTitle>
          This component lacks documentation. Consider adding JSDoc or similar documentation.
        </Alert>
      );
    }

    return (
      <>
        <Accordion
          expanded={expandedAccordions.includes('summary')}
          onChange={handleAccordionChange('summary')}
        >
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Description />
              <Typography>Summary</Typography>
              <Chip label={documentation.type} size="small" />
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            {documentation.summary && (
              <Typography variant="body1" paragraph>
                {documentation.summary}
              </Typography>
            )}
            {documentation.description && (
              <Typography variant="body2" color="text.secondary">
                {documentation.description}
              </Typography>
            )}
          </AccordionDetails>
        </Accordion>

        {documentation.parameters && documentation.parameters.length > 0 && (
          <Accordion
            expanded={expandedAccordions.includes('parameters')}
            onChange={handleAccordionChange('parameters')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Input />
                <Typography>Parameters</Typography>
                <Chip label={documentation.parameters.length} size="small" />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Type</TableCell>
                      <TableCell>Description</TableCell>
                      <TableCell>Optional</TableCell>
                      <TableCell>Default</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {documentation.parameters.map((param, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          <code>{param.name}</code>
                        </TableCell>
                        <TableCell>
                          <Chip label={param.type || 'any'} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell>{param.description || '-'}</TableCell>
                        <TableCell>
                          {param.optional ? (
                            <CheckCircle color="success" fontSize="small" />
                          ) : (
                            <Error color="error" fontSize="small" />
                          )}
                        </TableCell>
                        <TableCell>
                          {param.default_value ? <code>{param.default_value}</code> : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </AccordionDetails>
          </Accordion>
        )}

        {documentation.returns && (
          <Accordion
            expanded={expandedAccordions.includes('returns')}
            onChange={handleAccordionChange('returns')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Output />
                <Typography>Returns</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1}>
                {documentation.returns.type && (
                  <Stack direction="row" spacing={1}>
                    <Typography variant="body2" color="text.secondary">Type:</Typography>
                    <Chip label={documentation.returns.type} size="small" variant="outlined" />
                  </Stack>
                )}
                {documentation.returns.description && (
                  <Typography variant="body2">
                    {documentation.returns.description}
                  </Typography>
                )}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}

        {documentation.throws && documentation.throws.length > 0 && (
          <Accordion
            expanded={expandedAccordions.includes('throws')}
            onChange={handleAccordionChange('throws')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <BugReport />
                <Typography>Throws</Typography>
                <Chip label={documentation.throws.length} size="small" color="error" />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                {documentation.throws.map((throwItem, index) => (
                  <Alert severity="error" key={index} variant="outlined">
                    {throwItem.type && (
                      <Typography variant="body2" fontWeight="bold">
                        {throwItem.type}
                      </Typography>
                    )}
                    {throwItem.description && (
                      <Typography variant="body2">
                        {throwItem.description}
                      </Typography>
                    )}
                  </Alert>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}

        {documentation.examples && documentation.examples.length > 0 && (
          <Accordion
            expanded={expandedAccordions.includes('examples')}
            onChange={handleAccordionChange('examples')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Code />
                <Typography>Examples</Typography>
                <Chip label={documentation.examples.length} size="small" />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                {documentation.examples.map((example, index) => (
                  <Paper key={index} variant="outlined" sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                      <Typography variant="subtitle2">
                        {example.title || `Example ${index + 1}`}
                      </Typography>
                      <IconButton
                        size="small"
                        onClick={() => handleCopyCode(example.code)}
                        title="Copy code"
                      >
                        <ContentCopy fontSize="small" />
                      </IconButton>
                    </Stack>
                    <Box
                      component="pre"
                      sx={{
                        backgroundColor: 'grey.100',
                        p: 1,
                        borderRadius: 1,
                        overflow: 'auto',
                        fontSize: '0.875rem',
                        fontFamily: 'monospace'
                      }}
                    >
                      <code>{example.code}</code>
                    </Box>
                  </Paper>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}

        {documentation.tags && documentation.tags.length > 0 && (
          <Accordion
            expanded={expandedAccordions.includes('tags')}
            onChange={handleAccordionChange('tags')}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography>Tags & Metadata</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1}>
                {documentation.tags.map((tag, index) => (
                  <Stack key={index} direction="row" spacing={1} alignItems="center">
                    <Chip label={tag.tag} size="small" variant="outlined" />
                    <Typography variant="body2">{tag.value}</Typography>
                  </Stack>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}
      </>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <Paper elevation={2} sx={{ height: '100%', overflow: 'auto' }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={tabValue} onChange={(_, v) => setTabValue(v)}>
            <Tab label="Documentation" />
            <Tab label="Implementation" />
            <Tab label="Metadata" />
          </Tabs>
        </Box>

        <TabPanel value={tabValue} index={0}>
          {renderDocumentation()}
        </TabPanel>

        <TabPanel value={tabValue} index={1}>
          {renderImplementationStatus()}
        </TabPanel>

        <TabPanel value={tabValue} index={2}>
          <Stack spacing={2}>
            <Typography variant="h6">Node Information</Typography>
            <Divider />

            <Stack spacing={1}>
              <Stack direction="row" spacing={1}>
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                  ID:
                </Typography>
                <Typography variant="body2" fontFamily="monospace">
                  {node.id}
                </Typography>
              </Stack>

              <Stack direction="row" spacing={1}>
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                  Name:
                </Typography>
                <Typography variant="body2" fontWeight="bold">
                  {node.name}
                </Typography>
              </Stack>

              <Stack direction="row" spacing={1}>
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                  Type:
                </Typography>
                <Chip label={node.type} size="small" />
              </Stack>

              {node.tags && node.tags.length > 0 && (
                <Stack direction="row" spacing={1}>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                    Tags:
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap">
                    {node.tags.map((tag, index) => (
                      <Chip key={index} label={tag} size="small" variant="outlined" />
                    ))}
                  </Stack>
                </Stack>
              )}

              {node.source && (
                <>
                  <Stack direction="row" spacing={1}>
                    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                      File:
                    </Typography>
                    <Typography variant="body2" fontFamily="monospace">
                      {node.source.file}
                    </Typography>
                  </Stack>

                  <Stack direction="row" spacing={1}>
                    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                      Lines:
                    </Typography>
                    <Typography variant="body2">
                      {node.source.line} - {node.source.end_line}
                    </Typography>
                  </Stack>
                </>
              )}

              {node.analyzers && node.analyzers.length > 0 && (
                <Stack direction="row" spacing={1}>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 100 }}>
                    Analyzers:
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap">
                    {node.analyzers.map((analyzer, index) => (
                      <Chip
                        key={index}
                        label={analyzer}
                        size="small"
                        color={analyzer === node.primaryAnalyzer ? 'primary' : 'default'}
                        variant={analyzer === node.primaryAnalyzer ? 'filled' : 'outlined'}
                      />
                    ))}
                  </Stack>
                </Stack>
              )}
            </Stack>
          </Stack>
        </TabPanel>
      </Paper>
    </Box>
  );
};
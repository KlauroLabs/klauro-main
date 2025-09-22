import React, { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  Stack,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  ListItemSecondaryAction,
  IconButton,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  AlertTitle,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Badge,
  Tooltip,
  Card,
  CardContent,
  Grid
} from '@mui/material';
import {
  Code,
  Description,
  Assignment,
  CallSplit,
  Comment,
  ExpandMore,
  OpenInNew,
  ContentCopy,
  Visibility,
  Input,
  Output,
  ArrowForward,
  ArrowBack,
  Warning,
  Error,
  CheckCircle,
  Info,
  BugReport,
  Security,
  Speed,
  Loop,
  Cloud
} from '@mui/icons-material';
import {
  CASNode,
  CASDocumentation,
  CASComment,
  CASTodo,
  CASImplementationStatus,
  CASMethodCall,
  CASEdge
} from '../../types/cas.types';
import { DocumentationPanel } from './DocumentationPanel';

interface NodeDetailsProps {
  node: CASNode;
  edges: CASEdge[];
  methodCalls?: CASMethodCall[];
  allNodes: CASNode[];
  onNodeClick?: (nodeId: string) => void;
  onFileOpen?: (file: string, line: number) => void;
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

export const NodeDetails: React.FC<NodeDetailsProps> = ({
  node,
  edges,
  methodCalls = [],
  allNodes,
  onNodeClick,
  onFileOpen
}) => {
  const [tabValue, setTabValue] = useState(0);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['overview']));

  const incomingEdges = useMemo(() => edges.filter(e => e.target === node.id), [edges, node.id]);
  const outgoingEdges = useMemo(() => edges.filter(e => e.source === node.id), [edges, node.id]);

  const nodeMethods = useMemo(() => {
    return methodCalls.filter(mc => mc.caller_node === node.id);
  }, [methodCalls, node.id]);

  const isEntryPoint = useMemo(() => {
    return node.tags?.includes('entry_point') || incomingEdges.length === 0;
  }, [node.tags, incomingEdges]);

  const isExitPoint = useMemo(() => {
    return node.tags?.includes('exit_point') || outgoingEdges.some(e => e.type === 'external');
  }, [node.tags, outgoingEdges]);

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

  const handleCopyCode = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const renderOverview = () => (
    <Stack spacing={3}>
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Component Information
          </Typography>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                Name:
              </Typography>
              <Typography variant="body1" fontWeight="bold">
                {node.name}
              </Typography>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                Type:
              </Typography>
              <Chip label={node.type} size="small" color="primary" />
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                Location:
              </Typography>
              <Button
                size="small"
                startIcon={<OpenInNew />}
                onClick={() => onFileOpen?.(node.source.file, node.source.line)}
              >
                {node.source.file}:{node.source.line}-{node.source.end_line}
              </Button>
            </Stack>

            {node.level_name && (
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                  Level:
                </Typography>
                <Typography variant="body2">
                  {node.level_name} (Depth: {node.level})
                </Typography>
              </Stack>
            )}

            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                Tags:
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {node.tags.map((tag, index) => (
                  <Chip key={index} label={tag} size="small" variant="outlined" />
                ))}
                {isEntryPoint && (
                  <Chip label="Entry Point" size="small" color="success" icon={<Input />} />
                )}
                {isExitPoint && (
                  <Chip label="Exit Point" size="small" color="error" icon={<Output />} />
                )}
              </Stack>
            </Stack>

            {node.analyzers && node.analyzers.length > 0 && (
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
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
        </CardContent>
      </Card>

      {node.implementation_status && (
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Implementation Status
            </Typography>
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip
                  label={node.implementation_status.status}
                  color={
                    node.implementation_status.status === 'complete' ? 'success' :
                    node.implementation_status.status === 'partial' ? 'warning' :
                    'error'
                  }
                />
                {node.implementation_status.completeness?.estimated_percentage && (
                  <Typography variant="body2">
                    {node.implementation_status.completeness.estimated_percentage}% complete
                  </Typography>
                )}
              </Stack>

              {node.implementation_status.indicators && (
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {node.implementation_status.indicators.has_todo_markers && (
                    <Chip label="Has TODOs" size="small" color="warning" variant="outlined" />
                  )}
                  {node.implementation_status.indicators.has_stub_returns && (
                    <Chip label="Stub Returns" size="small" color="error" variant="outlined" />
                  )}
                  {node.implementation_status.indicators.has_placeholder_code && (
                    <Chip label="Placeholder Code" size="small" color="warning" variant="outlined" />
                  )}
                  {node.implementation_status.indicators.has_hardcoded_values && (
                    <Chip label="Hardcoded Values" size="small" variant="outlined" />
                  )}
                </Stack>
              )}

              {node.implementation_status.deprecation?.is_deprecated && (
                <Alert severity="warning">
                  <AlertTitle>Deprecated</AlertTitle>
                  {node.implementation_status.deprecation.alternative && (
                    <Typography variant="body2">
                      Use instead: {node.implementation_status.deprecation.alternative}
                    </Typography>
                  )}
                </Alert>
              )}
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Connections
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Stack spacing={1}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <ArrowBack color="primary" />
                  <Typography variant="subtitle2">
                    Incoming ({incomingEdges.length})
                  </Typography>
                </Stack>
                <List dense>
                  {incomingEdges.slice(0, 5).map(edge => {
                    const sourceNode = allNodes.find(n => n.id === edge.source);
                    return (
                      <ListItem
                        key={edge.id}
                        button
                        onClick={() => sourceNode && onNodeClick?.(sourceNode.id)}
                      >
                        <ListItemText
                          primary={sourceNode?.name || edge.source}
                          secondary={edge.type}
                        />
                      </ListItem>
                    );
                  })}
                  {incomingEdges.length > 5 && (
                    <ListItem>
                      <ListItemText
                        secondary={`+${incomingEdges.length - 5} more`}
                      />
                    </ListItem>
                  )}
                </List>
              </Stack>
            </Grid>

            <Grid item xs={6}>
              <Stack spacing={1}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <ArrowForward color="secondary" />
                  <Typography variant="subtitle2">
                    Outgoing ({outgoingEdges.length})
                  </Typography>
                </Stack>
                <List dense>
                  {outgoingEdges.slice(0, 5).map(edge => {
                    const targetNode = allNodes.find(n => n.id === edge.target);
                    return (
                      <ListItem
                        key={edge.id}
                        button
                        onClick={() => targetNode && onNodeClick?.(targetNode.id)}
                      >
                        <ListItemText
                          primary={targetNode?.name || edge.target}
                          secondary={edge.type}
                        />
                      </ListItem>
                    );
                  })}
                  {outgoingEdges.length > 5 && (
                    <ListItem>
                      <ListItemText
                        secondary={`+${outgoingEdges.length - 5} more`}
                      />
                    </ListItem>
                  )}
                </List>
              </Stack>
            </Grid>
          </Grid>
        </CardContent>
      </Card>
    </Stack>
  );

  const renderTodos = () => {
    if (!node.todos || node.todos.length === 0) {
      return (
        <Alert severity="success">
          <AlertTitle>No TODOs</AlertTitle>
          This component has no TODO items.
        </Alert>
      );
    }

    return (
      <List>
        {node.todos.map(todo => (
          <ListItem key={todo.id}>
            <ListItemIcon>
              {todo.priority === 'critical' || todo.priority === 'high' ? (
                <Error color="error" />
              ) : todo.priority === 'medium' ? (
                <Warning color="warning" />
              ) : (
                <Info color="info" />
              )}
            </ListItemIcon>
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label={todo.type} size="small" />
                  {todo.priority && (
                    <Chip
                      label={todo.priority}
                      size="small"
                      color={
                        todo.priority === 'critical' || todo.priority === 'high' ? 'error' :
                        todo.priority === 'medium' ? 'warning' : 'default'
                      }
                    />
                  )}
                  {todo.classification?.category && (
                    <Chip label={todo.classification.category} size="small" variant="outlined" />
                  )}
                </Stack>
              }
              secondary={
                <Stack spacing={1}>
                  <Typography variant="body2">{todo.text}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {todo.location.file}:{todo.location.line}
                  </Typography>
                  {todo.assignee && (
                    <Typography variant="caption">
                      Assigned to: {todo.assignee}
                    </Typography>
                  )}
                </Stack>
              }
            />
            {onFileOpen && (
              <ListItemSecondaryAction>
                <IconButton
                  edge="end"
                  onClick={() => onFileOpen(todo.location.file, todo.location.line)}
                >
                  <OpenInNew />
                </IconButton>
              </ListItemSecondaryAction>
            )}
          </ListItem>
        ))}
      </List>
    );
  };

  const renderComments = () => {
    if (!node.comments || node.comments.length === 0) {
      return (
        <Alert severity="info">
          <AlertTitle>No Comments</AlertTitle>
          This component has no inline comments.
        </Alert>
      );
    }

    return (
      <List>
        {node.comments.map(comment => (
          <ListItem key={comment.id}>
            <ListItemIcon>
              <Comment />
            </ListItemIcon>
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label={comment.type} size="small" variant="outlined" />
                  {comment.purpose && (
                    <Chip label={comment.purpose} size="small" />
                  )}
                  {comment.markers?.is_todo && (
                    <Badge badgeContent="TODO" color="warning" />
                  )}
                  {comment.markers?.is_fixme && (
                    <Badge badgeContent="FIXME" color="error" />
                  )}
                </Stack>
              }
              secondary={
                <Stack spacing={1}>
                  <Typography variant="body2">{comment.text}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {comment.location.file}:{comment.location.line}
                  </Typography>
                </Stack>
              }
            />
            <ListItemSecondaryAction>
              <IconButton edge="end" onClick={() => handleCopyCode(comment.text)}>
                <ContentCopy />
              </IconButton>
            </ListItemSecondaryAction>
          </ListItem>
        ))}
      </List>
    );
  };

  const renderMethodCalls = () => {
    if (nodeMethods.length === 0) {
      return (
        <Alert severity="info">
          <AlertTitle>No Method Calls</AlertTitle>
          This component doesn't make any tracked method calls.
        </Alert>
      );
    }

    return (
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Method</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Context</TableCell>
              <TableCell>Performance</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {nodeMethods.map(call => {
              const targetNode = call.target_node ? allNodes.find(n => n.id === call.target_node) : null;

              return (
                <TableRow key={call.id}>
                  <TableCell>
                    <Typography variant="body2" fontWeight="bold">
                      {call.call_details.method_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Line {call.call_details.location.line}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {targetNode ? (
                      <Button
                        size="small"
                        onClick={() => onNodeClick?.(targetNode.id)}
                      >
                        {targetNode.name}
                      </Button>
                    ) : call.external_details ? (
                      <Stack>
                        <Typography variant="body2">
                          {call.external_details.library}
                        </Typography>
                        <Chip label="External" size="small" icon={<Cloud />} />
                      </Stack>
                    ) : (
                      'Unknown'
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip label={call.call_details.call_type} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {call.execution_context.is_async && (
                        <Chip label="Async" size="small" color="secondary" />
                      )}
                      {call.execution_context.is_recursive && (
                        <Chip label="Recursive" size="small" color="warning" icon={<Loop />} />
                      )}
                      {call.execution_context.is_in_loop && (
                        <Chip label="In Loop" size="small" />
                      )}
                      {call.execution_context.is_conditional && (
                        <Chip label="Conditional" size="small" />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {call.performance_hints.is_hot_path && (
                        <Chip label="Hot Path" size="small" color="error" icon={<Speed />} />
                      )}
                      {call.performance_hints.is_potential_bottleneck && (
                        <Chip label="Bottleneck" size="small" color="warning" icon={<Warning />} />
                      )}
                      {call.performance_hints.is_critical_path && (
                        <Chip label="Critical" size="small" color="error" />
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    );
  };

  const renderPerspectives = () => {
    if (!node.perspectives || Object.keys(node.perspectives).length === 0) {
      return (
        <Alert severity="info">
          <AlertTitle>No Perspectives</AlertTitle>
          This component has no perspective-specific data.
        </Alert>
      );
    }

    return (
      <Stack spacing={2}>
        {Object.entries(node.perspectives).map(([perspectiveId, perspective]) => (
          <Accordion
            key={perspectiveId}
            expanded={expandedSections.has(perspectiveId)}
            onChange={() => handleSectionToggle(perspectiveId)}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography variant="subtitle1">
                Perspective: {perspectiveId}
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                <Stack direction="row" spacing={2}>
                  <Typography variant="body2" color="text.secondary">
                    Level: {perspective.level}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Priority: {perspective.priority}
                  </Typography>
                </Stack>

                {perspective.hierarchy && perspective.hierarchy.length > 0 && (
                  <Stack>
                    <Typography variant="subtitle2">Hierarchy</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {perspective.hierarchy.join(' > ')}
                    </Typography>
                  </Stack>
                )}

                {perspective.metadata && Object.keys(perspective.metadata).length > 0 && (
                  <Stack>
                    <Typography variant="subtitle2">Metadata</Typography>
                    {Object.entries(perspective.metadata).map(([key, value]) => (
                      <Typography key={key} variant="body2" color="text.secondary">
                        {key}: {JSON.stringify(value)}
                      </Typography>
                    ))}
                  </Stack>
                )}
              </Stack>
            </AccordionDetails>
          </Accordion>
        ))}
      </Stack>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={tabValue} onChange={(_, v) => setTabValue(v)} variant="scrollable">
            <Tab label="Overview" icon={<Info />} iconPosition="start" />
            <Tab
              label={
                <Badge badgeContent={node.documentation ? 1 : 0} color="primary">
                  Documentation
                </Badge>
              }
              icon={<Description />}
              iconPosition="start"
            />
            <Tab
              label={
                <Badge badgeContent={node.todos?.length || 0} color="warning">
                  TODOs
                </Badge>
              }
              icon={<Assignment />}
              iconPosition="start"
            />
            <Tab
              label={
                <Badge badgeContent={nodeMethods.length} color="secondary">
                  Method Calls
                </Badge>
              }
              icon={<CallSplit />}
              iconPosition="start"
            />
            <Tab
              label={
                <Badge badgeContent={node.comments?.length || 0} color="info">
                  Comments
                </Badge>
              }
              icon={<Comment />}
              iconPosition="start"
            />
            <Tab label="Perspectives" icon={<Visibility />} iconPosition="start" />
          </Tabs>
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto' }}>
          <TabPanel value={tabValue} index={0}>
            {renderOverview()}
          </TabPanel>

          <TabPanel value={tabValue} index={1}>
            <DocumentationPanel
              node={node}
              documentation={node.documentation}
              implementationStatus={node.implementation_status}
            />
          </TabPanel>

          <TabPanel value={tabValue} index={2}>
            {renderTodos()}
          </TabPanel>

          <TabPanel value={tabValue} index={3}>
            {renderMethodCalls()}
          </TabPanel>

          <TabPanel value={tabValue} index={4}>
            {renderComments()}
          </TabPanel>

          <TabPanel value={tabValue} index={5}>
            {renderPerspectives()}
          </TabPanel>
        </Box>
      </Paper>
    </Box>
  );
};
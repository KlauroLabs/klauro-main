import React, { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  ListItemSecondaryAction,
  Chip,
  IconButton,
  Stack,
  Badge,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  InputAdornment,
  Alert,
  AlertTitle,
  Divider,
  Collapse,
  Button,
  Menu,
  MenuItem,
  Checkbox,
  FormControlLabel,
  Grid,
  Card,
  CardContent,
  LinearProgress
} from '@mui/material';
import {
  Warning,
  Error,
  Info,
  CheckCircle,
  Assignment,
  BugReport,
  Build,
  Speed,
  Security,
  Description,
  Code,
  ExpandMore,
  ExpandLess,
  Search,
  FilterList,
  LocationOn,
  Person,
  CalendarToday,
  PriorityHigh,
  Sort,
  OpenInNew
} from '@mui/icons-material';
import { CASTodo, CASTodoSummary } from '../../types/cas.types';

interface TodoPanelProps {
  todos: CASTodo[];
  summary?: CASTodoSummary;
  onTodoClick?: (todo: CASTodo) => void;
  onNavigateToFile?: (file: string, line: number) => void;
}

type PriorityLevel = 'all' | 'low' | 'medium' | 'high' | 'critical';
type TodoType = 'all' | 'TODO' | 'FIXME' | 'HACK' | 'NOTE' | 'WARNING' | 'XXX' | 'OPTIMIZE' | 'REFACTOR';
type CategoryType = 'all' | 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test';

const getPriorityColor = (priority?: string): 'default' | 'info' | 'warning' | 'error' => {
  switch (priority) {
    case 'low': return 'info';
    case 'medium': return 'warning';
    case 'high': return 'error';
    case 'critical': return 'error';
    default: return 'default';
  }
};

const getPriorityIcon = (priority?: string) => {
  switch (priority) {
    case 'low': return <Info fontSize="small" />;
    case 'medium': return <Warning fontSize="small" />;
    case 'high': return <Error fontSize="small" />;
    case 'critical': return <PriorityHigh fontSize="small" color="error" />;
    default: return <Assignment fontSize="small" />;
  }
};

const getCategoryIcon = (category?: string) => {
  switch (category) {
    case 'bug': return <BugReport fontSize="small" />;
    case 'feature': return <Assignment fontSize="small" />;
    case 'refactor': return <Build fontSize="small" />;
    case 'performance': return <Speed fontSize="small" />;
    case 'security': return <Security fontSize="small" />;
    case 'documentation': return <Description fontSize="small" />;
    case 'test': return <Code fontSize="small" />;
    default: return <Assignment fontSize="small" />;
  }
};

const getTypeColor = (type: string): 'default' | 'error' | 'warning' | 'info' | 'success' => {
  switch (type) {
    case 'FIXME': return 'error';
    case 'HACK': return 'warning';
    case 'TODO': return 'info';
    case 'WARNING': return 'warning';
    case 'NOTE': return 'default';
    case 'OPTIMIZE': return 'success';
    case 'REFACTOR': return 'info';
    default: return 'default';
  }
};

export const TodoPanel: React.FC<TodoPanelProps> = ({
  todos,
  summary,
  onTodoClick,
  onNavigateToFile
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPriority, setSelectedPriority] = useState<PriorityLevel>('all');
  const [selectedType, setSelectedType] = useState<TodoType>('all');
  const [selectedCategory, setSelectedCategory] = useState<CategoryType>('all');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [showTechnicalDebtOnly, setShowTechnicalDebtOnly] = useState(false);
  const [showBlockingOnly, setShowBlockingOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'priority' | 'type' | 'file' | 'recent'>('priority');
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const filteredTodos = useMemo(() => {
    let filtered = [...todos];

    if (searchTerm) {
      filtered = filtered.filter(todo =>
        todo.text.toLowerCase().includes(searchTerm.toLowerCase()) ||
        todo.location.file.toLowerCase().includes(searchTerm.toLowerCase()) ||
        todo.context?.function_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        todo.context?.class_name?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (selectedPriority !== 'all') {
      filtered = filtered.filter(todo => todo.priority === selectedPriority);
    }

    if (selectedType !== 'all') {
      filtered = filtered.filter(todo => todo.type === selectedType);
    }

    if (selectedCategory !== 'all') {
      filtered = filtered.filter(todo => todo.classification?.category === selectedCategory);
    }

    if (showTechnicalDebtOnly) {
      filtered = filtered.filter(todo => todo.classification?.technical_debt);
    }

    if (showBlockingOnly) {
      filtered = filtered.filter(todo => todo.classification?.blocking);
    }

    const priorityOrder = { 'critical': 0, 'high': 1, 'medium': 2, 'low': 3, undefined: 4 };

    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'priority':
          return (priorityOrder[a.priority as keyof typeof priorityOrder] || 4) -
                 (priorityOrder[b.priority as keyof typeof priorityOrder] || 4);
        case 'type':
          return a.type.localeCompare(b.type);
        case 'file':
          return a.location.file.localeCompare(b.location.file);
        case 'recent':
          return (b.created_date || '').localeCompare(a.created_date || '');
        default:
          return 0;
      }
    });

    return filtered;
  }, [todos, searchTerm, selectedPriority, selectedType, selectedCategory,
      showTechnicalDebtOnly, showBlockingOnly, sortBy]);

  const toggleExpanded = (todoId: string) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(todoId)) {
        newSet.delete(todoId);
      } else {
        newSet.add(todoId);
      }
      return newSet;
    });
  };

  const renderSummaryCards = () => {
    if (!summary) return null;

    return (
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">{summary.total_todos}</Typography>
                <Assignment color="primary" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Total TODOs
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6" color="error.main">
                  {summary.by_priority.critical + summary.by_priority.high}
                </Typography>
                <PriorityHigh color="error" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                High Priority
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6" color="warning.main">
                  {summary.technical_debt_items}
                </Typography>
                <Warning color="warning" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Technical Debt
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6" color="error.main">
                  {summary.blocking_items}
                </Typography>
                <Error color="error" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Blocking Issues
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    );
  };

  const renderTodoItem = (todo: CASTodo) => {
    const isExpanded = expandedItems.has(todo.id);

    return (
      <React.Fragment key={todo.id}>
        <ListItem
          button
          onClick={() => toggleExpanded(todo.id)}
          sx={{
            borderLeft: 4,
            borderLeftColor: `${getPriorityColor(todo.priority)}.main`,
            '&:hover': { backgroundColor: 'action.hover' }
          }}
        >
          <ListItemIcon>
            {getCategoryIcon(todo.classification?.category)}
          </ListItemIcon>

          <ListItemText
            primary={
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip
                  label={todo.type}
                  size="small"
                  color={getTypeColor(todo.type)}
                  variant="outlined"
                />
                {todo.priority && (
                  <Chip
                    icon={getPriorityIcon(todo.priority)}
                    label={todo.priority}
                    size="small"
                    color={getPriorityColor(todo.priority)}
                  />
                )}
                {todo.classification?.technical_debt && (
                  <Chip label="Tech Debt" size="small" color="warning" variant="outlined" />
                )}
                {todo.classification?.blocking && (
                  <Badge badgeContent="!" color="error">
                    <Chip label="Blocking" size="small" color="error" />
                  </Badge>
                )}
                {todo.assignee && (
                  <Chip
                    icon={<Person fontSize="small" />}
                    label={todo.assignee}
                    size="small"
                    variant="outlined"
                  />
                )}
              </Stack>
            }
            secondary={
              <Typography variant="body2" noWrap sx={{ maxWidth: '80%' }}>
                {todo.text}
              </Typography>
            }
          />

          <ListItemSecondaryAction>
            <IconButton edge="end" size="small">
              {isExpanded ? <ExpandLess /> : <ExpandMore />}
            </IconButton>
          </ListItemSecondaryAction>
        </ListItem>

        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          <Box sx={{ pl: 9, pr: 3, py: 2, backgroundColor: 'action.hover' }}>
            <Stack spacing={2}>
              <Typography variant="body2">
                {todo.text}
              </Typography>

              <Divider />

              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <LocationOn fontSize="small" color="action" />
                  <Typography variant="body2" color="text.secondary">
                    {todo.location.file}:{todo.location.line}
                  </Typography>
                  {onNavigateToFile && (
                    <IconButton
                      size="small"
                      onClick={() => onNavigateToFile(todo.location.file, todo.location.line)}
                    >
                      <OpenInNew fontSize="small" />
                    </IconButton>
                  )}
                </Stack>

                {todo.context?.function_name && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Code fontSize="small" color="action" />
                    <Typography variant="body2" color="text.secondary">
                      Function: {todo.context.function_name}
                    </Typography>
                  </Stack>
                )}

                {todo.context?.class_name && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Code fontSize="small" color="action" />
                    <Typography variant="body2" color="text.secondary">
                      Class: {todo.context.class_name}
                    </Typography>
                  </Stack>
                )}

                {todo.created_date && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <CalendarToday fontSize="small" color="action" />
                    <Typography variant="body2" color="text.secondary">
                      Created: {todo.created_date}
                    </Typography>
                  </Stack>
                )}

                {todo.due_date && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <CalendarToday fontSize="small" color="error" />
                    <Typography variant="body2" color="error.main">
                      Due: {todo.due_date}
                    </Typography>
                  </Stack>
                )}

                {todo.context?.estimated_effort && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Speed fontSize="small" color="action" />
                    <Typography variant="body2" color="text.secondary">
                      Effort: {todo.context.estimated_effort}
                    </Typography>
                  </Stack>
                )}

                {todo.context?.related_issue && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <BugReport fontSize="small" color="action" />
                    <Typography variant="body2" color="text.secondary">
                      Issue: {todo.context.related_issue}
                    </Typography>
                  </Stack>
                )}
              </Stack>

              {onTodoClick && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => onTodoClick(todo)}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  View Details
                </Button>
              )}
            </Stack>
          </Box>
        </Collapse>
      </React.Fragment>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {renderSummaryCards()}

      <Paper elevation={2} sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack spacing={2}>
            <TextField
              fullWidth
              size="small"
              placeholder="Search TODOs..."
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

            <Stack direction="row" spacing={2} flexWrap="wrap">
              <ToggleButtonGroup
                value={selectedPriority}
                exclusive
                onChange={(_, value) => value && setSelectedPriority(value)}
                size="small"
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="critical" color="error">Critical</ToggleButton>
                <ToggleButton value="high" color="error">High</ToggleButton>
                <ToggleButton value="medium" color="warning">Medium</ToggleButton>
                <ToggleButton value="low" color="info">Low</ToggleButton>
              </ToggleButtonGroup>

              <Button
                size="small"
                startIcon={<Sort />}
                onClick={(e) => setAnchorEl(e.currentTarget)}
              >
                Sort: {sortBy}
              </Button>

              <Menu
                anchorEl={anchorEl}
                open={Boolean(anchorEl)}
                onClose={() => setAnchorEl(null)}
              >
                <MenuItem onClick={() => { setSortBy('priority'); setAnchorEl(null); }}>
                  Priority
                </MenuItem>
                <MenuItem onClick={() => { setSortBy('type'); setAnchorEl(null); }}>
                  Type
                </MenuItem>
                <MenuItem onClick={() => { setSortBy('file'); setAnchorEl(null); }}>
                  File
                </MenuItem>
                <MenuItem onClick={() => { setSortBy('recent'); setAnchorEl(null); }}>
                  Recent
                </MenuItem>
              </Menu>
            </Stack>

            <Stack direction="row" spacing={2}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={showTechnicalDebtOnly}
                    onChange={(e) => setShowTechnicalDebtOnly(e.target.checked)}
                    size="small"
                  />
                }
                label="Technical Debt Only"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={showBlockingOnly}
                    onChange={(e) => setShowBlockingOnly(e.target.checked)}
                    size="small"
                  />
                }
                label="Blocking Only"
              />
            </Stack>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {filteredTodos.length === 0 ? (
            <Alert severity="info" sx={{ m: 2 }}>
              <AlertTitle>No TODOs Found</AlertTitle>
              {todos.length === 0
                ? 'No TODO items in this codebase. Great job!'
                : 'No TODO items match the current filters.'}
            </Alert>
          ) : (
            <List>
              {filteredTodos.map(renderTodoItem)}
            </List>
          )}
        </Box>
      </Paper>
    </Box>
  );
};
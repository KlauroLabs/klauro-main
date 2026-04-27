import React, { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  InputAdornment,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Stack,
  Divider,
  ToggleButton,
  ToggleButtonGroup,
  Badge,
  Alert,
  AlertTitle,
  CircularProgress,
  Tooltip,
  Collapse,
  Card,
  CardContent,
  FormControlLabel,
  Checkbox,
  Button
} from '@mui/material';
import {
  Search,
  Clear,
  Code,
  Description,
  Assignment,
  Comment,
  CallSplit,
  OpenInNew,
  ExpandMore,
  ExpandLess,
  FilterList,
  History,
  TrendingUp,
  ContentCopy,
  Folder,
  Functions,
  Class,
  DataObject,
  Api
} from '@mui/icons-material';
import {
  CASNode,
  CASEdge,
  CASDocumentation,
  CASTodo,
  CASComment,
  CASMethodCall
} from '../../types/cas.types';

interface SearchPanelProps {
  nodes: CASNode[];
  edges: CASEdge[];
  methodCalls?: CASMethodCall[];
  onNodeClick?: (nodeId: string) => void;
  onFileOpen?: (file: string, line: number) => void;
}

interface SearchResult {
  id: string;
  type: 'node' | 'documentation' | 'todo' | 'comment' | 'parameter' | 'method-call';
  node: CASNode;
  matchedContent: string;
  matchedField: string;
  score: number;
  context?: any;
  highlights?: Array<{ start: number; end: number }>;
}

type SearchScope = 'all' | 'names' | 'documentation' | 'todos' | 'comments' | 'parameters' | 'calls';

export const SearchPanel: React.FC<SearchPanelProps> = ({
  nodes,
  edges,
  methodCalls = [],
  onNodeClick,
  onFileOpen
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [searchInFiles, setSearchInFiles] = useState(true);

  const performSearch = useCallback((query: string): SearchResult[] => {
    if (!query || query.length < 2) return [];

    const results: SearchResult[] = [];
    const searchPattern = useRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : query.toLowerCase();

    const matchText = (text: string): boolean => {
      if (!text) return false;
      if (useRegex) {
        return (searchPattern as RegExp).test(text);
      }
      return caseSensitive
        ? text.includes(query)
        : text.toLowerCase().includes(searchPattern as string);
    };

    const calculateScore = (matched: string, field: string): number => {
      let score = 1;
      if (field === 'name') score += 3;
      if (field === 'documentation.summary') score += 2;
      if (matched.startsWith(query)) score += 2;
      if (matched === query) score += 5;
      return score;
    };

    nodes.forEach(node => {
      if ((searchScope === 'all' || searchScope === 'names') && matchText(node.name)) {
        results.push({
          id: `${node.id}-name`,
          type: 'node',
          node,
          matchedContent: node.name,
          matchedField: 'name',
          score: calculateScore(node.name, 'name')
        });
      }

      if ((searchScope === 'all' || searchScope === 'documentation') && node.documentation) {
        const doc = node.documentation;

        if (doc.summary && matchText(doc.summary)) {
          results.push({
            id: `${node.id}-doc-summary`,
            type: 'documentation',
            node,
            matchedContent: doc.summary,
            matchedField: 'documentation.summary',
            score: calculateScore(doc.summary, 'documentation.summary'),
            context: doc
          });
        }

        if (doc.description && matchText(doc.description)) {
          results.push({
            id: `${node.id}-doc-desc`,
            type: 'documentation',
            node,
            matchedContent: doc.description,
            matchedField: 'documentation.description',
            score: calculateScore(doc.description, 'documentation.description'),
            context: doc
          });
        }
      }

      // Parameters search - separate from documentation
      if ((searchScope === 'all' || searchScope === 'parameters') && node.documentation?.parameters) {
        node.documentation.parameters.forEach((param, idx) => {
          if (matchText(param.name) || (param.description && matchText(param.description))) {
            results.push({
              id: `${node.id}-param-${idx}`,
              type: 'parameter',
              node,
              matchedContent: `${param.name}: ${param.description || param.type || ''}`,
              matchedField: 'parameter',
              score: calculateScore(param.name, 'parameter'),
              context: param
            });
          }
        });
      }

      if ((searchScope === 'all' || searchScope === 'todos') && node.todos) {
        node.todos.forEach((todo, idx) => {
          if (matchText(todo.text)) {
            results.push({
              id: `${node.id}-todo-${idx}`,
              type: 'todo',
              node,
              matchedContent: todo.text,
              matchedField: 'todo',
              score: calculateScore(todo.text, 'todo'),
              context: todo
            });
          }
        });
      }

      if ((searchScope === 'all' || searchScope === 'comments') && node.comments) {
        node.comments.forEach((comment, idx) => {
          if (matchText(comment.text)) {
            results.push({
              id: `${node.id}-comment-${idx}`,
              type: 'comment',
              node,
              matchedContent: comment.text,
              matchedField: 'comment',
              score: calculateScore(comment.text, 'comment'),
              context: comment
            });
          }
        });
      }
    });

    if ((searchScope === 'all' || searchScope === 'calls') && methodCalls.length > 0) {
      methodCalls.forEach((call, idx) => {
        if (matchText(call.call_details.method_name)) {
          const callerNode = nodes.find(n => n.id === call.caller_node);
          if (callerNode) {
            results.push({
              id: `call-${idx}`,
              type: 'method-call',
              node: callerNode,
              matchedContent: call.call_details.method_name,
              matchedField: 'method-call',
              score: calculateScore(call.call_details.method_name, 'method-call'),
              context: call
            });
          }
        }
      });
    }

    results.sort((a, b) => b.score - a.score);

    return results;
  }, [nodes, methodCalls, searchScope, caseSensitive, useRegex]);

  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    return performSearch(searchQuery);
  }, [searchQuery, performSearch]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query && !recentSearches.includes(query)) {
      setRecentSearches(prev => [query, ...prev.slice(0, 4)]);
    }
  };

  const toggleResultExpansion = (resultId: string) => {
    setExpandedResults(prev => {
      const newSet = new Set(prev);
      if (newSet.has(resultId)) {
        newSet.delete(resultId);
      } else {
        newSet.add(resultId);
      }
      return newSet;
    });
  };

  const getResultIcon = (type: SearchResult['type']) => {
    switch (type) {
      case 'node': return <Code />;
      case 'documentation': return <Description />;
      case 'todo': return <Assignment />;
      case 'comment': return <Comment />;
      case 'parameter': return <Functions />;
      case 'method-call': return <CallSplit />;
      default: return <Code />;
    }
  };

  const getResultColor = (type: SearchResult['type']) => {
    switch (type) {
      case 'node': return 'primary';
      case 'documentation': return 'success';
      case 'todo': return 'warning';
      case 'comment': return 'info';
      case 'parameter': return 'secondary';
      case 'method-call': return 'default';
      default: return 'default';
    }
  };

  const highlightMatch = (text: string, query: string) => {
    if (!query || !text) return text;

    try {
      const pattern = useRegex ? new RegExp(`(${query})`, caseSensitive ? 'g' : 'gi') :
                                 new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, caseSensitive ? 'g' : 'gi');

      const parts = text.split(pattern);
      return (
        <>
          {parts.map((part, index) =>
            pattern.test(part) ? (
              <mark key={index} style={{ backgroundColor: '#ffeb3b', padding: '0 2px' }}>
                {part}
              </mark>
            ) : (
              <span key={index}>{part}</span>
            )
          )}
        </>
      );
    } catch (error) {
      return text;
    }
  };

  const renderSearchResult = (result: SearchResult) => {
    const isExpanded = expandedResults.has(result.id);

    return (
      <React.Fragment key={result.id}>
        <ListItem
          button
          onClick={() => toggleResultExpansion(result.id)}
          sx={{
            borderLeft: 4,
            borderLeftColor: `${getResultColor(result.type)}.main`
          }}
        >
          <ListItemIcon>
            {getResultIcon(result.type)}
          </ListItemIcon>

          <ListItemText
            primary={
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="subtitle2">
                  {result.node.name}
                </Typography>
                <Chip label={result.type.replace('-', ' ')} size="small" color={getResultColor(result.type)} />
                <Chip label={result.node.type} size="small" variant="outlined" />
              </Stack>
            }
            secondary={
              <Typography variant="body2" component="div">
                {highlightMatch(result.matchedContent.substring(0, 100) + (result.matchedContent.length > 100 ? '...' : ''), searchQuery)}
              </Typography>
            }
          />

          <ListItemSecondaryAction>
            <IconButton edge="end">
              {isExpanded ? <ExpandLess /> : <ExpandMore />}
            </IconButton>
          </ListItemSecondaryAction>
        </ListItem>

        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          <Box sx={{ pl: 9, pr: 3, py: 2, backgroundColor: 'action.hover' }}>
            <Stack spacing={2}>
              <Typography variant="body2" component="div">
                {highlightMatch(result.matchedContent, searchQuery)}
              </Typography>

              <Divider />

              <Stack spacing={1}>
                <Typography variant="caption" color="text.secondary">
                  Found in: {result.matchedField}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  File: {result.node.source.file}:{result.node.source.line}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Match Score: {result.score}
                </Typography>
              </Stack>

              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  startIcon={<Code />}
                  onClick={() => onNodeClick?.(result.node.id)}
                >
                  View Component
                </Button>
                {onFileOpen && (
                  <Button
                    size="small"
                    startIcon={<OpenInNew />}
                    onClick={() => onFileOpen(result.node.source.file, result.node.source.line)}
                  >
                    Open File
                  </Button>
                )}
                <IconButton
                  size="small"
                  onClick={() => navigator.clipboard.writeText(result.matchedContent)}
                >
                  <ContentCopy fontSize="small" />
                </IconButton>
              </Stack>

              {result.context && result.type === 'todo' && (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1}>
                      <Stack direction="row" spacing={1}>
                        <Chip label={result.context.type} size="small" />
                        {result.context.priority && (
                          <Chip label={result.context.priority} size="small" color="warning" />
                        )}
                      </Stack>
                      {result.context.assignee && (
                        <Typography variant="caption">
                          Assigned to: {result.context.assignee}
                        </Typography>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              )}

              {result.context && result.type === 'parameter' && (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1}>
                      <Typography variant="subtitle2">Parameter Details</Typography>
                      <Typography variant="body2">
                        Name: <strong>{result.context.name}</strong>
                      </Typography>
                      {result.context.type && (
                        <Typography variant="body2">
                          Type: <Chip label={result.context.type} size="small" />
                        </Typography>
                      )}
                      {result.context.optional && (
                        <Chip label="Optional" size="small" color="info" />
                      )}
                      {result.context.default_value && (
                        <Typography variant="body2">
                          Default: <code>{result.context.default_value}</code>
                        </Typography>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              )}
            </Stack>
          </Box>
        </Collapse>
      </React.Fragment>
    );
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Paper elevation={2} sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack spacing={2}>
            <TextField
              fullWidth
              placeholder="Search components, documentation, TODOs, parameters..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    {isSearching ? <CircularProgress size={20} /> : <Search />}
                  </InputAdornment>
                ),
                endAdornment: searchQuery && (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setSearchQuery('')}>
                      <Clear />
                    </IconButton>
                  </InputAdornment>
                )
              }}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleSearch(searchQuery);
                }
              }}
            />

            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <ToggleButtonGroup
                value={searchScope}
                exclusive
                onChange={(_, value) => value && setSearchScope(value)}
                size="small"
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="names">Names</ToggleButton>
                <ToggleButton value="documentation">Docs</ToggleButton>
                <ToggleButton value="todos">TODOs</ToggleButton>
                <ToggleButton value="comments">Comments</ToggleButton>
                <ToggleButton value="parameters">Params</ToggleButton>
                <ToggleButton value="calls">Calls</ToggleButton>
              </ToggleButtonGroup>

              <Stack direction="row" spacing={1}>
                <Tooltip title="Case Sensitive">
                  <ToggleButton
                    value="case"
                    selected={caseSensitive}
                    onChange={() => setCaseSensitive(!caseSensitive)}
                    size="small"
                  >
                    Aa
                  </ToggleButton>
                </Tooltip>
                <Tooltip title="Use Regular Expression">
                  <ToggleButton
                    value="regex"
                    selected={useRegex}
                    onChange={() => setUseRegex(!useRegex)}
                    size="small"
                  >
                    .*
                  </ToggleButton>
                </Tooltip>
              </Stack>
            </Stack>

            {recentSearches.length > 0 && !searchQuery && (
              <Stack>
                <Typography variant="caption" color="text.secondary" gutterBottom>
                  Recent Searches
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {recentSearches.map((search, index) => (
                    <Chip
                      key={index}
                      label={search}
                      size="small"
                      icon={<History />}
                      onClick={() => setSearchQuery(search)}
                      onDelete={() => {
                        setRecentSearches(prev => prev.filter((_, i) => i !== index));
                      }}
                    />
                  ))}
                </Stack>
              </Stack>
            )}
          </Stack>
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {searchQuery && searchResults.length === 0 ? (
            <Alert severity="info" sx={{ m: 2 }}>
              <AlertTitle>No Results</AlertTitle>
              {`No matches found for "${searchQuery}" in ${searchScope === 'all' ? 'any field' : searchScope}.`}
            </Alert>
          ) : searchQuery && searchResults.length > 0 ? (
            <>
              <Box sx={{ p: 2, backgroundColor: 'action.hover' }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2">
                    Found {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    {Object.entries(
                      searchResults.reduce((acc, r) => {
                        acc[r.type] = (acc[r.type] || 0) + 1;
                        return acc;
                      }, {} as Record<string, number>)
                    ).map(([type, count]) => (
                      <Chip
                        key={type}
                        label={`${type.replace('-', ' ')}: ${count}`}
                        size="small"
                        color={getResultColor(type as SearchResult['type'])}
                        variant="outlined"
                      />
                    ))}
                  </Stack>
                </Stack>
              </Box>
              <List>
                {searchResults.map(renderSearchResult)}
              </List>
            </>
          ) : (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Search sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
              <Typography variant="h6" color="text.secondary">
                Start searching
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Search across component names, documentation, TODOs, comments, parameters, and method calls.
              </Typography>
            </Box>
          )}
        </Box>
      </Paper>
    </Box>
  );
};

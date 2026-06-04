import React, { useState } from 'react';
import {
  Paper,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  Box,
  IconButton,
  Collapse,
  Alert,
  Button
} from '@mui/material';
import {
  Error as ErrorIcon,
  Warning,
  Info,
  ExpandMore,
  ExpandLess,
  Close,
  BugReport,
  Speed,
  Security,
  Memory
} from '@mui/icons-material';

interface Issue {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: 'error' | 'performance' | 'security' | 'warning';
  message: string;
  component: string;
  timestamp: Date;
  details?: string;
  affectedUsers?: number;
}

interface IssuesPanelProps {
  issues: Issue[];
  isOpen: boolean;
  onClose: () => void;
  onIssueClick: (issue: Issue) => void;
  onNavigateToComponent: (componentId: string) => void;
}

export const IssuesPanel: React.FC<IssuesPanelProps> = ({
  issues,
  isOpen,
  onClose,
  onIssueClick,
  onNavigateToComponent
}) => {
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<string>('all');

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return '#f44336';
      case 'high': return '#ff5722';
      case 'medium': return '#ff9800';
      case 'low': return '#ffc107';
      default: return '#2196f3';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'error': return <ErrorIcon />;
      case 'performance': return <Speed />;
      case 'security': return <Security />;
      case 'warning': return <Warning />;
      default: return <Info />;
    }
  };

  const filteredIssues = filterSeverity === 'all' 
    ? issues 
    : issues.filter(issue => issue.severity === filterSeverity);

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const highCount = issues.filter(i => i.severity === 'high').length;

  if (!isOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        top: 80,
        right: 16,
        width: 400,
        maxHeight: 'calc(100vh - 100px)',
        bgcolor: 'rgba(0, 8, 20, 0.95)',
        border: '2px solid #f44336',
        borderRadius: 1,
        zIndex: 1000,
        overflow: 'hidden'
      }}
    >
      {/* Header */}
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        p: 2,
        borderBottom: '1px solid #f44336',
        bgcolor: 'rgba(244, 67, 54, 0.1)'
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <ErrorIcon sx={{ color: '#f44336', mr: 1 }} />
          <Typography variant="h6" sx={{ color: '#f44336', fontWeight: 'bold' }}>
            SYSTEM ISSUES
          </Typography>
        </Box>
        <IconButton onClick={onClose} sx={{ color: '#f44336' }}>
          <Close />
        </IconButton>
      </Box>

      {/* Alert Summary */}
      {(criticalCount > 0 || highCount > 0) && (
        <Alert 
          severity="error" 
          sx={{ 
            m: 2, 
            bgcolor: 'rgba(244, 67, 54, 0.1)',
            border: '1px solid #f44336',
            '& .MuiAlert-message': { color: '#fff' }
          }}
        >
          <strong>IMMEDIATE ATTENTION REQUIRED:</strong><br />
          {criticalCount > 0 && `${criticalCount} Critical`}
          {criticalCount > 0 && highCount > 0 && ', '}
          {highCount > 0 && `${highCount} High Priority`}
        </Alert>
      )}

      {/* Severity Filters */}
      <Box sx={{ p: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {['all', 'critical', 'high', 'medium', 'low'].map(severity => (
          <Chip
            key={severity}
            label={severity === 'all' ? 'ALL' : severity.toUpperCase()}
            onClick={() => setFilterSeverity(severity)}
            variant={filterSeverity === severity ? 'filled' : 'outlined'}
            sx={{
              color: filterSeverity === severity ? '#000' : getSeverityColor(severity),
              bgcolor: filterSeverity === severity ? getSeverityColor(severity) : 'transparent',
              borderColor: getSeverityColor(severity),
              '&:hover': {
                bgcolor: `${getSeverityColor(severity)}20`
              }
            }}
          />
        ))}
      </Box>

      {/* Issues List */}
      <List sx={{ maxHeight: '400px', overflow: 'auto' }}>
        {filteredIssues.map(issue => (
          <React.Fragment key={issue.id}>
            <ListItem
              button
              onClick={() => {
                setExpandedIssue(expandedIssue === issue.id ? null : issue.id);
                onIssueClick(issue);
              }}
              sx={{
                borderLeft: `4px solid ${getSeverityColor(issue.severity)}`,
                mb: 1,
                bgcolor: expandedIssue === issue.id ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                '&:hover': {
                  bgcolor: 'rgba(255, 255, 255, 0.08)'
                }
              }}
            >
              <ListItemIcon sx={{ color: getSeverityColor(issue.severity) }}>
                {getTypeIcon(issue.type)}
              </ListItemIcon>
              <ListItemText
                primary={
                  <Box>
                    <Typography variant="body2" sx={{ color: '#fff', fontWeight: 'bold' }}>
                      {issue.message}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                      <Chip
                        label={issue.severity.toUpperCase()}
                        size="small"
                        sx={{
                          bgcolor: getSeverityColor(issue.severity),
                          color: '#fff',
                          fontSize: '10px',
                          height: 20
                        }}
                      />
                      <Typography variant="caption" sx={{ color: '#aaa' }}>
                        {issue.component}
                      </Typography>
                      <Typography variant="caption" sx={{ color: '#aaa' }}>
                        {issue.timestamp.toLocaleTimeString()}
                      </Typography>
                    </Box>
                  </Box>
                }
              />
              <IconButton size="small" sx={{ color: '#fff' }}>
                {expandedIssue === issue.id ? <ExpandLess /> : <ExpandMore />}
              </IconButton>
            </ListItem>

            {/* Expanded Details */}
            <Collapse in={expandedIssue === issue.id}>
              <Box sx={{ pl: 4, pr: 2, pb: 2 }}>
                {issue.details && (
                  <Typography variant="body2" sx={{ color: '#ccc', mb: 1 }}>
                    {issue.details}
                  </Typography>
                )}
                
                {issue.affectedUsers && (
                  <Typography variant="caption" sx={{ color: '#ff9800' }}>
                    Affecting {issue.affectedUsers} users
                  </Typography>
                )}

                <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => onNavigateToComponent(issue.component)}
                    sx={{
                      color: '#00bcd4',
                      borderColor: '#00bcd4',
                      fontSize: '10px'
                    }}
                  >
                    GO TO COMPONENT
                  </Button>
                  
                  {issue.type === 'error' && (
                    <Button
                      size="small"
                      variant="outlined"
                      sx={{
                        color: '#f44336',
                        borderColor: '#f44336',
                        fontSize: '10px'
                      }}
                    >
                      VIEW LOGS
                    </Button>
                  )}
                </Box>
              </Box>
            </Collapse>
          </React.Fragment>
        ))}

        {filteredIssues.length === 0 && (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" sx={{ color: '#4caf50' }}>
              ✓ No {filterSeverity === 'all' ? '' : filterSeverity + ' '} issues found
            </Typography>
          </Box>
        )}
      </List>
    </Paper>
  );
};
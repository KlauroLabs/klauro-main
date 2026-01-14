import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  IconButton,
  TextField,
  InputAdornment,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Chip,
  Divider,
} from '@mui/material';
import {
  ArrowBack,
  Search,
  AccountTree,
  Security,
  Dns,
  Storage,
  Hub,
  Code,
  Warning,
  CheckCircle,
} from '@mui/icons-material';
import { CASNode } from '../types';
import { ArchitectureItemType } from './SystemOverview';

export interface ArchitectureItemsViewProps {
  itemType: ArchitectureItemType;
  nodes: CASNode[];
  onBack: () => void;
  onNodeSelect?: (nodeId: string) => void;
}

const ITEM_CONFIG: Record<ArchitectureItemType, {
  title: string;
  icon: React.ReactNode;
  description: string;
}> = {
  controller: {
    title: 'Controllers',
    icon: <AccountTree />,
    description: 'HTTP request handlers that define API endpoints',
  },
  guard: {
    title: 'Guards',
    icon: <Security />,
    description: 'Authentication and authorization handlers',
  },
  service: {
    title: 'Services',
    icon: <Dns />,
    description: 'Business logic and domain services',
  },
  repository: {
    title: 'Repositories',
    icon: <Storage />,
    description: 'Data access layer for database operations',
  },
  gateway: {
    title: 'Gateways',
    icon: <Hub />,
    description: 'WebSocket and real-time communication handlers',
  },
};

export const ArchitectureItemsView: React.FC<ArchitectureItemsViewProps> = ({
  itemType,
  nodes,
  onBack,
  onNodeSelect,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const config = ITEM_CONFIG[itemType];

  const filteredNodes = useMemo(() => {
    const typeNodes = nodes.filter(n => n.type === itemType);

    if (!searchQuery.trim()) {
      return typeNodes;
    }

    const query = searchQuery.toLowerCase();
    return typeNodes.filter(n =>
      n.name.toLowerCase().includes(query) ||
      n.source?.file?.toLowerCase().includes(query) ||
      n.documentation?.summary?.toLowerCase().includes(query)
    );
  }, [nodes, itemType, searchQuery]);

  const getImplementationStatus = (node: CASNode) => {
    if (!node.implementation_status) return null;
    const status = node.implementation_status.status;
    if (status === 'complete') {
      return <CheckCircle fontSize="small" color="success" />;
    }
    return <Warning fontSize="small" color="warning" />;
  };

  const getMethodCount = (node: CASNode) => {
    const metadata = node.metadata as any;
    return metadata?.attributes?.method_count || metadata?.attributes?.methods?.length || 0;
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
              {config.icon}
              <Typography variant="h6" fontWeight={600}>
                {config.title}
              </Typography>
              <Chip label={filteredNodes.length} size="small" />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {config.description}
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Box sx={{ px: 3, py: 2 }}>
        <TextField
          fullWidth
          size="small"
          placeholder={`Search ${config.title.toLowerCase()}...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <Search fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: 3, pb: 3 }}>
        {filteredNodes.length === 0 ? (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">
              {searchQuery ? `No ${config.title.toLowerCase()} match your search` : `No ${config.title.toLowerCase()} found`}
            </Typography>
          </Paper>
        ) : (
          <List disablePadding>
            {filteredNodes.map((node, index) => (
              <React.Fragment key={node.id}>
                {index > 0 && <Divider />}
                <ListItem
                  sx={{
                    px: 2,
                    py: 1.5,
                    cursor: onNodeSelect ? 'pointer' : 'default',
                    '&:hover': onNodeSelect ? { bgcolor: 'action.hover' } : {},
                    borderRadius: 1,
                  }}
                  onClick={() => onNodeSelect?.(node.id)}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    <Code fontSize="small" color="action" />
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="body1" fontWeight={500}>
                          {node.name}
                        </Typography>
                        {getImplementationStatus(node)}
                      </Stack>
                    }
                    secondary={
                      <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {node.source?.file || 'Unknown file'}
                        </Typography>
                        {getMethodCount(node) > 0 && (
                          <Typography variant="caption" color="text.secondary">
                            {getMethodCount(node)} methods
                          </Typography>
                        )}
                        {node.documentation?.summary && (
                          <Typography variant="caption" color="text.secondary">
                            {node.documentation.summary}
                          </Typography>
                        )}
                      </Stack>
                    }
                  />
                </ListItem>
              </React.Fragment>
            ))}
          </List>
        )}
      </Box>
    </Box>
  );
};

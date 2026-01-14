import React from 'react';
import { Box, Card, CardContent, Typography, Chip, Stack, Tooltip } from '@mui/material';
import {
  Code,
  Settings,
  Storage,
  Api,
  Widgets,
  FolderOpen,
  Functions,
  Class,
  ViewModule,
  DataObject,
} from '@mui/icons-material';
import { CASNode } from '../types';

export interface NodeCardProps {
  node: CASNode;
  selected?: boolean;
  highlighted?: boolean;
  dimmed?: boolean;
  compact?: boolean;
  onClick?: (node: CASNode) => void;
  onDoubleClick?: (node: CASNode) => void;
  style?: React.CSSProperties;
}

const TYPE_COLORS: Record<string, string> = {
  controller: '#4caf50',
  service: '#2196f3',
  repository: '#9c27b0',
  module: '#ff9800',
  class: '#607d8b',
  function: '#00bcd4',
  method: '#03a9f4',
  interface: '#8bc34a',
  type: '#cddc39',
  enum: '#ffc107',
  variable: '#795548',
  component: '#e91e63',
  hook: '#673ab7',
  context: '#3f51b5',
  entity: '#f44336',
  dto: '#009688',
  guard: '#ff5722',
  pipe: '#9e9e9e',
  interceptor: '#ffeb3b',
  middleware: '#00bcd4',
  decorator: '#e040fb',
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  controller: <Api fontSize="small" />,
  service: <Settings fontSize="small" />,
  repository: <Storage fontSize="small" />,
  module: <ViewModule fontSize="small" />,
  class: <Class fontSize="small" />,
  function: <Functions fontSize="small" />,
  method: <Functions fontSize="small" />,
  interface: <DataObject fontSize="small" />,
  component: <Widgets fontSize="small" />,
  entity: <Storage fontSize="small" />,
  file: <FolderOpen fontSize="small" />,
};

export const NodeCard: React.FC<NodeCardProps> = ({
  node,
  selected = false,
  highlighted = false,
  dimmed = false,
  compact = false,
  onClick,
  onDoubleClick,
  style,
}) => {
  const typeColor = TYPE_COLORS[node.type] || '#757575';
  const typeIcon = TYPE_ICONS[node.type] || <Code fontSize="small" />;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(node);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick?.(node);
  };

  const isEntryPoint = node.tags?.includes('entry-point') || node.type === 'controller';
  const isExitPoint = node.tags?.includes('exit-point') || node.type === 'repository';

  if (compact) {
    return (
      <Tooltip title={`${node.name} (${node.type})`} placement="top">
        <Box
          data-component="node-card"
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            py: 0.5,
            borderRadius: 1,
            bgcolor: selected ? 'primary.main' : 'background.paper',
            color: selected ? 'primary.contrastText' : 'text.primary',
            border: 1,
            borderColor: highlighted ? 'warning.main' : selected ? 'primary.main' : 'divider',
            opacity: dimmed ? 0.5 : 1,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            '&:hover': {
              transform: 'scale(1.02)',
              boxShadow: 2,
            },
            ...style,
          }}
        >
          <Box sx={{ color: typeColor }}>{typeIcon}</Box>
          <Typography variant="caption" noWrap sx={{ maxWidth: 100 }}>
            {node.name}
          </Typography>
        </Box>
      </Tooltip>
    );
  }

  return (
    <Card
      data-component="node-card"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      sx={{
        minWidth: 180,
        maxWidth: 240,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        opacity: dimmed ? 0.5 : 1,
        border: 2,
        borderColor: selected
          ? 'primary.main'
          : highlighted
          ? 'warning.main'
          : 'transparent',
        boxShadow: selected ? 4 : 1,
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: 3,
        },
        ...style,
      }}
    >
      <Box
        sx={{
          height: 4,
          bgcolor: typeColor,
        }}
      />
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ color: typeColor }}>{typeIcon}</Box>
            <Typography variant="subtitle2" fontWeight={600} noWrap>
              {node.name}
            </Typography>
          </Stack>

          <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ gap: 0.5 }}>
            <Chip
              label={node.type}
              size="small"
              sx={{
                bgcolor: `${typeColor}20`,
                color: typeColor,
                fontWeight: 500,
                height: 20,
                '& .MuiChip-label': { px: 1, fontSize: '0.7rem' },
              }}
            />
            {isEntryPoint && (
              <Chip
                label="ENTRY"
                size="small"
                color="success"
                variant="outlined"
                sx={{ height: 20, '& .MuiChip-label': { px: 0.5, fontSize: '0.65rem' } }}
              />
            )}
            {isExitPoint && (
              <Chip
                label="EXIT"
                size="small"
                color="error"
                variant="outlined"
                sx={{ height: 20, '& .MuiChip-label': { px: 0.5, fontSize: '0.65rem' } }}
              />
            )}
          </Stack>

          {node.source && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {node.source.file.split('/').pop()}:{node.source.line}
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
};

export function getNodeColor(type: string): string {
  return TYPE_COLORS[type] || '#757575';
}

export function getNodeIcon(type: string): React.ReactNode {
  return TYPE_ICONS[type] || <Code fontSize="small" />;
}

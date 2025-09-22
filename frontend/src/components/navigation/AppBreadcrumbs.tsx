import React from 'react';
import {
  Breadcrumbs,
  Link,
  Typography,
  Box,
  Chip,
} from '@mui/material';
import {
  Home as HomeIcon,
  ChevronRight as ChevronRightIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  Code as CodeIcon,
  Analytics as AnalyticsIcon,
} from '@mui/icons-material';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Workspace, Codebase } from '../../types/workspace.types';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  icon?: React.ReactNode;
  isActive?: boolean;
  metadata?: React.ReactNode;
}

interface AppBreadcrumbsProps {
  items?: BreadcrumbItem[];
  currentWorkspace?: Workspace;
  currentCodebase?: Codebase;
  showWorkspaceInfo?: boolean;
  maxItems?: number;
}

export function AppBreadcrumbs({
  items = [],
  currentWorkspace,
  currentCodebase,
  showWorkspaceInfo = true,
  maxItems = 8,
}: AppBreadcrumbsProps) {
  const { currentWorkspace: contextWorkspace } = useWorkspace();
  const workspace = currentWorkspace || contextWorkspace;

  // Build breadcrumb items
  const breadcrumbItems: BreadcrumbItem[] = [
    {
      label: 'Home',
      href: '/',
      icon: <HomeIcon sx={{ mr: 0.5 }} fontSize="inherit" />,
    },
  ];

  // Add workspace
  if (workspace) {
    breadcrumbItems.push({
      label: workspace.name,
      href: `/workspace/${workspace.id}`,
      icon: workspace.ownerType === 'organization' ? (
        <BusinessIcon sx={{ mr: 0.5 }} fontSize="inherit" />
      ) : (
        <PersonIcon sx={{ mr: 0.5 }} fontSize="inherit" />
      ),
      metadata: showWorkspaceInfo && (
        <Chip
          label={workspace.ownerType}
          size="small"
          variant="outlined"
          sx={{ ml: 1, height: 20 }}
        />
      ),
    });
  }

  // Add codebase
  if (currentCodebase && workspace) {
    breadcrumbItems.push({
      label: currentCodebase.name,
      href: `/workspace/${workspace.id}/codebase/${currentCodebase.id}`,
      icon: <CodeIcon sx={{ mr: 0.5 }} fontSize="inherit" />,
      metadata: (
        <Chip
          label={currentCodebase.status}
          size="small"
          color={getStatusColor(currentCodebase.status)}
          sx={{ ml: 1, height: 20 }}
        />
      ),
    });
  }

  // Add custom items
  breadcrumbItems.push(...items);

  // Limit items if needed
  const displayItems = breadcrumbItems.length > maxItems
    ? [
        breadcrumbItems[0],
        { label: '...', isActive: false },
        ...breadcrumbItems.slice(-maxItems + 2),
      ]
    : breadcrumbItems;

  return (
    <Breadcrumbs
      separator={<ChevronRightIcon fontSize="small" />}
      maxItems={maxItems}
      sx={{
        '& .MuiBreadcrumbs-ol': {
          alignItems: 'center',
        },
        '& .MuiBreadcrumbs-li': {
          display: 'flex',
          alignItems: 'center',
        },
      }}
    >
      {displayItems.map((item, index) => {
        const isLast = index === displayItems.length - 1;
        const isActive = item.isActive !== false && (isLast || item.isActive);

        if (item.label === '...') {
          return (
            <Typography key="ellipsis" color="text.secondary">
              ...
            </Typography>
          );
        }

        const content = (
          <Box display="flex" alignItems="center">
            {item.icon}
            {item.label}
            {item.metadata}
          </Box>
        );

        if (isActive || !item.href) {
          return (
            <Typography
              key={item.label}
              color={isActive ? 'text.primary' : 'text.secondary'}
              sx={{
                display: 'flex',
                alignItems: 'center',
                fontWeight: isActive ? 'medium' : 'normal',
              }}
            >
              {content}
            </Typography>
          );
        }

        return (
          <Link
            key={item.label}
            color="inherit"
            href={item.href}
            sx={{
              display: 'flex',
              alignItems: 'center',
              textDecoration: 'none',
              '&:hover': {
                textDecoration: 'underline',
              },
            }}
          >
            {content}
          </Link>
        );
      })}
    </Breadcrumbs>
  );
}

function getStatusColor(status: string) {
  switch (status) {
    case 'completed':
      return 'success' as const;
    case 'analyzing':
      return 'info' as const;
    case 'failed':
      return 'error' as const;
    case 'pending':
      return 'warning' as const;
    default:
      return 'default' as const;
  }
}

// Pre-built breadcrumb configurations for common pages
export const WorkspaceBreadcrumbs = () => (
  <AppBreadcrumbs />
);

export const CodebasesBreadcrumbs = () => (
  <AppBreadcrumbs
    items={[
      {
        label: 'Codebases',
        isActive: true,
      },
    ]}
  />
);

export const CodebaseDetailBreadcrumbs = ({ codebase }: { codebase: Codebase }) => (
  <AppBreadcrumbs
    currentCodebase={codebase}
    items={[
      {
        label: 'Analysis',
        icon: <AnalyticsIcon sx={{ mr: 0.5 }} fontSize="inherit" />,
        isActive: true,
      },
    ]}
  />
);

export const SettingsBreadcrumbs = () => (
  <AppBreadcrumbs
    items={[
      {
        label: 'Settings',
        isActive: true,
      },
    ]}
  />
);
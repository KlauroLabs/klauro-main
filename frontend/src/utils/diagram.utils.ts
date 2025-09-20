import React from 'react';
import {
  Architecture,
  Code,
  Functions as FunctionIcon,
  Storage,
  Settings,
  Api as ApiIcon
} from '@mui/icons-material';

export const formatTypeLabel = (type: string): string => {
  const labels: Record<string, string> = {
    'controller': 'Controllers',
    'service': 'Services',
    'repository': 'Repositories',
    'entity': 'Entities',
    'function': 'Functions',
    'class': 'Classes',
    'interface': 'Interfaces',
    'module': 'Modules',
    'component': 'Components',
    'decorator': 'Decorators',
    'middleware': 'Middleware'
  };
  return labels[type] || type.charAt(0).toUpperCase() + type.slice(1);
};

export const getTypeIcon = (type: string): React.ReactNode => {
  const iconMap: Record<string, () => React.ReactNode> = {
    'controller': () => React.createElement(ApiIcon, { fontSize: "small" }),
    'service': () => React.createElement(Settings, { fontSize: "small" }),
    'repository': () => React.createElement(Storage, { fontSize: "small" }),
    'entity': () => React.createElement(Architecture, { fontSize: "small" }),
    'function': () => React.createElement(FunctionIcon, { fontSize: "small" }),
    'class': () => React.createElement(Code, { fontSize: "small" }),
    'interface': () => React.createElement(Code, { fontSize: "small" }),
    'module': () => React.createElement(Architecture, { fontSize: "small" }),
    'component': () => React.createElement(Architecture, { fontSize: "small" }),
    'decorator': () => React.createElement(Settings, { fontSize: "small" }),
    'middleware': () => React.createElement(Settings, { fontSize: "small" })
  };
  const iconFn = iconMap[type] || (() => React.createElement(Code, { fontSize: "small" }));
  return iconFn();
};

export const getTypeColor = (type: string): string => {
  const colors: Record<string, string> = {
    'controller': '#8b5cf6',
    'service': '#10b981',
    'repository': '#f59e0b',
    'entity': '#ef4444',
    'function': '#84cc16',
    'class': '#ec4899',
    'interface': '#06b6d4',
    'module': '#6b7280',
    'component': '#3b82f6',
    'decorator': '#f97316',
    'middleware': '#8b5cf6'
  };
  return colors[type] || '#6b7280';
};
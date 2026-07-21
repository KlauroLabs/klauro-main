import { alpha } from '@mui/material/styles';
import type { ThemeOptions } from '@mui/material/styles';
import { interactiveAccent } from '../colors';

export const MuiList: NonNullable<ThemeOptions['components']>['MuiList'] = {
  styleOverrides: {
    root: { padding: 0 },
  },
};

export const MuiListItemButton: NonNullable<ThemeOptions['components']>['MuiListItemButton'] = {
  styleOverrides: {
    root: {
      borderRadius: 6,
      '&.Mui-selected': {
        backgroundColor: alpha(interactiveAccent, 0.12),
        color: interactiveAccent,
        '&:hover': { backgroundColor: alpha(interactiveAccent, 0.18) },
      },
    },
  },
};

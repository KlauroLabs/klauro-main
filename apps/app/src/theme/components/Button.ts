import type { ThemeOptions } from '@mui/material/styles';
import { surface, construction } from '../colors';

export const MuiCard: NonNullable<ThemeOptions['components']>['MuiCard'] = {
  defaultProps: { elevation: 0, variant: 'outlined' },
  styleOverrides: {
    root: {
      backgroundColor: surface,
      border: `1px solid ${construction}`,
      boxShadow: 'none',
    },
  },
};

export const MuiButton: NonNullable<ThemeOptions['components']>['MuiButton'] = {
  defaultProps: { disableElevation: true },
  styleOverrides: {
    root: { borderRadius: 8, boxShadow: 'none' },
    outlined: { borderColor: construction },
  },
};

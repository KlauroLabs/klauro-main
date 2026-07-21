import type { ThemeOptions } from '@mui/material/styles';
import { surface, construction, canvas, textPrimary } from '../colors';

export const MuiCssBaseline: NonNullable<ThemeOptions['components']>['MuiCssBaseline'] = {
  styleOverrides: {
    body: { backgroundColor: canvas, color: textPrimary },
  },
};

export const MuiPaper: NonNullable<ThemeOptions['components']>['MuiPaper'] = {
  defaultProps: { elevation: 0 },
  styleOverrides: {
    root: {
      backgroundColor: surface,
      backgroundImage: 'none',
      border: `1px solid ${construction}`,
      boxShadow: 'none',
    },
  },
};

import type { ThemeOptions } from '@mui/material/styles';
import { foundation, construction } from '../colors';

export const MuiDrawer: NonNullable<ThemeOptions['components']>['MuiDrawer'] = {
  styleOverrides: {
    paper: { backgroundColor: foundation, borderRight: `1px solid ${construction}` },
  },
};

export const MuiAppBar: NonNullable<ThemeOptions['components']>['MuiAppBar'] = {
  defaultProps: { elevation: 0, color: 'transparent' },
  styleOverrides: {
    root: { backgroundColor: foundation, borderBottom: `1px solid ${construction}`, boxShadow: 'none' },
  },
};

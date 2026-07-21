import type { ThemeOptions } from '@mui/material/styles';
import { interactiveAccent } from '../colors';

export const MuiTabs: NonNullable<ThemeOptions['components']>['MuiTabs'] = {
  styleOverrides: {
    indicator: { backgroundColor: interactiveAccent, height: 2 },
  },
};

export const MuiTab: NonNullable<ThemeOptions['components']>['MuiTab'] = {
  styleOverrides: {
    root: { textTransform: 'none', fontFamily: 'Urbanist', fontWeight: 500, minWidth: 'auto' },
  },
};

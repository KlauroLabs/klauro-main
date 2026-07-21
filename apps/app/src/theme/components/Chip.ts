import type { ThemeOptions } from '@mui/material/styles';
import { construction } from '../colors';

export const MuiChip: NonNullable<ThemeOptions['components']>['MuiChip'] = {
  styleOverrides: {
    root: {
      borderRadius: 6,
      border: `1px solid ${construction}`,
      backgroundColor: 'transparent',
      fontFamily: 'Urbanist',
      fontWeight: 500,
    },
  },
};

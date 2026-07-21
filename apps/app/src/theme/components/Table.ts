import type { ThemeOptions } from '@mui/material/styles';
import { construction, secondaryText } from '../colors';

export const MuiTableCell: NonNullable<ThemeOptions['components']>['MuiTableCell'] = {
  styleOverrides: {
    root: { borderBottom: `1px solid ${construction}` },
    head: { color: secondaryText, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 },
  },
};

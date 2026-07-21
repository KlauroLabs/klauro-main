import type { ThemeOptions } from '@mui/material/styles';
import { surface, overcardStroke, textPrimary } from '../colors';

export const MuiTooltip: NonNullable<ThemeOptions['components']>['MuiTooltip'] = {
  styleOverrides: {
    tooltip: { backgroundColor: surface, border: `1px solid ${overcardStroke}`, color: textPrimary, fontSize: 12 },
  },
};

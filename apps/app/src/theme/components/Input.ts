import type { ThemeOptions } from '@mui/material/styles';
import { inputBorder, divider } from '../colors';

export const MuiOutlinedInput: NonNullable<ThemeOptions['components']>['MuiOutlinedInput'] = {
  styleOverrides: {
    root: {
      '& .MuiOutlinedInput-notchedOutline': { borderColor: inputBorder },
    },
  },
};

export const MuiDivider: NonNullable<ThemeOptions['components']>['MuiDivider'] = {
  styleOverrides: {
    root: { borderColor: divider },
  },
};

import type { ThemeOptions } from '@mui/material/styles';
import { canvas, surface, interactiveAccent, criticalAccent, textPrimary, secondaryText, tertiaryText, construction } from './colors';

export const palette: ThemeOptions['palette'] = {
  mode: 'dark',
  background: { default: canvas, paper: surface },
  primary: { main: interactiveAccent, contrastText: '#0B0C10' },
  error: { main: criticalAccent },
  text: { primary: textPrimary, secondary: secondaryText, disabled: tertiaryText },
  divider: construction,
};

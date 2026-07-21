import { createTheme } from '@mui/material/styles';
import { palette } from './palette';
import { typography } from './typography';
import { components } from './components';

export const theme = createTheme({
  spacing: 8,
  shape: { borderRadius: 8 },
  palette,
  typography,
  components,
});

export { tokens } from './colors';

export default theme;

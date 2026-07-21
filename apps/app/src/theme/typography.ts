import type { ThemeOptions } from '@mui/material/styles';

export const typography: ThemeOptions['typography'] = {
  fontFamily: 'Urbanist, Inter, system-ui, sans-serif',
  h1: { fontFamily: 'Urbanist', fontWeight: 700, fontSize: 32, lineHeight: '40px' },
  h2: { fontFamily: 'Urbanist', fontWeight: 600, fontSize: 24, lineHeight: '32px' },
  h3: { fontFamily: 'Urbanist', fontWeight: 600, fontSize: 20, lineHeight: '28px' },
  h4: { fontFamily: 'Urbanist', fontWeight: 700, fontSize: 32, lineHeight: '40px' },
  subtitle1: { fontFamily: 'Urbanist', fontWeight: 500, fontSize: 14, lineHeight: '22px' },
  subtitle2: { fontFamily: 'Urbanist', fontWeight: 500, fontSize: 14, lineHeight: '22px' },
  body1: { fontFamily: 'Urbanist', fontWeight: 400, fontSize: 14, lineHeight: '24px' },
  body2: { fontFamily: 'Urbanist', fontWeight: 400, fontSize: 14, lineHeight: '22px' },
  caption: { fontFamily: 'Urbanist', fontWeight: 500, fontSize: 12, lineHeight: '18px' },
  overline: { fontFamily: 'Inter', fontWeight: 500, fontSize: 12, lineHeight: '18px', textTransform: 'none' },
  button: { fontFamily: 'Urbanist', fontWeight: 600, textTransform: 'none' },
};

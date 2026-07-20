// Klauro dark MUI theme. Single source of styling truth per LANE-COMMON.md
// ("ALL styling via the central theme — component defaults + variants via
// theme overrides. sx allowed only for a truly unique one-off; never inline
// style=; no new CSS files"). Values reconciled in apps/app/docs/DESIGN-TOKENS.md
// (LANE-COMMON's binding design-language colors + Figma-observed typography/
// spacing; documented conflicts noted there, not silently resolved here).
import { createTheme, alpha } from '@mui/material/styles';

// ---- Design-language color tokens (see DESIGN-TOKENS.md) -----------------
const foundation = '#13141B'; // sidebar/topbar background
const canvas = '#191A22'; // page/canvas background
const surface = '#20212A'; // Card/Paper background
const construction = '#2A2B36'; // default 1px border
const divider = '#32333E'; // in-card separators (Figma-observed)
const overcardStroke = '#45455A'; // hover/emphasis border state
const inputBorder = '#383952'; // text field border
const wireframe = '#B7BCC7'; // primary icon stroke
const tertiaryText = '#5C6080'; // muted/tertiary text (Figma-observed)
const secondaryText = '#9BA3C0'; // secondary/supporting text (Figma-observed)
const textPrimary = '#F5F5F5'; // primary text (design-language binding value)
// Accent conflict (see DESIGN-TOKENS.md "Conflicts"): the Figma file's actual
// interactive accent is teal (#72b8c5), wired here as palette.primary; the
// design-language doc's #E6414B red is wired as palette.error (its natural
// semantic home — critical/destructive signal).
const interactiveAccent = '#72B8C5';
const criticalAccent = '#E6414B';

export const theme = createTheme({
  spacing: 8,
  shape: { borderRadius: 8 },
  palette: {
    mode: 'dark',
    background: { default: canvas, paper: surface },
    primary: { main: interactiveAccent, contrastText: '#0B0C10' },
    error: { main: criticalAccent },
    text: { primary: textPrimary, secondary: secondaryText, disabled: tertiaryText },
    divider: construction,
  },
  typography: {
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
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: canvas, color: textPrimary },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: surface,
          backgroundImage: 'none',
          border: `1px solid ${construction}`,
          boxShadow: 'none',
        },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0, variant: 'outlined' },
      styleOverrides: {
        root: {
          backgroundColor: surface,
          border: `1px solid ${construction}`,
          boxShadow: 'none',
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 8, boxShadow: 'none' },
        outlined: { borderColor: construction },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          border: `1px solid ${construction}`,
          backgroundColor: 'transparent',
          fontFamily: 'Urbanist',
          fontWeight: 500,
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderBottom: `1px solid ${construction}` },
        head: { color: secondaryText, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: { backgroundColor: interactiveAccent, height: 2 },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: { textTransform: 'none', fontFamily: 'Urbanist', fontWeight: 500, minWidth: 'auto' },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: { backgroundColor: foundation, borderRight: `1px solid ${construction}` },
      },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'transparent' },
      styleOverrides: {
        root: { backgroundColor: foundation, borderBottom: `1px solid ${construction}`, boxShadow: 'none' },
      },
    },
    MuiList: {
      styleOverrides: {
        root: { padding: 0 },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          '&.Mui-selected': {
            backgroundColor: alpha(interactiveAccent, 0.12),
            color: interactiveAccent,
            '&:hover': { backgroundColor: alpha(interactiveAccent, 0.18) },
          },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: surface, border: `1px solid ${overcardStroke}`, color: textPrimary, fontSize: 12 },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-notchedOutline': { borderColor: inputBorder },
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: divider },
      },
    },
  },
});

// Exposed for components that need a raw token outside the theme object
// (e.g. SVG icon strokes, which take a `stroke` prop rather than an sx
// color) — see LANE-COMMON's geometry system ("icons are engineered
// symbols, outlined, consistent stroke").
export const tokens = {
  foundation,
  canvas,
  surface,
  construction,
  divider,
  overcardStroke,
  inputBorder,
  wireframe,
  tertiaryText,
  secondaryText,
  textPrimary,
  interactiveAccent,
  criticalAccent,
};

export default theme;

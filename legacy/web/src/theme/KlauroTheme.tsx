import React, { createContext, useContext, ReactNode } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { designTokens } from './tokens';

interface KlauroThemeContextType {
  tokens: typeof designTokens;
  setTimeOfDay: (time: 'day' | 'evening' | 'night') => void;
}

const KlauroThemeContext = createContext<KlauroThemeContextType | undefined>(undefined);

export const useKlauroTheme = () => {
  const context = useContext(KlauroThemeContext);
  if (!context) {
    throw new Error('useKlauroTheme must be used within KlauroThemeProvider');
  }
  return context;
};

interface KlauroThemeProviderProps {
  children: ReactNode;
  timeOfDay?: 'day' | 'evening' | 'night';
}

export const KlauroThemeProvider: React.FC<KlauroThemeProviderProps> = ({ 
  children, 
  timeOfDay = 'day' 
}) => {
  const [currentTimeOfDay, setCurrentTimeOfDay] = React.useState(timeOfDay);

  const muiTheme = createTheme({
    palette: {
      mode: 'dark',
      primary: {
        main: '#e91e63',
        light: '#f8bbd9',
        dark: '#c2185b',
      },
      secondary: {
        main: '#2196f3',
        light: '#90caf9',
        dark: '#1565c0',
      },
      background: {
        default: '#0a0a0a',
        paper: 'rgba(0, 0, 0, 0.8)',
      },
      text: {
        primary: designTokens.ui.text.primary,
        secondary: designTokens.ui.text.secondary,
      },
      action: {
        hover: designTokens.ui.interactive.hover,
        selected: designTokens.ui.interactive.selected,
      },
      success: {
        main: '#4caf50',
      },
      warning: {
        main: '#ff9800',
      },
      error: {
        main: '#f44336',
      },
      info: {
        main: '#2196f3',
      },
    },
    typography: {
      fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
      h1: {
        fontSize: designTokens.typography.ui.title,
        fontWeight: 600,
        color: designTokens.ui.text.primary,
      },
      h2: {
        fontSize: designTokens.typography.ui.subtitle,
        fontWeight: 500,
        color: designTokens.ui.text.primary,
      },
      body1: {
        fontSize: designTokens.typography.ui.body,
        color: designTokens.ui.text.secondary,
      },
      body2: {
        fontSize: designTokens.typography.ui.caption,
        color: designTokens.ui.text.muted,
      },
      caption: {
        fontSize: designTokens.typography.ui.micro,
        color: designTokens.ui.text.muted,
      },
    },
    shape: {
      borderRadius: 8,
    },
    components: {
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            backgroundColor: designTokens.ui.panels.primary,
            backdropFilter: designTokens.ui.panels.backdrop,
            border: `1px solid ${designTokens.ui.panels.border}`,
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            borderRadius: 6,
            transition: `all ${designTokens.animation.durations.standard}s ${designTokens.animation.easing.standard}`,
          },
          contained: {
            boxShadow: 'none',
            '&:hover': {
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            transition: `all ${designTokens.animation.durations.fast}s ${designTokens.animation.easing.standard}`,
            '&:hover': {
              backgroundColor: designTokens.ui.interactive.hover,
              transform: 'scale(1.05)',
            },
          },
        },
      },
      MuiFab: {
        styleOverrides: {
          root: {
            backdropFilter: 'blur(10px)',
            transition: `all ${designTokens.animation.durations.standard}s ${designTokens.animation.easing.bounce}`,
            '&:hover': {
              transform: 'scale(1.1)',
            },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            border: `1px solid ${designTokens.ui.panels.border}`,
            color: designTokens.ui.text.secondary,
            '&.Mui-selected': {
              backgroundColor: designTokens.ui.interactive.selected,
              color: '#000000',
              '&:hover': {
                backgroundColor: designTokens.ui.interactive.selected,
              },
            },
          },
        },
      },
      MuiSlider: {
        styleOverrides: {
          root: {
            color: '#2196f3',
          },
          thumb: {
            transition: `all ${designTokens.animation.durations.fast}s ${designTokens.animation.easing.standard}`,
            '&:hover': {
              transform: 'scale(1.2)',
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: designTokens.ui.panels.secondary,
            backdropFilter: designTokens.ui.panels.backdrop,
            border: `1px solid ${designTokens.ui.panels.border}`,
            fontSize: designTokens.typography.ui.caption,
          },
        },
      },
    },
  });

  const setTimeOfDay = (time: 'day' | 'evening' | 'night') => {
    setCurrentTimeOfDay(time);
  };

  const contextValue: KlauroThemeContextType = {
    tokens: designTokens,
    setTimeOfDay,
  };

  return (
    <KlauroThemeContext.Provider value={contextValue}>
      <ThemeProvider theme={muiTheme}>
        <CssBaseline />
        <style jsx global>{`
          body {
            margin: 0;
            padding: 0;
            font-family: 'Inter', 'Roboto', 'Helvetica', 'Arial', sans-serif;
            background: #0a0a0a;
            overflow: hidden;
          }
          
          * {
            box-sizing: border-box;
          }
          
          /* Custom scrollbars for Klauro theme */
          ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
          }
          
          ::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
          }
          
          ::-webkit-scrollbar-thumb {
            background: #2196f3;
            border-radius: 4px;
            transition: background ${designTokens.animation.durations.fast}s;
          }
          
          ::-webkit-scrollbar-thumb:hover {
            background: #90caf9;
          }
          
          /* Selection styling */
          ::selection {
            background: ${designTokens.ui.interactive.selected};
            color: #000000;
          }
          
          /* Smooth transitions for interactive elements */
          button, a, [role="button"] {
            transition: all ${designTokens.animation.durations.fast}s ${designTokens.animation.easing.standard};
          }
          
          /* Focus indicators for accessibility */
          *:focus-visible {
            outline: 2px solid ${designTokens.ui.interactive.focus};
            outline-offset: 2px;
          }
          
          /* Canvas optimization */
          canvas {
            display: block;
            outline: none;
          }
          
          /* Loading animations */
          @keyframes pulse {
            0% { opacity: 0.5; transform: scale(1); }
            50% { opacity: 1; transform: scale(1.05); }
            100% { opacity: 0.5; transform: scale(1); }
          }
          
          @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
          }
          
          @keyframes glow {
            0%, 100% { 
              box-shadow: 0 0 5px currentColor;
              filter: brightness(1);
            }
            50% { 
              box-shadow: 0 0 20px currentColor;
              filter: brightness(1.2);
            }
          }
          
          /* Utility classes for visualization components */
          .viz-glow {
            animation: glow 2s ease-in-out infinite;
          }
          
          .viz-float {
            animation: float 3s ease-in-out infinite;
          }
          
          .viz-pulse {
            animation: pulse 1.5s ease-in-out infinite;
          }
          
          /* High contrast mode support */
          @media (prefers-contrast: high) {
            * {
              border-color: white !important;
              background: black !important;
              color: white !important;
            }
          }
          
          /* Reduced motion support */
          @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
              animation-duration: 0.01ms !important;
              animation-iteration-count: 1 !important;
              transition-duration: 0.01ms !important;
            }
          }
        `}</style>
        {children}
      </ThemeProvider>
    </KlauroThemeContext.Provider>
  );
};

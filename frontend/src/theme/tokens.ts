export const designTokens = {
  colors: {
    primary: {
      50: '#f0f9ff',
      100: '#e0f2fe',
      200: '#bae6fd',
      300: '#7dd3fc',
      400: '#38bdf8',
      500: '#0ea5e9',
      600: '#0284c7',
      700: '#0369a1',
      800: '#075985',
      900: '#0c4a6e',
    },
    secondary: {
      50: '#f8fafc',
      100: '#f1f5f9',
      200: '#e2e8f0',
      300: '#cbd5e1',
      400: '#94a3b8',
      500: '#64748b',
      600: '#475569',
      700: '#334155',
      800: '#1e293b',
      900: '#0f172a',
    },
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#3b82f6',

    componentTypes: {
      component: '#3b82f6',
      service: '#10b981',
      controller: '#8b5cf6',
      repository: '#f59e0b',
      entity: '#ef4444',
      module: '#6b7280',
      interface: '#06b6d4',
      class: '#ec4899',
      function: '#84cc16',
      constant: '#eab308',
    },

    connectionTypes: {
      imports: '#3b82f6',
      calls: '#10b981',
      extends: '#8b5cf6',
      implements: '#f59e0b',
      uses: '#06b6d4',
      configures: '#ec4899',
    },

    activity: {
      critical: '#ef4444',
      high: '#f97316',
      medium: '#f59e0b',
      low: '#84cc16',
      idle: '#9ca3af',
    },

    background: {
      primary: '#ffffff',
      secondary: '#f9fafb',
      tertiary: '#f3f4f6',
      overlay: 'rgba(0, 0, 0, 0.5)',
    },

    text: {
      primary: '#111827',
      secondary: '#6b7280',
      tertiary: '#9ca3af',
      inverse: '#ffffff',
    },

    border: {
      default: '#e5e7eb',
      focus: '#3b82f6',
      error: '#ef4444',
    },
  },

  spacing: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
    '2xl': '3rem',
    '3xl': '4rem',
    '4xl': '6rem',
  },

  typography: {
    fontFamily: {
      sans: ['Inter', 'system-ui', 'sans-serif'],
      mono: ['JetBrains Mono', 'Consolas', 'monospace'],
    },
    fontSize: {
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
      '2xl': '1.5rem',
      '3xl': '1.875rem',
      '4xl': '2.25rem',
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    lineHeight: {
      none: 1,
      tight: 1.25,
      snug: 1.375,
      normal: 1.5,
      relaxed: 1.625,
      loose: 2,
    },
    ui: {
      title: '2rem',
      subtitle: '1.5rem',
      body: '1rem',
      caption: '0.875rem',
      micro: '0.75rem',
    },
  },

  borderRadius: {
    none: '0',
    sm: '0.125rem',
    md: '0.375rem',
    lg: '0.5rem',
    xl: '0.75rem',
    '2xl': '1rem',
    full: '9999px',
  },

  shadow: {
    xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    sm: '0 1px 3px 0 rgb(0 0 0 / 0.1)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    xl: '0 20px 25px -5px rgb(0 0 0 / 0.1)',
    '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
    none: '0 0 #0000',
  },

  animation: {
    duration: {
      fast: '150ms',
      normal: '300ms',
      slow: '500ms',
      slower: '1000ms',
    },
    durations: {
      fast: 0.15,
      standard: 0.3,
      slow: 0.5,
    },
    easing: {
      linear: 'linear',
      easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
      easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
      easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
      standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
      bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
    },
  },

  visualization: {
    node: {
      minSize: 24,
      maxSize: 96,
      defaultSize: 48,
      borderWidth: 2,
      selectedBorderWidth: 3,
      padding: '0.5rem',
    },

    connection: {
      width: {
        weak: 1,
        normal: 2,
        strong: 3,
      },
      opacity: {
        inactive: 0.3,
        normal: 0.6,
        active: 1,
      },
    },

    card: {
      width: '320px',
      maxWidth: '480px',
      minHeight: '180px',
      padding: '1rem',
      gap: '1rem',
    },

    graph: {
      nodeSpacing: 100,
      levelSpacing: 150,
      clusterPadding: 50,
    },

    hierarchyLevels: {
      system: {
        color: '#1e40af',
        label: 'System',
        scale: 1.5,
      },
      architectural: {
        color: '#7c3aed',
        label: 'Architectural',
        scale: 1.2,
      },
      code: {
        color: '#059669',
        label: 'Code',
        scale: 1.0,
      },
      member: {
        color: '#dc2626',
        label: 'Member',
        scale: 0.8,
      },
    },
  },

  zIndex: {
    background: -1,
    base: 0,
    card: 10,
    dropdown: 1000,
    overlay: 1100,
    modal: 1200,
    popover: 1300,
    tooltip: 1400,
    toast: 1500,
  },

  breakpoints: {
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px',
  },

  ui: {
    text: {
      primary: '#ffffff',
      secondary: '#9ca3af',
      muted: '#6b7280',
    },
    interactive: {
      hover: 'rgba(255, 255, 255, 0.08)',
      selected: 'rgba(255, 255, 255, 0.12)',
      focus: '#3b82f6',
    },
    panels: {
      primary: 'rgba(17, 24, 39, 0.8)',
      secondary: 'rgba(31, 41, 55, 0.8)',
      backdrop: 'blur(10px)',
      border: 'rgba(255, 255, 255, 0.1)',
    },
    backgrounds: {
      sky: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      sunset: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
      night: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
    },
  },

} as const;

export type DesignTokens = typeof designTokens;
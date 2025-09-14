export const designTokens = {
  // Spatial Colors - Representing different architectural elements
  spatial: {
    // Building Materials
    glass: {
      primary: '#81d4fa',
      selected: '#4fc3f7',
      opacity: 0.7
    },
    concrete: {
      primary: '#90a4ae',
      selected: '#78909c',
      opacity: 0.8
    },
    steel: {
      primary: '#78909c',
      selected: '#607d8b',
      opacity: 0.9
    },
    brick: {
      primary: '#bcaaa4',
      selected: '#a1887f',
      opacity: 0.8
    },
    
    // Room Types
    screen: {
      primary: '#f48fb1',
      glow: '#e91e63',
      intensity: 0.3
    },
    component: {
      primary: '#64b5f6',
      glow: '#2196f3',
      intensity: 0.2
    },
    service: {
      primary: '#81c784',
      glow: '#4caf50',
      intensity: 0.4
    },
    database: {
      primary: '#ffab91',
      glow: '#ff5722',
      intensity: 0.5
    },
    api: {
      primary: '#80deea',
      glow: '#00bcd4',
      intensity: 0.3
    },
    function: {
      primary: '#d4b6d4',
      glow: '#9c27b0',
      intensity: 0.2
    },
    
    // Building Types
    module: {
      primary: '#ffcc80',
      accent: '#ff9800',
      district: '#fff3e0'
    },
    library: {
      primary: '#c8e6c9',
      accent: '#4caf50',
      district: '#f1f8e9'
    },
    
    // Traffic & Data Flow
    traffic: {
      request: '#4caf50',
      response: '#2196f3',
      event: '#ff9800',
      data: '#e91e63',
      high: '#f44336',
      medium: '#ff9800',
      low: '#4caf50'
    },
    
    // Activity Levels
    activity: {
      critical: '#f44336',
      high: '#ff5722',
      medium: '#ff9800',
      low: '#4caf50',
      idle: '#9e9e9e'
    },
    
    // Districts
    districts: {
      frontend: {
        primary: '#e91e63',
        secondary: '#f8bbd9',
        background: 'rgba(233, 30, 99, 0.1)'
      },
      backend: {
        primary: '#2196f3',
        secondary: '#90caf9',
        background: 'rgba(33, 150, 243, 0.1)'
      },
      database: {
        primary: '#ff5722',
        secondary: '#ffab91',
        background: 'rgba(255, 87, 34, 0.1)'
      },
      infrastructure: {
        primary: '#607d8b',
        secondary: '#b0bec5',
        background: 'rgba(96, 125, 139, 0.1)'
      }
    }
  },
  
  // UI Colors
  ui: {
    // Background gradients for immersive experience
    backgrounds: {
      sky: 'linear-gradient(180deg, #87CEEB 0%, #E0F6FF 50%, #C9E4F5 100%)',
      night: 'linear-gradient(180deg, #1a237e 0%, #283593 50%, #3f51b5 100%)',
      sunset: 'linear-gradient(180deg, #ff7043 0%, #ff8a65 50%, #ffab91 100%)'
    },
    
    // Control panels and overlays
    panels: {
      primary: 'rgba(0, 0, 0, 0.8)',
      secondary: 'rgba(0, 0, 0, 0.9)',
      backdrop: 'blur(10px)',
      border: 'rgba(255, 255, 255, 0.2)'
    },
    
    // Interactive elements
    interactive: {
      hover: 'rgba(255, 255, 255, 0.1)',
      active: 'rgba(255, 255, 255, 0.2)',
      selected: '#ffeb3b',
      focus: '#64b5f6'
    },
    
    // Text and labels
    text: {
      primary: '#ffffff',
      secondary: 'rgba(255, 255, 255, 0.7)',
      muted: 'rgba(255, 255, 255, 0.5)',
      outline: '#000000'
    }
  },
  
  // Spatial Dimensions
  dimensions: {
    // Standard building heights
    buildings: {
      small: 20,
      medium: 30,
      large: 40,
      tower: 60
    },
    
    // Room sizes
    rooms: {
      small: { width: 6, height: 8, depth: 6 },
      medium: { width: 10, height: 8, depth: 8 },
      large: { width: 15, height: 10, depth: 12 },
      hall: { width: 20, height: 12, depth: 15 }
    },
    
    // Hallway dimensions
    hallways: {
      narrow: 2,
      standard: 4,
      wide: 6,
      highway: 8,
      height: 6
    },
    
    // Vehicle sizes
    vehicles: {
      small: 0.3,
      standard: 0.5,
      large: 0.8,
      bulk: 1.2
    }
  },
  
  // Animation & Interaction
  animation: {
    // Timing
    durations: {
      fast: 0.15,
      standard: 0.3,
      slow: 0.6,
      crawl: 1.2
    },
    
    // Easing
    easing: {
      standard: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
      decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
      accelerate: 'cubic-bezier(0.4, 0.0, 1, 1)',
      bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)'
    },
    
    // Traffic flow speeds
    traffic: {
      request: 2.0,
      response: 1.8,
      event: 2.5,
      data: 1.5,
      bulk: 0.8
    }
  },
  
  // Typography
  typography: {
    // 3D Text sizes for spatial labels
    spatial: {
      building: 4,
      room: 2,
      detail: 1,
      minimap: 0.8
    },
    
    // UI Text sizes
    ui: {
      title: 24,
      subtitle: 18,
      body: 14,
      caption: 12,
      micro: 10
    }
  },
  
  // Lighting
  lighting: {
    // Ambient lighting
    ambient: {
      day: 0.4,
      evening: 0.2,
      night: 0.1
    },
    
    // Directional light
    directional: {
      intensity: 1,
      position: [50, 100, 50],
      shadowMapSize: [2048, 2048]
    },
    
    // Point lights for rooms and hallways
    point: {
      room: { intensity: 0.5, distance: 20 },
      hallway: { intensity: 0.3, distance: 15 },
      accent: { intensity: 0.8, distance: 10 }
    }
  },
  
  // Performance
  performance: {
    // LOD (Level of Detail) distances
    lod: {
      high: 50,    // Full detail within 50 units
      medium: 100, // Reduced detail 50-100 units
      low: 200     // Minimal detail beyond 100 units
    },
    
    // Rendering limits
    limits: {
      maxParticles: 100,
      maxVehicles: 50,
      maxLights: 20
    }
  }
} as const;

export type DesignTokens = typeof designTokens;
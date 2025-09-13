export const visualizationSecurityConfig = {
  rateLimit: {
    render: {
      points: 20,
      duration: 60,
      blockDuration: 60,
    },
    upload: {
      points: 10,
      duration: 60,
      blockDuration: 120,
    },
    export: {
      points: 5,
      duration: 60,
      blockDuration: 300,
    },
    telemetry: {
      points: 100,
      duration: 60,
      blockDuration: 60,
    },
    cacheClear: {
      points: 2,
      duration: 300,
      blockDuration: 600,
    },
    websocket: {
      points: 100,
      duration: 60,
      blockDuration: 60,
    },
  },
  
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 1,
    maxFields: 5,
    allowedMimeTypes: ['application/json', 'text/plain', 'application/x-yaml', 'text/yaml'],
    allowedExtensions: ['json', 'yaml', 'yml'],
  },
  
  export: {
    maxWidth: 10000,
    maxHeight: 10000,
    maxNodes: 5000,
    maxEdges: 10000,
    allowedFormats: ['svg', 'pdf', 'png'],
    sanitizeOptions: {
      allowedTags: [
        'svg', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
        'path', 'text', 'tspan', 'defs', 'clipPath', 'mask', 'pattern',
        'linearGradient', 'radialGradient', 'stop', 'filter', 'marker',
      ],
      forbiddenTags: ['script', 'iframe', 'object', 'embed', 'link'],
      forbiddenAttributes: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur'],
    },
  },
  
  validation: {
    maxBlueprintSize: 5 * 1024 * 1024, // 5MB JSON
    maxComponentNameLength: 255,
    maxConnectionLabelLength: 100,
    maxSearchQueryLength: 100,
    maxTitleLength: 255,
    maxWatermarkLength: 100,
  },
  
  websocket: {
    maxConnectionsPerUser: 10,
    maxSubscriptionsPerClient: 20,
    heartbeatInterval: 30000, // 30 seconds
    heartbeatTimeout: 60000, // 60 seconds
    metricsInterval: 10000, // 10 seconds
    maxMessageSize: 1024 * 1024, // 1MB
    allowedChannelPatterns: [
      /^telemetry:[a-f0-9-]{36}$/,
      /^project:[a-f0-9-]{36}$/,
      /^system$/,
      /^notifications$/,
    ],
  },
  
  cache: {
    defaultTTL: 300, // 5 minutes
    searchTTL: 60, // 1 minute
    recommendationsTTL: 300, // 5 minutes
    maxCacheSize: 100 * 1024 * 1024, // 100MB
  },
  
  tempFiles: {
    directory: 'temp/exports',
    cleanupInterval: 3600000, // 1 hour
    maxAge: 3600000, // 1 hour
    maxTotalSize: 1024 * 1024 * 1024, // 1GB
  },
  
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
    maxAge: 86400, // 24 hours
  },
  
  headers: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;",
  },
  
  errorMessages: {
    unauthorized: 'Authentication required',
    forbidden: 'You do not have permission to perform this action',
    invalidToken: 'Invalid or expired authentication token',
    rateLimit: 'Too many requests, please try again later',
    invalidInput: 'Invalid input provided',
    projectNotFound: 'Project not found or access denied',
    invalidFileType: 'Invalid file type',
    fileTooLarge: 'File size exceeds maximum allowed',
    exportFailed: 'Failed to export visualization',
    websocketAuth: 'WebSocket authentication failed',
    channelAccessDenied: 'Access denied to requested channel',
  },
  
  logging: {
    logFailedAuth: true,
    logRateLimits: true,
    logSecurityViolations: true,
    logSensitiveData: false,
    redactPatterns: [
      /password/gi,
      /token/gi,
      /secret/gi,
      /api[_-]?key/gi,
      /authorization/gi,
    ],
  },
};

export default visualizationSecurityConfig;
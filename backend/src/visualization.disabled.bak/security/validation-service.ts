import { Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult, ValidationChain } from 'express-validator';
import DOMPurify from 'isomorphic-dompurify';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';

export interface SanitizationOptions {
  allowedTags?: string[];
  allowedAttributes?: Record<string, string[]>;
  stripUnknown?: boolean;
}

export class ValidationService {
  private sanitizer: typeof DOMPurify;
  private rateLimiter: RateLimiterMemory | RateLimiterRedis;

  constructor(redis?: Redis) {
    this.sanitizer = DOMPurify;
    
    if (redis) {
      this.rateLimiter = new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: 'rl:viz',
        points: 100,
        duration: 60,
        blockDuration: 60,
      });
    } else {
      this.rateLimiter = new RateLimiterMemory({
        points: 100,
        duration: 60,
        blockDuration: 60,
      });
    }
  }

  sanitizeString(input: string, options?: SanitizationOptions): string {
    if (!input || typeof input !== 'string') {
      return '';
    }

    const config: any = {
      ALLOWED_TAGS: options?.allowedTags || [],
      ALLOWED_ATTR: options?.allowedAttributes || [],
      KEEP_CONTENT: !options?.stripUnknown,
    };

    return this.sanitizer.sanitize(input, config);
  }

  sanitizeObject(obj: any, fieldsToSanitize?: string[]): any {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    const sanitized = { ...obj };
    const fields = fieldsToSanitize || Object.keys(obj);

    fields.forEach(field => {
      if (typeof sanitized[field] === 'string') {
        sanitized[field] = this.sanitizeString(sanitized[field]);
      } else if (Array.isArray(sanitized[field])) {
        sanitized[field] = sanitized[field].map(item => 
          typeof item === 'string' ? this.sanitizeString(item) : item
        );
      } else if (typeof sanitized[field] === 'object' && sanitized[field] !== null) {
        sanitized[field] = this.sanitizeObject(sanitized[field]);
      }
    });

    return sanitized;
  }

  validateBlueprint(): ValidationChain[] {
    return [
      body('blueprint').isObject().withMessage('Blueprint must be an object'),
      body('blueprint.components').isArray().withMessage('Components must be an array'),
      body('blueprint.components.*.id').isString().trim().escape(),
      body('blueprint.components.*.name').isString().trim().escape(),
      body('blueprint.components.*.type').isString().trim().escape(),
      body('blueprint.connections').isArray().withMessage('Connections must be an array'),
      body('blueprint.connections.*.source').isString().trim().escape(),
      body('blueprint.connections.*.target').isString().trim().escape(),
      body('blueprint.metadata').optional().isObject(),
    ];
  }

  validateVisualizationOptions(): ValidationChain[] {
    return [
      body('options').optional().isObject(),
      body('options.layout').optional().isIn(['force', 'hierarchical', 'circular', 'grid', 'dagre', 'radial']),
      body('options.theme').optional().isIn(['light', 'dark', 'blueprint']),
      body('options.width').optional().isInt({ min: 100, max: 10000 }),
      body('options.height').optional().isInt({ min: 100, max: 10000 }),
      body('options.filters').optional().isObject(),
    ];
  }

  validateFileUpload(): ValidationChain[] {
    return [
      body('options').optional().isJSON().withMessage('Options must be valid JSON'),
    ];
  }

  validateExportRequest(): ValidationChain[] {
    return [
      param('format').isIn(['svg', 'pdf', 'png']).withMessage('Invalid export format'),
      body('data').isObject().withMessage('Visualization data is required'),
      body('data.nodes').isArray().withMessage('Nodes must be an array'),
      body('data.edges').isArray().withMessage('Edges must be an array'),
      body('options').optional().isObject(),
      body('options.title').optional().isString().trim().escape(),
      body('options.watermark').optional().isString().trim().escape(),
    ];
  }

  validateProjectAccess(): ValidationChain[] {
    return [
      param('projectId').optional().isUUID().withMessage('Invalid project ID'),
      body('projectId').optional().isUUID().withMessage('Invalid project ID'),
      query('projectId').optional().isUUID().withMessage('Invalid project ID'),
    ];
  }

  validateSearchQuery(): ValidationChain[] {
    return [
      query('blueprintId').notEmpty().isAlphanumeric().withMessage('Invalid blueprint ID'),
      query('query').notEmpty().trim().escape().isLength({ max: 100 }),
    ];
  }

  validateTelemetryRequest(): ValidationChain[] {
    return [
      body('projectId').notEmpty().isUUID().withMessage('Invalid project ID'),
      body('clientId').notEmpty().isAlphanumeric().withMessage('Invalid client ID'),
    ];
  }

  handleValidationErrors(req: Request, res: Response, next: NextFunction): void {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array().map(err => ({
          field: err.type === 'field' ? (err as any).path : undefined,
          message: err.msg,
        })),
      });
      return;
    }
    next();
  }

  createRateLimiter(points: number = 100, duration: number = 60) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = (req as any).userId || req.ip;
        await this.rateLimiter.consume(key);
        next();
      } catch (rejRes: any) {
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
          retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 60,
        });
      }
    };
  }

  validateContentType(allowedTypes: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const contentType = req.headers['content-type'];
      
      if (!contentType) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Content-Type header is required',
        });
      }

      const baseContentType = contentType.split(';')[0].trim();
      
      if (!allowedTypes.includes(baseContentType)) {
        return res.status(415).json({
          error: 'Unsupported Media Type',
          message: `Content-Type must be one of: ${allowedTypes.join(', ')}`,
        });
      }

      next();
    };
  }

  validateFileType(allowedExtensions: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.file) {
        return next();
      }

      const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase();
      
      if (!fileExtension || !allowedExtensions.includes(fileExtension)) {
        return res.status(400).json({
          error: 'Invalid File Type',
          message: `File type must be one of: ${allowedExtensions.join(', ')}`,
        });
      }

      const mimeTypeMap: Record<string, string[]> = {
        json: ['application/json'],
        yaml: ['application/x-yaml', 'text/yaml'],
        yml: ['application/x-yaml', 'text/yaml'],
      };

      const allowedMimeTypes = allowedExtensions.flatMap(ext => mimeTypeMap[ext] || []);
      
      if (!allowedMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: 'Invalid File Type',
          message: 'File MIME type does not match expected type',
        });
      }

      next();
    };
  }

  sanitizeSVGContent(svgContent: string): string {
    const config = {
      ALLOWED_TAGS: [
        'svg', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
        'path', 'text', 'tspan', 'defs', 'clipPath', 'mask', 'pattern',
        'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur',
        'feOffset', 'feComponentTransfer', 'feFuncA', 'feMerge', 'feMergeNode',
        'marker', 'use', 'image', 'foreignObject'
      ],
      ALLOWED_ATTR: [
        'id', 'class', 'style', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray',
        'opacity', 'transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
        'rx', 'ry', 'width', 'height', 'd', 'points', 'viewBox', 'preserveAspectRatio',
        'href', 'xlink:href', 'text-anchor', 'font-size', 'font-family', 'font-weight',
        'gradientUnits', 'gradientTransform', 'offset', 'stop-color', 'stop-opacity',
        'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight',
        'refX', 'refY', 'orient', 'markerUnits', 'stdDeviation', 'dx', 'dy', 'result',
        'in', 'in2', 'type', 'slope', 'clip-path', 'mask', 'filter'
      ],
      KEEP_CONTENT: false,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link'],
      FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur'],
    };

    return this.sanitizer.sanitize(svgContent, config);
  }

  escapeForSVG(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/\\/g, '\\\\')
      .replace(/[^\x20-\x7E]/g, '');
  }

  validatePaginationParams(): ValidationChain[] {
    return [
      query('page').optional().isInt({ min: 1, max: 1000 }),
      query('limit').optional().isInt({ min: 1, max: 100 }),
      query('sort').optional().isIn(['asc', 'desc']),
      query('sortBy').optional().isAlphanumeric(),
    ];
  }

  createRequestValidator(validators: ValidationChain[]) {
    return [
      ...validators,
      this.handleValidationErrors,
    ];
  }
}

export function createValidationService(redis?: Redis) {
  return new ValidationService(redis);
}
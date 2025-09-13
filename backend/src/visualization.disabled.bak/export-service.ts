import { VisualizationData } from './visualization-engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import { createCanvas, Canvas, CanvasRenderingContext2D } from 'canvas';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { ValidationService } from './security/validation-service';
import DOMPurify from 'isomorphic-dompurify';

export interface ExportOptions {
  width?: number;
  height?: number;
  quality?: number;
  background?: string;
  title?: string;
  metadata?: boolean;
  watermark?: string;
  format?: 'A4' | 'A3' | 'Letter' | 'custom';
  orientation?: 'portrait' | 'landscape';
  margin?: number;
}

export interface ExportResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export class ExportService {
  private tempDir: string;
  private fontPath: string;
  private validationService: ValidationService;
  private activeCanvases: Set<Canvas>;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', 'exports');
    this.fontPath = path.join(process.cwd(), 'assets', 'fonts');
    this.validationService = new ValidationService();
    this.activeCanvases = new Set();
    this.ensureDirectories();
    this.startCleanupInterval();
  }
  
  private startCleanupInterval(): void {
    // Clean up temp files every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanupTempFiles(3600000).catch(err => {
        console.error('Temp file cleanup error:', err);
      });
    }, 3600000);
  }

  private async ensureDirectories(): Promise<void> {
    await fs.ensureDir(this.tempDir);
    await fs.ensureDir(this.fontPath);
  }

  async export(
    data: VisualizationData,
    format: 'svg' | 'pdf' | 'png',
    options: ExportOptions = {}
  ): Promise<Buffer> {
    switch (format) {
      case 'svg':
        return this.exportSVG(data, options);
      case 'pdf':
        return this.exportPDF(data, options);
      case 'png':
        return this.exportPNG(data, options);
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  private async exportSVG(
    data: VisualizationData,
    options: ExportOptions
  ): Promise<Buffer> {
    const width = options.width || 1200;
    const height = options.height || 800;
    const background = options.background || '#ffffff';

    const svg = this.generateSVG(data, width, height, background, options);
    return Buffer.from(svg, 'utf-8');
  }

  private generateSVG(
    data: VisualizationData,
    width: number,
    height: number,
    background: string,
    options: ExportOptions
  ): string {
    const lines: string[] = [];
    
    // SVG header
    lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    lines.push(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`);
    
    // Background
    lines.push(`  <rect width="${width}" height="${height}" fill="${background}"/>`);
    
    // Title - properly sanitized
    if (options.title) {
      const sanitizedTitle = this.validationService.escapeForSVG(options.title);
      lines.push(`  <text x="${width / 2}" y="30" text-anchor="middle" font-size="24" font-weight="bold">${sanitizedTitle}</text>`);
    }
    
    // Define markers for arrows
    lines.push('  <defs>');
    lines.push('    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">');
    lines.push('      <polygon points="0 0, 10 3.5, 0 7" fill="#666" />');
    lines.push('    </marker>');
    
    // Define gradients
    lines.push('    <linearGradient id="nodeGradient" x1="0%" y1="0%" x2="100%" y2="100%">');
    lines.push('      <stop offset="0%" style="stop-color:#ffffff;stop-opacity:0.5" />');
    lines.push('      <stop offset="100%" style="stop-color:#000000;stop-opacity:0.1" />');
    lines.push('    </linearGradient>');
    
    // Define filters
    lines.push('    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">');
    lines.push('      <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>');
    lines.push('      <feOffset dx="2" dy="2" result="offsetblur"/>');
    lines.push('      <feComponentTransfer>');
    lines.push('        <feFuncA type="linear" slope="0.3"/>');
    lines.push('      </feComponentTransfer>');
    lines.push('      <feMerge>');
    lines.push('        <feMergeNode/>');
    lines.push('        <feMergeNode in="SourceGraphic"/>');
    lines.push('      </feMerge>');
    lines.push('    </filter>');
    lines.push('  </defs>');
    
    // Main content group
    lines.push('  <g id="visualization">');
    
    // Draw edges first (so they appear behind nodes)
    lines.push('    <g id="edges">');
    data.edges.forEach(edge => {
      if (edge.hidden) return;
      
      const source = data.nodes.find(n => n.id === edge.source);
      const target = data.nodes.find(n => n.id === edge.target);
      
      if (source && target && source.x !== undefined && target.x !== undefined) {
        const strokeWidth = edge.style?.width || 1;
        const strokeColor = edge.style?.color || '#999';
        const strokeDasharray = edge.style === 'dashed' ? '5,5' : edge.style === 'dotted' ? '2,2' : '';
        const opacity = edge.style?.opacity || 0.6;
        
        lines.push(`      <line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" `);
        lines.push(`            stroke="${strokeColor}" stroke-width="${strokeWidth}" `);
        if (strokeDasharray) lines.push(`            stroke-dasharray="${strokeDasharray}" `);
        lines.push(`            opacity="${opacity}" `);
        if (edge.animated) lines.push(`            class="animated-edge" `);
        lines.push(`            marker-end="url(#arrowhead)" />`);
        
        // Edge label - sanitized
        if (edge.label) {
          const midX = (source.x + target.x) / 2;
          const midY = (source.y + target.y) / 2;
          const sanitizedLabel = this.validationService.escapeForSVG(edge.label);
          lines.push(`      <text x="${midX}" y="${midY}" text-anchor="middle" font-size="10" fill="#666">${sanitizedLabel}</text>`);
        }
      }
    });
    lines.push('    </g>');
    
    // Draw nodes
    lines.push('    <g id="nodes">');
    data.nodes.forEach(node => {
      if (node.hidden) return;
      
      const x = node.x || 0;
      const y = node.y || 0;
      const size = node.size || 20;
      const color = node.color || '#4CAF50';
      const opacity = node.metadata?.opacity || 1;
      
      // Node shape
      lines.push(`      <g transform="translate(${x}, ${y})" opacity="${opacity}">`);
      
      // Shadow
      lines.push(`        <circle r="${size}" fill="${color}" filter="url(#shadow)" />`);
      
      // Main shape
      lines.push(`        <circle r="${size}" fill="${color}" stroke="#fff" stroke-width="2" />`);
      
      // Gradient overlay
      lines.push(`        <circle r="${size}" fill="url(#nodeGradient)" opacity="0.3" />`);
      
      // Node label - sanitized
      if (node.label) {
        const sanitizedLabel = this.validationService.escapeForSVG(node.label);
        lines.push(`        <text y="${size + 15}" text-anchor="middle" font-size="12" fill="#333">${sanitizedLabel}</text>`);
      }
      
      // Icon (if any)
      if (node.icon) {
        lines.push(`        <text y="5" text-anchor="middle" font-size="${size}" fill="#fff">${node.icon}</text>`);
      }
      
      lines.push('      </g>');
    });
    lines.push('    </g>');
    
    // Clusters
    if (data.clusters?.length) {
      lines.push('    <g id="clusters" opacity="0.2">');
      data.clusters.forEach(cluster => {
        const clusterNodes = data.nodes.filter(n => cluster.nodes.includes(n.id));
        if (clusterNodes.length > 0) {
          const bounds = this.calculateBounds(clusterNodes);
          lines.push(`      <rect x="${bounds.minX - 20}" y="${bounds.minY - 20}" `);
          lines.push(`            width="${bounds.maxX - bounds.minX + 40}" `);
          lines.push(`            height="${bounds.maxY - bounds.minY + 40}" `);
          lines.push(`            fill="none" stroke="#999" stroke-width="2" `);
          lines.push(`            stroke-dasharray="10,5" rx="10" ry="10" />`);
          
          // Cluster label - sanitized
          const sanitizedClusterLabel = this.validationService.escapeForSVG(cluster.label);
          lines.push(`      <text x="${bounds.minX}" y="${bounds.minY - 25}" font-size="14" fill="#666">${sanitizedClusterLabel}</text>`);
        }
      });
      lines.push('    </g>');
    }
    
    lines.push('  </g>');
    
    // Watermark - sanitized
    if (options.watermark) {
      const sanitizedWatermark = this.validationService.escapeForSVG(options.watermark);
      lines.push(`  <text x="${width - 10}" y="${height - 10}" text-anchor="end" font-size="12" fill="#ccc" opacity="0.5">${sanitizedWatermark}</text>`);
    }
    
    // Metadata
    if (options.metadata && data.viewport) {
      lines.push('  <g id="metadata">');
      lines.push(`    <text x="10" y="${height - 30}" font-size="10" fill="#999">Nodes: ${data.nodes.length}</text>`);
      lines.push(`    <text x="10" y="${height - 15}" font-size="10" fill="#999">Edges: ${data.edges.length}</text>`);
      lines.push(`    <text x="10" y="${height - 0}" font-size="10" fill="#999">Layout: ${data.layout}</text>`);
      lines.push('  </g>');
    }
    
    lines.push('</svg>');
    
    // Final sanitization pass on complete SVG
    const rawSVG = lines.join('\n');
    return this.validationService.sanitizeSVGContent(rawSVG);
  }

  private calculateBounds(nodes: any[]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    nodes.forEach(node => {
      if (node.x !== undefined && node.y !== undefined) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x);
        maxY = Math.max(maxY, node.y);
      }
    });
    
    return { minX, minY, maxX, maxY };
  }

  private escapeXML(str: string): string {
    // Use validation service for consistent escaping
    return this.validationService.escapeForSVG(str);
  }

  private async exportPDF(
    data: VisualizationData,
    options: ExportOptions
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: options.format || 'A4',
          layout: options.orientation || 'landscape',
          margin: options.margin || 50
        });
        
        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        
        // Title - sanitized
        if (options.title) {
          const sanitizedTitle = this.validationService.sanitizeString(options.title);
          doc.fontSize(24)
             .text(sanitizedTitle, { align: 'center' })
             .moveDown();
        }
        
        // Generate SVG and add to PDF
        const svg = this.generateSVG(
          data,
          doc.page.width - (options.margin || 50) * 2,
          doc.page.height - (options.margin || 50) * 2 - 100,
          options.background || '#ffffff',
          options
        );
        
        // Use svg-to-pdfkit to render SVG in PDF
        SVGtoPDF(doc, svg, 0, 100);
        
        // Metadata section
        if (options.metadata) {
          doc.moveDown(2)
             .fontSize(10)
             .fillColor('#666666')
             .text(`Generated: ${new Date().toISOString()}`, { align: 'left' })
             .text(`Nodes: ${data.nodes.length} | Edges: ${data.edges.length}`, { align: 'left' })
             .text(`Layout: ${data.layout}`, { align: 'left' });
        }
        
        // Watermark - sanitized
        if (options.watermark) {
          const sanitizedWatermark = this.validationService.sanitizeString(options.watermark);
          doc.fontSize(8)
             .fillColor('#cccccc')
             .text(sanitizedWatermark, doc.page.width - 150, doc.page.height - 30, {
               width: 140,
               align: 'right'
             });
        }
        
        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async exportPNG(
    data: VisualizationData,
    options: ExportOptions
  ): Promise<Buffer> {
    const width = options.width || 1200;
    const height = options.height || 800;
    const quality = options.quality || 0.92;
    
    // Create canvas and track it for cleanup
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    this.activeCanvases.add(canvas);
    
    // Background
    ctx.fillStyle = options.background || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    
    // Title - sanitized
    if (options.title) {
      const sanitizedTitle = this.validationService.sanitizeString(options.title);
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 24px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(sanitizedTitle, width / 2, 40);
    }
    
    // Draw edges
    data.edges.forEach(edge => {
      if (edge.hidden) return;
      
      const source = data.nodes.find(n => n.id === edge.source);
      const target = data.nodes.find(n => n.id === edge.target);
      
      if (source && target && source.x && target.x) {
        ctx.beginPath();
        ctx.moveTo(source.x, source.y!);
        ctx.lineTo(target.x, target.y!);
        ctx.strokeStyle = edge.color || '#999999';
        ctx.lineWidth = edge.style?.width || 1;
        ctx.globalAlpha = edge.style?.opacity || 0.6;
        
        if (edge.style === 'dashed') {
          ctx.setLineDash([5, 5]);
        } else if (edge.style === 'dotted') {
          ctx.setLineDash([2, 2]);
        }
        
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        
        // Draw arrow
        if (edge.style?.arrow !== false) {
          this.drawArrow(ctx, source.x, source.y!, target.x, target.y!);
        }
      }
    });
    
    // Draw nodes
    data.nodes.forEach(node => {
      if (node.hidden) return;
      
      const x = node.x || 0;
      const y = node.y || 0;
      const size = node.size || 20;
      const color = node.color || '#4CAF50';
      
      // Shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      
      // Node circle
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Reset shadow
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      
      // Node label - sanitized
      if (node.label) {
        const sanitizedLabel = this.validationService.sanitizeString(node.label);
        ctx.fillStyle = '#333333';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(sanitizedLabel, x, y + size + 20);
      }
    });
    
    // Draw clusters
    if (data.clusters?.length) {
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 5]);
      ctx.globalAlpha = 0.3;
      
      data.clusters.forEach(cluster => {
        const clusterNodes = data.nodes.filter(n => cluster.nodes.includes(n.id));
        if (clusterNodes.length > 0) {
          const bounds = this.calculateBounds(clusterNodes);
          
          ctx.strokeRect(
            bounds.minX - 20,
            bounds.minY - 20,
            bounds.maxX - bounds.minX + 40,
            bounds.maxY - bounds.minY + 40
          );
          
          // Cluster label - sanitized
          const sanitizedClusterLabel = this.validationService.sanitizeString(cluster.label);
          ctx.fillStyle = '#666666';
          ctx.font = '14px Arial';
          ctx.textAlign = 'left';
          ctx.fillText(sanitizedClusterLabel, bounds.minX, bounds.minY - 25);
        }
      });
      
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    
    // Watermark - sanitized
    if (options.watermark) {
      const sanitizedWatermark = this.validationService.sanitizeString(options.watermark);
      ctx.fillStyle = 'rgba(200, 200, 200, 0.5)';
      ctx.font = '12px Arial';
      ctx.textAlign = 'right';
      ctx.fillText(sanitizedWatermark, width - 10, height - 10);
    }
    
    // Metadata
    if (options.metadata) {
      ctx.fillStyle = '#999999';
      ctx.font = '10px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(`Nodes: ${data.nodes.length}`, 10, height - 30);
      ctx.fillText(`Edges: ${data.edges.length}`, 10, height - 15);
      ctx.fillText(`Layout: ${data.layout}`, 10, height - 0);
    }
    
    // Convert to PNG buffer and clean up
    const buffer = canvas.toBuffer('image/png', { quality });
    
    // Clean up canvas from tracking
    this.activeCanvases.delete(canvas);
    
    // Force garbage collection hint
    (canvas as any) = null;
    (ctx as any) = null;
    
    return buffer;
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ): void {
    const headLength = 10;
    const angle = Math.atan2(toY - fromY, toX - fromX);
    
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - headLength * Math.cos(angle - Math.PI / 6),
      toY - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - headLength * Math.cos(angle + Math.PI / 6),
      toY - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
  }

  async exportBatch(
    visualizations: Array<{ data: VisualizationData; name: string }>,
    format: 'svg' | 'pdf' | 'png',
    options: ExportOptions = {}
  ): Promise<Map<string, Buffer>> {
    const results = new Map<string, Buffer>();
    
    for (const { data, name } of visualizations) {
      const buffer = await this.export(data, format, {
        ...options,
        title: options.title || name
      });
      results.set(name, buffer);
      
      // Add small delay between exports to prevent memory buildup
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
  }
  
  dispose(): void {
    // Clean up interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clean up any remaining canvases
    this.activeCanvases.forEach(canvas => {
      try {
        (canvas as any) = null;
      } catch (err) {
        console.error('Canvas cleanup error:', err);
      }
    });
    this.activeCanvases.clear();
    
    // Clean up temp files
    this.cleanupTempFiles(0).catch(err => {
      console.error('Final cleanup error:', err);
    });
  }

  async saveToFile(
    buffer: Buffer,
    filename: string,
    format: 'svg' | 'pdf' | 'png'
  ): Promise<string> {
    const ext = format;
    const fullPath = path.join(this.tempDir, `${filename}.${ext}`);
    
    await fs.writeFile(fullPath, buffer);
    return fullPath;
  }

  async cleanupTempFiles(olderThanMs: number = 3600000): Promise<void> {
    const now = Date.now();
    const files = await fs.readdir(this.tempDir);
    
    for (const file of files) {
      const filePath = path.join(this.tempDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtimeMs > olderThanMs) {
        await fs.remove(filePath);
      }
    }
  }

  getExportMetadata(format: 'svg' | 'pdf' | 'png'): ExportResult {
    const mimeTypes = {
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
      png: 'image/png'
    };
    
    const extensions = {
      svg: 'svg',
      pdf: 'pdf',
      png: 'png'
    };
    
    return {
      buffer: Buffer.alloc(0),
      mimeType: mimeTypes[format],
      filename: `visualization-${Date.now()}.${extensions[format]}`
    };
  }
}
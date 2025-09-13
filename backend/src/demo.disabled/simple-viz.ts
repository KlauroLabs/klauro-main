#!/usr/bin/env ts-node

import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

const REPO_PATH = process.argv[2] || process.cwd();
const OUTPUT_DIR = path.join(process.cwd(), 'demo-output');

interface SimpleComponent {
  id: string;
  name: string;
  type: string;
  path: string;
  imports: string[];
}

interface SimpleConnection {
  from: string;
  to: string;
}

async function analyzeSimple(repoPath: string) {
  console.log('🚀 Unravl Demo - Simple Architecture Visualization\n');
  
  // Find all TypeScript files
  const files = await glob('**/*.ts', {
    cwd: repoPath,
    ignore: ['node_modules/**', 'dist/**', '*.test.ts', '*.spec.ts']
  });
  
  console.log(`📁 Found ${files.length} TypeScript files\n`);
  
  const components: SimpleComponent[] = [];
  const connections: SimpleConnection[] = [];
  const componentMap = new Map<string, SimpleComponent>();
  
  // Analyze each file
  for (const file of files) {
    const fullPath = path.join(repoPath, file);
    const content = await fs.readFile(fullPath, 'utf-8');
    const name = path.basename(file, '.ts');
    const dir = path.dirname(file);
    
    // Determine component type
    let type = 'module';
    if (name.includes('controller') || name.includes('Controller')) type = 'controller';
    else if (name.includes('service') || name.includes('Service')) type = 'service';
    else if (name.includes('model') || name.includes('Model')) type = 'model';
    else if (name.includes('route') || name.includes('Route')) type = 'route';
    else if (name.includes('middleware')) type = 'middleware';
    else if (dir.includes('analyzer')) type = 'analyzer';
    else if (dir.includes('visualization')) type = 'visualization';
    else if (dir.includes('auth')) type = 'auth';
    else if (dir.includes('database')) type = 'database';
    else if (content.includes('export class')) type = 'class';
    else if (content.includes('export interface')) type = 'interface';
    
    const component: SimpleComponent = {
      id: file.replace(/[\/\\]/g, '_').replace('.ts', ''),
      name,
      type,
      path: file,
      imports: []
    };
    
    // Extract imports
    const importRegex = /import .* from ['"](.+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith('.')) {
        // Relative import - this is an internal connection
        const resolvedPath = path.join(dir, importPath);
        const normalizedPath = resolvedPath.replace(/[\/\\]/g, '_');
        component.imports.push(normalizedPath);
      }
    }
    
    components.push(component);
    componentMap.set(component.id, component);
  }
  
  // Create connections from imports
  for (const component of components) {
    for (const imp of component.imports) {
      // Try to find the target component
      const targetId = imp.replace(/^\.+_/, '');
      const target = Array.from(componentMap.keys()).find(id => 
        id.includes(targetId) || targetId.includes(id)
      );
      
      if (target && target !== component.id) {
        connections.push({
          from: component.id,
          to: target
        });
      }
    }
  }
  
  console.log(`📊 Analysis Complete:`);
  console.log(`   • ${components.length} components`);
  console.log(`   • ${connections.length} connections\n`);
  
  // Group by type
  const byType = components.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  console.log('📦 Component Types:');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`   • ${type}: ${count}`);
  });
  
  return { components, connections };
}

async function generateHTML(components: SimpleComponent[], connections: SimpleConnection[]) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Unravl - Architecture Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    
    #header {
      background: rgba(255, 255, 255, 0.95);
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    
    #header h1 {
      color: #667eea;
      font-size: 24px;
      margin-bottom: 10px;
    }
    
    #stats {
      color: #666;
      font-size: 14px;
    }
    
    #viz {
      flex: 1;
      background: white;
      margin: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    
    .tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 10px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>🗺️ Unravl Architecture Map</h1>
    <div id="stats">
      📦 ${components.length} components • 
      🔗 ${connections.length} connections • 
      🎨 ${Object.keys(components.reduce((a,c) => ({...a,[c.type]:1}), {})).length} types
    </div>
  </div>
  
  <div id="viz"></div>
  <div class="tooltip" id="tooltip"></div>

  <script>
    const nodes = ${JSON.stringify(components.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      path: c.path,
      group: c.type
    })))};
    
    const links = ${JSON.stringify(connections.map(c => ({
      source: c.from,
      target: c.to,
      value: 1
    })))};
    
    // Set up dimensions
    const container = document.getElementById('viz');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Create SVG
    const svg = d3.select('#viz')
      .append('svg')
      .attr('width', width)
      .attr('height', height);
    
    // Add zoom
    const g = svg.append('g');
    const zoom = d3.zoom()
      .scaleExtent([0.1, 10])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    svg.call(zoom);
    
    // Color scale
    const color = d3.scaleOrdinal()
      .domain(['controller', 'service', 'model', 'route', 'middleware', 'analyzer', 'visualization', 'auth', 'database', 'class', 'interface', 'module'])
      .range(['#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#00bcd4', '#009688', '#4caf50', '#8bc34a', '#ff9800', '#ff5722', '#795548']);
    
    // Create force simulation
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30));
    
    // Add links
    const link = g.append('g')
      .attr('stroke', '#999')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke-width', d => Math.sqrt(d.value));
    
    // Add nodes
    const node = g.append('g')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .selectAll('g')
      .data(nodes)
      .join('g')
      .call(drag(simulation));
    
    node.append('circle')
      .attr('r', 8)
      .attr('fill', d => color(d.type));
    
    node.append('text')
      .text(d => d.name)
      .attr('x', 0)
      .attr('y', -12)
      .attr('text-anchor', 'middle')
      .style('font-size', '10px')
      .style('font-weight', 'bold')
      .style('fill', '#333');
    
    // Tooltip
    const tooltip = d3.select('#tooltip');
    node.on('mouseover', (event, d) => {
      tooltip.style('opacity', 1)
        .html(\`<strong>\${d.name}</strong><br>Type: \${d.type}<br>Path: \${d.path}\`)
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY - 10) + 'px');
    })
    .on('mouseout', () => {
      tooltip.style('opacity', 0);
    });
    
    // Update positions on tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      
      node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
    });
    
    // Drag functionality
    function drag(simulation) {
      function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }
      
      function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }
      
      function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }
      
      return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    }
    
    // Initial zoom to fit
    setTimeout(() => {
      const bounds = g.node().getBBox();
      const fullWidth = width;
      const fullHeight = height;
      const widthScale = fullWidth / bounds.width;
      const heightScale = fullHeight / bounds.height;
      const scale = 0.8 * Math.min(widthScale, heightScale);
      const translate = [fullWidth / 2 - scale * (bounds.x + bounds.width / 2), 
                        fullHeight / 2 - scale * (bounds.y + bounds.height / 2)];
      
      svg.transition()
        .duration(750)
        .call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
    }, 1000);
  </script>
</body>
</html>`;
  
  return html;
}

async function main() {
  try {
    await fs.ensureDir(OUTPUT_DIR);
    
    const { components, connections } = await analyzeSimple(REPO_PATH);
    
    // Save data
    const dataPath = path.join(OUTPUT_DIR, 'architecture.json');
    await fs.writeJSON(dataPath, { components, connections }, { spaces: 2 });
    console.log(`\n💾 Data saved: ${dataPath}`);
    
    // Generate HTML
    const html = await generateHTML(components, connections);
    const htmlPath = path.join(OUTPUT_DIR, 'index.html');
    await fs.writeFile(htmlPath, html);
    console.log(`🎨 Visualization saved: ${htmlPath}`);
    
    console.log('\n' + '='.repeat(60));
    console.log('✨ SUCCESS! Your visualization is ready!');
    console.log('='.repeat(60));
    console.log('\nTo view: open ' + htmlPath);
    console.log('\nFeatures:');
    console.log('  • Zoom with mouse wheel');
    console.log('  • Drag nodes to rearrange');
    console.log('  • Hover for details');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
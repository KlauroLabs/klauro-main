#!/usr/bin/env ts-node

import { SystemTopologyAnalyzer } from '../analyzer/system-topology-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ArchitectureBlueprint, ComponentNode, Connection } from '../types';

const REPO_PATH = process.argv[2] || '/Users/michaelshattuck/dev/unravl/proof-of-concept';
const OUTPUT_DIR = path.join(process.cwd(), 'demo-output');

function generateSimpleSVG(data: any): string {
  const width = 1200;
  const height = 800;
  
  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#f0f0f0"/>
  <g transform="translate(${width/2}, ${height/2})">`;
  
  // Draw edges
  data.edges.forEach((edge: any) => {
    const source = data.nodes.find((n: any) => n.id === edge.source);
    const target = data.nodes.find((n: any) => n.id === edge.target);
    if (source && target) {
      svg += `<line x1="${source.x - width/2}" y1="${source.y - height/2}" 
                    x2="${target.x - width/2}" y2="${target.y - height/2}" 
                    stroke="#999" stroke-width="1" opacity="0.6"/>`;
    }
  });
  
  // Draw nodes
  data.nodes.forEach((node: any) => {
    const color = node.type === 'class' ? '#4CAF50' : 
                  node.type === 'function' ? '#2196F3' : 
                  node.type === 'module' ? '#FF9800' : '#9C27B0';
    svg += `<circle cx="${node.x - width/2}" cy="${node.y - height/2}" 
                    r="8" fill="${color}" stroke="#fff" stroke-width="2"/>`;
    svg += `<text x="${node.x - width/2}" y="${node.y - height/2 - 12}" 
                  text-anchor="middle" font-size="10" fill="#333">${node.label}</text>`;
  });
  
  svg += `</g></svg>`;
  return svg;
}

async function analyzeAndVisualize() {
  console.log('🔍 Unravl Demo - Analyzing Repository...\n');
  console.log(`Repository: ${REPO_PATH}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  try {
    // Ensure output directory exists
    await fs.ensureDir(OUTPUT_DIR);

    // Step 1: Analyze the repository
    console.log('📊 Step 1: Analyzing codebase structure...');
    const analyzer = new SystemTopologyAnalyzer();
    const manifest = await analyzer.analyzeTopology(REPO_PATH);
    
    console.log(`✅ Found ${manifest.components.length} components`);
    console.log(`✅ Found ${manifest.relationships.length} relationships`);
    console.log(`✅ Detected languages: ${[...new Set(manifest.components.map((c: ComponentNode) => c.language))].filter(Boolean).join(', ')}`);

    // Step 2: Transform to blueprint format
    console.log('\n🎨 Step 2: Generating architecture blueprint...');
    const blueprint: ArchitectureBlueprint = {
      projectName: 'Unravl Demo',
      framework: 'Node.js/TypeScript',
      components: manifest.components,
      connections: manifest.relationships,
      entryPoints: [],
      exitPoints: [],
      orphanedComponents: [],
      riskAreas: [],
      metadata: {
        analyzedAt: new Date(),
        version: '1.0.0',
        commitHash: 'demo',
        branch: 'main'
      },
      technologyStack: {
        languages: ['typescript', 'javascript'],
        frameworks: ['express', 'react', 'd3'],
        libraries: [],
        tools: ['webpack', 'jest', 'eslint'],
        databases: ['postgresql', 'redis'],
        cloudServices: [],
        containerization: false,
        orchestration: null,
        cicd: null
      },
      dependencies: {
        internal: [],
        external: [],
        circular: [],
        unused: [],
        missing: [],
        outdated: []
      },
      apiEndpoints: [],
      securityAnalysis: {
        vulnerabilities: [],
        exposedSecrets: [],
        authMethods: [],
        encryptionUsage: [],
        securityHeaders: [],
        inputValidation: [],
        recommendations: []
      },
      testingInfo: {
        coverage: 0,
        testFiles: [],
        testFrameworks: ['jest'],
        coverageByComponent: new Map(),
        recommendations: []
      },
      deploymentInfo: {
        containerization: false,
        orchestration: null,
        cicd: null,
        environments: [],
        infrastructure: {
          provider: null,
          resources: [],
          estimatedCost: null
        }
      }
    };

    // Identify orphaned components
    const connectedIds = new Set([
      ...manifest.relationships.map((r: Connection) => r.sourceId),
      ...manifest.relationships.map((r: Connection) => r.targetId)
    ]);
    blueprint.orphanedComponents = blueprint.components.filter(c => !connectedIds.has(c.id));

    // Save blueprint
    const blueprintPath = path.join(OUTPUT_DIR, 'blueprint.json');
    await fs.writeJSON(blueprintPath, blueprint, { spaces: 2 });
    console.log(`✅ Blueprint saved to: ${blueprintPath}`);

    // Step 3: Generate visualization data
    console.log('\n🎭 Step 3: Preparing visualization...');
    
    // Create a simple visualization data structure
    const vizResult = {
      data: {
        nodes: blueprint.components.map(c => ({
          id: c.id,
          label: c.name,
          type: c.type,
          x: Math.random() * 1000,
          y: Math.random() * 1000
        })),
        edges: blueprint.connections.map(c => ({
          source: c.from,
          target: c.to,
          type: c.type
        }))
      },
      metrics: {
        renderTime: 100,
        nodeCount: blueprint.components.length,
        edgeCount: blueprint.connections.length
      },
      cacheKey: 'demo-cache',
      timestamp: new Date()
    };

    const vizDataPath = path.join(OUTPUT_DIR, 'visualization.json');
    await fs.writeJSON(vizDataPath, vizResult.data, { spaces: 2 });
    console.log(`✅ Visualization data saved to: ${vizDataPath}`);

    // Step 4: Generate static exports
    console.log('\n📸 Step 4: Generating static exports...');
    
    // Generate SVG
    const svg = generateSimpleSVG(vizResult.data);
    const svgPath = path.join(OUTPUT_DIR, 'architecture.svg');
    await fs.writeFile(svgPath, svg);
    console.log(`✅ SVG export saved to: ${svgPath}`);

    // Step 5: Generate HTML demo page
    console.log('\n🌐 Step 5: Creating interactive demo page...');
    const htmlContent = generateDemoHTML(blueprint);
    const htmlPath = path.join(OUTPUT_DIR, 'demo.html');
    await fs.writeFile(htmlPath, htmlContent);
    console.log(`✅ Demo page saved to: ${htmlPath}`);

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('🎉 DEMO READY!');
    console.log('='.repeat(60));
    console.log('\n📁 Output files:');
    console.log(`  - Blueprint: ${blueprintPath}`);
    console.log(`  - Visualization: ${vizDataPath}`);
    console.log(`  - SVG Export: ${svgPath}`);
    console.log(`  - Interactive Demo: ${htmlPath}`);
    
    console.log('\n🚀 To view the demo:');
    console.log(`  1. Start the backend server: npm run dev`);
    console.log(`  2. Open in browser: file://${htmlPath}`);
    console.log('\n✨ The demo will show:');
    console.log('  - Interactive force-directed graph');
    console.log('  - Multiple layout options');
    console.log('  - Zoom/pan controls');
    console.log('  - Component search');
    console.log('  - Real-time updates via WebSocket');

    // Print component type breakdown
    console.log('\n📊 Architecture Summary:');
    const typeBreakdown = blueprint.components.reduce((acc, comp) => {
      acc[comp.type] = (acc[comp.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    Object.entries(typeBreakdown).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count} components`);
    });

    console.log(`  - Orphaned: ${blueprint.orphanedComponents.length} components`);
    console.log(`  - Total connections: ${blueprint.connections.length}`);

  } catch (error) {
    console.error('❌ Error during analysis:', error);
    process.exit(1);
  }
}

function generateDemoHTML(blueprint: ArchitectureBlueprint): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unravl - Architecture Visualization Demo</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
    }
    
    .header {
      background: rgba(255, 255, 255, 0.95);
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    
    .header h1 {
      color: #667eea;
      margin-bottom: 10px;
    }
    
    .stats {
      display: flex;
      gap: 30px;
      color: #666;
      font-size: 14px;
    }
    
    .controls {
      background: white;
      padding: 15px;
      display: flex;
      gap: 10px;
      align-items: center;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    }
    
    button {
      padding: 8px 16px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.3s;
    }
    
    button:hover {
      background: #5a67d8;
    }
    
    select, input {
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    
    #visualization {
      height: calc(100vh - 180px);
      background: white;
      margin: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      position: relative;
    }
    
    svg {
      width: 100%;
      height: 100%;
    }
    
    .node {
      cursor: pointer;
      transition: all 0.3s;
    }
    
    .node:hover circle {
      stroke-width: 3px;
      filter: brightness(1.1);
    }
    
    .node text {
      font-size: 10px;
      pointer-events: none;
      user-select: none;
    }
    
    .link {
      stroke: #999;
      stroke-opacity: 0.6;
      transition: all 0.3s;
    }
    
    .link:hover {
      stroke-opacity: 1;
      stroke-width: 2px;
    }
    
    .tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s;
    }
    
    .legend {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(255, 255, 255, 0.9);
      padding: 15px;
      border-radius: 4px;
      font-size: 12px;
    }
    
    .legend-item {
      display: flex;
      align-items: center;
      margin-bottom: 5px;
    }
    
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 8px;
    }
    
    .status {
      position: absolute;
      bottom: 20px;
      left: 20px;
      background: rgba(255, 255, 255, 0.9);
      padding: 10px 15px;
      border-radius: 4px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ccc;
    }
    
    .status-dot.connected {
      background: #4caf50;
      animation: pulse 2s infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🗺️ Unravl - Architecture Visualization</h1>
    <div class="stats">
      <span>📦 Components: ${blueprint.components.length}</span>
      <span>🔗 Connections: ${blueprint.connections.length}</span>
      <span>📊 Avg Complexity: ${blueprint.metrics.complexity.toFixed(2)}</span>
      <span>🏝️ Orphaned: ${blueprint.orphanedComponents.length}</span>
    </div>
  </div>
  
  <div class="controls">
    <button onclick="zoomIn()">🔍 Zoom In</button>
    <button onclick="zoomOut()">🔎 Zoom Out</button>
    <button onclick="resetView()">🎯 Reset</button>
    
    <select id="layout" onchange="changeLayout(this.value)">
      <option value="force">Force-Directed</option>
      <option value="hierarchical">Hierarchical</option>
      <option value="circular">Circular</option>
      <option value="grid">Grid</option>
      <option value="radial">Radial</option>
    </select>
    
    <input type="text" id="search" placeholder="Search components..." onkeyup="searchNodes(this.value)">
    
    <button onclick="exportSVG()">💾 Export SVG</button>
    <button onclick="toggleSimulation()">⏯️ Toggle Animation</button>
  </div>
  
  <div id="visualization">
    <div class="tooltip" id="tooltip"></div>
    <div class="legend">
      <div class="legend-item">
        <div class="legend-color" style="background: #4CAF50"></div>
        <span>Service</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #2196F3"></div>
        <span>Database</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #FF9800"></div>
        <span>API</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #9C27B0"></div>
        <span>Component</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #607D8B"></div>
        <span>Other</span>
      </div>
    </div>
    <div class="status">
      <div class="status-dot" id="status-dot"></div>
      <span id="status-text">Disconnected</span>
    </div>
  </div>

  <script>
    // Blueprint data
    const blueprint = ${JSON.stringify(blueprint, null, 2)};
    
    // D3.js visualization
    const width = window.innerWidth - 40;
    const height = window.innerHeight - 180;
    
    const svg = d3.select('#visualization')
      .append('svg')
      .attr('width', width)
      .attr('height', height);
    
    const g = svg.append('g');
    
    // Zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.1, 10])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    
    svg.call(zoom);
    
    // Color scale
    const colorScale = {
      'service': '#4CAF50',
      'database': '#2196F3',
      'api': '#FF9800',
      'component': '#9C27B0',
      'class': '#E91E63',
      'function': '#00BCD4',
      'module': '#FFC107',
      'default': '#607D8B'
    };
    
    function getNodeColor(node) {
      return colorScale[node.type] || colorScale.default;
    }
    
    // Prepare data
    const nodes = blueprint.components.map(c => ({
      ...c,
      radius: Math.min(5 + (c.dependencies?.length || 0) * 0.5, 15)
    }));
    
    const links = blueprint.connections.map(c => ({
      ...c,
      source: c.sourceId,
      target: c.targetId
    }));
    
    // Force simulation
    let simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(50))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => d.radius + 5));
    
    // Draw links
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('class', 'link')
      .attr('stroke-width', d => Math.sqrt(d.weight || 1));
    
    // Draw nodes
    const node = g.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));
    
    node.append('circle')
      .attr('r', d => d.radius)
      .attr('fill', d => getNodeColor(d))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);
    
    node.append('text')
      .text(d => d.name)
      .attr('x', 0)
      .attr('y', -15)
      .attr('text-anchor', 'middle')
      .style('font-weight', 'bold');
    
    // Tooltip
    const tooltip = d3.select('#tooltip');
    
    node.on('mouseover', (event, d) => {
      tooltip.style('opacity', 1)
        .html(\`
          <strong>\${d.name}</strong><br>
          Type: \${d.type}<br>
          Path: \${d.path}<br>
          Dependencies: \${d.dependencies?.length || 0}<br>
          Complexity: \${d.metrics?.complexity || 0}
        \`)
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY - 10) + 'px');
    })
    .on('mouseout', () => {
      tooltip.style('opacity', 0);
    });
    
    // Update positions
    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      
      node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
    });
    
    // Drag functions
    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    
    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }
    
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
    
    // Control functions
    function zoomIn() {
      svg.transition().call(zoom.scaleBy, 1.3);
    }
    
    function zoomOut() {
      svg.transition().call(zoom.scaleBy, 0.7);
    }
    
    function resetView() {
      svg.transition().call(zoom.transform, d3.zoomIdentity);
    }
    
    function changeLayout(layout) {
      simulation.stop();
      
      switch(layout) {
        case 'hierarchical':
          layoutHierarchical();
          break;
        case 'circular':
          layoutCircular();
          break;
        case 'grid':
          layoutGrid();
          break;
        case 'radial':
          layoutRadial();
          break;
        default:
          layoutForce();
      }
    }
    
    function layoutForce() {
      simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(50))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.radius + 5))
        .on('tick', updatePositions);
      simulation.alpha(1).restart();
    }
    
    function layoutCircular() {
      const radius = Math.min(width, height) / 3;
      const center = { x: width / 2, y: height / 2 };
      
      nodes.forEach((node, i) => {
        const angle = (i / nodes.length) * 2 * Math.PI;
        node.x = center.x + radius * Math.cos(angle);
        node.y = center.y + radius * Math.sin(angle);
      });
      
      updatePositions();
    }
    
    function layoutGrid() {
      const cols = Math.ceil(Math.sqrt(nodes.length));
      const cellWidth = width / (cols + 1);
      const cellHeight = height / (Math.ceil(nodes.length / cols) + 1);
      
      nodes.forEach((node, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        node.x = (col + 1) * cellWidth;
        node.y = (row + 1) * cellHeight;
      });
      
      updatePositions();
    }
    
    function layoutHierarchical() {
      // Simple hierarchical layout based on dependencies
      const levels = new Map();
      const roots = nodes.filter(n => !links.some(l => l.target === n.id));
      
      // BFS to assign levels
      const queue = roots.map(r => ({ node: r, level: 0 }));
      const visited = new Set();
      
      while (queue.length > 0) {
        const { node, level } = queue.shift();
        if (visited.has(node.id)) continue;
        
        visited.add(node.id);
        levels.set(node.id, level);
        
        const children = links
          .filter(l => l.source === node.id || l.source.id === node.id)
          .map(l => nodes.find(n => n.id === l.target || n.id === l.target.id))
          .filter(n => n && !visited.has(n.id));
        
        children.forEach(child => {
          queue.push({ node: child, level: level + 1 });
        });
      }
      
      // Position nodes by level
      const levelGroups = new Map();
      nodes.forEach(node => {
        const level = levels.get(node.id) || 0;
        if (!levelGroups.has(level)) levelGroups.set(level, []);
        levelGroups.get(level).push(node);
      });
      
      const levelHeight = height / (levelGroups.size + 1);
      levelGroups.forEach((group, level) => {
        const levelWidth = width / (group.length + 1);
        group.forEach((node, i) => {
          node.x = (i + 1) * levelWidth;
          node.y = (level + 1) * levelHeight;
        });
      });
      
      updatePositions();
    }
    
    function layoutRadial() {
      const center = { x: width / 2, y: height / 2 };
      const roots = nodes.filter(n => !links.some(l => l.target === n.id));
      
      if (roots.length === 0) {
        layoutCircular();
        return;
      }
      
      // Place root at center
      const root = roots[0];
      root.x = center.x;
      root.y = center.y;
      
      // Place others in circles around root
      const others = nodes.filter(n => n !== root);
      const angleStep = (2 * Math.PI) / others.length;
      
      others.forEach((node, i) => {
        const radius = 100 + Math.random() * 200;
        const angle = i * angleStep;
        node.x = center.x + radius * Math.cos(angle);
        node.y = center.y + radius * Math.sin(angle);
      });
      
      updatePositions();
    }
    
    function updatePositions() {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      
      node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
    }
    
    function searchNodes(query) {
      const lowerQuery = query.toLowerCase();
      
      node.style('opacity', d => {
        const matches = d.name.toLowerCase().includes(lowerQuery) ||
                       d.type.toLowerCase().includes(lowerQuery) ||
                       d.path.toLowerCase().includes(lowerQuery);
        return matches || !query ? 1 : 0.2;
      });
      
      link.style('opacity', query ? 0.2 : 0.6);
    }
    
    function exportSVG() {
      const svgData = new XMLSerializer().serializeToString(svg.node());
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'architecture.svg';
      a.click();
      URL.revokeObjectURL(url);
    }
    
    let simulationRunning = true;
    function toggleSimulation() {
      if (simulationRunning) {
        simulation.stop();
      } else {
        simulation.restart();
      }
      simulationRunning = !simulationRunning;
    }
    
    // WebSocket connection (optional)
    function connectWebSocket() {
      try {
        const socket = io('http://localhost:3001', {
          transports: ['websocket']
        });
        
        socket.on('connect', () => {
          document.getElementById('status-dot').classList.add('connected');
          document.getElementById('status-text').textContent = 'Connected';
          console.log('WebSocket connected');
        });
        
        socket.on('disconnect', () => {
          document.getElementById('status-dot').classList.remove('connected');
          document.getElementById('status-text').textContent = 'Disconnected';
        });
        
        socket.on('telemetry-update', (data) => {
          // Animate nodes based on telemetry
          if (data.nodeActivity) {
            node.select('circle')
              .transition()
              .duration(500)
              .attr('fill-opacity', d => {
                const activity = data.nodeActivity[d.id] || 0;
                return 0.3 + activity * 0.7;
              });
          }
        });
      } catch (error) {
        console.log('WebSocket connection optional - server may not be running');
      }
    }
    
    // Try to connect to WebSocket (optional)
    setTimeout(connectWebSocket, 1000);
  </script>
</body>
</html>`;
}

// Run the demo
analyzeAndVisualize().catch(console.error);
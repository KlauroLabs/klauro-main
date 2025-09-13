#!/usr/bin/env ts-node

import { SystemTopologyAnalyzer } from '../analyzer/system-topology-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ComponentNode, Connection } from '../types';

const REPO_PATH = process.argv[2] || '/Users/michaelshattuck/dev/unravl/proof-of-concept/backend';
const OUTPUT_DIR = path.join(process.cwd(), 'demo-output');

async function runQuickDemo() {
  console.log('🚀 Unravl Quick Demo - Let\'s visualize this codebase!\n');
  console.log(`📁 Analyzing: ${REPO_PATH}`);
  console.log(`💾 Output: ${OUTPUT_DIR}\n`);

  try {
    // Ensure output directory exists
    await fs.ensureDir(OUTPUT_DIR);

    // Step 1: Analyze the repository
    console.log('🔍 Analyzing codebase...');
    const analyzer = new SystemTopologyAnalyzer();
    const result = await analyzer.analyzeTopology(REPO_PATH);
    
    console.log(`\n✅ Analysis Complete!`);
    console.log(`   📦 Components: ${result.components.length}`);
    console.log(`   🔗 Connections: ${result.relationships.length}`);
    
    // Group components by type
    const componentsByType = result.components.reduce((acc, comp) => {
      acc[comp.type] = (acc[comp.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`\n📊 Component Breakdown:`);
    Object.entries(componentsByType).forEach(([type, count]) => {
      console.log(`   - ${type}: ${count}`);
    });

    // Save the analysis data
    const dataPath = path.join(OUTPUT_DIR, 'analysis.json');
    await fs.writeJSON(dataPath, result, { spaces: 2 });
    console.log(`\n💾 Analysis saved to: ${dataPath}`);

    // Generate a simple HTML visualization
    console.log('\n🎨 Generating interactive visualization...');
    const html = generateVisualizationHTML(result.components, result.relationships);
    const htmlPath = path.join(OUTPUT_DIR, 'visualization.html');
    await fs.writeFile(htmlPath, html);
    console.log(`✅ Visualization saved to: ${htmlPath}`);

    // Print instructions
    console.log('\n' + '='.repeat(60));
    console.log('🎉 SUCCESS! Your architecture visualization is ready!');
    console.log('='.repeat(60));
    console.log('\n📖 To view your visualization:');
    console.log(`   1. Open: file://${htmlPath}`);
    console.log(`   2. Or run: open ${htmlPath}`);
    console.log('\n✨ Features:');
    console.log('   • Interactive force-directed graph');
    console.log('   • Drag nodes to rearrange');
    console.log('   • Hover for details');
    console.log('   • Color-coded by component type');
    console.log('   • Multiple layout options');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

function generateVisualizationHTML(components: ComponentNode[], connections: Connection[]): string {
  // Prepare the data for D3.js
  const nodes = components.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    path: c.path,
    complexity: c.metrics?.complexity || 0,
    loc: c.metrics?.linesOfCode || 0
  }));

  const links = connections.map(c => ({
    source: c.from,
    target: c.to,
    type: c.type,
    strength: c.weight || 1
  }));

  return `<!DOCTYPE html>
<html>
<head>
  <title>Unravl - Architecture Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    
    #header {
      background: rgba(255, 255, 255, 0.95);
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    
    #header h1 {
      margin: 0;
      color: #667eea;
      font-size: 24px;
    }
    
    #stats {
      margin-top: 10px;
      color: #666;
      font-size: 14px;
    }
    
    #controls {
      background: white;
      padding: 10px 20px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      display: flex;
      gap: 10px;
      align-items: center;
    }
    
    button {
      padding: 6px 12px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    
    button:hover {
      background: #5a67d8;
    }
    
    select {
      padding: 6px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 13px;
    }
    
    #visualization {
      background: white;
      margin: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      height: calc(100vh - 200px);
      position: relative;
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
    
    .node {
      cursor: pointer;
    }
    
    .node:hover circle {
      stroke-width: 3px;
    }
    
    .link {
      stroke: #999;
      stroke-opacity: 0.6;
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>🗺️ Unravl Architecture Visualization</h1>
    <div id="stats">
      <span>📦 ${nodes.length} components</span> • 
      <span>🔗 ${links.length} connections</span> • 
      <span>📍 ${new Set(components.map(c => c.type)).size} component types</span>
    </div>
  </div>
  
  <div id="controls">
    <button onclick="resetView()">🎯 Reset View</button>
    <button onclick="zoomIn()">🔍 Zoom In</button>
    <button onclick="zoomOut()">🔎 Zoom Out</button>
    <select onchange="changeLayout(this.value)">
      <option value="force">Force Layout</option>
      <option value="circular">Circular</option>
      <option value="grid">Grid</option>
    </select>
  </div>
  
  <div id="visualization">
    <div class="tooltip" id="tooltip"></div>
  </div>

  <script>
    // Data
    const nodes = ${JSON.stringify(nodes)};
    const links = ${JSON.stringify(links)};
    
    // Dimensions
    const width = document.getElementById('visualization').clientWidth;
    const height = document.getElementById('visualization').clientHeight;
    
    // Create SVG
    const svg = d3.select('#visualization')
      .append('svg')
      .attr('width', width)
      .attr('height', height);
    
    const g = svg.append('g');
    
    // Zoom
    const zoom = d3.zoom()
      .scaleExtent([0.1, 10])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    
    svg.call(zoom);
    
    // Color scale
    const color = d3.scaleOrdinal()
      .domain(['class', 'function', 'module', 'interface', 'component'])
      .range(['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#E91E63']);
    
    // Force simulation
    let simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(60))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(20));
    
    // Draw links
    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('class', 'link')
      .attr('stroke-width', d => Math.sqrt(d.strength));
    
    // Draw nodes
    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));
    
    node.append('circle')
      .attr('r', d => 5 + Math.min(d.complexity * 0.5, 10))
      .attr('fill', d => color(d.type))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);
    
    node.append('text')
      .text(d => d.name)
      .attr('x', 0)
      .attr('y', -10)
      .attr('text-anchor', 'middle')
      .style('font-size', '10px')
      .style('font-weight', 'bold');
    
    // Tooltip
    const tooltip = d3.select('#tooltip');
    
    node.on('mouseover', (event, d) => {
      tooltip.style('opacity', 1)
        .html(\`
          <strong>\${d.name}</strong><br>
          Type: \${d.type}<br>
          Path: \${d.path}<br>
          Complexity: \${d.complexity}<br>
          Lines: \${d.loc}
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
    function resetView() {
      svg.transition().call(zoom.transform, d3.zoomIdentity);
    }
    
    function zoomIn() {
      svg.transition().call(zoom.scaleBy, 1.3);
    }
    
    function zoomOut() {
      svg.transition().call(zoom.scaleBy, 0.7);
    }
    
    function changeLayout(layout) {
      simulation.stop();
      
      if (layout === 'circular') {
        const radius = Math.min(width, height) / 3;
        nodes.forEach((node, i) => {
          const angle = (i / nodes.length) * 2 * Math.PI;
          node.x = width/2 + radius * Math.cos(angle);
          node.y = height/2 + radius * Math.sin(angle);
        });
      } else if (layout === 'grid') {
        const cols = Math.ceil(Math.sqrt(nodes.length));
        nodes.forEach((node, i) => {
          node.x = (i % cols + 1) * (width / (cols + 1));
          node.y = (Math.floor(i / cols) + 1) * (height / (Math.ceil(nodes.length/cols) + 1));
        });
      } else {
        // Reset to force
        simulation = d3.forceSimulation(nodes)
          .force('link', d3.forceLink(links).id(d => d.id).distance(60))
          .force('charge', d3.forceManyBody().strength(-200))
          .force('center', d3.forceCenter(width / 2, height / 2))
          .force('collision', d3.forceCollide().radius(20))
          .on('tick', updatePositions);
        simulation.alpha(1).restart();
        return;
      }
      
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
  </script>
</body>
</html>`;
}

// Run the demo
runQuickDemo().catch(console.error);
#!/usr/bin/env ts-node

import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { SpatialLayoutEngine } from '../spatial/spatial-layout-engine';
import { ComponentNode, Connection, ArchitectureBlueprint } from '../types';

const REPO_PATH = process.argv[2] || process.cwd();
const OUTPUT_DIR = path.join(process.cwd(), 'demo-output');

async function analyzeCorebase(repoPath: string): Promise<{ components: ComponentNode[]; connections: Connection[] }> {
  console.log('🔍 Analyzing codebase structure...');
  
  const files = await glob('**/*.ts', {
    cwd: repoPath,
    ignore: ['node_modules/**', 'dist/**', '*.test.ts', '*.spec.ts']
  });

  const components: ComponentNode[] = [];
  const connections: Connection[] = [];
  
  for (const file of files) {
    const fullPath = path.join(repoPath, file);
    const content = await fs.readFile(fullPath, 'utf-8');
    const name = path.basename(file, '.ts');
    const dir = path.dirname(file);
    
    // Determine component type
    let type: any = 'module';
    if (dir.includes('routes')) type = 'api';
    else if (dir.includes('spatial')) type = 'service';
    else if (dir.includes('visualization')) type = 'service';
    else if (dir.includes('analyzer')) type = 'service';
    else if (dir.includes('database')) type = 'database';
    else if (content.includes('export class')) type = 'class';
    else if (content.includes('export interface')) type = 'interface';
    
    const component: ComponentNode = {
      id: file.replace(/[\/\\]/g, '_').replace('.ts', ''),
      name,
      type: type as any,
      path: file,
      dependencies: [],
      dependents: [],
      metadata: {
        lineCount: content.split('\n').length,
        complexity: Math.floor(Math.random() * 10) + 1,
        lastModified: new Date(),
        exports: [],
        imports: [],
        layer: 'business' as any,
        responsibilities: [],
        isEntry: name === 'index'
      }
    };
    
    components.push(component);
    
    // Create some connections based on imports
    const importRegex = /import .* from ['"]\.([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const targetPath = path.join(dir, match[1]).replace(/[\/\\]/g, '_');
      const target = components.find(c => c.id.includes(targetPath));
      if (target) {
        connections.push({
          from: component.id,
          to: target.id,
          type: 'import',
          weight: 1
        });
      }
    }
  }
  
  console.log(`✅ Found ${components.length} components and ${connections.length} connections`);
  return { components, connections };
}

async function createSpatialVisualization() {
  console.log('\n🚀 Unravl Spatial Visualization Demo\n');
  console.log('Creating immersive "Marauder\'s Map" for your codebase...\n');

  try {
    await fs.ensureDir(OUTPUT_DIR);
    
    // Analyze the codebase
    const { components, connections } = await analyzeCorebase(REPO_PATH);
    
    // Create a mock ArchitectureBlueprint
    const blueprint: ArchitectureBlueprint = {
      projectName: 'Unravl Backend',
      framework: 'Node.js/TypeScript',
      components,
      connections,
      entryPoints: [],
      exitPoints: [],
      orphanedComponents: [],
      riskAreas: [],
      metadata: {
        totalComponents: components.length,
        frameworkVersion: '18.2.0',
        analysisDate: new Date(),
        repositoryPath: REPO_PATH,
        entryPointsCount: 3,
        orphanedCount: 0,
        complexityAverage: 4.2,
        primaryLanguage: 'TypeScript',
        languageDistribution: { 'TypeScript': 85, 'JavaScript': 10, 'JSON': 5 },
        codebaseSize: {
            totalLines: 10000,
            codeLines: 7000,
            commentLines: 2000,
            blankLines: 1000
        }
      },
      technologyStack: {
        primaryFramework: {
          name: 'Express',
          version: '4.18.0',
          type: 'api' as any,
          usage: 'primary' as any,
          conventions: [],
          patterns: [],
          detectionConfidence: 0.9
        },
        additionalFrameworks: [],
        languages: [
          { name: 'TypeScript', version: '5.0', fileCount: 50, lineCount: 8500, percentage: 85 },
          { name: 'JavaScript', version: 'ES6', fileCount: 10, lineCount: 1000, percentage: 10 }
        ],
        buildTools: [],
        testingFrameworks: [{ name: 'jest', version: '29.0', type: 'unit' as any }],
        databases: [
          { type: 'postgresql' as any, name: 'main_db', version: '14', usage: 'primary' as any }
        ],
        messageQueues: [],
        caching: [],
        authentication: [],
        deployment: []
      },
      dependencies: {
        totalCount: 45,
        directDependencies: [],
        devDependencies: [],
        peerDependencies: [],
        vulnerabilities: [],
        outdated: [],
        unused: [],
        licenseCompliance: []
      },
      apiEndpoints: [],
      securityAnalysis: {
        vulnerabilities: [],
        authenticationMethods: [],
        authorizationPatterns: [],
        dataEncryption: [],
        inputValidation: [],
        securityHeaders: [],
        secrets: []
      },
      testingInfo: {
        frameworks: [{ name: 'jest', version: '29.0', type: 'unit' as any }],
        coverage: {
          overall: 75,
          lines: { covered: 7500, total: 10000, percentage: 75 },
          branches: { covered: 600, total: 800, percentage: 75 },
          functions: { covered: 450, total: 600, percentage: 75 },
          statements: { covered: 7500, total: 10000, percentage: 75 },
          byComponent: {},
          byType: {},
          uncoveredFiles: []
        },
        testTypes: [{ type: 'unit' as any, count: 30, coverage: 80, tools: ['jest'] }],
        testFiles: [],
        totalTests: 42,
        passingTests: 40,
        failingTests: 2,
        skippedTests: 0,
        testSuites: []
      },
      deploymentInfo: {
        platform: 'aws',
        containerization: { type: 'docker' as any, baseImage: 'node:18-alpine' },
        cicd: {
          platform: 'github-actions',
          configFile: '.github/workflows/ci.yml',
          stages: ['test', 'build', 'deploy'],
          deploymentStrategy: 'rolling',
          automated: true
        },
        monitoring: {
          tools: ['datadog'],
          metrics: ['cpu', 'memory', 'requests'],
          logging: {
            level: 'info',
            destination: 'cloudwatch',
            structured: true,
            aggregation: true
          },
          alerting: {
            platform: 'pagerduty',
            rules: ['high-cpu', 'error-rate'],
            channels: ['email', 'slack']
          }
        },
        scaling: {
          type: 'horizontal' as any,
          automatic: true,
          metrics: ['cpu', 'memory'],
          limits: {
            minInstances: 2,
            maxInstances: 10,
            cpu: '70%',
            memory: '80%'
          }
        }
      }
    };
    
    // Initialize spatial engine
    console.log('🏗️ Generating spatial layout...');
    const spatialEngine = new SpatialLayoutEngine({
      enableRealTimeUpdates: true,
      enableSpatialIndex: true,
      enableAnimations: true
    });
    
    // Generate spatial layout
    const spatialBlueprint = await spatialEngine.generateSpatialLayout(blueprint);
    
    console.log(`\n✅ Spatial layout generated!`);
    console.log(`   🏢 ${spatialBlueprint.buildings.length} buildings`);
    console.log(`   🚪 ${spatialBlueprint.rooms.length} rooms`);
    console.log(`   🛤️ ${spatialBlueprint.hallways.length} hallways`);
    console.log(`   🚗 ${spatialBlueprint.trafficFlows?.length || 0} traffic flows`);
    
    // Save spatial data
    const spatialPath = path.join(OUTPUT_DIR, 'spatial-blueprint.json');
    await fs.writeJSON(spatialPath, spatialBlueprint, { spaces: 2 });
    console.log(`\n💾 Spatial data saved: ${spatialPath}`);
    
    // Generate HTML demo
    const html = generateSpatialHTML(spatialBlueprint);
    const htmlPath = path.join(OUTPUT_DIR, 'spatial.html');
    await fs.writeFile(htmlPath, html);
    console.log(`🎨 Visualization saved: ${htmlPath}`);
    
    console.log('\n' + '='.repeat(60));
    console.log('🗺️ MARAUDER\'S MAP READY!');
    console.log('='.repeat(60));
    console.log('\n📖 Your codebase is now a navigable world:');
    console.log('   • Buildings represent services and modules');
    console.log('   • Rooms represent components and classes');
    console.log('   • Hallways show connections and dependencies');
    console.log('   • Traffic flows show data movement');
    console.log('\n🎮 Controls:');
    console.log('   • WASD: Move around');
    console.log('   • Mouse: Look around');
    console.log('   • Space: Jump');
    console.log('   • Shift: Sprint');
    console.log('   • Ctrl: Crouch');
    console.log('\nTo view: open ' + htmlPath);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

function generateSpatialHTML(spatialBlueprint: any): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Unravl - Marauder's Map for Code</title>
  <style>
    * { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
      background: #000;
    }
    #canvas {
      width: 100vw;
      height: 100vh;
    }
    #info {
      position: absolute;
      top: 20px;
      left: 20px;
      color: white;
      background: rgba(0,0,0,0.7);
      padding: 20px;
      border-radius: 8px;
      font-size: 14px;
      max-width: 300px;
    }
    #info h1 {
      color: #667eea;
      margin-bottom: 10px;
      font-size: 20px;
    }
    #controls {
      position: absolute;
      bottom: 20px;
      left: 20px;
      color: white;
      background: rgba(0,0,0,0.7);
      padding: 15px;
      border-radius: 8px;
      font-size: 12px;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      margin: 5px 0;
    }
    .stat-value {
      color: #667eea;
      font-weight: bold;
    }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
  <canvas id="canvas"></canvas>
  
  <div id="info">
    <h1>🗺️ Marauder's Map</h1>
    <div class="stat">
      <span>Buildings:</span>
      <span class="stat-value">${spatialBlueprint.buildings.length}</span>
    </div>
    <div class="stat">
      <span>Rooms:</span>
      <span class="stat-value">${spatialBlueprint.rooms.length}</span>
    </div>
    <div class="stat">
      <span>Connections:</span>
      <span class="stat-value">${spatialBlueprint.hallways.length}</span>
    </div>
    <div class="stat">
      <span>Active Traffic:</span>
      <span class="stat-value">${spatialBlueprint.trafficFlows?.length || 0}</span>
    </div>
    <hr style="margin: 10px 0; opacity: 0.3;">
    <p style="font-size: 11px; opacity: 0.8; margin-top: 10px;">
      Navigate through your codebase as if walking through buildings. 
      Each room is a component, hallways are dependencies, and the flowing 
      particles represent data movement.
    </p>
  </div>
  
  <div id="controls">
    <strong>Controls:</strong><br>
    WASD - Move | Mouse - Look<br>
    Space - Jump | Shift - Sprint<br>
    Click to start
  </div>

  <script>
    const spatialData = ${JSON.stringify(spatialBlueprint, null, 2)};
    
    // Three.js setup
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x87CEEB, 100, 1000);
    
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 10, 50);
    
    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('canvas'), antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(50, 100, 50);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -100;
    directionalLight.shadow.camera.right = 100;
    directionalLight.shadow.camera.top = 100;
    directionalLight.shadow.camera.bottom = -100;
    scene.add(directionalLight);
    
    // Ground
    const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
    const groundMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x3a3a3a,
      roughness: 0.8,
      metalness: 0.2
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    
    // Grid
    const gridHelper = new THREE.GridHelper(1000, 100, 0x444444, 0x222222);
    scene.add(gridHelper);
    
    // Sky gradient
    const skyGeometry = new THREE.SphereGeometry(500, 32, 32);
    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x0077ff) },
        bottomColor: { value: new THREE.Color(0xffffff) },
        offset: { value: 100 },
        exponent: { value: 0.6 }
      },
      vertexShader: \`
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      \`,
      fragmentShader: \`
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      \`,
      side: THREE.BackSide
    });
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    scene.add(sky);
    
    // Create buildings
    spatialData.buildings.forEach(building => {
      const geometry = new THREE.BoxGeometry(
        building.dimensions.width,
        building.dimensions.height,
        building.dimensions.depth
      );
      
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(building.color),
        transparent: building.material === 'glass',
        opacity: building.material === 'glass' ? 0.7 : 1,
        metalness: building.material === 'steel' ? 0.8 : 0.2,
        roughness: building.material === 'concrete' ? 0.9 : 0.3
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        building.position.x,
        building.position.y + building.dimensions.height / 2,
        building.position.z
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      
      // Add building label
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 256;
      canvas.height = 64;
      context.fillStyle = 'white';
      context.font = '24px Arial';
      context.fillText(building.name, 10, 40);
      
      const texture = new THREE.CanvasTexture(canvas);
      const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(
        building.position.x,
        building.position.y + building.dimensions.height + 5,
        building.position.z
      );
      sprite.scale.set(20, 5, 1);
      scene.add(sprite);
    });
    
    // Create standalone rooms
    spatialData.rooms.filter(room => !room.buildingId).forEach(room => {
      const geometry = new THREE.BoxGeometry(
        room.dimensions.width,
        room.dimensions.height,
        room.dimensions.depth
      );
      
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(room.color),
        emissive: room.glowing ? new THREE.Color(room.color) : undefined,
        emissiveIntensity: room.glowing ? 0.3 : 0
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        room.position.x,
        room.position.y + room.dimensions.height / 2,
        room.position.z
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    });
    
    // Create hallways
    spatialData.hallways.forEach(hallway => {
      if (hallway.path.length < 2) return;
      
      const points = hallway.path.map(p => new THREE.Vector3(p.x, p.y + 0.1, p.z));
      const curve = new THREE.CatmullRomCurve3(points);
      const geometry = new THREE.TubeGeometry(curve, 20, hallway.width / 2, 8, false);
      const material = new THREE.MeshStandardMaterial({
        color: 0x666666,
        metalness: 0.3,
        roughness: 0.7
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      scene.add(mesh);
    });
    
    // Create traffic particles (if available)
    const particleGeometry = new THREE.SphereGeometry(0.5, 8, 8);
    (spatialData.trafficFlows || []).forEach(flow => {
      const vehicle = {
        position: flow.startPosition || {x: 0, y: 1, z: 0},
        color: '#00FF00',
        path: flow.path || [],
        pathIndex: 0
      };
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(vehicle.color),
        emissive: new THREE.Color(vehicle.color),
        emissiveIntensity: 0.5
      });
      
      const mesh = new THREE.Mesh(particleGeometry, material);
      mesh.position.set(vehicle.position.x, vehicle.position.y, vehicle.position.z);
      scene.add(mesh);
      
      // Animate along path
      vehicle.mesh = mesh;
    });
    
    // Controls
    const keys = {};
    let mouseX = 0, mouseY = 0;
    
    document.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
    document.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        camera.rotation.y -= e.movementX * 0.002;
        camera.rotation.x -= e.movementY * 0.002;
        camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.rotation.x));
      }
    });
    
    document.getElementById('canvas').addEventListener('click', () => {
      document.getElementById('canvas').requestPointerLock();
    });
    
    // Animation loop
    function animate() {
      requestAnimationFrame(animate);
      
      // Movement
      const speed = keys['shift'] ? 1 : 0.5;
      if (keys['w']) camera.position.z -= Math.cos(camera.rotation.y) * speed;
      if (keys['w']) camera.position.x -= Math.sin(camera.rotation.y) * speed;
      if (keys['s']) camera.position.z += Math.cos(camera.rotation.y) * speed;
      if (keys['s']) camera.position.x += Math.sin(camera.rotation.y) * speed;
      if (keys['a']) camera.position.x -= Math.cos(camera.rotation.y) * speed;
      if (keys['a']) camera.position.z += Math.sin(camera.rotation.y) * speed;
      if (keys['d']) camera.position.x += Math.cos(camera.rotation.y) * speed;
      if (keys['d']) camera.position.z -= Math.sin(camera.rotation.y) * speed;
      if (keys[' ']) camera.position.y += speed;
      if (keys['control']) camera.position.y -= speed;
      
      // Keep above ground
      camera.position.y = Math.max(2, camera.position.y);
      
      // Animate traffic flows
      (spatialData.trafficFlows || []).forEach(vehicle => {
        if (vehicle.mesh && vehicle.pathIndex < vehicle.path.length - 1) {
          vehicle.pathIndex = (vehicle.pathIndex + 0.01) % vehicle.path.length;
          const idx = Math.floor(vehicle.pathIndex);
          const t = vehicle.pathIndex - idx;
          
          if (vehicle.path[idx] && vehicle.path[idx + 1]) {
            vehicle.mesh.position.lerpVectors(
              new THREE.Vector3(vehicle.path[idx].x, vehicle.path[idx].y, vehicle.path[idx].z),
              new THREE.Vector3(vehicle.path[idx + 1].x, vehicle.path[idx + 1].y, vehicle.path[idx + 1].z),
              t
            );
          }
        }
      });
      
      renderer.render(scene, camera);
    }
    
    animate();
    
    // Handle resize
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>`;
}

// Run the demo
createSpatialVisualization().catch(console.error);
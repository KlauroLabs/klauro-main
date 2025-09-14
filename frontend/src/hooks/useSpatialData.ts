import { useState, useEffect, useCallback } from 'react';
import { SpatialBlueprint, Vehicle } from '@/types/spatial';
import { useWebSocket } from './useWebSocket';

interface UseSpatialDataReturn {
  spatialBlueprint: SpatialBlueprint | null;
  loading: boolean;
  error: string | null;
  updateVehicles: (vehicles: Vehicle[]) => void;
  refreshBlueprint: () => Promise<void>;
}

export const useSpatialData = (
  projectId: string,
  blueprintId?: string,
  enableRealTime: boolean = true
): UseSpatialDataReturn => {
  const [spatialBlueprint, setSpatialBlueprint] = useState<SpatialBlueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { isConnected, data: realtimeData } = useWebSocket(
    enableRealTime ? `ws://localhost:3001/ws/spatial/${projectId}` : null
  );

  const fetchBlueprint = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const url = blueprintId 
        ? `${baseUrl}/api/spatial/blueprints/${blueprintId}`
        : `${baseUrl}/api/spatial/projects/${projectId}/blueprint`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        if (response.status === 404) {
          // Generate sample data for development
          const sampleBlueprint = generateSampleBlueprint(projectId);
          setSpatialBlueprint(sampleBlueprint);
          return;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const blueprint = await response.json();
      setSpatialBlueprint(blueprint);
    } catch (err) {
      console.warn('Failed to fetch spatial blueprint, using sample data:', err);
      // Fallback to sample data for development
      const sampleBlueprint = generateSampleBlueprint(projectId);
      setSpatialBlueprint(sampleBlueprint);
    } finally {
      setLoading(false);
    }
  }, [projectId, blueprintId]);

  const updateVehicles = useCallback((vehicles: Vehicle[]) => {
    setSpatialBlueprint(prev => prev ? { ...prev, vehicles } : null);
  }, []);

  const refreshBlueprint = useCallback(async () => {
    await fetchBlueprint();
  }, [fetchBlueprint]);

  // Initial fetch
  useEffect(() => {
    fetchBlueprint();
  }, [fetchBlueprint]);

  // Handle real-time updates
  useEffect(() => {
    if (realtimeData && spatialBlueprint) {
      try {
        const update = typeof realtimeData === 'string' ? JSON.parse(realtimeData) : realtimeData;
        
        switch (update.type) {
          case 'vehicle_update':
            updateVehicles(update.vehicles);
            break;
            
          case 'room_activity':
            setSpatialBlueprint(prev => prev ? {
              ...prev,
              rooms: prev.rooms.map(room => 
                room.id === update.roomId 
                  ? { ...room, metadata: { ...room.metadata, activityLevel: update.activityLevel } }
                  : room
              )
            } : null);
            break;
            
          case 'building_activity':
            setSpatialBlueprint(prev => prev ? {
              ...prev,
              buildings: prev.buildings.map(building => 
                building.id === update.buildingId 
                  ? { ...building, metadata: { ...building.metadata, activityLevel: update.activityLevel } }
                  : building
              )
            } : null);
            break;
            
          case 'traffic_update':
            setSpatialBlueprint(prev => prev ? {
              ...prev,
              hallways: prev.hallways.map(hallway => 
                update.hallwayTraffic[hallway.id] !== undefined
                  ? { ...hallway, traffic: update.hallwayTraffic[hallway.id] }
                  : hallway
              )
            } : null);
            break;
            
          case 'blueprint_refresh':
            refreshBlueprint();
            break;
        }
      } catch (err) {
        console.error('Error processing real-time update:', err);
      }
    }
  }, [realtimeData, spatialBlueprint, updateVehicles, refreshBlueprint]);

  return {
    spatialBlueprint,
    loading,
    error,
    updateVehicles,
    refreshBlueprint
  };
};

// Generate sample data for development
const generateSampleBlueprint = (projectId: string): SpatialBlueprint => {
  return {
    id: `sample-blueprint-${projectId}`,
    projectId,
    campus: {
      bounds: {
        min: { x: -100, y: 0, z: -100 },
        max: { x: 100, y: 50, z: 100 }
      },
      districts: [
        {
          id: 'frontend-district',
          name: 'Frontend Services',
          type: 'frontend',
          bounds: {
            min: { x: -50, y: 0, z: -50 },
            max: { x: 0, y: 30, z: 50 }
          },
          buildingIds: ['frontend-building'],
          color: '#e91e63'
        },
        {
          id: 'backend-district',
          name: 'Backend Services',
          type: 'backend',
          bounds: {
            min: { x: 0, y: 0, z: -50 },
            max: { x: 50, y: 40, z: 50 }
          },
          buildingIds: ['api-building', 'service-building'],
          color: '#2196f3'
        }
      ],
      mainPaths: [
        {
          id: 'main-highway',
          points: [
            { x: -80, y: 0, z: 0 },
            { x: 0, y: 0, z: 0 },
            { x: 80, y: 0, z: 0 }
          ],
          width: 8,
          type: 'main'
        }
      ]
    },
    buildings: [
      {
        id: 'frontend-building',
        name: 'React Frontend',
        type: 'module',
        position: { x: -25, y: 15, z: 0 },
        dimensions: { width: 30, height: 30, depth: 25 },
        floors: [
          { id: 'f1', level: 0, height: 10, rooms: ['login-screen', 'dashboard-screen'], hallways: ['main-hall'] },
          { id: 'f2', level: 1, height: 10, rooms: ['profile-screen'], hallways: [] },
          { id: 'f3', level: 2, height: 10, rooms: ['settings-screen'], hallways: [] }
        ],
        entrances: [
          { id: 'main-entrance', position: { x: -25, y: 2, z: 12 }, type: 'main', width: 4, height: 8 }
        ],
        metadata: {
          serviceId: 'react-frontend',
          importance: 0.9,
          activityLevel: 0.7
        },
        material: 'glass',
        color: '#e91e63'
      },
      {
        id: 'api-building',
        name: 'REST API Gateway',
        type: 'api',
        position: { x: 25, y: 20, z: -15 },
        dimensions: { width: 25, height: 40, depth: 20 },
        floors: [
          { id: 'api-f1', level: 0, height: 20, rooms: ['auth-service', 'user-service'], hallways: ['api-hall'] },
          { id: 'api-f2', level: 1, height: 20, rooms: ['data-service'], hallways: [] }
        ],
        entrances: [
          { id: 'api-main', position: { x: 25, y: 2, z: -5 }, type: 'main', width: 3, height: 6 }
        ],
        metadata: {
          serviceId: 'api-gateway',
          importance: 1.0,
          activityLevel: 0.9
        },
        material: 'steel',
        color: '#2196f3'
      }
    ],
    rooms: [
      {
        id: 'login-screen',
        name: 'Login Screen',
        type: 'screen',
        position: { x: -35, y: 5, z: 5 },
        dimensions: { width: 8, height: 8, depth: 6 },
        floor: 0,
        buildingId: 'frontend-building',
        metadata: {
          componentId: 'LoginComponent',
          complexity: 0.6,
          linesOfCode: 150,
          importance: 0.8,
          activityLevel: 0.5
        },
        doors: [
          { id: 'login-door', position: 'south', targetRoomId: 'dashboard-screen', isOpen: true, width: 2 }
        ],
        windows: [],
        color: '#f48fb1',
        material: 'glass',
        glowing: false
      },
      {
        id: 'dashboard-screen',
        name: 'Dashboard',
        type: 'screen',
        position: { x: -15, y: 5, z: 5 },
        dimensions: { width: 12, height: 8, depth: 8 },
        floor: 0,
        buildingId: 'frontend-building',
        metadata: {
          componentId: 'DashboardComponent',
          complexity: 0.8,
          linesOfCode: 300,
          importance: 0.9,
          activityLevel: 0.8
        },
        doors: [
          { id: 'dash-door1', position: 'north', targetRoomId: 'login-screen', isOpen: true, width: 2 },
          { id: 'dash-door2', position: 'east', targetRoomId: 'api-building', isOpen: true, width: 3 }
        ],
        windows: [
          { id: 'dash-window', position: 'west', width: 4, height: 3 }
        ],
        color: '#f48fb1',
        material: 'glass',
        glowing: true
      },
      {
        id: 'auth-service',
        name: 'Authentication Service',
        type: 'service',
        position: { x: 15, y: 10, z: -20 },
        dimensions: { width: 10, height: 15, depth: 8 },
        floor: 0,
        buildingId: 'api-building',
        metadata: {
          componentId: 'AuthService',
          complexity: 0.9,
          linesOfCode: 500,
          importance: 1.0,
          activityLevel: 0.9
        },
        doors: [
          { id: 'auth-door', position: 'west', targetRoomId: 'dashboard-screen', isOpen: true, width: 3 }
        ],
        windows: [],
        color: '#64b5f6',
        material: 'steel',
        glowing: true
      }
    ],
    hallways: [
      {
        id: 'main-hall',
        path: [
          { x: -35, y: 2, z: 0 },
          { x: -15, y: 2, z: 0 },
          { x: 0, y: 2, z: 0 },
          { x: 15, y: 2, z: -15 }
        ],
        width: 4,
        height: 6,
        connectsRooms: ['login-screen', 'auth-service'],
        traffic: 65,
        material: 'marble'
      }
    ],
    vehicles: [
      {
        id: 'req-1',
        type: 'request',
        position: { x: -30, y: 3, z: 0 },
        destination: { x: 15, y: 3, z: -15 },
        speed: 2,
        color: '#4caf50',
        size: 0.5,
        pathIndex: 0,
        path: [
          { x: -30, y: 3, z: 0 },
          { x: -15, y: 3, z: 0 },
          { x: 0, y: 3, z: 0 },
          { x: 15, y: 3, z: -15 }
        ]
      },
      {
        id: 'res-1',
        type: 'response',
        position: { x: 10, y: 3, z: -10 },
        destination: { x: -25, y: 3, z: 5 },
        speed: 1.8,
        color: '#2196f3',
        size: 0.4,
        pathIndex: 1,
        path: [
          { x: 15, y: 3, z: -15 },
          { x: 0, y: 3, z: 0 },
          { x: -15, y: 3, z: 0 },
          { x: -25, y: 3, z: 5 }
        ]
      }
    ],
    metadata: {
      totalComponents: 6,
      totalConnections: 4,
      layoutType: 'campus',
      timestamp: new Date()
    },
    viewpoints: [
      {
        id: 'overview',
        name: 'Campus Overview',
        position: { x: 0, y: 100, z: 50 },
        lookAt: { x: 0, y: 0, z: 0 },
        fov: 60,
        description: 'Bird\'s eye view of the entire system'
      },
      {
        id: 'frontend-focus',
        name: 'Frontend District',
        position: { x: -50, y: 40, z: 30 },
        lookAt: { x: -25, y: 15, z: 0 },
        fov: 45,
        description: 'Focus on frontend components and user interfaces'
      }
    ]
  };
};
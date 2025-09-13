import React, { Suspense, useRef, useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Sky, Grid, Stats } from '@react-three/drei';
import { Box, Paper, CircularProgress } from '@mui/material';
import * as THREE from 'three';
import { SpatialBlueprint } from '@/types/spatial';
import { SpatialRoom } from './SpatialRoom';
import { SpatialBuilding } from './SpatialBuilding';
import { SpatialHallway } from './SpatialHallway';
import { TrafficFlow } from './TrafficFlow';
import { SpatialControls } from './SpatialControls';
import { SpatialMinimap } from './SpatialMinimap';
import { useSpatialNavigation } from '@/hooks/useSpatialNavigation';
import { useSpatialData } from '@/hooks/useSpatialData';

interface SpatialVisualizationProps {
  projectId: string;
  blueprintId?: string;
  enableRealTime?: boolean;
  onRoomClick?: (roomId: string) => void;
  onBuildingClick?: (buildingId: string) => void;
}

export const SpatialVisualization: React.FC<SpatialVisualizationProps> = ({
  projectId,
  blueprintId,
  enableRealTime = true,
  onRoomClick,
  onBuildingClick
}) => {
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'first-person' | 'third-person' | 'overview'>('third-person');
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  const [showTraffic, setShowTraffic] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [currentFloor, setCurrentFloor] = useState(0);

  // Load spatial data
  const { 
    spatialBlueprint, 
    loading: dataLoading, 
    error,
    updateVehicles 
  } = useSpatialData(projectId, blueprintId, enableRealTime);

  // Navigation hook
  const {
    cameraPosition,
    cameraRotation,
    moveForward,
    moveBackward,
    moveLeft,
    moveRight,
    jump,
    crouch,
    lookAround
  } = useSpatialNavigation();

  useEffect(() => {
    setLoading(dataLoading);
  }, [dataLoading]);

  const handleRoomClick = (roomId: string) => {
    setSelectedRoom(roomId);
    onRoomClick?.(roomId);
  };

  const handleBuildingClick = (buildingId: string) => {
    setSelectedBuilding(buildingId);
    onBuildingClick?.(buildingId);
  };

  const handleViewModeChange = (mode: typeof viewMode) => {
    setViewMode(mode);
  };

  const handleFloorChange = (floor: number) => {
    setCurrentFloor(floor);
  };

  if (error) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <Paper sx={{ p: 3, backgroundColor: 'error.dark', color: 'error.contrastText' }}>
          Error loading spatial data: {error}
        </Paper>
      </Box>
    );
  }

  if (loading || !spatialBlueprint) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress size={60} />
      </Box>
    );
  }

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Main 3D Canvas */}
      <Canvas
        shadows
        gl={{ 
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance'
        }}
        style={{ background: 'linear-gradient(180deg, #87CEEB 0%, #E0F6FF 50%, #C9E4F5 100%)' }}
      >
        <Suspense fallback={null}>
          {/* Lighting */}
          <ambientLight intensity={0.4} />
          <directionalLight
            position={[50, 100, 50]}
            intensity={1}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-far={200}
            shadow-camera-left={-100}
            shadow-camera-right={100}
            shadow-camera-top={100}
            shadow-camera-bottom={-100}
          />
          <pointLight position={[0, 50, 0]} intensity={0.5} />
          
          {/* Sky */}
          <Sky
            distance={450000}
            sunPosition={[100, 50, 100]}
            inclination={0.6}
            azimuth={0.25}
          />
          
          {/* Ground */}
          <Grid
            infiniteGrid
            fadeDistance={100}
            fadeStrength={1}
            cellSize={10}
            cellThickness={0.5}
            cellColor="#6f6f6f"
            sectionSize={50}
            sectionThickness={1.5}
            sectionColor="#9d9d9d"
            followCamera={false}
          />
          
          {/* Camera */}
          {viewMode === 'third-person' && (
            <OrbitControls
              enablePan={true}
              enableZoom={true}
              enableRotate={true}
              minDistance={10}
              maxDistance={500}
              maxPolarAngle={Math.PI / 2}
            />
          )}
          
          {viewMode === 'first-person' && (
            <PerspectiveCamera
              makeDefault
              position={[cameraPosition.x, cameraPosition.y, cameraPosition.z]}
              rotation={[cameraRotation.x, cameraRotation.y, cameraRotation.z]}
              fov={75}
            />
          )}
          
          {/* Render Buildings */}
          {spatialBlueprint.buildings.map(building => (
            <SpatialBuilding
              key={building.id}
              building={building}
              selected={selectedBuilding === building.id}
              onClick={handleBuildingClick}
              showLabels={showLabels}
              currentFloor={currentFloor}
            />
          ))}
          
          {/* Render Rooms (not in buildings) */}
          {spatialBlueprint.rooms
            .filter(room => !room.buildingId)
            .map(room => (
              <SpatialRoom
                key={room.id}
                room={room}
                selected={selectedRoom === room.id}
                onClick={handleRoomClick}
                showLabel={showLabels}
              />
            ))}
          
          {/* Render Hallways */}
          {spatialBlueprint.hallways.map(hallway => (
            <SpatialHallway
              key={hallway.id}
              hallway={hallway}
              showTraffic={showTraffic}
            />
          ))}
          
          {/* Traffic Flow */}
          {showTraffic && (
            <TrafficFlow
              vehicles={spatialBlueprint.vehicles}
              onUpdate={updateVehicles}
            />
          )}
          
          {/* Performance Stats in Dev */}
          {process.env.NODE_ENV === 'development' && <Stats />}
        </Suspense>
      </Canvas>
      
      {/* UI Overlays */}
      <SpatialControls
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        showTraffic={showTraffic}
        onTrafficToggle={() => setShowTraffic(!showTraffic)}
        showLabels={showLabels}
        onLabelsToggle={() => setShowLabels(!showLabels)}
        currentFloor={currentFloor}
        onFloorChange={handleFloorChange}
        maxFloor={Math.max(...spatialBlueprint.buildings.flatMap(b => b.floors.map(f => f.level)))}
      />
      
      {/* Minimap */}
      <SpatialMinimap
        blueprint={spatialBlueprint}
        cameraPosition={cameraPosition}
        selectedRoom={selectedRoom}
        selectedBuilding={selectedBuilding}
        currentFloor={currentFloor}
      />
    </Box>
  );
};
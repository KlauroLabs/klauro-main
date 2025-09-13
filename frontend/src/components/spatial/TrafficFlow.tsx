import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Instance, Instances, Sphere, Trail } from '@react-three/drei';
import * as THREE from 'three';
import { Vehicle } from '@/types/spatial';

interface TrafficFlowProps {
  vehicles: Vehicle[];
  onUpdate?: (vehicles: Vehicle[]) => void;
}

export const TrafficFlow: React.FC<TrafficFlowProps> = ({ vehicles, onUpdate }) => {
  const vehicleRefs = useRef<Map<string, THREE.Mesh>>(new Map());
  
  // Group vehicles by type for instanced rendering
  const vehiclesByType = useMemo(() => {
    const groups: Record<string, Vehicle[]> = {
      request: [],
      response: [],
      event: [],
      data: []
    };
    
    vehicles.forEach(vehicle => {
      if (groups[vehicle.type]) {
        groups[vehicle.type].push(vehicle);
      }
    });
    
    return groups;
  }, [vehicles]);

  // Animate vehicles along their paths
  useFrame((state, delta) => {
    const updatedVehicles: Vehicle[] = [];
    
    vehicles.forEach(vehicle => {
      const mesh = vehicleRefs.current.get(vehicle.id);
      if (!mesh) return;
      
      // Move along path
      if (vehicle.pathIndex < vehicle.path.length - 1) {
        const currentPos = vehicle.path[vehicle.pathIndex];
        const nextPos = vehicle.path[vehicle.pathIndex + 1];
        
        // Calculate direction
        const direction = new THREE.Vector3(
          nextPos.x - currentPos.x,
          nextPos.y - currentPos.y,
          nextPos.z - currentPos.z
        ).normalize();
        
        // Update position
        const newPosition = new THREE.Vector3(
          vehicle.position.x + direction.x * vehicle.speed * delta,
          vehicle.position.y + direction.y * vehicle.speed * delta,
          vehicle.position.z + direction.z * vehicle.speed * delta
        );
        
        // Check if reached next point
        const distanceToNext = new THREE.Vector3(
          nextPos.x - newPosition.x,
          nextPos.y - newPosition.y,
          nextPos.z - newPosition.z
        ).length();
        
        if (distanceToNext < 0.5) {
          vehicle.pathIndex++;
          vehicle.position = nextPos;
        } else {
          vehicle.position = {
            x: newPosition.x,
            y: newPosition.y,
            z: newPosition.z
          };
        }
        
        // Update mesh position
        mesh.position.set(vehicle.position.x, vehicle.position.y, vehicle.position.z);
        
        // Rotate to face direction
        mesh.lookAt(
          vehicle.position.x + direction.x,
          vehicle.position.y + direction.y,
          vehicle.position.z + direction.z
        );
        
        updatedVehicles.push(vehicle);
      }
    });
    
    if (onUpdate && updatedVehicles.length > 0) {
      onUpdate(updatedVehicles);
    }
  });

  // Get color for vehicle type
  const getVehicleColor = (type: string): string => {
    const colors: Record<string, string> = {
      request: '#00FF00',
      response: '#0000FF',
      event: '#FFFF00',
      data: '#FF00FF'
    };
    return colors[type] || '#FFFFFF';
  };

  return (
    <>
      {/* Render vehicles by type using instanced meshes for performance */}
      {Object.entries(vehiclesByType).map(([type, typeVehicles]) => (
        <Instances key={type} limit={1000}>
          <sphereGeometry args={[0.5, 16, 16]} />
          <meshStandardMaterial
            color={getVehicleColor(type)}
            emissive={getVehicleColor(type)}
            emissiveIntensity={0.5}
            metalness={0.8}
            roughness={0.2}
          />
          
          {typeVehicles.map(vehicle => (
            <VehicleInstance
              key={vehicle.id}
              vehicle={vehicle}
              onRef={(mesh) => {
                if (mesh) vehicleRefs.current.set(vehicle.id, mesh);
              }}
            />
          ))}
        </Instances>
      ))}
      
      {/* Traffic density indicators */}
      {vehicles.length > 50 && <TrafficDensityIndicator vehicleCount={vehicles.length} />}
    </>
  );
};

// Individual vehicle instance
const VehicleInstance: React.FC<{
  vehicle: Vehicle;
  onRef: (mesh: THREE.Mesh | null) => void;
}> = ({ vehicle, onRef }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  
  React.useEffect(() => {
    onRef(meshRef.current);
  }, [meshRef.current, onRef]);
  
  return (
    <Instance
      ref={meshRef}
      position={[vehicle.position.x, vehicle.position.y, vehicle.position.z]}
      scale={[vehicle.size, vehicle.size, vehicle.size]}
    >
      {/* Trail effect for fast-moving vehicles */}
      {vehicle.speed > 10 && (
        <Trail
          width={1}
          length={10}
          color={vehicle.color}
          attenuation={(t) => t * t}
        />
      )}
    </Instance>
  );
};

// Traffic density warning
const TrafficDensityIndicator: React.FC<{ vehicleCount: number }> = ({ vehicleCount }) => {
  const intensity = Math.min(vehicleCount / 100, 1);
  const color = new THREE.Color().setHSL(0.1 - intensity * 0.1, 1, 0.5);
  
  return (
    <group position={[0, 50, 0]}>
      <pointLight
        intensity={intensity * 2}
        color={color}
        distance={100}
      />
      <Sphere args={[2, 16, 16]}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.3 + intensity * 0.3}
        />
      </Sphere>
    </group>
  );
};
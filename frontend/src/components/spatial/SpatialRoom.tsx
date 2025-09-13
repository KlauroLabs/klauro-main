import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import * as THREE from 'three';
import { Room } from '@/types/spatial';

interface SpatialRoomProps {
  room: Room;
  selected: boolean;
  onClick: (roomId: string) => void;
  showLabel: boolean;
}

export const SpatialRoom: React.FC<SpatialRoomProps> = ({
  room,
  selected,
  onClick,
  showLabel
}) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const glowIntensity = useRef(0);

  // Animate glow effect
  useFrame((state, delta) => {
    if (!meshRef.current) return;

    // Pulsing glow for active rooms
    if (room.glowing) {
      glowIntensity.current = Math.sin(state.clock.elapsedTime * 2) * 0.5 + 0.5;
      (meshRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 
        glowIntensity.current * room.metadata.activityLevel;
    }

    // Hover effect
    if (hovered) {
      meshRef.current.scale.lerp(new THREE.Vector3(1.05, 1.05, 1.05), 0.1);
    } else {
      meshRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
    }

    // Selection effect
    if (selected) {
      meshRef.current.rotation.y += delta * 0.5;
    }
  });

  // Material based on room type
  const getMaterial = () => {
    const baseColor = new THREE.Color(room.color);
    const materials: Record<typeof room.material, Partial<THREE.MeshStandardMaterialParameters>> = {
      glass: {
        color: baseColor,
        metalness: 0.1,
        roughness: 0.1,
        transparent: true,
        opacity: 0.7,
        envMapIntensity: 1
      },
      concrete: {
        color: baseColor,
        metalness: 0,
        roughness: 0.9
      },
      steel: {
        color: baseColor,
        metalness: 0.8,
        roughness: 0.2
      },
      wood: {
        color: baseColor,
        metalness: 0,
        roughness: 0.7
      }
    };

    return materials[room.material];
  };

  const handleClick = (e: THREE.Event) => {
    e.stopPropagation();
    onClick(room.id);
  };

  const handlePointerOver = (e: THREE.Event) => {
    e.stopPropagation();
    setHovered(true);
    document.body.style.cursor = 'pointer';
  };

  const handlePointerOut = (e: THREE.Event) => {
    e.stopPropagation();
    setHovered(false);
    document.body.style.cursor = 'default';
  };

  return (
    <group position={[room.position.x, room.position.y, room.position.z]}>
      {/* Room Box */}
      <Box
        ref={meshRef}
        args={[room.dimensions.width, room.dimensions.height, room.dimensions.depth]}
        castShadow
        receiveShadow
        onClick={handleClick}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
      >
        <meshStandardMaterial
          {...getMaterial()}
          emissive={room.glowing ? new THREE.Color(room.color) : undefined}
          emissiveIntensity={room.glowing ? 0.2 : 0}
        />
      </Box>

      {/* Walls (for glass rooms) */}
      {room.material === 'glass' && (
        <>
          {/* Frame edges */}
          <lineSegments>
            <edgesGeometry args={[new THREE.BoxGeometry(
              room.dimensions.width,
              room.dimensions.height,
              room.dimensions.depth
            )]} />
            <lineBasicMaterial color="#333333" linewidth={2} />
          </lineSegments>
        </>
      )}

      {/* Doors */}
      {room.doors.map(door => {
        const doorPosition = getDoorPosition(door.position, room.dimensions);
        return (
          <Box
            key={door.id}
            position={doorPosition}
            args={[door.width, room.dimensions.height * 0.8, 0.2]}
          >
            <meshStandardMaterial color="#8B4513" />
          </Box>
        );
      })}

      {/* Windows */}
      {room.windows.map(window => {
        const windowPosition = getWindowPosition(window.position, room.dimensions);
        return (
          <Box
            key={window.id}
            position={windowPosition}
            args={[window.width, window.height, 0.1]}
          >
            <meshStandardMaterial
              color="#87CEEB"
              transparent
              opacity={0.3}
              metalness={0.8}
              roughness={0.1}
            />
          </Box>
        );
      })}

      {/* Label */}
      {showLabel && (
        <Text
          position={[0, room.dimensions.height / 2 + 2, 0]}
          fontSize={1.5}
          color={selected ? '#FFD700' : '#333333'}
          anchorX="center"
          anchorY="middle"
        >
          {room.name}
        </Text>
      )}

      {/* Activity Indicator */}
      {room.metadata.activityLevel > 0.5 && (
        <pointLight
          position={[0, room.dimensions.height / 2, 0]}
          intensity={room.metadata.activityLevel}
          color={room.color}
          distance={20}
        />
      )}

      {/* Complexity Indicator (particle effect for complex components) */}
      {room.metadata.complexity > 8 && (
        <ComplexityParticles complexity={room.metadata.complexity} />
      )}
    </group>
  );
};

// Helper functions
function getDoorPosition(position: string, dimensions: any): [number, number, number] {
  const y = -dimensions.height / 2 + (dimensions.height * 0.8) / 2;
  switch (position) {
    case 'north': return [0, y, dimensions.depth / 2];
    case 'south': return [0, y, -dimensions.depth / 2];
    case 'east': return [dimensions.width / 2, y, 0];
    case 'west': return [-dimensions.width / 2, y, 0];
    default: return [0, y, 0];
  }
}

function getWindowPosition(position: string, dimensions: any): [number, number, number] {
  const y = dimensions.height / 4;
  switch (position) {
    case 'north': return [0, y, dimensions.depth / 2];
    case 'south': return [0, y, -dimensions.depth / 2];
    case 'east': return [dimensions.width / 2, y, 0];
    case 'west': return [-dimensions.width / 2, y, 0];
    default: return [0, y, 0];
  }
}

// Complexity particles component
const ComplexityParticles: React.FC<{ complexity: number }> = ({ complexity }) => {
  const particlesRef = useRef<THREE.Points>(null);

  useFrame((state) => {
    if (particlesRef.current) {
      particlesRef.current.rotation.y = state.clock.elapsedTime * 0.1;
    }
  });

  const particleCount = Math.min(complexity * 10, 100);
  const positions = new Float32Array(particleCount * 3);
  
  for (let i = 0; i < particleCount; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 10;
    positions[i * 3 + 1] = Math.random() * 10;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
  }

  return (
    <points ref={particlesRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particleCount}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.1}
        color="#FFD700"
        transparent
        opacity={0.6}
        sizeAttenuation
      />
    </points>
  );
};
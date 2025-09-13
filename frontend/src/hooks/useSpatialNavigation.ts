import { useState, useEffect, useCallback, useRef } from 'react';
import * as THREE from 'three';

interface NavigationState {
  cameraPosition: { x: number; y: number; z: number };
  cameraRotation: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  isMoving: boolean;
  isJumping: boolean;
  isCrouching: boolean;
}

export function useSpatialNavigation(initialPosition = { x: 0, y: 10, z: 50 }) {
  const [state, setState] = useState<NavigationState>({
    cameraPosition: initialPosition,
    cameraRotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isMoving: false,
    isJumping: false,
    isCrouching: false
  });

  const keysPressed = useRef<Set<string>>(new Set());
  const mouseDelta = useRef({ x: 0, y: 0 });
  const animationFrame = useRef<number>();

  // Movement constants
  const MOVE_SPEED = 0.5;
  const SPRINT_MULTIPLIER = 2;
  const JUMP_FORCE = 0.3;
  const GRAVITY = -0.01;
  const GROUND_Y = 1.6;
  const CROUCH_HEIGHT = 0.8;
  const NORMAL_HEIGHT = 1.6;
  const MOUSE_SENSITIVITY = 0.002;

  // Handle keyboard input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      keysPressed.current.add(e.key.toLowerCase());
      
      // Prevent default for game controls
      if (['w', 'a', 's', 'd', ' ', 'shift', 'control'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.current.delete(e.key.toLowerCase());
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement) {
        mouseDelta.current.x += e.movementX;
        mouseDelta.current.y += e.movementY;
      }
    };

    const handleClick = () => {
      if (!document.pointerLockElement) {
        document.body.requestPointerLock();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('click', handleClick);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('click', handleClick);
    };
  }, []);

  // Game loop
  useEffect(() => {
    const updateLoop = () => {
      setState(prevState => {
        const newState = { ...prevState };
        const keys = keysPressed.current;
        
        // Calculate movement direction
        let moveX = 0;
        let moveZ = 0;
        
        if (keys.has('w')) moveZ -= 1;
        if (keys.has('s')) moveZ += 1;
        if (keys.has('a')) moveX -= 1;
        if (keys.has('d')) moveX += 1;
        
        // Apply sprint
        const speed = keys.has('shift') ? MOVE_SPEED * SPRINT_MULTIPLIER : MOVE_SPEED;
        
        // Calculate forward/right vectors based on camera rotation
        const forward = new THREE.Vector3(
          Math.sin(newState.cameraRotation.y),
          0,
          Math.cos(newState.cameraRotation.y)
        );
        const right = new THREE.Vector3(
          Math.sin(newState.cameraRotation.y + Math.PI / 2),
          0,
          Math.cos(newState.cameraRotation.y + Math.PI / 2)
        );
        
        // Apply movement
        newState.velocity.x = (forward.x * moveZ + right.x * moveX) * speed;
        newState.velocity.z = (forward.z * moveZ + right.z * moveX) * speed;
        
        // Jumping
        if (keys.has(' ') && !newState.isJumping) {
          newState.velocity.y = JUMP_FORCE;
          newState.isJumping = true;
        }
        
        // Apply gravity
        if (newState.cameraPosition.y > GROUND_Y || newState.velocity.y > 0) {
          newState.velocity.y += GRAVITY;
        } else {
          newState.velocity.y = 0;
          newState.isJumping = false;
          newState.cameraPosition.y = GROUND_Y;
        }
        
        // Crouching
        if (keys.has('control')) {
          newState.isCrouching = true;
          newState.cameraPosition.y = Math.max(CROUCH_HEIGHT, newState.cameraPosition.y - 0.1);
        } else {
          newState.isCrouching = false;
          if (newState.cameraPosition.y < NORMAL_HEIGHT && !newState.isJumping) {
            newState.cameraPosition.y = Math.min(NORMAL_HEIGHT, newState.cameraPosition.y + 0.1);
          }
        }
        
        // Update position
        newState.cameraPosition.x += newState.velocity.x;
        newState.cameraPosition.y += newState.velocity.y;
        newState.cameraPosition.z += newState.velocity.z;
        
        // Apply mouse look
        if (mouseDelta.current.x !== 0 || mouseDelta.current.y !== 0) {
          newState.cameraRotation.y -= mouseDelta.current.x * MOUSE_SENSITIVITY;
          newState.cameraRotation.x = Math.max(
            -Math.PI / 2,
            Math.min(Math.PI / 2, newState.cameraRotation.x - mouseDelta.current.y * MOUSE_SENSITIVITY)
          );
          
          mouseDelta.current.x = 0;
          mouseDelta.current.y = 0;
        }
        
        // Update moving state
        newState.isMoving = Math.abs(newState.velocity.x) > 0.01 || Math.abs(newState.velocity.z) > 0.01;
        
        return newState;
      });
      
      animationFrame.current = requestAnimationFrame(updateLoop);
    };
    
    updateLoop();
    
    return () => {
      if (animationFrame.current) {
        cancelAnimationFrame(animationFrame.current);
      }
    };
  }, []);

  // Navigation methods
  const moveForward = useCallback(() => {
    keysPressed.current.add('w');
  }, []);

  const moveBackward = useCallback(() => {
    keysPressed.current.add('s');
  }, []);

  const moveLeft = useCallback(() => {
    keysPressed.current.add('a');
  }, []);

  const moveRight = useCallback(() => {
    keysPressed.current.add('d');
  }, []);

  const jump = useCallback(() => {
    keysPressed.current.add(' ');
  }, []);

  const crouch = useCallback(() => {
    keysPressed.current.add('control');
  }, []);

  const lookAround = useCallback((deltaX: number, deltaY: number) => {
    mouseDelta.current.x = deltaX;
    mouseDelta.current.y = deltaY;
  }, []);

  const teleportTo = useCallback((position: { x: number; y: number; z: number }) => {
    setState(prev => ({
      ...prev,
      cameraPosition: position,
      velocity: { x: 0, y: 0, z: 0 }
    }));
  }, []);

  return {
    ...state,
    moveForward,
    moveBackward,
    moveLeft,
    moveRight,
    jump,
    crouch,
    lookAround,
    teleportTo
  };
}
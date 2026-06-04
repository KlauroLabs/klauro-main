import { useState, useCallback, useEffect } from 'react';
import { ViewTransform } from '../types/diagram.types';

export const useDragAndZoom = () => {
  const [viewTransform, setViewTransform] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Check if we're clicking on the background/canvas, not on components
    const target = e.target as HTMLElement;
    const isComponentClick = target.closest('[data-component]') || target.closest('.component-card');

    if (!isComponentClick) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - viewTransform.x, y: e.clientY - viewTransform.y });
      e.preventDefault();
    }
  }, [viewTransform]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragStart) {
      setViewTransform(prev => ({
        ...prev,
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      }));
    }
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
  }, []);

  // Add global mouse event listeners for proper dragging
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseMove = (e: MouseEvent) => {
        if (dragStart) {
          setViewTransform(prev => ({
            ...prev,
            x: e.clientX - dragStart.x,
            y: e.clientY - dragStart.y
          }));
        }
      };

      const handleGlobalMouseUp = () => {
        setIsDragging(false);
        setDragStart(null);
      };

      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleGlobalMouseMove);
        document.removeEventListener('mouseup', handleGlobalMouseUp);
      };
    }
  }, [isDragging, dragStart]);

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    setViewTransform(prev => ({
      ...prev,
      scale: direction === 'in' ?
        Math.min(prev.scale * 1.2, 3) :
        Math.max(prev.scale / 1.2, 0.3)
    }));
  }, []);

  const handleResetView = useCallback(() => {
    setViewTransform({ x: 0, y: 0, scale: 1 });
  }, []);

  return {
    viewTransform,
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleZoom,
    handleResetView
  };
};
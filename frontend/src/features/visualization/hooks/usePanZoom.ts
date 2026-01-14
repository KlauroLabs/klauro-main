import { useState, useCallback, useEffect, useRef } from 'react';

export interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

export interface UsePanZoomOptions {
  minScale?: number;
  maxScale?: number;
  scaleStep?: number;
  initialTransform?: ViewTransform;
}

export interface UsePanZoomResult {
  viewTransform: ViewTransform;
  isDragging: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: () => void;
  handleWheel: (e: React.WheelEvent) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  fitToContent: (contentBounds: { width: number; height: number }) => void;
  panTo: (x: number, y: number) => void;
  setZoom: (scale: number) => void;
}

const DEFAULT_OPTIONS: Required<UsePanZoomOptions> = {
  minScale: 0.1,
  maxScale: 4,
  scaleStep: 0.2,
  initialTransform: { x: 0, y: 0, scale: 1 },
};

export function usePanZoom(options: UsePanZoomOptions = {}): UsePanZoomResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const containerRef = useRef<HTMLDivElement>(null);

  const [viewTransform, setViewTransform] = useState<ViewTransform>(opts.initialTransform);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isComponentClick = target.closest('[data-component]') ||
                             target.closest('.node-card') ||
                             target.closest('button');

    if (!isComponentClick && e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - viewTransform.x, y: e.clientY - viewTransform.y });
      e.preventDefault();
    }
  }, [viewTransform.x, viewTransform.y]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragStart) {
      setViewTransform(prev => ({
        ...prev,
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      }));
    }
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -opts.scaleStep : opts.scaleStep;

    setViewTransform(prev => {
      const newScale = Math.min(opts.maxScale, Math.max(opts.minScale, prev.scale + delta));

      if (!containerRef.current) return { ...prev, scale: newScale };

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const scaleChange = newScale / prev.scale;
      const newX = mouseX - (mouseX - prev.x) * scaleChange;
      const newY = mouseY - (mouseY - prev.y) * scaleChange;

      return { x: newX, y: newY, scale: newScale };
    });
  }, [opts.maxScale, opts.minScale, opts.scaleStep]);

  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseMove = (e: MouseEvent) => {
        if (dragStart) {
          setViewTransform(prev => ({
            ...prev,
            x: e.clientX - dragStart.x,
            y: e.clientY - dragStart.y,
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

  const zoomIn = useCallback(() => {
    setViewTransform(prev => ({
      ...prev,
      scale: Math.min(opts.maxScale, prev.scale + opts.scaleStep),
    }));
  }, [opts.maxScale, opts.scaleStep]);

  const zoomOut = useCallback(() => {
    setViewTransform(prev => ({
      ...prev,
      scale: Math.max(opts.minScale, prev.scale - opts.scaleStep),
    }));
  }, [opts.minScale, opts.scaleStep]);

  const resetView = useCallback(() => {
    setViewTransform(opts.initialTransform);
  }, [opts.initialTransform]);

  const fitToContent = useCallback((contentBounds: { width: number; height: number }) => {
    if (!containerRef.current) return;

    const container = containerRef.current.getBoundingClientRect();
    const padding = 50;

    const scaleX = (container.width - padding * 2) / contentBounds.width;
    const scaleY = (container.height - padding * 2) / contentBounds.height;
    const scale = Math.min(scaleX, scaleY, opts.maxScale);

    const x = (container.width - contentBounds.width * scale) / 2;
    const y = (container.height - contentBounds.height * scale) / 2;

    setViewTransform({ x, y, scale: Math.max(opts.minScale, scale) });
  }, [opts.maxScale, opts.minScale]);

  const panTo = useCallback((x: number, y: number) => {
    setViewTransform(prev => ({ ...prev, x, y }));
  }, []);

  const setZoom = useCallback((scale: number) => {
    setViewTransform(prev => ({
      ...prev,
      scale: Math.min(opts.maxScale, Math.max(opts.minScale, scale)),
    }));
  }, [opts.maxScale, opts.minScale]);

  return {
    viewTransform,
    isDragging,
    containerRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    zoomIn,
    zoomOut,
    resetView,
    fitToContent,
    panTo,
    setZoom,
  };
}

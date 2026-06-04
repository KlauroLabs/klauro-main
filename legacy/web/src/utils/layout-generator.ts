export interface LayoutComponent {
  id: string;
  name: string;
  type: string;
  level: number;
  connections: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  position?: {
    x: number;
    y: number;
  };
  dimensions?: {
    width: number;
    height: number;
  };
  metadata?: Record<string, any>;
}

export interface LayoutBounds {
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface LayoutResult {
  components: LayoutComponent[];
  bounds: LayoutBounds;
}

export function generateLayeredLayout(
  components: LayoutComponent[],
  containerWidth: number = 1200,
  containerHeight: number = 800
): LayoutResult {
  const layoutComponents = [...components];

  const levels = new Map<number, LayoutComponent[]>();
  layoutComponents.forEach(comp => {
    const level = comp.level || 0;
    if (!levels.has(level)) {
      levels.set(level, []);
    }
    levels.get(level)!.push(comp);
  });

  const sortedLevels = Array.from(levels.keys()).sort((a, b) => a - b);
  const levelHeight = containerHeight / (sortedLevels.length || 1);
  const padding = 50;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  sortedLevels.forEach((level, levelIndex) => {
    const levelComponents = levels.get(level)!;
    const componentWidth = Math.max(120, (containerWidth - padding * 2) / Math.max(levelComponents.length, 1) - 20);
    const y = padding + levelIndex * levelHeight;

    levelComponents.forEach((comp, compIndex) => {
      const x = padding + compIndex * (componentWidth + 20);

      comp.x = x;
      comp.y = y;
      comp.width = componentWidth;
      comp.height = Math.min(levelHeight * 0.6, 100);

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + componentWidth);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + comp.height);
    });
  });

  return {
    components: layoutComponents,
    bounds: {
      width: maxX - minX,
      height: maxY - minY,
      minX: minX || 0,
      maxX: maxX || containerWidth,
      minY: minY || 0,
      maxY: maxY || containerHeight
    }
  };
}

export function generateForceLayout(
  components: LayoutComponent[],
  connections: Array<{ source: string; target: string }> = [],
  containerWidth: number = 1200,
  containerHeight: number = 800
): LayoutResult {
  const layoutComponents = [...components];

  layoutComponents.forEach((comp, index) => {
    const angle = (index / layoutComponents.length) * 2 * Math.PI;
    const radius = Math.min(containerWidth, containerHeight) * 0.3;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    comp.x = centerX + Math.cos(angle) * radius;
    comp.y = centerY + Math.sin(angle) * radius;
    comp.width = 120;
    comp.height = 80;
  });

  const iterations = 100;
  const repulsionStrength = 1000;
  const attractionStrength = 0.1;
  const damping = 0.85;

  for (let iter = 0; iter < iterations; iter++) {
    layoutComponents.forEach((comp1, i) => {
      let fx = 0, fy = 0;

      layoutComponents.forEach((comp2, j) => {
        if (i !== j) {
          const dx = comp2.x! - comp1.x!;
          const dy = comp2.y! - comp1.y!;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const repulsion = repulsionStrength / (distance * distance);
          fx -= (dx / distance) * repulsion;
          fy -= (dy / distance) * repulsion;
        }
      });

      connections.forEach(conn => {
        if (conn.source === comp1.id) {
          const target = layoutComponents.find(c => c.id === conn.target);
          if (target) {
            const dx = target.x! - comp1.x!;
            const dy = target.y! - comp1.y!;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;
            const attraction = (distance - 150) * attractionStrength;
            fx += (dx / distance) * attraction;
            fy += (dy / distance) * attraction;
          }
        }
      });

      comp1.x = Math.max(50, Math.min(containerWidth - 50, comp1.x! + fx * damping));
      comp1.y = Math.max(50, Math.min(containerHeight - 50, comp1.y! + fy * damping));
    });
  }

  const bounds = layoutComponents.reduce(
    (acc, comp) => ({
      minX: Math.min(acc.minX, comp.x!),
      maxX: Math.max(acc.maxX, comp.x! + comp.width!),
      minY: Math.min(acc.minY, comp.y!),
      maxY: Math.max(acc.maxY, comp.y! + comp.height!),
      width: 0,
      height: 0
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, width: 0, height: 0 }
  );

  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  return {
    components: layoutComponents,
    bounds
  };
}
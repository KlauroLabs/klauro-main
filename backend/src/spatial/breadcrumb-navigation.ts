import { Injectable } from '@nestjs/common';
import { 
  NavigationHierarchy, 
  BreadcrumbItem, 
  HierarchyLevel, 
  NavigationNodeType,
  HierarchicalNavigationService 
} from './hierarchical-navigation';

export interface BreadcrumbNavigationOptions {
  maxItems?: number;
  showIcons?: boolean;
  showLevels?: boolean;
  compactMode?: boolean;
  enableShortcuts?: boolean;
}

export interface NavigationShortcut {
  id: string;
  name: string;
  nodeId: string;
  level: HierarchyLevel;
  icon: string;
  hotkey?: string;
  description: string;
}

export interface BreadcrumbRenderOptions {
  separator?: string;
  homeIcon?: string;
  levelIcons?: Record<HierarchyLevel, string>;
  maxWidth?: number;
  truncateStrategy?: 'start' | 'middle' | 'end' | 'smart';
}

@Injectable()
export class BreadcrumbNavigationService {
  private shortcuts: Map<string, NavigationShortcut> = new Map();
  private navigationHistory: string[] = [];
  private readonly MAX_HISTORY_SIZE = 50;

  constructor(private hierarchicalNav: HierarchicalNavigationService) {
    this.initializeDefaultShortcuts();
  }

  /**
   * Generate breadcrumb navigation for current location
   */
  generateBreadcrumbs(
    currentNodeId: string,
    options: BreadcrumbNavigationOptions = {}
  ): BreadcrumbItem[] {
    const context = this.hierarchicalNav.getNavigationContext(currentNodeId);
    let breadcrumbs = [...context.breadcrumbs];

    // Apply max items limit
    if (options.maxItems && breadcrumbs.length > options.maxItems) {
      breadcrumbs = this.truncateBreadcrumbs(breadcrumbs, options.maxItems);
    }

    // Add navigation state
    breadcrumbs = breadcrumbs.map((crumb, index) => ({
      ...crumb,
      active: index === breadcrumbs.length - 1,
      navigable: index < breadcrumbs.length - 1
    }));

    return breadcrumbs;
  }

  /**
   * Render breadcrumbs as formatted string/HTML
   */
  renderBreadcrumbs(
    breadcrumbs: BreadcrumbItem[],
    renderOptions: BreadcrumbRenderOptions = {}
  ): string {
    const {
      separator = ' > ',
      homeIcon = '🏠',
      levelIcons = this.getDefaultLevelIcons(),
      maxWidth = 100,
      truncateStrategy = 'smart'
    } = renderOptions;

    // Apply truncation if needed
    const truncatedBreadcrumbs = this.applyTruncation(
      breadcrumbs, 
      maxWidth, 
      truncateStrategy
    );

    const parts: string[] = [];
    
    for (let i = 0; i < truncatedBreadcrumbs.length; i++) {
      const crumb = truncatedBreadcrumbs[i];
      const icon = crumb.level === HierarchyLevel.SYSTEM ? homeIcon : levelIcons[crumb.level];
      
      let part = '';
      
      // Add icon if requested
      if (icon) {
        part += `${icon} `;
      }
      
      // Add level indicator if requested
      if (renderOptions.levelIcons) {
        part += `[L${crumb.level}] `;
      }
      
      // Add name
      part += crumb.name;
      
      // Make clickable if not active
      if (!crumb.active) {
        part = `<span class="breadcrumb-link" data-node-id="${crumb.id}">${part}</span>`;
      } else {
        part = `<span class="breadcrumb-active">${part}</span>`;
      }
      
      parts.push(part);
    }

    return parts.join(separator);
  }

  /**
   * Get contextual navigation shortcuts for current location
   */
  getContextualShortcuts(currentNodeId: string): NavigationShortcut[] {
    const context = this.hierarchicalNav.getNavigationContext(currentNodeId);
    const shortcuts: NavigationShortcut[] = [];

    // Add parent shortcuts (up the hierarchy)
    for (const crumb of context.breadcrumbs) {
      if (crumb.id !== currentNodeId) {
        const shortcut: NavigationShortcut = {
          id: `shortcut_${crumb.id}`,
          name: crumb.name,
          nodeId: crumb.id,
          level: crumb.level,
          icon: this.getIconForNodeType(crumb.type),
          description: `Navigate to ${crumb.name} (${crumb.type})`
        };
        shortcuts.push(shortcut);
      }
    }

    // Add sibling shortcuts
    const siblings = context.siblings.slice(0, 5); // Limit to 5 siblings
    for (const sibling of siblings) {
      shortcuts.push({
        id: `shortcut_${sibling.id}`,
        name: sibling.name,
        nodeId: sibling.id,
        level: sibling.level,
        icon: this.getIconForNodeType(sibling.type),
        description: `Navigate to sibling: ${sibling.name}`
      });
    }

    // Add frequently accessed shortcuts
    shortcuts.push(...this.getFrequentlyUsedShortcuts());

    // Add recent history shortcuts
    shortcuts.push(...this.getHistoryShortcuts(5));

    return shortcuts;
  }

  /**
   * Navigate using breadcrumb
   */
  navigateViaBreadcrumb(breadcrumbIndex: number, currentBreadcrumbs: BreadcrumbItem[]): string {
    if (breadcrumbIndex < 0 || breadcrumbIndex >= currentBreadcrumbs.length) {
      throw new Error('Invalid breadcrumb index');
    }

    const targetCrumb = currentBreadcrumbs[breadcrumbIndex];
    this.addToHistory(targetCrumb.id);
    
    return targetCrumb.id;
  }

  /**
   * Navigate using shortcut
   */
  navigateViaShortcut(shortcutId: string): string {
    const shortcut = this.shortcuts.get(shortcutId);
    if (!shortcut) {
      throw new Error(`Shortcut not found: ${shortcutId}`);
    }

    this.addToHistory(shortcut.nodeId);
    return shortcut.nodeId;
  }

  /**
   * Add custom navigation shortcut
   */
  addShortcut(shortcut: NavigationShortcut): void {
    this.shortcuts.set(shortcut.id, shortcut);
  }

  /**
   * Remove navigation shortcut
   */
  removeShortcut(shortcutId: string): void {
    this.shortcuts.delete(shortcutId);
  }

  /**
   * Get navigation history
   */
  getNavigationHistory(limit: number = 10): string[] {
    return this.navigationHistory.slice(-limit).reverse();
  }

  /**
   * Go back in navigation history
   */
  navigateBack(): string | null {
    if (this.navigationHistory.length < 2) {
      return null;
    }

    // Remove current location and return previous
    this.navigationHistory.pop();
    return this.navigationHistory[this.navigationHistory.length - 1];
  }

  /**
   * Clear navigation history
   */
  clearHistory(): void {
    this.navigationHistory = [];
  }

  /**
   * Generate quick navigation menu
   */
  generateQuickNavigation(currentNodeId: string): {
    currentLocation: NavigationHierarchy;
    quickActions: NavigationShortcut[];
    levelNavigation: { level: HierarchyLevel; nodes: NavigationShortcut[] }[];
    recentHistory: NavigationShortcut[];
  } {
    const context = this.hierarchicalNav.getNavigationContext(currentNodeId);
    const stats = this.hierarchicalNav.getHierarchyStats();

    // Generate level-based navigation
    const levelNavigation: { level: HierarchyLevel; nodes: NavigationShortcut[] }[] = [];
    
    for (let level = HierarchyLevel.SYSTEM; level <= HierarchyLevel.FUNCTION; level++) {
      const nodesAtLevel = this.hierarchicalNav.getNodesByLevel(level).slice(0, 10);
      const shortcuts = nodesAtLevel.map(node => ({
        id: `level_nav_${node.id}`,
        name: node.name,
        nodeId: node.id,
        level: node.level,
        icon: this.getIconForNodeType(node.type),
        description: `${node.metadata.componentCount} components, complexity: ${node.metadata.complexity}`
      }));

      if (shortcuts.length > 0) {
        levelNavigation.push({
          level,
          nodes: shortcuts
        });
      }
    }

    return {
      currentLocation: context.currentNode,
      quickActions: this.getContextualShortcuts(currentNodeId).slice(0, 8),
      levelNavigation,
      recentHistory: this.getHistoryShortcuts(5)
    };
  }

  /**
   * Generate navigation breadcrumb trail with enhanced metadata
   */
  generateEnhancedBreadcrumbs(currentNodeId: string): {
    breadcrumbs: (BreadcrumbItem & {
      metadata: {
        componentCount: number;
        complexity: number;
        framework?: string;
        layer: string;
        hasChildren: boolean;
        depth: number;
      };
    })[];
    navigation: {
      canGoUp: boolean;
      canGoDown: boolean;
      siblingCount: number;
      childCount: number;
    };
  } {
    const context = this.hierarchicalNav.getNavigationContext(currentNodeId);
    
    const enhancedBreadcrumbs = context.breadcrumbs.map((crumb, index) => {
      const node = this.hierarchicalNav['hierarchyCache'].get(crumb.id);
      
      return {
        ...crumb,
        metadata: {
          componentCount: node?.metadata.componentCount || 0,
          complexity: node?.metadata.complexity || 0,
          framework: node?.metadata.framework,
          layer: node?.metadata.layer || '',
          hasChildren: (node?.children.length || 0) > 0,
          depth: index
        }
      };
    });

    return {
      breadcrumbs: enhancedBreadcrumbs,
      navigation: {
        canGoUp: !!context.currentNode.parent,
        canGoDown: context.children.length > 0,
        siblingCount: context.siblings.length,
        childCount: context.children.length
      }
    };
  }

  // Private helper methods

  private truncateBreadcrumbs(breadcrumbs: BreadcrumbItem[], maxItems: number): BreadcrumbItem[] {
    if (breadcrumbs.length <= maxItems) {
      return breadcrumbs;
    }

    // Always keep first (root) and last (current) items
    if (maxItems < 2) {
      return [breadcrumbs[breadcrumbs.length - 1]];
    }

    const first = breadcrumbs[0];
    const last = breadcrumbs[breadcrumbs.length - 1];
    const middle = breadcrumbs.slice(1, -1);
    
    // Calculate how many middle items we can keep
    const middleCount = maxItems - 2;
    
    if (middleCount <= 0) {
      return [first, last];
    }

    if (middle.length <= middleCount) {
      return breadcrumbs;
    }

    // Take items from end (closer to current location)
    const selectedMiddle = middle.slice(-middleCount);
    
    return [first, ...selectedMiddle, last];
  }

  private applyTruncation(
    breadcrumbs: BreadcrumbItem[],
    maxWidth: number,
    strategy: 'start' | 'middle' | 'end' | 'smart'
  ): BreadcrumbItem[] {
    const totalLength = breadcrumbs.reduce((sum, crumb) => sum + crumb.name.length, 0);
    
    if (totalLength <= maxWidth) {
      return breadcrumbs;
    }

    switch (strategy) {
      case 'smart':
        return this.smartTruncation(breadcrumbs, maxWidth);
      case 'start':
        return breadcrumbs.slice(-(Math.floor(maxWidth / 20)));
      case 'end':
        return breadcrumbs.slice(0, Math.floor(maxWidth / 20));
      case 'middle':
        const keepCount = Math.floor(maxWidth / 40);
        return [
          ...breadcrumbs.slice(0, keepCount),
          ...breadcrumbs.slice(-keepCount)
        ];
      default:
        return breadcrumbs;
    }
  }

  private smartTruncation(breadcrumbs: BreadcrumbItem[], maxWidth: number): BreadcrumbItem[] {
    // Smart truncation: keep important levels and current location
    const important = breadcrumbs.filter(crumb => 
      crumb.level === HierarchyLevel.SYSTEM ||
      crumb.level === HierarchyLevel.SERVICE ||
      crumb.active
    );

    if (important.reduce((sum, crumb) => sum + crumb.name.length, 0) <= maxWidth) {
      // Fill in additional items if we have room
      const remaining = breadcrumbs.filter(crumb => !important.includes(crumb));
      const additionalSpace = maxWidth - important.reduce((sum, crumb) => sum + crumb.name.length, 0);
      
      for (const crumb of remaining) {
        if (crumb.name.length <= additionalSpace) {
          important.push(crumb);
        }
      }
    }

    return important.sort((a, b) => breadcrumbs.indexOf(a) - breadcrumbs.indexOf(b));
  }

  private getDefaultLevelIcons(): Record<HierarchyLevel, string> {
    return {
      [HierarchyLevel.SYSTEM]: '🏠',
      [HierarchyLevel.SERVICE]: '🏢',
      [HierarchyLevel.LAYER]: '📚',
      [HierarchyLevel.MODULE]: '📦',
      [HierarchyLevel.COMPONENT]: '🔧',
      [HierarchyLevel.FUNCTION]: '⚙️'
    };
  }

  private getIconForNodeType(type: NavigationNodeType): string {
    const icons: Record<NavigationNodeType, string> = {
      [NavigationNodeType.SYSTEM]: '🏠',
      [NavigationNodeType.BUILDING]: '🏢',
      [NavigationNodeType.FLOOR]: '📚',
      [NavigationNodeType.ZONE]: '🗂️',
      [NavigationNodeType.ROOM]: '🏠',
      [NavigationNodeType.COMPONENT]: '🔧',
      [NavigationNodeType.FUNCTION]: '⚙️'
    };

    return icons[type] || '📄';
  }

  private initializeDefaultShortcuts(): void {
    // Add common navigation shortcuts
    this.shortcuts.set('go-to-root', {
      id: 'go-to-root',
      name: 'System Root',
      nodeId: 'system_root',
      level: HierarchyLevel.SYSTEM,
      icon: '🏠',
      hotkey: 'Ctrl+Home',
      description: 'Go to system root'
    });
  }

  private getFrequentlyUsedShortcuts(): NavigationShortcut[] {
    // In a real implementation, this would track usage statistics
    return Array.from(this.shortcuts.values())
      .filter(s => s.hotkey) // Shortcuts with hotkeys are considered frequently used
      .slice(0, 3);
  }

  private getHistoryShortcuts(limit: number): NavigationShortcut[] {
    const recentNodeIds = this.getNavigationHistory(limit);
    const shortcuts: NavigationShortcut[] = [];

    for (const nodeId of recentNodeIds) {
      const node = this.hierarchicalNav['hierarchyCache'].get(nodeId);
      if (node) {
        shortcuts.push({
          id: `history_${nodeId}`,
          name: node.name,
          nodeId: nodeId,
          level: node.level,
          icon: this.getIconForNodeType(node.type),
          description: `Recent: ${node.name}`
        });
      }
    }

    return shortcuts;
  }

  private addToHistory(nodeId: string): void {
    // Remove if already exists to avoid duplicates
    const existingIndex = this.navigationHistory.indexOf(nodeId);
    if (existingIndex !== -1) {
      this.navigationHistory.splice(existingIndex, 1);
    }

    // Add to end
    this.navigationHistory.push(nodeId);

    // Maintain max size
    if (this.navigationHistory.length > this.MAX_HISTORY_SIZE) {
      this.navigationHistory.shift();
    }
  }
}
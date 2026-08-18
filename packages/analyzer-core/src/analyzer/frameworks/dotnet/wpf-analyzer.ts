import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface WpfWindow {
  nodeId: string;
  name: string;
  filePath: string;
  xamlPath?: string;
  baseClass: string;
  dataContext?: string;
  controls: WpfControl[];
  eventHandlers: string[];
  commands: string[];
  resourceDictionaries: string[];
}

interface WpfUserControl {
  nodeId: string;
  name: string;
  filePath: string;
  xamlPath?: string;
  dependencyProperties: WpfDependencyProperty[];
  events: string[];
}

interface WpfViewModel {
  nodeId: string;
  name: string;
  filePath: string;
  properties: WpfProperty[];
  commands: WpfCommand[];
  implementsINotifyPropertyChanged: boolean;
  boundWindow?: string;
}

interface WpfControl {
  name: string;
  type: string;
  bindings: WpfBinding[];
}

interface WpfBinding {
  property: string;
  path: string;
  mode?: string;
  converter?: string;
}

interface WpfDependencyProperty {
  name: string;
  type: string;
  ownerType: string;
  defaultValue?: string;
}

interface WpfCommand {
  name: string;
  type: string;
  executeMethod?: string;
  canExecuteMethod?: string;
}

interface WpfProperty {
  name: string;
  type: string;
  hasNotification: boolean;
}

interface WpfService {
  nodeId: string;
  name: string;
  filePath: string;
  interfaces: string[];
  methods: Array<{ name: string; returnType?: string; parameters: string[] }>;
}

interface WpfConverter {
  nodeId: string;
  name: string;
  filePath: string;
  implementsIValueConverter: boolean;
  implementsIMultiValueConverter: boolean;
}

interface WpfEventHandlerBinding {
  event: string;
  method: string;
}

export class WPFAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'wpf',
      'WPF Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const csprojFiles = await glob(['**/*.csproj'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      for (const csproj of csprojFiles) {
        const content = await fs.readFile(path.join(projectPath, csproj), 'utf-8');
        if (this.detectWpfProject(content)) {
          return true;
        }
      }

      const xamlFiles = await glob(['**/*.xaml'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      return xamlFiles.length > 0;
    } catch {
      return false;
    }
  }

  private detectWpfProject(csprojContent: string): boolean {
    const wpfIndicators = [
      /PresentationCore/i,
      /PresentationFramework/i,
      /WindowsBase/i,
      /<UseWPF>true<\/UseWPF>/i,
      /System\.Windows/,
      /<OutputType>WinExe<\/OutputType>/i,
      /Xamarin\.Forms/i,
      /Xamarin\.Mac/i
    ];

    return wpfIndicators.some(pattern => pattern.test(csprojContent));
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const newNodes: CASNode[] = [];
    const enhancedNodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    const existingNodes = context.existingAnalysis?.flatMap(contribution => contribution.nodes || []) || [];

    try {
      const ignorePatterns = [
        '**/bin/**', '**/obj/**', '**/.git/**', '**/packages/**',
        '**/node_modules/**', '**/TestResults/**'
      ];

      const csFiles = await glob(['**/*.cs'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), ...ignorePatterns],
        nodir: true
      });

      const xamlFiles = await glob(['**/*.xaml'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), ...ignorePatterns],
        nodir: true
      });

      const windows = await this.analyzeWindows(csFiles, xamlFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, entryPoints);
      const userControls = await this.analyzeUserControls(csFiles, xamlFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, entryPoints);
      const viewModels = await this.analyzeViewModels(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, windows, entryPoints);
      const services = await this.analyzeServices(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes);
      const converters = await this.analyzeConverters(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes);

      this.buildMvvmRelationships(windows, viewModels, services, edges);
      this.buildDataBindingRelationships(windows, userControls, viewModels, edges);
      this.buildConverterRelationships(converters, windows, userControls, edges);
      this.identifyEntryPoints(windows, entryPoints);
      await this.identifyServiceEntryPoints(csFiles, context.projectPath, existingNodes, newNodes, entryPoints);
      await this.identifyAppStartupEntryPoints(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, entryPoints);
      await this.analyzeReportGeneration(csFiles, xamlFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, exitPoints);
      this.identifyExitPoints(services, exitPoints);

      this.createPerspectives(perspectives, windows, userControls, viewModels, services);

      const contributedNodes = [...enhancedNodes, ...newNodes];

      const contribution = this.createContribution(contributedNodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          windows_detected: windows.length,
          user_controls_detected: userControls.length,
          view_models_detected: viewModels.length,
          services_detected: services.length,
          converters_detected: converters.length,
          xaml_files: xamlFiles.length,
          nodes_enhanced: enhancedNodes.length,
          nodes_created: newNodes.length
        }
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(
        `WPF analysis failed: ${(error as Error).message}`,
        'WPF_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeWindows(
    csFiles: string[],
    xamlFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<WpfWindow[]> {
    const windows: WpfWindow[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const windowPattern = /class\s+(\w+)\s*:\s*(Window|MetroWindow|BaseWindow|System\.Windows\.Window|Xceed\.Wpf\.Toolkit\.\w*Window)\b/g;
        let match;

        while ((match = windowPattern.exec(content)) !== null) {
          const windowName = match[1];
          const baseClass = match[2];

          const xamlPath = this.findMatchingXaml(file, xamlFiles);
          let xamlContent = '';
          if (xamlPath) {
            try {
              xamlContent = await fs.readFile(path.join(projectPath, xamlPath), 'utf-8');
            } catch {}
          }

          const controls = this.extractControlsFromXaml(xamlContent);
          const eventHandlers = this.extractEventHandlers(content, xamlContent);
          const commands = this.extractCommands(content, xamlContent);
          const dataContext = this.extractDataContext(content, xamlContent);
          const resourceDictionaries = this.extractResourceDictionaries(xamlContent);

          const windowId = this.generateId('window', file, windowName);
          const windowInfo: WpfWindow = {
            nodeId: windowId,
            name: windowName,
            filePath: file,
            xamlPath,
            baseClass,
            dataContext,
            controls,
            eventHandlers,
            commands,
            resourceDictionaries
          };

          const existingNode = existingNodes.find(n =>
            n.name === windowName && n.type === 'class'
          );
          if (existingNode) windowInfo.nodeId = existingNode.id;
          windows.push(windowInfo);

          if (existingNode) {
            existingNode.type = 'window';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'wpf',
              base_class: baseClass,
              data_context: dataContext,
              control_count: controls.length,
              event_handler_count: eventHandlers.length,
              command_count: commands.length,
              has_xaml: !!xamlPath
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(windowId, windowName, 'window')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: file, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  base_class: baseClass,
                  data_context: dataContext,
                  control_count: controls.length,
                  event_handler_count: eventHandlers.length,
                  command_count: commands.length,
                  has_xaml: !!xamlPath,
                  resource_dictionaries: resourceDictionaries
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }

          if (xamlPath) {
            const xamlNodeId = this.generateId('xaml', xamlPath, windowName);
            const xamlNode = this.createNodeBuilder(xamlNodeId, path.basename(xamlPath), 'view')
              .withLevel(3, this.getLevelName(3))
              .withSource({ file: xamlPath, line: 1 })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  type: 'xaml',
                  associated_code_behind: file,
                  control_count: controls.length,
                  bindings: controls.reduce((acc, c) => acc + c.bindings.length, 0)
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(xamlNode);

            const edgeId = this.generateEdgeId(windowInfo.nodeId, xamlNodeId, 'defines-layout');
            edges.push(this.createEdgeBuilder(edgeId, windowInfo.nodeId, xamlNodeId, 'defines-layout')
              .withMetadata({ attributes: { relationship: 'code-behind-to-xaml' } })
              .build());
          }

          this.emitUiEventHandlerEntryPoints(
            windowInfo.nodeId, windowName, file,
            this.extractEventHandlerBindings(content, xamlContent),
            content, newNodes, edges, entryPoints
          );
        }
      } catch {}
    }

    return windows;
  }

  private async analyzeUserControls(
    csFiles: string[],
    xamlFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<WpfUserControl[]> {
    const controls: WpfUserControl[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const controlPattern = /class\s+(\w+)\s*:\s*(UserControl|ContentControl|Control|ItemsControl)\b/g;
        let match;

        while ((match = controlPattern.exec(content)) !== null) {
          const controlName = match[1];
          const xamlPath = this.findMatchingXaml(file, xamlFiles);

          let xamlContent = '';
          if (xamlPath) {
            try {
              xamlContent = await fs.readFile(path.join(projectPath, xamlPath), 'utf-8');
            } catch {}
          }

          const depProperties = this.extractDependencyProperties(content);
          const events = this.extractRoutedEvents(content);

          const controlId = this.generateId('control', file, controlName);
          const controlInfo: WpfUserControl = {
            nodeId: controlId,
            name: controlName,
            filePath: file,
            xamlPath,
            dependencyProperties: depProperties,
            events
          };

          const existingNode = existingNodes.find(n =>
            n.name === controlName && n.type === 'class'
          );
          if (existingNode) controlInfo.nodeId = existingNode.id;
          controls.push(controlInfo);

          if (existingNode) {
            existingNode.type = 'ui_component';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'wpf',
              component_type: 'user_control',
              dependency_property_count: depProperties.length,
              routed_event_count: events.length,
              has_xaml: !!xamlPath
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(controlId, controlName, 'ui_component')
              .withLevel(3, this.getLevelName(3))
              .withSource({ file: file, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  component_type: 'user_control',
                  dependency_properties: depProperties.map(dp => dp.name),
                  routed_events: events,
                  has_xaml: !!xamlPath
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }

          this.emitUiEventHandlerEntryPoints(
            controlInfo.nodeId, controlName, file,
            this.extractEventHandlerBindings(content, xamlContent),
            content, newNodes, edges, entryPoints
          );
        }
      } catch {}
    }

    return controls;
  }

  private async analyzeViewModels(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    windows: WpfWindow[],
    entryPoints: CASEntryPoint[]
  ): Promise<WpfViewModel[]> {
    const viewModels: WpfViewModel[] = [];

    const xamlBoundCommandNames = new Set<string>();
    for (const window of windows) {
      for (const cmd of window.commands) xamlBoundCommandNames.add(cmd);
    }

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const vmPattern = /class\s+(\w+(?:ViewModel|VM|Presenter))\s*(?::\s*[\w.,\s<>]+)?/g;
        const inpcPattern = /INotifyPropertyChanged/;
        let match;

        while ((match = vmPattern.exec(content)) !== null) {
          const vmName = match[1];
          const implementsINPC = inpcPattern.test(content);

          const properties = this.extractViewModelProperties(content);
          const commands = this.extractViewModelCommands(content);

          const vmId = this.generateId('viewmodel', file, vmName);
          const vmInfo: WpfViewModel = {
            nodeId: vmId,
            name: vmName,
            filePath: file,
            properties,
            commands,
            implementsINotifyPropertyChanged: implementsINPC
          };

          const existingNode = existingNodes.find(n =>
            n.name === vmName && n.type === 'class'
          );
          if (existingNode) vmInfo.nodeId = existingNode.id;
          viewModels.push(vmInfo);

          if (existingNode) {
            existingNode.type = 'viewmodel';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'wpf',
              pattern: 'mvvm',
              implements_inpc: implementsINPC,
              property_count: properties.length,
              command_count: commands.length,
              observable_properties: properties.filter(p => p.hasNotification).map(p => p.name),
              commands: commands.map(c => c.name)
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(vmId, vmName, 'viewmodel')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: file, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  pattern: 'mvvm',
                  implements_inpc: implementsINPC,
                  property_count: properties.length,
                  command_count: commands.length,
                  observable_properties: properties.filter(p => p.hasNotification).map(p => p.name),
                  commands: commands.map(c => c.name)
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }

          for (const cmd of commands) {
            const cmdId = this.generateId('command', file, `${vmName}_${cmd.name}`);
            const cmdNode = this.createNodeBuilder(cmdId, cmd.name, 'command')
              .withLevel(4, this.getLevelName(4))
              .withSource({ file: file })
              .withParent(vmInfo.nodeId)
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  command_type: cmd.type,
                  execute_method: cmd.executeMethod,
                  can_execute_method: cmd.canExecuteMethod
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(cmdNode);

            edges.push(this.createEdgeBuilder(
              this.generateEdgeId(vmInfo.nodeId, cmdId, 'has-command'),
              vmInfo.nodeId, cmdId, 'has-command'
            ).build());

            const isWired = !!cmd.executeMethod || xamlBoundCommandNames.has(cmd.name);
            if (isWired) {
              entryPoints.push(this.createEntryPoint(
                this.generateId('entry', file, `command_${vmName}_${cmd.name}`),
                cmdId,
                'command',
                `${vmName}.${cmd.name}`,
                `ICommand exposed by ${vmName}${cmd.executeMethod ? ` (executes ${cmd.executeMethod})` : ''}`,
                { event: cmd.name },
                undefined,
                {
                  framework: 'wpf',
                  entry_type: 'view_model_command',
                  command_type: cmd.type,
                  view_model: vmName,
                  execute_method: cmd.executeMethod,
                  xaml_bound: xamlBoundCommandNames.has(cmd.name)
                },
                { node_id: cmdId, method_name: cmd.executeMethod || cmd.name, file }
              ));
            }
          }
        }
      } catch {}
    }

    return viewModels;
  }

  private async analyzeServices(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[]
  ): Promise<WpfService[]> {
    const services: WpfService[] = [];

    const serviceFiles = csFiles.filter(f => {
      const lower = f.toLowerCase();
      return lower.includes('service') ||
             lower.includes('repository') ||
             lower.includes('manager') ||
             lower.includes('handler') ||
             lower.includes('helper') ||
             lower.includes('provider');
    });

    for (const file of serviceFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const classPattern = /class\s+(\w+(?:Service|Repository|Manager|Handler|Helper|Provider))\s*(?::\s*([\w.,\s<>]+))?/g;
        let match;

        while ((match = classPattern.exec(content)) !== null) {
          const serviceName = match[1];
          const baseTypes = match[2] ? match[2].split(',').map(t => t.trim()) : [];
          const interfaces = baseTypes.filter(t => t.startsWith('I'));
          const methods = this.extractServiceMethods(content, serviceName);

          const serviceId = this.generateId('service', file, serviceName);
          const serviceInfo: WpfService = {
            nodeId: serviceId,
            name: serviceName,
            filePath: file,
            interfaces,
            methods
          };

          const existingNode = existingNodes.find(n =>
            n.name === serviceName && n.type === 'class'
          );
          if (existingNode) serviceInfo.nodeId = existingNode.id;
          services.push(serviceInfo);

          if (existingNode) {
            existingNode.type = 'service';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'wpf',
              service_type: this.classifyServiceType(serviceName),
              interfaces,
              method_count: methods.length
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(serviceId, serviceName, 'service')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: file, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  service_type: this.classifyServiceType(serviceName),
                  interfaces,
                  method_count: methods.length,
                  methods: methods.map(m => m.name)
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }
        }
      } catch {}
    }

    return services;
  }

  private async analyzeConverters(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[]
  ): Promise<WpfConverter[]> {
    const converters: WpfConverter[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const converterPattern = /class\s+(\w+)\s*:\s*[\w\s,]*(?:IValueConverter|IMultiValueConverter)/g;
        let match;

        while ((match = converterPattern.exec(content)) !== null) {
          const converterName = match[1];
          const implementsIValueConverter = /IValueConverter(?!s)/.test(match[0]);
          const implementsIMultiValueConverter = /IMultiValueConverter/.test(match[0]);

          const converterId = this.generateId('converter', file, converterName);
          const converterInfo: WpfConverter = {
            nodeId: converterId,
            name: converterName,
            filePath: file,
            implementsIValueConverter,
            implementsIMultiValueConverter
          };
          const existingNode = existingNodes.find(n =>
            n.name === converterName && n.type === 'class'
          );
          if (existingNode) converterInfo.nodeId = existingNode.id;
          converters.push(converterInfo);

          if (existingNode) {
            existingNode.type = 'converter';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'wpf',
              converter_type: implementsIMultiValueConverter ? 'multi_value' : 'value'
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(converterId, converterName, 'converter')
              .withLevel(3, this.getLevelName(3))
              .withSource({ file: file, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  converter_type: implementsIMultiValueConverter ? 'multi_value' : 'value',
                  implements_ivalueconverter: implementsIValueConverter,
                  implements_imultivalueconverter: implementsIMultiValueConverter
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }
        }
      } catch {}
    }

    return converters;
  }

  private buildMvvmRelationships(
    windows: WpfWindow[],
    viewModels: WpfViewModel[],
    services: WpfService[],
    edges: CASEdge[]
  ): void {
    for (const window of windows) {
      if (!window.dataContext) continue;

      const vm = viewModels.find(v => v.name === window.dataContext);
      if (vm) {
        vm.boundWindow = window.name;

        edges.push(this.createEdgeBuilder(
          this.generateEdgeId(window.nodeId, vm.nodeId, 'binds-to'),
          window.nodeId, vm.nodeId, 'binds-to'
        ).withMetadata({ attributes: { relationship: 'data-context', pattern: 'mvvm' } }).build());
      }
    }

    for (const vm of viewModels) {
      for (const service of services) {
        const nameMatch = service.interfaces.some(iface => {
          const stripped = iface.replace(/^I/, '');
          return vm.name.toLowerCase().includes(stripped.toLowerCase()) ||
                 stripped.toLowerCase().includes(vm.name.replace(/ViewModel|VM|Presenter/, '').toLowerCase());
        });

        if (nameMatch) {
          edges.push(this.createEdgeBuilder(
            this.generateEdgeId(vm.nodeId, service.nodeId, 'depends-on'),
            vm.nodeId, service.nodeId, 'depends-on'
          ).withMetadata({ attributes: { relationship: 'service-dependency' } }).build());
        }
      }
    }
  }

  private buildDataBindingRelationships(
    windows: WpfWindow[],
    userControls: WpfUserControl[],
    viewModels: WpfViewModel[],
    edges: CASEdge[]
  ): void {
    for (const window of windows) {
      for (const control of window.controls) {
        for (const binding of control.bindings) {
          const vm = viewModels.find(v => v.name === window.dataContext);
          if (vm) {
            const prop = vm.properties.find(p => p.name === binding.path);
            if (prop) {
              const edgeId = this.generateEdgeId(window.nodeId, vm.nodeId, `binding-${binding.path}`);
              if (!edges.find(e => e.id === edgeId)) {
                edges.push(this.createEdgeBuilder(edgeId, window.nodeId, vm.nodeId, 'data-binding')
                  .withMetadata({
                    attributes: {
                      binding_path: binding.path,
                      binding_mode: binding.mode || 'default',
                      control: control.name,
                      control_property: binding.property
                    }
                  }).build());
              }
            }
          }
        }
      }
    }
  }

  private buildConverterRelationships(
    converters: WpfConverter[],
    windows: WpfWindow[],
    userControls: WpfUserControl[],
    edges: CASEdge[]
  ): void {
    for (const window of windows) {
      for (const control of window.controls) {
        for (const binding of control.bindings) {
          if (binding.converter) {
            const converter = converters.find(c => c.name === binding.converter);
            if (converter) {
              edges.push(this.createEdgeBuilder(
                this.generateEdgeId(window.nodeId, converter.nodeId, 'uses-converter'),
                window.nodeId, converter.nodeId, 'uses-converter'
              ).withMetadata({ attributes: { binding_property: binding.property } }).build());
            }
          }
        }
      }
    }
  }

  private identifyEntryPoints(
    windows: WpfWindow[],
    entryPoints: CASEntryPoint[]
  ): void {
    for (const window of windows) {
      if (window.baseClass === 'Window' || window.name.toLowerCase().includes('main')) {
        const project = path.basename(path.dirname(window.filePath));
        entryPoints.push(this.createEntryPoint(
          this.generateId('entry', window.filePath, window.name),
          window.nodeId,
          'event',
          project && project !== '.' ? `${project}.${window.name}` : window.name,
          `WPF Window: ${window.name}`,
          { event: 'user-interaction' },
          undefined,
          {
            framework: 'wpf',
            entry_type: 'window',
            window_class: window.name,
            file: window.filePath,
            data_context: window.dataContext,
            event_handler_count: window.eventHandlers.length
          },
          { node_id: window.nodeId, method_name: window.name, file: window.filePath }
        ));
      }
    }
  }

  private async identifyServiceEntryPoints(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): Promise<void> {
    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const serviceBasePattern = /class\s+(\w+)\s*:\s*(?:System\.ServiceProcess\.)?ServiceBase\b/g;
        let match;
        while ((match = serviceBasePattern.exec(content)) !== null) {
          const serviceName = match[1];
          const serviceId = this.generateId('service_entry', file, serviceName);

          const existingNode = existingNodes.find(n => n.name === serviceName);
          if (existingNode) {
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
          }

          entryPoints.push(this.createEntryPoint(
            this.generateId('entry', file, `service_${serviceName}`),
            existingNode?.id || serviceId,
            'event',
            `Windows Service: ${serviceName}`,
            `Windows Service entry point`,
            { event: 'service-start' },
            undefined,
            { framework: 'wpf', entry_type: 'windows_service', service_name: serviceName }
          ));
        }

        const timerPattern = /(?:DispatcherTimer|System\.Timers\.Timer|System\.Threading\.Timer)\s+(\w+)/g;
        while ((match = timerPattern.exec(content)) !== null) {
          const timerName = match[1];
          const namespace = this.extractNamespaceFromContent(content);

          entryPoints.push(this.createEntryPoint(
            this.generateId('entry', file, `timer_${timerName}`),
            `file_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
            'schedule',
            `Timer: ${timerName}`,
            `Scheduled timer entry point`,
            { event: 'timer-tick' },
            undefined,
            { framework: 'wpf', entry_type: 'timer', timer_name: timerName, namespace }
          ));
        }
      } catch {}
    }
  }

  private extractNamespaceFromContent(content: string): string {
    const nsMatch = content.match(/namespace\s+([a-zA-Z0-9_.]+)/);
    return nsMatch ? nsMatch[1] : 'global';
  }

  private async identifyAppStartupEntryPoints(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): Promise<void> {
    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const appClassPattern = /class\s+(\w+)\s*:\s*(?:System\.Windows\.)?Application\b/;
        const appMatch = appClassPattern.exec(content);
        const mainPattern = /(?:private|public|internal)?\s*static\s+(?:async\s+)?(?:void|Task|int)\s+Main\s*\(/;
        const mainMatch = mainPattern.exec(content);

        if (!appMatch && !mainMatch) continue;

        const onStartupPattern = /(?:protected|public)\s+override\s+(?:async\s+)?void\s+OnStartup\s*\(/;
        const onStartupMatch = onStartupPattern.exec(content);

        const startupMatch = onStartupMatch || mainMatch;
        if (!startupMatch) continue;
        const methodName = onStartupMatch ? 'OnStartup' : 'Main';

        const appName = appMatch ? appMatch[1] : path.basename(file, '.cs');
        const nodeId = this.generateId('app_startup', file, appName);
        const line = this.findLineNumber(content, startupMatch[0]);

        const existingNode = appMatch ? existingNodes.find(n => n.name === appName && n.type === 'class') : undefined;
        let sourceNodeId = nodeId;

        if (existingNode) {
          existingNode.type = 'app_startup';
          if (!existingNode.metadata) existingNode.metadata = {};
          existingNode.metadata.attributes = {
            ...existingNode.metadata.attributes,
            framework: 'wpf',
            startup_method: methodName
          };
          if (!existingNode.analyzers) existingNode.analyzers = [];
          if (!existingNode.analyzers.includes(this.analyzerId)) {
            existingNode.analyzers.push(this.analyzerId);
          }
          enhancedNodes.push(existingNode);
          sourceNodeId = existingNode.id;
        } else {
          newNodes.push(
            this.createNodeBuilder(nodeId, appName, 'app_startup')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: file, line })
              .withMetadata({
                framework: 'wpf',
                attributes: { startup_method: methodName, is_application_subclass: !!appMatch }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build()
          );
        }

        entryPoints.push(this.createEntryPoint(
          this.generateId('entry', file, `app_startup_${appName}`),
          sourceNodeId,
          'lifecycle',
          `${appName}.${methodName}`,
          `WPF application startup entry point`,
          { event: 'app-startup' },
          undefined,
          { framework: 'wpf', entry_type: 'app_startup', startup_method: methodName },
          { node_id: sourceNodeId, method_name: methodName, file }
        ));
      } catch {}
    }
  }

  private async analyzeReportGeneration(
    csFiles: string[],
    xamlFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[]
  ): Promise<void> {
    const reportFiles = csFiles.filter(f => {
      const lower = f.toLowerCase();
      return lower.includes('report') || lower.includes('print') || lower.includes('export') || lower.includes('letter');
    });

    for (const file of reportFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const classPattern = /class\s+(\w+(?:Report|Print|Export|Letter|Document)\w*)\s*(?::\s*([\w.,\s<>]+))?/g;
        let match;

        while ((match = classPattern.exec(content)) !== null) {
          const className = match[1];
          const existingNode = existingNodes.find(n => n.name === className);

          if (existingNode) {
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'wpf',
              report_type: this.classifyReportType(className)
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          }

          const isPrintOp = /PrintDialog|PrintDocument|FlowDocument|FixedDocument|XpsDocument|PrintVisual/.test(content);
          const isExportOp = /SaveFileDialog|StreamWriter|FileStream|PdfWriter|ExcelPackage/.test(content);

          if (isPrintOp) {
            exitPoints.push(this.createExitPoint(
              this.generateId('exit', file, `${className}_print`),
              existingNode?.id || this.generateId('report', file, className),
              'file',
              `${className} print output`,
              `Report print operation`,
              { service_id: 'printer' },
              { action: 'print', method: 'Print' },
              { framework: 'wpf', report_class: className }
            ));
          }
          if (isExportOp) {
            exitPoints.push(this.createExitPoint(
              this.generateId('exit', file, `${className}_export`),
              existingNode?.id || this.generateId('report', file, className),
              'file',
              `${className} file export`,
              `Report file export operation`,
              { service_id: 'filesystem' },
              { action: 'write', method: 'Export' },
              { framework: 'wpf', report_class: className }
            ));
          }
        }
      } catch {}
    }

    const reportXamlFiles = xamlFiles.filter(f => {
      const lower = f.toLowerCase();
      return lower.includes('report') || lower.includes('print');
    });

    for (const xamlFile of reportXamlFiles) {
      const fullPath = path.join(projectPath, xamlFile);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (/FlowDocument|FixedDocument|DocumentViewer|FlowDocumentReader/.test(content)) {
          const reportNodeId = this.generateId('report_template', xamlFile, path.basename(xamlFile));
          newNodes.push(
            this.createNodeBuilder(reportNodeId, path.basename(xamlFile), 'view')
              .withLevel(3, this.getLevelName(3))
              .withSource({ file: xamlFile, line: 1 })
              .withMetadata({
                framework: 'wpf',
                attributes: {
                  type: 'report_template',
                  document_type: /FlowDocument/.test(content) ? 'flow_document' : 'fixed_document'
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build()
          );
        }
      } catch {}
    }
  }

  private classifyReportType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('grip')) return 'grip_strength_report';
    if (lower.includes('pinch')) return 'pinch_report';
    if (lower.includes('rom') || lower.includes('inclin')) return 'range_of_motion_report';
    if (lower.includes('muscle')) return 'muscle_test_report';
    if (lower.includes('letter') || lower.includes('narrative')) return 'narrative_report';
    if (lower.includes('graphical') || lower.includes('graph')) return 'graphical_report';
    if (lower.includes('preview') || lower.includes('print')) return 'print_preview';
    return 'report';
  }

  private identifyExitPoints(
    services: WpfService[],
    exitPoints: CASExitPoint[]
  ): void {
    for (const service of services) {
      for (const method of service.methods) {
        const isDbOperation = /^(Get|Find|Query|Insert|Update|Delete|Save|Load|Fetch|Add|Remove|Create|Read)/i.test(method.name);
        const isExternalCall = /^(Send|Post|Call|Invoke|Request|Notify|Publish|Dispatch)/i.test(method.name);

        if (isDbOperation) {
          exitPoints.push(this.createExitPoint(
            this.generateId('exit', service.filePath, `${service.name}_${method.name}`),
            service.nodeId,
            'database',
            `${service.name}.${method.name}`,
            `Database operation via ${service.name}`,
            { service_id: 'database' },
            { action: 'read', method: method.name },
            { framework: 'wpf', service: service.name }
          ));
        } else if (isExternalCall) {
          exitPoints.push(this.createExitPoint(
            this.generateId('exit', service.filePath, `${service.name}_${method.name}`),
            service.nodeId,
            'api',
            `${service.name}.${method.name}`,
            `External call via ${service.name}`,
            { service_id: 'external' },
            { action: 'call', method: method.name },
            { framework: 'wpf', service: service.name }
          ));
        }
      }
    }
  }

  private createPerspectives(
    perspectives: CASPerspective[],
    windows: WpfWindow[],
    userControls: WpfUserControl[],
    viewModels: WpfViewModel[],
    services: WpfService[]
  ): void {
    perspectives.push({
      id: 'wpf-mvvm',
      name: 'WPF MVVM Architecture',
      description: 'View-ViewModel-Model pattern in the WPF application',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['window', 'viewmodel', 'ui_component', 'service', 'converter', 'command', 'view']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'layer'
      }
    });

    if (windows.length > 0) {
      perspectives.push({
        id: 'wpf-navigation',
        name: 'WPF Window Navigation',
        description: 'Windows, dialogs, and user controls navigation structure',
        analyzer_id: this.analyzerId,
        type: 'structure',
        connection_rules: {
          visible_node_types: ['window', 'ui_component', 'view']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'LR',
          group_by: 'type'
        }
      });
    }
  }

  private findMatchingXaml(csFile: string, xamlFiles: string[]): string | undefined {

    const baseName = csFile.endsWith('.xaml.cs')
      ? csFile.slice(0, -'.xaml.cs'.length)
      : csFile.replace(/\.cs$/, '');
    return xamlFiles.find(x => {
      const xamlBase = x.replace(/\.xaml$/, '');
      return xamlBase === baseName;
    });
  }

  private extractControlsFromXaml(xamlContent: string): WpfControl[] {
    const controls: WpfControl[] = [];
    if (!xamlContent) return controls;

    const namedControlPattern = /<(\w+:)?(\w+)\s+[^>]*(?:x:Name|Name)\s*=\s*"([^"]*)"[^>]*/g;
    let match;

    while ((match = namedControlPattern.exec(xamlContent)) !== null) {
      const controlType = match[2];
      const controlName = match[3] || controlType;
      const endIdx = xamlContent.indexOf('>', match.index);
      const closeTagIdx = xamlContent.indexOf(`</${match[1] || ''}${controlType}>`, match.index);
      const sectionEnd = closeTagIdx > 0 ? closeTagIdx : (endIdx > 0 ? endIdx + 1 : match.index + match[0].length);
      const controlSection = xamlContent.substring(match.index, sectionEnd);
      const bindings = this.extractBindingsFromSection(controlSection);

      controls.push({ name: controlName, type: controlType, bindings });
    }

    const allBindingPattern = /(\w+)\s*=\s*"\{Binding\s+(?:Path=)?([^,}"]+)(?:,\s*Mode=(\w+))?(?:,\s*Converter=\{(?:StaticResource|DynamicResource)\s+(\w+)\})?[^"]*\}"/g;
    while ((match = allBindingPattern.exec(xamlContent)) !== null) {
      const prop = match[1];
      const bindingPath = match[2].trim();
      const mode = match[3];
      const converter = match[4];

      const existing = controls.find(c => c.bindings.some(b => b.path === bindingPath && b.property === prop));
      if (!existing) {
        const lineContext = xamlContent.substring(
          Math.max(0, xamlContent.lastIndexOf('<', match.index)),
          xamlContent.indexOf('>', match.index) + 1
        );
        const typeMatch = lineContext.match(/<(\w+:)?(\w+)/);
        controls.push({
          name: `bound_${bindingPath}`,
          type: typeMatch ? typeMatch[2] : 'unknown',
          bindings: [{ property: prop, path: bindingPath, mode, converter }]
        });
      }
    }

    const commandBindingPattern = /Command\s*=\s*"\{Binding\s+(?:Path=)?(\w+)\}"/g;
    while ((match = commandBindingPattern.exec(xamlContent)) !== null) {
      const cmdName = match[1];
      const existing = controls.find(c => c.bindings.some(b => b.path === cmdName));
      if (!existing) {
        controls.push({
          name: `cmd_${cmdName}`,
          type: 'command_binding',
          bindings: [{ property: 'Command', path: cmdName }]
        });
      }
    }

    const itemsSourcePattern = /ItemsSource\s*=\s*"\{Binding\s+(?:Path=)?([^,}"]+)[^"]*\}"/g;
    while ((match = itemsSourcePattern.exec(xamlContent)) !== null) {
      const sourcePath = match[1].trim();
      const existing = controls.find(c => c.bindings.some(b => b.path === sourcePath && b.property === 'ItemsSource'));
      if (!existing) {
        controls.push({
          name: `items_${sourcePath}`,
          type: 'items_control',
          bindings: [{ property: 'ItemsSource', path: sourcePath }]
        });
      }
    }

    return controls;
  }

  private extractBindingsFromSection(section: string): WpfBinding[] {
    const bindings: WpfBinding[] = [];

    const bindingPattern = /(\w+)\s*=\s*"\{Binding\s+(?:Path=)?([^,}"]+)(?:,\s*Mode=(\w+))?(?:,\s*Converter=\{StaticResource\s+(\w+)\})?[^"]*\}"/g;
    let match;

    while ((match = bindingPattern.exec(section)) !== null) {
      bindings.push({
        property: match[1],
        path: match[2].trim(),
        mode: match[3],
        converter: match[4]
      });
    }

    return bindings;
  }

  private extractEventHandlers(csContent: string, xamlContent: string): string[] {
    const handlers: string[] = [];

    const codeHandlerPattern = /(?:Click|MouseDown|KeyDown|Loaded|Closed|Closing|SelectionChanged|TextChanged|Checked|Unchecked)\s*\+=\s*(?:new\s+\w+\()?([\w]+)/g;
    let match;
    while ((match = codeHandlerPattern.exec(csContent)) !== null) {
      handlers.push(match[1]);
    }

    if (xamlContent) {
      const xamlHandlerPattern = /(?:Click|MouseDown|KeyDown|Loaded|Closed|Closing|SelectionChanged|TextChanged|Checked|Unchecked)\s*=\s*"(\w+)"/g;
      while ((match = xamlHandlerPattern.exec(xamlContent)) !== null) {
        if (!handlers.includes(match[1])) {
          handlers.push(match[1]);
        }
      }
    }

    return handlers;
  }

  private extractEventHandlerBindings(csContent: string, xamlContent: string): WpfEventHandlerBinding[] {
    const bindings: WpfEventHandlerBinding[] = [];
    const seen = new Set<string>();

    const codeHandlerPattern = /(Click|MouseDown|KeyDown|Loaded|Closed|Closing|SelectionChanged|TextChanged|Checked|Unchecked)\s*\+=\s*(?:new\s+\w+\()?([\w]+)/g;
    let match;
    while ((match = codeHandlerPattern.exec(csContent)) !== null) {
      const key = `${match[1]}:${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        bindings.push({ event: match[1], method: match[2] });
      }
    }

    if (xamlContent) {
      const xamlHandlerPattern = /(Click|MouseDown|KeyDown|Loaded|Closed|Closing|SelectionChanged|TextChanged|Checked|Unchecked)\s*=\s*"(\w+)"/g;
      while ((match = xamlHandlerPattern.exec(xamlContent)) !== null) {
        const key = `${match[1]}:${match[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          bindings.push({ event: match[1], method: match[2] });
        }
      }
    }

    return bindings;
  }

  private emitUiEventHandlerEntryPoints(
    parentId: string,
    parentName: string,
    filePath: string,
    bindings: WpfEventHandlerBinding[],
    csContent: string,
    newNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    for (const binding of bindings) {
      const handlerId = this.generateId('event_handler', filePath, `${parentName}_${binding.event}_${binding.method}`);
      const declPattern = new RegExp(`(?:private|public|protected|internal)\\s+(?:async\\s+)?void\\s+${binding.method}\\s*\\(`);
      const declMatch = declPattern.exec(csContent);
      const resolvedToCodeMethod = !!declMatch;
      const line = declMatch ? this.findLineNumber(csContent, declMatch[0]) : undefined;

      const handlerNode = this.createNodeBuilder(handlerId, `${binding.event}=${binding.method}`, 'event_handler')
        .withLevel(4, this.getLevelName(4))
        .withSource({ file: filePath, line: line || 1 })
        .withParent(parentId)
        .withMetadata({
          framework: 'wpf',
          attributes: {
            event: binding.event,
            method: binding.method,
            resolved_to_code_method: resolvedToCodeMethod
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      newNodes.push(handlerNode);

      edges.push(this.createEdgeBuilder(
        this.generateEdgeId(parentId, handlerId, `handles-${binding.event}`),
        parentId, handlerId, 'handles-event'
      ).withMetadata({ attributes: { event: binding.event, method: binding.method } }).build());

      entryPoints.push(this.createEntryPoint(
        this.generateId('entry', filePath, `ui_event_${parentName}_${binding.event}_${binding.method}`),
        handlerId,
        'event',
        `${parentName}.${binding.method}`,
        `WPF UI event handler: ${binding.event} -> ${binding.method}`,
        { event: binding.event },
        undefined,
        {
          framework: 'wpf',
          entry_type: 'ui_event_handler',
          owner: parentName,
          event: binding.event,
          resolved_to_code_method: resolvedToCodeMethod
        },
        { node_id: handlerId, method_name: binding.method, file: filePath }
      ));
    }
  }

  private extractCommands(csContent: string, xamlContent: string): string[] {
    const commands: string[] = [];

    const propertyCommandPattern = /(?:public|private)\s+(?:ICommand|RelayCommand|DelegateCommand)\s+(\w+)/g;
    let match;

    while ((match = propertyCommandPattern.exec(csContent)) !== null) {
      commands.push(match[1]);
    }

    if (xamlContent) {
      const xamlCommandPattern = /Command\s*=\s*"\{Binding\s+(\w+)\}"/g;
      while ((match = xamlCommandPattern.exec(xamlContent)) !== null) {
        if (!commands.includes(match[1])) {
          commands.push(match[1]);
        }
      }
    }

    return commands;
  }

  private extractDataContext(csContent: string, xamlContent: string): string | undefined {
    const codePattern = /DataContext\s*=\s*new\s+(\w+)/;
    let match = codePattern.exec(csContent);
    if (match) return match[1];

    const codeCastPattern = /DataContext\s*(?:as|is)\s+(\w+)/;
    match = codeCastPattern.exec(csContent);
    if (match) return match[1];

    if (xamlContent) {
      const xamlPattern = /DataContext\s*=\s*"\{.*?(?:x:Type|local:)(\w+)\}"/;
      match = xamlPattern.exec(xamlContent);
      if (match) return match[1];

      const xamlElementPattern = /<\w+\.DataContext>\s*<(?:\w+:)?(\w+)/;
      match = xamlElementPattern.exec(xamlContent);
      if (match) return match[1];
    }

    return undefined;
  }

  private extractResourceDictionaries(xamlContent: string): string[] {
    const dictionaries: string[] = [];
    if (!xamlContent) return dictionaries;

    const pattern = /Source\s*=\s*"([^"]*\.xaml)"/g;
    let match;
    while ((match = pattern.exec(xamlContent)) !== null) {
      dictionaries.push(match[1]);
    }

    return dictionaries;
  }

  private extractDependencyProperties(content: string): WpfDependencyProperty[] {
    const properties: WpfDependencyProperty[] = [];

    const dpPattern = /DependencyProperty\.Register\w*\(\s*(?:nameof\((\w+)\)|"(\w+)")\s*,\s*typeof\((\w+)\)\s*,\s*typeof\((\w+)\)/g;
    let match;

    while ((match = dpPattern.exec(content)) !== null) {
      properties.push({
        name: match[1] || match[2],
        type: match[3],
        ownerType: match[4]
      });
    }

    return properties;
  }

  private extractRoutedEvents(content: string): string[] {
    const events: string[] = [];

    const eventPattern = /EventManager\.RegisterRoutedEvent\(\s*"(\w+)"/g;
    let match;
    while ((match = eventPattern.exec(content)) !== null) {
      events.push(match[1]);
    }

    const routedEventPattern = /public\s+(?:static\s+)?(?:readonly\s+)?RoutedEvent\s+(\w+)/g;
    while ((match = routedEventPattern.exec(content)) !== null) {
      if (!events.includes(match[1])) {
        events.push(match[1]);
      }
    }

    return events;
  }

  private extractViewModelProperties(content: string): WpfProperty[] {
    const properties: WpfProperty[] = [];

    const propPattern = /(?:public|protected)\s+(\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\{[^}]*(?:get|set)/g;
    let match;

    while ((match = propPattern.exec(content)) !== null) {
      const propName = match[2];
      const propType = match[1];

      const propBlock = content.substring(match.index, content.indexOf('}', match.index + match[0].length) + 1);
      const hasNotification = /(?:OnPropertyChanged|RaisePropertyChanged|SetProperty|NotifyOfPropertyChange|Set\()/.test(propBlock);

      properties.push({
        name: propName,
        type: propType,
        hasNotification
      });
    }

    return properties;
  }

  private extractViewModelCommands(content: string): WpfCommand[] {
    const commands: WpfCommand[] = [];

    const commandPropPattern = /(?:public|private)\s+(?:ICommand|RelayCommand|DelegateCommand|AsyncCommand)\s+(\w+)\s*\{/g;
    let match;

    while ((match = commandPropPattern.exec(content)) !== null) {
      const cmdName = match[1];
      const cmdType = match[0].includes('RelayCommand') ? 'RelayCommand' :
                      match[0].includes('DelegateCommand') ? 'DelegateCommand' :
                      match[0].includes('AsyncCommand') ? 'AsyncCommand' : 'ICommand';

      const executeMatch = content.match(new RegExp(`${cmdName}\\s*=\\s*new\\s+\\w+\\(\\s*(\\w+)`));
      const canExecuteMatch = content.match(new RegExp(`${cmdName}\\s*=\\s*new\\s+\\w+\\([^,]+,\\s*(\\w+)`));

      commands.push({
        name: cmdName,
        type: cmdType,
        executeMethod: executeMatch?.[1],
        canExecuteMethod: canExecuteMatch?.[1]
      });
    }

    return commands;
  }

  private extractServiceMethods(content: string, className: string): Array<{ name: string; returnType?: string; parameters: string[] }> {
    const methods: Array<{ name: string; returnType?: string; parameters: string[] }> = [];

    const methodPattern = /(?:public|protected|internal)\s+(?:virtual\s+|override\s+|async\s+|static\s+)*(\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
    let match;

    while ((match = methodPattern.exec(content)) !== null) {
      const returnType = match[1];
      const methodName = match[2];
      const params = match[3].trim();

      if (methodName === className || methodName === 'Dispose' || methodName === 'ToString') continue;

      methods.push({
        name: methodName,
        returnType,
        parameters: params ? params.split(',').map(p => p.trim()) : []
      });
    }

    return methods;
  }

  private classifyServiceType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('repository') || lower.includes('repo')) return 'repository';
    if (lower.includes('handler')) return 'handler';
    if (lower.includes('manager')) return 'manager';
    if (lower.includes('provider')) return 'provider';
    if (lower.includes('helper')) return 'helper';
    return 'service';
  }

  private findLineNumber(content: string, searchStr: string): number {
    const index = content.indexOf(searchStr);
    if (index === -1) return 1;
    return content.substring(0, index).split('\n').length;
  }

  protected getCapabilities(): string[] {
    return [
      'wpf-window-analysis',
      'user-control-analysis',
      'viewmodel-detection',
      'mvvm-pattern-detection',
      'data-binding-analysis',
      'command-analysis',
      'dependency-property-analysis',
      'converter-analysis',
      'xaml-parsing',
      'service-detection',
      'app-startup-detection',
      'ui-event-handler-entry-points',
      'view-model-command-entry-points'
    ];
  }

  protected getLevelName(level: number): string {
    const levels: Record<number, string> = {
      1: 'system',
      2: 'architectural',
      3: 'code',
      4: 'member',
      5: 'implementation'
    };
    return levels[level] || 'unknown';
  }
}

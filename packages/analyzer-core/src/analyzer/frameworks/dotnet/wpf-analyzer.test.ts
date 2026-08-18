import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { WPFAnalyzer } from './wpf-analyzer';
import { CASContribution, CASNode } from '../../../types/cas.types';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpf-analyzer-test-'));

  await fs.writeFile(path.join(dir, 'WpfApp.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>WinExe</OutputType>',
    '    <UseWPF>true</UseWPF>',
    '  </PropertyGroup>',
    '</Project>',
    ''
  ].join('\n'));

  // App startup: Application subclass overriding OnStartup.
  await fs.writeFile(path.join(dir, 'App.xaml.cs'), [
    'namespace WpfApp',
    '{',
    '    public partial class App : System.Windows.Application',
    '    {',
    '        protected override void OnStartup(System.Windows.StartupEventArgs e)',
    '        {',
    '            base.OnStartup(e);',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n'));

  // MainWindow: a Click handler wired in XAML (real UI entry point) plus a
  // plain private helper method that is NOT wired to any event (control:
  // must not be promoted to an entry point).
  await fs.writeFile(path.join(dir, 'MainWindow.xaml'), [
    '<Window x:Class="WpfApp.MainWindow"',
    '        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"',
    '        DataContext="{Binding Source={StaticResource MainViewModel}}">',
    '    <StackPanel>',
    '        <Button x:Name="SaveButton" Content="Save" Click="SaveButton_Click" />',
    '        <Button Content="Submit" Command="{Binding SubmitCommand}" />',
    '    </StackPanel>',
    '</Window>',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(dir, 'MainWindow.xaml.cs'), [
    'namespace WpfApp',
    '{',
    '    public partial class MainWindow : Window',
    '    {',
    '        public MainWindow()',
    '        {',
    '            InitializeComponent();',
    '        }',
    '',
    '        private void SaveButton_Click(object sender, RoutedEventArgs e)',
    '        {',
    '            // handles the click',
    '        }',
    '',
    '        private void ComputeInternalLayout()',
    '        {',
    '            // never wired to any WPF event - must not be promoted',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n'));

  // ViewModel exposing a wired ICommand (bound in MainWindow.xaml above) and
  // an unwired command (no executeMethod, never referenced from any XAML).
  await fs.writeFile(path.join(dir, 'MainViewModel.cs'), [
    'namespace WpfApp',
    '{',
    '    public class MainViewModel : INotifyPropertyChanged',
    '    {',
    '        public ICommand SubmitCommand { get; }',
    '        public ICommand UnwiredCommand { get; }',
    '',
    '        public MainViewModel()',
    '        {',
    '            SubmitCommand = new RelayCommand(Submit);',
    '        }',
    '',
    '        private void Submit()',
    '        {',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n'));

  return dir;
}

test('WPFAnalyzer surfaces the UI interaction surface as entry points', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new WPFAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true for a WPF project');

    const result = await analyzer.analyze({ projectPath: dir });

    // (a) App startup entry point (OnStartup).
    const appStartupNode = result.nodes.find(n => n.type === 'app_startup' && n.name === 'App');
    assert.ok(appStartupNode, 'expected an app_startup node for the Application subclass');
    const appStartupEntry = result.entry_points.find(
      e => e.metadata?.entry_type === 'app_startup' && e.source_node === appStartupNode!.id
    );
    assert.ok(appStartupEntry, 'expected an app-startup entry point');
    assert.equal(appStartupEntry!.type, 'lifecycle');
    assert.equal(appStartupEntry!.metadata?.startup_method, 'OnStartup');

    // (b) Code-behind UI event handler wired via XAML Click="SaveButton_Click".
    const handlerNode = result.nodes.find(
      n => n.type === 'event_handler' &&
           n.metadata?.attributes?.event === 'Click' &&
           n.metadata?.attributes?.method === 'SaveButton_Click'
    );
    assert.ok(handlerNode, 'expected a Click=SaveButton_Click event_handler node');
    assert.equal(handlerNode!.metadata?.attributes?.resolved_to_code_method, true);

    const mainWindowNode = result.nodes.find(n => n.type === 'window' && n.name === 'MainWindow');
    assert.ok(mainWindowNode, 'expected a MainWindow window node');

    const handlesEdge = result.edges.find(
      e => e.type === 'handles-event' && e.source === mainWindowNode!.id && e.target === handlerNode!.id
    );
    assert.ok(handlesEdge, 'expected a handles-event edge from MainWindow to the handler');

    const uiEventEntry = result.entry_points.find(
      e => e.metadata?.entry_type === 'ui_event_handler' && e.source_node === handlerNode!.id
    );
    assert.ok(uiEventEntry, 'expected a UI event handler entry point for SaveButton_Click');
    assert.equal(uiEventEntry!.type, 'event');

    // Control: a method never wired to any WPF event must NOT be promoted
    // to an event_handler node or entry point.
    const unwiredMethodNode = result.nodes.find(
      n => n.type === 'event_handler' && n.metadata?.attributes?.method === 'ComputeInternalLayout'
    );
    assert.equal(unwiredMethodNode, undefined, 'a non-event-wired method must not become an event_handler node');
    const unwiredMethodEntry = result.entry_points.find(
      e => e.metadata?.entry_type === 'ui_event_handler' && e.metadata?.owner === 'ComputeInternalLayout'
    );
    assert.equal(unwiredMethodEntry, undefined, 'a non-event-wired method must not become an entry point');

    // (c) ICommand exposed by the ViewModel and bound via XAML Command="{Binding SubmitCommand}".
    const submitCommandEntry = result.entry_points.find(
      e => e.metadata?.entry_type === 'view_model_command' && e.name === 'MainViewModel.SubmitCommand'
    );
    assert.ok(submitCommandEntry, 'expected a view_model_command entry point for SubmitCommand');
    assert.equal(submitCommandEntry!.type, 'command');
    assert.equal(submitCommandEntry!.metadata?.execute_method, 'Submit');

    // Control: an ICommand-typed property with no execute-method wiring and
    // no XAML binding must not be promoted to an entry point (evidence gate).
    const unwiredCommandEntry = result.entry_points.find(
      e => e.metadata?.entry_type === 'view_model_command' && e.name === 'MainViewModel.UnwiredCommand'
    );
    assert.equal(unwiredCommandEntry, undefined, 'an unwired ICommand property must not become an entry point');

    // The command node itself is still emitted (structure is still visible),
    // just not promoted to an entry point.
    const unwiredCommandNode = result.nodes.find(n => n.type === 'command' && n.name === 'UnwiredCommand');
    assert.ok(unwiredCommandNode, 'the UnwiredCommand node should still be emitted for structural navigation');
  } finally {
    await fs.remove(dir);
  }
});

test('WPFAnalyzer preserves canonical language node identities across graph surfaces', async () => {
  const dir = await makeProject();
  try {
    await fs.writeFile(path.join(dir, 'PatientService.cs'), [
      'namespace WpfApp',
      '{',
      '    public class PatientService : IPatientService',
      '    {',
      '        public Patient GetPatient() { return null; }',
      '    }',
      '}',
      '',
    ].join('\n'));
    const existingNodes: CASNode[] = [
      { id: 'class_main_window', name: 'MainWindow', type: 'class', level: 3, source: { file: 'MainWindow.xaml.cs' } },
      { id: 'class_main_view_model', name: 'MainViewModel', type: 'class', level: 3, source: { file: 'MainViewModel.cs' } },
      { id: 'class_patient_service', name: 'PatientService', type: 'class', level: 3, source: { file: 'PatientService.cs' } },
    ];
    const existingContribution: CASContribution = {
      nodes: existingNodes,
      analyzer_metadata: {
        analyzer_id: 'fixture',
        analyzer_name: 'Fixture',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        capabilities: [],
      },
    };
    const result = await new WPFAnalyzer().analyze({ projectPath: dir, existingAnalysis: [existingContribution] });
    const availableIds = new Set([
      ...result.nodes.map(node => node.id),
      ...result.entry_points.map(entry => entry.id),
      ...result.exit_points.map(exit => exit.id),
    ]);

    assert.equal(result.nodes.find(node => node.name === 'MainWindow')?.id, 'class_main_window');
    assert.equal(result.entry_points.find(entry => entry.metadata?.entry_type === 'window')?.source_node, 'class_main_window');
    assert.equal(result.exit_points.find(exit => exit.name.includes('PatientService'))?.source_node, 'class_patient_service');
    assert.ok(result.edges.every(edge => availableIds.has(edge.source) && availableIds.has(edge.target)));
    assert.ok(result.exit_points.every(exit => availableIds.has(exit.source_node)));
  } finally {
    await fs.remove(dir);
  }
});

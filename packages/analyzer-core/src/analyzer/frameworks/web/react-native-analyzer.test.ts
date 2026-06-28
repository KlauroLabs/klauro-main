import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ReactNativeAnalyzer } from './react-native-analyzer';
import { AnalysisContext } from '../../core/base-analyzer';

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'rn-fixture',
    dependencies: {
      'react-native': '0.74.0',
      expo: '~51.0.0',
      'expo-router': '~3.5.0',
      'expo-camera': '~15.0.0',
      '@react-navigation/native': '^6.0.0',
      '@react-navigation/native-stack': '^6.0.0',
    },
  });

  await fs.writeJson(path.join(root, 'app.json'), {
    expo: { name: 'rn-fixture', slug: 'rn-fixture' },
  });

  // screens/HomeScreen.tsx — renders RN primitives, imports react-native, uses expo-camera.
  await fs.ensureDir(path.join(root, 'screens'));
  await fs.writeFile(
    path.join(root, 'screens', 'HomeScreen.tsx'),
    `import React from 'react';
import { View, Text, Button } from 'react-native';
import { Camera } from 'expo-camera';

export default function HomeScreen({ navigation }) {
  return (
    <View>
      <Text>Home</Text>
      <Button title="Go" onPress={() => navigation.navigate('Details')} />
    </View>
  );
}
`
  );

  await fs.writeFile(
    path.join(root, 'screens', 'DetailsScreen.tsx'),
    `import React from 'react';
import { View, Text } from 'react-native';

export default function DetailsScreen() {
  return (
    <View>
      <Text>Details</Text>
    </View>
  );
}
`
  );

  // App.tsx — Stack navigator registering screens.
  await fs.writeFile(
    path.join(root, 'App.tsx'),
    `import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from './screens/HomeScreen';
import DetailsScreen from './screens/DetailsScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Details" component={DetailsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
`
  );

  // Expo Router file route: app/index.tsx and a dynamic route + layout.
  await fs.ensureDir(path.join(root, 'app'));
  await fs.writeFile(
    path.join(root, 'app', 'index.tsx'),
    `import { View, Text } from 'react-native';
export default function Index() {
  return (<View><Text>Index</Text></View>);
}
`
  );
  await fs.writeFile(
    path.join(root, 'app', '_layout.tsx'),
    `import { Stack } from 'expo-router';
export default function Layout() {
  return <Stack />;
}
`
  );
  await fs.ensureDir(path.join(root, 'app', 'profile'));
  await fs.writeFile(
    path.join(root, 'app', 'profile', '[id].tsx'),
    `import { View, Text } from 'react-native';
export default function Profile() {
  return (<View><Text>Profile</Text></View>);
}
`
  );

  return root;
}

async function runFullAnalysis(root: string) {
  const analyzer = new ReactNativeAnalyzer();
  const ctx: AnalysisContext = { projectPath: root };
  return analyzer.analyze(ctx);
}

test('ReactNativeAnalyzer: canAnalyze true for Expo / react-native project', async () => {
  const root = await makeProject();
  try {
    const analyzer = new ReactNativeAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('ReactNativeAnalyzer: canAnalyze false for plain TS project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rn-neg-'));
  try {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'plain', dependencies: { typescript: '^5.0.0' } });
    await fs.writeFile(path.join(root, 'index.ts'), `export const x = 1;\n`);
    const analyzer = new ReactNativeAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('ReactNativeAnalyzer: HomeScreen produces a screen node', async () => {
  const root = await makeProject();
  try {
    const result = await runFullAnalysis(root);
    const home = result.nodes.find(n => n.name === 'HomeScreen');
    assert.ok(home, 'HomeScreen node should exist');
    assert.strictEqual(home!.type, 'rn-screen', 'HomeScreen should be typed rn-screen');
    assert.ok(
      (home!.metadata?.attributes?.primitives_used || []).includes('View'),
      'HomeScreen should record View primitive usage'
    );
  } finally {
    await fs.remove(root);
  }
});

test('ReactNativeAnalyzer: Stack.Screen registrations + navigate edge', async () => {
  const root = await makeProject();
  try {
    const result = await runFullAnalysis(root);

    const homeReg = result.nodes.find(n => n.type === 'navigation-screen' && n.name === 'Home');
    const detailsReg = result.nodes.find(n => n.type === 'navigation-screen' && n.name === 'Details');
    assert.ok(homeReg, 'Home screen registration node should exist');
    assert.ok(detailsReg, 'Details screen registration node should exist');
    assert.strictEqual(homeReg!.metadata?.attributes?.component, 'HomeScreen');

    // navigation.navigate('Details') in HomeScreen -> Details registration node.
    const navEdge = result.edges.find(e => e.type === 'navigates' && e.target === detailsReg!.id);
    assert.ok(navEdge, 'a navigate edge should target the Details screen');
  } finally {
    await fs.remove(root);
  }
});

test('ReactNativeAnalyzer: expo-router index route + dynamic route + layout', async () => {
  const root = await makeProject();
  try {
    const result = await runFullAnalysis(root);

    const indexRoute = result.nodes.find(n => n.type === 'route' && n.metadata?.attributes?.routePath === '/');
    assert.ok(indexRoute, 'expo-router index route (/) should exist');

    const indexEntry = result.entry_points.find(ep => ep.trigger?.path === '/' && ep.type === 'route');
    assert.ok(indexEntry, 'index route should produce a route entry point');

    const dynamicRoute = result.nodes.find(n => n.type === 'route' && n.metadata?.attributes?.routePath === '/profile/:id');
    assert.ok(dynamicRoute, 'dynamic route /profile/:id should exist');
    assert.ok(
      (dynamicRoute!.metadata?.attributes?.dynamicParams || []).includes('id'),
      'dynamic route should record the id param'
    );

    const layout = result.nodes.find(n => n.type === 'layout');
    assert.ok(layout, '_layout.tsx should produce a layout node');
  } finally {
    await fs.remove(root);
  }
});

test('ReactNativeAnalyzer: native capability (expo-camera) detected', async () => {
  const root = await makeProject();
  try {
    const result = await runFullAnalysis(root);
    const cap = result.nodes.find(n => n.type === 'native-capability' && n.name === 'expo-camera');
    assert.ok(cap, 'expo-camera native capability node should exist');
    assert.strictEqual(cap!.metadata?.attributes?.feature, 'camera');
  } finally {
    await fs.remove(root);
  }
});

test('ReactNativeAnalyzer: single-file incremental analysis attributes nodes', async () => {
  const root = await makeProject();
  try {
    const analyzer = new ReactNativeAnalyzer();
    assert.strictEqual(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles!(root);
    assert.ok(relevant.includes('App.tsx'), 'getRelevantFiles should include App.tsx');

    const rel = 'App.tsx';
    const result = await analyzer.analyzeFileSingle!({
      projectPath: root,
      filePath: path.join(root, rel),
      relativePath: rel,
    });
    assert.strictEqual(result.filePath, rel);
    const homeReg = result.nodes.find(n => n.type === 'navigation-screen' && n.name === 'Home');
    assert.ok(homeReg, 'single-file analysis of App.tsx should yield the Home registration');
  } finally {
    await fs.remove(root);
  }
});

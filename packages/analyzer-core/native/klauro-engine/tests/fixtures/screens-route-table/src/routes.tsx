import { lazy } from 'react';
import Home from './pages/Home';

const ChartList = lazy(() => import(/* webpackChunkName: "ChartList" */ './pages/ChartList'));

export const RoutePaths = { Home: '/welcome/', Charts: '/charts/' };

export const routes = [
  { path: RoutePaths.Home, Component: Home },
  { path: RoutePaths.Charts, Component: ChartList },
];

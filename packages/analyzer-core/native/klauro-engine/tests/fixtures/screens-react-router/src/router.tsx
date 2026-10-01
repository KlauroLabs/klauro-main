import { lazy } from 'react';
import { createBrowserRouter, Outlet } from 'react-router-dom';
import { Home } from './pages/Home';
import OrderPage from './pages/OrderPage';

const Settings = lazy(() => import('./pages/Settings'));

function Layout() {
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'orders/:id', element: <OrderPage /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);

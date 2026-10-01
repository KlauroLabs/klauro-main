import { Route, Routes } from 'react-router-dom';
import { Shell } from './pages/Shell';
import { About } from './pages/About';
import { Account } from './pages/Account';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Shell />}>
        <Route index element={<About />} />
        <Route path="account" element={<Account />} />
      </Route>
    </Routes>
  );
}

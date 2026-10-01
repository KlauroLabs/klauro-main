import { WrappedRoute } from './WrappedRoute';
import { About } from './pages/About';
import { Detail, Lists, Wrapped } from './loaders';
import { SettingsPage } from './pages/SettingsPage';
import { Paths } from './paths';

export const extra = [{ path: Paths.Settings, Component: SettingsPage }];

export function App() {
  return (
    <div>
      <WrappedRoute path='/about' component={About} />
      <WrappedRoute path='/lists' component={Lists} />
      <WrappedRoute path='/detail' component={Detail} />
      <WrappedRoute path='/wrapped' component={Wrapped} />
    </div>
  );
}

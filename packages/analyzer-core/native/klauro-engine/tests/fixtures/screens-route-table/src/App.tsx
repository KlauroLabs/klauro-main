import { WrappedRoute } from './WrappedRoute';
import { About } from './pages/About';

export function App() {
  return (
    <div>
      <WrappedRoute path='/about' component={About} />
    </div>
  );
}

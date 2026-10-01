import { Route } from 'react-router-dom';
import { Shell } from './Shell';

export function Root() {
  return <Route path="/" component={Shell} />;
}

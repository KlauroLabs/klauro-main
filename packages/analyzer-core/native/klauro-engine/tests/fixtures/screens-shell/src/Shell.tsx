import { Route } from 'react-router-dom';
import { Inbox } from './Inbox';

export function Shell() {
  return (
    <div>
      <Route path="/inbox" component={Inbox} />
    </div>
  );
}

import { memo } from 'react';

function Toolbar() {
  return <nav>Tools</nav>;
}

function WrappedBody() {
  return <p>Body</p>;
}

export function Shared() {
  return <Toolbar />;
}

export default memo(WrappedBody);

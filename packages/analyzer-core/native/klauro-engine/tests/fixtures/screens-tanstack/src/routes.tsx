import { createRootRoute, createRoute } from '@tanstack/react-router';

function PostsPage() {
  return <button onClick={() => fetch('/api/posts/refresh', { method: 'POST' })}>Refresh</button>;
}

function formatTitle(title: string) {
  return title.trim();
}

const rootRoute = createRootRoute();

export const postsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/posts', component: PostsPage });

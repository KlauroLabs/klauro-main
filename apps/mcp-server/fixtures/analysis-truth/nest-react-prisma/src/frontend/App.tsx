import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router-dom';

const queryClient = new QueryClient();

export function UserPage() {
  const { id = '' } = useParams();
  const userQuery = useQuery({
    queryKey: ['user', id],
    queryFn: () => fetch(`/api/users/${id}`).then(response => response.json())
  });

  return (
    <main>
      <h1>{userQuery.data?.name || 'Loading user'}</h1>
      <Link to="/users/new">Create user</Link>
    </main>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/users/:id" element={<UserPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

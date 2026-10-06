import { component$ } from '@builder.io/qwik';
import { UserCard } from '../components/user-card';

export const App = component$(() => {
  return (
    <main>
      <UserCard name="Ada" age={36} />
    </main>
  );
});

export default App;

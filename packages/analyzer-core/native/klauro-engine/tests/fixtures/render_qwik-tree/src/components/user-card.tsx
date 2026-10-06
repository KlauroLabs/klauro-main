import { component$ } from '@builder.io/qwik';

interface UserCardProps { name: string; age: number; }

export const UserCard = component$<UserCardProps>(({ name, age }) => {
  return <div class="card">{name} ({age})</div>;
});

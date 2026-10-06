<script>
  import UserCard from './UserCard.svelte';
  let user = { name: 'Ada', email: 'ada@x.com' };
</script>

<div class="app">
  <UserCard name={user.name} email={user.email} />
</div>

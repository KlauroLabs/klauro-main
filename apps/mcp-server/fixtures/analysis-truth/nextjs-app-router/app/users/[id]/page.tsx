export default async function UserPage({ params }: { params: { id: string } }) {
  const user = await fetch(`/api/users/${params.id}`).then(response => response.json());

  return (
    <main>
      <h1>{user.name}</h1>
    </main>
  );
}

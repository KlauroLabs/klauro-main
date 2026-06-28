interface UserCardProps { name: string; age: number; }
export function UserCard({ name, age }: UserCardProps) {
  return <div className="card">{name} ({age})</div>;
}

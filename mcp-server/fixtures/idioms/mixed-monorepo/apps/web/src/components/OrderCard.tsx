export function OrderCard({ totalCents }: { totalCents: number }) {
  return <article>${(totalCents / 100).toFixed(2)}</article>;
}

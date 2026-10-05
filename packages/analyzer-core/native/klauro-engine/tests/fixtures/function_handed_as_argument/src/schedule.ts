function tick(): void {
  refresh();
}

function refresh(): void {}

export function start(): void {
  setTimeout(tick, 100);
  const total = 3;
  console.log(total);
}

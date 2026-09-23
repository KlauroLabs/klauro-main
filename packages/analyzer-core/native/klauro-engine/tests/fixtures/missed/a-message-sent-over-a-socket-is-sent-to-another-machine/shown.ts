export function tell(address: string, command: string) {
  const socket = new WebSocket(address);
  socket.send(JSON.stringify({ command }));
  return socket;
}

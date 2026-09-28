export async function main() {
  const command = process.argv[2] || 'help';

  if (command === 'start') {
    start();
    return;
  }

  if (command === 'stop') {
    stop();
    return;
  }
}

function start() {
  console.log('starting');
}

function stop() {
  console.log('stopping');
}

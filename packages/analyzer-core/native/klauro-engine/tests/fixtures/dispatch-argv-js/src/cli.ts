export async function main() {
  const command = process.argv[2] || 'help';

  if (command === 'build' || command === 'compile') {
    build();
    return;
  }

  if (command === 'test') {
    runTests();
    return;
  }
}

function build() {
  console.log('building');
}

function runTests() {
  console.log('testing');
}

export function runSwitch() {
  const command = process.argv[2] || 'help';
  switch (command) {
    case 'start':
      start();
      break;
    case 'stop':
      stop();
      break;
  }
}

function start() {
  console.log('starting');
}

function stop() {
  console.log('stopping');
}

export function configure(mode: string) {
  if (mode === 'fast') {
    return true;
  }
  return mode === 'slow';
}

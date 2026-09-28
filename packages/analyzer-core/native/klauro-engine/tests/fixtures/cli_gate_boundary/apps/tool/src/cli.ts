export async function main() {
  const command = process.argv[2] || 'help';

  if (command === 'build') {
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

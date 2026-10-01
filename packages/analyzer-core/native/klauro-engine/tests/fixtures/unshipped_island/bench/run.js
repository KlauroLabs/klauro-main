function measure(rounds) {
  let total = 0;
  for (let at = 0; at < rounds; at++) {
    total += at;
  }
  return total;
}

function main() {
  measure(1000);
}

main();

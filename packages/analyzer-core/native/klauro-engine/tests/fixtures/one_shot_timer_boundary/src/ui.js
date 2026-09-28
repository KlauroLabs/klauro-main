function onClick() {
  setTimeout(() => {
    doSomething();
  }, 300);
}

function scheduleJob() {
  setInterval(() => {
    doWork();
  }, 5000);
}

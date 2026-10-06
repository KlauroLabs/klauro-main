import { spawn } from "child_process";

export function launch(job: string) {
  return start(job);
}

function start(job: string) {
  return begin(job);
}

function begin(job: string) {
  return spawn("worker", [job]);
}

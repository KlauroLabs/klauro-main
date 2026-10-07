import { emit } from "../../sdk/src/index";
export function start(): string {
  emit("started");
  return "running";
}
start();

import { format } from "@lib/format";
import { Panel } from "@ui/panel";

export function run(value: string) {
  return new Panel(format(value));
}

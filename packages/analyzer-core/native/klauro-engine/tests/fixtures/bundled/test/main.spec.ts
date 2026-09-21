import { map } from "lodash-es";
import { fixture } from "spec/helpers";

export function check() {
  return map([fixture()], (entry) => entry.name);
}

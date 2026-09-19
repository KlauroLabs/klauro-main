import { map } from "lodash-es";
import { render } from "support/render";

export function page(values: string[]) {
  return map(values, render);
}

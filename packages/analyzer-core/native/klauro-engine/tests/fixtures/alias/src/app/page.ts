import { settings } from "settings";
import { format } from "$lib/format";
import { render } from "@/app/render";
import { Marked } from "marked";

export function page(value: string) {
  return render(format(value), settings(), new Marked());
}

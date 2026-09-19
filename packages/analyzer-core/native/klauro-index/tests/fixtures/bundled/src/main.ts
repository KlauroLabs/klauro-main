import { useState } from "react";
import { slug } from "~utils";
import { Panel } from "@/ui/panel";

export function run(value: string) {
  return new Panel(slug(value) + useState());
}

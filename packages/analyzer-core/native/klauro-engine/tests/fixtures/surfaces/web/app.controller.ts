import { Controller, Get } from "@nestjs/common";
import { Route } from "./routes";

@Controller(Route.App)
export class AppController {
  @Get()
  getCustomCss() {
    return "";
  }
}

export function register(router: { MapRoute(name: string): void }) {
  router.MapRoute("legacy");
}

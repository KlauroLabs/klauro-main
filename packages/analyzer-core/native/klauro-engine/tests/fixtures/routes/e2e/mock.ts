export function mockServer(context: BrowserContext): void {
  context.route('**/api/users/me', (route) => route.fulfill({ status: 200 }));
}

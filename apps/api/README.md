# Klauro API

Hosted API entrypoint for account, workspace, project, and remote analysis routes.

This package exists so the deployable API surface is separate from the React app and from the local MCP binary. The current server delegates to the shared remote analyzer/account implementation while that code is extracted into cleaner product modules.

```bash
npm run api:dev
npm run api:build
```


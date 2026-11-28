# @polso/mcp

The MCP endpoint that the phone and the self-hosted server share: the protocol, the six read-only
Health tools, HTTP request handling with the token check, and the catalog of Health types.

The tools read Health data through the `HealthQueries` interface in
[`src/health/queries.ts`](src/health/queries.ts). The app answers it from HealthKit; a server
answers it from its own copy of the data.

Plain TypeScript with no runtime dependencies. Relative imports keep their `.ts` extensions, so
Node runs the source as is.

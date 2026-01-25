import { defineConfig } from "tsup";

export default defineConfig([
  // CLI entry point (main binary)
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    outDir: "dist",
    target: "node18",
    sourcemap: true,
    minify: false,
    splitting: false,
    bundle: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  // MCP Server
  {
    entry: { server: "src/talk_to_figma_mcp/server.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    outDir: "dist",
    target: "node18",
    sourcemap: true,
    minify: false,
    splitting: false,
    bundle: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  // WebSocket Server
  {
    entry: { socket: "src/socket.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    outDir: "dist",
    target: "node18",
    sourcemap: true,
    minify: false,
    splitting: false,
    bundle: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);

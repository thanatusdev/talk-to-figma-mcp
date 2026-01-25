/**
 * CLI entry point for talk-to-figma-mcp
 *
 * Usage:
 *   npx talk-to-figma-mcp-tool           # Start MCP server
 *   npx talk-to-figma-mcp-tool --socket  # Start WebSocket server
 *   npx talk-to-figma-mcp-tool -s        # Start WebSocket server (shorthand)
 *   npx talk-to-figma-mcp-tool --plugin  # Show Figma plugin location
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);

if (args.includes("--socket") || args.includes("-s")) {
  // Start the WebSocket server
  import("./socket.js");
} else if (args.includes("--plugin") || args.includes("-p")) {
  // Show Figma plugin location
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pluginPath = join(__dirname, "..", "src", "cursor_mcp_plugin");

  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Figma Plugin Installation                        ║
╠════════════════════════════════════════════════════════════╣
║  The Figma plugin files are located at:                    ║
╚════════════════════════════════════════════════════════════╝

${pluginPath}

To install the plugin in Figma:

1. Open Figma
2. Go to Plugins > Development > Import plugin from manifest...
3. Navigate to the path above and select manifest.json
4. The "Talk to Figma MCP" plugin will appear in your plugins menu

Alternatively, download the plugin files from:
https://github.com/thanatusdev/talk-to-figma-mcp/tree/main/src/cursor_mcp_plugin
`);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Talk to Figma MCP - AI-powered Figma integration

Usage:
  npx talk-to-figma-mcp-tool [options]

Options:
  --socket, -s    Start the WebSocket server (required for Figma plugin)
  --plugin, -p    Show Figma plugin installation path
  --help, -h      Show this help message

Examples:
  npx talk-to-figma-mcp-tool              # Start MCP server (for editor integration)
  npx talk-to-figma-mcp-tool --socket     # Start WebSocket server (run this first!)
  npx talk-to-figma-mcp-tool --plugin     # Show where to find the Figma plugin

Environment Variables:
  FIGMA_WS_PORT   WebSocket server port (default: 3055)
  FIGMA_WS_HOST   Host binding (default: localhost, use 0.0.0.0 for external)

For more information, visit: https://github.com/thanatusdev/talk-to-figma-mcp
`);
} else {
  // Start the MCP server
  import("./talk_to_figma_mcp/server.js");
}

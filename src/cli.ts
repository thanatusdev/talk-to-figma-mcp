/**
 * CLI entry point for talk-to-figma-mcp
 *
 * Usage:
 *   npx talk-to-figma-mcp           # Start MCP server
 *   npx talk-to-figma-mcp --socket  # Start WebSocket server
 *   npx talk-to-figma-mcp -s        # Start WebSocket server (shorthand)
 */

const args = process.argv.slice(2);

if (args.includes("--socket") || args.includes("-s")) {
  // Start the WebSocket server
  import("./socket.js");
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Talk to Figma MCP - AI-powered Figma integration

Usage:
  npx talk-to-figma-mcp [options]

Options:
  --socket, -s    Start the WebSocket server (required for Figma plugin)
  --server=URL    Connect to a custom WebSocket server URL
  --help, -h      Show this help message

Examples:
  npx talk-to-figma-mcp              # Start MCP server (for editor integration)
  npx talk-to-figma-mcp --socket     # Start WebSocket server (run this first!)

Environment Variables:
  FIGMA_WS_PORT   WebSocket server port (default: 3055)
  FIGMA_WS_HOST   Host binding (default: localhost, use 0.0.0.0 for external)

For more information, visit: https://github.com/anthropics/talk-to-figma-mcp
`);
} else {
  // Start the MCP server
  import("./talk_to_figma_mcp/server.js");
}

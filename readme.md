# Talk to Figma MCP

A Model Context Protocol (MCP) integration that enables AI-powered tools like Cursor, Windsurf, Cline and Claude to communicate with Figma for reading designs and modifying them programmatically.

https://github.com/user-attachments/assets/129a14d2-ed73-470f-9a4c-2240b2a4885c

## Quick Start (Recommended)

The easiest way to use Talk to Figma MCP is via npx/bunx - no need to clone the repository!

### 1. Start the WebSocket Server

In one terminal, run:

```bash
npx talk-to-figma-mcp@latest --socket
```

Or with Bun:

```bash
bunx talk-to-figma-mcp@latest --socket
```

### 2. Configure Your Editor

Add the MCP server to your editor's configuration:

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "npx",
      "args": ["-y", "talk-to-figma-mcp@latest"]
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "npx",
      "args": ["-y", "talk-to-figma-mcp@latest"]
    }
  }
}
```

**Windsurf** (`~/.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "npx",
      "args": ["-y", "talk-to-figma-mcp@latest"]
    }
  }
}
```

**Zed** (`settings.json`):

```json
{
  "context_servers": {
    "TalkToFigma": {
      "command": "npx",
      "args": ["-y", "talk-to-figma-mcp@latest"]
    }
  }
}
```

### 3. Install the Figma Plugin

1. Download the plugin files from the `src/cursor_mcp_plugin/` folder in this repository
2. In Figma, go to **Plugins > Development > Import plugin from manifest...**
3. Select the `manifest.json` file from the downloaded folder
4. The plugin will appear in your Figma plugins menu

### 4. Connect and Use

1. Open Figma and run the "Cursor MCP Plugin" from the plugins menu
2. The plugin will show a channel name - copy it
3. In your AI editor, use the `join_channel` tool with the channel name
4. Start designing with AI!

## Project Structure

- `src/talk_to_figma_mcp/` - TypeScript MCP server for Figma integration
- `src/cursor_mcp_plugin/` - Figma plugin for communicating with your editor
- `src/socket.ts` - WebSocket server that facilitates communication

## Development Setup

If you want to contribute or modify the project:

### Prerequisites

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Installation

```bash
git clone https://github.com/anthropics/talk-to-figma-mcp.git
cd talk-to-figma-mcp
bun install
```

### Running Locally

1. Start the WebSocket server:

```bash
bun run socket
```

2. The MCP server runs automatically when your editor invokes it

### Building

```bash
bun run build
```

## Quick Video Tutorial

[Video Link](https://www.linkedin.com/posts/sonnylazuardi_just-wanted-to-share-my-latest-experiment-activity-7307821553654657024-yrh8)

## Design Automation Example

**Bulk text content replacement**

Thanks to [@dusskapark](https://github.com/dusskapark) for contributing the bulk text replacement feature. Here is the [demo video](https://www.youtube.com/watch?v=j05gGT3xfCs).

## Windows + WSL Guide

1. Install bun via powershell:

```bash
powershell -c "irm bun.sh/install.ps1|iex"
```

2. Set environment variable to allow connections from WSL:

```bash
export FIGMA_WS_HOST=0.0.0.0
npx talk-to-figma-mcp@latest --socket
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FIGMA_WS_PORT` | WebSocket server port | `3055` |
| `FIGMA_WS_HOST` | Host binding (`0.0.0.0` for external connections) | `localhost` |

## MCP Tools

The MCP server provides 60+ tools for interacting with Figma:

### Document & Selection

- `get_document_info` - Get information about the current Figma document
- `get_selection` - Get information about the current selection
- `read_my_design` - Get detailed node information about the current selection
- `get_node_info` - Get detailed information about a specific node
- `get_nodes_info` - Get detailed information about multiple nodes

### Creating Elements

- `create_rectangle` - Create a new rectangle
- `create_frame` - Create a new frame with auto-layout support
- `create_text` - Create a new text node
- `create_ellipse` - Create a new ellipse/circle
- `create_line` - Create a new line

### Styling

- `set_fill_color` - Set the fill color of a node (RGBA)
- `set_stroke_color` - Set the stroke color and weight
- `set_gradient_fill` - Apply gradient fills (linear, radial, angular, diamond)
- `set_corner_radius` - Set corner radius with per-corner control
- `set_effects` - Apply visual effects (shadows, blurs)
- `set_blend_mode` - Set layer blend mode
- `set_opacity` - Set node opacity
- `set_visibility` - Show/hide nodes

### Text Operations

- `scan_text_nodes` - Scan text nodes with intelligent chunking
- `set_text_content` - Set text content of a single node
- `set_multiple_text_contents` - Batch update multiple text nodes
- `set_text_style` - Set advanced typography (line-height, letter-spacing, decoration)

### Layout & Organization

- `set_auto_layout` - Configure auto-layout properties
- `set_constraints` - Set responsive constraints
- `move_node` - Move a node to a new position
- `resize_node` - Resize a node
- `delete_node` - Delete a node
- `delete_multiple_nodes` - Delete multiple nodes efficiently
- `clone_node` - Duplicate a node
- `group_nodes` - Group multiple nodes
- `ungroup_nodes` - Ungroup nodes
- `flatten_node` - Flatten to vector
- `insert_child` - Move node into a parent
- `rename_node` - Rename a node
- `set_locked` - Lock/unlock nodes

### Navigation & Selection

- `get_children` - Get all direct children of a node
- `get_parent` - Get the parent node
- `find_nodes_by_name` - Find nodes by name pattern (supports wildcards)
- `set_selection` - Programmatically select nodes
- `scroll_into_view` - Scroll viewport to show a node

### Design Analysis

- `get_all_colors` - Extract all colors used in a design
- `get_all_fonts` - List all fonts used (typography audit)
- `node_exists` - Check if a node exists (validation)

### Annotations

- `get_annotations` - Get annotations in document or node
- `set_annotation` - Create/update an annotation
- `set_multiple_annotations` - Batch create/update annotations
- `scan_nodes_by_types` - Scan for nodes by type

### Components & Styles

- `get_styles` - Get local styles
- `get_local_components` - Get local components
- `create_component_instance` - Create a component instance

### Export

- `export_node_as_image` - Export as PNG, JPG, SVG, or PDF

### Connection

- `join_channel` - Join a channel to communicate with Figma

## Best Practices

1. **Always join a channel** before sending commands
2. **Get document overview** using `get_document_info` first
3. **Check current selection** with `get_selection` before modifications
4. **Use batch operations** when possible for better performance
5. **Verify changes** using `get_node_info` or `export_node_as_image`
6. **Handle errors** appropriately - all commands can throw exceptions

### For Large Designs

- Use chunking parameters in `scan_text_nodes`
- Monitor progress through WebSocket updates
- Use `find_nodes_by_name` to locate specific elements

### For Text Operations

- Use `set_multiple_text_contents` for batch updates
- Leverage `scan_text_nodes` for discovery
- Verify with targeted exports

## Troubleshooting

### Connection Issues

1. Ensure the WebSocket server is running on port 3055
2. Check that the Figma plugin is connected to the same channel
3. Verify no firewall is blocking localhost connections

### Plugin Not Appearing

1. Make sure you imported the plugin via **Plugins > Development > Import plugin from manifest...**
2. Refresh Figma if needed

### Commands Not Working

1. Verify you've joined a channel with `join_channel`
2. Check the WebSocket server terminal for error messages
3. Ensure the Figma file is open and editable

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

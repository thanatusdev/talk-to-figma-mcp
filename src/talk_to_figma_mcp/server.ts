import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { v4 as uuidv4 } from "uuid";
import WebSocket from "ws";
import { z } from "zod";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: "command_progress";
  commandId: string;
  commandType: string;
  status: "started" | "in_progress" | "completed" | "error";
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`),
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    lastActivity: number;
  }
>();

// Track which channel each client is in
let currentChannel: string | null = null;

// Reconnection state with exponential backoff
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;

function getReconnectDelay(): number {
  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY,
  );
  return delay + Math.random() * 1000;
}

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find((arg) => arg.startsWith("--server="));
const serverUrl = serverArg ? serverArg.split("=")[1] : "localhost";
const WS_URL =
  serverUrl === "localhost" ? `ws://${serverUrl}` : `wss://${serverUrl}`;

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Selection Tool
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Read My Design Tool
server.tool(
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("read_my_design", {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Node Info Tool
server.tool(
  "get_node_info",
  "Get detailed information about a specific node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId });
      return {
        content: [
          { type: "text", text: JSON.stringify(filterFigmaNode(result)) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

function rgbaToHex(color: any): string {
  if (color.startsWith("#")) {
    return color;
  }
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a === 255 ? "" : a.toString(16).padStart(2, "0")}`;
}

function filterFigmaNode(node: any) {
  if (node.type === "VECTOR") {
    return null;
  }

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill: any) => {
      const processedFill = { ...fill };
      delete processedFill.boundVariables;
      delete processedFill.imageRef;
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map(
          (stop: any) => {
            const processedStop = { ...stop };
            if (processedStop.color) {
              processedStop.color = rgbaToHex(processedStop.color);
            }
            delete processedStop.boundVariables;
            return processedStop;
          },
        );
      }
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }
      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke: any) => {
      const processedStroke = { ...stroke };
      delete processedStroke.boundVariables;
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }
  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }
  if (node.characters) {
    filtered.characters = node.characters;
  }
  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
    };
  }
  if (node.children) {
    filtered.children = node.children
      .map((child: any) => filterFigmaNode(child))
      .filter((child: any) => child !== null);
  }
  return filtered;
}

// Nodes Info Tool
server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: z
      .array(z.string())
      .describe("Array of node IDs to get information about"),
  },
  async ({ nodeIds }) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId) => {
          const result = await sendCommandToFigma("get_node_info", { nodeId });
          return { nodeId, info: result };
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              results.map((result) => filterFigmaNode(result.info)),
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
  }) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor,
        strokeWeight,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Optional name for the text node by default following text"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name}" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name}" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone"),
  },
  async ({ nodeId, x, y }) => {
    try {
      const result = await sendCommandToFigma("clone_node", { nodeId, x, y });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ""}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [{ type: "text", text: `Deleted node with ID: ${nodeId}` }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", {
        nodeIds,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export a node as an image from Figma",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format"),
    scale: z.number().positive().optional().describe("Export scale"),
  },
  async ({ nodeId, format, scale }) => {
    try {
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };
      return {
        content: [
          {
            type: "image",
            data: typedResult.imageData,
            mimeType: typedResult.mimeType || "image/png",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Text Content Tool
server.tool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Styles Tool
server.tool(
  "get_styles",
  "Get all styles from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z
      .string()
      .optional()
      .describe("Optional node ID to get annotations for specific node"),
    includeCategories: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include category information"),
  },
  async ({ nodeId, includeCategories }) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z
      .string()
      .optional()
      .describe(
        "The ID of the annotation to update (if updating existing annotation)",
      ),
    labelMarkdown: z
      .string()
      .describe("The annotation text in markdown format"),
    categoryId: z
      .string()
      .optional()
      .describe("The ID of the annotation category"),
    properties: z
      .array(z.object({ type: z.string() }))
      .optional()
      .describe("Additional properties for the annotation"),
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z
            .string()
            .describe("The annotation text in markdown format"),
          categoryId: z
            .string()
            .optional()
            .describe("The ID of the annotation category"),
          annotationId: z
            .string()
            .optional()
            .describe(
              "The ID of the annotation to update (if updating existing annotation)",
            ),
          properties: z
            .array(z.object({ type: z.string() }))
            .optional()
            .describe("Additional properties for the annotation"),
        }),
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }) => {
    try {
      if (!annotations || annotations.length === 0) {
        return { content: [{ type: "text", text: "No annotations provided" }] };
      }

      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${annotations.length} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter((item) => !item.success);
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults
          .map((item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`)
          .join("\n")}`;
      }

      return {
        content: [
          initialStatus,
          { type: "text" as const, text: progressText + detailedResponse },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma",
  {
    componentKey: z.string().describe("Key of the component to instantiate"),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
  },
  async ({ componentKey, x, y }) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentKey,
        x,
        y,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Corner Radius Tool
server.tool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]",
      ),
  },
  async ({ nodeId, radius, corners }) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Auto Layout Tool
server.tool(
  "set_auto_layout",
  "Configure auto-layout properties on a frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    mode: z
      .enum(["NONE", "HORIZONTAL", "VERTICAL"])
      .optional()
      .describe("Layout direction"),
    layoutWrap: z
      .enum(["NO_WRAP", "WRAP"])
      .optional()
      .describe("Wrap behavior for auto-layout"),
    paddingTop: z.number().min(0).optional().describe("Top padding"),
    paddingRight: z.number().min(0).optional().describe("Right padding"),
    paddingBottom: z.number().min(0).optional().describe("Bottom padding"),
    paddingLeft: z.number().min(0).optional().describe("Left padding"),
    itemSpacing: z.number().min(0).optional().describe("Spacing between items"),
    counterAxisSpacing: z
      .number()
      .min(0)
      .optional()
      .describe("Spacing between wrapped rows/columns"),
    primaryAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment"),
    counterAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "BASELINE"])
      .optional()
      .describe("Counter axis alignment"),
  },
  async (params) => {
    try {
      const result = await sendCommandToFigma("set_auto_layout", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting auto-layout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Effects Tool
server.tool(
  "set_effects",
  "Apply visual effects (shadows, blur) to a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    effects: z
      .array(
        z.object({
          type: z
            .enum([
              "DROP_SHADOW",
              "INNER_SHADOW",
              "LAYER_BLUR",
              "BACKGROUND_BLUR",
            ])
            .describe("Effect type"),
          visible: z.boolean().optional().describe("Whether effect is visible"),
          radius: z.number().min(0).optional().describe("Blur radius"),
          color: z
            .object({
              r: z.number().min(0).max(1),
              g: z.number().min(0).max(1),
              b: z.number().min(0).max(1),
              a: z.number().min(0).max(1),
            })
            .optional()
            .describe("Shadow color (RGBA)"),
          offset: z
            .object({ x: z.number(), y: z.number() })
            .optional()
            .describe("Shadow offset"),
          spread: z.number().optional().describe("Shadow spread"),
          blendMode: z.string().optional().describe("Blend mode"),
        }),
      )
      .describe("Array of effects to apply"),
  },
  async ({ nodeId, effects }) => {
    try {
      const result = await sendCommandToFigma("set_effects", {
        nodeId,
        effects,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting effects: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Group Nodes Tool
server.tool(
  "group_nodes",
  "Group multiple nodes together in Figma",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to group"),
    name: z.string().optional().describe("Name for the new group"),
  },
  async ({ nodeIds, name }) => {
    try {
      const result = await sendCommandToFigma("group_nodes", { nodeIds, name });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error grouping nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Ungroup Nodes Tool
server.tool(
  "ungroup_nodes",
  "Ungroup a group node, moving its children to the parent",
  {
    nodeId: z.string().describe("The ID of the group to ungroup"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("ungroup_nodes", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error ungrouping nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Flatten Node Tool
server.tool(
  "flatten_node",
  "Flatten a node to a single vector (like Outline Stroke)",
  {
    nodeId: z.string().describe("The ID of the node to flatten"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("flatten_node", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error flattening node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Insert Child Tool
server.tool(
  "insert_child",
  "Move a node into a parent container at a specific index",
  {
    parentId: z.string().describe("The ID of the parent node"),
    childId: z.string().describe("The ID of the child node to insert"),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Index to insert at (appends if not specified)"),
  },
  async ({ parentId, childId, index }) => {
    try {
      const result = await sendCommandToFigma("insert_child", {
        parentId,
        childId,
        index,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error inserting child: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// ==================== NEW IMPROVEMENT TOOLS ====================

// Set Opacity Tool
server.tool(
  "set_opacity",
  "Set the opacity of a node in Figma (0-1)",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    opacity: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Opacity value (0-1, where 0 is fully transparent and 1 is fully opaque)",
      ),
  },
  async ({ nodeId, opacity }) => {
    try {
      const result = await sendCommandToFigma("set_opacity", {
        nodeId,
        opacity,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting opacity: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Visibility Tool
server.tool(
  "set_visibility",
  "Show or hide a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    visible: z.boolean().describe("Whether the node should be visible"),
  },
  async ({ nodeId, visible }) => {
    try {
      const result = await sendCommandToFigma("set_visibility", {
        nodeId,
        visible,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting visibility: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Rename Node Tool
server.tool(
  "rename_node",
  "Rename a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to rename"),
    name: z.string().describe("The new name for the node"),
  },
  async ({ nodeId, name }) => {
    try {
      const result = await sendCommandToFigma("rename_node", { nodeId, name });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Lock Node Tool
server.tool(
  "set_locked",
  "Lock or unlock a node to prevent/allow accidental edits",
  {
    nodeId: z.string().describe("The ID of the node to lock/unlock"),
    locked: z.boolean().describe("Whether the node should be locked"),
  },
  async ({ nodeId, locked }) => {
    try {
      const result = await sendCommandToFigma("set_locked", { nodeId, locked });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting lock state: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get All Colors Tool
server.tool(
  "get_all_colors",
  "Extract all unique colors used in a node and its children (for design analysis)",
  {
    nodeId: z.string().describe("The ID of the node to analyze"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_all_colors", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting colors: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get All Fonts Tool
server.tool(
  "get_all_fonts",
  "Extract all fonts used in a node and its children (for typography audit)",
  {
    nodeId: z.string().describe("The ID of the node to analyze"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_all_fonts", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting fonts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Node Exists Tool
server.tool(
  "node_exists",
  "Check if a node exists in the Figma document (useful for validation before operations)",
  {
    nodeId: z.string().describe("The ID of the node to check"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("node_exists", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error checking node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Children Tool
server.tool(
  "get_children",
  "Get all direct children of a node",
  {
    nodeId: z.string().describe("The ID of the parent node"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_children", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting children: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Find Nodes by Name Tool
server.tool(
  "find_nodes_by_name",
  "Find nodes by name pattern within a parent node",
  {
    nodeId: z.string().describe("The ID of the parent node to search within"),
    pattern: z
      .string()
      .describe("Name pattern to search for (supports * wildcard)"),
    type: z
      .string()
      .optional()
      .describe(
        "Optional: filter by node type (e.g., 'TEXT', 'FRAME', 'COMPONENT')",
      ),
  },
  async ({ nodeId, pattern, type }) => {
    try {
      const result = await sendCommandToFigma("find_nodes_by_name", {
        nodeId,
        pattern,
        type,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error finding nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Gradient Fill Tool
server.tool(
  "set_gradient_fill",
  "Set a gradient fill on a node",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    gradientType: z
      .enum(["LINEAR", "RADIAL", "ANGULAR", "DIAMOND"])
      .describe("Type of gradient"),
    stops: z
      .array(
        z.object({
          position: z
            .number()
            .min(0)
            .max(1)
            .describe("Position of the stop (0-1)"),
          color: z
            .object({
              r: z.number().min(0).max(1).describe("Red component (0-1)"),
              g: z.number().min(0).max(1).describe("Green component (0-1)"),
              b: z.number().min(0).max(1).describe("Blue component (0-1)"),
              a: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Alpha component (0-1)"),
            })
            .describe("Color at this stop"),
        }),
      )
      .min(2)
      .describe("Array of gradient stops (minimum 2)"),
    angle: z
      .number()
      .optional()
      .describe("Rotation angle in degrees (for linear gradients)"),
  },
  async ({ nodeId, gradientType, stops, angle }) => {
    try {
      const result = await sendCommandToFigma("set_gradient_fill", {
        nodeId,
        gradientType,
        stops,
        angle,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting gradient: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Text Style Tool
server.tool(
  "set_text_style",
  "Set advanced text styling properties (line height, letter spacing, etc.)",
  {
    nodeId: z.string().describe("The ID of the text node to style"),
    fontSize: z.number().positive().optional().describe("Font size in pixels"),
    fontWeight: z.number().optional().describe("Font weight (100-900)"),
    letterSpacing: z.number().optional().describe("Letter spacing in pixels"),
    lineHeight: z
      .union([
        z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
        z.literal("AUTO"),
      ])
      .optional()
      .describe("Line height (AUTO, or {value, unit})"),
    textAlignHorizontal: z
      .enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
      .optional()
      .describe("Horizontal text alignment"),
    textAlignVertical: z
      .enum(["TOP", "CENTER", "BOTTOM"])
      .optional()
      .describe("Vertical text alignment"),
    textDecoration: z
      .enum(["NONE", "UNDERLINE", "STRIKETHROUGH"])
      .optional()
      .describe("Text decoration"),
    textCase: z
      .enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"])
      .optional()
      .describe("Text case transformation"),
  },
  async ({ nodeId, ...styles }) => {
    try {
      const result = await sendCommandToFigma("set_text_style", {
        nodeId,
        ...styles,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Constraints Tool
server.tool(
  "set_constraints",
  "Set constraints for responsive behavior when parent is resized",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    horizontal: z
      .enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"])
      .optional()
      .describe("Horizontal constraint (MIN=left, MAX=right)"),
    vertical: z
      .enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"])
      .optional()
      .describe("Vertical constraint (MIN=top, MAX=bottom)"),
  },
  async ({ nodeId, horizontal, vertical }) => {
    try {
      const result = await sendCommandToFigma("set_constraints", {
        nodeId,
        horizontal,
        vertical,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting constraints: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Blend Mode Tool
server.tool(
  "set_blend_mode",
  "Set the blend mode of a node",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    blendMode: z
      .enum([
        "NORMAL",
        "DARKEN",
        "MULTIPLY",
        "LINEAR_BURN",
        "COLOR_BURN",
        "LIGHTEN",
        "SCREEN",
        "LINEAR_DODGE",
        "COLOR_DODGE",
        "OVERLAY",
        "SOFT_LIGHT",
        "HARD_LIGHT",
        "DIFFERENCE",
        "EXCLUSION",
        "HUE",
        "SATURATION",
        "COLOR",
        "LUMINOSITY",
      ])
      .describe("The blend mode to apply"),
  },
  async ({ nodeId, blendMode }) => {
    try {
      const result = await sendCommandToFigma("set_blend_mode", {
        nodeId,
        blendMode,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting blend mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Ellipse Tool
server.tool(
  "create_ellipse",
  "Create a new ellipse/circle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the ellipse"),
    height: z
      .number()
      .describe("Height of the ellipse (same as width for circle)"),
    name: z.string().optional().describe("Optional name for the ellipse"),
    parentId: z.string().optional().describe("Optional parent node ID"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      })
      .optional()
      .describe("Fill color in RGBA format"),
  },
  async ({ x, y, width, height, name, parentId, fillColor }) => {
    try {
      const result = await sendCommandToFigma("create_ellipse", {
        x,
        y,
        width,
        height,
        name: name || "Ellipse",
        parentId,
        fillColor,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating ellipse: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Line Tool
server.tool(
  "create_line",
  "Create a new line in Figma",
  {
    startX: z.number().describe("Starting X position"),
    startY: z.number().describe("Starting Y position"),
    endX: z.number().describe("Ending X position"),
    endY: z.number().describe("Ending Y position"),
    name: z.string().optional().describe("Optional name for the line"),
    parentId: z.string().optional().describe("Optional parent node ID"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({
    startX,
    startY,
    endX,
    endY,
    name,
    parentId,
    strokeColor,
    strokeWeight,
  }) => {
    try {
      const result = await sendCommandToFigma("create_line", {
        startX,
        startY,
        endX,
        endY,
        name: name || "Line",
        parentId,
        strokeColor,
        strokeWeight: strokeWeight || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating line: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Parent Tool
server.tool(
  "get_parent",
  "Get the parent node of a given node",
  {
    nodeId: z.string().describe("The ID of the node to get parent of"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_parent", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting parent: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Selection Tool
server.tool(
  "set_selection",
  "Set the current selection in Figma to specific nodes",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }) => {
    try {
      const result = await sendCommandToFigma("set_selection", { nodeIds });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selection: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Scroll Into View Tool
server.tool(
  "scroll_into_view",
  "Scroll the viewport to show a specific node",
  {
    nodeId: z.string().describe("The ID of the node to scroll to"),
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("scroll_into_view", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scrolling to node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Text Node Scanning Tool
server.tool(
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
  },
  async ({ nodeId }) => {
    try {
      const initialStatus = {
        type: "text" as const,
        text: "Starting text node scanning. This may take a moment for large designs...",
      };

      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,
        chunkSize: 10,
      });

      if (result && typeof result === "object" && "chunks" in result) {
        const typedResult = result as {
          success: boolean;
          totalNodes: number;
          processedNodes: number;
          chunks: number;
          textNodes: Array<any>;
        };

        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;

        return {
          content: [
            initialStatus,
            { type: "text" as const, text: summaryText },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.textNodes, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          initialStatus,
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for nodes with specific types in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z
      .array(z.string())
      .describe("Array of node types to find (e.g. ['COMPONENT', 'FRAME'])"),
  },
  async ({ nodeId, types }) => {
    try {
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(", ")}...`,
      };

      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types,
      });

      if (result && typeof result === "object" && "matchingNodes" in result) {
        const typedResult = result as {
          success: boolean;
          count: number;
          matchingNodes: Array<{
            id: string;
            name: string;
            type: string;
            bbox: { x: number; y: number; width: number; height: number };
          }>;
          searchedTypes: Array<string>;
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(", ")}`;

        return {
          content: [
            initialStatus,
            { type: "text" as const, text: summaryText },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.matchingNodes, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          initialStatus,
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Multiple Text Contents Tool
server.tool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        }),
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }) => {
    try {
      if (!text || text.length === 0) {
        return { content: [{ type: "text", text: "No text provided" }] };
      }

      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${text.length} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter((item) => !item.success);
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults
          .map((item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`)
          .join("\n")}`;
      }

      return {
        content: [
          initialStatus,
          { type: "text" as const, text: progressText + detailedResponse },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Join Channel Tool
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }) => {
    try {
      if (!channel) {
        return {
          content: [
            { type: "text", text: "Please provide a channel name to join:" },
          ],
          followUp: {
            tool: "join_channel",
            description: "Join the specified channel",
          },
        };
      }
      await joinChannel(channel);
      return {
        content: [
          { type: "text", text: `Successfully joined channel: ${channel}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// ==================== TYPE DEFINITIONS ====================

type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "export_node_as_image"
  | "join"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_auto_layout"
  | "set_effects"
  | "group_nodes"
  | "ungroup_nodes"
  | "flatten_node"
  | "insert_child"
  | "set_opacity"
  | "set_visibility"
  | "rename_node"
  | "set_locked"
  | "get_all_colors"
  | "get_all_fonts"
  | "node_exists"
  | "get_children"
  | "find_nodes_by_name"
  | "set_gradient_fill"
  | "set_text_style"
  | "set_constraints"
  | "set_blend_mode"
  | "create_ellipse"
  | "create_line"
  | "get_parent"
  | "set_selection"
  | "scroll_into_view";

// ==================== WEBSOCKET CONNECTION ====================

function connectToFigma(port: number = 3055) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info("Already connected to Figma");
    return;
  }

  const wsUrl = serverUrl === "localhost" ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logger.info("Connected to Figma socket server");
    currentChannel = null;
    reconnectAttempts = 0;
  });

  ws.on("message", (data: any) => {
    try {
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any;
      }

      const json = JSON.parse(data) as ProgressMessage;

      if (json.type === "progress_update") {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || "";

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;
          request.lastActivity = Date.now();
          clearTimeout(request.timeout);
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(
                `Request ${requestId} timed out after extended period of inactivity`,
              );
              pendingRequests.delete(requestId);
              request.reject(new Error("Request to Figma timed out"));
            }
          }, 60000);
          logger.info(
            `Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`,
          );
          if (
            progressData.status === "completed" &&
            progressData.progress === 100
          ) {
            logger.info(
              `Operation ${progressData.commandType} completed, waiting for final result`,
            );
          }
        }
        return;
      }

      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);

      if (
        myResponse.id &&
        pendingRequests.has(myResponse.id) &&
        myResponse.result
      ) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);
        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }
        pendingRequests.delete(myResponse.id);
      } else {
        logger.info(
          `Received broadcast message: ${JSON.stringify(myResponse)}`,
        );
      }
    } catch (error) {
      logger.error(
        `Error parsing message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  ws.on("error", (error: Error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on("close", () => {
    logger.info("Disconnected from Figma socket server");
    ws = null;

    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    reconnectAttempts++;
    const delay = getReconnectDelay();
    logger.info(
      `Attempting to reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`,
    );
    setTimeout(() => connectToFigma(port), delay);
  });
}

async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(
      `Failed to join channel: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id,
        },
      },
    };

    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(
          `Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`,
        );
        reject(new Error("Request to Figma timed out"));
      }
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now(),
    });

    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

// ==================== SERVER STARTUP ====================

async function main() {
  try {
    connectToFigma();
  } catch (error) {
    logger.warn(
      `Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`,
    );
    logger.warn("Will try to connect when the first command is sent");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaMCP server running on stdio");
}

main().catch((error) => {
  logger.error(
    `Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

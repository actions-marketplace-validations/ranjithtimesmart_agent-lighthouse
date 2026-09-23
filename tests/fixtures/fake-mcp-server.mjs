// A tiny stdio MCP server for tests: two pages of tools.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } else if (msg.method === "tools/list") {
    if (!msg.params?.cursor) {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "read_file", description: "Reads a file from disk and returns its text.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path" } }, required: ["path"] } }], nextCursor: "p2" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "delete_file", description: "Deletes a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] } });
    }
  }
});

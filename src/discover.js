import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const PROMPT_NAMES = ["system_prompt.md", "system_prompt.txt", "system-prompt.md", "prompt.md", "prompt.txt", "system.md", "system.txt"];
const TOOL_NAMES = ["tools.json", "functions.json", "mcp-tools.json", "tool_definitions.json"];

/** Normalize OpenAI, Anthropic, MCP or plain tool definitions to {name, description, parameters}. */
export function normalizeTools(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tools) ? raw.tools : Array.isArray(raw?.functions) ? raw.functions : null;
  if (!list) throw new Error("tools file must be an array, or an object with a `tools` array");
  return list.map((t, i) => {
    const f = t.type === "function" && t.function ? t.function : t;
    const parameters = f.parameters ?? f.input_schema ?? f.inputSchema ?? { type: "object", properties: {} };
    if (!f.name) throw new Error(`tool #${i + 1} has no name`);
    return { name: String(f.name), description: String(f.description ?? ""), parameters };
  });
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJSON(p) {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (e) { throw new Error(`${p}: ${e.message}`); }
}

/**
 * Load an agent definition.
 *   target: a directory (auto-detects files or reads agent-lighthouse.json) or a tools .json file
 *   opts.prompt / opts.tools: explicit file paths
 *   opts.mcp: a shell command that starts an MCP server over stdio
 */
export async function loadAgent(target = ".", opts = {}) {
  let promptPath = opts.prompt, toolsPath = opts.tools, name = opts.name;
  const abs = path.resolve(target);
  const isDir = (await stat(abs).catch(() => null))?.isDirectory();

  if (isDir) {
    const manifest = path.join(abs, "agent-lighthouse.json");
    if (await exists(manifest)) {
      const m = await readJSON(manifest);
      promptPath ??= m.prompt && path.join(abs, m.prompt);
      toolsPath ??= m.tools && path.join(abs, m.tools);
      name ??= m.name;
    }
    for (const n of PROMPT_NAMES) if (!promptPath && await exists(path.join(abs, n))) promptPath = path.join(abs, n);
    for (const n of TOOL_NAMES) if (!toolsPath && await exists(path.join(abs, n))) toolsPath = path.join(abs, n);
    name ??= path.basename(abs);
  } else if (abs.endsWith(".json") && !toolsPath) {
    toolsPath = abs;
    name ??= path.basename(abs, ".json");
  }

  const prompt = promptPath ? await readFile(promptPath, "utf8") : "";
  let tools = [];
  if (opts.mcp) {
    tools = normalizeTools(await listMcpTools(opts.mcp, opts.mcpTimeoutMs));
    name = opts.name ?? `mcp: ${opts.mcp}`;
  } else if (toolsPath) {
    tools = normalizeTools(await readJSON(toolsPath));
  }
  if (!prompt && !tools.length) {
    throw new Error(`No agent found at ${target}. Expected a system prompt (${PROMPT_NAMES[0]}, prompt.md, …) and/or tools.json, ` +
      "or an agent-lighthouse.json manifest. You can also pass --prompt, --tools or --mcp.");
  }
  return { name, prompt, tools, sources: { prompt: promptPath ?? null, tools: opts.mcp ? `mcp:${opts.mcp}` : toolsPath ?? null } };
}

/** Start an MCP server over stdio, run the handshake and page through tools/list. */
export function listMcpTools(command, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", id = 0, done = false, stderr = "";
    const pending = new Map();
    const tools = [];

    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`MCP server did not answer within ${timeoutMs / 1000}s. stderr: ${stderr.slice(-300)}`)), timeoutMs);

    const send = (method, params) => new Promise((res, rej) => {
      const msg = { jsonrpc: "2.0", id: ++id, method, params };
      pending.set(msg.id, { res, rej });
      child.stdin.write(JSON.stringify(msg) + "\n");
    });
    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => finish(new Error(`MCP server exited (code ${code}). stderr: ${stderr.slice(-300)}`)));
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = msg.id != null && pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(`MCP error: ${msg.error.message}`)) : p.res(msg.result);
      }
    });

    (async () => {
      await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agent-lighthouse", version: "0.1.0" },
      });
      notify("notifications/initialized", {});
      let cursor;
      do {
        const page = await send("tools/list", cursor ? { cursor } : {});
        tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      finish(null, tools);
    })().catch((e) => finish(e));
  });
}

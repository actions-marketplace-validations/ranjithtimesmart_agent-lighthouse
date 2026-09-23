import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeTools, loadAgent } from "../src/discover.js";
import { createJev } from "../src/jev.js";
import { audit, planRequests, statusOf, scoreResults } from "../src/audit.js";
import { renderTerminal, renderMarkdown, renderBadge } from "../src/report.js";
import { TOOL_CHECKS, PROMPT_CHECKS, allJevCheckCount } from "../src/checks.js";
import { main } from "../src/cli.js";
import { mockFetch } from "./mock-jev.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => path.join(here, "..", "examples", n);

const sink = () => { let s = ""; return { write: (x) => { s += x; }, get text() { return s; }, isTTY: false }; };

test("normalizes OpenAI, Anthropic, MCP and plain tool formats", () => {
  const tools = normalizeTools({ tools: [
    { type: "function", function: { name: "a", description: "A", parameters: { type: "object", properties: { x: {} } } } },
    { name: "b", description: "B", input_schema: { type: "object", properties: {} } },
    { name: "c", description: "C", inputSchema: { type: "object", properties: { y: {} } } },
    { name: "d" },
  ] });
  assert.deepEqual(tools.map((t) => t.name), ["a", "b", "c", "d"]);
  assert.ok(tools[0].parameters.properties.x && tools[2].parameters.properties.y);
  assert.equal(tools[3].description, "");
  assert.throws(() => normalizeTools({ nope: 1 }), /array/);
});

test("auto-discovers prompt and tools in a folder", async () => {
  const a = await loadAgent(ex("support-agent"));
  assert.equal(a.tools.length, 5);
  assert.match(a.prompt, /Acme Outfitters/);
  await assert.rejects(loadAgent(here + "/fixtures"), /No agent found/);
});

test("one Jev request per scope, every question in the documented schema", async () => {
  const agent = await loadAgent(ex("support-agent-fixed"));
  const reqs = planRequests(agent);
  assert.equal(reqs.length, 2 + agent.tools.length);
  const { fetchImpl, calls } = mockFetch();
  const jev = createJev({ apiKey: "k", fetchImpl });
  const report = await audit(agent, { jev });
  assert.equal(calls.length, reqs.length);
  assert.equal(report.run.decisions, allJevCheckCount(agent.tools.length));
  for (const c of calls) {
    assert.equal(c.headers.Authorization, "Bearer k");
    assert.ok(c.url.endsWith("/v1/systemone"));
    assert.deepEqual(Object.keys(c.body).sort(), ["model", "questions", "state"]);
    for (const q of Object.values(c.body.questions)) {
      assert.ok(["noul", "score", "choice"].includes(q.type));
      assert.ok(q.instructions && q.criteria);
    }
  }
  const toolReq = calls.find((c) => c.body.state.tool);
  assert.ok(Array.isArray(toolReq.body.state.other_tools));
  assert.equal(toolReq.body.state.other_tools.length, agent.tools.length - 1);
});

test("credits: 'bad when true' checks invert, risky tools need safeguards", () => {
  const overlap = TOOL_CHECKS.find((c) => c.id === "tool.overlap");
  assert.equal(overlap.credit({ overlap: { noul: 0.9 } }).toFixed(2), "0.10");
  const side = TOOL_CHECKS.find((c) => c.id === "tool.side_effects");
  const risky = { choice: "risky_action", probabilities: { read_only: 0, reversible_write: 0, risky_action: 1 } };
  assert.equal(side.credit({ action: risky, guard: { noul: 0.05 } }), 0.05);
  assert.equal(side.credit({ action: risky, guard: { noul: 0.95 } }), 0.95);
  const safe = { choice: "read_only", probabilities: { read_only: 1, reversible_write: 0, risky_action: 0 } };
  assert.equal(side.credit({ action: safe, guard: { noul: 0 } }), 1);
  const purpose = TOOL_CHECKS.find((c) => c.id === "tool.purpose");
  assert.equal(purpose.credit({ purpose: { score: 1, probabilities: { 0: 0, 1: 1, 2: 0 } } }), 0.5);
  const contra = PROMPT_CHECKS.find((c) => c.id === "prompt.contradictions");
  assert.ok(contra.credit({ contra: { noul: 0.02 } }) > 0.9);
});

test("calibrated middle ground becomes 'unsure', not pass/fail", () => {
  assert.equal(statusOf(0.5, "jev"), "unsure");
  assert.equal(statusOf(0.5, "static"), "warn");
  assert.equal(statusOf(0.9, "jev"), "pass");
  assert.equal(statusOf(0.1, "jev"), "fail");
});

test("scoring counts each check once per category, not once per tool", () => {
  const rs = [
    ...Array.from({ length: 10 }, () => ({ id: "t", category: "design", credit: 0 })),
    { id: "p", category: "design", credit: 1 },
  ];
  assert.equal(scoreResults(rs).categories.design.score, 50);
});

test("flawed agent scores well below the fixed one when Jev agrees with the flaws", async () => {
  // Pessimistic mock for the flawed agent, optimistic for the fixed one.
  const bad = mockFetch({ nouls: (k) => (/overlap|contra|phantom/.test(k) ? 0.9 : 0.1), score: 0, choice: "risky_action" });
  const good = mockFetch({ nouls: (k) => (/overlap|contra|phantom/.test(k) ? 0.05 : 0.95), score: 2 });
  const r1 = await audit(await loadAgent(ex("support-agent")), { jev: createJev({ apiKey: "k", fetchImpl: bad.fetchImpl }) });
  const r2 = await audit(await loadAgent(ex("support-agent-fixed")), { jev: createJev({ apiKey: "k", fetchImpl: good.fetchImpl }) });
  assert.ok(r1.scores.overall < 30, `flawed scored ${r1.scores.overall}`);
  assert.ok(r2.scores.overall > 90, `fixed scored ${r2.scores.overall}`);
  const txt = renderTerminal(r1, { color: false });
  assert.match(txt, /Fix these/);
  assert.match(txt, /Jev decisions/);
  assert.match(renderMarkdown(r1), /Agent Lighthouse: \*\*\d+\/100\*\*/);
});

test("retries 429s, then succeeds", async () => {
  const { fetchImpl, calls } = mockFetch({ fail: 2 });
  const jev = createJev({ apiKey: "k", fetchImpl });
  const ans = await jev.ask({ x: 1 }, { q: { type: "noul", instructions: "?", criteria: { true: "a", false: "b" } } });
  assert.equal(calls.length, 3);
  assert.equal(ans.q.noul, 0.9);
});

test("no API key means static-only, clearly labeled", async () => {
  assert.equal(createJev({ apiKey: "" }), null);
  const r = await audit(await loadAgent(ex("support-agent")), { jev: null });
  assert.equal(r.run.semantic, false);
  assert.ok(r.results.every((x) => x.source === "static"));
  assert.match(renderTerminal(r, { color: false }), /Static checks only/);
  const secret = r.results.find((x) => x.id === "static.secrets");
  assert.equal(secret.status, "fail");
});

test("audits a live MCP server over stdio, following pagination", async () => {
  const cmd = `node ${path.join(here, "fixtures", "fake-mcp-server.mjs")}`;
  const a = await loadAgent(".", { mcp: cmd });
  assert.deepEqual(a.tools.map((t) => t.name), ["read_file", "delete_file"]);
  const r = await audit(a, { jev: null });
  assert.equal(r.agent.toolsOnly, true);
  assert.ok(!r.results.some((x) => x.id === "static.prompt_present"), "no prompt penalty for MCP servers");
  assert.ok(!("clarity" in r.scores.categories));
});

test("CLI: --min-score gate, --badge and --md outputs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alh-"));
  const out = sink(), err = sink();
  const { fetchImpl } = mockFetch({ nouls: 0.1, score: 0 });
  process.env.TYPESAFE_API_KEY = "k";
  try {
    const code = await main([ex("support-agent"), "--no-color", "--min-score", "80",
      "--badge", path.join(dir, "b.svg"), "--md", path.join(dir, "r.md")], { fetchImpl, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.match(err.text, /below --min-score 80/);
    const svg = await readFile(path.join(dir, "b.svg"), "utf8");
    assert.match(svg, /^<svg[\s\S]*agent score[\s\S]*<\/svg>\s*$/);
    assert.match(await readFile(path.join(dir, "r.md"), "utf8"), /Fix these/);
    const json = sink();
    assert.equal(await main([ex("support-agent-fixed"), "--json"], { fetchImpl: mockFetch().fetchImpl, stdout: json, stderr: err }), 0);
    assert.ok(JSON.parse(json.text).scores.overall >= 0);
    assert.equal(await main(["--nope"], { stdout: out, stderr: err }), 2);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("badge colors follow the grade", () => {
  assert.match(renderBadge(95), /#2ea043/);
  assert.match(renderBadge(60), /#d29922/);
  assert.match(renderBadge(20), /#da3633/);
});

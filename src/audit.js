import { PROMPT_CHECKS, TOOL_CHECKS, TOOLSET_CHECKS, STATIC_CHECKS, CATEGORIES } from "./checks.js";
import { pool, PRICE_PER_M_INPUT } from "./jev.js";

export const PASS_AT = 0.65;
export const FAIL_AT = 0.35;

export function statusOf(credit, source) {
  if (credit >= PASS_AT) return "pass";
  if (credit <= FAIL_AT) return "fail";
  return source === "jev" ? "unsure" : "warn";
}

const prefixed = (check) =>
  Object.fromEntries(Object.entries(check.questions).map(([k, q]) => [`${check.id.replace(/\W/g, "_")}__${k}`, q]));

const unprefix = (check, answers) =>
  Object.fromEntries(Object.keys(check.questions).map((k) => [k, answers[`${check.id.replace(/\W/g, "_")}__${k}`]]));

function toolSummary(t) {
  return { name: t.name, description: t.description };
}

/** Build every Jev request: one per scope, all of that scope's questions asked in parallel. */
export function planRequests(agent) {
  const reqs = [];
  const hasPrompt = agent.prompt.trim().length >= 40;
  if (hasPrompt) {
    reqs.push({ target: "system prompt", checks: PROMPT_CHECKS, state: { system_prompt: agent.prompt } });
  }
  if (hasPrompt && agent.tools.length) {
    reqs.push({
      target: "toolset", checks: TOOLSET_CHECKS,
      state: { system_prompt: agent.prompt, tools: agent.tools.map(toolSummary) },
    });
  }
  for (const tool of agent.tools) {
    reqs.push({
      target: tool.name, checks: TOOL_CHECKS,
      state: { tool, other_tools: agent.tools.filter((t) => t !== tool).map(toolSummary) },
    });
  }
  return reqs;
}

export async function audit(agent, { jev = null, concurrency = 8, onProgress = () => {} } = {}) {
  const results = [];

  // static checks: instant, no network
  const toolsOnly = !agent.prompt.trim() && agent.tools.length > 0; // e.g. auditing an MCP server
  for (const c of STATIC_CHECKS) {
    if (toolsOnly && c.id === "static.prompt_present") continue;
    const targets = c.scope === "tool" ? agent.tools.map((tool) => ({ tool, target: tool.name })) : [{ target: "agent" }];
    for (const { tool, target } of targets) {
      const r = c.run({ ...agent, tool });
      results.push({ id: c.id, title: c.title, category: c.category, target, source: "static",
        credit: r.credit, status: statusOf(r.credit, "static"), detail: r.detail ?? null, fix: c.fix });
    }
  }

  // Jev checks: one request per scope, every question inside it answered in parallel
  const reqs = jev ? planRequests(agent) : [];
  const started = performance.now();
  const latencies = [];
  await pool(reqs, concurrency, async (req) => {
    const questions = Object.assign({}, ...req.checks.map(prefixed));
    const t0 = performance.now();
    const answers = await jev.ask(req.state, questions);
    latencies.push(performance.now() - t0);
    for (const c of req.checks) {
      const a = unprefix(c, answers);
      const credit = clamp01(c.credit(a));
      results.push({ id: c.id, title: c.title, category: c.category, target: req.target, source: "jev",
        credit, status: statusOf(credit, "jev"), detail: c.detail?.(a) ?? null, fix: c.fix });
    }
    onProgress(req.target);
  });
  const wallMs = performance.now() - started;

  const decisions = reqs.reduce((n, r) => n + Object.keys(Object.assign({}, ...r.checks.map(prefixed))).length, 0);
  return {
    agent: { name: agent.name, tools: agent.tools.length, promptChars: agent.prompt.length, toolsOnly, sources: agent.sources },
    results,
    scores: scoreResults(results),
    run: {
      semantic: Boolean(jev),
      model: jev?.stats.model ?? null,
      requests: jev?.stats.requests ?? 0,
      decisions,
      wallMs: Math.round(wallMs),
      medianRequestMs: latencies.length ? Math.round(median(latencies)) : null,
      inputTokens: jev?.stats.inputTokens ?? 0,
      estCostUsd: jev ? (jev.stats.inputTokens / 1e6) * PRICE_PER_M_INPUT : 0,
    },
  };
}

/** Each check id counts once per category (tool checks are averaged across tools first). */
export function scoreResults(results) {
  const byCat = {};
  for (const r of results) {
    ((byCat[r.category] ??= {})[r.id] ??= []).push(r.credit);
  }
  const categories = {};
  let num = 0, den = 0;
  for (const [cat, meta] of Object.entries(CATEGORIES)) {
    const checks = byCat[cat];
    if (!checks) continue;
    const perCheck = Object.values(checks).map((cs) => cs.reduce((a, b) => a + b, 0) / cs.length);
    const s = (100 * perCheck.reduce((a, b) => a + b, 0)) / perCheck.length;
    categories[cat] = { label: meta.label, score: Math.round(s) };
    num += s * meta.weight;
    den += meta.weight;
  }
  return { overall: den ? Math.round(num / den) : 0, categories };
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

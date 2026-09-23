import { appendFile, writeFile } from "node:fs/promises";
import { loadAgent } from "./discover.js";
import { createJev } from "./jev.js";
import { audit, planRequests } from "./audit.js";
import { renderTerminal, renderMarkdown, renderBadge } from "./report.js";

const HELP = `agent-lighthouse: score your AI agent's prompt and tools in about a second, using Jev.

Usage
  agent-lighthouse [path] [options]

  path                 folder with system_prompt.md / prompt.md and tools.json
                       (or an agent-lighthouse.json manifest), or a tools .json file

Options
  --prompt <file>      system prompt file
  --tools <file>       tools file (OpenAI, Anthropic or MCP tool format)
  --mcp "<command>"    start an MCP server over stdio and audit its tools
  --json               print the full report as JSON
  --md <file>          also write a Markdown report (auto-added to GitHub step summary in Actions)
  --badge <file>       write an SVG score badge
  --min-score <n>      exit 1 if the overall score is below n (for CI)
  --static-only        skip Jev (no network)
  --verbose            show fixes for warnings too
  --no-color           plain output

Environment
  TYPESAFE_API_KEY     enables the semantic checks (https://docs.typesafe.ai)
`;

export function parseArgs(argv) {
  const o = { path: ".", color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "--prompt": o.prompt = val(); break;
      case "--tools": o.tools = val(); break;
      case "--mcp": o.mcp = val(); break;
      case "--json": o.json = true; break;
      case "--md": o.md = val(); break;
      case "--badge": o.badge = val(); break;
      case "--min-score": o.minScore = Number(val()); break;
      case "--static-only": o.staticOnly = true; break;
      case "--verbose": o.verbose = true; break;
      case "--no-color": o.color = false; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        o.path = a;
    }
  }
  return o;
}

export async function main(argv = process.argv.slice(2), { fetchImpl, stdout = process.stdout, stderr = process.stderr } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { stderr.write(`${e.message}\n\n${HELP}`); return 2; }
  if (o.help) { stdout.write(HELP); return 0; }

  try {
    const agent = await loadAgent(o.path, { prompt: o.prompt, tools: o.tools, mcp: o.mcp });
    const jev = o.staticOnly ? null : createJev({ fetchImpl });

    let spinner;
    if (jev && stderr.isTTY && !o.json) {
      const n = planRequests(agent).length;
      const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
      let k = 0, doneN = 0;
      spinner = setInterval(() => stderr.write(`\r  ${frames[k++ % frames.length]} asking Jev… ${doneN}/${n}`), 60);
      spinner.tick = () => { doneN++; };
    }
    const report = await audit(agent, { jev, onProgress: () => spinner?.tick() });
    if (spinner) { clearInterval(spinner); stderr.write("\r\x1b[2K"); }

    if (o.json) stdout.write(JSON.stringify(report, null, 2) + "\n");
    else stdout.write(renderTerminal(report, { color: o.color, verbose: o.verbose }) + "\n");

    const md = renderMarkdown(report);
    if (o.md) await writeFile(o.md, md + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `score=${report.scores.overall}\n`);
    if (o.badge) await writeFile(o.badge, renderBadge(report.scores.overall));

    if (Number.isFinite(o.minScore) && report.scores.overall < o.minScore) {
      stderr.write(`agent-lighthouse: score ${report.scores.overall} is below --min-score ${o.minScore}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    stderr.write(`agent-lighthouse: ${e.message}\n`);
    return 2;
  }
}

<h1 align="center">🔦 agent-lighthouse</h1>
<p align="center"><b>Lighthouse for AI agents.</b> Score your system prompt and tool definitions in one fast pass, powered by <a href="https://docs.typesafe.ai">Jev</a>.</p>
<p align="center">
  <code>npx agent-lighthouse ./my-agent</code>
</p>
<p align="center"><img src="docs/demo.gif" alt="agent-lighthouse scoring a support agent" width="820"></p>

---

Most agent failures don't come from the model. They come from **how the agent is described to the model**:

- a tool described as `"Refunds."`
- two tools that do the same thing
- a system prompt that never says what to do with instructions hidden in a web page
- a prompt that tells the agent to call a tool that doesn't exist

`agent-lighthouse` reads your agent's **system prompt** and **tool / MCP definitions** and runs about 60 best-practice checks on them. You get a score, a fix-list and a README badge.

The judgment calls, such as "is this tool's purpose clear?" or "do these two tools overlap?", are made by **[Jev](https://docs.typesafe.ai)**, TypeSafe AI's *System One* model. Jev doesn't write an opinion. It answers each typed question with a **calibrated probability** and answers them all **in parallel**. The whole audit takes about a second, and checks Jev is honestly unsure about are flagged for a human instead of guessed.

## Why it's fast: Jev

Jev doesn't generate text. Its answers are typed (yes/no, choice, score), each with a calibrated probability, and it answers every question in a request at once. That changes how an agent linter can work:

| | Asking an LLM judge | agent-lighthouse with Jev |
|---|---|---|
| ~60 judgments | ~60 generations, or one long fragile JSON blob | **one request per tool**, all questions answered in parallel |
| Output | text you have to parse and hope is valid | typed answers, always valid |
| "Is this clear?" | "Yes, mostly" | `0.62`, a real probability |
| Borderline cases | forced into pass or fail | flagged **"Jev isn't sure: worth a human look"** |
| Speed and cost | seconds, cents | measured and printed after every run |

The last line of every report shows what actually happened, so no one has to take our word for it (the numbers below are illustrative):

```
⚡ 58 Jev decisions in 7 parallel requests · 840 ms total · median 190 ms/request · ~<$0.0001
```

## Quick start

```bash
export TYPESAFE_API_KEY=...        # https://docs.typesafe.ai/introduction/quickstart
npx agent-lighthouse ./my-agent
```

It looks in the folder for:

- **Prompt:** `system_prompt.md`, `system_prompt.txt`, `prompt.md`, `prompt.txt` or `system.md`
- **Tools:** `tools.json`, `functions.json` or `mcp-tools.json`. It understands the OpenAI, Anthropic and MCP tool formats.

Or be explicit:

```bash
npx agent-lighthouse --prompt agent/prompt.md --tools agent/tools.json
```

Or drop an `agent-lighthouse.json` next to your agent: `{"prompt": "prompts/support.md", "tools": "tools.json"}`.

Without an API key it still runs the static checks (secrets, missing descriptions and so on) and tells you what you're missing.

### Audit any MCP server

```bash
npx agent-lighthouse --mcp "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

It starts the server over stdio, runs the MCP handshake, pages through `tools/list` and scores every tool. It's a quick way to see how agent-friendly an MCP server's tools really are.

## Try the examples

```bash
git clone https://github.com/ranjithtimesmart/agent-lighthouse && cd agent-lighthouse
node bin/agent-lighthouse.js examples/support-agent         # a realistic, flawed agent
node bin/agent-lighthouse.js examples/support-agent-fixed   # the same agent, done right
```

The flawed agent has a secret in its prompt, a one-word refund tool, two overlapping order tools, no injection guidance, and a prompt that calls a `escalate_to_human` tool that doesn't exist. See how many of these problems the tool catches.

## What it checks

**System prompt** (one Jev request, 9 questions)
role and goal · explicit boundaries · *treats tool output as data, not instructions* · escalation path · definition of done · what to do when unsure · guidance on choosing tools · contradictory instructions · sensitive-data handling

**Every tool** (one Jev request per tool, 9 questions each, all tools in parallel)
clear purpose (0–2 score) · when to use it · what it returns · failure behavior · parameter quality (0–2) · name matches behavior · **overlaps another tool** · **risky action (money, delete, send) without safeguards**

**Tools vs prompt** (one request)
tools cover what the prompt asks for · **prompt mentions a tool that doesn't exist**

**Static** (no network)
secrets or API keys in the prompt · missing parameter descriptions · no `required` list · one-line descriptions · tool count · malformed names

Scores roll up into **Tool design, Safety, Prompt clarity and Reliability**. Each check counts once per category (per-tool checks are averaged across tools), so an agent with 40 tools isn't graded only on tools.

Every Jev check turns its answer into a **credit** between 0 and 1, the probability that the check passes: ≥ 0.65 passes, ≤ 0.35 fails, and anything in between is reported as *unsure* instead of guessed. That's the calibration doing real work.

## In CI

```yaml
- uses: ranjithtimesmart/agent-lighthouse@v0
  with:
    path: agents/support
    min-score: 75
    badge: docs/agent-score.svg
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

The action posts the Markdown report to the job summary, sets a `score` output and fails the build below `min-score`. Commit the badge and add it to your README:

```md
![agent score](docs/agent-score.svg)
```

## As a library

```js
import { loadAgent, createJev, audit, renderMarkdown } from "agent-lighthouse";

const agent = await loadAgent("./agents/support");
const report = await audit(agent, { jev: createJev() });
console.log(report.scores.overall, renderMarkdown(report));
```

## All options

```
agent-lighthouse [path] [--prompt f] [--tools f] [--mcp "cmd"]
                 [--json] [--md report.md] [--badge badge.svg]
                 [--min-score n] [--static-only] [--verbose] [--no-color]
```

## Honest limits

- These are **heuristics about how an agent is described**, not a test of how it behaves. A high score means fewer avoidable mistakes, not a correct agent. Pair it with real evals.
- Jev's own docs say it's weaker with double negatives and deeply nested content, and that irrelevant context lowers accuracy. That's why each tool is judged in its own request, with only the other tools' names and descriptions alongside it.
- The cost estimate uses TypeSafe's published launch price ($0.042 per million input tokens). Check your own billing.

## Contributing

New checks are about a dozen lines in [`src/checks.js`](src/checks.js): one typed question, one credit function and one fix suggestion. PRs with checks backed by a real failure you've seen are especially welcome.

```bash
npm test
```

---

Built by [Ranjith Raghavan](https://www.linkedin.com/in/ranjith-n-raghavan). Independent project, not affiliated with TypeSafe AI or Google Lighthouse. MIT licensed.

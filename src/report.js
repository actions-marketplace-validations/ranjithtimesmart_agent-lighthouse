export function grade(score) {
  if (score >= 90) return { label: "Excellent", color: "green", hex: "#2ea043" };
  if (score >= 75) return { label: "Good", color: "green", hex: "#3fb950" };
  if (score >= 50) return { label: "Needs work", color: "yellow", hex: "#d29922" };
  return { label: "Poor", color: "red", hex: "#da3633" };
}

function paint(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39),
    yellow: wrap(33, 39), cyan: wrap(36, 39), magenta: wrap(35, 39),
  };
}

/** Collapse per-tool results into one line per check, listing the targets. */
export function groupIssues(results, status) {
  const groups = new Map();
  for (const r of results.filter((x) => x.status === status)) {
    const g = groups.get(r.id) ?? { ...r, targets: [] };
    g.targets.push({ target: r.target, credit: r.credit, detail: r.detail });
    groups.set(r.id, g);
  }
  const order = { safety: 0, reliability: 1, design: 2, clarity: 3 };
  return [...groups.values()].sort((a, b) => order[a.category] - order[b.category] || b.targets.length - a.targets.length);
}

const bar = (score, width = 20) => {
  const full = Math.round((score / 100) * width);
  return "█".repeat(full) + "░".repeat(width - full);
};

const fmtTargets = (g, max = 4) => {
  const names = g.targets.map((t) => t.target);
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max} more` : shown;
};

export function renderTerminal(report, { color = true, verbose = false } = {}) {
  const c = paint(color);
  const { agent, scores, run } = report;
  const g = grade(scores.overall);
  const tint = g.color === "green" ? c.green : g.color === "yellow" ? c.yellow : c.red;
  const out = [];

  out.push("");
  out.push(`  ${c.bold("agent-lighthouse")}  ${c.dim("·")}  ${agent.name}  ${c.dim(agent.toolsOnly ? `(${agent.tools} tools · tools-only audit, no system prompt)` : `(${agent.tools} tools, ${agent.promptChars.toLocaleString()}-char prompt)`)}`);
  out.push("");
  out.push(`   ${tint("╭──────╮")}`);
  out.push(`   ${tint("│")} ${c.bold(tint(String(scores.overall).padStart(3)))}  ${tint("│")}  ${c.bold(tint(g.label))}`);
  out.push(`   ${tint("╰──────╯")}`);
  out.push("");
  for (const cat of Object.values(scores.categories)) {
    const t = grade(cat.score).color === "green" ? c.green : grade(cat.score).color === "yellow" ? c.yellow : c.red;
    out.push(`  ${cat.label.padEnd(16)} ${t(bar(cat.score))} ${String(cat.score).padStart(3)}`);
  }

  const fails = groupIssues(report.results, "fail");
  const warns = groupIssues(report.results, "warn");
  const unsure = groupIssues(report.results, "unsure");
  const passed = report.results.filter((r) => r.status === "pass").length;

  if (fails.length) {
    const limit = verbose ? fails.length : 8;
    out.push("", `  ${c.red(c.bold(`✗ Fix these (${fails.length})`))}`);
    for (const f of fails.slice(0, limit)) {
      const detail = f.targets.map((t) => t.detail).find(Boolean);
      out.push(`    ${c.red("✗")} ${f.title}  ${c.dim(`${fmtTargets(f)}${detail ? ` · ${detail}` : ""}`)}`);
      out.push(`      ${c.cyan("→")} ${f.fix}`);
    }
    if (fails.length > limit) out.push(c.dim(`    …and ${fails.length - limit} more (run with --verbose, or --md for the full list)`));
  }
  if (warns.length) {
    out.push("", `  ${c.yellow(c.bold(`! Could be better (${warns.length})`))}`);
    for (const w of warns) {
      const detail = w.targets.map((t) => t.detail).find(Boolean);
      out.push(`    ${c.yellow("!")} ${w.title}  ${c.dim(`${fmtTargets(w)}${detail ? ` · ${detail}` : ""}`)}`);
      if (verbose) out.push(`      ${c.cyan("→")} ${w.fix}`);
    }
  }
  if (unsure.length) {
    out.push("", `  ${c.magenta(c.bold(`? Jev isn't sure: worth a human look (${unsure.length})`))}`);
    for (const u of unsure) {
      const conf = u.targets.map((t) => `${t.target} ${Math.round(t.credit * 100)}%`).slice(0, 3).join(", ");
      out.push(`    ${c.magenta("?")} ${u.title}  ${c.dim(conf)}`);
    }
  }
  out.push("", `  ${c.green(`✓ ${passed} checks passed`)}`);

  out.push("");
  if (run.semantic) {
    const cost = run.estCostUsd < 0.0001 ? "<$0.0001" : `$${run.estCostUsd.toFixed(4)}`;
    out.push(`  ${c.cyan("⚡")} ${c.bold(`${run.decisions} Jev decisions`)} in ${run.requests} parallel requests · ${c.bold(`${run.wallMs} ms`)} total` +
      `${run.medianRequestMs != null ? ` · median ${run.medianRequestMs} ms/request` : ""} · ~${cost}${run.model ? c.dim(` · ${run.model}`) : ""}`);
  } else {
    out.push(`  ${c.yellow("⚠")} Static checks only. Set ${c.bold("TYPESAFE_API_KEY")} to run the ${c.bold("semantic checks")} with Jev.`);
  }
  out.push("");
  return out.join("\n");
}

export function renderMarkdown(report) {
  const { agent, scores, run } = report;
  const g = grade(scores.overall);
  const lines = [
    `## 🔦 Agent Lighthouse: **${scores.overall}/100** (${g.label})`,
    "",
    agent.toolsOnly ? `\`${agent.name}\` · ${agent.tools} tools · tools-only audit` : `\`${agent.name}\` · ${agent.tools} tools · ${agent.promptChars.toLocaleString()}-char prompt`,
    "",
    "| Category | Score |",
    "|---|---|",
    ...Object.values(scores.categories).map((cat) => `| ${cat.label} | ${cat.score} |`),
    "",
  ];
  const fails = groupIssues(report.results, "fail");
  if (fails.length) {
    lines.push("### ✗ Fix these", "");
    for (const f of fails) lines.push(`- **${f.title}** (${fmtTargets(f, 6)}): ${f.fix}`);
    lines.push("");
  }
  const unsure = groupIssues(report.results, "unsure");
  if (unsure.length) {
    lines.push("### ? Jev isn't sure (worth a human look)", "");
    for (const u of unsure) lines.push(`- ${u.title}: ${u.targets.map((t) => `${t.target} (${Math.round(t.credit * 100)}%)`).join(", ")}`);
    lines.push("");
  }
  lines.push(run.semantic
    ? `<sub>⚡ ${run.decisions} Jev decisions · ${run.requests} requests · ${run.wallMs} ms · ~$${run.estCostUsd.toFixed(5)}</sub>`
    : "<sub>Static checks only (no TYPESAFE_API_KEY).</sub>");
  return lines.join("\n");
}

export function renderBadge(score, label = "agent score") {
  const g = grade(score);
  const value = String(score);
  const cw = 6.6; // approx char width at 11px Verdana
  const lw = Math.round(label.length * cw + 12);
  const vw = Math.round(value.length * cw + 14);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}">
<title>${label}: ${value}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${g.hex}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="${lw / 2}" y="14">${label}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text><text x="${lw + vw / 2}" y="14">${value}</text>
</g></svg>
`;
}

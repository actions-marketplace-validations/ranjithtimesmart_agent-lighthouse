// A fake /v1/systemone that answers every question with a fixed policy, and records requests.
export function mockFetch({ nouls = 0.9, score = 2, choice = "read_only", fail = 0 } = {}) {
  const calls = [];
  let failures = fail;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (failures-- > 0) return new Response("slow down", { status: 429 });
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[k] = { type: "noul", noul: typeof nouls === "function" ? nouls(k, body.state) : nouls };
      if (q.type === "score") {
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === score ? 1 : 0]));
        answers[k] = { type: "score", score, confidence: 1, probabilities, legend: {} };
      }
      if (q.type === "choice") {
        const probabilities = Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === choice ? 1 : 0]));
        answers[k] = { type: "choice", choice, confidence: 1, probabilities };
      }
    }
    return new Response(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

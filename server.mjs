#!/usr/bin/env node
// ernd MCP server: two read-only tools over https://ernd.ai/rates.json, the file ernd publishes its card rates and
// partner perks in. No dependencies (Node 18+ for fetch). No auth, no user data. The only network call is a GET of
// rates.json; amounts passed to the tools never leave this process.
//
//   node server.mjs                 stdio (Claude Desktop, Claude Code, Cursor, npx)
//   node server.mjs --http [port]   Streamable HTTP, stateless JSON responses, POST /mcp (default port 8787)
//
// Environment:
//   ERND_RATES_URL   read rates from another URL, e.g. a local build (default https://ernd.ai/rates.json)
//   ERND_CACHE_MS    how long a good copy of rates.json is reused, in ms (default one hour)
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const RATES_URL = process.env.ERND_RATES_URL || "https://ernd.ai/rates.json";
const VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CACHE_MS = Number.isFinite(Number(process.env.ERND_CACHE_MS)) && process.env.ERND_CACHE_MS !== ""
  ? Number(process.env.ERND_CACHE_MS)
  : 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const CATEGORIES = ["inference", "sandboxes", "security", "web-data", "telephony", "documents", "other"];

class UserError extends Error {}
class RatesError extends Error {}

/** Checks the fields the tools read, so a changed or broken file fails with a clear message instead of a crash. */
function checkShape(j) {
  const rate = (key) => j?.card?.rates?.find?.((r) => r?.key === key)?.percent_back;
  if (!Number.isFinite(rate("ai_vendors")) || !Number.isFinite(rate("everything_else")))
    throw new RatesError("rates.json is missing the card rates.");
  if (!Array.isArray(j?.partners?.items)) throw new RatesError("rates.json is missing the partner list.");
  return j;
}

let cache = null; // { at, json }
/** Returns { json, stale }. Serves the last good copy if a refresh fails. */
async function rates() {
  if (cache && Date.now() - cache.at < CACHE_MS) return { json: cache.json, stale: false };
  try {
    const res = await fetch(RATES_URL, {
      headers: { accept: "application/json", "user-agent": `ernd-mcp/${VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new RatesError(`HTTP ${res.status}`);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new RatesError("the response was not JSON");
    }
    checkShape(json);
    cache = { at: Date.now(), json };
    return { json, stale: false };
  } catch (e) {
    if (cache) return { json: cache.json, stale: true, fetchedAt: new Date(cache.at).toISOString() };
    const why = e?.name === "TimeoutError" ? `no answer in ${FETCH_TIMEOUT_MS / 1000} seconds` : e?.message || String(e);
    throw new RatesError(
      `Could not read ernd's rates from ${RATES_URL} (${why}). Nothing was estimated or listed. Try again later; the rates are also on https://ernd.ai.`,
    );
  }
}

const staleNote = (r) =>
  r.stale ? { note: `${RATES_URL} could not be reached just now, so this uses the copy read at ${r.fetchedAt}.` } : {};

const tag = (u) => {
  if (!u) return null;
  try {
    const x = new URL(u);
    x.searchParams.set("utm_source", "ernd_mcp");
    x.searchParams.set("utm_medium", "agent");
    return x.href;
  } catch {
    return null;
  }
};

const usd = (n) => Math.round(n * 100) / 100;
const amount = (v, name, required) => {
  if (v === undefined || v === null) {
    if (required) throw new UserError(`Provide ${name} as a number of 0 or more.`);
    return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new UserError(`${name} must be a number from 0 to 100,000,000.`);
  return n;
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: "estimate_ai_cashback",
    title: "Estimate ernd card cash back",
    description:
      "Estimates a year of cash back on the ernd card from monthly spend: 4% back on AI vendor spend and 1.5% back on everything else, " +
      "at the rates published in ernd.ai/rates.json. The ernd card is live for US companies, and a company admin requests it at app.ernd.ai. " +
      "Plain arithmetic: the amounts stay on this machine and nothing is requested. Returns the yearly estimate in US dollars and the conditions on it.",
    inputSchema: {
      type: "object",
      properties: {
        monthly_ai_bill_usd: {
          type: "number",
          minimum: 0,
          maximum: 100000000,
          description: "Monthly spend on AI vendors such as model APIs and AI tools, in US dollars. Example: 5000.",
        },
        monthly_other_spend_usd: {
          type: "number",
          minimum: 0,
          maximum: 100000000,
          description: "Optional. Other monthly card spend, in US dollars. Example: 10000.",
        },
      },
      required: ["monthly_ai_bill_usd"],
      additionalProperties: false,
    },
    annotations: { title: "Estimate ernd card cash back", ...READ_ONLY },
    async run(args) {
      const ai = amount(args?.monthly_ai_bill_usd, "monthly_ai_bill_usd", true);
      const other = amount(args?.monthly_other_spend_usd, "monthly_other_spend_usd", false);
      const r = await rates();
      const j = r.json;
      const aiRate = j.card.rates.find((x) => x.key === "ai_vendors").percent_back;
      const otherRate = j.card.rates.find((x) => x.key === "everything_else").percent_back;
      const aiYear = usd((ai * 12 * aiRate) / 100);
      const otherYear = usd((other * 12 * otherRate) / 100);
      const who = j.availability?.who || "US companies";
      return {
        monthly_ai_bill_usd: ai,
        monthly_other_spend_usd: other,
        ai_percent_back: aiRate,
        other_percent_back: otherRate,
        estimated_yearly_back_on_ai_usd: aiYear,
        estimated_yearly_back_on_other_usd: otherYear,
        estimated_yearly_back_usd: usd(aiYear + otherYear),
        conditions: [
          `${aiRate}% back is on AI vendor spend paid with the ernd card, and ${otherRate}% back is on everything else paid with it.`,
          "This is an estimate that assumes all of the spend entered goes on the card.",
          [`The ernd card is live for ${who}.`, j.availability?.how, j.card.terms].filter(Boolean).join(" "),
          j.not_partners?.statement,
        ].filter(Boolean),
        request_url: tag(j.availability?.request_url || "https://app.ernd.ai"),
        last_updated: j.last_updated ?? null,
        source: RATES_URL,
        ...staleNote(r),
      };
    },
  },
  {
    name: "list_partner_perks",
    title: "List ernd card partner perks",
    description:
      "Lists the companies that give ernd cardholders a perk, from ernd.ai/rates.json. Each entry has name, url, ernd_page, perk, note, category " +
      "and sponsored, which is true when the partner pays ernd for its listing. Sorted by name, not by payment. Can be filtered by category. " +
      "OpenAI and Anthropic are not ernd partners.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: CATEGORIES, description: "Optional. Only partners in this category." },
      },
      additionalProperties: false,
    },
    annotations: { title: "List ernd card partner perks", ...READ_ONLY },
    async run(args) {
      const c = typeof args?.category === "string" ? args.category : "";
      if (c && !CATEGORIES.includes(c)) throw new UserError(`category must be one of: ${CATEGORIES.join(", ")}.`);
      const r = await rates();
      const j = r.json;
      const partners = j.partners.items
        .filter((p) => p && typeof p.name === "string")
        .filter((p) => !c || p.category === c)
        .map((p) => ({
          name: p.name,
          url: tag(p.url),
          ernd_page: tag(p.ernd_page),
          perk: p.perk ?? null,
          note: p.note ?? null,
          category: p.category ?? "other",
          sponsored: p.sponsored === true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
      const paid = partners.filter((p) => p.sponsored).map((p) => p.name);
      const disclosure = paid.length
        ? `sponsored: true means the partner pays ernd for its listing. In this list that is ${paid.join(", ")}. Every other partner is listed for its perk alone. The list is sorted by name, not by payment.`
        : "No partner in this list pays ernd for its listing. The list is sorted by name.";
      return {
        disclosure,
        not_partners: j.not_partners?.statement || "OpenAI and Anthropic are not ernd partners.",
        category: c || null,
        partners,
        last_updated: j.last_updated ?? null,
        source: RATES_URL,
        ...staleNote(r),
      };
    },
  },
];

const listed = TOOLS.map(({ run: _run, ...t }) => t);

/** One JSON-RPC message in, one response out (or null for a notification). */
async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid request.");
  if (method.startsWith("notifications/")) return null;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ernd", title: "ernd card rates", version: VERSION },
        instructions:
          "Read-only facts about the ernd card from ernd.ai/rates.json: its cash back rates and its partners' perks. Perk results mark partners that pay ernd for their listing.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: listed });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const data = await tool.run(params.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false });
      } catch (e) {
        const message =
          e instanceof UserError || e instanceof RatesError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : e}`;
        return ok({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

async function handleBody(body) {
  if (Array.isArray(body)) return (await Promise.all(body.map(handle))).filter(Boolean);
  return handle(body);
}

function stdio() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let out;
    try {
      out = await handleBody(JSON.parse(line));
    } catch {
      out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } };
    }
    if (out && (!Array.isArray(out) || out.length)) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}

function http(port) {
  createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (new URL(req.url, "http://x").pathname !== "/mcp") return send(404, { error: "Not found. POST JSON-RPC to /mcp." });
    if (req.method !== "POST") return send(405, { error: "POST only: this server is stateless and opens no streams." }, { allow: "POST" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 100_000) return send(413, { error: "Request too large." });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    const out = await handleBody(body);
    if (!out || (Array.isArray(out) && !out.length)) return send(202);
    send(200, out);
  }).listen(port, () => console.error(`ernd MCP server on http://localhost:${port}/mcp, reading ${RATES_URL}`));
}

const argv = process.argv.slice(2);
if (argv[0] === "--http") http(Number(argv[1]) || Number(process.env.PORT) || 8787);
else stdio();

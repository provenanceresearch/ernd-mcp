#!/usr/bin/env node
// Tests over stdio. No dependencies.
//   node test.mjs          against test/fixture-rates.json, served from a local port (offline, deterministic)
//   node test.mjs --live   against https://ernd.ai/rates.json (or ERND_RATES_URL if set)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const LIVE = process.argv.includes("--live");
const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const FIXTURE = readFileSync(new URL("./test/fixture-rates.json", import.meta.url), "utf8");
const BANNED = /early access|\bapply\b|\bapproved\b|\beligible\b|pool/i;

/** Starts server.mjs over stdio and returns an rpc() helper. */
function start(env) {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args }).then((m) => m.result);
  return { rpc, call, stop: () => child.kill() };
}

/** A local rates host: /rates.json serves the fixture while `up`, /missing is an HTML 404, /broken is not JSON. */
async function fixtureHost() {
  const state = { up: true };
  const srv = createServer((req, res) => {
    if (req.url === "/rates.json" && state.up) return res.writeHead(200, { "content-type": "application/json" }).end(FIXTURE);
    if (req.url === "/broken") return res.writeHead(200, { "content-type": "application/json" }).end("<html>");
    if (req.url === "/rates.json") return res.writeHead(503).end();
    res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, state, close: () => srv.close() };
}

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${label}`);
};

const host = LIVE ? null : await fixtureHost();
const ratesUrl = LIVE ? process.env.ERND_RATES_URL || "https://ernd.ai/rates.json" : `${host.base}/rates.json`;
console.log(`${LIVE ? "live" : "fixture"}: ${ratesUrl}`);

const s = start({ ERND_RATES_URL: ratesUrl });
let perksResult;

await check("initialize and tools/list", async () => {
  const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "ernd");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await s.rpc("tools/list", {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ["estimate_ai_cashback", "list_partner_perks"]);
  for (const t of list.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is read-only`);
    assert.equal(t.annotations.destructiveHint, false);
    assert.ok(t.title);
    assert.ok(!BANNED.test(JSON.stringify(t)), `${t.name} description avoids banned wording`);
  }
  const est = list.result.tools[0].description;
  for (const must of ["4% back on AI vendor spend", "1.5% back on everything else", "live for US companies", "app.ernd.ai"])
    assert.ok(est.includes(must), `estimate description says "${must}"`);
});

await check("estimate: $5,000/month AI -> $2,400/year", async () => {
  const r = await s.call("estimate_ai_cashback", { monthly_ai_bill_usd: 5000 });
  assert.equal(r.isError, false);
  const d = r.structuredContent;
  assert.equal(d.ai_percent_back, 4);
  assert.equal(d.other_percent_back, 1.5);
  assert.equal(d.estimated_yearly_back_usd, 2400);
  assert.ok(d.request_url.startsWith("https://app.ernd.ai"));
  assert.ok(d.request_url.includes("utm_source=ernd_mcp"));
  assert.ok(d.conditions.some((c) => c.includes("not ernd partners")));
  assert.ok(!BANNED.test(JSON.stringify(d)), "estimate output avoids banned wording");
});

await check("estimate: $5,000 AI + $10,000 other -> $4,200/year", async () => {
  const d = (await s.call("estimate_ai_cashback", { monthly_ai_bill_usd: 5000, monthly_other_spend_usd: 10000 })).structuredContent;
  assert.equal(d.estimated_yearly_back_on_other_usd, 1800);
  assert.equal(d.estimated_yearly_back_usd, 4200);
});

await check("estimate: bad input is a tool error", async () => {
  assert.equal((await s.call("estimate_ai_cashback", { monthly_ai_bill_usd: -5 })).isError, true);
  assert.equal((await s.call("estimate_ai_cashback", {})).isError, true);
  assert.equal((await s.call("estimate_ai_cashback", { monthly_ai_bill_usd: "lots" })).isError, true);
});

await check("perks: sorted by name, sponsored marked and disclosed", async () => {
  const r = await s.call("list_partner_perks");
  assert.equal(r.isError, false);
  const p = (perksResult = r.structuredContent);
  assert.ok(p.partners.length > 0);
  const names = p.partners.map((x) => x.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
  assert.deepEqual(p.partners.filter((x) => x.sponsored).map((x) => x.name), ["Agent 37", "Hopper", "Trace"]);
  for (const n of ["Agent 37", "Hopper", "Trace"]) assert.ok(p.disclosure.includes(n));
  assert.ok(p.disclosure.includes("pays ernd for its listing"));
  assert.ok(p.disclosure.includes("not by payment"));
  assert.ok(p.not_partners.includes("OpenAI and Anthropic are not ernd partners"));
  assert.ok(!p.partners.some((x) => /openai|anthropic/i.test(x.name)), "OpenAI and Anthropic are never partners");
  assert.ok(p.partners.every((x) => typeof x.sponsored === "boolean"));
  assert.ok(!BANNED.test(JSON.stringify(p)), "perks output avoids banned wording");
});

await check("perks: category filter", async () => {
  const d = (await s.call("list_partner_perks", { category: "sandboxes" })).structuredContent;
  assert.ok(d.partners.length > 0 && d.partners.every((x) => x.category === "sandboxes"));
  assert.equal((await s.call("list_partner_perks", { category: "banks" })).isError, true);
});

s.stop();

if (!LIVE) {
  await check("unreachable host: clear tool error, no crash", async () => {
    const t = start({ ERND_RATES_URL: "http://127.0.0.1:9/rates.json" });
    const r = await t.call("estimate_ai_cashback", { monthly_ai_bill_usd: 5000 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Could not read ernd's rates/);
    assert.match(r.content[0].text, /https:\/\/ernd\.ai/);
    assert.equal((await t.call("list_partner_perks")).isError, true);
    assert.deepEqual(await t.rpc("ping", {}).then((m) => m.result), {}, "server still answers");
    t.stop();
  });

  await check("HTML 404 and non-JSON body: clear tool errors", async () => {
    for (const path of ["/missing", "/broken"]) {
      const t = start({ ERND_RATES_URL: `${host.base}${path}` });
      const r = await t.call("list_partner_perks");
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Could not read ernd's rates/);
      t.stop();
    }
  });

  await check("host goes down after a good read: last copy served with a note", async () => {
    const t = start({ ERND_RATES_URL: ratesUrl, ERND_CACHE_MS: "0" });
    assert.equal((await t.call("list_partner_perks")).isError, false);
    host.state.up = false;
    const r = await t.call("estimate_ai_cashback", { monthly_ai_bill_usd: 1000 });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.estimated_yearly_back_usd, 480);
    assert.match(r.structuredContent.note, /could not be reached just now/);
    host.state.up = true;
    t.stop();
  });
  host.close();
}

console.log(`\n${passed} checks passed (${LIVE ? "live" : "fixture"}). Partners:`);
console.log(perksResult.partners.map((x) => `  ${x.name}: ${x.perk}${x.sponsored ? " (sponsored)" : ""}`).join("\n"));

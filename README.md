# ernd-mcp

An MCP server for the [ernd card](https://ernd.ai), the credit card for the AI stack. It gives an AI assistant two
read-only tools: one estimates the card's cash back from your monthly spend, and one lists the perks ernd partners give
cardholders.

The card earns 4% back on AI vendor spend and 1.5% back on everything else. It's live for US companies, and a company
admin requests it at [app.ernd.ai](https://app.ernd.ai).

Both tools read [ernd.ai/rates.json](https://ernd.ai/rates.json), the file ernd publishes its rates and partners in. That
GET is the only network call. The server needs no key or account, and the amounts you enter never leave your machine.

## Tools

### `estimate_ai_cashback`

Estimates a year of cash back from monthly spend.

| Input | Type | |
| --- | --- | --- |
| `monthly_ai_bill_usd` | number, required | Monthly spend on AI vendors, in US dollars |
| `monthly_other_spend_usd` | number, optional | Other monthly card spend, in US dollars |

Ask your assistant: *"We spend about $5,000 a month on model APIs and $10,000 on everything else. What would the ernd
card earn back in a year?"*

```json
{
  "ai_percent_back": 4,
  "other_percent_back": 1.5,
  "estimated_yearly_back_on_ai_usd": 2400,
  "estimated_yearly_back_on_other_usd": 1800,
  "estimated_yearly_back_usd": 4200,
  "conditions": [
    "4% back is on AI vendor spend paid with the ernd card, and 1.5% back is on everything else paid with it.",
    "This is an estimate that assumes all of the spend entered goes on the card.",
    "The ernd card is live for US companies. A company admin sends the request for the company. Final terms come with the card.",
    "OpenAI and Anthropic are not ernd partners or sponsors and don't endorse ernd. ..."
  ],
  "request_url": "https://app.ernd.ai/?utm_source=ernd_mcp&utm_medium=agent"
}
```

### `list_partner_perks`

Lists the companies that give ernd cardholders a perk, sorted by name. Each entry has `name`, `url`, `ernd_page`,
`perk`, `note`, `category` and `sponsored`.

| Input | Type | |
| --- | --- | --- |
| `category` | string, optional | One of `inference`, `sandboxes`, `security`, `web-data`, `telephony`, `documents`, `other` |

Ask your assistant: *"Which ernd partners give perks on sandboxes?"*

```json
{
  "disclosure": "sponsored: true means the partner pays ernd for its listing. In this list that is Agent 37. Every other partner is listed for its perk alone. The list is sorted by name, not by payment.",
  "category": "sandboxes",
  "partners": [
    { "name": "Agent 37", "perk": "4% back", "category": "sandboxes", "sponsored": true, "...": "..." },
    { "name": "Superserve", "perk": "5% back", "category": "sandboxes", "sponsored": false, "...": "..." }
  ]
}
```

**Paid listings.** Some partners pay ernd for their listing. Those entries have `sponsored: true`, and every result
names them in `disclosure`. The list is always sorted by name, never by who pays. OpenAI and Anthropic are not ernd
partners.

Links in results carry `utm_source=ernd_mcp&utm_medium=agent`, so ernd can count visits that came from this server.

## Install

Needs Node.js 18 or newer. There's nothing else to install: `npx` fetches the package the first time it runs.

### Claude Code

```sh
claude mcp add ernd -- npx -y ernd-mcp
```

### Claude Desktop

Open Settings, then Developer, then Edit Config, and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ernd": {
      "command": "npx",
      "args": ["-y", "ernd-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Cursor

Add this to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "ernd": {
      "command": "npx",
      "args": ["-y", "ernd-mcp"]
    }
  }
}
```

### From a clone

```sh
git clone https://github.com/provenanceresearch/ernd-mcp
cd ernd-mcp
claude mcp add ernd -- node "$PWD/server.mjs"
```

### Over HTTP

`node server.mjs --http 8787` serves stateless Streamable HTTP at `POST http://localhost:8787/mcp`.

## Options

| Variable | Default | |
| --- | --- | --- |
| `ERND_RATES_URL` | `https://ernd.ai/rates.json` | Where to read rates from |
| `ERND_CACHE_MS` | `3600000` (one hour) | How long a good copy of rates.json is reused |

If rates.json can't be reached, the tools return a plain error and the server keeps running. If it was read earlier in
the session, the tools use that copy and say so in a `note`.

## Development

```sh
npm test            # against test/fixture-rates.json on a local port, offline
npm run test:live   # against https://ernd.ai/rates.json
```

## License

MIT

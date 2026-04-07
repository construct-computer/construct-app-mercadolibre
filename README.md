[![Construct App](https://img.shields.io/badge/Construct-App-6366f1)](https://construct.computer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Construct App: MercadoLibre

Complete [MercadoLibre](https://www.mercadolibre.com) integration for Construct. Search products, compare prices, manage listings, process orders, answer buyer questions, and track shipments across 17 Latin American marketplaces.

## Tools

### Public Tools (no auth)

| Tool | Description |
|------|-------------|
| `search_products` | Search products by keyword with filters for price, condition, and country |
| `get_product` | Get detailed info about a specific product by item ID |
| `get_category` | Browse product categories and subcategories |
| `get_seller` | Check seller reputation, ratings, and transaction history |
| `compare_prices` | Compare prices across listings with min/max/median stats |
| `list_sites` | List available MercadoLibre country sites |
| `get_trends` | Get trending searches for a country |
| `get_product_reviews` | Get buyer reviews and star ratings for a product |
| `get_product_description` | Get the full text description of a listing |
| `get_currency_conversion` | Convert between currencies using MercadoLibre rates |

### Authenticated Tools (OAuth required)

| Tool | Description |
|------|-------------|
| `get_my_account` | Get your account details, reputation, and seller level |
| `list_my_items` | List your active product listings |
| `update_listing` | Update price, stock, or status of a listing |
| `list_orders` | List your recent sales orders |
| `get_order` | Get full order details -- buyer, items, payment, shipping |
| `list_questions` | List buyer questions on your listings |
| `answer_question` | Answer a buyer's question |
| `get_shipment` | Get shipment tracking details |
| `send_message` | Send a message in an order conversation |
| `get_item_visits` | Get visit/view statistics for your listings |
| `manage_ads` | Manage Product Ads -- check status, activate, or pause campaigns |

## Supported Countries

| Site ID | Country |
|---------|---------|
| MLA | Argentina |
| MLB | Brazil |
| MLM | Mexico |
| MLC | Chile |
| MCO | Colombia |
| MLU | Uruguay |
| MPE | Peru |
| MEC | Ecuador |
| MPA | Panama |
| MPY | Paraguay |
| MRD | Dominican Republic |
| MBO | Bolivia |
| MNI | Nicaragua |
| MCR | Costa Rica |
| MSV | El Salvador |
| MHN | Honduras |
| MGT | Guatemala |

## Getting Started

```bash
# Fork and clone the repository
git clone https://github.com/<your-username>/construct-app-mercadolibre.git
cd construct-app-mercadolibre

# Install dependencies
npm install

# Start the local dev server
npm run dev
```

The Worker listens on `http://localhost:8787/mcp` for JSON-RPC requests and `http://localhost:8787/health` for health checks.

## OAuth Setup

To use the authenticated seller tools, you need to register a MercadoLibre application and configure OAuth credentials.

1. Create an application on the [MercadoLibre Developer Portal](https://developers.mercadolibre.com.ar/devcenter).
2. Set the redirect URI to `{your-domain}/api/apps/mercadolibre/oauth/callback`.
3. Add the following environment variables to your Construct backend (or `.dev.vars` for local development):
   - `MELI_CLIENT_ID` -- your application's Client ID
   - `MELI_CLIENT_SECRET` -- your application's Client Secret
4. Open the MercadoLibre app window in Construct and click **Connect** to initiate the OAuth flow.

Public tools (search, product details, price comparison, trends) work without any authentication.

## Project Structure

```
construct-app-mercadolibre/
  server.ts          # Main Worker entry point -- all tool handlers and API helpers
  manifest.json      # App manifest (metadata, OAuth config, network permissions)
  package.json       # Dependencies and scripts
  wrangler.toml      # Cloudflare Workers configuration
  icon.png           # App icon
  dist/              # Build output (generated)
```

## Development

### Context-based auth pattern

Auth state is **never stored in module-level variables**. The Construct platform injects OAuth credentials per-request via the `x-construct-auth` header, and the SDK extracts them into a `RequestContext` (`ctx`) object passed through the entire call chain:

```typescript
// API helpers accept ctx to carry auth state per-request
async function apiFetch<T>(path: string, ctx: RequestContext): Promise<T> { ... }
async function authFetch<T>(path: string, ctx: RequestContext, options?: RequestInit): Promise<T> { ... }

// Tool handlers receive ctx from the SDK
app.tool('my_tool', {
  handler: async (args, ctx) => {
    requireAuth(ctx);  // throws if not authenticated
    const data = await authFetch('/endpoint', ctx);
    return `Result: ${data}`;
  },
});
```

This ensures no state leaks between requests, even if the Cloudflare Worker runtime reuses an isolate.

### Forking for other APIs

This app is a solid starting point for integrating other marketplace APIs (Amazon, eBay, Shopee, etc.):

1. Fork this repo.
2. Replace the `API_BASE` URL and TypeScript interfaces with the target API's endpoints and response shapes.
3. Update `apiFetch`/`authFetch` to match the target API's authentication scheme (Bearer token, API key, etc.).
4. Rewrite each `app.tool()` registration to call the target API's endpoints. The text formatting patterns (building `lines[]` arrays) translate well to any marketplace.
5. Update `manifest.json` with the new app's OAuth URLs and network permissions.

## Testing

You can test public tools locally with curl:

```bash
# Search for products
curl -X POST http://localhost:8787/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "search_products", "arguments": { "query": "iPhone 15", "site_id": "MLA" } }
}'

# Get trending searches in Brazil
curl -X POST http://localhost:8787/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "get_trends", "arguments": { "site_id": "MLB" } }
}'

# List available country sites
curl -X POST http://localhost:8787/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "list_sites", "arguments": {} }
}'
```

## Publishing

To publish this app to the Construct App Store, see the [Publishing Guide](https://registry.construct.computer/publish). In short: ensure your `manifest.json` is complete, build the worker with `npm run build`, and submit via the registry CLI.

## Links

- [MercadoLibre API Docs](https://developers.mercadolibre.com)
- [App SDK](https://www.npmjs.com/package/@construct-computer/app-sdk)
- [App Store](https://registry.construct.computer)
- [Publishing Guide](https://registry.construct.computer/publish)

## License

MIT

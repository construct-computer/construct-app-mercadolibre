# MercadoLibre — Construct App

Complete [MercadoLibre](https://www.mercadolibre.com) integration for Construct — search products, compare prices, manage listings, process orders, answer buyer questions, and track shipments across Latin America.

## Installation

From your Construct computer, ask the agent:

> Install the MercadoLibre app from https://github.com/anthropics/construct-app-mercadolibre

Or install manually:

```bash
cd /opt/apps/user
git clone https://github.com/anthropics/construct-app-mercadolibre mercadolibre
```

## OAuth Setup (Seller Features)

To use seller tools (orders, listings, questions), you need to connect your MercadoLibre account:

1. Create an app on the [MercadoLibre Developer Portal](https://developers.mercadolibre.com.ar/devcenter)
2. Set the redirect URI to `{your-domain}/api/apps/mercadolibre/oauth/callback`
3. Add `MELI_CLIENT_ID` and `MELI_CLIENT_SECRET` to your Construct backend environment
4. Open the MercadoLibre app window in Construct and click **Connect**

Public tools (search, product details, price comparison) work without authentication.

## Tools

### Public (no auth required)

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

### Authenticated (requires OAuth)

| Tool | Description |
|------|-------------|
| `get_my_account` | Get your account details, reputation, and seller level |
| `list_my_items` | List your active product listings |
| `update_listing` | Update price, stock, or status of a listing |
| `list_orders` | List your recent sales orders |
| `get_order` | Get full order details — buyer, items, payment, shipping |
| `list_questions` | List buyer questions on your listings |
| `answer_question` | Answer a buyer's question |
| `get_shipment` | Get shipment tracking details |
| `send_message` | Send a message in an order conversation |
| `get_item_visits` | Get visit/view statistics for your listings |
| `manage_ads` | Manage Product Ads — check status, activate, or pause campaigns |

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

## Usage Examples

Once installed, you can ask your Construct agent things like:

**Public:**
- "Search for iPhone 15 on MercadoLibre Argentina"
- "Compare prices for Nintendo Switch in Mexico"
- "Show me details for product MLA1234567890"
- "What's trending on MercadoLibre Brazil?"
- "Check the reputation of seller 12345678"

**Seller (after connecting your account):**
- "Show me my active listings"
- "List my recent orders"
- "Are there any unanswered buyer questions?"
- "Answer question #12345 with: Yes, we have it in stock"
- "Update the price of MLA9876543210 to 15000"
- "Track shipment #4567890"

## Development

This app runs as a Cloudflare Worker using the ConstructApp SDK pattern.

### Auth pattern

Auth state is **never stored in module-level variables**. Instead, the Construct platform injects OAuth credentials per-request via the `x-construct-auth` header, and the SDK extracts them into a `RequestContext` (`ctx`) object that is passed through the entire call chain:

```typescript
// apiFetch and authFetch accept ctx as a parameter
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

### Forking for other e-commerce APIs

This app is a good starting point for integrating other marketplace APIs (Amazon, eBay, Shopee, etc.):

1. Fork this repo
2. Replace the `API_BASE` URL and TypeScript interfaces with the target API's endpoints and response shapes
3. Update `apiFetch`/`authFetch` to match the target API's authentication scheme (Bearer token, API key, etc.)
4. Rewrite each `app.tool()` registration to call the target API's endpoints — the text formatting patterns (building `lines[]` arrays) work well for any marketplace
5. Update `manifest.json` with the new app's OAuth URLs and network permissions

### Local development

```bash
npm install
npm exec wrangler dev
```

The Worker listens on `http://localhost:8787/mcp` for JSON-RPC requests and `http://localhost:8787/health` for health checks.

## License

MIT

# MercadoLibre — Construct App

Search products, compare prices, and get details from [MercadoLibre](https://www.mercadolibre.com) across Latin America.

## Installation

From your Construct computer, ask the agent:

> Install the MercadoLibre app from https://github.com/anthropics/construct-app-mercadolibre

Or install manually:

```bash
cd /opt/apps/user
git clone https://github.com/anthropics/construct-app-mercadolibre mercadolibre
```

## Tools

| Tool | Description |
|------|-------------|
| `search_products` | Search for products by keyword with filters for price, condition, and country |
| `get_product` | Get detailed info about a specific product by ID |
| `get_category` | Browse product categories and subcategories |
| `get_seller` | Check a seller's reputation, ratings, and transaction history |
| `compare_prices` | Compare prices across listings with min/max/median stats |
| `list_sites` | List all available MercadoLibre country sites |

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

## Usage Examples

Once installed, you can ask your Construct agent things like:

- "Search for iPhone 15 on MercadoLibre Argentina"
- "Compare prices for Nintendo Switch in Mexico"
- "Show me details for product MLA1234567890"
- "What categories are available on MercadoLibre Brazil?"
- "Check the reputation of seller 12345678"

## Development

This app runs as a Deno subprocess with restricted permissions:

```bash
deno run --allow-net=api.mercadolibre.com server.ts
```

No authentication required — uses MercadoLibre's public API endpoints.

## License

MIT

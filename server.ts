/**
 * MercadoLibre — Construct App Store MCP server.
 *
 * Exposes tools for searching products, comparing prices, and getting
 * detailed product/seller info from MercadoLibre's public API.
 *
 * Runs as a Deno subprocess with --allow-net=api.mercadolibre.com.
 * Communicates via JSON-RPC 2.0 over stdin/stdout (MCP protocol).
 */

import * as readline from 'node:readline';

const API_BASE = 'https://api.mercadolibre.com';

// ─── MercadoLibre Sites ──────────────────────────────────────────────────────

const SITES: Record<string, string> = {
  MLA: 'Argentina',
  MLB: 'Brazil',
  MLM: 'Mexico',
  MLC: 'Chile',
  MCO: 'Colombia',
  MLU: 'Uruguay',
  MPE: 'Peru',
  MEC: 'Ecuador',
  MPA: 'Panama',
  MRD: 'Dominican Republic',
  MBO: 'Bolivia',
  MNI: 'Nicaragua',
  MCR: 'Costa Rica',
  MSV: 'El Salvador',
  MHN: 'Honduras',
  MGT: 'Guatemala',
  MPY: 'Paraguay',
};

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_products',
    description:
      'Search for products on MercadoLibre. Returns product listings with titles, prices, and links. Common site IDs: MLA (Argentina), MLB (Brazil), MLM (Mexico), MLC (Chile), MCO (Colombia).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g. "iphone 15", "zapatillas nike")' },
        site_id: {
          type: 'string',
          description: 'Country site ID. Default: MLA (Argentina). Others: MLB (Brazil), MLM (Mexico), MLC (Chile), MCO (Colombia)',
        },
        limit: { type: 'number', description: 'Max results (1-50, default 10)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
        sort: { type: 'string', description: 'Sort order: "price_asc", "price_desc", or "relevance" (default)' },
        price_min: { type: 'number', description: 'Minimum price filter' },
        price_max: { type: 'number', description: 'Maximum price filter' },
        condition: { type: 'string', description: 'Filter by condition: "new" or "used"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Get detailed information about a specific MercadoLibre product by its item ID (e.g. "MLA1234567890").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        item_id: { type: 'string', description: 'MercadoLibre item ID (e.g. "MLA1234567890")' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'get_category',
    description:
      'Browse product categories on MercadoLibre. Pass "root" as category_id to list top-level categories, or a specific category ID to see subcategories.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category_id: { type: 'string', description: 'Category ID (e.g. "MLA1055") or "root" for top-level categories' },
        site_id: { type: 'string', description: 'Country site ID (only used when category_id is "root"). Default: MLA' },
      },
      required: ['category_id'],
    },
  },
  {
    name: 'get_seller',
    description: 'Get seller reputation and details by seller ID. Useful to check trustworthiness before recommending a product.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        seller_id: { type: 'number', description: 'Seller user ID (numeric)' },
      },
      required: ['seller_id'],
    },
  },
  {
    name: 'compare_prices',
    description:
      'Compare prices for a product across multiple listings. Returns a price-sorted table with min/max/median stats.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Product to search for' },
        site_id: { type: 'string', description: 'Country site ID. Default: MLA' },
        condition: { type: 'string', description: 'Filter: "new", "used", or omit for all' },
        limit: { type: 'number', description: 'Number of listings to compare (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_sites',
    description: 'List all available MercadoLibre country sites and their IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MercadoLibre API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function formatPrice(price: number, currency: string): string {
  return `${currency} ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max - 3) + '...';
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'search_products':
        return await searchProducts(args);
      case 'get_product':
        return await getProduct(args);
      case 'get_category':
        return await getCategory(args);
      case 'get_seller':
        return await getSeller(args);
      case 'compare_prices':
        return await comparePrices(args);
      case 'list_sites':
        return listSites();
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}

// ── search_products ──

interface SearchResult {
  paging: { total: number; offset: number; limit: number };
  results: Array<{
    id: string;
    title: string;
    price: number;
    currency_id: string;
    condition: string;
    permalink: string;
    thumbnail: string;
    seller: { id: number; nickname: string };
    shipping: { free_shipping: boolean };
    sold_quantity?: number;
    available_quantity?: number;
  }>;
}

async function searchProducts(args: Record<string, unknown>): Promise<ToolResult> {
  const query = args.query as string;
  const siteId = (args.site_id as string) || 'MLA';
  const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
  const offset = (args.offset as number) || 0;

  const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });

  if (args.sort === 'price_asc') params.set('sort', 'price_asc');
  else if (args.sort === 'price_desc') params.set('sort', 'price_desc');

  if (args.price_min != null && args.price_max != null) {
    params.set('price', `${args.price_min}-${args.price_max}`);
  } else if (args.price_min != null) {
    params.set('price', `${args.price_min}-*`);
  } else if (args.price_max != null) {
    params.set('price', `*-${args.price_max}`);
  }

  if (args.condition === 'new') params.set('condition', 'new');
  else if (args.condition === 'used') params.set('condition', 'used');

  const data = await apiFetch<SearchResult>(`/sites/${siteId}/search?${params}`);

  if (data.results.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}" on ${siteId} (${SITES[siteId] || siteId}).` }] };
  }

  const lines: string[] = [
    `Search results for "${query}" on MercadoLibre ${SITES[siteId] || siteId} (${data.paging.total} total results):`,
    '',
  ];

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    const num = offset + i + 1;
    lines.push(`${num}. ${truncate(r.title, 80)}`);
    lines.push(`   Price: ${formatPrice(r.price, r.currency_id)} | Condition: ${r.condition}`);
    lines.push(`   Seller: ${r.seller.nickname} | Free shipping: ${r.shipping.free_shipping ? 'Yes' : 'No'}`);
    lines.push(`   ID: ${r.id} | Link: ${r.permalink}`);
    lines.push('');
  }

  if (data.paging.total > offset + limit) {
    lines.push(`Showing ${offset + 1}-${offset + data.results.length} of ${data.paging.total}. Use offset=${offset + limit} to see more.`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── get_product ──

interface ItemDetail {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  condition: string;
  permalink: string;
  available_quantity: number;
  sold_quantity: number;
  category_id: string;
  seller_id: number;
  shipping: { free_shipping: boolean; mode?: string };
  attributes: Array<{ name: string; value_name: string | null }>;
  pictures: Array<{ url: string }>;
  warranty?: string;
  accepts_mercadopago: boolean;
}

async function getProduct(args: Record<string, unknown>): Promise<ToolResult> {
  const itemId = args.item_id as string;
  const data = await apiFetch<ItemDetail>(`/items/${itemId}`);

  const lines: string[] = [
    `Product: ${data.title}`,
    `Price: ${formatPrice(data.price, data.currency_id)}`,
    `Condition: ${data.condition}`,
    `Available: ${data.available_quantity} | Sold: ${data.sold_quantity}`,
    `Free shipping: ${data.shipping.free_shipping ? 'Yes' : 'No'}`,
    `MercadoPago: ${data.accepts_mercadopago ? 'Yes' : 'No'}`,
    data.warranty ? `Warranty: ${data.warranty}` : '',
    `Category: ${data.category_id}`,
    `Seller ID: ${data.seller_id}`,
    `Link: ${data.permalink}`,
    '',
  ];

  // Key attributes (first 10)
  const attrs = data.attributes.filter((a) => a.value_name).slice(0, 10);
  if (attrs.length > 0) {
    lines.push('Attributes:');
    for (const a of attrs) {
      lines.push(`  ${a.name}: ${a.value_name}`);
    }
    lines.push('');
  }

  // Pictures (first 3)
  const pics = data.pictures.slice(0, 3);
  if (pics.length > 0) {
    lines.push('Images:');
    for (const p of pics) {
      lines.push(`  ${p.url}`);
    }
  }

  return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
}

// ── get_category ──

interface CategoryDetail {
  id: string;
  name: string;
  path_from_root: Array<{ id: string; name: string }>;
  children_categories: Array<{ id: string; name: string; total_items_in_this_category: number }>;
  total_items_in_this_category: number;
}

interface SiteCategory {
  id: string;
  name: string;
}

async function getCategory(args: Record<string, unknown>): Promise<ToolResult> {
  const categoryId = args.category_id as string;
  const siteId = (args.site_id as string) || 'MLA';

  if (categoryId === 'root') {
    const data = await apiFetch<SiteCategory[]>(`/sites/${siteId}/categories`);
    const lines = [`Top-level categories for ${SITES[siteId] || siteId}:`, ''];
    for (const cat of data) {
      lines.push(`  ${cat.id} — ${cat.name}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  const data = await apiFetch<CategoryDetail>(`/categories/${categoryId}`);
  const path = data.path_from_root.map((p) => p.name).join(' > ');

  const lines = [
    `Category: ${data.name}`,
    `ID: ${data.id}`,
    `Path: ${path}`,
    `Total items: ${data.total_items_in_this_category.toLocaleString()}`,
    '',
  ];

  if (data.children_categories.length > 0) {
    lines.push('Subcategories:');
    for (const child of data.children_categories.slice(0, 20)) {
      lines.push(`  ${child.id} — ${child.name} (${child.total_items_in_this_category.toLocaleString()} items)`);
    }
  } else {
    lines.push('(No subcategories — this is a leaf category)');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── get_seller ──

interface SellerDetail {
  id: number;
  nickname: string;
  registration_date: string;
  country_id: string;
  address?: { city: string; state: string };
  seller_reputation: {
    level_id: string;
    power_seller_status: string | null;
    transactions: {
      total: number;
      completed: number;
      canceled: number;
      ratings: { positive: number; neutral: number; negative: number };
    };
  };
}

async function getSeller(args: Record<string, unknown>): Promise<ToolResult> {
  const sellerId = args.seller_id as number;
  const data = await apiFetch<SellerDetail>(`/users/${sellerId}`);

  const rep = data.seller_reputation;
  const txns = rep.transactions;
  const ratings = txns.ratings;
  const totalRatings = ratings.positive + ratings.neutral + ratings.negative;
  const positivePercent = totalRatings > 0 ? ((ratings.positive / totalRatings) * 100).toFixed(1) : 'N/A';

  const lines = [
    `Seller: ${data.nickname}`,
    `ID: ${data.id}`,
    `Country: ${data.country_id}`,
    data.address ? `Location: ${data.address.city}, ${data.address.state}` : '',
    `Registered: ${data.registration_date.split('T')[0]}`,
    '',
    `Reputation Level: ${rep.level_id || 'N/A'}`,
    rep.power_seller_status ? `Power Seller: ${rep.power_seller_status}` : '',
    '',
    'Transaction History:',
    `  Total: ${txns.total} | Completed: ${txns.completed} | Canceled: ${txns.canceled}`,
    `  Positive: ${ratings.positive} (${positivePercent}%) | Neutral: ${ratings.neutral} | Negative: ${ratings.negative}`,
  ];

  return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
}

// ── compare_prices ──

async function comparePrices(args: Record<string, unknown>): Promise<ToolResult> {
  const query = args.query as string;
  const siteId = (args.site_id as string) || 'MLA';
  const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);

  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    sort: 'price_asc',
  });

  if (args.condition === 'new') params.set('condition', 'new');
  else if (args.condition === 'used') params.set('condition', 'used');

  const data = await apiFetch<SearchResult>(`/sites/${siteId}/search?${params}`);

  if (data.results.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}" on ${siteId}.` }] };
  }

  const prices = data.results.map((r) => r.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const currency = data.results[0].currency_id;

  const lines: string[] = [
    `Price comparison for "${query}" on MercadoLibre ${SITES[siteId] || siteId}:`,
    `Found ${data.paging.total} total listings.`,
    '',
    `Price range: ${formatPrice(min, currency)} — ${formatPrice(max, currency)}`,
    `Median: ${formatPrice(median, currency)}`,
    '',
    'Listings (sorted by price):',
    '',
  ];

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    lines.push(`${i + 1}. ${formatPrice(r.price, r.currency_id)} — ${truncate(r.title, 60)}`);
    lines.push(`   Condition: ${r.condition} | Free shipping: ${r.shipping.free_shipping ? 'Yes' : 'No'} | Seller: ${r.seller.nickname}`);
    lines.push(`   Link: ${r.permalink}`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── list_sites ──

function listSites(): ToolResult {
  const lines = ['Available MercadoLibre sites:', ''];
  for (const [id, name] of Object.entries(SITES)) {
    lines.push(`  ${id} — ${name}`);
  }
  lines.push('', 'Use the site_id parameter in search_products or compare_prices to search a specific country.');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── JSON-RPC handler ────────────────────────────────────────────────────────

async function handleRequest(req: {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}): Promise<object | null> {
  const { id, method, params } = req;

  // Notifications (no id) — acknowledge silently
  if (id == null) return null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mercadolibre', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = (params as { name: string }).name;
      const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments || {};
      const result = await handleToolCall(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─── Main loop: read stdin, write stdout ─────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line: string) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const response = await handleRequest(req);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }) + '\n',
    );
  }
});

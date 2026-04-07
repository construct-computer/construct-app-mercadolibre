/**
 * MercadoLibre — Construct MCP app built with the ConstructApp SDK.
 *
 * Public tools: search products, compare prices, get product/seller/category info,
 *               browse trends, list country sites, product reviews & descriptions,
 *               currency conversion.
 *
 * Authenticated seller tools (require OAuth): manage listings, orders, questions,
 *                                              shipments, messaging, visit stats,
 *                                              and Product Ads management.
 *
 * Runs as a Cloudflare Worker. Auth tokens injected per-request via
 * x-construct-auth header by the Construct platform and accessed through
 * the RequestContext (ctx) — never stored in module-level variables.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// INLINED: ConstructApp SDK (from @anthropic-ai/construct-app-sdk)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Types ────────────────────────────────────────────────────────────────────

/** A single content block in a tool result. */
interface ContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Full tool result (returned from handler or constructed automatically). */
interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

/** Per-request context injected by the Construct platform. */
interface RequestContext {
  /** User ID from the `x-construct-user` header. */
  userId?: string;

  /**
   * OAuth credentials from the `x-construct-auth` header.
   * Only present when the user has connected their account.
   */
  auth?: {
    access_token: string;
    user_id: string;
    [key: string]: unknown;
  };

  /** Whether valid auth credentials are present. */
  isAuthenticated: boolean;

  /** The raw incoming request. */
  request: Request;
}

/** JSON Schema definition for a tool parameter. */
interface ParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: ParameterSchema;
  properties?: Record<string, ParameterSchema>;
  required?: string[];
  [key: string]: unknown;
}

/** Full tool definition with handler. */
interface ToolDefinition {
  description: string;
  parameters?: Record<string, ParameterSchema>;
  inputSchema?: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    ctx: RequestContext,
  ) => Promise<string | ToolResult>;
}

interface ConstructAppOptions {
  name: string;
  version: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

class ConstructApp {
  readonly name: string;
  readonly version: string;
  private tools = new Map<string, ToolDefinition>();

  constructor(options: ConstructAppOptions) {
    this.name = options.name;
    this.version = options.version;
  }

  tool(name: string, definition: ToolDefinition): this {
    this.tools.set(name, definition);
    return this;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp' && request.method === 'POST') {
      return this.handleMcp(request);
    }

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-construct-user, x-construct-auth',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private extractContext(request: Request): RequestContext {
    const ctx: RequestContext = { isAuthenticated: false, request };

    const userId = request.headers.get('x-construct-user');
    if (userId) ctx.userId = userId;

    const authHeader = request.headers.get('x-construct-auth');
    if (authHeader) {
      try {
        const auth = JSON.parse(authHeader);
        ctx.auth = auth;
        ctx.isAuthenticated = !!auth.access_token;
      } catch {
        /* invalid auth header — leave isAuthenticated false */
      }
    }

    return ctx;
  }

  private getToolsList() {
    return Array.from(this.tools.entries()).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema ?? {
        type: 'object' as const,
        properties: def.parameters ?? {},
      },
    }));
  }

  private async handleMcp(request: Request): Promise<Response> {
    const ctx = this.extractContext(request);

    let rpc: JsonRpcRequest;
    try {
      rpc = (await request.json()) as JsonRpcRequest;
    } catch {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      );
    }

    if (rpc.id === undefined || rpc.id === null) {
      return new Response(null, { status: 204 });
    }

    switch (rpc.method) {
      case 'initialize':
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version },
          },
        });

      case 'tools/list':
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { tools: this.getToolsList() },
        });

      case 'tools/call':
        return this.handleToolCall(rpc, ctx);

      default:
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32601, message: `Unknown method: ${rpc.method}` },
        });
    }
  }

  private async handleToolCall(rpc: JsonRpcRequest, ctx: RequestContext): Promise<Response> {
    const params = rpc.params ?? {};
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

    const tool = this.tools.get(toolName);
    if (!tool) {
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}. Available: ${[...this.tools.keys()].join(', ')}` }],
          isError: true,
        },
      });
    }

    try {
      const result = await tool.handler(toolArgs, ctx);

      const content: ContentBlock[] =
        typeof result === 'string'
          ? [{ type: 'text', text: result }]
          : result.content;

      const isError = typeof result === 'string' ? false : result.isError;

      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content, ...(isError && { isError }) },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        },
      });
    }
  }
}

function requireAuth(ctx: RequestContext): asserts ctx is RequestContext & { auth: NonNullable<RequestContext['auth']> } {
  if (!ctx.isAuthenticated || !ctx.auth) {
    throw new Error('Not authenticated. Connect your MercadoLibre account first via the app window.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

const API_BASE = 'https://api.mercadolibre.com';

const app = new ConstructApp({ name: 'mercadolibre', version: '2.0.0' });

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

// ─── API helpers ─────────────────────────────────────────────────────────────

/**
 * Public API fetch — uses access token if available (MeLi requires tokens for
 * most endpoints now), falls back to unauthenticated for truly public ones.
 */
async function apiFetch<T>(path: string, ctx: RequestContext): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ctx.auth?.access_token) {
    headers.Authorization = `Bearer ${ctx.auth.access_token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if ((res.status === 401 || res.status === 403) && !ctx.auth?.access_token) {
      throw new Error(
        `MercadoLibre requires authentication for this endpoint. ` +
        `Connect your account via the app window to enable this tool. (${res.status})`
      );
    }
    if (res.status === 429) {
      throw new Error('MercadoLibre rate limit reached. Please wait a moment and try again.');
    }
    throw new Error(`MercadoLibre API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Authenticated fetch — requires Bearer token. Used for seller-specific endpoints. */
async function authFetch<T>(path: string, ctx: RequestContext, options: RequestInit = {}): Promise<T> {
  requireAuth(ctx);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ctx.auth.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('Access token expired or invalid. Reconnect your MercadoLibre account.');
    }
    if (res.status === 429) {
      throw new Error('MercadoLibre rate limit reached. Please wait a moment and try again.');
    }
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

function getUserId(ctx: RequestContext): string {
  requireAuth(ctx);
  if (!ctx.auth.user_id) throw new Error('User ID not available. Reconnect your MercadoLibre account.');
  return ctx.auth.user_id;
}

// ─── TypeScript interfaces ──────────────────────────────────────────────────

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
  status?: string;
}

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

interface Order {
  id: number;
  status: string;
  date_created: string;
  total_amount: number;
  currency_id: string;
  buyer: { id: number; nickname: string; first_name?: string; last_name?: string };
  order_items: Array<{ item: { id: string; title: string }; quantity: number; unit_price: number }>;
  shipping?: { id: number };
  payments: Array<{ id: number; status: string; total_paid_amount: number }>;
  pack_id?: number;
}

interface Question {
  id: number;
  text: string;
  status: string;
  date_created: string;
  item_id: string;
  from: { id: number; nickname?: string };
  answer?: { text: string; date_created: string };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

// ── search_products ──

app.tool('search_products', {
  description:
    'Search for products on MercadoLibre. Returns product listings with titles, prices, and links. Common site IDs: MLA (Argentina), MLB (Brazil), MLM (Mexico), MLC (Chile), MCO (Colombia). Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keywords (e.g. "iphone 15", "zapatillas nike")' },
      site_id: {
        type: 'string',
        description: 'Country site ID. Default: MLA (Argentina). Others: MLB, MLM, MLC, MCO',
      },
      limit: { type: 'number', description: 'Max results (1-50, default 10)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
      sort: { type: 'string', description: 'Sort: "price_asc", "price_desc", or "relevance" (default)' },
      price_min: { type: 'number', description: 'Minimum price filter' },
      price_max: { type: 'number', description: 'Maximum price filter' },
      condition: { type: 'string', description: 'Filter: "new" or "used"' },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
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

    const data = await apiFetch<SearchResult>(`/sites/${siteId}/search?${params}`, ctx);

    if (data.results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No results found for "${query}" on ${siteId} (${SITES[siteId] || siteId}).` }] };
    }

    const lines: string[] = [
      `Search results for "${query}" on MercadoLibre ${SITES[siteId] || siteId} (${data.paging.total} total):`,
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

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_product ──

app.tool('get_product', {
  description: 'Get detailed information about a specific MercadoLibre product by its item ID (e.g. "MLA1234567890"). Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'MercadoLibre item ID (e.g. "MLA1234567890")' },
    },
    required: ['item_id'],
  },
  handler: async (args, ctx) => {
    const itemId = args.item_id as string;
    const data = await apiFetch<ItemDetail>(`/items/${itemId}`, ctx);

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

    const attrs = data.attributes.filter((a) => a.value_name).slice(0, 10);
    if (attrs.length > 0) {
      lines.push('Attributes:');
      for (const a of attrs) {
        lines.push(`  ${a.name}: ${a.value_name}`);
      }
      lines.push('');
    }

    const pics = data.pictures.slice(0, 3);
    if (pics.length > 0) {
      lines.push('Images:');
      for (const p of pics) {
        lines.push(`  ${p.url}`);
      }
    }

    return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
  },
});

// ── get_category ──

app.tool('get_category', {
  description:
    'Browse product categories on MercadoLibre. Pass "root" as category_id for top-level categories, or a specific category ID for subcategories.',
  inputSchema: {
    type: 'object',
    properties: {
      category_id: { type: 'string', description: 'Category ID (e.g. "MLA1055") or "root" for top-level' },
      site_id: { type: 'string', description: 'Country site ID (only for "root"). Default: MLA' },
    },
    required: ['category_id'],
  },
  handler: async (args, ctx) => {
    const categoryId = args.category_id as string;
    const siteId = (args.site_id as string) || 'MLA';

    if (categoryId === 'root') {
      const data = await apiFetch<SiteCategory[]>(`/sites/${siteId}/categories`, ctx);
      const lines = [`Top-level categories for ${SITES[siteId] || siteId}:`, ''];
      for (const cat of data) {
        lines.push(`  ${cat.id} — ${cat.name}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }

    const data = await apiFetch<CategoryDetail>(`/categories/${categoryId}`, ctx);
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

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_seller ──

app.tool('get_seller', {
  description: 'Get seller reputation and details by seller ID. Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      seller_id: { type: 'number', description: 'Seller user ID (numeric)' },
    },
    required: ['seller_id'],
  },
  handler: async (args, ctx) => {
    const sellerId = args.seller_id as number;
    const data = await apiFetch<SellerDetail>(`/users/${sellerId}`, ctx);

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

    return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
  },
});

// ── compare_prices ──

app.tool('compare_prices', {
  description: 'Compare prices for a product across multiple listings. Returns a price-sorted table with min/max/median stats. Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Product to search for' },
      site_id: { type: 'string', description: 'Country site ID. Default: MLA' },
      condition: { type: 'string', description: 'Filter: "new", "used", or omit for all' },
      limit: { type: 'number', description: 'Number of listings to compare (default 10, max 50)' },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    const query = args.query as string;
    const siteId = (args.site_id as string) || 'MLA';
    const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);

    const params = new URLSearchParams({ q: query, limit: String(limit), sort: 'price_asc' });

    if (args.condition === 'new') params.set('condition', 'new');
    else if (args.condition === 'used') params.set('condition', 'used');

    const data = await apiFetch<SearchResult>(`/sites/${siteId}/search?${params}`, ctx);

    if (data.results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No results found for "${query}" on ${siteId}.` }] };
    }

    const prices = data.results.map((r) => r.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const sorted = [...prices].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 0
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

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── list_sites ──

app.tool('list_sites', {
  description: 'List all available MercadoLibre country sites and their IDs.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const lines = ['Available MercadoLibre sites:', ''];
    for (const [id, name] of Object.entries(SITES)) {
      lines.push(`  ${id} — ${name}`);
    }
    lines.push('', 'Use the site_id parameter in search_products or compare_prices to search a specific country.');
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_trends ──

app.tool('get_trends', {
  description: 'Get trending searches for a MercadoLibre country. Shows what people are searching for right now. Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      site_id: { type: 'string', description: 'Country site ID. Default: MLA (Argentina)' },
    },
  },
  handler: async (args, ctx) => {
    const siteId = (args.site_id as string) || 'MLA';
    const data = await apiFetch<Array<{ keyword: string; url: string }>>(`/trends/${siteId}`, ctx);

    if (!data || data.length === 0) {
      return { content: [{ type: 'text' as const, text: `No trending searches found for ${siteId} (${SITES[siteId] || siteId}).` }] };
    }

    const lines = [
      `Trending searches on MercadoLibre ${SITES[siteId] || siteId}:`,
      '',
    ];
    for (let i = 0; i < data.length; i++) {
      lines.push(`${i + 1}. ${data[i].keyword}`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_product_reviews ──

app.tool('get_product_reviews', {
  description: 'Get buyer reviews and ratings for a product. Shows rating average, star distribution, and individual reviews. Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'MercadoLibre item ID (e.g. "MLA1234567890")' },
      limit: { type: 'number', description: 'Max reviews to return (1-50, default 10)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
    },
    required: ['item_id'],
  },
  handler: async (args, ctx) => {
    const itemId = args.item_id as string;
    const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
    const offset = (args.offset as number) || 0;

    const data = await apiFetch<{
      paging: { total: number; limit: number; offset: number };
      reviews: Array<{
        id: number;
        title?: string;
        content?: string;
        rate: number;
        valorization: number;
        date_created: string;
        buying_date?: string;
        relevance: number;
        likes: number;
        dislikes: number;
      }>;
      rating_average: number;
      rating_levels: Record<string, number>;
    }>(`/reviews/item/${itemId}?limit=${limit}&offset=${offset}`, ctx);

    if (!data.reviews || data.reviews.length === 0) {
      return { content: [{ type: 'text' as const, text: `No reviews found for item ${itemId}.` }] };
    }

    const lines: string[] = [
      `Reviews for ${itemId}:`,
      `Average rating: ${'★'.repeat(Math.round(data.rating_average))}${'☆'.repeat(5 - Math.round(data.rating_average))} ${data.rating_average.toFixed(1)}/5 (${data.paging.total} reviews)`,
      '',
    ];

    // Star distribution
    if (data.rating_levels) {
      const levels = data.rating_levels;
      lines.push('Rating distribution:');
      for (let star = 5; star >= 1; star--) {
        const key = `${['', 'one', 'two', 'three', 'four', 'five'][star]}_star`;
        const count = levels[key] || 0;
        lines.push(`  ${'★'.repeat(star)}${'☆'.repeat(5 - star)} ${count}`);
      }
      lines.push('');
    }

    for (let i = 0; i < data.reviews.length; i++) {
      const r = data.reviews[i];
      const date = r.date_created.split('T')[0];
      const stars = '★'.repeat(r.rate) + '☆'.repeat(5 - r.rate);
      lines.push(`${offset + i + 1}. ${stars} (${r.rate}/5) — ${date}`);
      if (r.title) lines.push(`   "${r.title}"`);
      if (r.content) lines.push(`   ${truncate(r.content, 200)}`);
      if (r.likes > 0 || r.dislikes > 0) lines.push(`   Helpful: ${r.likes} 👍 ${r.dislikes} 👎`);
      lines.push('');
    }

    if (data.paging.total > offset + limit) {
      lines.push(`Showing ${offset + 1}-${offset + data.reviews.length} of ${data.paging.total}. Use offset=${offset + limit} for more.`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_product_description ──

app.tool('get_product_description', {
  description: 'Get the full text description of a MercadoLibre product listing. Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'MercadoLibre item ID (e.g. "MLA1234567890")' },
    },
    required: ['item_id'],
  },
  handler: async (args, ctx) => {
    const itemId = args.item_id as string;

    const data = await apiFetch<{
      text?: string;
      plain_text?: string;
      snapshot?: { url: string };
    }>(`/items/${itemId}/description`, ctx);

    const description = data.plain_text || data.text || '';

    if (!description && !data.snapshot?.url) {
      return { content: [{ type: 'text' as const, text: `No description available for item ${itemId}.` }] };
    }

    const lines = [`Description for ${itemId}:`, ''];

    if (description) {
      // Clean up HTML if plain_text wasn't available
      const clean = description
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
      lines.push(clean);
    }

    if (data.snapshot?.url) {
      lines.push('', `Description image: ${data.snapshot.url}`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_currency_conversion ──

app.tool('get_currency_conversion', {
  description: 'Convert between currencies using MercadoLibre exchange rates. Useful for comparing prices across countries. Requires account connection.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source currency code (e.g. "USD", "ARS", "BRL", "MXN")' },
      to: { type: 'string', description: 'Target currency code (e.g. "USD", "ARS", "BRL", "MXN")' },
      amount: { type: 'number', description: 'Amount to convert (default 1)' },
    },
    required: ['from', 'to'],
  },
  handler: async (args, ctx) => {
    const from = (args.from as string).toUpperCase();
    const to = (args.to as string).toUpperCase();
    const amount = (args.amount as number) || 1;

    const data = await apiFetch<{
      currency_base: string;
      currency_quote: string;
      ratio: number;
      inv_rate: number;
      creation_date: string;
      valid_until: string;
    }>(`/currency_conversions/search?from=${from}&to=${to}`, ctx);

    const converted = amount * data.ratio;

    const lines = [
      `Currency Conversion (MercadoLibre rates):`,
      '',
      `${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} ${from} = ${converted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${to}`,
      '',
      `Rate: 1 ${from} = ${data.ratio.toFixed(6)} ${to}`,
      `Inverse: 1 ${to} = ${data.inv_rate.toFixed(6)} ${from}`,
      `Valid until: ${data.valid_until?.split('T')[0] || 'N/A'}`,
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED SELLER TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

// ── get_my_account ──

app.tool('get_my_account', {
  description: 'Get your MercadoLibre account details — name, email, reputation, seller level. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const data = await authFetch<{
      id: number;
      nickname: string;
      first_name: string;
      last_name: string;
      email: string;
      country_id: string;
      address?: { city: string; state: string };
      seller_reputation?: {
        level_id: string;
        power_seller_status: string | null;
        transactions: { total: number; completed: number; canceled: number };
      };
      buyer_reputation?: { tags: string[] };
      status?: { site_status: string };
      points?: number;
    }>('/users/me', ctx);

    const lines = [
      `Account: ${data.nickname}`,
      `Name: ${data.first_name} ${data.last_name}`,
      `Email: ${data.email}`,
      `User ID: ${data.id}`,
      `Country: ${data.country_id}`,
      data.address ? `Location: ${data.address.city}, ${data.address.state}` : '',
      '',
    ];

    if (data.seller_reputation) {
      const sr = data.seller_reputation;
      lines.push(`Seller Level: ${sr.level_id || 'N/A'}`);
      if (sr.power_seller_status) lines.push(`Power Seller: ${sr.power_seller_status}`);
      lines.push(`Transactions: ${sr.transactions.total} total, ${sr.transactions.completed} completed, ${sr.transactions.canceled} canceled`);
    }

    if (data.status) {
      lines.push(`Status: ${data.status.site_status}`);
    }

    return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
  },
});

// ── list_my_items ──

app.tool('list_my_items', {
  description: 'List your active product listings on MercadoLibre. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter by status: "active" (default), "paused", "closed"' },
      limit: { type: 'number', description: 'Max results (1-50, default 20)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
    },
  },
  handler: async (args, ctx) => {
    const userId = getUserId(ctx);
    const status = (args.status as string) || 'active';
    const limit = Math.min(Math.max((args.limit as number) || 20, 1), 50);
    const offset = (args.offset as number) || 0;

    const params = new URLSearchParams({
      seller_id: userId,
      status,
      limit: String(limit),
      offset: String(offset),
    });

    const searchData = await authFetch<{
      paging: { total: number; offset: number; limit: number };
      results: string[];
    }>(`/users/${userId}/items/search?${params}`, ctx);

    if (searchData.results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No ${status} listings found.` }] };
    }

    // Fetch details for each item (batch up to 20)
    const ids = searchData.results.slice(0, 20);
    const itemsData = await authFetch<Array<{
      code: number;
      body: ItemDetail;
    }>>(`/items?ids=${ids.join(',')}&attributes=id,title,price,currency_id,available_quantity,sold_quantity,status,permalink`, ctx);

    const lines: string[] = [
      `Your ${status} listings (${searchData.paging.total} total):`,
      '',
    ];

    for (let i = 0; i < itemsData.length; i++) {
      const item = itemsData[i].body;
      if (!item) continue;
      lines.push(`${offset + i + 1}. ${truncate(item.title, 70)}`);
      lines.push(`   Price: ${formatPrice(item.price, item.currency_id)} | Stock: ${item.available_quantity} | Sold: ${item.sold_quantity}`);
      lines.push(`   Status: ${item.status || status} | ID: ${item.id}`);
      lines.push(`   Link: ${item.permalink}`);
      lines.push('');
    }

    if (searchData.paging.total > offset + limit) {
      lines.push(`Showing ${offset + 1}-${offset + ids.length} of ${searchData.paging.total}. Use offset=${offset + limit} for more.`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── update_listing ──

app.tool('update_listing', {
  description: 'Update a product listing — change price, available quantity, or status. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'Item ID to update (e.g. "MLA1234567890")' },
      price: { type: 'number', description: 'New price (omit to keep current)' },
      available_quantity: { type: 'number', description: 'New stock quantity (omit to keep current)' },
      status: { type: 'string', description: 'New status: "active", "paused", or "closed"' },
    },
    required: ['item_id'],
  },
  handler: async (args, ctx) => {
    const itemId = args.item_id as string;

    const updates: Record<string, unknown> = {};
    if (args.price != null) updates.price = args.price;
    if (args.available_quantity != null) updates.available_quantity = args.available_quantity;
    if (args.status) updates.status = args.status;

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: 'text' as const, text: 'No updates provided. Specify price, available_quantity, or status to update.' }], isError: true };
    }

    const data = await authFetch<ItemDetail>(`/items/${itemId}`, ctx, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });

    const lines = [
      `Listing updated: ${data.title}`,
      `ID: ${data.id}`,
      `Price: ${formatPrice(data.price, data.currency_id)}`,
      `Stock: ${data.available_quantity}`,
      `Status: ${data.status || 'active'}`,
      `Link: ${data.permalink}`,
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── list_orders ──

app.tool('list_orders', {
  description: 'List your recent sales orders. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter: "paid", "shipped", "delivered", "cancelled" (omit for all)' },
      limit: { type: 'number', description: 'Max results (1-50, default 20)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
      sort: { type: 'string', description: 'Sort: "date_desc" (default) or "date_asc"' },
    },
  },
  handler: async (args, ctx) => {
    const userId = getUserId(ctx);
    const limit = Math.min(Math.max((args.limit as number) || 20, 1), 50);
    const offset = (args.offset as number) || 0;
    const sort = (args.sort as string) === 'date_asc' ? 'date_asc' : 'date_desc';

    const params = new URLSearchParams({
      seller: userId,
      limit: String(limit),
      offset: String(offset),
      sort,
    });

    if (args.status) params.set('order.status', args.status as string);

    const data = await authFetch<{
      paging: { total: number; offset: number; limit: number };
      results: Order[];
    }>(`/orders/search?${params}`, ctx);

    if (data.results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No orders found matching the criteria.' }] };
    }

    const lines: string[] = [
      `Your orders (${data.paging.total} total):`,
      '',
    ];

    for (let i = 0; i < data.results.length; i++) {
      const o = data.results[i];
      const date = o.date_created.split('T')[0];
      const items = o.order_items.map((oi) => `${oi.item.title} x${oi.quantity}`).join(', ');
      lines.push(`${offset + i + 1}. Order #${o.id} — ${o.status.toUpperCase()}`);
      lines.push(`   Date: ${date} | Total: ${formatPrice(o.total_amount, o.currency_id)}`);
      lines.push(`   Buyer: ${o.buyer.nickname}${o.buyer.first_name ? ` (${o.buyer.first_name} ${o.buyer.last_name || ''})` : ''}`);
      lines.push(`   Items: ${truncate(items, 80)}`);
      if (o.shipping?.id) lines.push(`   Shipment ID: ${o.shipping.id}`);
      lines.push('');
    }

    if (data.paging.total > offset + limit) {
      lines.push(`Showing ${offset + 1}-${offset + data.results.length} of ${data.paging.total}. Use offset=${offset + limit} for more.`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── get_order ──

app.tool('get_order', {
  description: 'Get full details of a specific order — buyer info, items, payment, shipping. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      order_id: { type: 'number', description: 'Order ID (numeric)' },
    },
    required: ['order_id'],
  },
  handler: async (args, ctx) => {
    const orderId = args.order_id as number;
    const data = await authFetch<Order>(`/orders/${orderId}`, ctx);

    const lines = [
      `Order #${data.id}`,
      `Status: ${data.status.toUpperCase()}`,
      `Date: ${data.date_created.split('T')[0]}`,
      `Total: ${formatPrice(data.total_amount, data.currency_id)}`,
      '',
      `Buyer: ${data.buyer.nickname}${data.buyer.first_name ? ` (${data.buyer.first_name} ${data.buyer.last_name || ''})` : ''}`,
      `Buyer ID: ${data.buyer.id}`,
      '',
      'Items:',
    ];

    for (const oi of data.order_items) {
      lines.push(`  - ${oi.item.title} (${oi.item.id})`);
      lines.push(`    Qty: ${oi.quantity} | Unit price: ${formatPrice(oi.unit_price, data.currency_id)}`);
    }

    if (data.payments.length > 0) {
      lines.push('');
      lines.push('Payments:');
      for (const p of data.payments) {
        lines.push(`  - Payment #${p.id}: ${p.status} — ${formatPrice(p.total_paid_amount, data.currency_id)}`);
      }
    }

    if (data.shipping?.id) {
      lines.push('');
      lines.push(`Shipment ID: ${data.shipping.id} (use get_shipment for tracking)`);
    }

    if (data.pack_id) {
      lines.push(`Pack ID: ${data.pack_id} (use send_message with this ID)`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── list_questions ──

app.tool('list_questions', {
  description: 'List buyer questions on your listings. Filter by status to find unanswered ones. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter: "unanswered" (default), "answered", or omit for all' },
      item_id: { type: 'string', description: 'Filter questions for a specific item ID (optional)' },
      limit: { type: 'number', description: 'Max results (1-50, default 20)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
    },
  },
  handler: async (args, ctx) => {
    const userId = getUserId(ctx);
    const status = (args.status as string) || 'unanswered';
    const limit = Math.min(Math.max((args.limit as number) || 20, 1), 50);
    const offset = (args.offset as number) || 0;

    const params = new URLSearchParams({
      seller_id: userId,
      limit: String(limit),
      offset: String(offset),
    });

    if (status === 'unanswered') params.set('status', 'UNANSWERED');
    else if (status === 'answered') params.set('status', 'ANSWERED');

    if (args.item_id) params.set('item', args.item_id as string);

    const data = await authFetch<{
      total: number;
      questions: Question[];
    }>(`/questions/search?${params}`, ctx);

    if (!data.questions || data.questions.length === 0) {
      return { content: [{ type: 'text' as const, text: `No ${status} questions found.` }] };
    }

    const lines: string[] = [
      `Questions (${data.total} total, showing ${status}):`,
      '',
    ];

    for (let i = 0; i < data.questions.length; i++) {
      const q = data.questions[i];
      const date = q.date_created.split('T')[0];
      lines.push(`${offset + i + 1}. Question #${q.id} — ${q.status}`);
      lines.push(`   From: ${q.from.nickname || `User ${q.from.id}`} | Date: ${date}`);
      lines.push(`   Item: ${q.item_id}`);
      lines.push(`   Q: "${q.text}"`);
      if (q.answer) {
        lines.push(`   A: "${q.answer.text}" (${q.answer.date_created.split('T')[0]})`);
      }
      lines.push('');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── answer_question ──

app.tool('answer_question', {
  description: 'Answer a buyer question on one of your listings. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      question_id: { type: 'number', description: 'Question ID to answer' },
      text: { type: 'string', description: 'Your answer text' },
    },
    required: ['question_id', 'text'],
  },
  handler: async (args, ctx) => {
    const questionId = args.question_id as number;
    const text = args.text as string;

    const data = await authFetch<{
      question_id: number;
      text: string;
      status: string;
      date_created: string;
    }>(`/answers`, ctx, {
      method: 'POST',
      body: JSON.stringify({
        question_id: questionId,
        text,
      }),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Answer posted for question #${questionId}.\nStatus: ${data.status}\nAnswer: "${data.text}"`,
      }],
    };
  },
});

// ── get_shipment ──

app.tool('get_shipment', {
  description: 'Get shipment tracking details for an order. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      shipment_id: { type: 'number', description: 'Shipment ID (from order data)' },
    },
    required: ['shipment_id'],
  },
  handler: async (args, ctx) => {
    const shipmentId = args.shipment_id as number;

    const data = await authFetch<{
      id: number;
      status: string;
      substatus?: string;
      tracking_number?: string;
      tracking_method?: string;
      date_created: string;
      last_updated: string;
      receiver_address?: {
        city?: { name: string };
        state?: { name: string };
        zip_code?: string;
      };
      shipping_option?: {
        name?: string;
        estimated_delivery_time?: { date?: string };
      };
      status_history?: {
        date_shipped?: string;
        date_delivered?: string;
      };
    }>(`/shipments/${shipmentId}`, ctx);

    const lines = [
      `Shipment #${data.id}`,
      `Status: ${data.status}${data.substatus ? ` (${data.substatus})` : ''}`,
      data.tracking_number ? `Tracking: ${data.tracking_number}` : '',
      data.tracking_method ? `Carrier: ${data.tracking_method}` : '',
      `Created: ${data.date_created.split('T')[0]}`,
      `Updated: ${data.last_updated.split('T')[0]}`,
      '',
    ];

    if (data.receiver_address) {
      const addr = data.receiver_address;
      lines.push(`Destination: ${[addr.city?.name, addr.state?.name, addr.zip_code].filter(Boolean).join(', ')}`);
    }

    if (data.shipping_option) {
      lines.push(`Shipping method: ${data.shipping_option.name || 'N/A'}`);
      if (data.shipping_option.estimated_delivery_time?.date) {
        lines.push(`Estimated delivery: ${data.shipping_option.estimated_delivery_time.date.split('T')[0]}`);
      }
    }

    if (data.status_history) {
      if (data.status_history.date_shipped) lines.push(`Shipped: ${data.status_history.date_shipped.split('T')[0]}`);
      if (data.status_history.date_delivered) lines.push(`Delivered: ${data.status_history.date_delivered.split('T')[0]}`);
    }

    return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
  },
});

// ── send_message ──

app.tool('send_message', {
  description: 'Send a message to the buyer in an order conversation (post-sale messaging). Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      pack_id: { type: 'number', description: 'Pack/order ID for the conversation' },
      text: { type: 'string', description: 'Message text to send' },
    },
    required: ['pack_id', 'text'],
  },
  handler: async (args, ctx) => {
    const packId = args.pack_id as number;
    const text = args.text as string;
    const userId = getUserId(ctx);

    const data = await authFetch<{
      id: string;
      text: string;
      date_created: string;
    }>(`/messages/packs/${packId}/sellers/${userId}`, ctx, {
      method: 'POST',
      body: JSON.stringify({
        from: { user_id: userId },
        to: { /* MeLi resolves from pack context */ },
        text,
      }),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Message sent in pack #${packId}.\nMessage: "${data.text}"\nSent: ${data.date_created}`,
      }],
    };
  },
});

// ── get_item_visits ──

app.tool('get_item_visits', {
  description: 'Get visit/view statistics for one or more of your listings. Shows total views and daily breakdown. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      item_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Item IDs to check visits for (e.g. ["MLA1234567890"]). Max 50.',
      },
      last: { type: 'number', description: 'Time window: number of units to look back (default 7)' },
      unit: { type: 'string', description: 'Time window unit: "day" (default) or "hour"' },
    },
    required: ['item_ids'],
  },
  handler: async (args, ctx) => {
    const itemIds = args.item_ids as string[];
    const last = (args.last as number) || 7;
    const unit = (args.unit as string) || 'day';

    if (!itemIds || itemIds.length === 0) {
      return { content: [{ type: 'text' as const, text: 'Provide at least one item_id.' }], isError: true };
    }

    const ids = itemIds.slice(0, 50);

    // Get aggregate visit counts
    const totals = await authFetch<Record<string, number>>(
      `/items/visits?ids=${ids.join(',')}`, ctx
    );

    const lines: string[] = [
      `Visit statistics (total all-time):`,
      '',
    ];

    for (const id of ids) {
      const count = totals[id] ?? 0;
      lines.push(`  ${id}: ${count.toLocaleString()} visits`);
    }

    // Get time-window breakdown for the first item (detailed view)
    if (ids.length <= 5) {
      for (const id of ids) {
        try {
          const window = await authFetch<Array<{
            date: string;
            total: number;
          }>>(`/items/${id}/visits/time_window?last=${last}&unit=${unit}`, ctx);

          if (window && window.length > 0) {
            lines.push('');
            lines.push(`${id} — last ${last} ${unit}(s):`);
            for (const entry of window) {
              const date = entry.date?.split('T')[0] || entry.date;
              const bar = '█'.repeat(Math.min(Math.ceil(entry.total / 5), 30));
              lines.push(`  ${date}: ${entry.total} ${bar}`);
            }
          }
        } catch {
          // Time-window endpoint may not be available for all items
        }
      }
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
});

// ── manage_ads ──

app.tool('manage_ads', {
  description: 'Manage Product Ads for your listings — check status, activate, or pause advertising campaigns. Requires OAuth connection.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: "status" (check current ads), "activate" (start ad), or "pause" (stop ad)' },
      item_id: { type: 'string', description: 'Item ID to manage ads for (required for activate/pause)' },
      budget: { type: 'number', description: 'Daily budget in local currency (for activate action)' },
    },
    required: ['action'],
  },
  handler: async (args, ctx) => {
    const userId = getUserId(ctx);
    const action = args.action as string;
    const itemId = args.item_id as string | undefined;

    switch (action) {
      case 'status': {
        // List current ad campaigns
        const data = await authFetch<{
          results: Array<{
            item_id: string;
            status: string;
            daily_budget: number;
            campaign_id: string;
            date_created: string;
            last_updated: string;
          }>;
          paging: { total: number };
        }>(`/advertising/product_ads?user_id=${userId}&limit=20`, ctx);

        if (!data.results || data.results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No active Product Ads found. Use action "activate" with an item_id to create one.' }] };
        }

        const lines: string[] = [
          `Your Product Ads (${data.paging.total} total):`,
          '',
        ];

        for (let i = 0; i < data.results.length; i++) {
          const ad = data.results[i];
          lines.push(`${i + 1}. Item: ${ad.item_id} — ${ad.status.toUpperCase()}`);
          lines.push(`   Campaign: ${ad.campaign_id}`);
          lines.push(`   Daily budget: ${ad.daily_budget}`);
          lines.push(`   Created: ${ad.date_created.split('T')[0]} | Updated: ${ad.last_updated.split('T')[0]}`);
          lines.push('');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      case 'activate': {
        if (!itemId) {
          return { content: [{ type: 'text' as const, text: 'item_id is required to activate an ad.' }], isError: true };
        }
        const budget = (args.budget as number) || 0;
        const body: Record<string, unknown> = { item_id: itemId, status: 'active' };
        if (budget > 0) body.daily_budget = budget;

        const data = await authFetch<{
          item_id: string;
          campaign_id: string;
          status: string;
          daily_budget: number;
        }>('/advertising/product_ads', ctx, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Ad activated for item ${data.item_id}.\nCampaign: ${data.campaign_id}\nStatus: ${data.status}\nDaily budget: ${data.daily_budget}`,
          }],
        };
      }

      case 'pause': {
        if (!itemId) {
          return { content: [{ type: 'text' as const, text: 'item_id is required to pause an ad.' }], isError: true };
        }

        const data = await authFetch<{
          item_id: string;
          campaign_id: string;
          status: string;
        }>(`/advertising/product_ads/${itemId}`, ctx, {
          method: 'PUT',
          body: JSON.stringify({ status: 'paused' }),
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Ad paused for item ${data.item_id}.\nCampaign: ${data.campaign_id}\nStatus: ${data.status}`,
          }],
        };
      }

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown action "${action}". Use "status", "activate", or "pause".` }],
          isError: true,
        };
    }
  },
});

// ─── Export ──────────────────────────────────────────────────────────────────

export default app;

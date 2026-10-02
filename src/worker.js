/**
 * JevAds Cloudflare Worker - Google Ads negative-keyword viewer and
 * search-term triage.
 *
 * A port of api.py + google_ads.py onto the Workers runtime, route for route
 * and shape for shape, so the same index.html talks to either backend.
 *
 * Auth is pure OAuth 2.0: the browser signs in, we exchange the code here, and
 * every Google Ads call rides on that user's bearer token. There is no
 * developer token anywhere in this file - do not add one.
 *
 * Triage runs in-process (src/triage.js); there is no JEV sidecar to reach.
 */
import { triage } from "./triage.js";

// Latest GA major version. Only MAJOR versions appear in REST paths - minor
// releases (v25.1, v25.2) apply automatically to this same endpoint, so
// calling /v25 today serves the v25.2 feature set. There is no /v25.2 path.
export const API_VERSION = "v25";
const BASE = `https://googleads.googleapis.com/${API_VERSION}`;

// Google Ads rejects a searchStream page larger than this.
const PAGE_LIMIT = 10000;

const SCOPES = "openid email profile https://www.googleapis.com/auth/adwords";
const SESSION_KEY = "jev_ads_auth_session";

// Google's relative date constants only exist for these windows; any other
// lookback is expressed as an explicit BETWEEN range instead.
const DURING_DAYS = new Set([7, 14, 30]);

// --- errors ------------------------------------------------------------------

/** A non-2xx response from the Google Ads API, with the parsed body. */
export class GoogleAdsError extends Error {
  constructor(message, details = null, status = 400) {
    super(message);
    this.name = "GoogleAdsError";
    this.details = details;
    this.status = status;
  }
}

/** An error that already knows which status and `detail` body to render. */
export class HttpError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

const CORS = {
  // Bearer tokens travel in the request body, not cookies, so credentialed
  // requests are not needed - and "*" with credentials is rejected by browsers.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Mirror api.py's _ads_error: keep the useful statuses, flatten the rest. */
function adsErrorResponse(e) {
  const status = [400, 401, 403, 404, 429].includes(e.status) ? e.status : 400;
  return json(
    { detail: { error: String(e.message), details: e.details, api_version: API_VERSION } },
    status,
  );
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- safe field access -------------------------------------------------------

/**
 * Walk a nested GAQL result safely.
 *
 * Google serialises protobuf to JSON with default-valued fields omitted, so a
 * nested object (campaign, adGroup, metrics, campaignBudget) can be missing
 * entirely on a row that is otherwise fine. Indexing straight into it throws
 * and takes down the whole request.
 */
export function g(row, ...path) {
  let cur = row;
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return "";
    cur = cur[key];
    if (cur === null || cur === undefined) return "";
  }
  return cur === null || cur === undefined ? "" : cur;
}

/**
 * Coerce a GAQL numeric field to a number.
 *
 * Protobuf JSON encodes int64/uint64 as *strings* - amountMicros, costMicros,
 * impressions, clicks and memberCount all arrive quoted - so the raw value
 * must never go straight into arithmetic. Doubles like metrics.conversions
 * come back as real numbers, hence accepting both.
 */
export function num(value, dflt = 0) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return dflt;
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : dflt;
}

/** Round to cents without the usual floating-point surprises. */
export function round2(n) {
  const v = num(n);
  return Math.round((v + (v >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
}

/** Convert a micros field to currency units, rounded to cents. */
export function micros(value) {
  return round2(num(value) / 1000000);
}

/** Protobuf int64 counters are strings; these are whole numbers by definition. */
export function int(value) {
  return Math.trunc(num(value));
}

export function formatCid(cid) {
  const s = String(cid === null || cid === undefined ? "" : cid);
  return s.length === 10 ? `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}` : s;
}

/** Strip formatting so a customer id is safe to interpolate into a URL. */
function cleanCid(cid) {
  return String(cid === null || cid === undefined ? "" : cid).replace(/[^0-9]/g, "");
}

// --- Google Ads transport ----------------------------------------------------

function adsHeaders(accessToken, loginCustomerId = "") {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  // Set only when a client account is queried through its manager. No
  // developer token: this API surface does not need one for OAuth-only use.
  const loginCid = cleanCid(loginCustomerId);
  if (loginCid) headers["login-customer-id"] = loginCid;
  return headers;
}

/** Pull the most useful human-readable message out of an error body. */
export function extractError(body) {
  let b = body;
  if (Array.isArray(b) && b.length) b = b[0];
  if (b === null || typeof b !== "object") return String(b).slice(0, 300);
  const err = b.error && typeof b.error === "object" ? b.error : b;

  // GoogleAdsFailure carries the precise per-field reason.
  for (const detail of Array.isArray(err.details) ? err.details : []) {
    for (const failure of detail && Array.isArray(detail.errors) ? detail.errors : []) {
      if (failure && failure.message) return failure.message;
    }
  }
  return err.message || "Unknown Google Ads API error";
}

async function parseJsonResponse(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GoogleAdsError(
      `Non-JSON response from Google Ads (${resp.status})`,
      text.slice(0, 500),
      resp.status,
    );
  }
}

/** Run one GAQL query and return the flattened result rows. */
export async function search(accessToken, customerId, query, loginCustomerId = "") {
  const cid = cleanCid(customerId);
  const resp = await fetch(`${BASE}/customers/${cid}/googleAds:searchStream`, {
    method: "POST",
    headers: adsHeaders(accessToken, loginCustomerId),
    body: JSON.stringify({ query }),
  });

  const body = await parseJsonResponse(resp);
  if (!resp.ok) throw new GoogleAdsError(extractError(body), body, resp.status);

  // searchStream returns an array of batches; a single-batch reply may be bare.
  const batches = Array.isArray(body) ? body : [body];
  const rows = [];
  for (const batch of batches) {
    const results = batch && batch.results;
    if (Array.isArray(results)) for (const row of results) rows.push(row);
  }
  return rows;
}

/** Return the customer IDs this OAuth token can reach directly. */
export async function listAccessibleCustomers(accessToken) {
  const resp = await fetch(`${BASE}/customers:listAccessibleCustomers`, {
    method: "GET",
    headers: adsHeaders(accessToken),
  });
  const body = await parseJsonResponse(resp);
  if (!resp.ok) throw new GoogleAdsError(extractError(body), body, resp.status);
  const names = Array.isArray(body.resourceNames) ? body.resourceNames : [];
  return names.map((rn) => String(rn).split("/").pop());
}

// --- account discovery -------------------------------------------------------

const HIERARCHY_QUERY = `
    SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.time_zone,
        customer_client.manager,
        customer_client.level
    FROM customer_client
    WHERE customer_client.status = 'ENABLED'
`;

/**
 * Expand every reachable login customer into its full client hierarchy.
 *
 * One manager failing (no access, suspended, API disabled) must not sink the
 * whole request, so per-account failures are collected as warnings instead.
 */
export async function discoverAccounts(accessToken) {
  const topCids = await listAccessibleCustomers(accessToken);
  const accounts = [];
  const seen = new Set();
  const warnings = [];

  for (const topCid of topCids) {
    let expanded = false;
    try {
      const rows = await search(accessToken, topCid, HIERARCHY_QUERY, topCid);
      for (const row of rows) {
        const cId = String(g(row, "customerClient", "id"));
        if (!cId || seen.has(cId)) continue;
        seen.add(cId);
        expanded = true;
        const isManager = Boolean(g(row, "customerClient", "manager"));
        const name = g(row, "customerClient", "descriptiveName") || `Account ${formatCid(cId)}`;
        accounts.push({
          id: cId,
          formatted_id: formatCid(cId),
          name,
          label: `${name} (${formatCid(cId)})`,
          is_manager: isManager,
          // A client account must authenticate through its manager.
          login_customer_id: cId === topCid ? "" : topCid,
          currency: g(row, "customerClient", "currencyCode") || "",
          level: int(g(row, "customerClient", "level")),
        });
      }
    } catch (e) {
      if (!(e instanceof GoogleAdsError)) throw e;
      warnings.push(`${formatCid(topCid)}: ${e.message}`);
    }

    // Fall back to the bare login customer if the hierarchy query gave nothing.
    if (!expanded && !seen.has(topCid)) {
      seen.add(topCid);
      accounts.push({
        id: topCid,
        formatted_id: formatCid(topCid),
        name: `Account ${formatCid(topCid)}`,
        label: `Account (${formatCid(topCid)})`,
        is_manager: false,
        login_customer_id: "",
        currency: "",
        level: 0,
      });
    }
  }

  // Clients first (a manager has no search terms of its own), then by name.
  accounts.sort((a, b) => {
    const m = (a.is_manager ? 1 : 0) - (b.is_manager ? 1 : 0);
    if (m) return m;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  return { accounts, warnings };
}

// --- row parsing (pure) ------------------------------------------------------

export function parseCampaigns(rows) {
  const out = [];
  for (const r of rows || []) {
    const id = g(r, "campaign", "id");
    if (!id) continue; // no identifier to key on - the row is unusable
    out.push({
      id: String(id),
      name: g(r, "campaign", "name") || "Unnamed campaign",
      status: g(r, "campaign", "status") || "UNKNOWN",
      type: g(r, "campaign", "advertisingChannelType") || "UNKNOWN",
      // campaignBudget is omitted entirely when unset - hence g(), not r.x.y.
      budget_daily: micros(g(r, "campaignBudget", "amountMicros")),
    });
  }
  return out;
}

export function parseAdGroups(rows) {
  const out = [];
  for (const r of rows || []) {
    const id = g(r, "adGroup", "id");
    if (!id) continue;
    out.push({
      id: String(id),
      name: g(r, "adGroup", "name") || "Unnamed ad group",
      status: g(r, "adGroup", "status") || "UNKNOWN",
      campaign_id: String(g(r, "campaign", "id")),
      campaign_name: g(r, "campaign", "name"),
    });
  }
  return out;
}

/**
 * Assemble the three-level negative picture from the five result sets.
 *
 * Kept pure (rows in, payload out) so it can be exercised without a network.
 */
export function parseNegatives({ setRows = [], critRows = [], linkRows = [], campNegRows = [], agNegRows = [] } = {}) {
  // 1. Shared negative sets (the containers).
  const sharedLists = new Map();
  for (const r of setRows) {
    const sid = String(g(r, "sharedSet", "id"));
    if (!sid) continue;
    sharedLists.set(sid, {
      id: sid,
      name: g(r, "sharedSet", "name") || "Shared negative list",
      member_count: int(g(r, "sharedSet", "memberCount")),
      keywords: [],
      applied_campaigns: [],
    });
  }

  // 2. The actual keywords inside each shared set.
  for (const r of critRows) {
    const sid = String(g(r, "sharedSet", "id"));
    const text = g(r, "sharedCriterion", "keyword", "text");
    const list = sharedLists.get(sid);
    if (list && text) {
      list.keywords.push({
        text,
        match_type: g(r, "sharedCriterion", "keyword", "matchType") || "BROAD",
      });
    }
  }

  // 3. Which campaigns each set is attached to.
  for (const r of linkRows) {
    const sid = String(g(r, "sharedSet", "id"));
    const list = sharedLists.get(sid);
    if (list) {
      list.applied_campaigns.push({
        campaign_id: String(g(r, "campaign", "id")),
        campaign_name: g(r, "campaign", "name"),
      });
    }
  }

  // 4. Campaign-level negatives.
  const campaign_negatives = [];
  for (const r of campNegRows) {
    const text = g(r, "campaignCriterion", "keyword", "text");
    if (!text) continue;
    campaign_negatives.push({
      campaign_id: String(g(r, "campaign", "id")),
      campaign_name: g(r, "campaign", "name"),
      text,
      match_type: g(r, "campaignCriterion", "keyword", "matchType") || "BROAD",
    });
  }

  // 5. Ad group-level negatives (traffic sculpting).
  const adgroup_negatives = [];
  for (const r of agNegRows) {
    const text = g(r, "adGroupCriterion", "keyword", "text");
    if (!text) continue;
    adgroup_negatives.push({
      campaign_id: String(g(r, "campaign", "id")),
      campaign_name: g(r, "campaign", "name"),
      ad_group_id: String(g(r, "adGroup", "id")),
      ad_group_name: g(r, "adGroup", "name"),
      text,
      match_type: g(r, "adGroupCriterion", "keyword", "matchType") || "BROAD",
    });
  }

  const lists = [...sharedLists.values()].sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const total =
    lists.reduce((s, l) => s + l.keywords.length, 0) +
    campaign_negatives.length +
    adgroup_negatives.length;

  return {
    shared_lists: lists,
    campaign_negatives,
    adgroup_negatives,
    total_negatives: total,
  };
}

export function parseSearchTerms(rows) {
  const out = [];
  for (const r of rows || []) {
    out.push({
      term: g(r, "searchTermView", "searchTerm"),
      status: g(r, "searchTermView", "status") || "NONE",
      // Triage needs both IDs to decide ad group vs campaign vs shared list.
      campaign_id: String(g(r, "campaign", "id")),
      campaign_name: g(r, "campaign", "name"),
      ad_group_id: String(g(r, "adGroup", "id")),
      ad_group_name: g(r, "adGroup", "name"),
      // metrics is omitted entirely on a row with no stats at all.
      impressions: int(g(r, "metrics", "impressions")),
      clicks: int(g(r, "metrics", "clicks")),
      cost: micros(g(r, "metrics", "costMicros")),
      conversions: round2(num(g(r, "metrics", "conversions"))),
      conv_value: round2(num(g(r, "metrics", "conversionsValue"))),
    });
  }
  return out;
}

// --- Google Ads queries ------------------------------------------------------

/** Campaigns and ad groups, keyed for fast lookup during triage. */
export async function fetchStructure(accessToken, cid, loginCid = "") {
  const [campRows, agRows] = await Promise.all([
    search(accessToken, cid, `
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.advertising_channel_type, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name
    `, loginCid),
    search(accessToken, cid, `
        SELECT ad_group.id, ad_group.name, ad_group.status,
               campaign.id, campaign.name
        FROM ad_group
        WHERE ad_group.status != 'REMOVED'
        ORDER BY campaign.name, ad_group.name
    `, loginCid),
  ]);

  return { campaigns: parseCampaigns(campRows), ad_groups: parseAdGroups(agRows) };
}

/**
 * Every negative keyword on the account, at all three levels.
 *
 * Shared-list members come from shared_criterion - shared_set alone only
 * reports a member count, not the keywords themselves.
 */
export async function fetchNegatives(accessToken, cid, loginCid = "") {
  const [setRows, critRows, linkRows, campNegRows, agNegRows] = await Promise.all([
    search(accessToken, cid, `
        SELECT shared_set.id, shared_set.name, shared_set.member_count
        FROM shared_set
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND shared_set.status != 'REMOVED'
    `, loginCid),
    search(accessToken, cid, `
        SELECT shared_set.id, shared_criterion.keyword.text,
               shared_criterion.keyword.match_type
        FROM shared_criterion
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND shared_set.status != 'REMOVED'
    `, loginCid),
    search(accessToken, cid, `
        SELECT campaign.id, campaign.name, shared_set.id
        FROM campaign_shared_set
        WHERE campaign_shared_set.status = 'ENABLED'
    `, loginCid),
    search(accessToken, cid, `
        SELECT campaign.id, campaign.name,
               campaign_criterion.keyword.text,
               campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'KEYWORD'
          AND campaign_criterion.negative = TRUE
          AND campaign_criterion.status != 'REMOVED'
        LIMIT ${PAGE_LIMIT}
    `, loginCid),
    search(accessToken, cid, `
        SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
               ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = TRUE
          AND ad_group_criterion.status != 'REMOVED'
        LIMIT ${PAGE_LIMIT}
    `, loginCid),
  ]);

  return parseNegatives({ setRows, critRows, linkRows, campNegRows, agNegRows });
}

/** The date predicate for a lookback window, as GAQL will accept it. */
export function datePredicate(days, now = new Date()) {
  const d = int(days) || 30;
  if (DURING_DAYS.has(d)) return `segments.date DURING LAST_${d}_DAYS`;
  // LAST_60_DAYS and LAST_90_DAYS are not Google date constants, and the UI
  // offers both - express anything else as an explicit range. Yesterday is the
  // last day with settled stats.
  const end = new Date(now.getTime() - 86400000);
  const start = new Date(end.getTime() - (d - 1) * 86400000);
  const iso = (x) => x.toISOString().slice(0, 10);
  return `segments.date BETWEEN '${iso(start)}' AND '${iso(end)}'`;
}

/** Search terms with the campaign/ad group IDs triage needs for placement. */
export async function fetchSearchTerms(accessToken, cid, days = 30, loginCid = "", limit = 2000) {
  const rows = await search(accessToken, cid, `
        SELECT search_term_view.search_term,
               search_term_view.status,
               campaign.id, campaign.name,
               ad_group.id, ad_group.name,
               metrics.impressions, metrics.clicks,
               metrics.cost_micros, metrics.conversions,
               metrics.conversions_value
        FROM search_term_view
        WHERE ${datePredicate(days)}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${Math.min(int(limit) || 2000, PAGE_LIMIT)}
    `, loginCid);
  return parseSearchTerms(rows);
}

// --- OAuth -------------------------------------------------------------------

function oauthConfig(env) {
  return {
    clientId: String(env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || "").trim(),
  };
}

/**
 * Google only accepts localhost/127.0.0.1 redirect URIs over plain HTTP.
 *
 * Reaching this app by LAN IP or .local name produces a confusing
 * "device_id and device_name are required for private IP" 400 from Google, so
 * catch it here and say what to do instead.
 */
export function oauthHostProblem(host) {
  const hostname = String(host || "").split(":")[0].toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return null;

  const privateIp =
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname);
  if (privateIp) {
    return (
      `Google will not accept '${hostname}' as an OAuth redirect host - private ` +
      `IP addresses are rejected with 'device_id and device_name are required ` +
      `for private IP'. Reach this app over an SSH tunnel instead:\n\n` +
      `    ssh -L 8090:localhost:8090 you@${hostname}\n\n` +
      `then open http://localhost:8090 in your browser.`
    );
  }
  if (hostname.endsWith(".local")) {
    return (
      `Google will not accept the mDNS name '${hostname}' as an OAuth redirect ` +
      `host. Use an SSH tunnel and browse http://localhost:8090 instead:\n\n` +
      `    ssh -L 8090:localhost:8090 you@${hostname}`
    );
  }
  return null;
}

/**
 * Read the claims out of an id_token.
 *
 * Safe without signature verification only because this token came straight
 * from Google's token endpoint over TLS. Never do this to a client's token.
 */
export function decodeIdToken(idToken) {
  try {
    const part = String(idToken || "").split(".")[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === "object" ? claims : {};
  } catch (e) {
    return {};
  }
}

export function sessionPayload(tokenData, existingRefresh = "") {
  const claims = decodeIdToken(tokenData.id_token);
  const email = claims.email || "";
  const name = claims.name || "";
  const expiresIn = int(num(tokenData.expires_in, 3600)) || 3600;
  return {
    access_token: tokenData.access_token || "",
    // Google only returns a refresh token on first consent; keep the old one.
    refresh_token: tokenData.refresh_token || existingRefresh || "",
    email,
    name,
    display: name && email ? `${name} (${email})` : email || "Google Ads user",
    picture: claims.picture || "",
    // Epoch milliseconds, to match Date.now() in the browser - NOT uptime
    // seconds, which silently broke sign-in. Renew a minute early so a request
    // never goes out on a token that expires mid-flight.
    expires_at: Date.now() + (expiresIn - 60) * 1000,
  };
}

async function exchangeToken(params) {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  let body;
  try {
    body = await resp.json();
  } catch (e) {
    body = { error: "non_json_response" };
  }
  return { ok: resp.ok, body: body && typeof body === "object" ? body : {} };
}

// --- route handlers ----------------------------------------------------------

async function readJsonBody(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch (e) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  throw new HttpError(400, "Request body must be a JSON object");
}

function requireToken(body) {
  const token = String(body.access_token || "").trim();
  if (!token) throw new HttpError(401, "Missing access_token");
  return token;
}

function requireCustomerId(body) {
  const cid = cleanCid(body.customer_id);
  if (!cid) throw new HttpError(400, { error: "Missing or invalid customer_id" });
  return cid;
}

function handleHealth(env) {
  const { clientId, clientSecret } = oauthConfig(env);
  return json({
    status: "ok",
    service: "jev-ads-api",
    google_ads_api: API_VERSION,
    oauth_configured: Boolean(clientId && clientSecret),
    // There is no JEV sidecar on Workers: triage runs in this isolate, so it
    // is always reachable - but say which engine, so the chip stays honest.
    jev: { reachable: true, engine: "jev-worker-inline" },
  });
}

function handleLogin(request, url, env) {
  const { clientId } = oauthConfig(env);
  if (!clientId) {
    throw new HttpError(500, "GOOGLE_ADS_CLIENT_ID is not set in the Worker environment");
  }

  const problem = oauthHostProblem(request.headers.get("host") || url.host);
  if (problem) {
    return html(
      '<body style="font-family:system-ui;max-width:640px;margin:60px auto;' +
        'padding:0 20px;color:#181715">' +
        '<h2 style="color:#991b1b">This host can\'t complete Google sign-in</h2>' +
        '<pre style="white-space:pre-wrap;background:#f4f0e6;padding:16px;' +
        `border-radius:8px;line-height:1.6">${escapeHtml(problem)}</pre></body>`,
      400,
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url.origin}/api/auth/callback`,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` },
  });
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return html(`<h3>Google OAuth error: ${escapeHtml(error)}</h3>`, 400);
  if (!code) return html("<h3>Missing authorization code</h3>", 400);

  const { clientId, clientSecret } = oauthConfig(env);
  let result;
  try {
    result = await exchangeToken({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${url.origin}/api/auth/callback`,
      grant_type: "authorization_code",
    });
  } catch (e) {
    return html(`<h3>Token exchange failed: ${escapeHtml(e.message)}</h3>`, 500);
  }

  if (!result.ok || result.body.error) {
    return html(
      `<h3>Token exchange failed</h3><pre>${escapeHtml(JSON.stringify(result.body, null, 2))}</pre>`,
      400,
    );
  }

  const session = sessionPayload(result.body);
  // Escape "<" so a display name can never break out of the script element.
  const blob = JSON.stringify(session).replace(/</g, "\\u003c");

  return html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px;background:#fbf9f5">
  <h2>Signed in as ${escapeHtml(session.display)}</h2>
  <p>Returning to the dashboard&hellip;</p>
  <script>
    localStorage.setItem(${JSON.stringify(SESSION_KEY)}, JSON.stringify(${blob}));
    location.replace('/');
  </script>
</body></html>`);
}

/** Mint a new access token so an expiring session does not force re-consent. */
async function handleRefresh(request, env) {
  const body = await readJsonBody(request);
  const refreshToken = String(body.refresh_token || "").trim();
  if (!refreshToken) throw new HttpError(400, "Missing refresh_token");

  const { clientId, clientSecret } = oauthConfig(env);
  let result;
  try {
    result = await exchangeToken({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
  } catch (e) {
    throw new HttpError(502, `Token refresh failed: ${e.message}`);
  }

  if (!result.ok || result.body.error) {
    throw new HttpError(401, {
      error: result.body.error_description || result.body.error || "Token refresh rejected",
      details: result.body,
    });
  }
  return json(sessionPayload(result.body, refreshToken));
}

async function handleAccounts(request) {
  const body = await readJsonBody(request);
  const accessToken = requireToken(body);
  const { accounts, warnings } = await discoverAccounts(accessToken);
  return json({ accounts, warnings });
}

function accountArgs(body) {
  return {
    accessToken: requireToken(body),
    cid: requireCustomerId(body),
    loginCid: cleanCid(body.login_customer_id),
  };
}

/** Every negative keyword on the account, grouped by level. */
async function handleNegatives(request) {
  const body = await readJsonBody(request);
  const { accessToken, cid, loginCid } = accountArgs(body);

  const [structure, negatives] = await Promise.all([
    fetchStructure(accessToken, cid, loginCid),
    fetchNegatives(accessToken, cid, loginCid),
  ]);

  return json({ customer_id: cid, api_version: API_VERSION, ...structure, ...negatives });
}

/** Full view: structure, negatives, and search-term recommendations. */
async function handleTriage(request) {
  const body = await readJsonBody(request);
  const { accessToken, cid, loginCid } = accountArgs(body);
  const days = Math.min(Math.max(int(num(body.days, 30)) || 30, 1), 365);
  const minClicks = int(num(body.min_clicks, 2));
  const minCost = num(body.min_cost, 0);

  const [structure, negatives, terms] = await Promise.all([
    fetchStructure(accessToken, cid, loginCid),
    fetchNegatives(accessToken, cid, loginCid),
    fetchSearchTerms(accessToken, cid, days, loginCid),
  ]);

  const result = triage(terms, negatives, { minClicks, minCost });

  return json({
    customer_id: cid,
    api_version: API_VERSION,
    days,
    ...structure,
    ...negatives,
    search_terms_fetched: terms.length,
    ...result,
  });
}

// --- entry point -------------------------------------------------------------

const POST_ROUTES = {
  "/api/auth/refresh": handleRefresh,
  "/api/accounts": handleAccounts,
  "/api/negatives": handleNegatives,
  "/api/triage": handleTriage,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isApi = url.pathname.startsWith("/api/");

    if (isApi && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === "/api/health") return handleHealth(env);
      if (path === "/api/auth/login") return handleLogin(request, url, env);
      if (path === "/api/auth/callback") return await handleCallback(url, env);

      const handler = POST_ROUTES[path];
      if (handler) {
        if (request.method !== "POST") {
          return json({ detail: `Method ${request.method} not allowed` }, 405);
        }
        return await handler(request, env);
      }

      // No API route matched. Answering with the static-asset 404 page would
      // hand the frontend HTML where it expects JSON - the exact thing that
      // produced the useless "Load failed: {}" toast.
      if (isApi) return json({ detail: `No such endpoint: ${url.pathname}` }, 404);
    } catch (e) {
      // Never let an exception reach the browser as an opaque plain-text 500.
      if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
      if (e instanceof GoogleAdsError) return adsErrorResponse(e);

      const ref = Math.random().toString(16).slice(2, 10);
      console.error(`[${ref}] ${request.method} ${url.pathname} ->`, e && e.stack ? e.stack : e);
      return json(
        {
          detail: {
            error: `${(e && e.name) || "Error"}: ${(e && e.message) || e}`.slice(0, 400),
            ref,
            hint: "Full stack in the Worker logs (wrangler tail), search for the ref",
          },
        },
        500,
      );
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not Found", { status: 404 });
  },
};

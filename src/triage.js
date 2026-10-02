/**
 * Search-term triage for Cloudflare Workers - a dependency-free port of
 * `jev_triage.py`, with the JEV `choice` scorer (jev-server/server.py) inlined.
 *
 * Division of labour (unchanged from the Python):
 *   * The JEV `choice` scorer does the fuzzy lexical scoring - which existing
 *     negative does this term most resemble, and which intent vocabulary does
 *     it hit. Its abstain band gives us a principled "send to human" signal.
 *   * Plain code does the exact match-type algebra and the structural
 *     placement rules, because those are deterministic and must not guess.
 *
 * Workers cannot reach localhost:8080, so the scorer runs in-process here.
 * There are NO network calls in this file.
 *
 * Input shapes are exactly the Python ones:
 *   searchTerms: [{ term, status, campaign_id, campaign_name, ad_group_id,
 *                   ad_group_name, impressions, clicks, cost, conversions,
 *                   conv_value }]
 *   negatives:   { shared_lists: [{ id, name, keywords: [{ text, match_type }],
 *                                   applied_campaigns: [{ campaign_id }] }],
 *                  campaign_negatives: [{ text, match_type, campaign_id,
 *                                         campaign_name }],
 *                  adgroup_negatives:  [{ text, match_type, ad_group_id,
 *                                         ad_group_name, campaign_id }] }
 */

// The choice scorer is O(choices) per question; keep the shortlist tight so
// the signal is not drowned out by dozens of non-matching candidates.
export const MAX_CANDIDATES = 25;

// Intent vocabulary. The scorer matches substrings of the raw tokens, and we
// map the winning token back to its group here.
export const LEXICON = {
  employment: [
    "jobs", "job", "career", "careers", "salary", "salaries", "hiring",
    "vacancy", "resume", "internship", "recruitment", "apprenticeship",
  ],
  informational: [
    "what is", "how to", "tutorial", "guide", "meaning", "definition",
    "wikipedia", "examples", "example", "explained", "vs", "difference",
  ],
  freebie: [
    "free", "freeware", "cheap", "cheapest", "discount", "coupon",
    "crack", "cracked", "torrent", "pirated", "download", "pdf",
    "template", "templates", "sample", "trial version",
  ],
  support: [
    "login", "log in", "sign in", "customer service", "complaint",
    "cancel", "refund", "scam", "lawsuit", "contact number",
  ],
  commercial: [
    "buy", "purchase", "pricing", "price", "cost", "quote", "demo",
    "hire", "agency", "consultant", "vendor", "supplier", "company",
    "near me", "best", "top rated", "software", "platform", "solution",
    "enterprise", "for business",
  ],
};

// A term we could not classify needs this multiple of the click floor before we
// will place a negative for it automatically.
export const UNEXPLAINED_CLICK_MULTIPLIER = 2;

// Groups that represent waste anywhere in the account, not just in one ad
// group - these are the ones that belong on a shared list.
export const UNIVERSAL_WASTE = new Set(["employment", "informational", "freebie", "support"]);
export const WASTE_GROUPS = UNIVERSAL_WASTE;
export const BUYER_GROUPS = new Set(["commercial"]);

// token -> group. A Map keeps Python's dict semantics: a repeated token takes
// the last group but keeps its first insertion position.
const TOKEN_GROUP = new Map();
for (const [group, toks] of Object.entries(LEXICON)) {
  for (const tok of toks) TOKEN_GROUP.set(tok, group);
}
const ALL_TOKENS = [...TOKEN_GROUP.keys()];

const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
  ? () => performance.now()
  : () => Date.now();

// --- Numeric helpers ---------------------------------------------------------

/**
 * Python's round(x, nd): round-half-to-even on the exact binary value of the
 * double (JS toFixed is half-away-from-zero, which differs on exact ties such
 * as round(0.125, 2) -> 0.12).
 */
function pyRound(x, nd) {
  const v = Number(x);
  if (!Number.isFinite(v)) return v;
  const negative = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);

  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, a);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  let biasedExp = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biasedExp === 0) biasedExp = 1; // subnormal
  else mantissa |= 1n << 52n;
  const e = biasedExp - 1075; // a === mantissa * 2^e, exactly

  const scale = 10n ** BigInt(nd);
  let num = mantissa * scale;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den = 1n << BigInt(-e);

  let q = num / den;
  const twiceRem = (num % den) * 2n;
  if (twiceRem > den || (twiceRem === den && (q & 1n) === 1n)) q += 1n;

  const out = Number(q) / Number(scale);
  return negative ? -out : out;
}

/** Tolerant numeric coercion. JS `+` would concatenate protobuf's string int64s. */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Python's "%g" / f"{x:g}" - 6 significant digits, trailing zeros stripped. */
function fmtG(value, precision = 6) {
  const x = Number(value);
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mant, expPart] = x.toExponential(precision - 1).split("e");
  const exp = parseInt(expPart, 10);
  if (exp < -4 || exp >= precision) {
    const sign = exp < 0 ? "-" : "+";
    return `${stripTrailingZeros(mant)}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return stripTrailingZeros(x.toFixed(Math.max(0, precision - 1 - exp)));
}

function stripTrailingZeros(s) {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Python's f"{x:.2f}". Safe here because every cost is already rounded to 2dp. */
function fmt2(x) {
  return num(x).toFixed(2);
}

// --- JEV `choice` scorer (port of evaluate_decision, choice branch) ----------

/**
 * Lexical choice scorer. Returns { verdict, probabilities, confidence,
 * abstain, latency_ms } - the same fields the JEV HTTP service returned.
 */
export function choice(question, choices, context = "", state = "") {
  const t0 = nowMs();
  const text = `${question ?? ""} ${context ?? ""} ${state ?? ""}`.toLowerCase();

  const list = choices || [];
  const scores = [];
  for (const c of list) {
    const cLower = String(c).toLowerCase();
    let matchScore = 1.0;
    if (text.includes(cLower)) matchScore += 3.0;
    for (const word of cLower.split(/\s+/)) {
      if (word !== "" && text.includes(word)) matchScore += 1.5;
    }
    scores.push(matchScore);
  }

  const expScores = scores.map((s) => Math.exp(s));
  const sumExp = expScores.reduce((a, b) => a + b, 0);

  // A Map mirrors Python's dict: duplicate choices collapse onto their first
  // position, and max() with ties picks the first key in insertion order.
  const probMap = new Map();
  for (let i = 0; i < list.length; i++) {
    probMap.set(String(list[i]), pyRound(expScores[i] / sumExp, 4));
  }

  let verdict = null;
  let best = -Infinity;
  for (const [key, p] of probMap) {
    if (p > best) {
      best = p;
      verdict = key;
    }
  }

  const confidence = verdict === null ? 0.0 : pyRound(best, 4);
  const probabilities = {};
  for (const [key, p] of probMap) probabilities[key] = p;

  return {
    id: undefined,
    type: "choice",
    verdict,
    probabilities,
    confidence,
    latency_ms: pyRound(nowMs() - t0, 2),
    abstain: list.length === 0 ? true : confidence < (1.0 / list.length + 0.05),
  };
}

// --- Match-type algebra (deterministic) --------------------------------------

const NON_ALNUM = /[^\p{L}\p{N}]/gu;

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(NON_ALNUM, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

/** Does this existing negative already block this search term? */
export function blocks(negativeText, matchType, term) {
  const negToks = tokens(negativeText);
  const termToks = tokens(term);
  if (negToks.length === 0) return false;

  const mt = String(matchType || "BROAD").toUpperCase();
  if (mt === "EXACT") {
    return negToks.length === termToks.length && negToks.every((t, i) => t === termToks[i]);
  }
  if (mt === "PHRASE") {
    const n = negToks.length;
    for (let i = 0; i <= termToks.length - n; i++) {
      let hit = true;
      for (let j = 0; j < n; j++) {
        if (termToks[i + j] !== negToks[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }
  // BROAD negatives block when every token is present, in any order.
  return negToks.every((t) => termToks.includes(t));
}

/** Negatives sharing at least one token with the term, best overlap first. */
function shortlist(term, negatives) {
  const termToks = new Set(tokens(term));
  const scored = [];
  for (const neg of negatives) {
    let overlap = 0;
    for (const t of new Set(tokens(neg.text))) if (termToks.has(t)) overlap++;
    if (overlap) scored.push({ overlap, neg });
  }
  scored.sort((a, b) => b.overlap - a.overlap); // stable, like Python's sort
  return scored.slice(0, MAX_CANDIDATES).map((s) => s.neg);
}

// --- Aggregation -------------------------------------------------------------

/** Collapse per-ad-group rows into one record per search term. */
function aggregate(searchTerms) {
  const buckets = new Map();
  for (const row of searchTerms || []) {
    if (!row) continue;
    const term = String(row.term || "").trim();
    if (!term) continue;

    let b = buckets.get(term);
    if (!b) {
      b = {
        term,
        impressions: 0, clicks: 0, cost: 0.0,
        conversions: 0.0, conv_value: 0.0,
        campaigns: new Map(), ad_groups: new Map(), statuses: new Set(),
      };
      buckets.set(term, b);
    }
    b.impressions += num(row.impressions);
    b.clicks += num(row.clicks);
    b.cost += num(row.cost);
    b.conversions += num(row.conversions);
    b.conv_value += num(row.conv_value);
    b.statuses.add(row.status ?? "NONE");
    if (row.campaign_id) {
      b.campaigns.set(row.campaign_id, row.campaign_name ?? "");
    }
    if (row.ad_group_id) {
      b.ad_groups.set(row.ad_group_id, {
        name: row.ad_group_name ?? "",
        campaign_id: row.campaign_id ?? "",
        campaign_name: row.campaign_name ?? "",
      });
    }
  }

  const out = [];
  for (const b of buckets.values()) {
    b.cost = pyRound(b.cost, 2);
    b.conversions = pyRound(b.conversions, 2);
    b.conv_value = pyRound(b.conv_value, 2);
    b.excluded = b.statuses.has("EXCLUDED");
    b.statuses = [...b.statuses].sort();
    out.push(b);
  }
  out.sort((a, b) => b.cost - a.cost); // stable, like Python's sort
  return out;
}

/** One flat list of every negative, tagged with where it lives. */
function flattenNegatives(negatives) {
  const n = negatives || {};
  const flat = [];
  for (const sl of n.shared_lists || []) {
    for (const kw of sl.keywords || []) {
      flat.push({
        text: kw.text, match_type: kw.match_type,
        level: "SHARED_LIST", container_id: sl.id,
        container_name: sl.name,
        scope_campaigns: (sl.applied_campaigns || []).map((c) => c.campaign_id),
      });
    }
  }
  for (const cn of n.campaign_negatives || []) {
    flat.push({
      text: cn.text, match_type: cn.match_type,
      level: "CAMPAIGN", container_id: cn.campaign_id,
      container_name: cn.campaign_name,
      scope_campaigns: [cn.campaign_id],
    });
  }
  for (const an of n.adgroup_negatives || []) {
    flat.push({
      text: an.text, match_type: an.match_type,
      level: "AD_GROUP", container_id: an.ad_group_id,
      container_name: an.ad_group_name,
      scope_campaigns: [an.campaign_id],
    });
  }
  return flat.filter((x) => x.text);
}

// --- Triage ------------------------------------------------------------------

/**
 * Classify each search term and recommend where its negative belongs.
 * @param {Array<object>} searchTerms per-ad-group search term rows
 * @param {object} negatives { shared_lists, campaign_negatives, adgroup_negatives }
 * @param {{minClicks?: number, minCost?: number}} [options]
 */
export function triage(searchTerms, negatives, { minClicks = 2, minCost = 0 } = {}) {
  const aggregated = aggregate(searchTerms);
  const flatNegs = flattenNegatives(negatives);

  // Pass 1 - deterministic coverage check against existing negatives.
  const coverage = new Map();
  for (const rec of aggregated) {
    let hit = null;
    for (const neg of flatNegs) {
      if (blocks(neg.text, neg.match_type, rec.term)) {
        // A negative only counts if it actually applies where the term ran.
        if (neg.scope_campaigns.length === 0
            || neg.scope_campaigns.some((c) => rec.campaigns.has(c))) {
          hit = neg;
          break;
        }
      }
    }
    coverage.set(rec.term, hit);
  }

  // Pass 2 - every scorer question, exactly the set Python would have batched.
  const questions = [];
  const qmap = new Map();
  for (let i = 0; i < aggregated.length; i++) {
    const rec = aggregated[i];
    if (coverage.get(rec.term)) continue; // already blocked; nothing to route

    const intentId = `i${i}`;
    questions.push({ id: intentId, type: "choice", question: rec.term, choices: ALL_TOKENS });
    qmap.set(intentId, ["intent", rec.term]);

    const near = shortlist(rec.term, flatNegs);
    if (near.length) {
      const nearId = `n${i}`;
      questions.push({
        id: nearId, type: "choice",
        question: rec.term, choices: near.map((x) => x.text),
      });
      qmap.set(nearId, ["near", rec.term]);
    }
  }

  let jevLatency = 0.0;
  const intentByTerm = new Map();
  const nearByTerm = new Map();
  for (const q of questions) {
    const res = choice(q.question, q.choices);
    res.id = q.id;
    jevLatency += res.latency_ms;
    const [kind, term] = qmap.get(q.id);
    (kind === "intent" ? intentByTerm : nearByTerm).set(term, res);
  }

  // Pass 3 - placement.
  const recommendations = aggregated.map((rec) => recommend(
    rec,
    coverage.get(rec.term),
    intentByTerm.get(rec.term),
    nearByTerm.get(rec.term),
    flatNegs,
    minClicks,
    minCost,
  ));

  const buckets = new Map();
  for (const r of recommendations) {
    if (!buckets.has(r.action)) buckets.set(r.action, []);
    buckets.get(r.action).push(r);
  }
  const byAction = {};
  for (const action of [...buckets.keys()].sort()) byAction[action] = buckets.get(action).length;

  const WASTE_ACTIONS = new Set([
    "ADD_TO_SHARED_LIST", "ADD_CAMPAIGN_NEGATIVE", "ADD_ADGROUP_NEGATIVE",
  ]);

  return {
    recommendations,
    summary: {
      terms_analysed: aggregated.length,
      jev_questions: questions.length,
      jev_latency_ms: pyRound(jevLatency, 2),
      by_action: byAction,
      wasted_spend: pyRound(
        recommendations.reduce((s, r) => (WASTE_ACTIONS.has(r.action) ? s + r.cost : s), 0), 2),
      leaking_spend: pyRound(
        recommendations.reduce((s, r) => (r.action === "TIGHTEN_EXISTING" ? s + r.cost : s), 0), 2),
    },
  };
}

/** First [key, value] of a Map, or [null, null] - never throws. */
function first(map) {
  for (const [k, v] of map) return [k, v];
  return [null, null];
}

/**
 * A negative we cannot address is not actionable, so send it to a human.
 *
 * search_term_view normally carries both IDs, but a row missing one would
 * otherwise yield a recommendation pointing at nothing.
 */
function unplaceable(base, rec, level) {
  base.action = "REVIEW";
  base.reason = `Looks like waste ($${fmt2(rec.cost)} over ${rec.clicks} click(s), no `
    + `conversions) but the report did not name the ${level} it ran in, so it `
    + `cannot be placed automatically.`;
  return base;
}

function recommend(rec, covered, intent, near, flatNegs, minClicks, minCost) {
  const term = rec.term;
  const base = {
    term,
    impressions: rec.impressions,
    clicks: rec.clicks,
    cost: rec.cost,
    conversions: rec.conversions,
    conv_value: rec.conv_value,
    campaigns: [...rec.campaigns].map(([id, name]) => ({ id, name })),
    ad_groups: [...rec.ad_groups].map(([id, v]) => ({ id, ...v })),
    excluded: rec.excluded,
    confidence: 0.0,
    jev_abstain: false,
    matched_negative: null,
    intent_group: null,
  };

  // Already blocked by an existing negative.
  if (covered) {
    base.matched_negative = {
      text: covered.text, match_type: covered.match_type,
      level: covered.level, container_name: covered.container_name,
    };
    // Still spending despite a matching negative means the negative is scoped
    // or match-typed too narrowly to catch this variant.
    if (rec.cost > 0 || rec.clicks > 0) {
      base.action = "TIGHTEN_EXISTING";
      base.reason = `Still spending despite ${covered.match_type} negative `
        + `"${covered.text}" on ${String(covered.level).replace(/_/g, " ").toLowerCase()} `
        + `"${covered.container_name}". Widen the match type or move it up a level.`;
      base.confidence = 1.0;
    } else {
      base.action = "ALREADY_COVERED";
      base.reason = `Blocked by existing negative "${covered.text}" (${covered.match_type}).`;
      base.confidence = 1.0;
    }
    return base;
  }

  // Converting terms are never negative candidates.
  if (rec.conversions > 0) {
    base.action = "PROMOTE";
    base.reason = `${fmtG(rec.conversions)} conversion(s) at $${fmt2(rec.cost)}. `
      + `Consider promoting to an exact-match keyword.`;
    base.confidence = 1.0;
    return base;
  }

  // Below the evidence floor - not enough data to act on yet.
  if (rec.clicks < minClicks && rec.cost <= minCost) {
    base.action = "INSUFFICIENT_DATA";
    base.reason = `Only ${rec.clicks} click(s) / $${fmt2(rec.cost)} spent. Not enough signal yet.`;
    base.confidence = 0.0;
    return base;
  }

  let intentGroup = null;
  if (intent && !intent.abstain) {
    intentGroup = TOKEN_GROUP.get(intent.verdict ?? "") ?? null;
    base.confidence = intent.confidence ?? 0.0;
  }
  base.intent_group = intentGroup;
  base.jev_abstain = Boolean(intent && intent.abstain);

  // Buyer vocabulary with spend but no conversion always needs a human - the
  // fix is usually the landing page, not an exclusion.
  if (BUYER_GROUPS.has(intentGroup)) {
    base.action = "REVIEW";
    base.reason = `Commercial intent ("${intent.verdict}") but ${rec.clicks} click(s) `
      + `and no conversions - check the landing page before excluding.`;
    return base;
  }

  const nCampaigns = rec.campaigns.size;
  const nAdGroups = rec.ad_groups.size;

  // No vocabulary matched. These are the account-specific terms a generic
  // lexicon cannot classify - competitor names, adjacent verticals - and they
  // are exactly what level-based placement is for. Excluding a term we could
  // not explain needs firmer evidence than one we could, so require clicks
  // well past the floor; below that a human should look.
  const unexplained = intentGroup === null;
  if (unexplained) {
    const floor = Math.max(minClicks, 1) * UNEXPLAINED_CLICK_MULTIPLIER;
    if (rec.clicks < floor) {
      base.action = "REVIEW";
      base.reason = `No waste or buyer vocabulary matched and only ${rec.clicks} click(s) `
        + `($${fmt2(rec.cost)}) - not enough to place it automatically.`;
      return base;
    }
  }

  const token = intent ? (intent.verdict ?? "") : "";
  const evidence = unexplained
    ? `No vocabulary matched, but $${fmt2(rec.cost)} over ${rec.clicks} click(s) `
      + `with no conversions.`
    : "";

  if (UNIVERSAL_WASTE.has(intentGroup)) {
    const target = bestSharedList(near, flatNegs);
    base.action = "ADD_TO_SHARED_LIST";
    base.suggested_keyword = token;
    base.suggested_match_type = "PHRASE";
    base.target = target;
    base.reason = `"${token}" is universal ${intentGroup} waste`
      + (nCampaigns > 1 ? ` and this term ran in ${nCampaigns} campaigns` : "")
      + `. $${fmt2(rec.cost)} spent, no conversions.`
      + (target ? ` Closest existing list: "${target.container_name}".`
                : ` No shared list matched - create one.`);
  } else if (nCampaigns > 1) {
    base.action = "ADD_TO_SHARED_LIST";
    base.suggested_keyword = term;
    base.suggested_match_type = "EXACT";
    base.target = bestSharedList(near, flatNegs);
    base.reason = (evidence ? `${evidence} ` : "")
      + `Ran in ${nCampaigns} campaigns - exclude once at account level `
      + `rather than repeating it per campaign.`;
  } else if (nAdGroups > 1) {
    const [cid, cname] = first(rec.campaigns);
    if (!cid) return unplaceable(base, rec, "campaign");
    base.action = "ADD_CAMPAIGN_NEGATIVE";
    base.suggested_keyword = term;
    base.suggested_match_type = "EXACT";
    base.target = { level: "CAMPAIGN", container_id: cid, container_name: cname };
    base.reason = (evidence ? `${evidence} ` : "")
      + `Confined to "${cname}" but spread across ${nAdGroups} ad groups - `
      + `exclude at campaign level so every ad group is covered.`;
  } else {
    let [agId, ag] = first(rec.ad_groups);
    if (!agId) return unplaceable(base, rec, "ad group");
    ag = ag || { name: "" };
    base.action = "ADD_ADGROUP_NEGATIVE";
    base.suggested_keyword = term;
    base.suggested_match_type = "EXACT";
    base.target = { level: "AD_GROUP", container_id: agId, container_name: ag.name };
    base.reason = (evidence ? `${evidence} ` : "")
      + `Isolated to "${ag.name}" - sculpt locally so other ad groups `
      + `keep this traffic.`;
  }

  return base;
}

/** Use the nearest-negative verdict to name the most likely destination list. */
function bestSharedList(near, flatNegs) {
  if (!near || near.abstain) return null;
  const verdict = near.verdict;
  for (const neg of flatNegs) {
    if (neg.text === verdict && neg.level === "SHARED_LIST") {
      return {
        level: "SHARED_LIST",
        container_id: neg.container_id,
        container_name: neg.container_name,
        because_of: verdict,
        confidence: near.confidence ?? 0.0,
      };
    }
  }
  return null;
}

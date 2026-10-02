# Roadmap

Tracked work, roughly in the order it's worth doing. Updated 2026-10-02.

---

## 1. Show the MCC hierarchy in the account picker

**Status:** not started · **Scope:** frontend-only · **Raised:** 2026-10-02, during first live sign-in

The account dropdown renders every account as a flat alphabetical list. On an MCC
with nested managers you can't tell which client sits under which manager, and
sibling accounts with similar names are hard to tell apart.

The backend already returns everything needed — no API work required.
`discover_accounts()` in `google_ads.py` fetches `customer_client.level` and
returns per account:

| Field | Use |
|---|---|
| `level` | depth below the login customer — drives indentation |
| `is_manager` | manager vs. client |
| `login_customer_id` | the manager this account authenticates through |
| `formatted_id` | `xxx-xxx-xxxx` for disambiguating similar names |

Current sort is `(is_manager, name)`, which deliberately flattens. The work:

- Build a parent→children tree from `login_customer_id`, ordered by `level`.
- Render nested: either indent with `level` inside `<optgroup>`s, or replace the
  `<select>` with a searchable tree-picker (better for large MCCs, more work).
- Keep managers selectable only if they can actually be queried — a manager
  account has no search terms of its own, so selecting one should either be
  blocked with an explanation or roll up its children.
- Preserve the flat list as a filter/search fallback, since on a big MCC typing
  a name beats navigating a tree.

**Open question:** on a deep MCC, does rolling a manager's children up into one
combined view make sense, or should it stay strictly one-account-at-a-time?

---

## 2. Apply recommendations back to Google Ads

**Status:** not started · **Scope:** backend + UI

Triage currently produces recommendations and a TSV export; every change is
applied by hand or through Google Ads Editor. The write path would use
`sharedCriterion:mutate`, `campaignCriteria:mutate` and
`adGroupCriteria:mutate` on v25.

Needs careful handling before it's safe:

- Per-row review and explicit opt-in — never bulk-apply a whole triage run.
- `validate_only: true` dry-run first, surfacing what would change.
- An undo path, since a wrongly-added negative silently kills traffic.
- Write scope on the OAuth token, and a confirmation that names the account.

---

## 3. Tune the intent lexicon per industry

**Status:** not started · **Scope:** `jev_triage.py` + config

`LEXICON` is generic (employment / informational / freebie / support /
commercial). Competitor terms are deliberately **not** hardcoded — excluding a
competitor's name is an account-specific judgment call.

Worth making per-account configurable and persisted, so the triage reflects the
vertical rather than a one-size default.

---

## 4. Decide what happens to the Cloudflare Worker

**Status:** blocked on a decision · **Scope:** `src/worker.js`

`src/worker.js` predates `/api/negatives` and `/api/triage`, and it cannot reach
the JEV engine on localhost — so it cannot do triage at all. It is stale.

Three options: expose JEV publicly and point the Worker at it; port the
heuristics into the Worker (they're pure string matching, so this is feasible);
or drop the Cloudflare path and keep this Pi-local.

---

## 5. Smaller items

- **Emoji font on the Pi.** No emoji font is installed (`fc-list` finds 0 of
  184), so icons render as missing-glyph boxes when browsing from the Pi
  itself. `sudo apt-get install -y fonts-noto-color-emoji`. Invisible when
  browsing from a laptop or phone.
- **Pagination beyond 10k rows.** `fetch_search_terms` caps at the
  searchStream page limit. Large accounts over a 90-day window will truncate;
  needs cursor paging.
- **Access token in `localStorage`.** Readable by any script on the page.
  Moving the session to an httpOnly cookie would be the stronger posture,
  and matters more if this ever leaves the Pi.
- **Shared lists attached to zero campaigns.** Already surfaced in the UI as a
  warning; could become an explicit triage finding, since those keywords block
  nothing at all.

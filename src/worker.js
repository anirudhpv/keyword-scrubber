export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const clientId = env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
    const devToken = env.GOOGLE_ADS_DEVELOPER_TOKEN;

    // 1. ROUTE: /api/auth/login
    if (path === "/api/auth/login") {
      if (!clientId) {
        return new Response(JSON.stringify({ error: "Missing GOOGLE_ADS_CLIENT_ID in environment variables." }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      const redirectUri = `${url.origin}/api/auth/callback`;
      const scope = encodeURIComponent("https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email");
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

      return Response.redirect(authUrl, 302);
    }

    // 2. ROUTE: /api/auth/callback
    if (path === "/api/auth/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`Google OAuth Error: ${error}`, { status: 400 });
      }
      if (!code) {
        return new Response("Missing authorization code from Google.", { status: 400 });
      }

      const redirectUri = `${url.origin}/api/auth/callback`;

      try {
        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code"
          })
        });

        const tokenData = await tokenResp.json();
        if (!tokenResp.ok || tokenData.error) {
          return new Response(`Token Exchange Failed: ${JSON.stringify(tokenData)}`, { status: 400 });
        }

        let userEmail = "Google Ads User";
        try {
          const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
          });
          const userData = await userResp.json();
          userEmail = userData.email || userEmail;
        } catch (e) {}

        const sessionPayload = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || '',
          email: userEmail,
          expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000)
        };

        const html = `
          <!DOCTYPE html>
          <html>
          <head><title>Authenticated</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #fbf9f5;">
            <h2>Authenticated as ${userEmail}</h2>
            <p>Loading your Google Ads accounts...</p>
            <script>
              localStorage.setItem('jev_ads_auth_session', JSON.stringify(${JSON.stringify(sessionPayload)}));
              window.location.href = '/';
            </script>
          </body>
          </html>
        `;

        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      } catch (err) {
        return new Response(`OAuth Execution Error: ${err.message}`, { status: 500 });
      }
    }

    // 3. ROUTE: /api/google-ads/accounts
    if (path === "/api/google-ads/accounts") {
      let body = {};
      try { body = await request.json(); } catch(e) {}
      const accessToken = body.access_token;

      if (!accessToken) {
        return new Response(JSON.stringify({ error: "Missing access_token" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }

      try {
        const headers = { "Authorization": `Bearer ${accessToken}` };
        if (devToken && devToken !== "DEVELOPER_TOKEN_DEPRECATED") {
          headers["developer-token"] = devToken;
        }

        const resp = await fetch("https://googleads.googleapis.com/v18/customers:listAccessibleCustomers", {
          method: "GET",
          headers
        });

        const data = await resp.json();
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: "Google Ads API list error", details: data }), { 
            status: resp.status, 
            headers: { "Content-Type": "application/json" } 
          });
        }

        const accounts = (data.resourceNames || []).map(rn => {
          const cid = rn.split("/")[1];
          const formattedCid = `${cid.slice(0,3)}-${cid.slice(3,6)}-${cid.slice(6)}`;
          return { 
            id: cid, 
            formatted_id: formattedCid,
            name: `Google Ads Account (${formattedCid})` 
          };
        });

        return new Response(JSON.stringify({ accounts }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // 4. ROUTE: /api/google-ads/study
    if (path === "/api/google-ads/study") {
      let body = {};
      try { body = await request.json(); } catch(e) {}
      const accessToken = body.access_token;
      const customerId = (body.customer_id || "").replace(/-/g, "").trim();
      const days = parseInt(body.days || "30");

      if (!accessToken || !customerId) {
        return new Response(JSON.stringify({ error: "Missing access_token or customer_id" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      const headers = {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      };
      if (devToken && devToken !== "DEVELOPER_TOKEN_DEPRECATED") {
        headers["developer-token"] = devToken;
      }
      if (body.login_customer_id) {
        headers["login-customer-id"] = body.login_customer_id.replace(/-/g, "").trim();
      }

      let lastApiError = null;

      const runGaql = async (query) => {
        try {
          const r = await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:searchStream`, {
            method: "POST",
            headers,
            body: JSON.stringify({ query })
          });
          const json = await r.json();
          if (!r.ok) {
            lastApiError = json;
            return [];
          }
          const rows = [];
          if (Array.isArray(json)) {
            for (const batch of json) {
              if (batch.results) rows.push(...batch.results);
            }
          }
          return rows;
        } catch (e) {
          lastApiError = { error: e.message };
          return [];
        }
      };

      try {
        const campRows = await runGaql(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`);
        
        if (campRows.length === 0 && lastApiError) {
          return new Response(JSON.stringify({ 
            error: "Google Ads API Permission / Query Error", 
            details: lastApiError,
            hint: "If this account is managed under an MCC, specify the Manager CID in login_customer_id." 
          }), { 
            status: 400, 
            headers: { "Content-Type": "application/json" } 
          });
        }

        const campaigns = campRows.map(r => ({
          id: String(r.campaign?.id || ""),
          name: r.campaign?.name || "Unnamed Campaign",
          status: r.campaign?.status || "ENABLED",
          type: r.campaign?.advertisingChannelType || "SEARCH",
          budget_daily: roundNumber((r.campaignBudget?.amountMicros || 0) / 1000000)
        }));

        const agRows = await runGaql(`SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name FROM ad_group WHERE ad_group.status != 'REMOVED' ORDER BY campaign.name, ad_group.name`);
        const ad_groups = agRows.map(r => ({
          id: String(r.adGroup?.id || ""),
          name: r.adGroup?.name || "Unnamed AdGroup",
          status: r.adGroup?.status || "ENABLED",
          campaign_id: String(r.campaign?.id || ""),
          campaign_name: r.campaign?.name || ""
        }));

        const sharedRows = await runGaql(`SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.member_count FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status != 'REMOVED'`);
        const shared_lists = sharedRows.map(r => ({
          id: String(r.sharedSet?.id || ""),
          name: r.sharedSet?.name || "Shared Negative List",
          member_count: r.sharedSet?.memberCount || 0,
          applied_campaigns: []
        }));

        const listMap = {};
        shared_lists.forEach(sl => { listMap[sl.id] = sl; });
        const cssRows = await runGaql(`SELECT campaign.id, campaign.name, shared_set.id, shared_set.name FROM campaign_shared_set WHERE campaign_shared_set.status = 'ENABLED'`);
        cssRows.forEach(r => {
          const sid = String(r.sharedSet?.id || "");
          if (listMap[sid]) {
            listMap[sid].applied_campaigns.push({
              campaign_id: String(r.campaign?.id || ""),
              campaign_name: r.campaign?.name || ""
            });
          }
        });

        const campNegRows = await runGaql(`SELECT campaign.id, campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED' LIMIT 300`);
        const campaign_negatives = campNegRows.map(r => ({
          campaign_id: String(r.campaign?.id || ""),
          campaign_name: r.campaign?.name || "",
          keyword: r.campaignCriterion?.keyword?.text || "",
          match_type: r.campaignCriterion?.keyword?.matchType || "BROAD"
        }));

        const agNegRows = await runGaql(`SELECT campaign.name, ad_group.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE AND ad_group_criterion.status != 'REMOVED' LIMIT 300`);
        const adgroup_negatives = agNegRows.map(r => ({
          campaign_name: r.campaign?.name || "",
          ad_group_id: String(r.adGroup?.id || ""),
          ad_group_name: r.adGroup?.name || "",
          keyword: r.adGroupCriterion?.keyword?.text || "",
          match_type: r.adGroupCriterion?.keyword?.matchType || "EXACT"
        }));

        const stRows = await runGaql(`SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_${days}_DAYS ORDER BY metrics.impressions DESC LIMIT 500`);
        const search_terms = stRows.map(r => ({
          search_term: r.searchTermView?.searchTerm || "",
          status: r.searchTermView?.status || "NONE",
          campaign: r.campaign?.name || "",
          ad_group: r.adGroup?.name || "",
          impressions: r.metrics?.impressions || 0,
          clicks: r.metrics?.clicks || 0,
          cost: roundNumber((r.metrics?.costMicros || 0) / 1000000),
          conversions: roundNumber(r.metrics?.conversions || 0)
        }));

        return new Response(JSON.stringify({
          data: {
            customer_id: customerId,
            campaigns,
            ad_groups,
            shared_lists,
            campaign_negatives,
            adgroup_negatives,
            search_terms
          }
        }), { headers: { "Content-Type": "application/json" } });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // 5. Default: Serve static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

function roundNumber(n) {
  return Math.round(n * 100) / 100;
}

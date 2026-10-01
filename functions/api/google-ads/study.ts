export async function onRequestPost(context: any) {
  const { env, request } = context;
  const devToken = env.GOOGLE_ADS_DEVELOPER_TOKEN;

  let body: any = {};
  try { body = await request.json(); } catch(e) {}
  const accessToken = body.access_token;
  const customerId = (body.customer_id || "").replace(/-/g, "").trim();
  const managerId = (body.manager_id || "").replace(/-/g, "").trim();
  const days = parseInt(body.days || "30");

  if (!accessToken || !customerId) {
    return new Response(JSON.stringify({ error: "Missing access_token or customer_id" }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };

  if (devToken && devToken !== "DEVELOPER_TOKEN_DEPRECATED") {
    headers["developer-token"] = devToken;
  }
  
  // Attach login-customer-id if managing under an MCC
  if (managerId && managerId !== customerId) {
    headers["login-customer-id"] = managerId;
  } else if (body.login_customer_id) {
    headers["login-customer-id"] = body.login_customer_id.replace(/-/g, "").trim();
  }

  let lastApiError: any = null;

  const roundNumber = (val: number) => Math.round(val * 100) / 100;

  const runGaql = async (query: string) => {
    try {
      const r = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:searchStream`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query })
      });
      const json: any = await r.json();
      if (!r.ok) {
        lastApiError = json;
        return [];
      }
      const rows: any[] = [];
      if (Array.isArray(json)) {
        for (const batch of json) {
          if (batch.results) rows.push(...batch.results);
        }
      }
      return rows;
    } catch (e: any) {
      lastApiError = { error: e.message };
      return [];
    }
  };

  try {
    const campRows = await runGaql(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`);
    
    if (campRows.length === 0 && lastApiError) {
      return new Response(JSON.stringify({ 
        error: "Google Ads API Permission / Query Error", 
        details: lastApiError 
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
      applied_campaigns: [] as any[]
    }));

    const listMap: Record<string, any> = {};
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

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

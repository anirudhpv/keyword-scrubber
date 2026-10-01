export async function onRequestPost(context: any) {
  const { env, request } = context;
  const devToken = env.GOOGLE_ADS_DEVELOPER_TOKEN;

  let body: any = {};
  try { body = await request.json(); } catch(e) {}
  const accessToken = body.access_token;

  if (!accessToken) {
    return new Response(JSON.stringify({ error: "Missing access_token" }), { 
      status: 401, 
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

  try {
    // Step 1: List top-level accessible customers using Google Ads API v25
    const listResp = await fetch("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers", {
      method: "GET",
      headers
    });

    const listData: any = await listResp.json();
    if (!listResp.ok) {
      return new Response(JSON.stringify({ error: "Failed to list accessible customers", details: listData }), { 
        status: listResp.status, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const topLevelCids = (listData.resourceNames || []).map((rn: string) => rn.split("/")[1]);
    const allDiscoveredAccounts: any[] = [];
    const seenCids = new Set<string>();

    // Step 2: For each top-level customer, query customer_client hierarchy
    for (const topCid of topLevelCids) {
      try {
        const query = `
          SELECT
            customer_client.client_customer,
            customer_client.id,
            customer_client.descriptive_name,
            customer_client.currency_code,
            customer_client.time_zone,
            customer_client.manager,
            customer_client.status,
            customer_client.level
          FROM customer_client
          WHERE customer_client.status = 'ENABLED'
        `;

        const streamHeaders: Record<string, string> = { ...headers, "login-customer-id": topCid };
        const streamResp = await fetch(`https://googleads.googleapis.com/v25/customers/${topCid}/googleAds:searchStream`, {
          method: "POST",
          headers: streamHeaders,
          body: JSON.stringify({ query })
        });

        if (streamResp.ok) {
          const streamData: any = await streamResp.json();
          for (const batch of streamData) {
            if (batch.results) {
              for (const row of batch.results) {
                const cc = row.customerClient;
                if (cc && !seenCids.has(String(cc.id))) {
                  seenCids.add(String(cc.id));
                  const cidStr = String(cc.id);
                  const formattedCid = `${cidStr.slice(0,3)}-${cidStr.slice(3,6)}-${cidStr.slice(6)}`;
                  const isManager = Boolean(cc.manager);

                  allDiscoveredAccounts.push({
                    id: cidStr,
                    formatted_id: formattedCid,
                    name: cc.descriptiveName ? `${cc.descriptiveName} (${formattedCid})` : `Account (${formattedCid})`,
                    raw_name: cc.descriptiveName || `Account ${formattedCid}`,
                    is_manager: isManager,
                    manager_id: isManager ? cidStr : topCid,
                    currency: cc.currencyCode || "USD",
                    level: cc.level || 0
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn(`Error crawling customer_client for ${topCid}:`, err);
      }

      // Fallback if topCid was not returned in customer_client stream
      if (!seenCids.has(topCid)) {
        seenCids.add(topCid);
        const formattedCid = `${topCid.slice(0,3)}-${topCid.slice(3,6)}-${topCid.slice(6)}`;
        allDiscoveredAccounts.push({
          id: topCid,
          formatted_id: formattedCid,
          name: `Account (${formattedCid})`,
          raw_name: `Account ${formattedCid}`,
          is_manager: false,
          manager_id: topCid,
          currency: "USD",
          level: 0
        });
      }
    }

    // Sort: Client accounts first, then managers
    allDiscoveredAccounts.sort((a, b) => {
      if (a.is_manager === b.is_manager) return a.name.localeCompare(b.name);
      return a.is_manager ? 1 : -1;
    });

    return new Response(JSON.stringify({ accounts: allDiscoveredAccounts }), { 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

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
        return new Response(JSON.stringify({ error: "Missing GOOGLE_ADS_CLIENT_ID." }), {
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
        return new Response(JSON.stringify({ error: "Missing access_token" }), { 
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const headers = {
          "Authorization": `Bearer ${accessToken}`
        };
        if (devToken) {
          headers["developer-token"] = devToken;
        }

        const resp = await fetch("https://googleads.googleapis.com/v18/customers:listAccessibleCustomers", {
          method: "GET",
          headers
        });

        const text = await resp.text();
        let data = {};
        try { data = JSON.parse(text); } catch(e) {
          return new Response(JSON.stringify({ error: "Google API response parse error", raw: text }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (!resp.ok) {
          return new Response(JSON.stringify({ error: "Google Ads API error", details: data }), { 
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

        return new Response(JSON.stringify({ accounts }), { 
          headers: { "Content-Type": "application/json" } 
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        });
      }
    }

    // 4. Default: Serve static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

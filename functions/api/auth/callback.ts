export async function onRequestGet(context: any) {
  const { env, request } = context;
  const clientId = env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth Error from Google: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing authorization code from Google redirect.", { status: 400 });
  }

  const redirectUri = `${url.origin}/api/auth/callback`;

  // Exchange code for token
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

  const tokenData: any = await tokenResp.json();

  if (!tokenResp.ok || tokenData.error) {
    return new Response(`Token Exchange Failed: ${JSON.stringify(tokenData)}`, { status: 400 });
  }

  // Extract user info from id_token and userinfo API
  let userEmail = "";
  let userName = "";
  let userPicture = "";

  if (tokenData.id_token) {
    try {
      const payloadBase64 = tokenData.id_token.split(".")[1];
      const decodedPayload = JSON.parse(atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/")));
      userEmail = decodedPayload.email || "";
      userName = decodedPayload.name || "";
      userPicture = decodedPayload.picture || "";
    } catch (e) {}
  }

  if (!userEmail) {
    try {
      const userResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userData: any = await userResp.json();
      userEmail = userData.email || "";
      userName = userData.name || userName;
      userPicture = userData.picture || userPicture;
    } catch (e) {}
  }

  const finalDisplay = userEmail ? (userName ? `${userName} (${userEmail})` : userEmail) : "Google Ads User";

  const sessionPayload = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || "",
    email: userEmail || finalDisplay,
    name: userName,
    display: finalDisplay,
    picture: userPicture,
    expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000)
  };

  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Authenticated</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #fbf9f5;">
      <h2>Authenticated as ${finalDisplay}</h2>
      <p>Loading your Google Ads accounts & MCC hierarchy...</p>
      <script>
        localStorage.setItem('jev_ads_auth_session', JSON.stringify(${JSON.stringify(sessionPayload)}));
        window.location.href = '/';
      </script>
    </body>
    </html>
  `;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

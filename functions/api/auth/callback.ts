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

  // Get user info
  let userEmail = "Google User";
  try {
    const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData: any = await userResp.json();
    userEmail = userData.email || userEmail;
  } catch (e) {}

  // Return HTML script that stores token in localStorage and redirects to dashboard
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Authenticating...</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #fbf9f5;">
      <h2>Authenticated as ${userEmail}</h2>
      <p>Saving session and loading your Google Ads accounts...</p>
      <script>
        localStorage.setItem('***', JSON.stringify({
          access_token: ${JSON.stringify(tokenData.access_token)},
          refresh_token: ${JSON.stringify(tokenData.refresh_token || '')},
          email: ${JSON.stringify(userEmail)},
          expires_at: Date.now() + (${tokenData.expires_in || 3600} * 1000)
        }));
        window.location.href = '/';
      </script>
    </body>
    </html>
  `;

  return new Response(html, {
    headers: { "Content-Type": "text/html" }
  });
}

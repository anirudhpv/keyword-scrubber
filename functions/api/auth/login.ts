export async function onRequestGet(context: any) {
  const { env, request } = context;
  const clientId = env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  
  if (!clientId) {
    return new Response(JSON.stringify({ error: "Missing GOOGLE_ADS_CLIENT_ID in Cloudflare environment variables." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/callback`;
  const scope = encodeURIComponent("https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email");
  
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

  return Response.redirect(authUrl, 302);
}

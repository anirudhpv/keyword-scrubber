export async function onRequestPost(context: any) {
  const { env, request } = context;
  const devToken = env.GOOGLE_ADS_DEVELOPER_TOKEN || "DEVELOPER_TOKEN_DEPRECATED";
  
  let body: any = {};
  try { body = await request.json(); } catch(e) {}
  const accessToken = body.access_token;

  if (!accessToken) {
    return new Response(JSON.stringify({ error: "Unauthorized: Missing access_token" }), { status: 401 });
  }

  try {
    const resp = await fetch("https://googleads.googleapis.com/v18/customers:listAccessibleCustomers", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": devToken
      }
    });

    const data: any = await resp.json();
    if (!resp.ok) {
      return new Response(JSON.stringify(data), { status: resp.status });
    }

    const accounts = (data.resourceNames || []).map((rn: string) => {
      const cid = rn.split("/")[1];
      return {
        id: cid,
        name: `Account (${cid})`,
        resource_name: rn
      };
    });

    return new Response(JSON.stringify({ accounts }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

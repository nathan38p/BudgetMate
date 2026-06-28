import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getPowensDomain() {
  const rawDomain = Deno.env.get("POWENS_DOMAIN") || "";
  return rawDomain
    .replace(/^https?:\/\//, "")
    .replace(/\.biapi\.pro\/?$/, "")
    .replace(/\/$/, "")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUserClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") || "",
        },
      },
    },
  );

  const {
    data: { user },
    error: userError,
  } = await supabaseUserClient.auth.getUser();

  if (userError || !user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const clientId = Deno.env.get("POWENS_CLIENT_ID");
  const clientSecret = Deno.env.get("POWENS_CLIENT_SECRET");
  const domain = getPowensDomain();

  if (!clientId || !clientSecret || !domain) {
    return jsonResponse(
      {
        error: "Secrets Powens manquants.",
        details: "Ajoute POWENS_CLIENT_ID, POWENS_CLIENT_SECRET et POWENS_DOMAIN dans Supabase Edge Functions Secrets.",
      },
      500,
    );
  }

  const body = await req.json().catch(() => ({}));
  const redirectUrl = body.redirect_url || `${new URL(req.url).origin}${new URL(req.url).pathname}`;

  const existingToken = await supabaseAdmin
    .from("powens_users")
    .select("access_token, powens_user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingToken.error) {
    return jsonResponse(
      {
        error: "Impossible de lire la table powens_users.",
        details: existingToken.error.message,
      },
      500,
    );
  }

  let accessToken = existingToken.data?.access_token || null;
  let powensUserId = existingToken.data?.powens_user_id || null;

  if (!accessToken) {
    const initResponse = await fetch(`https://${domain}.biapi.pro/2.0/auth/init`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const initData = await initResponse.json().catch(() => ({}));

    if (!initResponse.ok) {
      return jsonResponse(
        {
          error: "Erreur Powens pendant auth/init.",
          status: initResponse.status,
          details: initData,
        },
        initResponse.status,
      );
    }

    accessToken = initData.auth_token || null;
    powensUserId = initData.id_user || initData.user?.id || null;

    if (!accessToken) {
      return jsonResponse(
        {
          error: "Powens n'a pas renvoyé de auth_token.",
          details: initData,
        },
        500,
      );
    }

    const { error: upsertError } = await supabaseAdmin.from("powens_users").upsert({
      user_id: user.id,
      access_token: accessToken,
      powens_user_id: powensUserId,
      updated_at: new Date().toISOString(),
    });

    if (upsertError) {
      return jsonResponse(
        {
          error: "Impossible d'enregistrer le token Powens dans powens_users.",
          details: upsertError.message,
        },
        500,
      );
    }
  }

  const codeResponse = await fetch(`https://${domain}.biapi.pro/2.0/auth/token/code?type=singleAccess`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  const codeData = await codeResponse.json().catch(() => ({}));

  if (!codeResponse.ok) {
    return jsonResponse(
      {
        error: "Erreur Powens pendant auth/token/code.",
        status: codeResponse.status,
        details: codeData,
      },
      codeResponse.status,
    );
  }

  const temporaryCode = codeData.code;

  if (!temporaryCode) {
    return jsonResponse(
      {
        error: "Powens n'a pas renvoyé de code temporaire.",
        details: codeData,
      },
      500,
    );
  }

  const webviewUrl = new URL("https://webview.powens.com/connect");
  webviewUrl.searchParams.set("domain", domain);
  webviewUrl.searchParams.set("client_id", clientId);
  webviewUrl.searchParams.set("redirect_uri", redirectUrl);
  webviewUrl.searchParams.set("code", temporaryCode);
  webviewUrl.searchParams.set("state", user.id);

  return jsonResponse({
    url: webviewUrl.toString(),
  });
});

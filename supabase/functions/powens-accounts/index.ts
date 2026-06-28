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

  const domain = getPowensDomain();

  if (!domain) {
    return jsonResponse({ error: "Secret Powens manquant : POWENS_DOMAIN." }, 500);
  }

  const existingToken = await supabaseAdmin
    .from("powens_users")
    .select("access_token")
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

  const accessToken = existingToken.data?.access_token;

  if (!accessToken) {
    return jsonResponse({ accounts: [], message: "Aucun compte Powens connecté." });
  }

  const accountsResponse = await fetch(`https://${domain}.biapi.pro/2.0/users/me/accounts?all`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  const accountsData = await accountsResponse.json().catch(() => ({}));

  if (!accountsResponse.ok) {
    return jsonResponse(
      {
        error: "Erreur Powens pendant la récupération des comptes.",
        status: accountsResponse.status,
        details: accountsData,
      },
      accountsResponse.status,
    );
  }

  const rawAccounts = Array.isArray(accountsData)
    ? accountsData
    : Array.isArray(accountsData.accounts)
      ? accountsData.accounts
      : Array.isArray(accountsData.results)
        ? accountsData.results
        : Array.isArray(accountsData.data)
          ? accountsData.data
          : [];

  const accounts = rawAccounts.map((account: Record<string, unknown>) => {
    const connection = account.connection as Record<string, unknown> | undefined;
    const connector = connection?.connector as Record<string, unknown> | undefined;

    return {
      id: account.id,
      name: account.name || account.original_name || account.label || "Compte bancaire",
      bank_name: account.bank_name || account.connector_name || connector?.name || "Banque",
      type: account.type || account.usage || null,
      balance: account.balance ?? account.coming_balance ?? 0,
      currency: account.currency || "EUR",
      disabled: account.disabled || false,
      last_update: account.last_update || account.updated_at || null,
    };
  });

  return jsonResponse({ accounts, raw_count: rawAccounts.length });
});

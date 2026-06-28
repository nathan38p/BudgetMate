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
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
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

function normalizeAccounts(rawAccounts: unknown[], ownerUserId: string, typeByAccountId: Record<string, string>) {
  return rawAccounts.map((account: Record<string, unknown>) => {
    const connection = account.connection as Record<string, unknown> | undefined;
    const connector = connection?.connector as Record<string, unknown> | undefined;
    const accountId = String(account.id);

    return {
      id: accountId,
      owner_user_id: ownerUserId,
      account_kind: typeByAccountId[accountId] || "current",
      name: account.name || account.original_name || account.label || "Compte bancaire",
      bank_name: account.bank_name || account.connector_name || connector?.name || "Banque",
      type: account.type || account.usage || null,
      balance: account.balance ?? account.coming_balance ?? 0,
      currency: account.currency || "EUR",
      disabled: account.disabled || false,
      last_update: account.last_update || account.updated_at || null,
    };
  });
}

async function fetchPowensRawAccounts(domain: string, accessToken: string) {
  const accountsResponse = await fetch(`https://${domain}.biapi.pro/2.0/users/me/accounts?all`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  const accountsData = await accountsResponse.json().catch(() => ({}));

  if (!accountsResponse.ok) {
    throw {
      status: accountsResponse.status,
      body: accountsData,
    };
  }

  return Array.isArray(accountsData)
    ? accountsData
    : Array.isArray(accountsData.accounts)
      ? accountsData.accounts
      : Array.isArray(accountsData.results)
        ? accountsData.results
        : Array.isArray(accountsData.data)
          ? accountsData.data
          : [];
}

function extractConnectionIdsFromAccounts(rawAccounts: unknown[]) {
  return [...new Set(rawAccounts
    .map((account) => {
      const row = account as Record<string, unknown>;
      return row.id_connection || row.connection_id || row.id_parent || null;
    })
    .filter(Boolean)
    .map(String))];
}

async function fetchPowensConnectionIds(domain: string, accessToken: string) {
  const response = await fetch(`https://${domain}.biapi.pro/2.0/users/me/connections`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return [];
  }

  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body.connections)
      ? body.connections
      : Array.isArray(body.results)
        ? body.results
        : Array.isArray(body.data)
          ? body.data
          : [];

  return [...new Set(rows
    .map((connection: Record<string, unknown>) => connection.id)
    .filter(Boolean)
    .map(String))];
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryRefreshPowensConnections(domain: string, accessToken: string, rawAccounts: unknown[]) {
  const connectionIdsFromConnections = await fetchPowensConnectionIds(domain, accessToken);
  const connectionIdsFromAccounts = extractConnectionIdsFromAccounts(rawAccounts);
  const connectionIds = [...new Set([...connectionIdsFromConnections, ...connectionIdsFromAccounts])];

  const attempts = [];

  for (const connectionId of connectionIds) {
    const endpoints = [
      `https://${domain}.biapi.pro/2.0/users/me/connections/${connectionId}/sync`,
      `https://${domain}.biapi.pro/2.0/users/me/connections/${connectionId}/refresh`,
      `https://${domain}.biapi.pro/2.0/users/me/connections/${connectionId}/update`,
    ];

    for (const url of endpoints) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      }).catch((error) => ({
        ok: false,
        status: 0,
        json: async () => ({ message: String(error) }),
      }));

      const body = await response.json().catch(() => ({}));

      attempts.push({
        connection_id: connectionId,
        endpoint: url.split("/2.0/")[1],
        status: response.status,
        ok: response.ok,
        body,
      });

      if (response.ok) {
        break;
      }
    }
  }

  if (attempts.some((attempt) => attempt.ok)) {
    await sleep(2500);
  }

  return attempts;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestBody = await req.json().catch(() => ({}));
  const forceRefresh = Boolean(requestBody.force_refresh);

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

  const { data: mateRows, error: matesError } = await supabaseAdmin
    .from("mates")
    .select("owner_id, mate_id")
    .or(`owner_id.eq.${user.id},mate_id.eq.${user.id}`);

  if (matesError) {
    return jsonResponse({ error: "Impossible de lire la table mates.", details: matesError.message }, 500);
  }

  const mateUserIds = [...new Set((mateRows || []).map((row) => row.owner_id === user.id ? row.mate_id : row.owner_id))];
  const userIdsToRead = [user.id, ...mateUserIds];

  const { data: powensRows, error: powensRowsError } = await supabaseAdmin
    .from("powens_users")
    .select("user_id, access_token")
    .in("user_id", userIdsToRead);

  if (powensRowsError) {
    return jsonResponse({ error: "Impossible de lire la table powens_users.", details: powensRowsError.message }, 500);
  }

  if (!powensRows?.length) {
    return jsonResponse({ accounts: [], message: "Aucun compte Powens connecté." });
  }

  const { data: accountSettingsRows, error: accountSettingsError } = await supabaseAdmin
    .from("bank_account_settings")
    .select("user_id, powens_account_id, account_kind")
    .in("user_id", userIdsToRead);

  if (accountSettingsError) {
    return jsonResponse({ error: "Impossible de lire la table bank_account_settings.", details: accountSettingsError.message }, 500);
  }

  const typeByUserAndAccount: Record<string, Record<string, string>> = {};
  (accountSettingsRows || []).forEach((row) => {
    if (!typeByUserAndAccount[row.user_id]) {
      typeByUserAndAccount[row.user_id] = {};
    }
    typeByUserAndAccount[row.user_id][row.powens_account_id] = row.account_kind;
  });

  const allAccounts = [];
  const refreshAttempts = [];
  let rawCount = 0;

  for (const powensRow of powensRows) {
    try {
      let rawAccounts = await fetchPowensRawAccounts(domain, powensRow.access_token);

      if (forceRefresh && powensRow.user_id === user.id) {
        const attempts = await tryRefreshPowensConnections(domain, powensRow.access_token, rawAccounts);
        refreshAttempts.push(...attempts);
        rawAccounts = await fetchPowensRawAccounts(domain, powensRow.access_token);
      }

      rawCount += rawAccounts.length;

      const normalizedAccounts = normalizeAccounts(
        rawAccounts,
        powensRow.user_id,
        typeByUserAndAccount[powensRow.user_id] || {},
      );

      const visibleAccounts = normalizedAccounts.filter((account) => {
        if (account.owner_user_id === user.id) return true;
        return account.account_kind === "shared";
      });

      allAccounts.push(...visibleAccounts);
    } catch (error) {
      if (powensRow.user_id === user.id) {
        return jsonResponse(
          {
            error: "Erreur Powens pendant la récupération des comptes.",
            status: error.status || 500,
            details: error.body || error,
          },
          error.status || 500,
        );
      }
    }
  }

  return jsonResponse({
    accounts: allAccounts,
    raw_count: rawCount,
    refresh_requested: forceRefresh,
    refresh_attempts: refreshAttempts,
  });
});

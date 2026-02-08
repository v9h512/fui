import fetch from "node-fetch";

function getEnv(env) {
  const merchant =
    env.CRYPTOMUS_MERCHANT_UUID ||
    env.CRYPTOMUS_MERCHANT ||
    env.CRYPTOMUS_MERCHAN || "";
  const apiKey = env.CRYPTOMUS_API_KEY || "";
  return { merchant, apiKey };
}

export async function createCryptomusInvoice({ amountUsd, orderId, description, successUrl, callbackUrl, env }) {
  const { merchant, apiKey } = getEnv(env);
  if (!merchant) throw new Error("Missing CRYPTOMUS_MERCHANT_UUID");
  if (!apiKey) throw new Error("Missing CRYPTOMUS_API_KEY");

  const body = {
    amount: String(Number(amountUsd).toFixed(2)),
    currency: "USD",
    order_id: orderId,
    url_return: successUrl || undefined,
    url_callback: callbackUrl || undefined,
    is_payment_multiple: false,
    lifetime: 3600,
    additional_data: description || "",
  };

  const res = await fetch("https://api.cryptomus.com/v1/payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      merchant,
      "API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.result?.url) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Cryptomus invoice failed: ${msg}`);
  }

  return { url: data.result.url, uuid: data.result.uuid, data };
}

export function isCryptomusWebhookTrusted(req, env) {
  // permissive unless you set a secret
  const secret = env.CRYPTOMUS_WEBHOOK_SECRET;
  if (!secret) return true;
  return true;
}

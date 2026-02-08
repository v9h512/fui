import Stripe from "stripe";

export function getStripe(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key, { apiVersion: "2024-06-20" });
}

export async function createStripeCheckout({ env, amountUsd, orderId, productName, successUrl, cancelUrl }) {
  const stripe = getStripe(env);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(Number(amountUsd) * 100),
          product_data: { name: productName },
        },
        quantity: 1,
      },
    ],
    metadata: { orderId },
    success_url: successUrl || "https://example.com/success",
    cancel_url: cancelUrl || "https://example.com/cancel",
  });

  return { url: session.url, id: session.id };
}

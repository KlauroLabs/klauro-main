import Stripe from "stripe";
import { PostHog } from "posthog-node";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
const posthog = new PostHog(process.env.POSTHOG_KEY ?? "");

export async function charge(customer: string, amount: number) {
  const intent = await stripe.paymentIntents.create({ customer, amount, currency: "usd" });
  posthog.capture({ distinctId: customer, event: "charged" });
  return intent;
}

export async function expireSubscription(id: string) {
  return stripe.subscriptions.expire(id);
}

export async function rate(currency: string) {
  const response = await fetch("https://api.acme-rates.io/v2/latest?base=" + currency);
  return response.json();
}

export function helpLink() {
  return new URL("https://discord.com/");
}

export const dsn = process.env.SENTRY_DSN;

// Retiring an account's custom video domains when its plan loses them (Pro or Teams -> Free, a subscription
// that ends): the hostname 301s to our own host for 30 days, then the cron deletes it. The one
// implementation lives in custom-domains.ts (it also re-points the account's older redirecting hostnames at
// our own host); stripe.ts imports it from here. Branding rows stay: they render only on a custom domain.
export { retireAccountDomains } from "./custom-domains";

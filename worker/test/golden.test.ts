// Golden outputs of a hosted-shaped deployment (billing on, BRAND_NAME "Recitbot", operator vars, email, Turnstile keys),
// recorded at 507ad36 into golden/507ad36.json: pages, emails and model-facing text must stay byte-identical for it.
// Only per-run values are replaced (tokens, asset hash, sign-in ids: outputs.ts norm). To record a new baseline on
// purpose, replace the fixture's content with {} and run this file once.
import { expect, it } from "vitest";
import { collect } from "./outputs";

const FIXTURE = import.meta.glob("./golden/*.json", { query: "?raw", import: "default", eager: true });
const GOLDEN = JSON.parse(FIXTURE["./golden/507ad36.json"] ?? "{}") as Record<string, string>;

it("every output is byte-identical to the recorded baseline", { timeout: 120_000 }, async () => {
  const out = await collect({ BRAND_NAME: "Recitbot", STRIPE_STORAGE_ADDON_PRICE_ID: "price_PLACEHOLDER_STORAGE" });
  if (!Object.keys(GOLDEN).length) {
    await expect(`${JSON.stringify(out, null, 1)}
`).toMatchFileSnapshot("./golden/507ad36.json");
    throw new Error("golden baseline recorded: run again");
  }
  expect(Object.keys(out).sort()).toEqual(Object.keys(GOLDEN).sort());
  for (const [name, text] of Object.entries(out)) expect(text, name).toBe(GOLDEN[name]);
});

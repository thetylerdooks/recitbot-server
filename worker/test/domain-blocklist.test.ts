import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cfDeps } from "../src/cf-saas";
import { needsReviewMessage } from "../src/custom-domains";
import { hostnameBlockedReason, punycodeDecode } from "../src/domain-blocklist";
import { mcp, seedAccount, withEnv } from "./helpers";

/** The stored form of a name typed in Unicode (URL does the IDNA mapping, as validateHostname does). */
const ascii = (h: string) => new URL(`https://${h}`).hostname;

describe("hostnameBlockedReason: needs review", () => {
  const blocked: [string, RegExp][] = [
    // Brand / payment / auth names, anywhere in a label
    ["videos.paypal-help.com", /paypal/],
    ["paypal.example.com", /paypal/],
    ["videos.mypaypal.com", /paypal/],
    ["pay-pal.example.com", /paypal/],
    ["videos.paypal.com", /paypal/],
    ["VIDEOS.PAYPAL.COM", /paypal/],
    ["login.example.com", /login/],
    ["secure-login.example.com", /login/],
    ["videos.google-drive.com", /google/],
    ["gmail-team.example.com", /gmail/],
    ["videos.icloud-share.com", /icloud/],
    ["microsoft-teams.example.com", /microsoft/],
    ["outlook.example.com", /outlook/],
    ["videos.office365.example.com", /office365/],
    ["amazon-orders.example.com", /amazon/],
    ["netflix.example.com", /netflix/],
    ["facebook-video.example.com", /facebook/],
    ["insta.instagram-help.com", /instagram/],
    ["whatsapp.example.com", /whatsapp/],
    ["coinbase.example.com", /coinbase/],
    ["videos.binance-pro.com", /binance/],
    ["metamask-wallet.example.com", /metamask/],
    ["online-banking.example.com", /banking/],
    ["wells-fargo.example.com", /wellsfargo/],
    ["citibank.example.com", /citibank/],
    ["hsbc-uk.example.com", /hsbc/],
    ["scotiabank.example.com", /scotiabank/],
    ["mastercard.example.com", /mastercard/],
    ["cra-arc.example.com", /craarc/],
    ["helpdesk.example.com", /helpdesk/],
    ["recitbot-videos.example.com", /recitbot/],
    ["videos.recitbot.co", /recitbot/],
    // Whole words only
    ["stripe.example.com", /stripe/],
    ["stripe-billing.example.com", /stripe/],
    ["apple.example.com", /apple/],
    ["aws.example.com", /aws/],
    ["meta.example.com", /meta/],
    ["my-bank.example.com", /bank/],
    ["chase.example.com", /chase/],
    ["td.example.com", /td/],
    ["td-bank.example.com", /td|bank/],
    ["videos.rbc.com", /rbc/],
    ["bmo.example.com", /bmo/],
    ["cibc.example.com", /cibc/],
    ["interac.example.com", /interac/],
    ["visa.example.com", /visa/],
    ["amex.example.com", /amex/],
    ["irs.example.com", /irs/],
    ["gov.example.com", /gov/],
    ["sign-in.example.com", /signin/],
    ["signin.example.com", /signin/],
    ["account.example.com", /account/],
    ["my-account.example.com", /account/],
    ["accounts.example.com", /accounts/],
    // Word starts
    ["verify.example.com", /verif/],
    ["verification.example.com", /verif/],
    ["secure.example.com", /secure/],
    ["securemail.example.com", /secure/],
    ["wallet.example.com", /wallet/],
    ["walletconnect.example.com", /wallet/],
    // support-*
    ["support-billing.example.com", /help desk/],
    // Homoglyph folds
    ["paypa1.example.com", /looks like "paypal"/],
    ["g00gle.example.com", /looks like "google"/],
    ["arnazon.example.com", /looks like "amazon"/],
    ["rnicrosoft.example.com", /looks like "microsoft"/],
    ["vvhatsapp.example.com", /looks like "whatsapp"/],
    ["5ecure.example.com", /looks like "secure"/],
    ["l0gin.example.com", /looks like "login"/],
    ["rec1tbot.example.com", /looks like "recitbot"/],
    ["c1t1bank.example.com", /looks like "citibank"/],
    ["app1e.example.com", /looks like "apple"/],
    ["v1sa.example.com", /looks like "visa"/],
    ["n3tflix.example.com", /looks like "netflix"/],
    // Registrable domain checked too
    ["videos.paypal-secure.net", /paypal/],
    ["videos.gov-portal.co.uk", /gov/],
  ];
  it.each(blocked)("%s", (h, why) => {
    const r = hostnameBlockedReason(h.toLowerCase());
    expect(r).not.toBeNull();
    expect(r).toMatch(why);
  });

  const idn: [string, RegExp][] = [
    // Cyrillic а in a Latin name: mixed scripts
    ["pаypal.example.com", /mixes Cyrillic and Latin/],
    ["videos.pаypal.com", /mixes Cyrillic and Latin/],
    ["gооgle.example.com", /mixes Cyrillic and Latin/],
    // Greek ρ
    ["ρaypal.example.com", /mixes Greek and Latin/],
    // Wholly Cyrillic look-alikes of Latin letters
    ["аррӏе.example.com", /Cyrillic letters that look like Latin/],
    ["раураӏ.example.com", /Cyrillic letters that look like Latin/],
    ["ехсеӏ.example.com", /Cyrillic letters that look like Latin/],
    // Wholly Greek look-alikes
    ["ορτικ.example.com", /Greek letters that look like Latin/],
    // Accents dropped: still paypal
    ["páypal.example.com", /looks like "paypal"/],
    ["vidéos.gôogle.com", /looks like "google"/],
    // Latin look-alike letters
    ["ɡoogle.example.com", /google/],
    // Mixed Latin + Han
    ["paypal中文.example.com", /mixes/],
  ];
  it.each(idn)("IDN %s", (h, why) => {
    const a = ascii(h);
    expect(a).toMatch(/xn--/);
    const r = hostnameBlockedReason(a);
    expect(r).not.toBeNull();
    expect(r).toMatch(why);
  });

  it("an unreadable punycode label is blocked", () => {
    expect(hostnameBlockedReason("xn--a-99999999999999.example.com")).toMatch(/isn't a readable international name/);
  });
});

describe("hostnameBlockedReason: allowed (no false positives)", () => {
  const allowed = [
    "videos.acme.example.com",
    "watch.studio-max.com",
    "videos.example.com",
    "vids.acme.co.uk",
    "videos.purchase-guide.com", // chase
    "videos.pineapple.co.uk", // apple
    "metadata.example.com", // meta
    "videos.interactive-media.com", // interac
    "designing.example.com", // signin
    "videos.accounting-firm.com", // account
    "videos.lawsuit.com", // aws
    "first.example.com", // irs
    "videos.governance.org", // gov
    "learn.modern-history.com", // rn -> m
    "videos.example.td", // the TLD .td
    "videos.example.gov.uk", // a public suffix label
    "videos.security-news.com", // secure
    "videos.visage.com", // visa
    "support.example.com", // only support-*
    "videos.bankside.co.uk", // bank
    "videos.stripes-and-dots.com", // stripe
    "videos.chaser.com", // chase
    "videos.metro-news.com",
    "watch.td-ameritrade-fan.example.com".replace("td-", "tdx-"), // tdx is not td
    "videos.studiotd.com", // td inside a word
    "videos.loginov.example.com".replace("login", "logi"), // logi
    "tv.example.com",
    "videos.123.example.com",
  ];
  it.each(allowed)("%s", (h) => {
    expect(hostnameBlockedReason(h)).toBeNull();
  });

  const idnAllowed = ["café.example.com", "münchen.example.de", "видео.example.ru", "動画.example.jp", "ビデオ.example.jp", "δοκιμή.example.gr"];
  it.each(idnAllowed)("IDN %s", (h) => {
    const a = ascii(h);
    expect(a).toMatch(/xn--/);
    expect(hostnameBlockedReason(a)).toBeNull();
  });
});

describe("punycodeDecode", () => {
  it("decodes RFC 3492 labels and refuses invalid ones", () => {
    expect(punycodeDecode("caf-dma")).toBe("café");
    expect(punycodeDecode("mnchen-3ya")).toBe("münchen");
    expect(punycodeDecode(ascii("видео.example.ru").split(".")[0].slice(4))).toBe("видео");
    expect(punycodeDecode(ascii("動画.example.jp").split(".")[0].slice(4))).toBe("動画");
    expect(punycodeDecode("a-99999999999999")).toBeNull();
    expect(punycodeDecode("ab-c!")).toBeNull();
    expect(punycodeDecode("é-a")).toBeNull();
  });
});

describe("set_custom_domain refuses with HOSTNAME_NEEDS_REVIEW", () => {
  const E = withEnv({ CF_SAAS_API_TOKEN: "cf_test_token", CF_ZONE_ID: "zone_test" });
  const real = cfDeps.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    cfDeps.fetch = async () => {
      calls++;
      return Response.json({ success: false, errors: [{ code: 10000, message: "no" }] }, { status: 403 });
    };
  });
  afterEach(() => {
    cfDeps.fetch = real;
  });

  it("before any Cloudflare call, with the plain message and the reason", async () => {
    const { accountId, key } = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'teams' WHERE id = ?").bind(accountId).run();
    for (const h of ["paypal.example.com", "https://login.example.com/", "rn1crosoft.example.com", "pаypal.example.com"]) {
      const r = await mcp("set_custom_domain", { hostname: h }, key, E);
      expect(r.isError, h).toBe(true);
      expect(r.data).toMatchObject({ error: "HOSTNAME_NEEDS_REVIEW", message: needsReviewMessage(E), reason: expect.any(String) });
    }
    expect(needsReviewMessage(E)).toBe(
      "That name looks like it could be mistaken for another company, so it needs a manual review. Email abuse@example.test or pick a different subdomain.",
    );
    expect(calls).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM custom_domains WHERE account_id = ?").bind(accountId).first<{ n: number }>())!.n).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { type EmailSite, renderSigninEmail } from "../src/oauth/email-template";

const SITE: EmailSite = { baseUrl: "https://example.test", branded: true, supportLine: (verb) => `${verb} hello@example.test` };

const LINK = "https://example.test/oauth/magic?t=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG";

describe("sign-in email", () => {
  const withLink = renderSigninEmail({ code: "482915", link: LINK, email: "alex@example.com" }, SITE);
  const codeOnly = renderSigninEmail({ code: "482915", email: "alex@example.com" }, SITE);

  it("subject carries the code", () => {
    expect(withLink.subject).toBe("Your Recitbot code: 482915");
  });

  it("html: the code once, as one text node in the white code box", () => {
    for (const { html } of [withLink, codeOnly]) {
      expect(html.split("482915")).toHaveLength(2);
      expect(html).toMatch(/<td align="center" bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E4E0D8;[^"]*"><span class="rb-code rb-ink" style="[^"]*letter-spacing:8px;color:#111318;[^"]*">482915<\/span><\/td>/);
      expect(html).toContain("Expires in 10 minutes.");
      expect(html).toContain("If you didn't ask for this, you can ignore this email.");
    }
  });

  it("html: color-scheme metas, PNG logo with alt, no SVG, no external CSS, no script", () => {
    const { html } = withLink;
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain('<img src="https://example.test/s/apple-touch-icon.png" width="48" height="48" alt="Recitbot"');
    expect(html).toContain(">recitbot</td>");
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain("[data-ogsc]");
    expect(html).not.toMatch(/<svg|\.svg|<link|@import|<script/i);
    expect(html).not.toMatch(/personals+brand/i);
  });

  it("html: with a link, a bulletproof Tally Red button (VML for Outlook) and the raw link", () => {
    expect(withLink.html).toContain('fillcolor="#F2463A"');
    expect(withLink.html).toContain('<td align="center" bgcolor="#F2463A"');
    expect(withLink.html).toContain(`<a href="${LINK}" target="_blank" style="display:inline-block;`);
    expect(withLink.html).toContain(`>${LINK}</a>`);
    expect(withLink.html.match(/Sign in to Recitbot/g)).toHaveLength(2);
    expect(codeOnly.html).not.toContain("Sign in to Recitbot");
    expect(codeOnly.html).not.toContain("<a ");
  });

  it("text: code and link each on their own line", () => {
    expect(withLink.text).toMatch(/\n482915\n/);
    expect(withLink.text).toContain(`\n${LINK}\n`);
    expect(withLink.text).toContain("Expires in 10 minutes.");
    expect(withLink.text).toContain("If you didn't ask for this, you can ignore this email.");
    expect(codeOnly.text).not.toContain("http");
    expect(withLink.text).not.toMatch(/personals+brand/i);
  });

  it("escapes the email address in html", () => {
    expect(renderSigninEmail({ code: "000001", email: '"<b>"@example.com' }, SITE).html).toContain("&quot;&lt;b&gt;&quot;@example.com");
  });
});

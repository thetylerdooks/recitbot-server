// Disposable-email domains (subdomains match too): the vendored list plus a few it lacks. Built once at module load.
import { VENDORED_DISPOSABLE_DOMAINS } from "./disposable-domains";

const DOMAINS = new Set(VENDORED_DISPOSABLE_DOMAINS.split("\n").filter(Boolean));
for (const d of ["tempmail.com", "temp-mail.io", "spamgourmet.com", "burnermail.io"]) DOMAINS.add(d);

export function disposableDomain(email: string): boolean {
  const domain = email.split("@").pop()!.toLowerCase();
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DOMAINS.has(parts.slice(i).join("."))) return true;
  return false;
}

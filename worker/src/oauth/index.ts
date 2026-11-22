// Routes for /.well-known/* (RFC 9728 / RFC 8414 discovery), /oauth/*, the website sign-in (/signin, /signout) and the owner
// claim (POST /claim).
// Returns null for any other path.
import { getConfig } from "../config";
import type { Env } from "../env";
import { authorize, consent, decide, magicLink, signin, signinPost, signout, signoutConfirm, submitCode, submitEmail } from "./authorize";
import { claimServer } from "./claim-route";
import { register } from "./clients";
import { issuerFor, SCOPE, SCOPES } from "./hosts";
import { corsJson, oauthError, publicPreflight } from "./http";
import { revokeEndpoint, tokenEndpoint } from "./tokens";

export { withMcpCors } from "./http";

const DISCOVERY_HEADERS = { "cache-control": "public, max-age=300" };

/** Documentation links (config.ts docsUrl): left out when this server has none. */
const docs = (env: Env, key: "resource_documentation" | "service_documentation") => {
  const url = getConfig(env).site.docsUrl;
  return url ? { [key]: url } : {};
};

const protectedResource = (env: Env, iss: string) => ({
  resource: `${iss}/mcp`,
  authorization_servers: [iss],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  // Left out without a BRAND_NAME.
  resource_name: getConfig(env).site.brandName ?? undefined,
  ...docs(env, "resource_documentation"),
});

const authorizationServer = (env: Env, iss: string) => ({
  issuer: iss,
  authorization_endpoint: `${iss}/oauth/authorize`,
  token_endpoint: `${iss}/oauth/token`,
  registration_endpoint: `${iss}/oauth/register`,
  revocation_endpoint: `${iss}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: SCOPES,
  ...docs(env, "service_documentation"),
});

type Handler = (req: Request, env: Env, url: URL) => Promise<Response> | Response;

/** CORS paths answer OPTIONS preflights. */
const ROUTES: Record<string, { cors?: boolean; GET?: Handler; POST?: Handler }> = {
  "/.well-known/oauth-protected-resource": { cors: true, GET: (_r, e, u) => corsJson(protectedResource(e, issuerFor(e, u)), 200, DISCOVERY_HEADERS) },
  "/.well-known/oauth-protected-resource/mcp": { cors: true, GET: (_r, e, u) => corsJson(protectedResource(e, issuerFor(e, u)), 200, DISCOVERY_HEADERS) },
  "/.well-known/oauth-authorization-server": { cors: true, GET: (_r, e, u) => corsJson(authorizationServer(e, issuerFor(e, u)), 200, DISCOVERY_HEADERS) },
  "/.well-known/openid-configuration": { cors: true, GET: (_r, e, u) => corsJson(authorizationServer(e, issuerFor(e, u)), 200, DISCOVERY_HEADERS) },
  "/oauth/register": { cors: true, POST: register },
  "/oauth/token": { cors: true, POST: tokenEndpoint },
  "/oauth/revoke": { cors: true, POST: revokeEndpoint },
  "/oauth/authorize": { GET: authorize },
  "/oauth/authorize/email": { POST: submitEmail },
  "/oauth/authorize/code": { POST: submitCode },
  "/oauth/authorize/consent": { GET: consent },
  "/oauth/authorize/decide": { POST: decide },
  "/oauth/magic": { GET: magicLink },
  "/signin": { GET: signin, POST: signinPost },
  "/signout": { GET: signoutConfirm, POST: signout },
};

export async function routeOAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  // Any other method there is an unknown path, and so is the POST unless a claim is possible.
  if (url.pathname === "/claim") return req.method === "POST" ? claimServer(req, env) : null;
  const route = ROUTES[url.pathname];
  if (!route) return null;
  if (route.cors && req.method === "OPTIONS") return publicPreflight();
  const handler = req.method === "GET" ? route.GET : req.method === "POST" ? route.POST : undefined;
  if (!handler) return oauthError("invalid_request", "Method not allowed.", 405);
  return handler(req, env, url);
}

// MCP client helpers built on the official SDK (Streamable HTTP + Bearer header).
// Run directly for a protocol smoke test: node scripts/mcp-smoke.mjs [baseUrl]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pathToFileURL } from "node:url";

export async function connect(base, apiKey) {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), {
    requestInit: apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {},
  });
  const client = new Client({ name: "agent-recorder-smoke", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns its structured result; throws on tool errors. */
export async function callTool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const data = r.structuredContent ?? JSON.parse(r.content[0].text);
  if (r.isError) {
    const e = new Error(`${name} failed: ${data.error}: ${data.message}`);
    e.data = data;
    throw e;
  }
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] ?? "http://127.0.0.1:8787";
  const anon = await connect(base);
  const { tools } = await anon.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
  const s = await callTool(anon, "signup", { bot_name: "smoke" });
  const authed = await connect(base, s.api_key);
  console.log("device_status:", JSON.stringify(await callTool(authed, "device_status")));
  console.log("signup ok (api key not printed)");
  await anon.close();
  await authed.close();
}

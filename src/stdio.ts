#!/usr/bin/env node
/**
 * `npx @qed-proof/mcp` — the local stdio server. The key comes from QED_API_KEY and stays in this process.
 * stdout is the MCP channel, so everything else goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QedApi } from "./api.js";
import { createServer } from "./tools.js";

const api = new QedApi({ apiKey: process.env.QED_API_KEY, baseUrl: process.env.QED_API_URL });
if (!api.hasKey)
  console.error("qed-proof-mcp: QED_API_KEY is not set; submit_claim, get_verdict and list tools will return an auth error.");
const server = createServer({ api, defaultAgentId: process.env.QED_AGENT_ID });
await server.connect(new StdioServerTransport());

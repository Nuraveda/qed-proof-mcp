/**
 * A thin client for the QED Proof API. It holds the caller's key only for the life of the process (stdio) or of one
 * request (remote) and never logs it. Receipts are fetched as RAW text, because the offline checker must see the exact
 * bytes (a parsed-and-re-serialised receipt can't be checked for the integer-only rule).
 */
export const DEFAULT_API = "https://api.qedproof.site";
export const VERSION = "0.1.0";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryAfter?: string,
  ) {
    super(`HTTP ${status}: ${detail}`);
  }
}

export type ClaimIn = {
  client_claim_id: string;
  agent_id: string;
  action: string;
  target: string;
  params: Record<string, unknown>;
  claimed_at: string;
};

export type ClaimStatus = {
  claim_id: string;
  state: string;
  attempts?: number;
  receipt_id: string | null;
  verdict: string | null;
  created?: boolean;
};

export class QedApi {
  readonly base: string;
  private readonly key?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_API).replace(/\/+$/, "");
    this.key = opts.apiKey?.trim() || undefined;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get hasKey(): boolean {
    return Boolean(this.key);
  }

  private async request(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<string> {
    const headers: Record<string, string> = { "User-Agent": `qed-proof-mcp/${VERSION}`, Accept: "application/json" };
    if (init.auth !== false) {
      if (!this.key) throw new ApiError(401, "no API key");
      headers.Authorization = `Bearer ${this.key}`;
    } else if (this.key) {
      // Public reads still carry the key when there is one, so the API can rate-limit them per key rather than per
      // IP. Every hosted-MCP user shares the server's egress IPs.
      headers.Authorization = `Bearer ${this.key}`;
    }
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = res.statusText || "request failed";
      try {
        const j = JSON.parse(text) as { detail?: unknown };
        if (typeof j.detail === "string") detail = j.detail;
      } catch {
        // not JSON; keep the status text
      }
      throw new ApiError(res.status, detail, res.headers.get("retry-after") ?? undefined);
    }
    return text;
  }

  async submitClaim(claim: ClaimIn): Promise<ClaimStatus> {
    return JSON.parse(await this.request("/v1/claims", { method: "POST", body: claim })) as ClaimStatus;
  }

  async getClaim(claimId: string): Promise<ClaimStatus> {
    return JSON.parse(await this.request(`/v1/claims/${encodeURIComponent(claimId)}`)) as ClaimStatus;
  }

  /** The receipt's exact bytes. Receipts are public, so this works without a key. */
  async getReceiptText(receiptId: string): Promise<string> {
    return this.request(`/v1/receipts/${encodeURIComponent(receiptId)}`, { auth: false });
  }

  async getKeys(): Promise<string> {
    return this.request("/.well-known/poaw-keys.json", { auth: false });
  }

  async listClaims(query: Record<string, string | number | undefined>): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return JSON.parse(await this.request(`/v1/claims${qs.size ? `?${qs}` : ""}`));
  }

  async listConnections(): Promise<unknown> {
    return JSON.parse(await this.request("/v1/connections"));
  }
}

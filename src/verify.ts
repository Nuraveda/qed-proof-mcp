/**
 * Offline receipt check: a line-for-line port of the reference checker, oss/spec/tools/check.py (SPEC §10).
 * It must agree with that checker on every spec vector (test/verify.test.ts reads test/vectors/manifest.json).
 *
 * Offline means no chain read, so the anchor is reported "not_checked_offline" and the achieved trust level is at most
 * 1 — exactly as the reference checker does without --rpc. Never report more than was checked.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import canonicalize from "canonicalize";
import { RECEIPT_SCHEMA } from "./generated/spec.js";

const SIG_DOMAIN = new TextEncoder().encode("POAW-RECEIPT-V0\n");
const enc = new TextEncoder();

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export type KeySet = { keys: { key_id: string; public_key: string; valid_from: string; revoked_at: string | null }[] };

export type CheckReport = {
  checks: {
    spec_version: boolean;
    schema: boolean;
    integers_only: boolean;
    key: boolean;
    signature: boolean;
    claim_digest: boolean;
    inclusion: boolean | "absent";
    anchor: "absent" | "not_checked_offline";
  };
  valid: boolean;
  achieved_trust_level: 0 | 1;
  verdict: string | null;
};

// --- encoding (SPEC §3) --------------------------------------------------------------------------------------------
export function b64u(data: Uint8Array): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  return new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

function jcs(value: unknown): Uint8Array {
  const s = canonicalize(value);
  if (s === undefined) throw new Error("value can't be canonicalised");
  return enc.encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * SPEC §3: receipts carry integers only. This must read the RAW text: `JSON.parse("1.0")` yields the integer 1 in
 * JavaScript, so a parsed value can't tell `1.0` from `1`, while the reference checker (Python) can. Any number token
 * with a fraction or an exponent is a float, exactly as Python's json module decides.
 */
export function hasFloatInText(raw: string): boolean {
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      let float = false;
      while (j < raw.length && /[0-9eE+\-.]/.test(raw[j])) {
        if (raw[j] === "." || raw[j] === "e" || raw[j] === "E") float = true;
        j++;
      }
      if (float) return true;
      i = j - 1;
    }
  }
  return false;
}

// --- keys + signatures (SPEC §5) ------------------------------------------------------------------------------------
export function keyId(publicKey: Uint8Array): string {
  return `ed25519:${b64u(sha256(publicKey))}`;
}

function verifySignature(publicKey: Uint8Array, body: unknown, sigValue: unknown): boolean {
  try {
    if (typeof sigValue !== "string") return false;
    return ed25519.verify(b64uDecode(sigValue), concat(SIG_DOMAIN, jcs(body)), publicKey);
  } catch {
    return false;
  }
}

function claimDigest(claim: Obj): string {
  const { claim_digest: _drop, ...rest } = claim;
  return b64u(sha256(jcs(rest)));
}

// --- Merkle log, RFC 6962 (SPEC §8) ---------------------------------------------------------------------------------
function leafHash(receipt: Obj): Uint8Array {
  return sha256(concat(new Uint8Array([0]), jcs({ body: receipt.body, signature: receipt.signature })));
}

function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concat(new Uint8Array([1]), left, right));
}

/** RFC 9162 §2.1.3.2 audit-path verification. The computed root, or null if the path is malformed. */
export function rootFromInclusion(index: number, size: number, leaf: Uint8Array, path: Uint8Array[]): Uint8Array | null {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return null;
  // BigInt keeps the bit operations exact beyond 2^31, where JavaScript's `>>` and `&` would wrap.
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r = leaf;
  for (const p of path) {
    if (sn === 0n) return null;
    if (fn & 1n || fn === sn) {
      r = node(p, r);
      if (!(fn & 1n)) {
        while (fn && !(fn & 1n)) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = node(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n ? r : null;
}

// --- the check (SPEC §10) -------------------------------------------------------------------------------------------
const ajv = new Ajv2020({ allErrors: false, strict: false });
const validateSchema = ajv.compile(RECEIPT_SCHEMA as object);

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Check a receipt given as its raw JSON text (so the float rule can be applied exactly) against a key set.
 * `valid` is true only if every check that applies passes.
 */
export function checkReceipt(receiptJson: string, keyset: KeySet): CheckReport {
  const receipt = JSON.parse(receiptJson) as unknown;
  const r: Obj = isObj(receipt) ? receipt : {};
  const body: Obj = isObj(r.body) ? r.body : {};
  const sig: Obj = isObj(r.signature) ? r.signature : {};

  const version = str(body.spec_version);
  const specVersion = version.split("/")[0] === "poaw" && (version.split("/").pop() ?? "").split(".")[0] === "0";
  const schema = Boolean(validateSchema(receipt));
  const integersOnly = !hasFloatInText(receiptJson);

  const key = (keyset?.keys ?? []).find((k) => k.key_id === sig.key_id);
  const issued = str(body.issued_at);
  const issuer: Obj = isObj(body.issuer) ? body.issuer : {};
  let keyOk = false;
  let pk: Uint8Array | null = null;
  try {
    pk = key ? b64uDecode(key.public_key) : null;
    keyOk = Boolean(
      key &&
        pk &&
        sig.key_id === issuer.key_id &&
        keyId(pk) === key.key_id &&
        key.valid_from <= issued &&
        (key.revoked_at === null || key.revoked_at === undefined || issued < key.revoked_at),
    );
  } catch {
    keyOk = false;
  }
  const signature = Boolean(keyOk && pk && verifySignature(pk, body, sig.value));
  const claim = body.claim;
  const digest = isObj(claim) && claim.claim_digest === claimDigest(claim);

  let inclusion: boolean | "absent" = "absent";
  const proof = r.proof;
  if (proof !== undefined && proof !== null) {
    try {
      const p = proof as Obj;
      const path = (p.inclusion as string[]).map(b64uDecode);
      const root = rootFromInclusion(p.leaf_index as number, p.tree_size as number, leafHash(r), path);
      inclusion = root !== null && b64u(root) === p.root_hash;
    } catch {
      inclusion = false;
    }
  }
  const anchor = isObj(proof) && proof.anchor ? "not_checked_offline" : "absent";

  const checks = {
    spec_version: specVersion,
    schema,
    integers_only: integersOnly,
    key: keyOk,
    signature,
    claim_digest: digest,
    inclusion,
    anchor,
  } as CheckReport["checks"];
  const required = [checks.spec_version, checks.schema, checks.integers_only, checks.key, checks.signature, checks.claim_digest];
  const valid = required.every((c) => c === true) && (checks.inclusion === true || checks.inclusion === "absent");
  const verdictObj = isObj(body.verdict) ? body.verdict : {};
  return {
    checks,
    valid,
    // SPEC §7: the ACHIEVED level. Level 2 needs an anchor verified on-chain, which an offline check never does.
    achieved_trust_level: valid ? 1 : 0,
    verdict: valid ? str(verdictObj.value) || null : null,
  };
}

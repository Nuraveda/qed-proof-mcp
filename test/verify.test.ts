import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkReceipt, hasFloatInText, type KeySet } from "../src/verify.js";

const DIR = join(import.meta.dirname, "vectors");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
  keyset: string;
  vectors: { file: string; description: string; expected: Record<string, unknown> }[];
};
const keyset = JSON.parse(readFileSync(join(DIR, manifest.keyset), "utf8")) as KeySet;

/**
 * The port must agree with oss/spec/tools/check.py on every vector, check by check: the same `valid`, the same
 * achieved level, the same verdict, and the same individual results. An agent will quote this tool's answer.
 */
describe("verify_receipt agrees with the reference checker on every spec vector", () => {
  it("has the vectors", () => expect(manifest.vectors.length).toBeGreaterThanOrEqual(20));

  it.each(manifest.vectors.map((v) => [v.file, v]))("%s", (_file, v) => {
    const raw = readFileSync(join(DIR, v.file), "utf8");
    const report = checkReceipt(raw, keyset);
    expect(report).toEqual(v.expected);
  });
});

describe("the float rule reads raw text (JSON.parse loses 1.0 vs 1)", () => {
  it.each([
    ['{"a":1.0}', true],
    ['{"a":1e3}', true],
    ['{"a":-2.5E-1}', true],
    ['{"a":10}', false],
    ['{"a":"1.0"}', false],
    ['{"a":"say \\"2.5\\""}', false],
    ['{"a":[1,2,-3]}', false],
  ])("%s → %s", (raw, expected) => expect(hasFloatInText(raw)).toBe(expected));
});

describe("the cross-language float case the spec vectors don't cover", () => {
  // Vector 014 uses 0.5, which JavaScript also sees as non-integer. The case that actually splits the languages is a
  // float that equals an integer: Python reads "attempts": 1.0 as a float and rejects the receipt; JSON.parse makes it
  // the integer 1. A checker that only looks at parsed values accepts it. This one must not.
  it('rejects "attempts": 1.0 even though JSON.parse turns it into 1', () => {
    const raw = readFileSync(join(DIR, "001-valid-verified.json"), "utf8").replace('"attempts": 1,', '"attempts": 1.0,');
    expect(raw).toContain('"attempts": 1.0,');
    const report = checkReceipt(raw, keyset);
    expect(report.checks.integers_only).toBe(false);
    expect(report.valid).toBe(false);
    expect(report.achieved_trust_level).toBe(0);
  });
});

/**
 * Secret handling (§17) — `lib/engines/shared.ts` plus the secrets engine itself.
 *
 * The guarantee under test is narrow and absolute: a detected credential is masked in every
 * place it appears, and the raw value never reaches a finding (snippet, metadata or
 * evidence). The engine is run over the golden demo dataset (§45), which contains
 * deliberately realistic credentials.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { demoSnapshot } from "../lib/demo/demo-repo";
import { runSecretsEngine } from "../lib/engines/secrets";
import { looksPlaceholder, maskValue, scrubSecrets, shannonEntropy, textFiles } from "../lib/engines/shared";
import type { RawFinding } from "../lib/types";
import { demoSecret } from "./helpers";

/** Credentials literally present in the demo fixture — none of them may surface. */
const DEMO_SECRETS = [
  "sk_live_EXAMPLEDEMO0000000000000000001234",
  "SuperSecret123",
  "jwt-demo-signing-key-do-not-use-abcdef123456",
  "mail-password-demo",
  "ghp_EXAMPLEDEMO0000000000000000000000",
  "MIIEogIBAAKCAQEAexamplekeyfordemo0000000000000000000000000000",
  "DEMONSTRATIONONLYNOTAREALPRIVATEKEY00000000000000000000000000",
];

const STRIPE = demoSecret("sk", "live", "TESTONLY1234567890abcdefghij");

function runEngine(): RawFinding[] {
  const snapshot = demoSnapshot();
  return runSecretsEngine({
    snapshot,
    emit: () => undefined,
    note: () => undefined,
    deadline: Date.now() + 30_000,
    files: textFiles(snapshot),
  });
}

describe("maskValue", () => {
  test("keeps at most the head and the tail and never the middle", () => {
    const value = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const masked = maskValue(value, 4);
    assert.ok(masked.startsWith(value.slice(0, 3)), "the head stays readable");
    assert.ok(masked.endsWith(value.slice(-4)), `the last ${4} characters stay readable`);
    assert.ok(masked.includes("*"), "the masked middle is made of asterisks");
    assert.ok(!masked.includes(value.slice(8, -8)), "the middle of the value is never revealed");
    assert.ok(!masked.includes("klmnopqrstuvwxyz"), "no run from the middle survives");
  });

  test("masks a value that is too short to split", () => {
    assert.equal(maskValue("abc"), "****", "a 3-character value becomes asterisks only");
    assert.equal(maskValue("ABCDEF"), "******", "a value at the keep+2 boundary is fully masked");
    assert.ok(!maskValue("ABCDEF").includes("A"), "nothing of a short value is left readable");
  });

  test("ignores whitespace inside the value", () => {
    assert.equal(maskValue("ab cd efgh", 4), maskValue("abcdefgh", 4), "whitespace is stripped before masking");
  });

  test("caps the length of the masked middle", () => {
    const masked = maskValue("x".repeat(500), 4);
    assert.ok(masked.length < 500, "a very long value must not be reproduced in full");
    assert.ok(masked.split("").every((char, index) => index < 7 || char === "*" || index >= masked.length - 4));
  });
});

describe("scrubSecrets", () => {
  test("removes a live provider key but keeps the prefix", () => {
    const scrubbed = scrubSecrets(`const key = "${STRIPE}";`);
    assert.ok(!scrubbed.includes(STRIPE), "the key must be gone");
    assert.ok(scrubbed.includes("sk_live_"), "the prefix stays for the report");
    assert.ok(scrubbed.includes("****"), "a mask was written in its place");
  });

  test("removes an AWS access key id", () => {
    const scrubbed = scrubSecrets("export const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';");
    assert.ok(!scrubbed.includes("IOSFODNN7EXAMPLE"), "the key body must be gone");
    assert.ok(scrubbed.includes("AKIA"), "the key id prefix stays");
  });

  test("removes the body of a private key block", () => {
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----";
    const scrubbed = scrubSecrets(block);
    assert.ok(!scrubbed.includes("MIIEowIBAAKCAQEA"), "the key body must be gone");
    assert.ok(!scrubbed.includes("secretbody"), "no part of the body survives");
    assert.ok(scrubbed.includes("-----BEGIN RSA PRIVATE KEY-----"), "the marker stays visible");
    assert.ok(scrubbed.includes("-----END RSA PRIVATE KEY-----"), "the end marker stays visible");
    assert.ok(/masked/i.test(scrubbed), "the replacement says it was masked");
  });

  test("removes a password assignment and a credential URL", () => {
    const password = scrubSecrets('const password = "hunter2secretvalue";');
    assert.ok(!password.includes("hunter2secretvalue"), "the assigned password must be gone");
    assert.ok(password.includes("password ="), "the surrounding code stays readable");

    const url = scrubSecrets("postgres://admin:SuperSecret123@db.internal:5432/app");
    assert.ok(!url.includes("SuperSecret123"), "the password inside the URL must be gone");
    assert.ok(url.includes("postgres://admin:"), "scheme and user stay readable");
  });

  test("leaves ordinary code and text untouched", () => {
    for (const sample of [
      "const total = items.length + 1;",
      "export function login(email: string) { return findByEmail(email); }",
      "https://example.com/docs/getting-started",
      "SELECT id, name FROM users WHERE id = $1",
    ]) {
      assert.equal(scrubSecrets(sample), sample, `scrubSecrets altered ordinary text: ${sample}`);
    }
  });
});

describe("looksPlaceholder", () => {
  test("accepts the placeholder shapes the engines rely on", () => {
    for (const placeholder of [
      "process.env.STRIPE_KEY",
      "import.meta.env.VITE_KEY",
      "changeme",
      "CHANGE_ME_NOW",
      "dummy-value",
      "<your-token>",
      "xxxxxxxxxx",
      "TODO",
      "${SECRET}",
      "{{ token }}",
      "os.environ['KEY']",
      "sample_key_value",
    ]) {
      assert.equal(looksPlaceholder(placeholder), true, `${placeholder} should be recognised as a placeholder`);
    }
  });

  test("rejects a real-looking value", () => {
    assert.equal(looksPlaceholder("q7Zk19LmPq8Wx3Yb"), false, "a random value is not a placeholder");
    assert.equal(looksPlaceholder(STRIPE), false, "a provider key is not a placeholder");
  });

  test("recognises the hyphenated `your-api-key` shape", () => {
    // Regression: the pattern covered `your_key`/`yourkey` only, so this common documentation
    // shape still read as a candidate secret and produced noise.
    assert.equal(looksPlaceholder("your-api-key"), true);
    assert.equal(looksPlaceholder("your-secret-key"), true);
  });
});

describe("shannonEntropy", () => {
  test("is zero for a repeated string and high for a random one", () => {
    assert.equal(shannonEntropy("aaaaaaaaaaaaaaaa"), 0, "a repeated character carries no entropy");
    assert.equal(shannonEntropy(""), 0, "an empty string carries no entropy");
    const random = shannonEntropy("aB3$kL9!mN2@pQ7#zR5%");
    assert.ok(random > 3.9, `a random-looking value should score above the detection threshold, got ${random}`);
    assert.ok(random > shannonEntropy("aaabbbccc"), "randomness must outrank repetition");
  });
});

describe("secrets engine over the golden dataset", () => {
  test("finds the credentials the demo fixture plants", () => {
    const findings = runEngine();
    const ruleIds = new Set(findings.map((finding) => finding.ruleId));
    assert.ok(findings.length > 0, "the demo fixture contains credentials and must produce findings");
    for (const expected of ["SEC-001", "SEC-002", "SEC-004", "SEC-006"]) {
      assert.ok(ruleIds.has(expected), `expected ${expected} to fire on the demo fixture`);
    }
    const paths = new Set(findings.map((finding) => finding.filePath));
    assert.ok(paths.has(".env"), "the committed .env file must be reported");
    assert.ok(paths.has("config/private.pem"), "the committed private key must be reported");
  });

  test("every emitted finding is masked — no raw credential reaches the output", () => {
    const serialized = JSON.stringify(runEngine());
    for (const secret of DEMO_SECRETS) {
      assert.ok(!serialized.includes(secret), `a raw credential reached the findings: ${secret.slice(0, 12)}…`);
    }
    assert.ok(serialized.includes("*"), "masking should be visible in the evidence");
  });

  test("the private key finding never carries the key body and points at the file", () => {
    const findings = runEngine();
    const finding = findings.find((candidate) => candidate.ruleId === "SEC-002");
    assert.ok(finding, "the private key must be reported");
    assert.equal(finding.filePath, "config/private.pem");
    assert.equal(finding.lineStart, 1, "the finding points at the header line");
    assert.match(finding.snippet ?? "", /PRIVATE KEY/);
    assert.match(finding.snippet ?? "", /masked/i, "the snippet must say the block was masked");
    assert.ok(!(finding.snippet ?? "").includes("MIIEogIBAAKCAQEA"), "no key material in the snippet");
  });

  test("every finding is in the secrets or security category and cites a tool reference", () => {
    for (const finding of runEngine()) {
      assert.ok(
        finding.ruleId.startsWith("SEC-"),
        `${finding.ruleId} is not a secret/security rule and should not come from this engine`,
      );
      assert.ok((finding.toolReference ?? "").startsWith("secrets-engine:"), `${finding.ruleId} has no tool reference`);
      assert.ok((finding.confidence ?? 0) > 0 && (finding.confidence ?? 0) <= 1, `${finding.ruleId}: bad confidence`);
      assert.ok(finding.filePath.length > 0, `${finding.ruleId} has no file`);
    }
  });

  test("metadata carries the masked value, never the value", () => {
    for (const finding of runEngine()) {
      const metadata = JSON.stringify(finding.metadata ?? {});
      for (const secret of DEMO_SECRETS) {
        assert.ok(!metadata.includes(secret), `${finding.ruleId}: metadata leaked ${secret.slice(0, 12)}…`);
      }
    }
  });
});

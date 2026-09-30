/**
 * Source input validation (§38, SSRF) — `lib/sources/github.ts`.
 *
 * The repository address is the one place a user hands the platform something that becomes an
 * outbound request, so it is validated against GitHub's own naming rules before it is put into
 * a URL path. These tests are the boundary: a malformed owner or repository is refused, and a
 * known-good input keeps working.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSafeRepoRef, parseRepoInput } from "../lib/sources/github";

describe("parseRepoInput", () => {
  test("accepts the shapes a user actually pastes", () => {
    assert.deepEqual(parseRepoInput("https://github.com/vercel/next.js"), { owner: "vercel", repo: "next.js" });
    assert.deepEqual(parseRepoInput("https://github.com/vercel/next.js.git"), { owner: "vercel", repo: "next.js" });
    assert.deepEqual(parseRepoInput("git@github.com:vercel/next.js.git"), { owner: "vercel", repo: "next.js" });
    assert.deepEqual(parseRepoInput("vercel/next.js"), { owner: "vercel", repo: "next.js" });
    assert.deepEqual(parseRepoInput("  vercel/next.js  "), { owner: "vercel", repo: "next.js" });
  });

  test("refuses anything that is not a repository address", () => {
    for (const input of ["", "   ", "not a repo", "https://gitlab.com/a/b", "vercel", "https://github.com/vercel"]) {
      assert.equal(parseRepoInput(input), null, `${JSON.stringify(input)} is not a GitHub repository`);
    }
  });
});

describe("isSafeRepoRef", () => {
  test("accepts realistic owner and repository names", () => {
    for (const ref of [
      { owner: "vercel", repo: "next.js" },
      { owner: "salahamer801-ops", repo: "ai-software-project-auditor" },
      { owner: "a", repo: "a" },
      { owner: "Org2", repo: "repo_with_underscores" },
    ]) {
      assert.equal(isSafeRepoRef(ref), true, `${ref.owner}/${ref.repo} is a valid reference`);
    }
  });

  test("refuses traversal and anything that would change the request path", () => {
    for (const ref of [
      { owner: "..", repo: "x" },
      { owner: ".", repo: "x" },
      { owner: "a/b", repo: "x" },
      { owner: "owner", repo: ".." },
      { owner: "owner", repo: "." },
      { owner: "owner", repo: "a/b" },
      { owner: "owner", repo: "a?b" },
      { owner: "owner", repo: "a#b" },
      { owner: "owner", repo: "" },
      { owner: "-leading", repo: "x" },
      { owner: "e".repeat(40), repo: "x" },
    ]) {
      assert.equal(
        isSafeRepoRef(ref),
        false,
        `${JSON.stringify(ref)} must not reach a GitHub URL path`,
      );
    }
  });
});

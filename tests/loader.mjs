/**
 * Module-resolution hook for the test suite.
 *
 * The application is a Next.js project: TypeScript sources are written extension-less and
 * use the `@/` alias, which only the bundler (and tsc) resolve. Node's ESM resolver does
 * neither, so this hook rewrites those specifiers to the real `.ts` files, which Node then
 * loads with its built-in type stripping.
 *
 * Three rules:
 *  - never rewrite a specifier whose file does not exist (fall through untouched),
 *  - never throw while probing candidates,
 *  - for the two modules that cannot load in a bare Node process (`lib/db.ts` pulls a
 *    PostgreSQL pool, `next/headers` needs the Next runtime) return a test double instead,
 *    so the pure modules that import them stay importable offline.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Runtime stand-ins for modules that can only exist inside the Next server. */
const STUB_BY_BARE_SPECIFIER = new Map([
  ["next/headers", "tests/stubs/next-headers.ts"],
  ["next/cache", "tests/stubs/next-headers.ts"],
  ["server-only", "tests/stubs/empty.ts"],
]);

const STUB_BY_FILE = new Map([
  [path.join(ROOT, "lib/db.ts"), path.join(ROOT, "tests/stubs/db.ts")],
  [path.join(ROOT, "lib/db/index.ts"), path.join(ROOT, "tests/stubs/db.ts")],
]);

function stubUrl(absPath) {
  return existsSync(absPath) ? pathToFileURL(absPath).href : null;
}

function isFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveCandidate(absPathWithoutExtension) {
  const candidates = [absPathWithoutExtension];
  if (!absPathWithoutExtension.endsWith(".ts")) {
    candidates.push(`${absPathWithoutExtension}.ts`, path.join(absPathWithoutExtension, "index.ts"));
  }
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const stubbed = STUB_BY_BARE_SPECIFIER.get(specifier);
  if (stubbed) {
    const url = stubUrl(path.join(ROOT, stubbed));
    if (url) return { url, shortCircuit: true };
  }

  let base = null;
  if (specifier.startsWith("@/")) {
    base = path.join(ROOT, specifier.slice(2));
  } else if (specifier.startsWith("file:")) {
    base = fileURLToPath(specifier);
  } else if (specifier.startsWith(".") || specifier.startsWith("/")) {
    if (context?.parentURL?.startsWith("file:")) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      base = specifier.startsWith("/") ? specifier : path.resolve(parentDir, specifier);
    }
  }

  if (base) {
    const resolved = resolveCandidate(base);
    if (resolved) {
      const asStub = STUB_BY_FILE.get(resolved);
      const url = pathToFileURL(asStub ?? resolved).href;
      // No `format` on purpose: letting Node detect it is what enables type stripping
      // for the `.ts` sources.
      return { url, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}

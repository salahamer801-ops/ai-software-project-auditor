/**
 * Registered with `node --import ./tests/setup.mjs` before the test files load, so every
 * test process resolves `@/...` and extension-less imports the way the app does.
 *
 * The suite is required to run offline: any accidental network call through `fetch` is a bug
 * in the test (or in a module under test that should be pure), so it fails loudly instead of
 * reaching a real registry.
 */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

globalThis.fetch = () => {
  throw new Error("the test suite is offline: a test attempted a network request");
};

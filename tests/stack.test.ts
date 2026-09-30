/**
 * Stack detection (§15) — `lib/engines/stack.ts`.
 *
 * The stack must come from what the files say (manifests, config files, source), never from
 * a folder name: a repository called `django-service/` that contains a Next.js app is a
 * Next.js app.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectStack, isMigrationFile, isTestFile, isUiFile, languageOf, stackHighlights } from "../lib/engines/stack";
import { snapshotOf } from "./helpers";
import type { RepoSnapshot } from "../lib/types";

function stackOf(files: { path: string; content: string }[]): RepoSnapshot["stack"] {
  return snapshotOf(files).stack;
}

describe("detectStack — frameworks", () => {
  test("a package.json naming Next.js and React is detected as such", () => {
    const stack = stackOf([
      { path: "app/page.tsx", content: "export default function Page() { return null; }\n" },
      { path: "next.config.ts", content: "export default {};\n" },
      { path: "package.json", content: JSON.stringify({ dependencies: { next: "15.5.26", react: "19.3.0" } }) },
    ]);
    assert.deepEqual(stack.frameworks, ["Next.js", "React"]);
    assert.ok(stack.packageManagers.includes("npm"));
    assert.ok(stack.buildTools.includes("TypeScript") === false, "typescript is not a dependency here");
    assert.ok(stack.languages.some((language) => language.name === "typescript"));
  });

  test("a composer.json naming Laravel is detected as such", () => {
    const stack = stackOf([
      { path: "composer.json", content: JSON.stringify({ require: { "laravel/framework": "^10.0", php: ">=8.1" } }) },
      { path: "artisan", content: "#!/usr/bin/env php\n" },
      { path: "routes/web.php", content: "<?php Route::get('/', fn () => 'ok');\n" },
    ]);
    assert.ok(stack.frameworks.includes("Laravel"), `expected Laravel in ${stack.frameworks.join(", ")}`);
    assert.ok(stack.packageManagers.includes("composer"));
    assert.ok(stack.apiSurface.includes("Laravel routes"));
    assert.deepEqual(stack.databaseIndicators, ["Eloquent (Laravel)"], "the framework's ORM is reported");
  });

  test("a Django project is detected from requirements.txt plus manage.py", () => {
    const stack = stackOf([
      { path: "requirements.txt", content: "Django==4.2.0\npsycopg2-binary==2.9.9\npytest==8.1.1\n" },
      { path: "manage.py", content: "#!/usr/bin/env python\n" },
      { path: "shop/urls.py", content: "urlpatterns = []\n" },
      { path: "shop/models.py", content: "class User: pass\n" },
    ]);
    assert.ok(stack.frameworks.includes("Django"), `expected Django in ${stack.frameworks.join(", ")}`);
    assert.ok(stack.databaseIndicators.includes("Django ORM"));
    assert.ok(stack.databaseIndicators.includes("PostgreSQL driver"));
    assert.ok(stack.apiSurface.includes("Django urls"));
    assert.ok(stack.packageManagers.includes("pip"));
    assert.ok(stack.testFrameworks.includes("Pytest"), `expected Pytest in ${stack.testFrameworks.join(", ")}`);
  });

  test("a FastAPI backend is detected from its dependencies", () => {
    const stack = stackOf([{ path: "requirements.txt", content: "fastapi==0.110.0\nuvicorn==0.29.0\n" }]);
    assert.ok(stack.frameworks.includes("FastAPI"));
    assert.ok(stack.apiSurface.includes("FastAPI routes"));
  });

  test("the stack never comes from a folder name", () => {
    const stack = stackOf([
      { path: "django-app/index.ts", content: "export const x = 1;\n" },
      { path: "laravel/src/main.ts", content: "export const y = 2;\n" },
      { path: "python-project/app.ts", content: "export const z = 3;\n" },
    ]);
    assert.deepEqual(stack.frameworks, [], "no manifest names a framework, so none is claimed");
    assert.deepEqual(stack.packageManagers, []);
    assert.deepEqual(stack.languages.map((language) => language.name), ["typescript"]);
  });
});

describe("detectStack — inventories", () => {
  test("collects manifests, CI providers, docker indicators and test frameworks", () => {
    const stack = stackOf([
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "19.3.0" }, devDependencies: { vitest: "3.1.0", typescript: "5.9.3" } }) },
      { path: "package-lock.json", content: "{}" },
      { path: "Dockerfile", content: "FROM node:22-alpine\n" },
      { path: "docker-compose.yml", content: "services: {}\n" },
      { path: ".github/workflows/ci.yml", content: "name: ci\n" },
      { path: "vite.config.ts", content: "export default {};\n" },
      { path: "src/sum.test.ts", content: "test('x', () => {});\n" },
    ]);
    assert.ok(stack.manifests.includes("package.json"));
    assert.ok(stack.manifests.includes("package-lock.json"));
    assert.ok(stack.manifests.includes("Dockerfile"));
    assert.equal(stack.docker, true);
    assert.deepEqual(stack.ciProviders, ["GitHub Actions"]);
    assert.ok(stack.testFrameworks.includes("Vitest"));
    assert.ok(stack.buildTools.includes("Vite"));
    assert.ok(stack.buildTools.includes("TypeScript"));
    assert.ok(stack.buildTools.includes("Make") === false);
  });

  test("an empty file list yields a well-formed, empty stack", () => {
    const stack = stackOf([]);
    assert.deepEqual(stack.languages, []);
    assert.deepEqual(stack.frameworks, []);
    assert.deepEqual(stack.packageManagers, []);
    assert.deepEqual(stack.testFrameworks, []);
    assert.deepEqual(stack.buildTools, []);
    assert.deepEqual(stack.ciProviders, []);
    assert.deepEqual(stack.databaseIndicators, []);
    assert.deepEqual(stack.manifests, []);
    assert.deepEqual(stack.apiSurface, []);
    assert.equal(stack.docker, false);
    assert.equal(stack.totalFiles, 0);
    assert.equal(stack.totalLoc, 0);
    assert.deepEqual(stackHighlights(stack), [], "an empty stack has no highlight line");
  });

  test("counts languages by size, biggest first, and caps the list at 12", () => {
    const stack = stackOf([
      { path: "a.ts", content: "export const a = 1;\nexport const b = 2;\n" },
      { path: "b.ts", content: "export const c = 3;\n" },
      { path: "styles.css", content: "a { color: red; }\n" },
      { path: "README.md", content: "# hi\n" },
    ]);
    assert.deepEqual(stack.languages[0], { name: "typescript", files: 2, loc: 3 });
    // `countLoc` skips lines starting with `#`, so a markdown heading counts as no code at
    // all and the 1-line stylesheet outranks the README.
    assert.deepEqual(stack.languages[1], { name: "css", files: 1, loc: 1 });
    assert.deepEqual(stack.languages[2], { name: "markdown", files: 1, loc: 0 });
    assert.ok(stack.languages.length <= 12, "the language list is capped");
    assert.equal(stack.totalFiles, 4);
    assert.equal(stack.totalLoc, 4, "loc sums the per-language counts");
  });

  test("stackHighlights summarises the interesting parts", () => {
    const stack = stackOf([
      { path: "package.json", content: JSON.stringify({ dependencies: { next: "15.5.26", react: "19.3.0", pg: "8.23.0" } }) },
      { path: "app/page.tsx", content: "export default function Page() { return null; }\n" },
    ]);
    const highlights = stackHighlights(stack);
    assert.ok(highlights.length > 0, "a detected stack produces highlights");
    assert.ok(highlights.some((line) => line.includes("Next.js")), `frameworks missing from ${highlights.join(" | ")}`);
    assert.ok(highlights.some((line) => line.includes("typescript")), `languages missing from ${highlights.join(" | ")}`);
    assert.ok(highlights.some((line) => line.includes("npm")), `package managers missing from ${highlights.join(" | ")}`);
  });
});

describe("path classification", () => {
  test("languageOf maps extensions and special file names", () => {
    assert.equal(languageOf("src/app.tsx"), "typescript");
    assert.equal(languageOf("src/app.js"), "javascript");
    assert.equal(languageOf("Dockerfile"), "dockerfile");
    assert.equal(languageOf("Dockerfile.prod"), "dockerfile");
    assert.equal(languageOf("Makefile"), "make");
    assert.equal(languageOf("go.mod"), "go");
    assert.equal(languageOf("package.json"), "json");
    assert.equal(languageOf("requirements.txt"), "text");
    assert.equal(languageOf(".env"), "env");
    assert.equal(languageOf("LICENSE"), "text", "an extension-less file is plain text");
    assert.equal(languageOf("file.unknownext"), "text", "an unknown extension falls back to text");
    assert.equal(languageOf("lib/util.vue"), "vue");
  });

  test("isTestFile recognises the documented test paths", () => {
    for (const path of [
      "tests/a.ts",
      "src/__tests__/a.ts",
      "src/a.test.ts",
      "src/a.spec.tsx",
      "test_main.py",
      "app/main_test.go",
      "lib/foo_test.rb",
      "spec/models_spec.rb",
      "UserTest.java",
      "UserIT.cs",
    ]) {
      assert.equal(isTestFile(path), true, `${path} should be a test file`);
    }
    for (const path of ["src/a.ts", "src/testing.ts", "docs/testing.md", "src/latest.ts"]) {
      assert.equal(isTestFile(path), false, `${path} is not a test file`);
    }
  });

  test("isMigrationFile recognises migrations, schema files and SQL", () => {
    for (const path of [
      "migrations/001_init.sql",
      "db/migrations/2.ts",
      "db/migrate/20230101.rb",
      "prisma/schema.prisma",
      "scripts/seed.sql",
    ]) {
      assert.equal(isMigrationFile(path), true, `${path} should be a migration file`);
    }
    for (const path of ["src/app.ts", "src/database.ts", "app/api/route.ts"]) {
      assert.equal(isMigrationFile(path), false, `${path} is not a migration file`);
    }
  });

  test("isUiFile recognises components and view layers", () => {
    for (const path of [
      "components/Button.tsx",
      "src/components/Button.tsx",
      "app/page.tsx",
      "views/Home.vue",
      "src/ui/Widget.svelte",
      "pages/index.jsx",
    ]) {
      assert.equal(isUiFile(path), true, `${path} should be a UI file`);
    }
    for (const path of ["src/lib/util.ts", "scripts/build.mjs", "server/api.ts"]) {
      assert.equal(isUiFile(path), false, `${path} is not a UI file`);
    }
  });
});

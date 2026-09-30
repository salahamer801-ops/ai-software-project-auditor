/**
 * Dependency engine (§18) — `lib/engines/dependencies.ts`, manifest parsing.
 *
 * Only the pure parser is exercised here: no registry and no advisory database is contacted.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseManifests } from "../lib/engines/dependencies";

function entriesOf(path: string, content: string) {
  const [manifest] = parseManifests([{ path, content }]);
  if (!manifest) throw new Error(`${path} produced no manifest`);
  return manifest.entries;
}

function manifestOf(path: string, content: string) {
  const [manifest] = parseManifests([{ path, content }]);
  if (!manifest) throw new Error(`${path} produced no manifest`);
  return manifest;
}

describe("parseManifests — routing", () => {
  test("only known manifest names are parsed, wherever they sit in the tree", () => {
    const manifests = parseManifests([
      { path: "package.json", content: "{}" },
      { path: "apps/web/package.json", content: "{}" },
      { path: "src/thing.json", content: "{}" },
      { path: "notes.txt", content: "hello" },
      { path: "requirements.txt", content: "flask==3.0.0\n" },
      { path: "backend/requirements.txt", content: "django==5.0.0\n" },
    ]);
    assert.deepEqual(
      manifests.map((manifest) => manifest.path),
      ["package.json", "apps/web/package.json", "requirements.txt", "backend/requirements.txt"],
      "only manifest file names produce a manifest, and their real path is kept",
    );
  });

  test("an empty file list yields no manifests", () => {
    assert.deepEqual(parseManifests([]), []);
  });
});

describe("parseManifests — npm", () => {
  const content = JSON.stringify({
    dependencies: { next: "15.5.26", react: "^19.3.0", pg: "~8.23.0" },
    devDependencies: { typescript: "*", vitest: "^3.0.0" },
    peerDependencies: { "react-dom": ">=18 <20" },
    optionalDependencies: { fsevents: "^2.3.3" },
  });

  test("reports the package manager and ecosystem", () => {
    const manifest = manifestOf("package.json", content);
    assert.equal(manifest.packageManager, "npm");
    assert.equal(manifest.ecosystem, "npm");
    assert.equal(manifest.path, "package.json");
  });

  test("collects dependencies, devDependencies, peerDependencies and optionalDependencies as direct", () => {
    const entries = entriesOf("package.json", content);
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      ["fsevents", "next", "pg", "react", "react-dom", "typescript", "vitest"],
      "every dependency section contributes entries",
    );
    for (const entry of entries) {
      assert.equal(entry.scope, "direct", `${entry.name} should be a direct dependency`);
    }
  });

  test("normalises caret, tilde, exact and range versions", () => {
    const entries = entriesOf("package.json", content);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("next")?.version, "15.5.26", "an exact version passes through");
    assert.equal(byName.get("next")?.unpinned, false, "an exact version is pinned");
    assert.equal(byName.get("react")?.version, "19.3.0", "the caret is stripped");
    assert.equal(byName.get("react")?.unpinned, true, "a caret range is not pinned");
    assert.equal(byName.get("pg")?.version, "8.23.0", "the tilde is stripped");
    assert.equal(byName.get("pg")?.unpinned, true);
    assert.equal(byName.get("typescript")?.version, "", "a `*` range has no usable version");
    assert.equal(byName.get("typescript")?.unpinned, true);
    assert.equal(byName.get("react-dom")?.version, "18", "a range resolves to its lowest bound");
    assert.equal(byName.get("react-dom")?.unpinned, true);
    assert.equal(byName.get("vitest")?.version, "3.0.0");
  });

  test("a malformed package.json yields an empty manifest instead of throwing", () => {
    const manifest = manifestOf("package.json", '{ "dependencies": { "react": ');
    assert.deepEqual(manifest.entries, []);
    assert.equal(manifest.packageManager, "npm");
  });

  test("package-lock.json reports transitive dependencies", () => {
    const lock = JSON.stringify({
      lockfileVersion: 2,
      dependencies: {
        express: { version: "4.18.2" },
        "left-pad": { version: "1.3.0" },
      },
    });
    const manifest = manifestOf("package-lock.json", lock);
    assert.equal(manifest.packageManager, "npm");
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.name, entry.version, entry.scope]),
      [
        ["express", "4.18.2", "transitive"],
        ["left-pad", "1.3.0", "transitive"],
      ],
    );
    assert.ok(manifest.entries.every((entry) => entry.unpinned === false), "lock entries are exact");
  });

  test("a lockfileVersion 3 `packages` tree is read as transitive dependencies", () => {
    // Regression: the parser used to skip every key starting with `node_modules/` — exactly how
    // npm v2/v3 name their packages — so a modern package-lock.json reported nothing. The
    // entries to skip are the workspace root ("") and local workspace packages.
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0" },
        "node_modules/express": { version: "4.18.2" },
        "node_modules/express/node_modules/ms": { version: "2.1.3" },
        "node_modules/@types/node": { version: "22.20.4" },
        "packages/local": { version: "0.0.1" },
      },
    });
    const entries = entriesOf("package-lock.json", lock);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["express", "ms", "@types/node"],
      "installed packages are dependencies; the root and local workspaces are not",
    );
    assert.ok(
      entries.every((entry) => entry.scope === "transitive" && entry.unpinned === false),
      "lock entries are exact and transitive",
    );
  });

  test("a malformed package-lock.json yields no entries", () => {
    assert.deepEqual(entriesOf("package-lock.json", "{ not json"), []);
  });
});

describe("parseManifests — pip", () => {
  test("requirements.txt keeps `==` pins and flags everything else as unpinned", () => {
    const content = [
      "# a comment",
      "Flask==3.0.1",
      "requests>=2.31.0",
      "uvicorn[standard]==0.30.1  # inline comment",
      "-r other-requirements.txt",
      "",
      "sqlalchemy",
    ].join("\n");
    const entries = entriesOf("requirements.txt", content);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.version, entry.unpinned, entry.scope]),
      [
        ["Flask", "3.0.1", false, "direct"],
        ["requests", "", true, "direct"],
        ["uvicorn", "0.30.1", false, "direct"],
        ["sqlalchemy", "", true, "direct"],
      ],
      "comments, -r includes and extras brackets must not corrupt the parse",
    );
    assert.equal(manifestOf("requirements.txt", content).ecosystem, "PyPI");
    assert.equal(manifestOf("requirements.txt", content).packageManager, "pip");
  });

  test("an empty requirements.txt yields no entries", () => {
    assert.deepEqual(entriesOf("requirements.txt", ""), []);
  });

  test("pyproject.toml reads the PEP 621 dependency list and the poetry section", () => {
    const content = `[project]
name = "app"
dependencies = [
  "django==4.2.0",
  "celery>=5.3",
]

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.110.0"
httpx = "0.27.0"
`;
    const entries = entriesOf("pyproject.toml", content);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("django")?.version, "4.2.0");
    assert.equal(byName.get("django")?.unpinned, false);
    assert.equal(byName.get("celery")?.version, "", "a `>=` constraint is not a pinned version");
    assert.equal(byName.get("celery")?.unpinned, true);
    assert.equal(byName.get("fastapi")?.version, "0.110.0", "the caret is stripped in poetry too");
    assert.equal(byName.get("fastapi")?.unpinned, true);
    assert.equal(byName.get("httpx")?.version, "0.27.0");
    assert.equal(byName.get("python"), undefined, "the interpreter constraint is not a package");
    assert.ok(entries.every((entry) => entry.scope === "direct"));
  });

  test("a malformed pyproject.toml yields no entries instead of throwing", () => {
    assert.deepEqual(entriesOf("pyproject.toml", "dependencies = [ oops"), []);
  });

  test("a bracketed extra does not truncate the PEP 621 dependency list", () => {
    // Regression: the dependency block was matched with a non-greedy `[…]`, so the first extra
    // (`psycopg[binary]`) ended the list early and every dependency after it disappeared.
    const content = `[project]
dependencies = [
  "django==4.2.0",
  "psycopg[binary]>=3.1",
  "redis==5.0.1",
]
`;
    const entries = entriesOf("pyproject.toml", content);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["django", "psycopg", "redis"],
      "an extra inside a quoted requirement is not the end of the array",
    );
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("django")?.version, "4.2.0");
    assert.equal(byName.get("redis")?.version, "5.0.1");
    assert.equal(byName.get("psycopg")?.unpinned, true, "a range is not a pin");
  });
});

describe("parseManifests — composer", () => {
  test("composer.json reports Packagist, skips php/ext-* and keeps dev requirements", () => {
    const content = JSON.stringify({
      require: { php: ">=8.1", "ext-json": "*", "laravel/framework": "^10.0", "guzzlehttp/guzzle": "7.8.1" },
      "require-dev": { "phpunit/phpunit": "10.5.1" },
    });
    const manifest = manifestOf("composer.json", content);
    assert.equal(manifest.packageManager, "composer");
    assert.equal(manifest.ecosystem, "Packagist");
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.name, entry.version]),
      [
        ["laravel/framework", "10.0"],
        ["guzzlehttp/guzzle", "7.8.1"],
        ["phpunit/phpunit", "10.5.1"],
      ],
      "platform requirements are not packages",
    );
    for (const entry of manifest.entries) assert.equal(entry.scope, "direct");
  });

  test("composer.lock reports transitive packages", () => {
    const content = JSON.stringify({
      packages: [{ name: "laravel/framework", version: "v10.48.0" }],
      "packages-dev": [{ name: "phpunit/phpunit", version: "10.5.1" }],
    });
    assert.deepEqual(
      entriesOf("composer.lock", content).map((entry) => [entry.name, entry.version, entry.scope]),
      [
        ["laravel/framework", "10.48.0", "transitive"],
        ["phpunit/phpunit", "10.5.1", "transitive"],
      ],
    );
  });

  test("a malformed composer.json yields no entries", () => {
    assert.deepEqual(entriesOf("composer.json", "{ broken"), []);
  });
});

describe("parseManifests — go and others", () => {
  test("go.mod reads module paths, direct and indirect", () => {
    const content = `module example.com/app

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	golang.org/x/text v0.14.0 // indirect
)
`;
    const manifest = manifestOf("go.mod", content);
    assert.equal(manifest.packageManager, "go");
    assert.equal(manifest.ecosystem, "Go");
    const byName = new Map(manifest.entries.map((entry) => [entry.name, entry]));
    assert.deepEqual(
      manifest.entries.map((entry) => entry.name),
      ["github.com/gin-gonic/gin", "golang.org/x/text"],
      "the require block is the parsed list",
    );
    assert.equal(byName.get("github.com/gin-gonic/gin")?.version, "1.9.1");
    assert.equal(byName.get("github.com/gin-gonic/gin")?.scope, "direct");
    assert.equal(byName.get("golang.org/x/text")?.scope, "transitive", "an indirect require is transitive");
    assert.equal(byName.get("example.com/app"), undefined, "the module line itself is not a dependency");
  });

  test("a single-line require is read", () => {
    // Regression: the pattern was anchored to the start of the line, so `require x/y v1.0.0`
    // (what `go mod tidy` writes when adding one module) was skipped — only the parenthesised
    // block was parsed.
    const content = `module example.com/app

go 1.22

require github.com/stretchr/testify v1.9.0
`;
    const entries = entriesOf("go.mod", content);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.version, entry.scope]),
      [["github.com/stretchr/testify", "1.9.0", "direct"]],
    );
  });

  test("pubspec.yaml reads the dependencies block", () => {
    const content = `name: app

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  provider: 6.1.2

dev_dependencies:
  flutter_test:
    sdk: flutter
`;
    const manifest = manifestOf("pubspec.yaml", content);
    assert.equal(manifest.packageManager, "pub");
    assert.equal(manifest.ecosystem, "Pub");
    const names = manifest.entries.map((entry) => entry.name);
    assert.ok(names.includes("http"), "a caret dependency is read");
    assert.ok(names.includes("provider"), "an exact dependency is read");
    assert.ok(!names.includes("flutter"), "the SDK constraint is skipped");
    assert.equal(manifest.entries.find((entry) => entry.name === "provider")?.unpinned, false);
    // Quirk: the pubspec parser treats a caret constraint as pinned (only a value that is
    // neither `^x.y.z` nor a plain number is flagged), unlike npm where `^` means unpinned.
    assert.equal(manifest.entries.find((entry) => entry.name === "http")?.unpinned, false);
    assert.equal(manifest.entries.find((entry) => entry.name === "http")?.version, "1.2.0");
  });

  test("Cargo.toml reads [dependencies] and Cargo.lock reads [[package]] blocks", () => {
    const toml = `[package]
name = "app"

[dependencies]
serde = "1.0.197"
axum = { version = "0.7.4", features = ["json"] }
`;
    const manifest = manifestOf("Cargo.toml", toml);
    assert.equal(manifest.packageManager, "cargo");
    assert.equal(manifest.ecosystem, "crates.io");
    const byName = new Map(manifest.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("serde")?.version, "1.0.197");
    assert.equal(byName.get("axum")?.version, "0.7.4", "a table form still yields the version");
    assert.ok(!byName.has("name"), "the [package] section is not a dependency");

    const lock = `[[package]]
name = "serde"
version = "1.0.197"

[[package]]
name = "axum"
version = "0.7.4"
`;
    assert.deepEqual(
      entriesOf("Cargo.lock", lock).map((entry) => [entry.name, entry.version, entry.scope]),
      [
        ["serde", "1.0.197", "transitive"],
        ["axum", "0.7.4", "transitive"],
      ],
    );
  });

  test("pom.xml reads groupId:artifactId coordinates", () => {
    const content = `<project><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.2.4</version></dependency>
  <dependency><groupId>com.example</groupId><artifactId>no-version</artifactId></dependency>
</dependencies></project>`;
    const manifest = manifestOf("pom.xml", content);
    assert.equal(manifest.packageManager, "maven");
    const byName = new Map(manifest.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("org.springframework.boot:spring-boot-starter-web")?.version, "3.2.4");
    assert.equal(
      byName.get("com.example:no-version")?.unpinned,
      true,
      "an inherited version is an unpinned dependency",
    );
  });

  test("Gemfile.lock reads the GEM specs section", () => {
    const content = `GEM
  remote: https://rubygems.org/
  specs:
    rails (7.1.3)
    puma (6.4.2)

PLATFORMS
  ruby
`;
    assert.deepEqual(
      entriesOf("Gemfile.lock", content).map((entry) => [entry.name, entry.version, entry.scope]),
      [
        ["rails", "7.1.3", "transitive"],
        ["puma", "6.4.2", "transitive"],
      ],
    );
    assert.equal(manifestOf("Gemfile.lock", content).ecosystem, "RubyGems");
  });

  test("parses every manifest in one call and keeps them separate", () => {
    const manifests = parseManifests([
      { path: "package.json", content: JSON.stringify({ dependencies: { next: "15.5.26" } }) },
      { path: "requirements.txt", content: "django==5.0.0\n" },
      { path: "go.mod", content: "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n" },
    ]);
    assert.deepEqual(
      manifests.map((manifest) => [manifest.packageManager, manifest.ecosystem, manifest.entries.length]),
      [
        ["npm", "npm", 1],
        ["pip", "PyPI", 1],
        ["go", "Go", 1],
      ],
    );
  });
});

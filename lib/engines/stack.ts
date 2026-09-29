import type { LanguageStat, RepoFile, StackInfo } from "../types";

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  php: "php",
  py: "python",
  pyw: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  go: "go",
  rs: "rust",
  swift: "swift",
  dart: "dart",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  vue: "vue",
  svelte: "svelte",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  bat: "shell",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  txt: "text",
  xml: "xml",
  csproj: "xml",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
  gradle: "gradle",
  proto: "protobuf",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  lua: "lua",
  pl: "perl",
  r: "r",
  m: "objectivec",
  mm: "objectivec",
  jsp: "jsp",
  twig: "twig",
  ejs: "ejs",
  pug: "pug",
  haml: "haml",
  lock: "text",
  edition: "text",
};

const SPECIAL_FILES: Record<string, string> = {
  Dockerfile: "dockerfile",
  "docker-compose.yml": "yaml",
  "docker-compose.yaml": "yaml",
  Makefile: "make",
  "package.json": "json",
  "package-lock.json": "json",
  "composer.json": "json",
  "composer.lock": "json",
  "tsconfig.json": "json",
  "go.mod": "go",
  "go.sum": "text",
  "Cargo.toml": "toml",
  "Cargo.lock": "toml",
  "pyproject.toml": "toml",
  "requirements.txt": "text",
  "pubspec.yaml": "yaml",
  "pubspec.lock": "yaml",
  "pom.xml": "xml",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  Gemfile: "ruby",
  "Gemfile.lock": "ruby",
  ".gitignore": "text",
  ".dockerignore": "text",
  ".env": "env",
  ".env.example": "env",
};

export function languageOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (SPECIAL_FILES[name]) return SPECIAL_FILES[name]!;
  if (/^Dockerfile(\..+)?$/.test(name)) return "dockerfile";
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "text";
  return LANGUAGE_BY_EXTENSION[name.slice(idx + 1).toLowerCase()] ?? "text";
}

export function isTestFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const lower = path.toLowerCase();
  if (/(^|\/)(__tests__|tests?|spec|e2e|integration)(\/|$)/.test(lower)) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(name)) return true;
  if (/_test\.(go|dart|rb|py|exs)$/i.test(name)) return true;
  if (/(Test|Tests|IT)\.(java|kt|cs)$/.test(name)) return true;
  if (/^test_.*\.py$/i.test(name)) return true;
  return false;
}

export function isMigrationFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(migrations?|database\/migrations|db\/migrate)(\/|$)/.test(lower) ||
    /\.sql$/.test(lower) ||
    /schema\.prisma$/.test(lower) ||
    /models?\.py$/.test(lower) && /django/i.test(lower)
  );
}

export function isUiFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /\.(tsx|jsx|vue|svelte)$/.test(lower) ||
    /(^|\/)(components?|pages|views|screens|widgets|ui)(\/|$)/.test(lower)
  );
}

function manifestText(files: RepoFile[], names: string[]): string | null {
  for (const name of names) {
    const file = files.find((candidate) => candidate.path === name || candidate.path.endsWith(`/${name}`));
    if (file?.content) return file.content;
  }
  return null;
}

function parseJson(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasFile(files: RepoFile[], matcher: (path: string) => boolean): boolean {
  return files.some((file) => matcher(file.path));
}

const FRAMEWORK_SIGNALS: { name: string; test: (ctx: { deps: Set<string>; files: RepoFile[] }) => boolean }[] = [
  { name: "Next.js", test: ({ deps, files }) => deps.has("next") || hasFile(files, (p) => p.startsWith("next.config")) },
  { name: "React", test: ({ deps }) => deps.has("react") },
  { name: "Vue", test: ({ deps }) => deps.has("vue") },
  { name: "Svelte", test: ({ deps, files }) => deps.has("svelte") || hasFile(files, (p) => p.endsWith("svelte.config.js")) },
  { name: "Angular", test: ({ deps }) => deps.has("@angular/core") },
  { name: "Express", test: ({ deps }) => deps.has("express") },
  { name: "Fastify", test: ({ deps }) => deps.has("fastify") },
  { name: "NestJS", test: ({ deps }) => deps.has("@nestjs/core") },
  { name: "Laravel", test: ({ deps, files }) => deps.has("laravel/framework") || hasFile(files, (p) => p === "artisan") },
  { name: "Symfony", test: ({ deps }) => deps.has("symfony/framework-bundle") },
  { name: "Django", test: ({ files }) => hasFile(files, (p) => p.endsWith("manage.py")) },
  { name: "FastAPI", test: ({ deps }) => deps.has("fastapi") },
  { name: "Flask", test: ({ deps }) => deps.has("flask") },
  { name: "Rails", test: ({ deps }) => deps.has("rails") },
  { name: "Spring Boot", test: ({ deps }) => deps.has("org.springframework.boot") },
  { name: "Flutter", test: ({ files }) => hasFile(files, (p) => p === "pubspec.yaml") },
  { name: "Gin", test: ({ deps }) => deps.has("github.com/gin-gonic/gin") },
  { name: "Actix", test: ({ deps }) => deps.has("actix-web") },
];

const TEST_FRAMEWORK_SIGNALS: { name: string; test: (ctx: { deps: Set<string>; files: RepoFile[] }) => boolean }[] = [
  { name: "Jest", test: ({ deps }) => deps.has("jest") || deps.has("ts-jest") },
  { name: "Vitest", test: ({ deps }) => deps.has("vitest") },
  { name: "Mocha", test: ({ deps }) => deps.has("mocha") },
  { name: "Jasmine/Karma", test: ({ deps }) => deps.has("karma") || deps.has("jasmine") },
  { name: "PHPUnit", test: ({ deps, files }) => deps.has("phpunit/phpunit") || hasFile(files, (p) => p.endsWith("phpunit.xml")) },
  { name: "Pest", test: ({ deps }) => deps.has("pestphp/pest") },
  { name: "Pytest", test: ({ deps, files }) => deps.has("pytest") || hasFile(files, (p) => p === "pytest.ini") },
  { name: "unittest", test: ({ files }) => hasFile(files, (p) => p.startsWith("tests/") && p.endsWith(".py")) },
  { name: "Flutter test", test: ({ files }) => hasFile(files, (p) => p.startsWith("test/") && p.endsWith("_test.dart")) },
  { name: "RSpec", test: ({ deps, files }) => deps.has("rspec") || hasFile(files, (p) => p === "spec/spec_helper.rb") },
  { name: "JUnit", test: ({ files }) => hasFile(files, (p) => /src\/test\/java/.test(p)) },
  { name: "Go test", test: ({ files }) => hasFile(files, (p) => p.endsWith("_test.go")) },
  { name: "xUnit/NUnit", test: ({ deps }) => deps.has("xunit") || deps.has("nunit") },
];

const DB_SIGNALS: { name: string; test: (ctx: { deps: Set<string>; files: RepoFile[]; pyContent: string }) => boolean }[] = [
  { name: "Prisma", test: ({ deps, files }) => deps.has("@prisma/client") || hasFile(files, (p) => p.endsWith("schema.prisma")) },
  { name: "Sequelize", test: ({ deps }) => deps.has("sequelize") },
  { name: "TypeORM", test: ({ deps }) => deps.has("typeorm") },
  { name: "Mongoose/MongoDB", test: ({ deps }) => deps.has("mongoose") || deps.has("mongodb") },
  { name: "Knex", test: ({ deps }) => deps.has("knex") },
  { name: "Drizzle", test: ({ deps }) => deps.has("drizzle-orm") },
  { name: "Eloquent (Laravel)", test: ({ deps }) => deps.has("laravel/framework") },
  { name: "SQLAlchemy", test: ({ deps, pyContent }) => deps.has("sqlalchemy") || /sqlalchemy/i.test(pyContent) },
  { name: "Django ORM", test: ({ pyContent }) => /django/i.test(pyContent) },
  { name: "PostgreSQL driver", test: ({ deps }) => deps.has("pg") || deps.has("psycopg2") || deps.has("psycopg2-binary") || deps.has("psycopg") },
  { name: "MySQL driver", test: ({ deps }) => deps.has("mysql2") || deps.has("mysqlclient") || deps.has("mysql") },
  { name: "SQLite", test: ({ deps, pyContent }) => deps.has("better-sqlite3") || deps.has("sqlite3") || /sqlite/i.test(pyContent) },
];

const API_SIGNALS: { name: string; test: (ctx: { deps: Set<string>; files: RepoFile[]; pyContent: string; phpContent: string }) => boolean }[] = [
  { name: "Express routes", test: ({ deps }) => deps.has("express") },
  { name: "Fastify routes", test: ({ deps }) => deps.has("fastify") },
  { name: "NestJS controllers", test: ({ deps }) => deps.has("@nestjs/core") },
  { name: "Next.js route handlers", test: ({ files }) => hasFile(files, (p) => /(^|\/)app\/.*route\.(ts|js)$/.test(p)) },
  { name: "Laravel routes", test: ({ deps, phpContent }) => deps.has("laravel/framework") || phpContent.includes("Route::") },
  { name: "Django urls", test: ({ files }) => hasFile(files, (p) => p.endsWith("urls.py")) },
  { name: "FastAPI routes", test: ({ deps }) => deps.has("fastapi") },
  { name: "Spring controllers", test: ({ deps }) => deps.has("org.springframework.boot") },
  { name: "Rails routes", test: ({ files }) => hasFile(files, (p) => p === "config/routes.rb") },
];

export function detectStack(files: RepoFile[]): StackInfo {
  const textFiles = files.filter((file) => file.text);

  const languages: LanguageStat[] = [];
  const byLanguage = new Map<string, LanguageStat>();
  for (const file of textFiles) {
    const existing = byLanguage.get(file.language) ?? { name: file.language, files: 0, loc: 0 };
    existing.files += 1;
    existing.loc += file.loc;
    byLanguage.set(file.language, existing);
  }
  languages.push(...Array.from(byLanguage.values()).sort((a, b) => b.loc - a.loc || b.files - a.files));

  const packageJson = parseJson(manifestText(files, ["package.json"]));
  const deps = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const values = packageJson?.[section] as Record<string, string> | undefined;
    if (values) for (const key of Object.keys(values)) deps.add(key);
  }

  const composer = parseJson(manifestText(files, ["composer.json"]));
  for (const section of ["require", "require-dev"]) {
    const values = composer?.[section] as Record<string, string> | undefined;
    if (values) for (const key of Object.keys(values)) deps.add(key);
  }

  const pyContent = manifestText(files, ["requirements.txt", "pyproject.toml", "Pipfile"]) ?? "";
  for (const line of pyContent.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9._-]+)\s*(?:[<>=!~]|$)/);
    if (match) deps.add(match[1]!.toLowerCase());
  }
  const goMod = manifestText(files, ["go.mod"]);
  if (goMod) {
    for (const line of goMod.split("\n")) {
      const match = line.match(/^\s*([a-z0-9.\-]+\/[^\s]+)\s+v/);
      if (match) deps.add(match[1]!);
    }
  }
  const cargo = manifestText(files, ["Cargo.toml"]);
  if (cargo) {
    const depSection = cargo.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
    if (depSection) {
      for (const line of depSection[1]!.split("\n")) {
        const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
        if (match) deps.add(match[1]!);
      }
    }
  }

  const phpContent = files
    .filter((file) => file.language === "php" && file.content && file.content.length < 60_000)
    .slice(0, 40)
    .map((file) => file.content ?? "")
    .join("\n");

  const manifests: string[] = [];
  const manifestNames = [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "composer.json",
    "composer.lock",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "poetry.lock",
    "pubspec.yaml",
    "pubspec.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
  ];
  for (const name of manifestNames) {
    const file = files.find((candidate) => candidate.path === name || candidate.path.endsWith(`/${name}`));
    if (file) manifests.push(file.path);
  }

  const packageManagers: string[] = [];
  if (hasFile(files, (p) => p.endsWith("pnpm-lock.yaml"))) packageManagers.push("pnpm");
  else if (hasFile(files, (p) => p.endsWith("yarn.lock"))) packageManagers.push("yarn");
  else if (hasFile(files, (p) => p.endsWith("package.json"))) packageManagers.push("npm");
  if (hasFile(files, (p) => p.endsWith("composer.json"))) packageManagers.push("composer");
  if (hasFile(files, (p) => p.endsWith("requirements.txt"))) packageManagers.push("pip");
  if (hasFile(files, (p) => p.endsWith("pyproject.toml"))) packageManagers.push("poetry/pyproject");
  if (hasFile(files, (p) => p.endsWith("Gemfile"))) packageManagers.push("bundler");
  if (hasFile(files, (p) => /pom\.xml$/.test(p))) packageManagers.push("maven");
  if (hasFile(files, (p) => /build\.gradle(\.kts)?$/.test(p))) packageManagers.push("gradle");
  if (hasFile(files, (p) => p.endsWith("go.mod"))) packageManagers.push("go modules");
  if (hasFile(files, (p) => p.endsWith("Cargo.toml"))) packageManagers.push("cargo");
  if (hasFile(files, (p) => p.endsWith("pubspec.yaml"))) packageManagers.push("pub");

  const frameworks = FRAMEWORK_SIGNALS.filter((signal) => signal.test({ deps, files })).map((s) => s.name);
  const testFrameworks = TEST_FRAMEWORK_SIGNALS.filter((signal) => signal.test({ deps, files })).map((s) => s.name);
  const databaseIndicators = DB_SIGNALS.filter((signal) => signal.test({ deps, files, pyContent })).map((s) => s.name);
  const apiSurface = API_SIGNALS.filter((signal) => signal.test({ deps, files, pyContent, phpContent })).map((s) => s.name);

  const buildTools: string[] = [];
  if (hasFile(files, (p) => /vite\.config\./.test(p))) buildTools.push("Vite");
  if (hasFile(files, (p) => /webpack\.config\./.test(p))) buildTools.push("Webpack");
  if (hasFile(files, (p) => /tsup\.config\./.test(p))) buildTools.push("tsup");
  if (hasFile(files, (p) => /rollup\.config\./.test(p))) buildTools.push("Rollup");
  if (deps.has("typescript")) buildTools.push("TypeScript");
  if (hasFile(files, (p) => p === "Makefile")) buildTools.push("Make");
  if (hasFile(files, (p) => /pom\.xml$/.test(p))) buildTools.push("Maven");
  if (hasFile(files, (p) => /build\.gradle(\.kts)?$/.test(p))) buildTools.push("Gradle");
  if (deps.has("turbo")) buildTools.push("Turborepo");
  if (deps.has("nx")) buildTools.push("Nx");

  const ciProviders: string[] = [];
  if (hasFile(files, (p) => p.startsWith(".github/workflows/"))) ciProviders.push("GitHub Actions");
  if (hasFile(files, (p) => p === ".gitlab-ci.yml")) ciProviders.push("GitLab CI");
  if (hasFile(files, (p) => p.startsWith(".circleci/"))) ciProviders.push("CircleCI");
  if (hasFile(files, (p) => p === "Jenkinsfile")) ciProviders.push("Jenkins");
  if (hasFile(files, (p) => p === ".travis.yml")) ciProviders.push("Travis CI");
  if (hasFile(files, (p) => p === "azure-pipelines.yml")) ciProviders.push("Azure Pipelines");
  if (hasFile(files, (p) => p === "bitbucket-pipelines.yml")) ciProviders.push("Bitbucket Pipelines");

  const totalLoc = languages.reduce((sum, item) => sum + item.loc, 0);

  return {
    languages: languages.slice(0, 12),
    frameworks,
    packageManagers,
    testFrameworks,
    buildTools,
    ciProviders,
    databaseIndicators,
    manifests,
    docker: hasFile(files, (p) => /(^|\/)Dockerfile(\..+)?$/.test(p) || /docker-compose\.ya?ml$/.test(p)),
    apiSurface,
    totalFiles: files.length,
    totalLoc,
  };
}

export function stackHighlights(stack: StackInfo): string[] {
  const highlights: string[] = [];
  if (stack.frameworks.length) highlights.push(stack.frameworks.slice(0, 3).join(" + "));
  if (stack.languages.length) highlights.push(stack.languages.slice(0, 3).map((l) => l.name).join(" / "));
  if (stack.databaseIndicators.length) highlights.push(stack.databaseIndicators.slice(0, 2).join(", "));
  if (stack.packageManagers.length) highlights.push(stack.packageManagers.slice(0, 2).join(", "));
  return highlights;
}

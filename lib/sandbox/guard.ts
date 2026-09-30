/**
 * The execution guard, embedded as source.
 *
 * It is written into every sandbox workspace and loaded with `--import` before the first test
 * file, so the hooks are in place before any project code is evaluated.
 *
 * Four layers, in order of strength:
 *
 *  1. Node's own permission model (`--permission`, no `--allow-fs-write`, only the workspace
 *     readable) — enforced by the runtime: filesystem writes, `child_process`, worker threads,
 *     native addons and `process.binding` cannot be patched back by project code.
 *  2. Prototype-level hooks (`net.Socket.prototype.connect`, `dgram.Socket.prototype.send`) —
 *     these sit under every higher-level client, so they hold even when project code imports the
 *     low-level functions as ESM named bindings.
 *  3. Module-object hooks (`fetch`, `WebSocket`, `dns`, `child_process`, …) — effective for the
 *     common `require`/default-import path and for the guards that have no prototype to hook.
 *  4. A scrubbed environment and a temporary workspace that is deleted afterwards.
 *
 * What this is not: an operating-system sandbox. A guard that lives inside the same process can
 * be outrun by a native addon or by ESM named bindings for the few guards with no prototype hook
 * (a `dns.lookup` import can still resolve a name; it cannot connect to anything). The audit
 * report states this limit instead of implying containment.
 */
export const GUARD_FILENAME = "codeaudit-sandbox-guard.mjs";

export const GUARD_SOURCE = String.raw`/**
 * CodeAudit execution guard — generated, do not edit.
 * Loaded with --import before any test file. Everything here is a denial hook, never a policy.
 */
const CODE = "CODEAUDIT_SANDBOX_BLOCKED";
const blocked = (what) =>
  function sandboxBlocked() {
    const error = new Error("codeaudit-sandbox: " + what + " is disabled in this run");
    error.code = CODE;
    throw error;
  };

const hooks = [];
const hook = (label, target, key) => {
  if (!target) return;
  try {
    target[key] = blocked(label + " (" + key + ")");
    hooks.push(label + "." + key);
  } catch {
    /* frozen namespace or getter-only export: nothing to do here */
  }
};

/* globals — truly global, so every import style sees them */
globalThis.fetch = blocked("outbound network (fetch)");
globalThis.WebSocket = blocked("outbound network (WebSocket)");
globalThis.EventSource = blocked("outbound network (EventSource)");
globalThis.XMLHttpRequest = blocked("outbound network (XMLHttpRequest)");
hooks.push("fetch", "WebSocket", "EventSource", "XMLHttpRequest");

/* prototypes — the chokepoint under every TCP/TLS/UDP client */
try {
  const net = (await import("node:net")).default;
  if (net && net.Socket && net.Socket.prototype) {
    net.Socket.prototype.connect = blocked("outbound network (Socket.connect)");
    hooks.push("net.Socket.prototype.connect");
  }
  hook("network", net, "connect");
  hook("network", net, "createConnection");
  hook("network", net, "createServer");
} catch {}

try {
  const tls = (await import("node:tls")).default;
  hook("tls", tls, "connect");
  hook("tls", tls, "createServer");
} catch {}

try {
  const dgram = (await import("node:dgram")).default;
  if (dgram && dgram.Socket && dgram.Socket.prototype) {
    for (const key of ["send", "sendto", "connect", "bind"]) {
      if (Object.getOwnPropertyDescriptor(dgram.Socket.prototype, key)) {
        dgram.Socket.prototype[key] = blocked("outbound network (dgram." + key + ")");
        hooks.push("dgram.Socket.prototype." + key);
      }
    }
  }
  hook("dgram", dgram, "createSocket");
  hook("dgram", dgram, "createServer");
} catch {}

try {
  const dns = (await import("node:dns")).default;
  for (const key of [
    "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname",
    "resolveMx", "resolveSrv", "resolveTxt", "resolveNs", "resolvePtr", "resolveSoa", "reverse",
  ]) {
    hook("dns", dns, key);
    hook("dns.promises", dns && dns.promises, key);
  }
} catch {}

try {
  const http = (await import("node:http")).default;
  hook("http", http, "request");
  hook("http", http, "get");
  hook("http", http, "createServer");
} catch {}

try {
  const https = (await import("node:https")).default;
  hook("https", https, "request");
  hook("https", https, "get");
} catch {}

try {
  const http2 = (await import("node:http2")).default;
  hook("http2", http2, "connect");
  hook("http2", http2, "createConnection");
  hook("http2", http2, "createServer");
} catch {}

/* process escape hatches (the permission model already denies them; this makes the failure clear) */
try {
  const child = (await import("node:child_process")).default;
  for (const key of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) {
    hook("child_process", child, key);
  }
} catch {}

try {
  const workers = (await import("node:worker_threads")).default;
  hook("worker_threads", workers, "Worker");
} catch {}

try {
  const cluster = (await import("node:cluster")).default;
  hook("cluster", cluster, "fork");
} catch {}

try {
  const inspectors = (await import("node:inspector")).default;
  hook("inspector", inspectors, "open");
} catch {}

Object.defineProperty(globalThis, "__CODEAUDIT_SANDBOX__", {
  value: Object.freeze({ mode: "restricted-process", hooks: hooks.length }),
  enumerable: false,
  writable: false,
  configurable: false,
});
`;

import { getSessionUser, type SessionUser } from "./auth";

let warned = false;

/**
 * Session lookup that never throws: before the project database is ready (or after a
 * cold start that cannot reach it) we simply treat the visitor as signed out instead of
 * breaking every page.
 */
export async function getSessionUserSafe(): Promise<SessionUser | null> {
  try {
    return await getSessionUser();
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error("[session] lookup failed:", error instanceof Error ? error.message : error);
    }
    return null;
  }
}

export async function dbUnavailable<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error("[db] query failed:", error instanceof Error ? error.message : error);
    return fallback;
  }
}

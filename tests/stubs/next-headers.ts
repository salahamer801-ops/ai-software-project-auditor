/** Test double for `next/headers` / `next/cache` — the functions only exist in Next. */

export function headers(): never {
  throw new Error("headers() is not available outside the Next server");
}

export function cookies(): never {
  throw new Error("cookies() is not available outside the Next server");
}

export function draftMode(): never {
  throw new Error("draftMode() is not available outside the Next server");
}

export function revalidatePath(): void {
  /* no-op in tests */
}

export function revalidateTag(): void {
  /* no-op in tests */
}

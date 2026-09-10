import { expect, expectTypeOf, it, vi } from "vitest";
import { constrainFetch } from "./utils.js";

it("constrains native fetch to a single Request argument", async () => {
  const response = Response.json({ ok: true });
  const fetchFn = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => response,
  );
  const requestFetch = constrainFetch(fetchFn);
  const request = new Request("https://example.com", {
    method: "POST",
    body: JSON.stringify({ value: 42 }),
  });

  expectTypeOf<typeof window.fetch>().toExtend<
    Parameters<typeof constrainFetch>[0]
  >();
  expectTypeOf(requestFetch).toEqualTypeOf<
    (request: Request) => Promise<Response>
  >();
  // @ts-expect-error The adapter requires a Request rather than a URL string.
  expectTypeOf(requestFetch).toBeCallableWith("https://example.com");
  // @ts-expect-error Request options belong in the Request itself.
  expectTypeOf(requestFetch).toBeCallableWith(request, { method: "GET" });

  await expect(requestFetch(request)).resolves.toBe(response);
  expect(fetchFn).toHaveBeenCalledExactlyOnceWith(request);
});

import { assert, describe, expect, expectTypeOf, it } from "vitest";
import { createClient } from "../client.js";
import { serverEndpoint } from "../server.js";
import type { ContractResponse } from "../types.js";
import { exampleContract } from "./contract.js";
import { exampleHandler } from "./serverHandler.js";

describe("example end-to-end", () => {
  it("round-trips the auth response from the merged contract", async () => {
    const endpoint = serverEndpoint()
      .contract(exampleContract)
      .handler(async () => ({ status: 403, body: { error: "auth_please" } }));
    const fetchExample = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => endpoint.fetchWithContext(request, {}),
    }).contract(exampleContract);

    const response = await fetchExample({
      params: { pathParam: 42 },
      query: { queryParam: "a" },
      body: { requestParam: true },
      headers: new Headers(),
    });

    expect(response).toEqual({
      status: 403,
      body: { error: "auth_please" },
    });
    if (response.status === 403) {
      expectTypeOf(response.body).toEqualTypeOf<{ error: "auth_please" }>();
    }
  });

  it("round-trips a typed request through HTTP JSON and the server handler", async () => {
    const expectedBody = {
      hi: "Hello",
      pathParam: 42.5,
      queryParam: "b",
      requestParam: true,
    };
    const fetchExample = createClient({
      baseUrl: "https://example.com",
      fetch: async (request) => {
        assert(request instanceof Request);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://example.com/test/42.5?queryParam=b");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.clone().json()).toEqual({ requestParam: true });

        const response = await exampleHandler.fetchWithContext(request, {});

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.clone().json()).toEqual(expectedBody);
        return response;
      },
    }).contract(exampleContract);

    expectTypeOf(fetchExample).returns.resolves.toEqualTypeOf<
      ContractResponse<typeof exampleHandler.definition.responses>
    >();

    const response = await fetchExample({
      params: { pathParam: 42.5 },
      query: { queryParam: "b" },
      body: { requestParam: true },
      headers: new Headers(),
    });

    expect(response).toEqual({ status: 200, body: expectedBody });
    if (response.status === 200) {
      expectTypeOf(response.body.pathParam).toEqualTypeOf<number>();
      expectTypeOf(response.body.requestParam).toEqualTypeOf<boolean>();
    }
  });

  it("returns the server's declared business error through the client", async () => {
    const fetchExample = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => exampleHandler.fetchWithContext(request, {}),
    }).contract(exampleContract);

    const response = await fetchExample({
      params: { pathParam: 42 },
      query: { queryParam: "a" },
      body: { requestParam: false },
      headers: new Headers(),
    });

    expect(response).toEqual({
      status: 400,
      body: { error: "requestParam must be true" },
    });
    if (response.status === 400) {
      expectTypeOf(response.body).toEqualTypeOf<{ error: string }>();
    }
  });
});

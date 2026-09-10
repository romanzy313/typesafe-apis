import { describe, expect, expectTypeOf, it } from "vitest";
import { createClient } from "../client.js";
import { exampleContract } from "./contract.js";
import { exampleHandler } from "./serverHandler.js";

describe("example end-to-end", () => {
  it("round-trips a typed request through HTTP JSON and the server handler", async () => {
    const expectedBody = {
      hi: "Hello",
      pathParam: 42.5,
      queryParam: "b",
      requestParam: true,
    };
    const fetchExample = createClient({
      baseUrl: "https://example.com",
      doRequest: async (request) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://example.com/test/42.5?queryParam=b");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.clone().json()).toEqual({ requestParam: true });

        const response = await exampleHandler.fetch(request);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.clone().json()).toEqual(expectedBody);
        return response;
      },
    }).contract(exampleContract);

    expectTypeOf(fetchExample).toEqualTypeOf<typeof exampleHandler.handler>();

    const response = await fetchExample({
      params: { pathParam: 42.5 },
      query: { queryParam: "b" },
      body: { requestParam: true },
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
      doRequest: exampleHandler.fetch,
    }).contract(exampleContract);

    const response = await fetchExample({
      params: { pathParam: 42 },
      query: { queryParam: "a" },
      body: { requestParam: false },
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

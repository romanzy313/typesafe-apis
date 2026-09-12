import { assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createClient, type ClientResponse } from "../client.js";
import { SidechannelError, sidechannelHeaderKey } from "../sidechannel.js";
import type { ContractResponse } from "../types.js";
import { exampleContract } from "./contract.js";
import { exampleAuthService, type ServerEnvironment } from "./dependencies.js";
import { exampleComposedMiddleware } from "./middleware.js";
import { exampleEndpoint } from "./server.js";

const input = {
  params: { pathParam: 42.5 },
  query: { queryParam: "b" as const },
  body: { requestParam: true },
};

function createExampleClient(env: ServerEnvironment) {
  return createClient({
    baseUrl: "https://example.com",
    fetch: (request) => exampleEndpoint.fetchWithContext(request, env),
  }).contract(exampleContract);
}

describe("example end-to-end", () => {
  it("round-trips auth, merged middleware, inline middleware, and the handler", async () => {
    expectTypeOf(exampleComposedMiddleware)
      .parameter(1)
      .parameter(0)
      .toMatchTypeOf<{
        compose1: boolean;
        compose2: boolean;
      }>();
    const authService = exampleAuthService();
    const lookup = vi
      .spyOn(authService, "getUserIdByBearer")
      .mockResolvedValue("resolved-user");
    const expectedBody = {
      userId: "resolved-user",
      pathParam: 42.5,
      queryParam: "b",
      requestParam: true,
    };
    const call = createClient({
      baseUrl: "https://example.com",
      fetch: async (request) => {
        assert(request instanceof Request);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://example.com/test/42.5?queryParam=b");
        expect(request.headers.get("authorization")).toBe(
          "Bearer example-token",
        );
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.clone().json()).toEqual({ requestParam: true });
        const response = await exampleEndpoint.fetchWithContext(request, {
          authService,
        });
        expect(response.status).toBe(200);
        expect(await response.clone().json()).toEqual(expectedBody);
        return response;
      },
    }).contract(exampleContract);
    expectTypeOf(call).returns.resolves.toEqualTypeOf<
      ClientResponse<
        ContractResponse<typeof exampleEndpoint.definition.responses>
      >
    >();

    const headers = { authorization: "Bearer example-token" };
    const response = await call(input, { headers });
    expect(response).toEqual({
      status: 200,
      body: expectedBody,
      headers: expect.any(Headers),
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith("example-token");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers.has("authorization")).toBe(false);
    expect(response.headers.get("x-compose1")).toBe("true");
    expect(response.headers.get("x-compose2")).toBe("true");
    expect(headers).toEqual({ authorization: "Bearer example-token" });
    if (response.status === 200) {
      expectTypeOf(response.body.userId).toEqualTypeOf<string>();
      expectTypeOf(response.body.pathParam).toEqualTypeOf<number>();
    }
  });

  it.each([
    { authorization: undefined, bearer: undefined },
    { authorization: "", bearer: undefined },
    { authorization: "Basic example-user", bearer: undefined },
    { authorization: "Bearer", bearer: undefined },
    { authorization: "Bearer user extra", bearer: undefined },
    { authorization: "Bearer ", bearer: undefined },
    { authorization: "Bearer fail", bearer: "fail" },
  ])(
    "returns auth_please for authorization=$authorization",
    async ({ authorization, bearer }) => {
      const authService = exampleAuthService();
      const lookup = vi.spyOn(authService, "getUserIdByBearer");
      const call = createExampleClient({ authService });
      const response = await call(input, {
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(response).toEqual({
        status: 403,
        body: { error: "auth_please" },
        headers: expect.any(Headers),
      });
      expect(response.headers.has("x-request-id")).toBe(false);
      expect(response.headers.has("x-compose1")).toBe(false);
      expect(response.headers.has("x-compose2")).toBe(false);
      expect(response.headers.has(sidechannelHeaderKey)).toBe(false);
      if (bearer === undefined) expect(lookup).not.toHaveBeenCalled();
      else expect(lookup).toHaveBeenCalledExactlyOnceWith(bearer);
      if (response.status === 403) {
        expectTypeOf(response.body).toEqualTypeOf<
          Readonly<{ error: "auth_please" }>
        >();
      }
    },
  );

  it("returns a business error after authentication and preserves the request ID", async () => {
    const call = createExampleClient({ authService: exampleAuthService() });
    const response = await call(
      { ...input, body: { requestParam: false } },
      {
        headers: { authorization: "Bearer example-user" },
      },
    );
    expect(response).toEqual({
      status: 400,
      body: { error: "requestParam must be true" },
      headers: expect.any(Headers),
    });
    expect(response.headers.get("x-request-id")).toBeTypeOf("string");
    expect(response.headers.has(sidechannelHeaderKey)).toBe(false);
    if (response.status === 400) {
      expectTypeOf(response.body).toEqualTypeOf<Readonly<{ error: string }>>();
    }
  });

  it("isolates authentication variables and request IDs across concurrent requests", async () => {
    const call = createExampleClient({ authService: exampleAuthService() });
    const responses = await Promise.all(
      ["first-user", "second-user"].map((userId) =>
        call(input, { headers: { authorization: `Bearer ${userId}` } }),
      ),
    );
    expect(responses.map((response) => response.body)).toEqual([
      {
        userId: "first-user",
        pathParam: 42.5,
        queryParam: "b",
        requestParam: true,
      },
      {
        userId: "second-user",
        pathParam: 42.5,
        queryParam: "b",
        requestParam: true,
      },
    ]);
    const requestIds = responses.map((response) =>
      response.headers.get("x-request-id"),
    );
    expect(requestIds.every((requestId) => typeof requestId === "string")).toBe(
      true,
    );
    expect(new Set(requestIds).size).toBe(2);
  });

  it("throws a remote internal error for authentication service failures", async () => {
    const error = new Error("Authentication service unavailable");
    const authService = exampleAuthService();
    vi.spyOn(authService, "getUserIdByBearer").mockRejectedValue(error);
    const call = createExampleClient({ authService });
    const result = call(input, {
      headers: { authorization: "Bearer example-user" },
    });
    await expect(result).rejects.toBeInstanceOf(SidechannelError);
    const failure = await result.catch((error: unknown) => error);
    assert(failure instanceof SidechannelError);
    expect(failure.kind).toBe("internal_server_error");
    expect(failure.response.status).toBe(500);
    expect(await failure.response.json()).toEqual({
      error: "internal_server_error",
    });
  });

  it("throws a remote codec error when the server receives invalid JSON data", async () => {
    const call = createClient({
      baseUrl: "https://example.com",
      fetch: (request) =>
        exampleEndpoint.fetchWithContext(
          new Request(request, {
            body: JSON.stringify({ requestParam: "invalid" }),
          }),
          { authService: exampleAuthService() },
        ),
    }).contract(exampleContract);

    const result = call(input);
    await expect(result).rejects.toBeInstanceOf(SidechannelError);
    const failure = await result.catch((error: unknown) => error);
    assert(failure instanceof SidechannelError);
    expect(failure.kind).toBe("codec_error");
    expect(failure.response.status).toBe(400);
    expect(await failure.response.json()).toMatchInlineSnapshot(`
      {
        "error": "codec_error",
        "issues": [
          {
            "code": "invalid_type",
            "expected": "boolean",
            "message": "Invalid input: expected boolean, received string",
            "path": [
              "requestParam",
            ],
          },
        ],
        "message": "Bad request",
      }
    `);
  });

  it("throws internal error when a service produces an invalid response value", async () => {
    const authService = exampleAuthService();
    // @ts-expect-error Simulate a service returning an invalid user ID at runtime.
    vi.spyOn(authService, "getUserIdByBearer").mockResolvedValue(42);
    const call = createExampleClient({ authService });

    const result = call(input, {
      headers: { authorization: "Bearer example-user" },
    });
    await expect(result).rejects.toBeInstanceOf(SidechannelError);
    const failure = await result.catch((error: unknown) => error);
    assert(failure instanceof SidechannelError);
    expect(failure.kind).toBe("internal_server_error");
    expect(failure.response.status).toBe(500);
    expect(await failure.response.json()).toMatchInlineSnapshot(`
      {
        "error": "internal_server_error",
      }
    `);
  });
});

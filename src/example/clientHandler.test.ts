import { describe, expect, expectTypeOf, it } from "vitest";
import z from "zod";
import { exampleContract } from "./contract.js";
import { serverContractHandler } from "../server.js";
import { exampleHandler } from "./serverHandler.js";
import type { Codec } from "../types.js";
import { zodCodec } from "../codec.js";

function createRequest(
  pathParam = "42",
  queryParam = "a",
  body: unknown = { requestParam: true },
) {
  return new Request(
    `https://example.com/test/${pathParam}?queryParam=${queryParam}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("example", () => {
  it("serves the successful JSON response using the shared contract", async () => {
    const response = await exampleHandler.fetch(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hi: "Hello",
      pathParam: 42,
      queryParam: "a",
      requestParam: true,
    });
  });

  it("serves the declared business error response", async () => {
    const response = await exampleHandler.fetch(
      createRequest("42", "b", { requestParam: false }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "requestParam must be true",
    });
  });

  it("supports testing the typed handler directly", async () => {
    const response = await exampleHandler.handler({
      params: { pathParam: 7 },
      query: { queryParam: "b" },
      body: { requestParam: true },
    });

    expect(response).toEqual({
      status: 200,
      body: {
        hi: "Hello",
        pathParam: 7,
        queryParam: "b",
        requestParam: true,
      },
    });
  });

  it("uses the same path codec in both directions", () => {
    expect(exampleContract.params.decode({ pathParam: "42.5" })).toEqual({
      pathParam: 42.5,
    });
    expect(exampleContract.params.encode({ pathParam: 42.5 })).toEqual({
      pathParam: "42.5",
    });
  });

  it.each([
    { name: "path", path: "invalid", query: "a", body: { requestParam: true } },
    {
      name: "numeric prefix",
      path: "42abc",
      query: "a",
      body: { requestParam: true },
    },
    { name: "query", path: "42", query: "c", body: { requestParam: true } },
    { name: "missing body field", path: "42", query: "a", body: {} },
    {
      name: "body type",
      path: "42",
      query: "a",
      body: { requestParam: "true" },
    },
  ])("rejects invalid $name values", async ({ path, query, body }) => {
    await expect(
      exampleHandler.fetch(createRequest(path, query, body)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it.each([200, 400] as const)(
    "validates the response body for status %s at runtime",
    async (status) => {
      const untypedHandler = async () => ({ status, body: {} });
      // @ts-expect-error Simulate an untyped caller returning an invalid body.
      const endpoint = serverContractHandler(exampleContract, untypedHandler);

      await expect(endpoint.fetch(createRequest())).rejects.toBeInstanceOf(
        z.ZodError,
      );
    },
  );
});

describe("example types", () => {
  it("preserves schema output types through the codec adapter", () => {
    const codec = zodCodec(z.stringbool());

    expectTypeOf(codec).toEqualTypeOf<Codec<boolean>>();
    expectTypeOf(exampleContract.params.decode).returns.toEqualTypeOf<{
      pathParam: number;
    }>();
    expectTypeOf(exampleContract.query.decode).returns.toEqualTypeOf<{
      queryParam: "a" | "b";
    }>();
    expectTypeOf(exampleContract.request.decode).returns.toEqualTypeOf<{
      requestParam: boolean;
    }>();
  });

  it("infers handler arguments and the complete response union", () => {
    expectTypeOf(exampleHandler.handler).parameter(0).toEqualTypeOf<{
      params: { pathParam: number };
      query: { queryParam: "a" | "b" };
      body: { requestParam: boolean };
    }>();
    expectTypeOf(exampleHandler.handler).returns.resolves.toEqualTypeOf<
      | {
          status: 200;
          body: {
            hi: string;
            pathParam: number;
            queryParam: string;
            requestParam: boolean;
          };
        }
      | { status: 400; body: { error: string } }
    >();
  });

  it("rejects the original example's missing response field", () => {
    // @ts-expect-error The success body requires hi, not notWorking.
    serverContractHandler(exampleContract, async (req) => ({
      status: 200,
      body: {
        notWorking: "",
        pathParam: req.params.pathParam,
        queryParam: req.query.queryParam,
        requestParam: req.body.requestParam,
      },
    }));
  });
});

import { describe, expect, expectTypeOf, it } from "vitest";
import z from "zod";
import { exampleContract } from "./contract.js";
import { serverEndpoint } from "../server.js";
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
    const response = await exampleHandler.fetchWithContext(createRequest(), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hi: "Hello",
      pathParam: 42,
      queryParam: "a",
      requestParam: true,
    });
  });

  it("returns a typed business error without HTTP serialization", async () => {
    const response = await exampleHandler.handle(
      {
        params: { pathParam: 42 },
        query: { queryParam: "b" },
        body: { requestParam: false },
      },
      {},
    );

    expect(response).toEqual({
      status: 400,
      body: { error: "requestParam must be true" },
    });
  });

  it("uses the same path codec in both directions", () => {
    const { params } = exampleContract.definition;
    expect(params.decode({ pathParam: "42.5" })).toEqual({
      pathParam: 42.5,
    });
    expect(params.encode({ pathParam: 42.5 })).toEqual({
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
      exampleHandler.fetchWithContext(createRequest(path, query, body), {}),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it.each([200, 400] as const)(
    "validates the response body for status %s at runtime",
    async (status) => {
      const untypedHandler = async () => ({ status, body: {} });
      const builder = serverEndpoint().contract(exampleContract);
      // @ts-expect-error Simulate an untyped caller returning an invalid body.
      const endpoint = builder.handler(untypedHandler);

      await expect(
        endpoint.fetchWithContext(createRequest(), {}),
      ).rejects.toBeInstanceOf(z.ZodError);
    },
  );
});

describe("example types", () => {
  it("preserves schema output types through the codec adapter", () => {
    const codec = zodCodec(z.stringbool());
    const { definition } = exampleContract;

    expectTypeOf(codec).toEqualTypeOf<Codec<boolean>>();
    expectTypeOf(definition.params.decode).returns.toEqualTypeOf<{
      pathParam: number;
    }>();
    expectTypeOf(definition.query.decode).returns.toEqualTypeOf<{
      queryParam: "a" | "b";
    }>();
    expectTypeOf(definition.request.decode).returns.toEqualTypeOf<{
      requestParam: boolean;
    }>();
  });

  it("infers handler arguments and the complete response union", () => {
    expectTypeOf(exampleHandler.handle).parameter(0).toEqualTypeOf<{
      params: { pathParam: number };
      query: { queryParam: "a" | "b" };
      body: { requestParam: boolean };
    }>();
    expectTypeOf(exampleHandler.handle).returns.resolves.toEqualTypeOf<
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
    serverEndpoint().contract(exampleContract).handler(async (req) => ({
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

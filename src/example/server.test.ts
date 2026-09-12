import { describe, expect, expectTypeOf, it } from "vitest";
import z from "zod";
import { zodCodec } from "../codec.js";
import { compileContract } from "../contract.js";
import { serverEndpoint } from "../server.js";
import { getSidechannelHeader } from "../sidechannel.js";
import type { Codec, RequestContextInput } from "../types.js";
import { exampleContract } from "./contract.js";
import {
  exampleAuthService,
  type ExampleAuthServiceEnvironment,
} from "./dependencies.js";
import { exampleEndpoint, exampleServer } from "./server.js";

const env: ExampleAuthServiceEnvironment = {
  authService: exampleAuthService(),
};

function createRequest(
  pathParam = "42",
  queryParam = "a",
  body: unknown = { requestParam: true },
) {
  return new Request(
    `https://example.com/test/${pathParam}?queryParam=${queryParam}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer example-user",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("example", () => {
  it("serves the successful JSON response using the shared contract", async () => {
    const response = await exampleEndpoint.fetchWithContext(
      createRequest(),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: "example-user",
      pathParam: 42,
      queryParam: "a",
      requestParam: true,
    });
  });

  it("returns a typed business error without HTTP serialization", async () => {
    const response = await exampleEndpoint.handle({
      req: {
        params: { pathParam: 42 },
        query: { queryParam: "b" },
        body: { requestParam: false },
        headers: new Headers({ authorization: "Bearer example-user" }),
      },
      env,
    });

    expect(response).toEqual({
      status: 400,
      body: { error: "requestParam must be true" },
    });
  });

  it("uses the same path codec in both directions", () => {
    const { params } = compileContract(exampleContract);
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
  ])("reports invalid $name values", async ({ path, query, body }) => {
    const response = await exampleEndpoint.fetchWithContext(
      createRequest(path, query, body),
      env,
    );
    expect(response.status).toBe(400);
    expect(getSidechannelHeader(response)).toBe("codec_error");
    expect((await response.json()).message).toBe("Bad request");
  });

  it.each([200, 400, 403] as const)(
    "validates the response body for status %s at runtime",
    async (status) => {
      const untypedHandler = async () => ({ status, body: {} });
      const builder = exampleServer.contract(exampleContract);
      // @ts-expect-error Simulate an untyped caller returning an invalid body.
      const endpoint = builder.handler(untypedHandler);

      const response = await endpoint.fetchWithContext(createRequest(), env);
      expect(response.status).toBe(500);
      expect(getSidechannelHeader(response)).toBe("internal_server_error");
      expect(await response.json()).toEqual({
        error: "internal_server_error",
      });
    },
  );
});

describe("example types", () => {
  it("preserves schema output types through the codec adapter", () => {
    const codec = zodCodec(z.stringbool());
    const definition = compileContract(exampleContract);

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
    expectTypeOf(exampleEndpoint.handle)
      .parameter(0)
      .toEqualTypeOf<
        RequestContextInput<
          { pathParam: number },
          { queryParam: "a" | "b" },
          { requestParam: boolean },
          ExampleAuthServiceEnvironment
        >
      >();
    expectTypeOf(exampleEndpoint.handle).returns.resolves.toEqualTypeOf<
      | {
          status: 200;
          body: {
            userId: string;
            pathParam: number;
            queryParam: string;
            requestParam: boolean;
          };
        }
      | { status: 400; body: { error: string } }
      | { status: 403; body: { error: "auth_please" } }
    >();
  });

  it("rejects the original example's missing response field", () => {
    const builder = serverEndpoint().contract(exampleContract);
    // @ts-expect-error The success body requires userId, not notWorking.
    builder.handler(async ({ req }) => ({
      status: 200,
      body: {
        notWorking: "",
        pathParam: req.params.pathParam,
        queryParam: req.query.queryParam,
        requestParam: req.body.requestParam,
      },
    }));
  });

  it("requires the auth error literal for status 403", () => {
    const builder = serverEndpoint().contract(exampleContract);
    // @ts-expect-error The auth contract requires the literal auth_please.
    builder.handler(async () => ({ status: 403, body: { error: "other" } }));
  });
});

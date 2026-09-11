import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { zodCodec } from "./codec.js";
import { compileContract, contract, type InferResponses } from "./contract.js";
import {
  contractHandler,
  serverEndpoint,
  type ServerEndpoint,
} from "./server.js";
import type {
  RequestContextInput,
  ServerRequest,
  StatusCode,
} from "./types.js";

const date = new Date("2026-09-09T12:00:00.000Z");

function createContract(path = "/items/:id") {
  const stringToNumber = z.codec(z.string(), z.number(), {
    decode: Number,
    encode: String,
  });
  const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString(),
  });
  const c = contract()
    .method("POST")
    .path(path, zodCodec(z.object({ id: stringToNumber })))
    .query(zodCodec(z.object({ filter: z.enum(["a", "b"]) })))
    .request(zodCodec(z.object({ enabled: z.boolean() })))
    .response(200, zodCodec(isoDatetimeToDate))
    .response(400, zodCodec(z.object({ error: z.string() })));

  vi.spyOn(compileContract(c).params, "decode").mockReturnValue({ id: 42 });
  vi.spyOn(compileContract(c).query, "decode").mockReturnValue({ filter: "a" });
  vi.spyOn(compileContract(c).request, "decode").mockReturnValue({
    enabled: true,
  });
  vi.spyOn(compileContract(c).responses[200], "encode");
  vi.spyOn(compileContract(c).responses[200], "decode").mockReturnValue(date);
  vi.spyOn(compileContract(c).responses[400], "encode");
  vi.spyOn(compileContract(c).responses[400], "decode").mockReturnValue({
    error: "Invalid item",
  });
  return c;
}

function createRequest(url = "https://example.com/items/42?filter=a") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
}

function inputsFrom(c: ReturnType<typeof createContract>) {
  const definition = compileContract(c);
  return contract()
    .method(definition.method)
    .path(definition.path, definition.params)
    .query(definition.query)
    .request(definition.request);
}

describe("serverEndpoint", () => {
  it("handles typed requests with a supplied base context", async () => {
    const incoming = new Headers({ "x-client": "example" });
    const responseState = {
      headers: new Headers({ "x-base": "seed" }),
    };
    const endpoint = contractHandler(createContract(), async ({ req, res }) => {
      expectTypeOf(res.headers).toEqualTypeOf<Headers>();
      expect(res).toBe(responseState);
      expect(req.headers).toBe(incoming);
      res.headers.set("x-client-seen", req.headers.get("x-client")!);
      return { status: 200, body: date };
    });

    const response = await endpoint.handle({
      req: {
        params: { id: 7 },
        query: { filter: "b" },
        body: { enabled: true },
        headers: incoming,
      },
      env: {},
      res: responseState,
    });

    expect(response).toEqual({ status: 200, body: date });
    expect([...responseState.headers]).toEqual([
      ["x-base", "seed"],
      ["x-client-seen", "example"],
    ]);
    expect([...incoming]).toEqual([["x-client", "example"]]);
  });

  it("handles decoded values without running transport codecs", async () => {
    const c = createContract();
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverEndpoint().contract(c).handler(handler);
    const request: Parameters<typeof endpoint.handle>[0]["req"] = {
      params: { id: 7 },
      query: { filter: "b" },
      body: { enabled: false },
      headers: new Headers(),
    };

    const response = await endpoint.handle({ req: request, env: {} });

    expect(handler).toHaveBeenCalledExactlyOnceWith({
      req: request,
      env: {},
      res: { headers: new Headers() },
      vars: {},
    });
    expect(response).toEqual({ status: 200, body: date });
    expect(response.body).toBe(date);
    expect(compileContract(c).params.decode).not.toHaveBeenCalled();
    expect(compileContract(c).query.decode).not.toHaveBeenCalled();
    expect(compileContract(c).request.decode).not.toHaveBeenCalled();
    expect(compileContract(c).responses[200].encode).not.toHaveBeenCalled();
    expect(compileContract(c).responses[400].encode).not.toHaveBeenCalled();
  });

  it("decodes requests and encodes responses with the selected codec", async () => {
    const c = createContract();
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(handler);

    const response = await endpoint.fetchWithContext(createRequest(), {});

    expect(endpoint.definition).toEqual(compileContract(c));
    expect(endpoint.definition.method).toBe("POST");
    expect(endpoint.definition.path).toBe("/items/:id");
    expect(endpoint).not.toHaveProperty("method");
    expect(endpoint).not.toHaveProperty("path");
    expect(compileContract(c).params.decode).toHaveBeenCalledExactlyOnceWith({
      id: "42",
    });
    expect(compileContract(c).query.decode).toHaveBeenCalledExactlyOnceWith({
      filter: "a",
    });
    expect(compileContract(c).request.decode).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      req: {
        params: { id: 42 },
        query: { filter: "a" },
        body: { enabled: true },
        headers: new Headers({ "content-type": "application/json" }),
      },
      env: {},
      res: { headers: new Headers() },
      vars: {},
    });
    expect(
      compileContract(c).responses[200].encode,
    ).toHaveBeenCalledExactlyOnceWith(date);
    expect(compileContract(c).responses[200].decode).not.toHaveBeenCalled();
    expect(compileContract(c).responses[400].encode).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toBe(date.toISOString());
  });

  it("uses the error response codec for status 400", async () => {
    const c = createContract();
    const body = { error: "Invalid item" };
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async () => ({
      status: 400,
      body,
    }));

    const response = await endpoint.fetchWithContext(createRequest(), {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(body);
    expect(
      compileContract(c).responses[400].encode,
    ).toHaveBeenCalledExactlyOnceWith(body);
    expect(compileContract(c).responses[200].encode).not.toHaveBeenCalled();
  });

  it("supports a contract declaring only status 201", async () => {
    const original = createContract();
    const c = inputsFrom(original).response(
      201,
      compileContract(original).responses[200],
    );
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async () => ({
      status: 201,
      body: date,
    }));

    const response = await endpoint.fetchWithContext(createRequest(), {});

    expect(response.status).toBe(201);
    expect(await response.json()).toBe(date.toISOString());
    expectTypeOf(endpoint.handle).returns.resolves.toEqualTypeOf<{
      status: 201;
      body: Date;
    }>();
  });

  it.each([404, 500] as const)(
    "supports status %s in a contract declaring only error responses",
    async (status) => {
      const original = createContract();
      const c = inputsFrom(original)
        .response(404, compileContract(original).responses[400])
        .response(500, compileContract(original).responses[400]);
      const body = { error: "Request failed" };
      const builder = serverEndpoint().contract(c);
      const endpoint = builder.handler(async () => ({ status, body }));

      const response = await endpoint.fetchWithContext(createRequest(), {});

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    },
  );

  it("rejects undeclared statuses returned by an untyped handler", async () => {
    const handler = async () => ({
      status: 500 as const,
      body: { error: "Request failed" },
    });
    const builder = serverEndpoint().contract(createContract());
    // @ts-expect-error Status 500 is standard but absent from this contract.
    const endpoint = builder.handler(handler);

    await expect(
      endpoint.fetchWithContext(createRequest(), {}),
    ).rejects.toThrow("No encoder for status 500");
  });

  it("extracts multiple decoded path parameters and query values", async () => {
    const c = createContract("/groups/:group/items/:id");
    const endpoint = serverEndpoint()
      .contract(c)
      .handler(async () => ({ status: 200, body: date }));

    await endpoint.fetchWithContext(
      createRequest(
        "https://example.com/groups/a%2Fb/items/hello%20world" +
          "?filter=hello+world&extra=a%2Fb",
      ),
      {},
    );

    expect(compileContract(c).params.decode).toHaveBeenCalledExactlyOnceWith({
      group: "a/b",
      id: "hello world",
    });
    expect(compileContract(c).query.decode).toHaveBeenCalledExactlyOnceWith({
      filter: "hello world",
      extra: "a/b",
    });
  });

  it("passes an absent GET body to the request codec as undefined", async () => {
    const c = createContract();
    const request = zodCodec(z.undefined());
    vi.spyOn(request, "decode");
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverEndpoint()
      .contract(
        contract()
          .method("GET")
          .path("/items", compileContract(c).params)
          .query(compileContract(c).query)
          .request(request)
          .response(200, compileContract(c).responses[200]),
      )
      .handler(handler);

    await endpoint.fetchWithContext(
      new Request("https://example.com/items"),
      {},
    );

    expect(compileContract(c).params.decode).toHaveBeenCalledExactlyOnceWith(
      {},
    );
    expect(compileContract(c).query.decode).toHaveBeenCalledExactlyOnceWith({});
    expect(request.decode).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      req: {
        params: { id: 42 },
        query: { filter: "a" },
        body: undefined,
        headers: new Headers(),
      },
      env: {},
      res: { headers: new Headers() },
      vars: {},
    });
  });

  it.each(["params", "query", "request"] as const)(
    "propagates %s decoding failures before calling the handler",
    async (part) => {
      const c = createContract();
      const error = new Error(`Invalid ${part}`);
      vi.mocked(compileContract(c)[part].decode).mockImplementation(() => {
        throw error;
      });
      const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
      const builder = serverEndpoint().contract(c);
      const endpoint = builder.handler(handler);

      await expect(endpoint.fetchWithContext(createRequest(), {})).rejects.toBe(
        error,
      );
      expect(handler).not.toHaveBeenCalled();
      expect(compileContract(c).responses[200].encode).not.toHaveBeenCalled();
      expect(compileContract(c).responses[400].encode).not.toHaveBeenCalled();
    },
  );

  it.each(["/other/42", "/items", "/items/", "/items/42/extra"])(
    "rejects a mismatched path: %s",
    async (path) => {
      const c = createContract();
      const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
      const builder = serverEndpoint().contract(c);
      const endpoint = builder.handler(handler);

      await expect(
        endpoint.fetchWithContext(
          createRequest(`https://example.com${path}`),
          {},
        ),
      ).rejects.toThrow("Request path does not match /items/:id");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON before calling the handler", async () => {
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverEndpoint()
      .contract(createContract())
      .handler(handler);

    await expect(
      endpoint.fetchWithContext(
        new Request("https://example.com/items/42", {
          method: "POST",
          body: "{",
        }),
        {},
      ),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates handler failures without encoding a response", async () => {
    const c = createContract();
    const error = new Error("Handler failed");
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async () => {
      throw error;
    });

    await expect(endpoint.fetchWithContext(createRequest(), {})).rejects.toBe(
      error,
    );
    expect(compileContract(c).responses[200].encode).not.toHaveBeenCalled();
    expect(compileContract(c).responses[400].encode).not.toHaveBeenCalled();
  });

  it("propagates response encoding failures", async () => {
    const c = createContract();
    const error = new Error("Invalid response");
    vi.mocked(compileContract(c).responses[200].encode).mockImplementation(
      () => {
        throw error;
      },
    );
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async () => ({
      status: 200,
      body: date,
    }));

    await expect(endpoint.fetchWithContext(createRequest(), {})).rejects.toBe(
      error,
    );
  });
});

describe("serverEndpoint types", () => {
  it("keeps server input readonly and server output mutable", async () => {
    const c = contract()
      .method("POST")
      .path("/items/:id", zodCodec(z.object({ id: z.string() })))
      .query(zodCodec(z.object({ filter: z.string() })))
      .request(zodCodec(z.object({ name: z.string() })))
      .response(200, zodCodec(z.object({ name: z.string() })));
    const endpoint = serverEndpoint<{ prefix: string }>()
      .contract(c)
      .use<{ user: string }>(async (context, next) => {
        expectTypeOf(context.vars).toEqualTypeOf<Readonly<{}>>();
        if (false) {
          // @ts-expect-error The request reference is readonly.
          context.req = context.req;
          // @ts-expect-error Request parts are readonly.
          context.req.params = { id: "changed" };
          // @ts-expect-error Decoded parameter fields are readonly.
          context.req.params.id = "changed";
          // @ts-expect-error Decoded query fields are readonly.
          context.req.query.filter = "changed";
          // @ts-expect-error Decoded body fields are readonly.
          context.req.body.name = "changed";
          // @ts-expect-error The incoming header collection cannot be replaced.
          context.req.headers = new Headers();
          // @ts-expect-error Incoming headers expose no set method.
          context.req.headers.set("x-test", "changed");
          // @ts-expect-error Incoming headers expose no append method.
          context.req.headers.append("x-test", "changed");
          // @ts-expect-error Incoming headers expose no delete method.
          context.req.headers.delete("x-test");
          context.req.headers.forEach((_value, _key, headers) => {
            // @ts-expect-error Iteration cannot expose mutable headers either.
            headers.set("x-test", "changed");
          });
          // @ts-expect-error Environment fields are readonly.
          context.env.prefix = "changed";
          // @ts-expect-error Variables are extended through next.
          context.vars = { user: "changed" };
        }
        context.res.headers.set("x-before", "set");
        return next({ user: "Ada" });
      })
      .handler(async (context) => {
        expect([...context.req.headers]).toEqual([]);
        if (false) {
          // @ts-expect-error Established variable fields are readonly.
          context.vars.user = "changed";
        }
        context.res.headers = new Headers({ "x-user": context.vars.user });
        context.res.headers.append("x-test", "set");
        context.res.headers.delete("x-test");
        return {
          status: 200,
          body: { name: context.env.prefix + context.req.body.name },
        };
      });
    const res = { headers: new Headers() };
    const response = await endpoint.handle({
      req: {
        params: { id: "one" },
        query: { filter: "active" },
        body: { name: "item" },
      },
      env: { prefix: "new " },
      res,
    });
    expect(response).toEqual({ status: 200, body: { name: "new item" } });
    expect(res.headers.get("x-user")).toBe("Ada");
    response.status = 200;
    response.body.name = "updated";
    response.body = { name: "replaced" };
    expect(response.body.name).toBe("replaced");
  });

  it("accepts Hono status codes and excludes codes outside its declaration", () => {
    expectTypeOf<
      100 | 103 | 207 | 226 | 308 | 418 | 425 | 451 | 507 | 511
    >().toExtend<StatusCode>();
    expectTypeOf<
      Extract<StatusCode, 99 | 104 | 209 | 309 | 419 | 509 | 600>
    >().toBeNever();
  });

  it("infers response bodies only for the declared subset", () => {
    const original = createContract();
    const c = inputsFrom(original)
      .response(201, compileContract(original).responses[200])
      .response(503, compileContract(original).responses[400]);
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async ({ req }) => {
      if (req.body.enabled) {
        return { status: 201, body: date };
      }
      return { status: 503, body: { error: "Unavailable" } };
    });

    expectTypeOf(endpoint.handle).returns.resolves.toEqualTypeOf<
      { status: 201; body: Date } | { status: 503; body: { error: string } }
    >();

    // @ts-expect-error Status 200 is not declared by this contract.
    builder.handler(async () => ({ status: 200, body: date }));

    // @ts-expect-error Status 201 requires a Date, not the error body.
    builder.handler(async () => ({
      status: 201,
      body: { error: "x" },
    }));

    // @ts-expect-error Status 503 requires the error body, not a Date.
    builder.handler(async () => ({ status: 503, body: date }));
  });

  it("rejects response declarations with status codes absent from Hono", () => {
    const original = createContract();
    // @ts-expect-error Status 104 is absent from Hono's StatusCode.
    original.response(104, compileContract(original).responses[200]);
  });

  it("infers decoded request values and status-specific response bodies", () => {
    const c = createContract();
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async ({ req }) => {
      expectTypeOf(req).toEqualTypeOf<
        ServerRequest<
          { id: number },
          { filter: "a" | "b" },
          { enabled: boolean }
        >
      >();

      if (req.body.enabled) {
        return { status: 200, body: date };
      }
      return { status: 400, body: { error: "Disabled" } };
    });

    expectTypeOf(endpoint).toEqualTypeOf<
      ServerEndpoint<
        { id: number },
        { filter: "a" | "b" },
        { enabled: boolean },
        InferResponses<typeof c>,
        {},
        "POST"
      >
    >();
    expectTypeOf(endpoint.definition.params.decode).returns.toEqualTypeOf<{
      id: number;
    }>();
    expectTypeOf(
      endpoint.definition.responses[200].decode,
    ).returns.toEqualTypeOf<Date>();
    expectTypeOf<
      Parameters<typeof builder.handler>[0]
    >().returns.resolves.toEqualTypeOf<
      { status: 200; body: Date } | { status: 400; body: { error: string } }
    >();
    expectTypeOf(endpoint.handle).parameters.toEqualTypeOf<
      [
        RequestContextInput<
          { id: number },
          { filter: "a" | "b" },
          { enabled: boolean },
          {}
        >,
      ]
    >();
    expectTypeOf(endpoint.handle).returns.resolves.toEqualTypeOf<
      { status: 200; body: Date } | { status: 400; body: { error: string } }
    >();
    const validRequest: Parameters<typeof endpoint.handle>[0]["req"] = {
      params: { id: 42 },
      query: { filter: "a" },
      body: { enabled: true },
      headers: new Headers(),
    };
    expectTypeOf(endpoint.handle).toBeCallableWith({
      req: validRequest,
      env: {},
    });
    expectTypeOf(endpoint.handle).toBeCallableWith({
      // @ts-expect-error handle requires decoded numeric parameters.
      req: { ...validRequest, params: { id: "42" } },
      env: {},
    });
    expectTypeOf(endpoint.handle).toBeCallableWith({
      // @ts-expect-error handle only accepts the declared query values.
      req: { ...validRequest, query: { filter: "c" } },
      env: {},
    });
    expectTypeOf(endpoint.handle).toBeCallableWith({
      // @ts-expect-error handle requires the declared request body.
      req: { ...validRequest, body: {} },
      env: {},
    });
    expectTypeOf(endpoint.fetchWithContext).toEqualTypeOf<
      (request: Request, env: Readonly<{}>) => Promise<Response>
    >();
    const request = createRequest();
    // @ts-expect-error Native Requests must go through fetchWithContext.
    expectTypeOf(endpoint.handle).toBeCallableWith({ req: request, env: {} });
    const url = new URL(request.url);
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(request, {});
    // @ts-expect-error The endpoint requires a Request, not a URL string.
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(request.url, {});
    // @ts-expect-error The endpoint requires a Request, not a URL object.
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(url, {});
    const options = { method: "POST" };
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(
      request,
      {},
      // @ts-expect-error Request options must be supplied to the Request itself.
      options,
    );
  });

  it("narrows the response body by status", async () => {
    const endpoint = serverEndpoint()
      .contract(createContract())
      .handler(async () => ({ status: 200, body: date }));
    const response = await endpoint.handle({
      req: {
        params: { id: 42 },
        query: { filter: "a" },
        body: { enabled: true },
        headers: new Headers(),
      },
      env: {},
    });

    if (response.status === 200) {
      expectTypeOf(response.body).toEqualTypeOf<Date>();
    } else {
      expectTypeOf(response.body).toEqualTypeOf<{ error: string }>();
    }
  });

  it("rejects invalid handlers without widening the contract", () => {
    const c = createContract();
    const builder = serverEndpoint().contract(c);

    // @ts-expect-error Status 201 is not declared by the contract.
    builder.handler(async () => ({ status: 201, body: date }));

    // @ts-expect-error Status 200 requires a Date, not the error body.
    builder.handler(async () => ({
      status: 200,
      body: { error: "x" },
    }));

    // @ts-expect-error Status 400 requires the error body, not a Date.
    builder.handler(async () => ({ status: 400, body: date }));

    // @ts-expect-error The error response body must contain an error string.
    builder.handler(async () => ({ status: 400, body: {} }));

    // @ts-expect-error The decoded path parameter is a number.
    builder.handler(async (_context: { req: { params: { id: string } } }) => ({
      status: 200,
      body: date,
    }));
  });
});

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";
import { contractHandler, serverEndpoint, type ServerEndpoint } from "./server.js";
import type { RequestContext, StatusCode, TypedRequest } from "./types.js";

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

  vi.spyOn(c.definition.params, "decode").mockReturnValue({ id: 42 });
  vi.spyOn(c.definition.query, "decode").mockReturnValue({ filter: "a" });
  vi.spyOn(c.definition.request, "decode").mockReturnValue({ enabled: true });
  vi.spyOn(c.definition.responses[200], "encode");
  vi.spyOn(c.definition.responses[200], "decode").mockReturnValue(date);
  vi.spyOn(c.definition.responses[400], "encode");
  vi.spyOn(c.definition.responses[400], "decode").mockReturnValue({
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

describe("serverEndpoint", () => {
  it("handles typed requests with a supplied base context", async () => {
    const incoming = new Headers({ "x-client": "example" });
    const requestContext: RequestContext = {
      headers: new Headers({ "x-base": "seed" }),
    };
    const endpoint = contractHandler(
      createContract(),
      async (req, _server: Readonly<{}>, context) => {
        expectTypeOf(context).toEqualTypeOf<RequestContext>();
        expect(context).toBe(requestContext);
        expect(req.headers).toBe(incoming);
        context.headers.set("x-client-seen", req.headers.get("x-client")!);
        return { status: 200, body: date };
      },
    );

    const response = await endpoint.handle(
      {
        params: { id: 7 },
        query: { filter: "b" },
        body: { enabled: true },
        headers: incoming,
      },
      {},
      requestContext,
    );

    expect(response).toEqual({ status: 200, body: date });
    expect([...requestContext.headers]).toEqual([
      ["x-base", "seed"],
      ["x-client-seen", "example"],
    ]);
    expect([...incoming]).toEqual([["x-client", "example"]]);
  });

  it("handles decoded values without running transport codecs", async () => {
    const c = createContract();
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverEndpoint().contract(c).handler(handler);
    const request: Parameters<typeof endpoint.handle>[0] = {
      params: { id: 7 },
      query: { filter: "b" },
      body: { enabled: false },
      headers: new Headers(),
    };

    const response = await endpoint.handle(request, {});

    expect(handler).toHaveBeenCalledExactlyOnceWith(request, {}, {
      headers: new Headers(),
    });
    expect(response).toEqual({ status: 200, body: date });
    expect(response.body).toBe(date);
    expect(c.definition.params.decode).not.toHaveBeenCalled();
    expect(c.definition.query.decode).not.toHaveBeenCalled();
    expect(c.definition.request.decode).not.toHaveBeenCalled();
    expect(c.definition.responses[200].encode).not.toHaveBeenCalled();
    expect(c.definition.responses[400].encode).not.toHaveBeenCalled();
  });

  it("decodes requests and encodes responses with the selected codec", async () => {
    const c = createContract();
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(handler);

    const response = await endpoint.fetchWithContext(createRequest(), {});

    expect(endpoint.definition).toBe(c.definition);
    expect(endpoint.definition.route.method).toBe("POST");
    expect(endpoint.definition.route.path).toBe("/items/:id");
    expect(endpoint).not.toHaveProperty("method");
    expect(endpoint).not.toHaveProperty("path");
    expect(c.definition.params.decode).toHaveBeenCalledExactlyOnceWith({
      id: "42",
    });
    expect(c.definition.query.decode).toHaveBeenCalledExactlyOnceWith({
      filter: "a",
    });
    expect(c.definition.request.decode).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      {
        params: { id: 42 },
        query: { filter: "a" },
        body: { enabled: true },
        headers: new Headers({ "content-type": "application/json" }),
      },
      {},
      { headers: new Headers() },
    );
    expect(c.definition.responses[200].encode).toHaveBeenCalledExactlyOnceWith(
      date,
    );
    expect(c.definition.responses[200].decode).not.toHaveBeenCalled();
    expect(c.definition.responses[400].encode).not.toHaveBeenCalled();
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
    expect(c.definition.responses[400].encode).toHaveBeenCalledExactlyOnceWith(
      body,
    );
    expect(c.definition.responses[200].encode).not.toHaveBeenCalled();
  });

  it("supports a contract declaring only status 201", async () => {
    const original = createContract();
    const c = {
      definition: {
        ...original.definition,
        responses: { 201: original.definition.responses[200] },
      },
    };
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async () => ({
      status: 201,
      body: date,
    }));

    const response = await endpoint.fetchWithContext(createRequest(), {});

    expect(response.status).toBe(201);
    expect(await response.json()).toBe(date.toISOString());
    expectTypeOf(endpoint.handle)
      .returns.resolves.toEqualTypeOf<{ status: 201; body: Date }>();
  });

  it.each([404, 500] as const)(
    "supports status %s in a contract declaring only error responses",
    async (status) => {
      const original = createContract();
      const c = {
        definition: {
          ...original.definition,
          responses: {
            404: original.definition.responses[400],
            500: original.definition.responses[400],
          },
        },
      };
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

    expect(c.definition.params.decode).toHaveBeenCalledExactlyOnceWith({
      group: "a/b",
      id: "hello world",
    });
    expect(c.definition.query.decode).toHaveBeenCalledExactlyOnceWith({
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
      .contract({
        definition: {
          ...c.definition,
          route: { method: "GET", path: "/items" },
          request,
        },
      })
      .handler(handler);

    await endpoint.fetchWithContext(
      new Request("https://example.com/items"),
      {},
    );

    expect(c.definition.params.decode).toHaveBeenCalledExactlyOnceWith({});
    expect(c.definition.query.decode).toHaveBeenCalledExactlyOnceWith({});
    expect(request.decode).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      {
        params: { id: 42 },
        query: { filter: "a" },
        body: undefined,
        headers: new Headers(),
      },
      {},
      { headers: new Headers() },
    );
  });

  it.each(["params", "query", "request"] as const)(
    "propagates %s decoding failures before calling the handler",
    async (part) => {
      const c = createContract();
      const error = new Error(`Invalid ${part}`);
      vi.mocked(c.definition[part].decode).mockImplementation(() => {
        throw error;
      });
      const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
      const builder = serverEndpoint().contract(c);
      const endpoint = builder.handler(handler);

      await expect(
        endpoint.fetchWithContext(createRequest(), {}),
      ).rejects.toBe(error);
      expect(handler).not.toHaveBeenCalled();
      expect(c.definition.responses[200].encode).not.toHaveBeenCalled();
      expect(c.definition.responses[400].encode).not.toHaveBeenCalled();
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
    expect(c.definition.responses[200].encode).not.toHaveBeenCalled();
    expect(c.definition.responses[400].encode).not.toHaveBeenCalled();
  });

  it("propagates response encoding failures", async () => {
    const c = createContract();
    const error = new Error("Invalid response");
    vi.mocked(c.definition.responses[200].encode).mockImplementation(() => {
      throw error;
    });
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
    const c = {
      definition: {
        ...original.definition,
        responses: {
          201: original.definition.responses[200],
          503: original.definition.responses[400],
        },
      },
    };
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async (req) => {
      if (req.body.enabled) {
        return { status: 201, body: date };
      }
      return { status: 503, body: { error: "Unavailable" } };
    });

    expectTypeOf(endpoint.handle)
      .returns.resolves.toEqualTypeOf<
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

  it("rejects response maps containing status codes absent from Hono", () => {
    const original = createContract();
    const invalid = {
      definition: {
        ...original.definition,
        responses: {
          ...original.definition.responses,
          104: original.definition.responses[200],
        },
      },
    };

    // @ts-expect-error Status 104 is absent from Hono's StatusCode.
    original.response(104, original.definition.responses[200]);

    serverEndpoint()
      // @ts-expect-error Direct handler construction also rejects status 104.
      .contract(invalid)
      .handler(async () => ({ status: 200, body: date }));
  });

  it("infers decoded request values and status-specific response bodies", () => {
    const c = createContract();
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async (req) => {
      expectTypeOf(req).toEqualTypeOf<
        TypedRequest<
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
        typeof c.definition.responses,
        {}
      >
    >();
    expectTypeOf(endpoint.definition.params.decode).returns.toEqualTypeOf<{
      id: number;
    }>();
    expectTypeOf(endpoint.definition.responses[200].decode)
      .returns.toEqualTypeOf<Date>();
    expectTypeOf<Parameters<typeof builder.handler>[0]>()
      .returns.resolves.toEqualTypeOf<
        { status: 200; body: Date } | { status: 400; body: { error: string } }
      >();
    expectTypeOf(endpoint.handle).parameters.toEqualTypeOf<[
      TypedRequest<{ id: number }, { filter: "a" | "b" }, { enabled: boolean }>,
      Readonly<{}>,
      (RequestContext | undefined)?,
    ]>();
    expectTypeOf(endpoint.handle).returns.resolves.toEqualTypeOf<
      { status: 200; body: Date } | { status: 400; body: { error: string } }
    >();
    const typedRequest: Parameters<typeof endpoint.handle>[0] = {
      params: { id: 42 },
      query: { filter: "a" },
      body: { enabled: true },
      headers: new Headers(),
    };
    expectTypeOf(endpoint.handle).toBeCallableWith(typedRequest, {});
    expectTypeOf(endpoint.handle).toBeCallableWith(
      // @ts-expect-error handle requires decoded numeric parameters.
      { ...typedRequest, params: { id: "42" } },
      {},
    );
    expectTypeOf(endpoint.handle).toBeCallableWith(
      // @ts-expect-error handle only accepts the declared query values.
      { ...typedRequest, query: { filter: "c" } },
      {},
    );
    expectTypeOf(endpoint.handle).toBeCallableWith(
      // @ts-expect-error handle requires the declared request body.
      { ...typedRequest, body: {} },
      {},
    );
    expectTypeOf(endpoint.fetchWithContext).toEqualTypeOf<
      (request: Request, serverContext: Readonly<{}>) => Promise<Response>
    >();
    const request = createRequest();
    // @ts-expect-error Native Requests must go through fetchWithContext.
    expectTypeOf(endpoint.handle).toBeCallableWith(request, {});
    const url = new URL(request.url);
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(request, {});
    // @ts-expect-error The endpoint requires a Request, not a URL string.
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(request.url, {});
    // @ts-expect-error The endpoint requires a Request, not a URL object.
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(url, {});
    const options = { method: "POST" };
    // @ts-expect-error Request options must be supplied to the Request itself.
    expectTypeOf(endpoint.fetchWithContext).toBeCallableWith(request, {}, options);
  });

  it("narrows the response body by status", async () => {
    const endpoint = serverEndpoint()
      .contract(createContract())
      .handler(async () => ({ status: 200, body: date }));
    const response = await endpoint.handle(
      {
        params: { id: 42 },
        query: { filter: "a" },
        body: { enabled: true },
        headers: new Headers(),
      },
      {},
    );

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
    builder.handler(async (_req: { params: { id: string } }) => ({
      status: 200,
      body: date,
    }));
  });
});

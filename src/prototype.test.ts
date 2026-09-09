import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  contract,
  serverContractHandler,
  type Codec,
  type StatusCode,
  type TypedRequest,
} from "./prototype.js";

const date = new Date("2026-09-09T12:00:00.000Z");

function createContract() {
  return contract({
    method: "POST",
    path: "/items/:id",
    params: {
      encode: (value: { id: number }) => ({ id: String(value.id) }),
      decode: vi.fn((_value: unknown) => ({ id: 42 })),
    },
    query: {
      encode: (value: { filter: "a" | "b" }) => value,
      decode: vi.fn((_value: unknown): { filter: "a" | "b" } => ({
        filter: "a",
      })),
    },
    request: {
      encode: (value: { enabled: boolean }) => value,
      decode: vi.fn((_value: unknown) => ({ enabled: true })),
    },
    responses: {
      200: {
        encode: vi.fn((value: Date) => value.toISOString()),
        decode: vi.fn((_value: unknown) => date),
      },
      400: {
        encode: vi.fn((value: { error: string }) => value),
        decode: vi.fn((_value: unknown) => ({ error: "Invalid item" })),
      },
    },
  });
}

function createRequest(url = "https://example.com/items/42?filter=a") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
}

describe("serverContractHandler", () => {
  it("decodes requests and encodes responses with the selected codec", async () => {
    const c = createContract();
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverContractHandler(c, handler);

    const response = await endpoint.fetch(createRequest());

    expect(endpoint.method).toBe("POST");
    expect(endpoint.path).toBe("/items/:id");
    expect(endpoint.handler).toBe(handler);
    expect(c.params.decode).toHaveBeenCalledExactlyOnceWith({ id: "42" });
    expect(c.query.decode).toHaveBeenCalledExactlyOnceWith({ filter: "a" });
    expect(c.request.decode).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      params: { id: 42 },
      query: { filter: "a" },
      body: { enabled: true },
    });
    expect(c.responses[200].encode).toHaveBeenCalledExactlyOnceWith(date);
    expect(c.responses[200].decode).not.toHaveBeenCalled();
    expect(c.responses[400].encode).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toBe(date.toISOString());
  });

  it("uses the error response codec for status 400", async () => {
    const c = createContract();
    const body = { error: "Invalid item" };
    const endpoint = serverContractHandler(c, async () => ({
      status: 400,
      body,
    }));

    const response = await endpoint.fetch(createRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(body);
    expect(c.responses[400].encode).toHaveBeenCalledExactlyOnceWith(body);
    expect(c.responses[200].encode).not.toHaveBeenCalled();
  });

  it("supports a contract declaring only status 201", async () => {
    const original = createContract();
    const c = contract({
      ...original,
      responses: { 201: original.responses[200] },
    });
    const endpoint = serverContractHandler(c, async () => ({
      status: 201,
      body: date,
    }));

    const response = await endpoint.fetch(createRequest());

    expect(response.status).toBe(201);
    expect(await response.json()).toBe(date.toISOString());
    expectTypeOf(endpoint.handler).returns.resolves.toEqualTypeOf<{
      status: 201;
      body: Date;
    }>();
  });

  it.each([404, 500] as const)(
    "supports status %s in a contract declaring only error responses",
    async (status) => {
      const original = createContract();
      const c = contract({
        ...original,
        responses: {
          404: original.responses[400],
          500: original.responses[400],
        },
      });
      const body = { error: "Request failed" };
      const endpoint = serverContractHandler(c, async () => ({ status, body }));

      const response = await endpoint.fetch(createRequest());

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    },
  );

  it("rejects undeclared statuses returned by an untyped handler", async () => {
    const handler = async () => ({
      status: 500 as const,
      body: { error: "Request failed" },
    });
    // @ts-expect-error Status 500 is standard but absent from this contract.
    const endpoint = serverContractHandler(createContract(), handler);

    await expect(endpoint.fetch(createRequest())).rejects.toThrow(
      "No encoder for status 500",
    );
  });

  it("extracts multiple decoded path parameters and query values", async () => {
    const c = createContract();
    const endpoint = serverContractHandler(
      { ...c, path: "/groups/:group/items/:id" },
      async () => ({ status: 200, body: date }),
    );

    await endpoint.fetch(
      createRequest(
        "https://example.com/groups/a%2Fb/items/hello%20world" +
          "?filter=hello+world&extra=a%2Fb",
      ),
    );

    expect(c.params.decode).toHaveBeenCalledExactlyOnceWith({
      group: "a/b",
      id: "hello world",
    });
    expect(c.query.decode).toHaveBeenCalledExactlyOnceWith({
      filter: "hello world",
      extra: "a/b",
    });
  });

  it("passes an absent GET body to the request codec as undefined", async () => {
    const c = createContract();
    const request: Codec<undefined> = {
      encode: (value) => value,
      decode: vi.fn((_value: unknown) => undefined),
    };
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverContractHandler(
      { ...c, method: "GET", path: "/items", request },
      handler,
    );

    await endpoint.fetch(new Request("https://example.com/items"));

    expect(c.params.decode).toHaveBeenCalledExactlyOnceWith({});
    expect(c.query.decode).toHaveBeenCalledExactlyOnceWith({});
    expect(request.decode).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      params: { id: 42 },
      query: { filter: "a" },
      body: undefined,
    });
  });

  it.each(["params", "query", "request"] as const)(
    "propagates %s decoding failures before calling the handler",
    async (part) => {
      const c = createContract();
      const error = new Error(`Invalid ${part}`);
      c[part].decode.mockImplementation(() => {
        throw error;
      });
      const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
      const endpoint = serverContractHandler(c, handler);

      await expect(endpoint.fetch(createRequest())).rejects.toBe(error);
      expect(handler).not.toHaveBeenCalled();
      expect(c.responses[200].encode).not.toHaveBeenCalled();
      expect(c.responses[400].encode).not.toHaveBeenCalled();
    },
  );

  it.each(["/other/42", "/items", "/items/", "/items/42/extra"])(
    "rejects a mismatched path: %s",
    async (path) => {
      const c = createContract();
      const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
      const endpoint = serverContractHandler(c, handler);

      await expect(
        endpoint.fetch(createRequest(`https://example.com${path}`)),
      ).rejects.toThrow("Request path does not match /items/:id");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON before calling the handler", async () => {
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverContractHandler(createContract(), handler);

    await expect(
      endpoint.fetch(
        new Request("https://example.com/items/42", {
          method: "POST",
          body: "{",
        }),
      ),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates handler failures without encoding a response", async () => {
    const c = createContract();
    const error = new Error("Handler failed");
    const endpoint = serverContractHandler(c, async () => {
      throw error;
    });

    await expect(endpoint.fetch(createRequest())).rejects.toBe(error);
    expect(c.responses[200].encode).not.toHaveBeenCalled();
    expect(c.responses[400].encode).not.toHaveBeenCalled();
  });

  it("propagates response encoding failures", async () => {
    const c = createContract();
    const error = new Error("Invalid response");
    c.responses[200].encode.mockImplementation(() => {
      throw error;
    });
    const endpoint = serverContractHandler(c, async () => ({
      status: 200,
      body: date,
    }));

    await expect(endpoint.fetch(createRequest())).rejects.toBe(error);
  });
});

describe("serverContractHandler types", () => {
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
    const c = contract({
      ...original,
      responses: {
        201: original.responses[200],
        503: original.responses[400],
      },
    });
    const endpoint = serverContractHandler(c, async (req) => {
      if (req.body.enabled) {
        return { status: 201, body: date };
      }
      return { status: 503, body: { error: "Unavailable" } };
    });

    expectTypeOf(endpoint.handler).returns.resolves.toEqualTypeOf<
      { status: 201; body: Date } | { status: 503; body: { error: string } }
    >();

    // @ts-expect-error Status 200 is not declared by this contract.
    serverContractHandler(c, async () => ({ status: 200, body: date }));

    // @ts-expect-error Status 201 requires a Date, not the error body.
    serverContractHandler(c, async () => ({
      status: 201,
      body: { error: "x" },
    }));

    // @ts-expect-error Status 503 requires the error body, not a Date.
    serverContractHandler(c, async () => ({ status: 503, body: date }));
  });

  it("rejects response maps containing status codes absent from Hono", () => {
    const original = createContract();
    const invalid = {
      ...original,
      responses: { ...original.responses, 104: original.responses[200] },
    };

    // @ts-expect-error Status 104 is absent from Hono's StatusCode.
    contract(invalid);

    // @ts-expect-error Direct handler construction also rejects status 104.
    serverContractHandler(invalid, async () => ({ status: 200, body: date }));
  });

  it("infers decoded request values and status-specific response bodies", () => {
    const endpoint = serverContractHandler(createContract(), async (req) => {
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

    expectTypeOf(endpoint.handler).returns.resolves.toEqualTypeOf<
      { status: 200; body: Date } | { status: 400; body: { error: string } }
    >();
    expectTypeOf(endpoint.fetch).toEqualTypeOf<
      (request: Request) => Promise<Response>
    >();
  });

  it("narrows the response body by status", async () => {
    const endpoint = serverContractHandler(createContract(), async () => ({
      status: 200,
      body: date,
    }));
    const response = await endpoint.handler({
      params: { id: 42 },
      query: { filter: "a" },
      body: { enabled: true },
    });

    if (response.status === 200) {
      expectTypeOf(response.body).toEqualTypeOf<Date>();
    } else {
      expectTypeOf(response.body).toEqualTypeOf<{ error: string }>();
    }
  });

  it("rejects invalid handlers without widening the contract", () => {
    const c = createContract();

    // @ts-expect-error Status 201 is not declared by the contract.
    serverContractHandler(c, async () => ({ status: 201, body: date }));

    // @ts-expect-error Status 200 requires a Date, not the error body.
    serverContractHandler(c, async () => ({
      status: 200,
      body: { error: "x" },
    }));

    // @ts-expect-error Status 400 requires the error body, not a Date.
    serverContractHandler(c, async () => ({ status: 400, body: date }));

    // @ts-expect-error The error response body must contain an error string.
    serverContractHandler(c, async () => ({ status: 400, body: {} }));

    // @ts-expect-error The decoded path parameter is a number.
    serverContractHandler(c, async (_req: { params: { id: string } }) => ({
      status: 200,
      body: date,
    }));
  });
});

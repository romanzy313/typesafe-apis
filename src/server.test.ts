import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { serverContractHandler } from "./server.js";
import { type StatusCode, type TypedRequest } from "./types.js";
import { contract } from "./contract.js";
import { zodCodec } from "./codec.js";

const date = new Date("2026-09-09T12:00:00.000Z");

function createContract() {
  const stringToNumber = z.codec(z.string(), z.number(), {
    decode: Number,
    encode: String,
  });
  const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString(),
  });
  const c = contract()
    .route("POST", "/items/:id", zodCodec(z.object({ id: stringToNumber })))
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

describe("serverContractHandler", () => {
  it("decodes requests and encodes responses with the selected codec", async () => {
    const c = createContract();
    const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
    const endpoint = serverContractHandler(c, handler);

    const response = await endpoint.fetch(createRequest());

    expect(endpoint.method).toBe("POST");
    expect(endpoint.path).toBe("/items/:id");
    expect(endpoint.handler).toBe(handler);
    expect(c.definition.params.decode).toHaveBeenCalledExactlyOnceWith({
      id: "42",
    });
    expect(c.definition.query.decode).toHaveBeenCalledExactlyOnceWith({
      filter: "a",
    });
    expect(c.definition.request.decode).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      params: { id: 42 },
      query: { filter: "a" },
      body: { enabled: true },
    });
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
    const endpoint = serverContractHandler(c, async () => ({
      status: 400,
      body,
    }));

    const response = await endpoint.fetch(createRequest());

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
      c.route("POST", "/groups/:group/items/:id", c.definition.params),
      async () => ({ status: 200, body: date }),
    );

    await endpoint.fetch(
      createRequest(
        "https://example.com/groups/a%2Fb/items/hello%20world" +
          "?filter=hello+world&extra=a%2Fb",
      ),
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
    const endpoint = serverContractHandler(
      c.route("GET", "/items", c.definition.params).request(request),
      handler,
    );

    await endpoint.fetch(new Request("https://example.com/items"));

    expect(c.definition.params.decode).toHaveBeenCalledExactlyOnceWith({});
    expect(c.definition.query.decode).toHaveBeenCalledExactlyOnceWith({});
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
      vi.mocked(c.definition[part].decode).mockImplementation(() => {
        throw error;
      });
      const handler = vi.fn(async () => ({ status: 200 as const, body: date }));
      const endpoint = serverContractHandler(c, handler);

      await expect(endpoint.fetch(createRequest())).rejects.toBe(error);
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
    expect(c.definition.responses[200].encode).not.toHaveBeenCalled();
    expect(c.definition.responses[400].encode).not.toHaveBeenCalled();
  });

  it("propagates response encoding failures", async () => {
    const c = createContract();
    const error = new Error("Invalid response");
    vi.mocked(c.definition.responses[200].encode).mockImplementation(() => {
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
    const c = {
      definition: {
        ...original.definition,
        responses: {
          201: original.definition.responses[200],
          503: original.definition.responses[400],
        },
      },
    };
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

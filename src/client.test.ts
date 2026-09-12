import { assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient, type ClientRequestOptions } from "./client.js";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";
import { sidechannelHeaderKey, SidechannelError } from "./sidechannel.js";
import type { MinFetch, ReadonlyHeaders } from "./types.js";

const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});
const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: (value) => Number.parseFloat(value),
  encode: (value) => value.toString(),
});
function createInputs() {
  return {
    params: zodCodec(z.object({ id: z.string() })),
    query: zodCodec(z.object({ limit: stringToNumber, search: z.string() })),
    request: zodCodec(z.object({ at: isoDatetimeToDate })),
  };
}
const inputs = createInputs();
const itemResponses = contract()
  .response(201, zodCodec(z.object({ createdAt: isoDatetimeToDate })))
  .response(400, zodCodec(z.object({ error: z.string() })));
const itemBase = itemResponses.query(inputs.query);
const itemContract = itemBase
  .method("POST")
  .path("/items/:id", inputs.params)
  .request(inputs.request);
const date = new Date("2026-09-10T12:00:00.000Z");
const input = {
  params: { id: "one" },
  query: { limit: 0, search: "" },
  body: { at: date },
};

function createTransport() {
  return vi.fn<MinFetch>(async () =>
    Response.json({ createdAt: date.toISOString() }, { status: 201 }),
  );
}

describe("createClient", () => {
  it("encodes requests and decodes the selected response", async () => {
    const headers = new Headers({ authorization: "Bearer example-token" });
    const fetch = vi.fn<MinFetch>(async (request) => {
      assert(request instanceof Request);
      const url = new URL(request.url);
      expect(url.origin).toBe("https://example.com");
      expect(url.pathname).toBe("/api/items/one%2Ftwo%20%3F%23%25");
      expect([...url.searchParams]).toEqual([
        ["limit", "0"],
        ["search", "a & b+c/?#"],
      ]);
      expect(url.hash).toBe("");
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe("Bearer example-token");
      expect(await request.json()).toEqual({ at: date.toISOString() });
      return Response.json({ createdAt: date.toISOString() }, { status: 201 });
    });
    const fetchItem = createClient({
      baseUrl: "https://example.com/api/",
      fetch,
    }).contract(itemContract);

    const response = await fetchItem(
      {
        params: { id: "one/two ?#%" },
        query: { limit: 0, search: "a & b+c/?#" },
        body: { at: date },
      },
      { headers },
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      headers: expect.any(Headers),
      status: 201,
      body: { createdAt: date },
    });
    expect([...headers]).toEqual([["authorization", "Bearer example-token"]]);
  });

  it.each([
    ["https://example.com/api", "/items/:id"],
    ["https://example.com/api/", "items/:id"],
  ])("joins base URL %s and path %s", async (baseUrl, path) => {
    const fetch = createTransport();
    const fetchItem = createClient({ baseUrl, fetch }).contract(
      itemBase.method("POST").path(path, inputs.params).request(inputs.request),
    );

    await fetchItem(input);

    const request = fetch.mock.calls[0]?.[0];
    assert(request instanceof Request);
    expect(request.url).toBe(
      "https://example.com/api/items/one?limit=0&search=",
    );
  });

  it("accepts an absolute contract URL without a base URL", async () => {
    const fetch = createTransport();
    const fetchItem = createClient({ fetch }).contract(
      itemBase
        .method("POST")
        .path("https://example.com/items/:id", inputs.params)
        .request(inputs.request),
    );

    await fetchItem(input);

    const request = fetch.mock.calls[0]?.[0];
    assert(request instanceof Request);
    expect(request.url).toBe("https://example.com/items/one?limit=0&search=");
  });

  it.each(["GET", "POST"] as const)(
    "sends a %s request without a body when the codec encodes undefined",
    async (method) => {
      const fetch = createTransport();
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract(
        itemResponses.method(method).path("/items/:id", inputs.params),
      );

      await fetchItem(
        {
          params: input.params,
          query: {},
          body: undefined,
        },
        { headers: { "x-client": "example" } },
      );

      const request = fetch.mock.calls[0]?.[0];
      assert(request instanceof Request);
      expect(request.url).toBe("https://example.com/items/one");
      expect(request.method).toBe(method);
      expect(request.body).toBeNull();
      expect(request.headers.has("content-type")).toBe(false);
      expect(request.headers.get("x-client")).toBe("example");
    },
  );

  it.each([false, 0, "", null])("preserves the JSON body %j", async (body) => {
    const fetch = createTransport();
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch,
    }).contract(
      itemBase
        .method("POST")
        .path("/items/:id", inputs.params)
        .request(zodCodec(z.unknown())),
    );

    await fetchItem({ ...input, body });

    const request = fetch.mock.calls[0]?.[0];
    assert(request instanceof Request);
    expect(await request.json()).toEqual(body);
  });

  it("decodes declared error responses", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () =>
        Response.json({ error: "Invalid item" }, { status: 400 }),
    }).contract(itemContract);

    await expect(fetchItem(input)).resolves.toEqual({
      headers: expect.any(Headers),
      status: 400,
      body: { error: "Invalid item" },
    });
  });

  it("preserves an explicitly supplied JSON content type", async () => {
    const fetch = createTransport();
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
    });
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch,
    }).contract(itemContract);

    await fetchItem(input, { headers });

    const request = fetch.mock.calls[0]?.[0];
    assert(request instanceof Request);
    expect(request.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("decodes an absent response body as undefined", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () => new Response(null, { status: 204 }),
    }).contract(
      contract()
        .method("POST")
        .path("/items/:id", inputs.params)
        .query(inputs.query)
        .request(inputs.request)
        .response(204, zodCodec(z.undefined())),
    );

    await expect(fetchItem(input)).resolves.toEqual({
      headers: expect.any(Headers),
      status: 204,
      body: undefined,
    });
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
      {
        readonly status: 204;
        readonly body: undefined;
      } & { readonly headers: ReadonlyHeaders }
    >();
  });

  it.each(["id", "toString"])(
    "rejects a missing path parameter %s before calling the transport",
    async (name) => {
      const fetch = createTransport();
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract(
        itemBase.method("POST").path(`/items/:${name}`).request(inputs.request),
      );

      await expect(fetchItem({ ...input, params: {} })).rejects.toThrow(
        `Missing path parameter ${name}`,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["params", "query"] as const)(
    "rejects non-string values encoded by the %s codec",
    async (part) => {
      const fetch = createTransport();
      const codecs = createInputs();
      vi.spyOn(codecs[part], "encode").mockReturnValue({ value: 42 });
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract(
        itemResponses
          .method("POST")
          .path("/items/:id", codecs.params)
          .query(codecs.query)
          .request(codecs.request),
      );

      await expect(fetchItem(input)).rejects.toThrow(
        `Encoded ${part} must be an object of strings`,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["params", "query", "request"] as const)(
    "propagates %s encoding errors before calling the transport",
    async (part) => {
      const error = new Error(`Cannot encode ${part}`);
      const fetch = createTransport();
      const codecs = createInputs();
      vi.spyOn(codecs[part], "encode").mockImplementation(() => {
        throw error;
      });
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract(
        itemResponses
          .method("POST")
          .path("/items/:id", codecs.params)
          .query(codecs.query)
          .request(codecs.request),
      );

      await expect(fetchItem(input)).rejects.toBe(error);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("propagates transport failures", async () => {
    const error = new Error("Connection failed");
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () => {
        throw error;
      },
    }).contract(itemContract);

    await expect(fetchItem(input)).rejects.toBe(error);
  });

  it.each([
    { kind: "codec_error", status: 400 },
    { kind: "internal_server_error", status: 500 },
  ] as const)(
    "throws $kind before reading or decoding HTTP $status",
    async ({ kind, status }) => {
      const response = new Response("Not JSON", {
        status,
        headers: { [sidechannelHeaderKey]: kind },
      });
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch: async () => response,
      }).contract(itemContract);

      const result = fetchItem(input);
      await expect(result).rejects.toBeInstanceOf(SidechannelError);
      const error = await result.catch((error: unknown) => error);
      assert(error instanceof SidechannelError);
      expect(error.kind).toBe(kind);
      expect(error.response).toBe(response);
      expect(response.bodyUsed).toBe(false);
      expect(await error.response.text()).toBe("Not JSON");
      expectTypeOf(error.kind).toEqualTypeOf<
        "codec_error" | "internal_server_error"
      >();
    },
  );

  it("ignores unrecognized sidechannel values", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () =>
        Response.json(
          { createdAt: date.toISOString() },
          {
            status: 201,
            headers: { [sidechannelHeaderKey]: "future_error" },
          },
        ),
    }).contract(itemContract);

    expect(await fetchItem(input)).toMatchObject({
      status: 201,
      body: { createdAt: date },
    });
  });

  it.each([500, 599])("rejects undeclared status %s", async (status) => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () => Response.json({ error: "Unexpected" }, { status }),
    }).contract(itemContract);

    await expect(fetchItem(input)).rejects.toThrow(
      `No decoder for status ${status}`,
    );
  });

  it("validates the body with the selected response codec", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () =>
        Response.json({ createdAt: "invalid" }, { status: 201 }),
    }).contract(itemContract);

    await expect(fetchItem(input)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("rejects malformed response JSON", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () => new Response("{", { status: 201 }),
    }).contract(itemContract);

    await expect(fetchItem(input)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("propagates failures while reading the response body", async () => {
    const error = new Error("Response body interrupted");
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          { status: 201 },
        ),
    }).contract(itemContract);

    await expect(fetchItem(input)).rejects.toBe(error);
  });
});

describe("createClient types", () => {
  it("keeps client input mutable and client output readonly", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: createTransport(),
    }).contract(itemContract);
    const request: Parameters<typeof fetchItem>[0] = {
      params: { id: "one" },
      query: { limit: 1, search: "first" },
      body: { at: date },
    };
    request.params.id = "two";
    request.query.limit = 2;
    request.body.at = date;
    request.params = { id: "three" };
    request.query = { limit: 3, search: "last" };
    request.body = { at: date };
    const options: ClientRequestOptions = {};
    options.headers = new Headers();
    options.headers.set("x-client", "set");
    options.headers.append("x-client", "appended");
    options.headers.delete("x-client");

    const response = await fetchItem(request, options);
    expect(response.headers.get("content-type")).toBe("application/json");
    response.headers.forEach((_value, _key, headers) => {
      expect(headers).toBe(response.headers);
      if (false) {
        // @ts-expect-error Iteration cannot expose mutable headers.
        headers.set("x-test", "changed");
      }
    });
    if (false) {
      // @ts-expect-error Client response status is readonly.
      response.status = 201;
      // @ts-expect-error Client response body is readonly.
      response.body = { createdAt: date };
      // @ts-expect-error Client response headers cannot be replaced.
      response.headers = new Headers();
      // @ts-expect-error Client response headers expose no set method.
      response.headers.set("x-test", "changed");
      // @ts-expect-error Client response headers expose no append method.
      response.headers.append("x-test", "changed");
      // @ts-expect-error Client response headers expose no delete method.
      response.headers.delete("x-test");
    }
    if (response.status === 201) {
      if (false) {
        // @ts-expect-error Decoded response fields are readonly.
        response.body.createdAt = date;
      }
      expect(response.body.createdAt).toEqual(date);
    }
  });

  it("infers decoded arguments and the declared response union", () => {
    const fetchItem = createClient({ fetch: createTransport() }).contract(
      itemContract,
    );
    const defaultFetchItem = createClient({
      baseUrl: "https://example.com",
    }).contract(itemContract);

    expectTypeOf(defaultFetchItem).toEqualTypeOf<typeof fetchItem>();
    expectTypeOf(fetchItem).parameter(0).toEqualTypeOf<{
      params: { id: string };
      query: { limit: number; search: string };
      body: { at: Date };
    }>();
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
      (
        | { readonly status: 201; readonly body: { readonly createdAt: Date } }
        | { readonly status: 400; readonly body: { readonly error: string } }
      ) & { readonly headers: ReadonlyHeaders }
    >();
    expectTypeOf(fetchItem).toBeCallableWith(input);
    expectTypeOf(fetchItem).toBeCallableWith(input, {
      headers: { authorization: "Bearer example-token" },
    });
    if (false) {
      fetchItem({
        ...input,
        // @ts-expect-error Headers belong in client options, not valid request data.
        headers: { authorization: "Bearer example-token" },
      });
    }

    expectTypeOf(fetchItem).toBeCallableWith({
      ...input,
      // @ts-expect-error The decoded path parameter must be a string.
      params: { id: 42 },
    });
    expectTypeOf(fetchItem).toBeCallableWith({
      ...input,
      // @ts-expect-error The client takes a number before URL encoding.
      query: { limit: "42", search: "" },
    });
    expectTypeOf(fetchItem).toBeCallableWith({
      ...input,
      // @ts-expect-error The client takes a Date before JSON encoding.
      body: { at: date.toISOString() },
    });
    // @ts-expect-error The request body is required.
    expectTypeOf(fetchItem).toBeCallableWith({
      params: input.params,
      query: input.query,
    });
  });

  it("narrows decoded response bodies by status", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: createTransport(),
    }).contract(itemContract);
    const response = await fetchItem(input);

    if (response.status === 201) {
      expectTypeOf(response.body).toEqualTypeOf<{ readonly createdAt: Date }>();
    } else {
      expectTypeOf(response.body).toEqualTypeOf<{ readonly error: string }>();
    }
  });

  it("rejects contracts with unsupported response statuses", () => {
    expectTypeOf(itemContract.response).toBeCallableWith(
      // @ts-expect-error A client contract cannot declare status 600.
      600,
      zodCodec(z.string()),
    );
  });
});

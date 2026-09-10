import { assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient } from "./client.js";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";
import type { MinFetch } from "./types.js";

const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});
const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: (value) => Number.parseFloat(value),
  encode: (value) => value.toString(),
});
const itemBase = contract()
  .query(zodCodec(z.object({ limit: stringToNumber, search: z.string() })))
  .response(201, zodCodec(z.object({ createdAt: isoDatetimeToDate })))
  .response(400, zodCodec(z.object({ error: z.string() })));
const itemContract = itemBase
  .method("POST")
  .path("/items/:id", zodCodec(z.object({ id: z.string() })))
  .request(zodCodec(z.object({ at: isoDatetimeToDate })));
const date = new Date("2026-09-10T12:00:00.000Z");
const input = {
  params: { id: "one" },
  query: { limit: 0, search: "" },
  body: { at: date },
  headers: new Headers(),
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

    const response = await fetchItem({
      params: { id: "one/two ?#%" },
      query: { limit: 0, search: "a & b+c/?#" },
      body: { at: date },
      headers,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ status: 201, body: { createdAt: date } });
    expect([...headers]).toEqual([["authorization", "Bearer example-token"]]);
  });

  it.each([
    ["https://example.com/api", "/items/:id"],
    ["https://example.com/api/", "items/:id"],
  ])("joins base URL %s and path %s", async (baseUrl, path) => {
    const fetch = createTransport();
    const fetchItem = createClient({ baseUrl, fetch }).contract(
      itemBase
        .method("POST")
        .path(path, itemContract.definition.params)
        .request(itemContract.definition.request),
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
        .path("https://example.com/items/:id", itemContract.definition.params)
        .request(itemContract.definition.request),
    );

    await fetchItem(input);

    const request = fetch.mock.calls[0]?.[0];
    assert(request instanceof Request);
    expect(request.url).toBe(
      "https://example.com/items/one?limit=0&search=",
    );
  });

  it.each(["GET", "POST"] as const)(
    "sends a %s request without a body when the codec encodes undefined",
    async (method) => {
      const fetch = createTransport();
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract({
        definition: {
          ...itemContract.definition,
          route: { method, path: "/items/:id" },
          query: zodCodec(z.object({})),
          request: zodCodec(z.undefined()),
        },
      });

      await fetchItem({
        params: input.params,
        query: {},
        body: undefined,
        headers: new Headers({ "x-client": "example" }),
      });

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
        .path("/items/:id", itemContract.definition.params)
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

    await fetchItem({ ...input, headers });

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
    }).contract({
      definition: {
        ...itemContract.definition,
        responses: { 204: zodCodec(z.undefined()) },
      },
    });

    await expect(fetchItem(input)).resolves.toEqual({
      status: 204,
      body: undefined,
    });
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<{
      status: 204;
      body: undefined;
    }>();
  });

  it.each(["id", "toString"])(
    "rejects a missing path parameter %s before calling the transport",
    async (name) => {
      const fetch = createTransport();
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract(
        itemBase
          .method("POST")
          .path(`/items/:${name}`)
          .request(itemContract.definition.request),
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
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract({
        definition: {
          ...itemContract.definition,
          [part]: {
            ...itemContract.definition[part],
            encode: () => ({ value: 42 }),
          },
        },
      });

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
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch,
      }).contract({
        definition: {
          ...itemContract.definition,
          [part]: {
            ...itemContract.definition[part],
            encode: () => {
              throw error;
            },
          },
        },
      });

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
      headers: Readonly<Headers>;
    }>();
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
      | { status: 201; body: { createdAt: Date } }
      | { status: 400; body: { error: string } }
    >();
    expectTypeOf(fetchItem).toBeCallableWith(input);
    expectTypeOf(fetchItem).toBeCallableWith({
      ...input,
      // @ts-expect-error Request headers must be a Headers instance.
      headers: { authorization: "Bearer example-token" },
    });

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
      headers: input.headers,
    });
  });

  it("narrows decoded response bodies by status", async () => {
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: createTransport(),
    }).contract(itemContract);
    const response = await fetchItem(input);

    if (response.status === 201) {
      expectTypeOf(response.body).toEqualTypeOf<{ createdAt: Date }>();
    } else {
      expectTypeOf(response.body).toEqualTypeOf<{ error: string }>();
    }
  });

  it("rejects contracts with unsupported response statuses", () => {
    const client = createClient({ fetch: createTransport() });
    const invalid = {
      definition: {
        ...itemContract.definition,
        responses: {
          201: itemContract.definition.responses[201],
          600: itemContract.definition.responses[400],
        },
      },
    };

    // @ts-expect-error A client contract cannot declare status 600.
    client.contract(invalid);
  });
});

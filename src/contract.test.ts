import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient, type ClientResponse } from "./client.js";
import { zodCodec } from "./codec.js";
import {
  compileContract,
  contract,
  type InferDefinition,
  type InferRequest,
} from "./contract.js";
import { createMiddleware } from "./middleware.js";
import { serverEndpoint } from "./server.js";
import type { ServerRequest } from "./types.js";

const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: Number,
  encode: String,
});
const params = zodCodec(z.object({ id: stringToNumber }));
const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});

describe("contract compilation", () => {
  it("defers nested composition and preserves response declaration order", () => {
    const page = zodCodec(z.object({ page: stringToNumber }));
    const filter = zodCodec(z.object({ filter: z.string() }));
    const firstResponse = zodCodec(z.object({ value: z.string() }));
    const secondResponse = zodCodec(
      z.object({ value: z.string(), extra: z.string() }),
    );
    const intersection = vi.spyOn(page, "intersection");
    const union = vi.spyOn(firstResponse, "union");
    const base = contract()
      .path("/base/")
      .query(page)
      .response(200, firstResponse);
    const nested = contract().merge(
      contract().path("/items/").query(filter).response(200, secondResponse),
    );
    const ready = base.merge(nested).method("GET").path("/:id", params);

    expect(base).not.toHaveProperty("definition");
    expect(ready).not.toHaveProperty("definition");
    // @ts-expect-error Builders have no executable definition, even when ready.
    expectTypeOf(ready.definition);
    expect(intersection).not.toHaveBeenCalled();
    expect(union).not.toHaveBeenCalled();

    const definition = compileContract(ready);
    expect(Object.keys(definition)).toEqual([
      "method",
      "path",
      "params",
      "query",
      "request",
      "responses",
    ]);
    expect(definition.path).toBe("/base/items/:id");
    expectTypeOf(definition.method).toEqualTypeOf<"GET">();
    expectTypeOf(definition).toEqualTypeOf<InferDefinition<typeof ready>>();
    expectTypeOf<InferRequest<typeof ready>>().toEqualTypeOf<{
      params: { id: number };
      query: { page: number } & { filter: string };
      body: undefined;
    }>();
    expect(intersection).toHaveBeenCalledExactlyOnceWith(filter);
    expect(union).toHaveBeenCalledExactlyOnceWith(secondResponse);
    expect(definition.query.decode({ page: "2", filter: "active" })).toEqual({
      page: 2,
      filter: "active",
    });
    const overlapping = { value: "ok", extra: "kept by the second codec" };
    expect(definition.responses[200].decode(overlapping)).toEqual({
      value: "ok",
    });
    expect(definition.responses[200].encode(overlapping)).toEqual({
      value: "ok",
    });
    expect(compileContract(ready)).not.toBe(definition);
    expect(intersection).toHaveBeenCalledTimes(2);
    expect(union).toHaveBeenCalledTimes(2);

    const sibling = base.method("GET").path("/other");
    expect(compileContract(sibling).path).toBe("/base/other");
    expect(definition.path).toBe("/base/items/:id");
  });

  it("compiles once per binding and uses prepared codecs in both transports", async () => {
    const body = zodCodec(z.object({ name: z.string() }));
    const response = zodCodec(z.object({ name: z.string() }));
    const preparedBody = zodCodec(z.object({ name: z.string() }));
    const preparedResponse = zodCodec(z.object({ name: z.string() }));
    const compileBody = vi.spyOn(body, "compile").mockReturnValue(preparedBody);
    const compileResponse = vi
      .spyOn(response, "compile")
      .mockReturnValue(preparedResponse);
    const encodeBody = vi.spyOn(preparedBody, "encode");
    const decodeBody = vi.spyOn(preparedBody, "decode");
    const encodeResponse = vi.spyOn(preparedResponse, "encode");
    const decodeResponse = vi.spyOn(preparedResponse, "decode");
    const requirements = contract().request(body).response(200, response);
    const middleware = createMiddleware()(
      requirements,
      async ({ req }, next) => {
        expectTypeOf(req.params).toBeUnknown();
        expectTypeOf(req.query).toBeUnknown();
        expectTypeOf(req.body).toEqualTypeOf<Readonly<{ name: string }>>();
        return next({});
      },
    );
    const ready = requirements.method("POST").path("/items");
    const pending = serverEndpoint().contract(ready).use(middleware);
    expect(compileBody).not.toHaveBeenCalled();
    expect(compileResponse).not.toHaveBeenCalled();

    const endpoint = pending.handler(async ({ req }) => ({
      status: 200,
      body: req.body,
    }));
    expect(endpoint.definition.request).toBe(preparedBody);
    expect(endpoint.definition.responses[200]).toBe(preparedResponse);
    expect(compileBody).toHaveBeenCalledTimes(1);
    expect(compileResponse).toHaveBeenCalledTimes(1);
    const call = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => endpoint.fetchWithContext(request, {}),
    }).contract(ready);
    expect(compileBody).toHaveBeenCalledTimes(2);
    expect(compileResponse).toHaveBeenCalledTimes(2);
    const request = {
      params: {},
      query: {},
      body: { name: "item" },
    };
    for (let index = 0; index < 2; index++) {
      await expect(call(request)).resolves.toEqual({
        headers: expect.any(Headers),
        status: 200,
        body: request.body,
      });
    }
    expect(encodeBody).toHaveBeenCalledTimes(2);
    expect(decodeBody).toHaveBeenCalledTimes(2);
    expect(encodeResponse).toHaveBeenCalledTimes(2);
    expect(decodeResponse).toHaveBeenCalledTimes(2);
    await expect(endpoint.handle({ req: request, env: {} })).resolves.toEqual({
      status: 200,
      body: request.body,
    });
    expect(decodeBody).toHaveBeenCalledTimes(2);
    expect(compileBody).toHaveBeenCalledTimes(2);
    expect(compileResponse).toHaveBeenCalledTimes(2);
  });

  it("compiles when a client binds first and propagates compilation failures", () => {
    const response = zodCodec(z.string());
    const error = new Error("Cannot prepare codec");
    const compile = vi.spyOn(response, "compile").mockImplementationOnce(() => {
      throw error;
    });
    const ready = contract().method("GET").response(200, response);
    const client = createClient();
    expect(() => client.contract(ready)).toThrow(error);
    expect(() => client.contract(ready)).not.toThrow();
    serverEndpoint()
      .contract(ready)
      .handler(async () => ({ status: 200, body: "ok" }));
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it("validates methods and paths at compilation without invoking codecs", () => {
    const codec = zodCodec(z.object({}));
    const compile = vi.spyOn(codec, "compile");
    const base = contract().query(codec);
    const duplicate = base.method("GET").path("/:id/:id");
    expect(() => compileContract(duplicate)).toThrow(
      "Duplicate path parameter id",
    );
    expect(() => {
      // @ts-expect-error A compiler input must have a method.
      compileContract(base);
    }).toThrow("Contract must define a method with .method()");
    // @ts-expect-error Conflicting literal methods are rejected statically too.
    const conflict = base.method("GET").merge(contract().method("POST"));
    expect(() => compileContract(conflict)).toThrow(
      "Cannot compose different methods: GET and POST",
    );
    expect(compile).not.toHaveBeenCalled();
  });

  it("preserves alternatives inside intersected request codecs", () => {
    const alternatives = zodCodec(
      z.object({ kind: z.literal("a"), value: z.number() }),
    ).union(zodCodec(z.object({ kind: z.literal("b"), value: z.string() })));
    const ready = contract()
      .request(alternatives)
      .merge(contract().request(zodCodec(z.object({ version: z.number() }))))
      .method("POST");
    const definition = compileContract(ready);
    expectTypeOf(definition.request.decode).returns.toEqualTypeOf<
      ({ kind: "a"; value: number } | { kind: "b"; value: string }) & {
        version: number;
      }
    >();
    for (const body of [
      { kind: "a", value: 1, version: 2 },
      { kind: "b", value: "one", version: 2 },
    ] as const) {
      expect(definition.request.decode(body)).toEqual(body);
      expect(definition.request.encode(body)).toEqual(body);
    }
    expect(() => definition.request.decode({ kind: "a", value: 1 })).toThrow(
      z.ZodError,
    );
  });
});

describe("contract composition", () => {
  it("derives independent contracts from a reusable base", () => {
    const base = contract()
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(401, zodCodec(z.object({ error: z.literal("unauthorized") })))
      .response(403, zodCodec(z.object({ error: z.literal("forbidden") })));
    const first = base
      .method("GET")
      .path("/items/:id", params)
      .query(zodCodec(z.object({ filter: z.string() })))
      .response(200, zodCodec(z.object({ name: z.string() })))
      .response(
        403,
        zodCodec(z.object({ error: z.literal("disabled"), id: z.number() })),
      );
    const second = base
      .method("POST")
      .path("/other/:id", params)
      .query(zodCodec(z.object({ sort: z.enum(["asc", "desc"]) })))
      .request(zodCodec(z.object({ enabled: z.boolean() })))
      .response(201, zodCodec(z.object({ created: z.boolean() })));

    expect(base).not.toHaveProperty("definition");
    expect(compileContract(first)).toMatchObject({
      method: "GET",
      path: "/items/:id",
    });
    expect(compileContract(second)).toMatchObject({
      method: "POST",
      path: "/other/:id",
    });
    expect(Object.keys(compileContract(base.method("GET")).responses)).toEqual([
      "401",
      "403",
    ]);
    expect(Object.keys(compileContract(first).responses)).toEqual([
      "200",
      "401",
      "403",
    ]);
    expect(Object.keys(compileContract(second).responses)).toEqual([
      "201",
      "401",
      "403",
    ]);
    expect(
      compileContract(base.method("GET")).query.decode({ page: "2" }),
    ).toEqual({ page: 2 });
    expect(
      compileContract(first).query.decode({ page: "2", filter: "active" }),
    ).toEqual({
      page: 2,
      filter: "active",
    });
    expect(
      compileContract(second).query.decode({ page: "2", sort: "asc" }),
    ).toEqual({
      page: 2,
      sort: "asc",
    });
    expect(() =>
      compileContract(first).query.decode({ filter: "active" }),
    ).toThrow(z.ZodError);
    expect(() => compileContract(first).query.decode({ page: "2" })).toThrow(
      z.ZodError,
    );
    expect(() =>
      compileContract(second).query.decode({ page: "2", filter: "active" }),
    ).toThrow(z.ZodError);
    expect(
      compileContract(first).responses[403].decode({
        error: "disabled",
        id: 7,
      }),
    ).toEqual({
      error: "disabled",
      id: 7,
    });
    expect(() =>
      compileContract(base.method("GET")).responses[403].decode({
        error: "disabled",
        id: 7,
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      compileContract(second).responses[403].decode({
        error: "disabled",
        id: 7,
      }),
    ).toThrow(z.ZodError);
    expect(
      compileContract(base.method("GET")).request.decode(undefined),
    ).toBeUndefined();
    expect(compileContract(first).request.decode(undefined)).toBeUndefined();
    expect(compileContract(second).request.decode({ enabled: true })).toEqual({
      enabled: true,
    });
  });

  it("round-trips shared queries and response variants under one status", async () => {
    const base = contract()
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(403, zodCodec(z.object({ error: z.literal("forbidden") })));
    const other = contract()
      .query(
        zodCodec(
          z.object({ action: z.enum(["read", "forbidden", "disabled"]) }),
        ),
      )
      .response(200, zodCodec(z.object({ id: z.number(), page: z.number() })))
      .response(
        403,
        zodCodec(
          z.object({
            error: z.literal("disabled"),
            data: z.object({ id: z.number() }),
          }),
        ),
      );
    const final = base.merge(other).method("GET").path("/items/:id", params);

    expect(final).not.toBe(base);
    expect(final).not.toBe(other);
    expect(base).not.toHaveProperty("definition");
    expect(other).not.toHaveProperty("definition");
    expect(Object.keys(compileContract(base.method("GET")).responses)).toEqual([
      "403",
    ]);
    expect(() =>
      compileContract(base.method("GET")).responses[403].decode({
        error: "disabled",
        data: { id: 7 },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      compileContract(other.method("GET")).responses[403].decode({
        error: "forbidden",
      }),
    ).toThrow(z.ZodError);
    expect(
      compileContract(final).query.encode({ page: 2, action: "read" }),
    ).toEqual({
      page: "2",
      action: "read",
    });
    expect(
      compileContract(base.method("GET")).query.decode({ page: "2" }),
    ).toEqual({ page: 2 });
    expect(
      compileContract(other.method("GET")).query.decode({ action: "read" }),
    ).toEqual({
      action: "read",
    });

    const builder = serverEndpoint().contract(final);
    const endpoint = builder.handler(async ({ req }) => {
      expectTypeOf(req.params).toEqualTypeOf<Readonly<{ id: number }>>();
      expectTypeOf(req.query).toEqualTypeOf<
        Readonly<
          { page: number } & { action: "read" | "forbidden" | "disabled" }
        >
      >();
      expectTypeOf(req.body).toBeUndefined();

      if (req.query.action === "forbidden") {
        return { status: 403, body: { error: "forbidden" as const } };
      }
      if (req.query.action === "disabled") {
        return {
          status: 403,
          body: { error: "disabled" as const, data: { id: req.params.id } },
        };
      }
      return { status: 200, body: { id: req.params.id, page: req.query.page } };
    });
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => endpoint.fetchWithContext(request, {}),
    }).contract(final);

    expectTypeOf(fetchItem)
      .parameter(0)
      .toEqualTypeOf<InferRequest<typeof final>>();
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
      ClientResponse<
        | { status: 200; body: { id: number; page: number } }
        | {
            status: 403;
            body:
              | { error: "forbidden" }
              | { error: "disabled"; data: { id: number } };
          }
      >
    >();

    for (const action of ["read", "forbidden", "disabled"] as const) {
      const response = await fetchItem({
        params: { id: 42.5 },
        query: { page: 2, action },
        body: undefined,
      });
      if (action === "read") {
        expect(response).toEqual({
          headers: expect.any(Headers),
          status: 200,
          body: { id: 42.5, page: 2 },
        });
      } else if (action === "forbidden") {
        expect(response).toEqual({
          headers: expect.any(Headers),
          status: 403,
          body: { error: "forbidden" },
        });
      } else {
        expect(response).toEqual({
          headers: expect.any(Headers),
          status: 403,
          body: { error: "disabled", data: { id: 42.5 } },
        });
      }

      if (response.status === 403) {
        if (response.body.error === "disabled") {
          expectTypeOf(response.body.data).toEqualTypeOf<{ id: number }>();
        } else {
          expectTypeOf(response.body).toEqualTypeOf<
            Readonly<{ error: "forbidden" }>
          >();
          // @ts-expect-error Only the disabled variant has data.
          expectTypeOf(response.body.data);
        }
      }
    }

    expectTypeOf(fetchItem).toBeCallableWith({
      params: { id: 1 },
      // @ts-expect-error The inherited page field is required.
      query: { action: "read" },
      body: undefined,
    });
    // @ts-expect-error The disabled variant requires data.
    builder.handler(async () => ({
      status: 403,
      body: { error: "disabled" },
    }));
    // @ts-expect-error A discriminator cannot be added by the handler.
    builder.handler(async () => ({
      status: 403,
      body: { error: "other" },
    }));
    // @ts-expect-error This status was not declared by the contract.
    builder.handler(async () => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
  });

  it("rejects missing methods at binding time and in the type system", () => {
    const base = contract()
      .path("/items/:id", params)
      .merge(contract().query(zodCodec(z.object({ page: stringToNumber }))))
      .merge(
        contract().response(
          401,
          zodCodec(z.object({ error: z.literal("unauthorized") })),
        ),
      );
    const handler = vi.fn(async () => ({
      status: 401 as const,
      body: { error: "unauthorized" as const },
    }));
    const fetch = vi.fn(async () => Response.json({}));
    const client = createClient({ fetch });

    // Configuring a derived method does not complete the original base.
    const ready = base.method("GET");
    expect(() => {
      // @ts-expect-error A path-only base contract has no method.
      serverEndpoint().contract(base).handler(handler);
    }).toThrow("Contract must define a method with .method()");
    expect(() => {
      // @ts-expect-error A path-only base contract has no method.
      client.contract(base);
    }).toThrow("Contract must define a method with .method()");
    expect(() => {
      serverEndpoint()
        // @ts-expect-error A new contract has no method.
        .contract(contract())
        .handler(async () => {
          throw new Error("Must not run");
        });
    }).toThrow("Contract must define a method with .method()");
    expect(() => {
      // @ts-expect-error A new contract has no method.
      client.contract(contract());
    }).toThrow("Contract must define a method with .method()");
    expect(() =>
      serverEndpoint().contract(ready).handler(handler),
    ).not.toThrow();
    expect(() => client.contract(ready)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defaults to the root path, empty params and query, and no body", async () => {
    const c = contract()
      .method("GET")
      .response(200, zodCodec(z.object({ ok: z.boolean() })));
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async ({ req }) => {
      expect(req).toEqual({
        headers: new Headers(),
        params: {},
        query: {},
        body: undefined,
      });
      return { status: 200, body: { ok: true } };
    });
    const fetchEmpty = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => {
        expect(request.url).toBe("https://example.com/");
        return endpoint.fetchWithContext(request, {});
      },
    }).contract(c);

    await expect(
      fetchEmpty({
        params: {},
        query: {},
        body: undefined,
      }),
    ).resolves.toEqual({
      headers: expect.any(Headers),
      status: 200,
      body: { ok: true },
    });
    expectTypeOf(fetchEmpty).parameter(0).toEqualTypeOf<{
      params: Record<string, never>;
      query: Record<string, never>;
      body: undefined;
    }>();
    expectTypeOf(fetchEmpty).toBeCallableWith({
      params: {},
      // @ts-expect-error An undeclared query cannot contain fields.
      query: { page: 1 },
      body: undefined,
    });
  });

  it("preserves conflicting fields when merged queries are extended", () => {
    const c = contract()
      .query(zodCodec(z.object({ page: z.string() })))
      .merge(contract().query(zodCodec(z.object({ page: z.number() }))))
      .method("GET")
      .path("/items/:id", params)
      .request(zodCodec(z.undefined()))
      .response(200, zodCodec(z.object({ ok: z.boolean() })))
      .merge(contract())
      .query(zodCodec(z.object({ filter: z.string() })));
    const query = compileContract(c).query;

    expectTypeOf(query.decode).returns.toEqualTypeOf<
      { page: string } & { page: number } & { filter: string }
    >();
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async ({ req }) => {
      expectTypeOf(req.query.page).toBeNever();
      return { status: 200, body: { ok: true } };
    });
    const fetchItem = createClient({
      fetch: (request) => endpoint.fetchWithContext(request, {}),
    }).contract(c);

    expectTypeOf(fetchItem)
      .parameter(0)
      .toEqualTypeOf<InferRequest<typeof c>>();
    expectTypeOf(fetchItem).toBeCallableWith({
      params: { id: 1 },
      // @ts-expect-error The conflicting page field must not disappear.
      query: { filter: "active" },
      body: undefined,
    });

    for (const page of ["2", 2]) {
      const input = { page, filter: "active" };
      expect(() => query.decode(input)).toThrow(z.ZodError);
      expect(() => {
        // @ts-expect-error No string or number satisfies both page types.
        query.encode(input);
      }).toThrow(z.ZodError);
    }
  });

  it("preserves an impossible query after conflicting discriminators", () => {
    const c = contract()
      .method("GET")
      .query(zodCodec(z.object({ mode: z.literal("a") })))
      .query(zodCodec(z.object({ mode: z.literal("b") })))
      .query(zodCodec(z.object({ filter: z.string() })));

    expectTypeOf(compileContract(c).query.decode).returns.toBeNever();
    expectTypeOf(compileContract(c).query.encode).parameter(0).toBeNever();
    expect(() =>
      compileContract(c).query.decode({ mode: "a", filter: "active" }),
    ).toThrow(z.ZodError);
  });

  it("preserves constraints on shared query fields", () => {
    const c = contract()
      .method("GET")
      .query(zodCodec(z.object({ name: z.string().min(2) })))
      .query(zodCodec(z.object({ name: z.string().max(4) })));

    expect(compileContract(c).query.decode({ name: "abc" })).toEqual({
      name: "abc",
    });
    expect(() => compileContract(c).query.decode({ name: "a" })).toThrow(
      z.ZodError,
    );
    expect(() => compileContract(c).query.encode({ name: "abcde" })).toThrow(
      z.ZodError,
    );
  });
});

describe("path composition", () => {
  it("accumulates params and keeps derived paths independent", () => {
    const base = contract().path(
      "/organizations/:organizationId/",
      zodCodec(z.object({ organizationId: stringToNumber })),
    );
    const first = base.method("GET").path("/items/:id", params);
    const second = base.path("/members").method("POST");

    expect(compileContract(base.method("GET"))).toMatchObject({
      method: "GET",
      path: "/organizations/:organizationId/",
    });
    expect(compileContract(first)).toMatchObject({
      method: "GET",
      path: "/organizations/:organizationId/items/:id",
    });
    expect(compileContract(second).path).toBe(
      "/organizations/:organizationId/members",
    );
    expectTypeOf(compileContract(first).params.decode).returns.toEqualTypeOf<
      { organizationId: number } & { id: number }
    >();
    expectTypeOf(compileContract(second).params.decode).returns.toEqualTypeOf<{
      organizationId: number;
    }>();
    expect(
      compileContract(first).params.decode({ organizationId: "2", id: "7.5" }),
    ).toEqual({ organizationId: 2, id: 7.5 });
    expect(
      compileContract(first).params.encode({ organizationId: 2, id: 7.5 }),
    ).toEqual({ organizationId: "2", id: "7.5" });
    for (const incomplete of [{ organizationId: "2" }, { id: "7.5" }]) {
      expect(() => compileContract(first).params.decode(incomplete)).toThrow(
        z.ZodError,
      );
    }
    expectTypeOf(compileContract(first).params.encode).toBeCallableWith(
      // @ts-expect-error Every fragment's params are required.
      { id: 7.5 },
    );
  });

  it.each([
    ["/base/route/", "/:id", "/base/route/:id"],
    ["/base///", "///route/", "/base/route/"],
    ["/base", "route", "/base/route"],
    ["/base//inside", "/route", "/base//inside/route"],
    ["/", "/route", "/route"],
    ["/base", "/", "/base/"],
    ["", "/route/", "/route/"],
    ["/base/", "", "/base/"],
    ["", "", "/"],
    ["https://example.com/base/", "/:id", "https://example.com/base/:id"],
  ])("joins %s and %s at their boundary", (first, second, expected) => {
    const base = contract().method("GET").path(first);
    const chained = base.path(second);
    const merged = base.merge(contract().path(second));

    expect(compileContract(chained).path).toBe(expected);
    expect(compileContract(merged).path).toBe(expected);
    expect(compileContract(merged.merge(contract())).path).toBe(expected);
    expect(compileContract(contract().merge(merged)).path).toBe(expected);
  });

  it("appends merged paths in order and permits matching methods", () => {
    const first = contract().method("GET").path("/first");
    const second = contract().method("GET").path("/second");
    const merged = first.merge(second).method("GET").path("/third/");

    expect(compileContract(merged).path).toBe("/first/second/third/");
    expect(compileContract(second.merge(first)).path).toBe("/second/first");
    expectTypeOf(compileContract(merged).method).toEqualTypeOf<"GET">();
    expectTypeOf(
      compileContract(contract().merge(first)).method,
    ).toEqualTypeOf<"GET">();
    expectTypeOf(
      compileContract(first.merge(contract())).method,
    ).toEqualTypeOf<"GET">();
    expect(() => {
      // @ts-expect-error A repeated method must agree with the inherited method.
      compileContract(merged.method("POST"));
    }).toThrow("Cannot compose different methods: GET and POST");
  });

  it("rejects repeated parameter names within and across fragments", () => {
    expect(() =>
      compileContract(
        contract().method("GET").path("/organizations/:id/items/:id", params),
      ),
    ).toThrow("Duplicate path parameter id");
    const base = contract().method("GET").path("/organizations/:id", params);
    expect(() => compileContract(base.path("/items/:id", params))).toThrow(
      "Duplicate path parameter id",
    );
    expect(() =>
      compileContract(base.merge(contract().path("/items/:id", params))),
    ).toThrow("Duplicate path parameter id");
    expect(compileContract(base.method("GET")).path).toBe("/organizations/:id");
  });

  it("preserves conflicting param constraints through later composition", () => {
    const c = contract()
      .path("/:id", zodCodec(z.object({ id: z.string() })))
      .merge(contract().path("/items", zodCodec(z.object({ id: z.number() }))))
      .method("GET")
      .merge(contract())
      .path("/:name", zodCodec(z.object({ name: z.string() })));

    expectTypeOf(compileContract(c).params.decode).returns.toEqualTypeOf<
      { id: string } & { id: number } & { name: string }
    >();
    for (const id of ["2", 2]) {
      expect(() =>
        compileContract(c).params.decode({ id, name: "item" }),
      ).toThrow(z.ZodError);
    }
  });
});

describe("request composition", () => {
  it("intersects bodies when chaining and merging, preserving codecs", () => {
    const base = contract()
      .method("GET")
      .request(zodCodec(z.object({ expectedVersion: stringToNumber })));
    const fields = zodCodec(z.object({ at: isoDatetimeToDate }));
    const at = new Date("2026-09-10T12:00:00.000Z");

    for (const c of [
      base.request(fields),
      base.merge(contract().request(fields)),
    ]) {
      expectTypeOf(compileContract(c).request.decode).returns.toEqualTypeOf<
        { expectedVersion: number } & { at: Date }
      >();
      expect(
        compileContract(c).request.decode({
          expectedVersion: "2",
          at: at.toISOString(),
        }),
      ).toEqual({ expectedVersion: 2, at });
      expect(
        compileContract(c).request.encode({ expectedVersion: 2, at }),
      ).toEqual({
        expectedVersion: "2",
        at: at.toISOString(),
      });
      for (const incomplete of [
        { expectedVersion: "2" },
        { at: at.toISOString() },
      ]) {
        expect(() => compileContract(c).request.decode(incomplete)).toThrow(
          z.ZodError,
        );
      }
    }
    expect(
      compileContract(base.method("GET")).request.decode({
        expectedVersion: "2",
      }),
    ).toEqual({
      expectedVersion: 2,
    });
    expect(fields.decode({ at: at.toISOString() })).toEqual({ at });
  });

  it("preserves incompatible body fields and impossible discriminators", () => {
    const c = contract()
      .request(zodCodec(z.object({ version: z.string() })))
      .merge(contract().request(zodCodec(z.object({ version: z.number() }))))
      .method("POST")
      .path("/items")
      .response(200, zodCodec(z.string()))
      .merge(contract())
      .request(zodCodec(z.object({ name: z.string() })));

    expectTypeOf(compileContract(c).request.decode).returns.toEqualTypeOf<
      { version: string } & { version: number } & { name: string }
    >();
    for (const version of ["2", 2]) {
      const input = { version, name: "item" };
      expect(() => compileContract(c).request.decode(input)).toThrow(
        z.ZodError,
      );
      expect(() => {
        // @ts-expect-error Neither a string nor a number satisfies both codecs.
        compileContract(c).request.encode(input);
      }).toThrow(z.ZodError);
    }

    const impossible = contract()
      .method("POST")
      .request(zodCodec(z.object({ kind: z.literal("a") })))
      .request(zodCodec(z.object({ kind: z.literal("b") })))
      .merge(contract())
      .merge(contract().request(zodCodec(z.object({ name: z.string() }))))
      .request(zodCodec(z.object({ version: z.number() })));

    expectTypeOf(
      compileContract(impossible).request.decode,
    ).returns.toBeNever();
    expectTypeOf(compileContract(impossible).request.encode)
      .parameter(0)
      .toBeNever();
    expect(() =>
      compileContract(impossible).request.decode({
        kind: "a",
        name: "item",
        version: 2,
      }),
    ).toThrow(z.ZodError);
  });

  it("requires every shared field constraint", () => {
    const c = contract()
      .method("POST")
      .request(zodCodec(z.object({ name: z.string().min(2) })))
      .merge(
        contract().request(zodCodec(z.object({ name: z.string().max(4) }))),
      );

    expect(compileContract(c).request.decode({ name: "abc" })).toEqual({
      name: "abc",
    });
    expect(() => compileContract(c).request.decode({ name: "a" })).toThrow(
      z.ZodError,
    );
    expect(() => compileContract(c).request.encode({ name: "abcde" })).toThrow(
      z.ZodError,
    );
  });

  it("round-trips composed paths and bodies through middleware, server, and client", async () => {
    const base = contract()
      .path(
        "/organizations/:organization/",
        zodCodec(z.object({ organization: z.string() })),
      )
      .request(zodCodec(z.object({ expectedVersion: stringToNumber })));
    const details = contract()
      .path("/items/")
      .request(zodCodec(z.object({ at: isoDatetimeToDate })));
    const final = base
      .merge(details)
      .method("POST")
      .path("/:id", params)
      .request(zodCodec(z.object({ name: z.string() })))
      .response(
        200,
        zodCodec(z.object({ name: z.string(), at: isoDatetimeToDate })),
      );
    const at = new Date("2026-09-10T12:00:00.000Z");
    const input = {
      params: { organization: "one/two ?#%", id: 7.5 },
      query: {},
      body: { expectedVersion: 2, at, name: "item" },
    };
    const middleware = createMiddleware()(base, async ({ req }, next) => {
      expectTypeOf(req.params).toEqualTypeOf<
        Readonly<{ organization: string }>
      >();
      expectTypeOf(req.body).toEqualTypeOf<
        Readonly<{ expectedVersion: number }>
      >();
      expect(req.params.organization).toBe(input.params.organization);
      expect(req.body.expectedVersion).toBe(2);
      return next({});
    });
    const endpoint = serverEndpoint()
      .contract(final)
      .use(middleware)
      .handler(async ({ req }) => {
        expectTypeOf(req.params).toEqualTypeOf<
          Readonly<{ organization: string } & { id: number }>
        >();
        expectTypeOf(req.body).toEqualTypeOf<
          Readonly<
            { expectedVersion: number } & { at: Date } & { name: string }
          >
        >();
        expect(req.params).toEqual(input.params);
        expect(req.body).toEqual(input.body);
        return { status: 200, body: { name: req.body.name, at: req.body.at } };
      });
    const fetchItem = createClient({
      baseUrl: "https://example.com",
      fetch: async (request) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://example.com/organizations/one%2Ftwo%20%3F%23%25/items/7.5",
        );
        expect(await request.clone().json()).toEqual({
          expectedVersion: "2",
          at: at.toISOString(),
          name: "item",
        });
        return endpoint.fetchWithContext(request, {});
      },
    }).contract(final);

    expectTypeOf(fetchItem)
      .parameter(0)
      .toEqualTypeOf<InferRequest<typeof final>>();
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
      ClientResponse<{
        status: 200;
        body: { name: string; at: Date };
      }>
    >();
    expectTypeOf(fetchItem).toBeCallableWith({
      ...input,
      // @ts-expect-error The inherited path parameter is required.
      params: { id: 7.5 },
    });
    expectTypeOf(fetchItem).toBeCallableWith({
      ...input,
      // @ts-expect-error The inherited body field is required.
      body: { at, name: "item" },
    });
    await expect(fetchItem(input)).resolves.toEqual({
      headers: expect.any(Headers),
      status: 200,
      body: { name: "item", at },
    });
    await expect(endpoint.handle({ req: input, env: {} })).resolves.toEqual({
      status: 200,
      body: { name: "item", at },
    });
    await expect(
      endpoint.fetchWithContext(
        new Request("https://example.com/organizations/one/items/7.5", {
          method: "POST",
          body: JSON.stringify({ at: at.toISOString(), name: "item" }),
        }),
        {},
      ),
    ).rejects.toThrow(z.ZodError);
  });
});

describe("contract merge", () => {
  it("treats unconfigured parts as neutral on either side", async () => {
    const empty = contract();
    const configured = contract()
      .method("POST")
      .path("/items/:id", params)
      .query(zodCodec(z.object({ page: stringToNumber })))
      .request(zodCodec(z.object({ name: z.string() })))
      .response(201, zodCodec(z.object({ created: z.boolean() })));

    for (const merged of [
      empty.merge(configured),
      configured.merge(empty),
      empty.merge(empty).merge(configured),
      configured.merge(empty.merge(empty)),
    ]) {
      const endpoint = serverEndpoint()
        .contract(merged)
        .handler(async ({ req }) => {
          expectTypeOf(req).toEqualTypeOf<
            ServerRequest<{ id: number }, { page: number }, { name: string }>
          >();
          expect(req).toEqual({
            params: { id: 7 },
            query: { page: 2 },
            body: { name: "item" },
            headers: new Headers({ "content-type": "application/json" }),
          });
          return { status: 201, body: { created: true } };
        });
      const fetchItem = createClient({
        baseUrl: "https://example.com",
        fetch: (request) => endpoint.fetchWithContext(request, {}),
      }).contract(merged);

      expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
        ClientResponse<{
          status: 201;
          body: { created: boolean };
        }>
      >();
      expect(compileContract(merged)).toMatchObject({
        method: "POST",
        path: "/items/:id",
      });
      await expect(
        fetchItem({
          params: { id: 7 },
          query: { page: 2 },
          body: { name: "item" },
        }),
      ).resolves.toEqual({
        status: 201,
        body: { created: true },
        headers: expect.any(Headers),
      });
    }
    expect(empty).not.toHaveProperty("definition");
    expect(compileContract(empty.method("GET")).query.decode({})).toEqual({});
    expect(
      compileContract(empty.method("GET")).request.decode(undefined),
    ).toBeUndefined();
    expect(compileContract(empty.method("GET")).responses).toEqual({});
  });

  it("allows configuration after merging empty bases", () => {
    const merged = contract().merge(contract());
    expect(() => {
      // @ts-expect-error Merging empty builders does not provide a method.
      compileContract(merged);
    }).toThrow("Contract must define a method with .method()");
    expectTypeOf(
      compileContract(merged.method("GET")).query.decode,
    ).returns.toEqualTypeOf<Record<string, never>>();
    expectTypeOf(
      compileContract(merged.method("GET")).request.decode,
    ).returns.toBeUndefined();

    const configured = merged
      .method("GET")
      .query(zodCodec(z.object({ page: stringToNumber })))
      .merge(contract().request(zodCodec(z.boolean())));
    expectTypeOf(
      compileContract(configured).query.decode,
    ).returns.toEqualTypeOf<{
      page: number;
    }>();
    expectTypeOf(
      compileContract(configured).request.decode,
    ).returns.toBeBoolean();
    expect(compileContract(configured).query.decode({ page: "2" })).toEqual({
      page: 2,
    });
    expect(compileContract(configured).request.decode(true)).toBe(true);
  });

  it("combines a route and a request body from separate bases", () => {
    const route = contract().method("POST").path("/items/:id", params);
    const body = contract().request(zodCodec(z.object({ name: z.string() })));

    for (const merged of [route.merge(body), body.merge(route)]) {
      expectTypeOf(
        compileContract(merged).params.decode,
      ).returns.toEqualTypeOf<{
        id: number;
      }>();
      expectTypeOf(
        compileContract(merged).request.decode,
      ).returns.toEqualTypeOf<{
        name: string;
      }>();
      expect(compileContract(merged)).toMatchObject({
        method: "POST",
        path: "/items/:id",
      });
      expect(compileContract(merged).params.decode({ id: "7" })).toEqual({
        id: 7,
      });
      expect(compileContract(merged).request.decode({ name: "item" })).toEqual({
        name: "item",
      });
    }
  });

  it("rejects conflicting methods, including methods inherited by merge", () => {
    const first = contract().method("GET").path("/first");
    const second = contract().method("POST").path("/second");
    const inherited = contract()
      .merge(first)
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(200, zodCodec(z.string()));

    expect(() => {
      // @ts-expect-error GET and POST cannot be composed.
      compileContract(first.merge(second));
    }).toThrow("Cannot compose different methods: GET and POST");
    expect(() => {
      // @ts-expect-error An inherited method must still agree.
      compileContract(inherited.merge(second));
    }).toThrow("Cannot compose different methods: GET and POST");
  });

  it("preserves an explicit undefined body as a constraint", () => {
    const bodyCodec = zodCodec(z.object({ name: z.string() }));
    const body = contract().method("POST").request(bodyCodec);
    const noBody = contract().method("POST").request(zodCodec(z.undefined()));
    const inherited = contract()
      .merge(body)
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(200, zodCodec(z.string()))
      .method("POST")
      .path("/items/:id", params);

    expect(
      compileContract(body.merge(body)).request.decode({ name: "item" }),
    ).toEqual({
      name: "item",
    });
    expect(
      compileContract(noBody.merge(noBody)).request.decode(undefined),
    ).toBeUndefined();
    for (const merged of [
      body.merge(noBody),
      noBody.merge(body),
      inherited.merge(noBody),
      noBody.request(bodyCodec),
    ]) {
      expectTypeOf(compileContract(merged).request.decode).returns.toBeNever();
      expectTypeOf(compileContract(merged).request.encode)
        .parameter(0)
        .toBeNever();
      expect(() => compileContract(merged).request.decode(undefined)).toThrow(
        z.ZodError,
      );
      expect(() =>
        compileContract(merged).request.decode({ name: "item" }),
      ).toThrow(z.ZodError);
    }
  });
});

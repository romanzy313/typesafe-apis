import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient } from "./client.js";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";
import { createMiddleware } from "./middleware.js";
import { serverEndpoint } from "./server.js";

const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: Number,
  encode: String,
});
const params = zodCodec(z.object({ id: stringToNumber }));
const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
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

    expect(base.definition.route.method).toBeUndefined();
    expect(first.definition.route).toEqual({
      method: "GET",
      path: "/items/:id",
    });
    expect(second.definition.route).toEqual({
      method: "POST",
      path: "/other/:id",
    });
    expect(Object.keys(base.definition.responses)).toEqual(["401", "403"]);
    expect(Object.keys(first.definition.responses)).toEqual([
      "200",
      "401",
      "403",
    ]);
    expect(Object.keys(second.definition.responses)).toEqual([
      "201",
      "401",
      "403",
    ]);
    expect(base.definition.query.decode({ page: "2" })).toEqual({ page: 2 });
    expect(
      first.definition.query.decode({ page: "2", filter: "active" }),
    ).toEqual({
      page: 2,
      filter: "active",
    });
    expect(second.definition.query.decode({ page: "2", sort: "asc" })).toEqual({
      page: 2,
      sort: "asc",
    });
    expect(() => first.definition.query.decode({ filter: "active" })).toThrow(
      z.ZodError,
    );
    expect(() => first.definition.query.decode({ page: "2" })).toThrow(
      z.ZodError,
    );
    expect(() =>
      second.definition.query.decode({ page: "2", filter: "active" }),
    ).toThrow(z.ZodError);
    expect(
      first.definition.responses[403].decode({ error: "disabled", id: 7 }),
    ).toEqual({
      error: "disabled",
      id: 7,
    });
    expect(() =>
      base.definition.responses[403].decode({ error: "disabled", id: 7 }),
    ).toThrow(z.ZodError);
    expect(() =>
      second.definition.responses[403].decode({ error: "disabled", id: 7 }),
    ).toThrow(z.ZodError);
    expect(base.definition.request.decode(undefined)).toBeUndefined();
    expect(first.definition.request.decode(undefined)).toBeUndefined();
    expect(second.definition.request.decode({ enabled: true })).toEqual({
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
    expect(base.definition.route.method).toBeUndefined();
    expect(other.definition.route.method).toBeUndefined();
    expect(Object.keys(base.definition.responses)).toEqual(["403"]);
    expect(() =>
      base.definition.responses[403].decode({
        error: "disabled",
        data: { id: 7 },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      other.definition.responses[403].decode({ error: "forbidden" }),
    ).toThrow(z.ZodError);
    expect(final.definition.query.encode({ page: 2, action: "read" })).toEqual({
      page: "2",
      action: "read",
    });
    expect(base.definition.query.decode({ page: "2" })).toEqual({ page: 2 });
    expect(other.definition.query.decode({ action: "read" })).toEqual({
      action: "read",
    });

    const builder = serverEndpoint().contract(final);
    const endpoint = builder.handler(async (req) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: number }>();
      expectTypeOf(req.query).toEqualTypeOf<
        { page: number } & { action: "read" | "forbidden" | "disabled" }
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

    type Handler = Parameters<typeof builder.handler>[0];
    expectTypeOf(fetchItem).toEqualTypeOf<
      (req: Parameters<Handler>[0]) => ReturnType<Handler>
    >();
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<
      | { status: 200; body: { id: number; page: number } }
      | {
          status: 403;
          body:
            | { error: "forbidden" }
            | { error: "disabled"; data: { id: number } };
        }
    >();

    for (const action of ["read", "forbidden", "disabled"] as const) {
      const response = await fetchItem({
        params: { id: 42.5 },
        query: { page: 2, action },
        body: undefined,
        headers: new Headers(),
      });
      if (action === "read") {
        expect(response).toEqual({ status: 200, body: { id: 42.5, page: 2 } });
      } else if (action === "forbidden") {
        expect(response).toEqual({ status: 403, body: { error: "forbidden" } });
      } else {
        expect(response).toEqual({
          status: 403,
          body: { error: "disabled", data: { id: 42.5 } },
        });
      }

      if (response.status === 403) {
        if (response.body.error === "disabled") {
          expectTypeOf(response.body.data).toEqualTypeOf<{ id: number }>();
        } else {
          expectTypeOf(response.body).toEqualTypeOf<{ error: "forbidden" }>();
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
      headers: new Headers(),
    });
    // @ts-expect-error The disabled variant requires data.
    serverEndpoint().contract(final).handler(async () => ({
      status: 403,
      body: { error: "disabled" },
    }));
    // @ts-expect-error A discriminator cannot be added by the handler.
    serverEndpoint().contract(final).handler(async () => ({
      status: 403,
      body: { error: "other" },
    }));
    // @ts-expect-error This status was not declared by the contract.
    serverEndpoint().contract(final).handler(async () => ({
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
      // @ts-expect-error A new contract has no method.
      serverEndpoint().contract(contract()).handler(async () => {
        throw new Error("Must not run");
      });
    }).toThrow("Contract must define a method with .method()");
    expect(() => {
      // @ts-expect-error A new contract has no method.
      client.contract(contract());
    }).toThrow("Contract must define a method with .method()");
    expect(() => serverEndpoint().contract(ready).handler(handler)).not.toThrow();
    expect(() => client.contract(ready)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defaults to the root path, empty params and query, and no body", async () => {
    const c = contract()
      .method("GET")
      .response(200, zodCodec(z.object({ ok: z.boolean() })));
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async (req) => {
      expect(req).toEqual({
        params: {},
        query: {},
        body: undefined,
        headers: new Headers(),
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
        headers: new Headers(),
      }),
    ).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expectTypeOf(fetchEmpty).parameter(0).toEqualTypeOf<{
      params: Record<string, never>;
      query: Record<string, never>;
      body: undefined;
      headers: Readonly<Headers>;
    }>();
    expectTypeOf(fetchEmpty).toBeCallableWith({
      params: {},
      // @ts-expect-error An undeclared query cannot contain fields.
      query: { page: 1 },
      body: undefined,
      headers: new Headers(),
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
    const query = c.definition.query;

    expectTypeOf(query.decode).returns.toEqualTypeOf<
      { page: string } & { page: number } & { filter: string }
    >();
    const builder = serverEndpoint().contract(c);
    const endpoint = builder.handler(async (req) => {
      expectTypeOf(req.query.page).toBeNever();
      return { status: 200, body: { ok: true } };
    });
    const fetchItem = createClient({
      fetch: (request) => endpoint.fetchWithContext(request, {}),
    }).contract(c);

    type Handler = Parameters<typeof builder.handler>[0];
    expectTypeOf(fetchItem).toEqualTypeOf<
      (req: Parameters<Handler>[0]) => ReturnType<Handler>
    >();
    expectTypeOf(fetchItem).toBeCallableWith({
      params: { id: 1 },
      // @ts-expect-error The conflicting page field must not disappear.
      query: { filter: "active" },
      body: undefined,
      headers: new Headers(),
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
      .query(zodCodec(z.object({ mode: z.literal("a") })))
      .query(zodCodec(z.object({ mode: z.literal("b") })))
      .query(zodCodec(z.object({ filter: z.string() })));

    expectTypeOf(c.definition.query.decode).returns.toBeNever();
    expectTypeOf(c.definition.query.encode).parameter(0).toBeNever();
    expect(() =>
      c.definition.query.decode({ mode: "a", filter: "active" }),
    ).toThrow(z.ZodError);
  });

  it("preserves constraints on shared query fields", () => {
    const c = contract()
      .query(zodCodec(z.object({ name: z.string().min(2) })))
      .query(zodCodec(z.object({ name: z.string().max(4) })));

    expect(c.definition.query.decode({ name: "abc" })).toEqual({ name: "abc" });
    expect(() => c.definition.query.decode({ name: "a" })).toThrow(z.ZodError);
    expect(() => c.definition.query.encode({ name: "abcde" })).toThrow(
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

    expect(base.definition.route).toEqual({
      method: undefined,
      path: "/organizations/:organizationId/",
    });
    expect(first.definition.route).toEqual({
      method: "GET",
      path: "/organizations/:organizationId/items/:id",
    });
    expect(second.definition.route.path).toBe(
      "/organizations/:organizationId/members",
    );
    expectTypeOf(first.definition.params.decode).returns.toEqualTypeOf<
      { organizationId: number } & { id: number }
    >();
    expectTypeOf(second.definition.params.decode).returns.toEqualTypeOf<{
      organizationId: number;
    }>();
    expect(
      first.definition.params.decode({ organizationId: "2", id: "7.5" }),
    ).toEqual({ organizationId: 2, id: 7.5 });
    expect(
      first.definition.params.encode({ organizationId: 2, id: 7.5 }),
    ).toEqual({ organizationId: "2", id: "7.5" });
    for (const incomplete of [{ organizationId: "2" }, { id: "7.5" }]) {
      expect(() => first.definition.params.decode(incomplete)).toThrow(
        z.ZodError,
      );
    }
    expectTypeOf(first.definition.params.encode).toBeCallableWith(
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
    const base = contract().path(first);
    const chained = base.path(second);
    const merged = base.merge(contract().path(second));

    expect(chained.definition.route.path).toBe(expected);
    expect(merged.definition.route.path).toBe(expected);
    expect(merged.merge(contract()).definition.route.path).toBe(expected);
    expect(contract().merge(merged).definition.route.path).toBe(expected);
  });

  it("appends merged paths in order and permits matching methods", () => {
    const first = contract().method("GET").path("/first");
    const second = contract().method("GET").path("/second");
    const merged = first.merge(second).method("GET").path("/third/");

    expect(merged.definition.route.path).toBe("/first/second/third/");
    expect(second.merge(first).definition.route.path).toBe("/second/first");
    expectTypeOf(merged.definition.route.method).toEqualTypeOf<"GET">();
    expectTypeOf(contract().merge(first).definition.route.method)
      .toEqualTypeOf<"GET">();
    expectTypeOf(first.merge(contract()).definition.route.method)
      .toEqualTypeOf<"GET">();
    expect(() => {
      // @ts-expect-error A repeated method must agree with the inherited method.
      merged.method("POST");
    }).toThrow("Cannot compose different methods: GET and POST");
  });

  it("rejects repeated parameter names within and across fragments", () => {
    expect(() =>
      contract().path("/organizations/:id/items/:id", params),
    ).toThrow("Duplicate path parameter id");
    const base = contract().path("/organizations/:id", params);
    expect(() => base.path("/items/:id", params)).toThrow(
      "Duplicate path parameter id",
    );
    expect(() => base.merge(contract().path("/items/:id", params))).toThrow(
      "Duplicate path parameter id",
    );
    expect(base.definition.route.path).toBe("/organizations/:id");
  });

  it("preserves conflicting param constraints through later composition", () => {
    const c = contract()
      .path("/:id", zodCodec(z.object({ id: z.string() })))
      .merge(contract().path("/items", zodCodec(z.object({ id: z.number() }))))
      .method("GET")
      .merge(contract())
      .path("/:name", zodCodec(z.object({ name: z.string() })));

    expectTypeOf(c.definition.params.decode).returns.toEqualTypeOf<
      { id: string } & { id: number } & { name: string }
    >();
    for (const id of ["2", 2]) {
      expect(() => c.definition.params.decode({ id, name: "item" })).toThrow(
        z.ZodError,
      );
    }
  });
});

describe("request composition", () => {
  it("intersects bodies when chaining and merging, preserving codecs", () => {
    const base = contract().request(
      zodCodec(z.object({ expectedVersion: stringToNumber })),
    );
    const fields = zodCodec(z.object({ at: isoDatetimeToDate }));
    const at = new Date("2026-09-10T12:00:00.000Z");

    for (const c of [
      base.request(fields),
      base.merge(contract().request(fields)),
    ]) {
      expectTypeOf(c.definition.request.decode).returns.toEqualTypeOf<
        { expectedVersion: number } & { at: Date }
      >();
      expect(
        c.definition.request.decode({
          expectedVersion: "2",
          at: at.toISOString(),
        }),
      ).toEqual({ expectedVersion: 2, at });
      expect(c.definition.request.encode({ expectedVersion: 2, at })).toEqual({
        expectedVersion: "2",
        at: at.toISOString(),
      });
      for (const incomplete of [
        { expectedVersion: "2" },
        { at: at.toISOString() },
      ]) {
        expect(() => c.definition.request.decode(incomplete)).toThrow(
          z.ZodError,
        );
      }
    }
    expect(base.definition.request.decode({ expectedVersion: "2" })).toEqual({
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

    expectTypeOf(c.definition.request.decode).returns.toEqualTypeOf<
      { version: string } & { version: number } & { name: string }
    >();
    for (const version of ["2", 2]) {
      const input = { version, name: "item" };
      expect(() => c.definition.request.decode(input)).toThrow(z.ZodError);
      expect(() => {
        // @ts-expect-error Neither a string nor a number satisfies both codecs.
        c.definition.request.encode(input);
      }).toThrow(z.ZodError);
    }

    const impossible = contract()
      .request(zodCodec(z.object({ kind: z.literal("a") })))
      .request(zodCodec(z.object({ kind: z.literal("b") })))
      .merge(contract())
      .merge(contract().request(zodCodec(z.object({ name: z.string() }))))
      .request(zodCodec(z.object({ version: z.number() })));

    expectTypeOf(impossible.definition.request.decode).returns.toBeNever();
    expectTypeOf(impossible.definition.request.encode).parameter(0).toBeNever();
    expect(() =>
      impossible.definition.request.decode({
        kind: "a", name: "item", version: 2,
      }),
    ).toThrow(z.ZodError);
  });

  it("requires every shared field constraint", () => {
    const c = contract()
      .request(zodCodec(z.object({ name: z.string().min(2) })))
      .merge(
        contract().request(zodCodec(z.object({ name: z.string().max(4) }))),
      );

    expect(c.definition.request.decode({ name: "abc" })).toEqual({ name: "abc" });
    expect(() => c.definition.request.decode({ name: "a" })).toThrow(z.ZodError);
    expect(() => c.definition.request.encode({ name: "abcde" })).toThrow(
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
      headers: new Headers(),
    };
    const middleware = createMiddleware()(
      { params: base.definition.params, request: base.definition.request },
      async (req, _server, _context, next) => {
        expectTypeOf(req.params).toEqualTypeOf<{ organization: string }>();
        expectTypeOf(req.body).toEqualTypeOf<{ expectedVersion: number }>();
        expect(req.params.organization).toBe(input.params.organization);
        expect(req.body.expectedVersion).toBe(2);
        return next({});
      },
    );
    const endpoint = serverEndpoint()
      .contract(final)
      .use(middleware)
      .handler(async (req) => {
        expectTypeOf(req.params).toEqualTypeOf<
          { organization: string } & { id: number }
        >();
        expectTypeOf(req.body).toEqualTypeOf<
          { expectedVersion: number } & { at: Date } & { name: string }
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

    expectTypeOf(fetchItem).parameter(0).toEqualTypeOf<
      Parameters<typeof endpoint.handle>[0]
    >();
    expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<{
      status: 200;
      body: { name: string; at: Date };
    }>();
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
      status: 200, body: { name: "item", at },
    });
    await expect(endpoint.handle(input, {})).resolves.toEqual({
      status: 200, body: { name: "item", at },
    });
    await expect(endpoint.fetchWithContext(
      new Request("https://example.com/organizations/one/items/7.5", {
        method: "POST",
        body: JSON.stringify({ at: at.toISOString(), name: "item" }),
      }),
      {},
    )).rejects.toThrow(z.ZodError);
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
        .handler(async (req) => {
          expectTypeOf(req).toEqualTypeOf<{
            params: { id: number };
            query: { page: number };
            body: { name: string };
            headers: Readonly<Headers>;
          }>();
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

      expectTypeOf(fetchItem).returns.resolves.toEqualTypeOf<{
        status: 201;
        body: { created: boolean };
      }>();
      expect(merged.definition.route).toEqual({
        method: "POST",
        path: "/items/:id",
      });
      await expect(
        fetchItem({
          params: { id: 7 },
          query: { page: 2 },
          body: { name: "item" },
          headers: new Headers(),
        }),
      ).resolves.toEqual({ status: 201, body: { created: true } });
    }
    expect(empty.definition.route.method).toBeUndefined();
    expect(empty.definition.query.decode({})).toEqual({});
    expect(empty.definition.request.decode(undefined)).toBeUndefined();
    expect(empty.definition.responses).toEqual({});
  });

  it("allows configuration after merging empty bases", () => {
    const merged = contract().merge(contract());
    expectTypeOf(merged.definition.route.method).toBeUndefined();
    expectTypeOf(merged.definition.query.decode).returns.toEqualTypeOf<
      Record<string, never>
    >();
    expectTypeOf(merged.definition.request.decode).returns.toBeUndefined();

    const configured = merged
      .query(zodCodec(z.object({ page: stringToNumber })))
      .merge(contract().request(zodCodec(z.boolean())));
    expectTypeOf(configured.definition.query.decode).returns.toEqualTypeOf<{
      page: number;
    }>();
    expectTypeOf(configured.definition.request.decode).returns.toBeBoolean();
    expect(configured.definition.query.decode({ page: "2" })).toEqual({
      page: 2,
    });
    expect(configured.definition.request.decode(true)).toBe(true);
  });

  it("combines a route and a request body from separate bases", () => {
    const route = contract().method("POST").path("/items/:id", params);
    const body = contract().request(zodCodec(z.object({ name: z.string() })));

    for (const merged of [route.merge(body), body.merge(route)]) {
      expectTypeOf(merged.definition.params.decode).returns.toEqualTypeOf<{
        id: number;
      }>();
      expectTypeOf(merged.definition.request.decode).returns.toEqualTypeOf<{
        name: string;
      }>();
      expect(merged.definition.route).toEqual({
        method: "POST",
        path: "/items/:id",
      });
      expect(merged.definition.params.decode({ id: "7" })).toEqual({ id: 7 });
      expect(merged.definition.request.decode({ name: "item" })).toEqual({
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
      first.merge(second);
    }).toThrow("Cannot compose different methods: GET and POST");
    expect(() => {
      // @ts-expect-error An inherited method must still agree.
      inherited.merge(second);
    }).toThrow("Cannot compose different methods: GET and POST");
  });

  it("preserves an explicit undefined body as a constraint", () => {
    const body = contract().request(zodCodec(z.object({ name: z.string() })));
    const noBody = contract().request(zodCodec(z.undefined()));
    const inherited = contract()
      .merge(body)
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(200, zodCodec(z.string()))
      .method("POST")
      .path("/items/:id", params);

    expect(body.merge(body).definition.request.decode({ name: "item" })).toEqual({
      name: "item",
    });
    expect(
      noBody.merge(noBody).definition.request.decode(undefined),
    ).toBeUndefined();
    for (const merged of [
      body.merge(noBody),
      noBody.merge(body),
      inherited.merge(noBody),
      noBody.request(body.definition.request),
    ]) {
      expectTypeOf(merged.definition.request.decode).returns.toBeNever();
      expectTypeOf(merged.definition.request.encode).parameter(0).toBeNever();
      expect(() => merged.definition.request.decode(undefined)).toThrow(
        z.ZodError,
      );
      expect(() => merged.definition.request.decode({ name: "item" })).toThrow(
        z.ZodError,
      );
    }
  });
});

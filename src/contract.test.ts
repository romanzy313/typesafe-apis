import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient } from "./client.js";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";
import { serverContractHandler } from "./server.js";

const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: Number,
  encode: String,
});
const params = zodCodec(z.object({ id: stringToNumber }));

describe("contract composition", () => {
  it("derives independent contracts from a reusable base", () => {
    const base = contract()
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(401, zodCodec(z.object({ error: z.literal("unauthorized") })))
      .response(403, zodCodec(z.object({ error: z.literal("forbidden") })));
    const first = base
      .route("GET", "/items/:id", params)
      .query(zodCodec(z.object({ filter: z.string() })))
      .response(200, zodCodec(z.object({ name: z.string() })))
      .response(
        403,
        zodCodec(z.object({ error: z.literal("disabled"), id: z.number() })),
      );
    const second = base
      .route("POST", "/other/:id", params)
      .query(zodCodec(z.object({ sort: z.enum(["asc", "desc"]) })))
      .request(zodCodec(z.object({ enabled: z.boolean() })))
      .response(201, zodCodec(z.object({ created: z.boolean() })));

    expect(base.definition.route).toBeUndefined();
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
    const final = base
      .route("GET", "/items/:id", params)
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
    const endpoint = serverContractHandler(final, async (req) => {
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
      doRequest: endpoint.fetch,
    }).contract(final);

    expectTypeOf(fetchItem).toEqualTypeOf<typeof endpoint.handler>();
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
    });
    // @ts-expect-error The disabled variant requires data.
    serverContractHandler(final, async () => ({
      status: 403,
      body: { error: "disabled" },
    }));
    // @ts-expect-error A discriminator cannot be added by the handler.
    serverContractHandler(final, async () => ({
      status: 403,
      body: { error: "other" },
    }));
    // @ts-expect-error This status was not declared by the contract.
    serverContractHandler(final, async () => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
  });

  it("rejects missing routes at binding time and in the type system", () => {
    const base = contract()
      .query(zodCodec(z.object({ page: stringToNumber })))
      .response(401, zodCodec(z.object({ error: z.literal("unauthorized") })));
    const handler = vi.fn(async () => ({
      status: 401 as const,
      body: { error: "unauthorized" as const },
    }));
    const doRequest = vi.fn(async () => Response.json({}));
    const client = createClient({ doRequest });

    // Configuring a derived route does not complete the original base.
    const ready = base.route("GET", "/items/:id", params);
    expect(() => {
      // @ts-expect-error A base contract has no route.
      serverContractHandler(base, handler);
    }).toThrow("Contract must define a route with .route()");
    expect(() => {
      // @ts-expect-error A base contract has no route.
      client.contract(base);
    }).toThrow("Contract must define a route with .route()");
    expect(() => {
      // @ts-expect-error A new contract has no route.
      serverContractHandler(contract(), async () => {
        throw new Error("Must not run");
      });
    }).toThrow("Contract must define a route with .route()");
    expect(() => {
      // @ts-expect-error A new contract has no route.
      client.contract(contract());
    }).toThrow("Contract must define a route with .route()");
    expect(() => serverContractHandler(ready, handler)).not.toThrow();
    expect(() => client.contract(ready)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(doRequest).not.toHaveBeenCalled();
  });

  it("defaults to an empty query and no request body", async () => {
    const c = contract()
      .route("GET", "/empty", zodCodec(z.object({})))
      .response(200, zodCodec(z.object({ ok: z.boolean() })));
    const endpoint = serverContractHandler(c, async (req) => {
      expect(req).toEqual({ params: {}, query: {}, body: undefined });
      return { status: 200, body: { ok: true } };
    });
    const fetchEmpty = createClient({
      baseUrl: "https://example.com",
      doRequest: endpoint.fetch,
    }).contract(c);

    await expect(
      fetchEmpty({ params: {}, query: {}, body: undefined }),
    ).resolves.toEqual({
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

  it("preserves conflicting fields when a query is extended again", () => {
    const c = contract()
      .query(zodCodec(z.object({ page: z.string() })))
      .query(zodCodec(z.object({ page: z.number() })))
      .route("GET", "/items/:id", params)
      .request(zodCodec(z.undefined()))
      .response(200, zodCodec(z.object({ ok: z.boolean() })))
      .query(zodCodec(z.object({ filter: z.string() })));
    const query = c.definition.query;

    expectTypeOf(query.decode).returns.toEqualTypeOf<
      { page: string } & { page: number } & { filter: string }
    >();
    const endpoint = serverContractHandler(c, async (req) => {
      expectTypeOf(req.query.page).toBeNever();
      return { status: 200, body: { ok: true } };
    });
    const fetchItem = createClient({ doRequest: endpoint.fetch }).contract(c);

    expectTypeOf(fetchItem).toEqualTypeOf<typeof endpoint.handler>();
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

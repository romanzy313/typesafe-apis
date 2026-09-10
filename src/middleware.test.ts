import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient } from "./client.js";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";
import { createMiddleware, type MiddlewareHandler } from "./middleware.js";
import { contractHandler, serverEndpoint } from "./server.js";
import type { RequestContext, TypedRequest } from "./types.js";

const stringToNumber = z.codec(z.string(), z.number(), {
  decode: Number,
  encode: String,
});
const authContract = contract()
  .query(zodCodec(z.object({ fail: z.stringbool() })))
  .response(403, zodCodec(z.object({ error: z.literal("auth_please") })));
const testContract = authContract
  .route("POST", "/test/:id", zodCodec(z.object({ id: stringToNumber })))
  .request(zodCodec(z.object({ name: z.string() })))
  .response(200, zodCodec(z.object({ hello: z.string() })))
  .response(418, zodCodec(z.object({ funFact: z.string() })));

type ServerContext = { greeting: string; userName: string };
type TraceContext = { traceId: string };
type AuthContext = { user: { name: string } };
const serverContext: Readonly<ServerContext> = Object.freeze({
  greeting: "Hello",
  userName: "Ada",
});

const authenticate = createMiddleware<
  { userName: string },
  TraceContext,
  AuthContext
>()(
  {
    query: authContract.definition.query,
    responses: authContract.definition.responses,
  },
  async (req, server, context, next) => {
    expectTypeOf(context.traceId).toEqualTypeOf<string>();
    if (req.query.fail) {
      return { status: 403, body: { error: "auth_please" } };
    }
    return next({ user: { name: server.userName } });
  },
);

function createRequest(id = 7, fail = false) {
  return new Request(`https://example.com/test/${id}?fail=${fail}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "world" }),
  });
}

function tracedEndpoint() {
  return serverEndpoint<ServerContext>()
    .contract(testContract)
    .use<TraceContext>(async (req, _server, _context, next) =>
      next({ traceId: `request-${req.params.id}` }),
    );
}

describe("createMiddleware", () => {
  it("infers decoded requirements and preserves explicit context types", () => {
    const middleware = createMiddleware<
      ServerContext,
      TraceContext,
      AuthContext
    >()(testContract.definition, async (req, server, context, next) => {
      expectTypeOf(req).toEqualTypeOf<
        TypedRequest<{ id: number }, { fail: boolean }, { name: string }>
      >();
      expectTypeOf(server).toEqualTypeOf<Readonly<ServerContext>>();
      expectTypeOf(context).toEqualTypeOf<RequestContext & TraceContext>();
      expectTypeOf(next).parameter(0).toEqualTypeOf<
        AuthContext & Partial<RequestContext>
      >();
      return next({ user: { name: server.userName } });
    });

    expectTypeOf(middleware).toEqualTypeOf<
      MiddlewareHandler<
        { id: number },
        { fail: boolean },
        { name: string },
        typeof testContract.definition.responses,
        ServerContext,
        TraceContext,
        AuthContext
      >
    >();
    tracedEndpoint().use(middleware);
  });

  it("allows middleware without request or response requirements", async () => {
    const middleware = createMiddleware()(
      {},
      async (req, server, context, next) => {
        expectTypeOf(req).toEqualTypeOf<
          TypedRequest<unknown, unknown, unknown>
        >();
        expectTypeOf(server).toEqualTypeOf<Readonly<{}>>();
        expectTypeOf(context).toEqualTypeOf<RequestContext>();
        return next({});
      },
    );
    const bound = serverEndpoint()
      .contract(testContract)
      .use(middleware)
      .handler(async (req) => ({
        status: 200,
        body: { hello: req.body.name },
      }));

    const response = await bound.fetchWithContext(createRequest(), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "world" });
  });

  it("does not narrow request requirements from callback annotations", () => {
    const nextOnly = async () => {
      throw new Error("Type test only");
    };
    const withParams = async (_req: { params: { id: string } }) => nextOnly();
    const withQuery = async (_req: { query: { fail: true } }) => nextOnly();
    const withBody = async (_req: { body: { name: number } }) => nextOnly();

    createMiddleware()(
      { params: testContract.definition.params },
      // @ts-expect-error The codec decodes id to a number.
      withParams,
    );
    createMiddleware()(
      { query: authContract.definition.query },
      // @ts-expect-error The codec can decode fail to either boolean value.
      withQuery,
    );
    createMiddleware()(
      { request: testContract.definition.request },
      // @ts-expect-error The codec decodes name to a string.
      withBody,
    );
  });

  it("rejects responses not declared by its requirements", () => {
    const requirements = { responses: authContract.definition.responses };

    createMiddleware()(
      requirements,
      // @ts-expect-error Only the declared 403 response is allowed.
      async () => ({ status: 200 as const, body: { hello: "world" } }),
    );
    createMiddleware()(
      requirements,
      // @ts-expect-error The declared error is the literal auth_please.
      async () => ({ status: 403 as const, body: { error: "other" as const } }),
    );
    createMiddleware()(
      {},
      // @ts-expect-error Without response requirements middleware must use next.
      async () => ({ status: 403 as const, body: { error: "auth_please" } }),
    );
    createMiddleware()(
      // @ts-expect-error Status 104 is absent from Hono's StatusCode.
      { responses: { ...requirements.responses, 104: zodCodec(z.string()) } },
      async (_req, _server, _context, next) => next({}),
    );
  });
});

describe("middleware composition", () => {
  it.each([false, true])(
    "writes middleware response headers with fail=%s",
    async (fail) => {
      const bound = tracedEndpoint()
        .use(async (req, _server, context, next) => {
          expectTypeOf(req.headers).toEqualTypeOf<Readonly<Headers>>();
          expectTypeOf(context.headers).toEqualTypeOf<Headers>();
          context.headers.set("x-trace-id", req.headers.get("x-trace-id")!);
          const response = await next({});
          context.headers.set("x-status", String(response.status));
          return response;
        })
        .use(authenticate)
        .handler(async (_req, _server, context) => {
          context.headers.set("x-user", context.user.name);
          return { status: 200, body: { hello: context.user.name } };
        });
      const request = createRequest(7, fail);
      request.headers.set("x-trace-id", "client-trace");
      request.headers.set("authorization", "Bearer example-token");

      const response = await bound.fetchWithContext(request, serverContext);

      expect(response.status).toBe(fail ? 403 : 200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("x-trace-id")).toBe("client-trace");
      expect(response.headers.get("x-status")).toBe(fail ? "403" : "200");
      expect(response.headers.get("x-user")).toBe(fail ? null : "Ada");
      expect(response.headers.has("authorization")).toBe(false);
      expect(await response.json()).toEqual(
        fail ? { error: "auth_please" } : { hello: "Ada" },
      );
    },
  );

  it.each([false, true])(
    "preserves replaced headers when downstream throws=%s",
    async (throws) => {
      const error = new Error("Handler failed");
      const replacement = new Headers({ "x-inner": "set" });
      const requestContext: RequestContext = { headers: new Headers() };
      const bound = serverEndpoint<ServerContext>()
        .contract(testContract)
        .use(async (_req, _server, context, next) => {
          try {
            return await next({ headers: replacement });
          } catch (caught) {
            expect(caught).toBe(error);
            return { status: 403, body: { error: "auth_please" } };
          } finally {
            context.headers.set("x-outer", "set");
          }
        })
        .handler(async (_req, _server, context) => {
          context.headers.set("x-handler", "set");
          if (throws) throw error;
          return { status: 200, body: { hello: "world" } };
        });

      const response = await bound.handle(
        {
          params: { id: 7 },
          query: { fail: false },
          body: { name: "world" },
          headers: new Headers(),
        },
        serverContext,
        requestContext,
      );

      expect(response.status).toBe(throws ? 403 : 200);
      expect(requestContext.headers).toBe(replacement);
      expect([...requestContext.headers]).toEqual([
        ["x-handler", "set"],
        ["x-inner", "set"],
        ["x-outer", "set"],
      ]);
    },
  );

  it.each([false, true])(
    "runs middleware for typed requests with fail=%s",
    async (fail) => {
      const handlerCalled = vi.fn();
      const bound = tracedEndpoint()
        .use(authenticate)
        .handler(async (req, server, context) => {
          handlerCalled();
          expect(server).toBe(serverContext);
          expect(context.traceId).toBe("request-7");
          return {
            status: 200,
            body: {
              hello: `${server.greeting} ${context.user.name}, ${req.body.name}`,
            },
          };
        });

      await expect(
        bound.handle(
          {
            params: { id: 7 },
            query: { fail },
            body: { name: "world" },
            headers: new Headers(),
          },
          serverContext,
        ),
      ).resolves.toEqual(
        fail
          ? { status: 403, body: { error: "auth_please" } }
          : { status: 200, body: { hello: "Hello Ada, world" } },
      );
      expect(handlerCalled).toHaveBeenCalledTimes(fail ? 0 : 1);
    },
  );

  it("runs nested middleware through HTTP JSON", async () => {
    const order: string[] = [];
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      .use<TraceContext>(async (req, server, context, next) => {
        expect(context).toEqual({ headers: new Headers() });
        expect(server).toBe(serverContext);
        expect(req).toEqual({
          params: { id: 7 },
          query: { fail: false },
          body: { name: "world" },
          headers: new Headers({ "content-type": "application/json" }),
        });
        order.push("trace before");
        const response = await next({ traceId: `request-${req.params.id}` });
        order.push("trace after");
        return response;
      })
      .use(authenticate)
      .use(async (_req, _server, context, next) => {
        expect(context).toEqual({
          traceId: "request-7",
          user: { name: "Ada" },
          headers: new Headers(),
        });
        order.push("inner before");
        const response = await next({});
        order.push("inner after");
        return response;
      })
      .handler(async (req, server, context) => {
        expectTypeOf(req.params.id).toEqualTypeOf<number>();
        expectTypeOf(req.query.fail).toEqualTypeOf<boolean>();
        expectTypeOf(context.traceId).toEqualTypeOf<string>();
        expectTypeOf(context.user).toEqualTypeOf<AuthContext["user"]>();
        expect(context.traceId).toBe("request-7");
        order.push("handler");
        return {
          status: 200,
          body: {
            hello: `${server.greeting} ${context.user.name}, ${req.body.name}`,
          },
        };
      });
    const fetch = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => bound.fetchWithContext(request, serverContext),
    }).contract(testContract);

    await expect(
      fetch({
        params: { id: 7 },
        query: { fail: false },
        body: { name: "world" },
        headers: new Headers(),
      }),
    ).resolves.toEqual({ status: 200, body: { hello: "Hello Ada, world" } });
    expect(bound.definition).toBe(testContract.definition);
    expect(order).toEqual([
      "trace before",
      "inner before",
      "handler",
      "inner after",
      "trace after",
    ]);
  });

  it("short-circuits the chain with an auth response", async () => {
    const outerResponse = vi.fn();
    const afterAuth = vi.fn();
    const handlerCalled = vi.fn();
    const bound = tracedEndpoint()
      .use(async (_req, _server, _context, next) => {
        const response = await next({});
        outerResponse(response.status);
        return response;
      })
      .use(authenticate)
      .use(async (_req, _server, _context, next) => {
        afterAuth();
        return next({});
      })
      .handler(async () => {
        handlerCalled();
        return { status: 200, body: { hello: "world" } };
      });

    const response = await bound.fetchWithContext(
      createRequest(7, true),
      serverContext,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "auth_please" });
    expect(outerResponse).toHaveBeenCalledExactlyOnceWith(403);
    expect(afterAuth).not.toHaveBeenCalled();
    expect(handlerCalled).not.toHaveBeenCalled();
  });

  it("reuses middleware across compatible contracts", async () => {
    const otherContract = authContract
      .route("GET", "/other/:slug", zodCodec(z.object({ slug: z.string() })))
      .query(zodCodec(z.object({ locale: z.string() })))
      .response(201, zodCodec(z.object({ location: z.string() })));
    const bound = serverEndpoint<ServerContext>()
      .contract(otherContract)
      .use<TraceContext>(async (req, _server, _context, next) =>
        next({ traceId: req.params.slug }),
      )
      .use(authenticate)
      .handler(async (req, _server, context) => ({
        status: 201,
        body: {
          location: `${req.query.locale}/${context.user.name}/${context.traceId}`,
        },
      }));

    const response = await bound.fetchWithContext(
      new Request("https://example.com/other/item?fail=false&locale=en"),
      serverContext,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ location: "en/Ada/item" });
  });

  it("branches chains and replaces request context fields", async () => {
    const base = tracedEndpoint().use(authenticate);
    const replaced = base
      .use<{ traceId: number }>(async (_req, _server, context, next) =>
        next({ traceId: context.traceId.length }),
      )
      .handler(async (_req, _server, context) => {
        expectTypeOf(context.traceId).toEqualTypeOf<number>();
        expectTypeOf(context.user).toEqualTypeOf<AuthContext["user"]>();
        return {
          status: 200,
          body: { hello: `${context.user.name}:${context.traceId}` },
        };
      });
    const original = base.handler(async (_req, _server, context) => {
      expectTypeOf(context.traceId).toEqualTypeOf<string>();
      return {
        status: 200,
        body: { hello: `${context.user.name}:${context.traceId}` },
      };
    });

    const [left, right] = await Promise.all([
      replaced.fetchWithContext(createRequest(), serverContext),
      original.fetchWithContext(createRequest(), serverContext),
    ]);

    expect(await left.json()).toEqual({ hello: "Ada:9" });
    expect(await right.json()).toEqual({ hello: "Ada:request-7" });
  });

  it("retains context fields omitted by optional updates", async () => {
    const bound = tracedEndpoint()
      .use<{ traceId?: number }>(async (req, _server, _context, next) =>
        next(req.query.fail ? { traceId: 42 } : {}),
      )
      .handler(async (_req, _server, context) => {
        expectTypeOf(context.traceId).toEqualTypeOf<string | number>();
        return { status: 200, body: { hello: String(context.traceId) } };
      });

    const [unchanged, updated] = await Promise.all([
      bound.fetchWithContext(createRequest(), serverContext),
      bound.fetchWithContext(createRequest(7, true), serverContext),
    ]);

    expect(await unchanged.json()).toEqual({ hello: "request-7" });
    expect(await updated.json()).toEqual({ hello: "42" });
  });

  it("starts concurrent requests with separate contexts and headers", async () => {
    const contexts: RequestContext[] = [];
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      .use<{ requestId: number }>(async (req, server, context, next) => {
        expect(context).toEqual({ headers: new Headers() });
        expect(server).toBe(serverContext);
        context.headers.set("x-request-id", String(req.params.id));
        contexts.push(context);
        await Promise.resolve();
        return next({ requestId: req.params.id });
      })
      .handler(async (_req, server, context) => {
        await Promise.resolve();
        return {
          status: 200,
          body: { hello: `${server.greeting}:${context.requestId}` },
        };
      });

    const [first, second, third] = await Promise.all([
      bound.fetchWithContext(createRequest(1), serverContext),
      bound.fetchWithContext(createRequest(2), serverContext),
      bound.handle(
        {
          params: { id: 3 },
          query: { fail: false },
          body: { name: "world" },
          headers: new Headers(),
        },
        serverContext,
      ),
    ]);

    expect(contexts).toHaveLength(3);
    expect(new Set(contexts).size).toBe(3);
    expect(new Set(contexts.map((context) => context.headers)).size).toBe(3);
    expect(first.headers.get("x-request-id")).toBe("1");
    expect(second.headers.get("x-request-id")).toBe("2");
    expect(await first.json()).toEqual({ hello: "Hello:1" });
    expect(await second.json()).toEqual({ hello: "Hello:2" });
    expect(third).toEqual({ status: 200, body: { hello: "Hello:3" } });
    expect(serverContext).toEqual({ greeting: "Hello", userName: "Ada" });
  });

  it("binds a handler directly with both contexts", async () => {
    const bound = contractHandler(
      testContract,
      async (req, server: Readonly<ServerContext>, context) => {
        expectTypeOf(context).toEqualTypeOf<RequestContext>();
        expect(context).toEqual({ headers: new Headers() });
        return {
          status: 200,
          body: { hello: `${server.greeting} ${req.body.name}` },
        };
      },
    );

    const response = await bound.fetchWithContext(
      createRequest(),
      serverContext,
    );

    expect(await response.json()).toEqual({ hello: "Hello world" });
  });

  it("validates the request before calling middleware", async () => {
    const called = vi.fn();
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      .use(async (_req, _server, _context, next) => {
        called();
        return next({});
      })
      .handler(async () => ({ status: 200, body: { hello: "world" } }));
    const request = new Request("https://example.com/test/7?fail=invalid", {
      method: "POST",
      body: JSON.stringify({ name: "world" }),
    });

    await expect(
      bound.fetchWithContext(request, serverContext),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(called).not.toHaveBeenCalled();
  });

  it.each(["middleware", "handler"] as const)(
    "propagates %s failures",
    async (source) => {
      const error = new Error("Request failed");
      const bound = serverEndpoint<ServerContext>()
        .contract(testContract)
        .use(async (_req, _server, _context, next) => {
          if (source === "middleware") throw error;
          return next({});
        })
        .handler(async () => {
          throw error;
        });

      await expect(
        bound.fetchWithContext(createRequest(), serverContext),
      ).rejects.toBe(error);
      await expect(
        bound.handle(
          {
            params: { id: 7 },
            query: { fail: false },
            body: { name: "world" },
            headers: new Headers(),
          },
          serverContext,
        ),
      ).rejects.toBe(error);
    },
  );

  it("rejects undeclared middleware responses", async () => {
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      // @ts-expect-error Status 500 is not declared by the contract.
      .use(async () => ({ status: 500 as const, body: { error: "failed" } }))
      .handler(async () => ({ status: 200, body: { hello: "world" } }));

    await expect(
      bound.fetchWithContext(createRequest(), serverContext),
    ).rejects.toThrow("No encoder for status 500");
  });

  it("validates a short-circuited response body", async () => {
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      // @ts-expect-error The declared error is the literal auth_please.
      .use(async () => ({ status: 403 as const, body: { error: 42 } }))
      .handler(async () => ({ status: 200, body: { hello: "world" } }));

    await expect(
      bound.fetchWithContext(createRequest(), serverContext),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("rejects middleware that returns no response", async () => {
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      // @ts-expect-error Middleware must return its own response or next().
      .use(async () => undefined)
      .handler(async () => ({ status: 200, body: { hello: "world" } }));

    await expect(
      bound.fetchWithContext(createRequest(), serverContext),
    ).rejects.toThrow("Middleware returned undefined");
  });

  it("requires a route before binding a handler", () => {
    expect(() => {
      serverEndpoint<ServerContext>()
        // @ts-expect-error The base contract has no route.
        .contract(authContract)
        .handler(async () => ({
          status: 403,
          body: { error: "auth_please" },
        }));
    }).toThrow("Contract must define a route with .route()");
  });
});

describe("middleware types", () => {
  it("keeps server context readonly and types next context", () => {
    const bound = serverEndpoint<ServerContext>()
      .contract(testContract)
      .use<AuthContext>(async (_req, server, context, next) => {
        expectTypeOf(server).toEqualTypeOf<Readonly<ServerContext>>();
        expectTypeOf(context).toEqualTypeOf<RequestContext>();
        // @ts-expect-error Middleware cannot reassign server context fields.
        server.userName = "changed";
        // @ts-expect-error Authentication has not added a user yet.
        context.user;
        // @ts-expect-error next must receive the declared context fields.
        next({});
        // @ts-expect-error The user name must be a string.
        next({ user: { name: 42 } });
        // @ts-expect-error Replacing context headers requires Headers.
        next({ user: { name: "Ada" }, headers: "invalid" });
        return next({ user: { name: server.userName } });
      })
      .handler(async (_req, server, context) => {
        expectTypeOf(server).toEqualTypeOf<Readonly<ServerContext>>();
        expectTypeOf(context.user).toEqualTypeOf<AuthContext["user"]>();
        // @ts-expect-error Handlers cannot reassign server context fields.
        server.greeting = "changed";
        return { status: 200, body: { hello: context.user.name } };
      });

    expectTypeOf(bound.fetchWithContext).toEqualTypeOf<
      (request: Request, server: Readonly<ServerContext>) => Promise<Response>
    >();
    expectTypeOf(bound.handle).parameter(1).toEqualTypeOf<
      Readonly<ServerContext>
    >();
    const typedRequest = {
      params: { id: 7 },
      query: { fail: false },
      body: { name: "world" },
      headers: new Headers(),
    };
    expectTypeOf(bound.handle).toBeCallableWith(typedRequest, serverContext);
    expectTypeOf(bound.handle).toBeCallableWith(typedRequest, serverContext, {
      headers: new Headers(),
    });
    expectTypeOf(bound.handle).toBeCallableWith(typedRequest, serverContext, {
      // @ts-expect-error The base context requires a Headers instance.
      headers: { "x-test": "value" },
    });
    // @ts-expect-error The server context is required for typed requests too.
    expectTypeOf(bound.handle).toBeCallableWith(typedRequest);
    // @ts-expect-error The server context must supply both configured fields.
    expectTypeOf(bound.handle).toBeCallableWith(typedRequest, {});
    expectTypeOf(bound.handle).toBeCallableWith(
      typedRequest,
      serverContext,
      // @ts-expect-error A supplied base context must include headers.
      { user: { name: "injected" } },
    );
    const request = createRequest();
    const url = request.url;
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(
      request,
      serverContext,
    );
    // @ts-expect-error The server context is required at the request boundary.
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(request);
    // @ts-expect-error The server context must supply both configured fields.
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(request, {});
    // @ts-expect-error The endpoint accepts a Request, not a URL string.
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(url, serverContext);
  });

  it("checks middleware context dependencies", () => {
    const empty = serverEndpoint<ServerContext>().contract(testContract);
    // @ts-expect-error authenticate requires traceId in the request context.
    empty.use(authenticate);

    const wrongTrace = empty.use<{ traceId: number }>(
      async (_req, _server, _context, next) => next({ traceId: 1 }),
    );
    // @ts-expect-error authenticate requires a string traceId.
    wrongTrace.use(authenticate);

    const optionalTrace = empty.use<{ traceId?: string }>(
      async (_req, _server, _context, next) => next({}),
    );
    // @ts-expect-error authenticate requires traceId to be present.
    optionalTrace.use(authenticate);

    // @ts-expect-error authenticate adds a string user name, not a number.
    tracedEndpoint().use<{ user: { name: number } }>(authenticate);

    const missingServer = serverEndpoint<{}>()
      .contract(testContract)
      .use<TraceContext>(async (_req, _server, _context, next) =>
        next({ traceId: "id" }),
      );
    // @ts-expect-error authenticate requires userName in server context.
    missingServer.use(authenticate);
  });

  it("checks middleware contract requirements", () => {
    const wrongQueryContract = contract()
      .route("GET", "/wrong", zodCodec(z.object({})))
      .query(zodCodec(z.object({ fail: z.string() })))
      .response(403, authContract.definition.responses[403]);
    const wrongQuery = serverEndpoint<ServerContext>()
      .contract(wrongQueryContract)
      .use<TraceContext>(async (_req, _server, _context, next) =>
        next({ traceId: "id" }),
      );
    // @ts-expect-error authenticate requires a boolean fail query.
    wrongQuery.use(authenticate);

    const missingResponseContract = contract()
      .route("GET", "/missing", zodCodec(z.object({})))
      .query(authContract.definition.query)
      .response(200, zodCodec(z.string()));
    const missingResponse = serverEndpoint<ServerContext>()
      .contract(missingResponseContract)
      .use<TraceContext>(async (_req, _server, _context, next) =>
        next({ traceId: "id" }),
      );
    // @ts-expect-error authenticate requires a response for status 403.
    missingResponse.use(authenticate);

    const wrongResponse = serverEndpoint<ServerContext>()
      .contract(missingResponseContract.response(403, zodCodec(z.number())))
      .use<TraceContext>(async (_req, _server, _context, next) =>
        next({ traceId: "id" }),
      );
    // @ts-expect-error authenticate returns an error object, not a number.
    wrongResponse.use(authenticate);
  });

  it("checks final handler context and responses", () => {
    const builder = tracedEndpoint().use(authenticate);
    // @ts-expect-error Status 500 is not in the contract.
    builder.handler(async () => ({ status: 500, body: { hello: "world" } }));
    // @ts-expect-error The success response must contain hello.
    builder.handler(async () => ({ status: 200, body: { error: "wrong" } }));
    const wrongContextHandler = async (
      _req: unknown,
      _server: Readonly<ServerContext>,
      _context: { user: { name: number } },
    ) => ({ status: 200 as const, body: { hello: "world" } });
    // @ts-expect-error The accumulated user name is a string.
    builder.handler(wrongContextHandler);
    // @ts-expect-error Direct binding supplies headers, not an authenticated user.
    contractHandler(testContract, wrongContextHandler);
  });
});

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import z from "zod";
import { createClient } from "./client.js";
import { zodCodec } from "./codec.js";
import { compileContract, contract, type InferResponses } from "./contract.js";
import { createMiddleware, type Middleware } from "./middleware.js";
import { contractHandler, serverEndpoint } from "./server.js";
import { getSidechannelHeader, sidechannelHeaderKey } from "./sidechannel.js";
import type {
  RequestContext,
  ReadonlyHeaders,
  ServerRequest,
} from "./types.js";

const stringToNumber = z.codec(z.string(), z.number(), {
  decode: Number,
  encode: String,
});

const authQuery = zodCodec(z.object({ fail: z.stringbool() }));
const authResponse = zodCodec(z.object({ error: z.literal("auth_please") }));
const authContract = contract().query(authQuery).response(403, authResponse);

const testContract = authContract
  .method("POST")
  .path("/test/:id", zodCodec(z.object({ id: stringToNumber })))
  .request(zodCodec(z.object({ name: z.string() })))
  .response(200, zodCodec(z.object({ hello: z.string() })))
  .response(418, zodCodec(z.object({ funFact: z.string() })));

type ServerEnvironment = { greeting: string; userName: string };
type TraceVariables = { traceId: string };
type AuthVariables = { user: { name: string } };
const env: Readonly<ServerEnvironment> = Object.freeze({
  greeting: "Hello",
  userName: "Ada",
});

const authenticate = createMiddleware<
  { userName: string },
  TraceVariables,
  AuthVariables
>()(authContract, async ({ req, env: server, vars: variables }, next) => {
  expectTypeOf(variables.traceId).toEqualTypeOf<string>();
  if (req.query.fail) {
    return { status: 403, body: { error: "auth_please" } };
  }
  return next({ user: { name: server.userName } });
});

function createRequest(id = 7, fail = false) {
  return new Request(`https://example.com/test/${id}?fail=${fail}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "world" }),
  });
}

function tracedEndpoint() {
  return serverEndpoint<ServerEnvironment>()
    .contract(testContract)
    .use<TraceVariables>(async ({ req }, next) =>
      next({ traceId: `request-${req.params.id}` }),
    );
}

describe("createMiddleware", () => {
  it("infers factory and inline variable additions without explicit output types", async () => {
    const auth = createMiddleware<ServerEnvironment>()(
      authContract,
      async ({ req, env, vars }, next) => {
        expectTypeOf(vars).toEqualTypeOf<Readonly<{}>>();
        if (req.query.fail)
          return { status: 403, body: { error: "auth_please" } };
        return next({ ...vars, userId: env.userName });
      },
    );
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use(auth)
      .use((context, next) => {
        expectTypeOf(context.vars.userId).toEqualTypeOf<string>();
        // @ts-expect-error The previous middleware has not added requestId.
        expectTypeOf(context.vars.requestId);
        return next({ ...context.vars, requestId: context.req.params.id });
      })
      .use(async (context, next) => {
        expectTypeOf(context.vars.userId).toEqualTypeOf<string>();
        expectTypeOf(context.vars.requestId).toEqualTypeOf<number>();
        const response = await next({ label: "inline" });
        context.res.headers.set("x-status", String(response.status));
        return response;
      })
      .handler(async ({ vars }) => {
        expectTypeOf(vars.userId).toEqualTypeOf<string>();
        expectTypeOf(vars.requestId).toEqualTypeOf<number>();
        expectTypeOf(vars.label).toEqualTypeOf<string>();
        if (false) {
          // @ts-expect-error Inferred variables remain readonly.
          vars.userId = "changed";
        }
        return {
          status: 200,
          body: { hello: `${vars.userId}:${vars.requestId}:${vars.label}` },
        };
      });
    const response = await bound.fetchWithContext(createRequest(7), env);
    expect(await response.json()).toEqual({ hello: "Ada:7:inline" });
    expect(response.headers.get("x-status")).toBe("200");
  });

  it("preserves branch-dependent replacements when inferring variables", async () => {
    const bound = tracedEndpoint()
      .use((context, next) =>
        context.req.query.fail ? next({ traceId: 42 }) : next({}),
      )
      .handler(async ({ vars }) => {
        expectTypeOf(vars.traceId).toEqualTypeOf<string | number>();
        return { status: 200, body: { hello: String(vars.traceId) } };
      });
    const [original, changed] = await Promise.all([
      bound.fetchWithContext(createRequest(7, false), env),
      bound.fetchWithContext(createRequest(7, true), env),
    ]);
    expect(await original.json()).toEqual({ hello: "request-7" });
    expect(await changed.json()).toEqual({ hello: "42" });
  });

  it("does not promise fields omitted by a continuation branch", () => {
    const optionalAuth = createMiddleware()(authContract, (context, next) =>
      context.req.query.fail ? next({}) : next({ userId: "Ada" }),
    );
    serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use(optionalAuth)
      .handler(async ({ vars }) => {
        // @ts-expect-error The userId field is absent on one continuation path.
        expectTypeOf(vars.userId);
        if ("userId" in vars) expectTypeOf(vars.userId).toEqualTypeOf<string>();
        return { status: 200, body: { hello: "world" } };
      });
  });

  it("checks inline error responses while inferring successful additions", async () => {
    const base = serverEndpoint<ServerEnvironment>().contract(testContract);
    const bound = base
      .use(async (context, next) => {
        if (context.req.query.fail)
          return { status: 403, body: { error: "auth_please" } };
        return next({ userId: context.env.userName });
      })
      .handler(async ({ vars }) => ({
        status: 200,
        body: { hello: vars.userId },
      }));
    const response = await bound.fetchWithContext(createRequest(7, true), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "auth_please" });
    // @ts-expect-error An inferred callback must return a declared status and body.
    base.use(async (_context, _next) => ({
      status: 500,
      body: { error: "failed" },
    }));
    // @ts-expect-error The auth response literal is checked for inferred callbacks.
    base.use(async (_context, _next) => ({
      status: 403,
      body: { error: "other" },
    }));
  });

  it("keeps an explicit absent-body requirement distinct from an omitted one", async () => {
    const requirements = contract().request(zodCodec(z.undefined()));
    const middleware = createMiddleware()(
      requirements,
      async ({ req }, next) => {
        expectTypeOf(req.body).toBeUndefined();
        expectTypeOf(req.params).toBeUnknown();
        expectTypeOf(req.query).toBeUnknown();
        return next({});
      },
    );
    const endpoint = serverEndpoint()
      .contract(contract().method("GET").response(200, zodCodec(z.string())))
      .use(middleware)
      .handler(async () => ({ status: 200, body: "ok" }));
    await expect(
      endpoint.handle({
        req: {
          params: {},
          query: {},
          body: undefined,
          headers: new Headers(),
        },
        env: {},
      }),
    ).resolves.toEqual({ status: 200, body: "ok" });
    // @ts-expect-error This middleware requires an absent body.
    serverEndpoint().contract(testContract).use(middleware);
  });

  it("infers decoded requirements and preserves explicit variables types", () => {
    const middleware = createMiddleware<
      ServerEnvironment,
      TraceVariables,
      AuthVariables
    >()(testContract, async ({ req, env: server, vars: variables }, next) => {
      expectTypeOf(req).toEqualTypeOf<
        ServerRequest<{ id: number }, { fail: boolean }, { name: string }>
      >();
      expectTypeOf(server).toEqualTypeOf<Readonly<ServerEnvironment>>();
      expectTypeOf(variables).toEqualTypeOf<Readonly<TraceVariables>>();
      expectTypeOf(next).parameter(0).toEqualTypeOf<AuthVariables>();
      return next({ user: { name: server.userName } });
    });

    expectTypeOf(middleware).toEqualTypeOf<
      Middleware<
        { id: number },
        { fail: boolean },
        { name: string },
        InferResponses<typeof testContract>,
        ServerEnvironment,
        TraceVariables,
        AuthVariables
      >
    >();
    tracedEndpoint().use(middleware);
  });

  it("allows middleware without request or response requirements", async () => {
    const middleware = createMiddleware()(
      contract(),
      async ({ req, env: server, vars: variables }, next) => {
        expectTypeOf(req).toEqualTypeOf<
          ServerRequest<unknown, unknown, unknown>
        >();
        expectTypeOf(server).toEqualTypeOf<Readonly<{}>>();
        expectTypeOf(variables).toEqualTypeOf<Readonly<{}>>();
        return next({});
      },
    );
    const bound = serverEndpoint()
      .contract(testContract)
      .use(middleware)
      .handler(async ({ req }) => ({
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
    const withParams = async (_context: { req: { params: { id: string } } }) =>
      nextOnly();
    const withQuery = async (_context: { req: { query: { fail: true } } }) =>
      nextOnly();
    const withBody = async (_context: { req: { body: { name: number } } }) =>
      nextOnly();

    createMiddleware()(
      contract().path("/:id", zodCodec(z.object({ id: stringToNumber }))),
      // @ts-expect-error The codec decodes id to a number.
      withParams,
    );
    createMiddleware()(
      authContract,
      // @ts-expect-error The codec can decode fail to either boolean value.
      withQuery,
    );
    createMiddleware()(
      contract().request(zodCodec(z.object({ name: z.string() }))),
      // @ts-expect-error The codec decodes name to a string.
      withBody,
    );
  });

  it("rejects responses not declared by its requirements", () => {
    const requirements = contract().response(403, authResponse);

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
      contract(),
      // @ts-expect-error Without response requirements middleware must use next.
      async () => ({ status: 403 as const, body: { error: "auth_please" } }),
    );
    createMiddleware()(
      // @ts-expect-error Status 104 is absent from Hono's StatusCode.
      requirements.response(104, zodCodec(z.string())),
      async (_context, next) => next({}),
    );
  });
});

describe("middleware.merge", () => {
  it("composes callable middleware in order and preserves shared context", async () => {
    const order: string[] = [];
    const res = { headers: new Headers() };
    const params = zodCodec(z.object({ id: stringToNumber }));
    const compile = vi.spyOn(params, "compile");
    const first = createMiddleware<{ greeting: string }>()(
      contract().path("/:id", params),
      async (context, next) => {
        expect(context.res).toBe(res);
        expect(context.env).toBe(env);
        order.push("first before");
        const response = await next({
          traceId: `${context.env.greeting}:${context.req.params.id}`,
        });
        expect(context.vars).toEqual({ upstream: true });
        order.push("first after");
        context.res.headers.set("x-order", order.join(","));
        return response;
      },
    );
    const second = createMiddleware<{ userName: string }, TraceVariables>()(
      authContract,
      async ({ req, env, vars, res: response }, next) => {
        expect(vars.traceId).toBe("Hello:7");
        expect(req.query.fail).toBe(false);
        expect(response).toBe(res);
        order.push("second before");
        const result = await next({ userId: env.userName });
        order.push("second after");
        return result;
      },
    );
    const third = createMiddleware<{}, { userId: string }>()(
      contract().request(zodCodec(z.object({ name: z.string() }))),
      async ({ req, vars }, next) => {
        order.push("third before");
        const response = await next({
          label: `${vars.userId}:${req.body.name}`,
        });
        order.push("third after");
        return response;
      },
    );
    const merged = first.merge(second).merge(third);
    expect(merged).toBeTypeOf("function");
    expect(merged).not.toBe(first);
    expect(order).toEqual([]);
    expect(compile).not.toHaveBeenCalled();

    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use((_context, next) => next({ upstream: true }))
      .use(merged)
      .handler(async ({ vars, res: response }) => {
        expectTypeOf(vars.traceId).toEqualTypeOf<string>();
        expectTypeOf(vars.userId).toEqualTypeOf<string>();
        expectTypeOf(vars.label).toEqualTypeOf<string>();
        expectTypeOf(vars.upstream).toEqualTypeOf<boolean>();
        expect(response).toBe(res);
        expect(vars).toEqual({
          upstream: true,
          traceId: "Hello:7",
          userId: "Ada",
          label: "Ada:world",
        });
        if (false) {
          // @ts-expect-error Merged variables remain readonly.
          vars.userId = "changed";
        }
        order.push("handler");
        return { status: 200, body: { hello: vars.label } };
      });
    await expect(
      bound.handle({
        req: {
          params: { id: 7 },
          query: { fail: false },
          body: { name: "world" },
        },
        env,
        res,
      }),
    ).resolves.toEqual({ status: 200, body: { hello: "Ada:world" } });
    expect(order).toEqual([
      "first before",
      "second before",
      "third before",
      "handler",
      "third after",
      "second after",
      "first after",
    ]);
    expect(res.headers.get("x-order")).toBe(order.join(","));

    // Composing the right-hand side first keeps the same requirements and outputs.
    const nested = first.merge(second.merge(third));
    expectTypeOf(nested).toMatchTypeOf<typeof merged>();
    serverEndpoint<ServerEnvironment>().contract(testContract).use(nested);
    serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use(first)
      .handler(async ({ vars }) => {
        // @ts-expect-error The original middleware has no userId addition.
        expectTypeOf(vars.userId);
        return { status: 200, body: { hello: vars.traceId } };
      });
  });

  it.each(["first", "second", "third", "none"] as const)(
    "preserves early response alternatives with stop=%s",
    async (stop) => {
      const order: string[] = [];
      const query = contract().query(zodCodec(z.object({ stop: z.string() })));
      const firstContract = query.response(
        403,
        zodCodec(z.object({ error: z.literal("first") })),
      );
      const secondContract = query.response(
        403,
        zodCodec(z.object({ error: z.literal("second") })),
      );
      const thirdContract = query.response(
        418,
        zodCodec(z.object({ error: z.literal("third") })),
      );
      const first = createMiddleware()(firstContract, async ({ req }, next) => {
        order.push("first");
        if (req.query.stop === "first")
          return { status: 403, body: { error: "first" } };
        return next({});
      });
      const second = createMiddleware()(
        secondContract,
        async ({ req }, next) => {
          order.push("second");
          if (req.query.stop === "second")
            return { status: 403, body: { error: "second" } };
          return next({});
        },
      );
      const third = createMiddleware()(thirdContract, async ({ req }, next) => {
        order.push("third");
        if (req.query.stop === "third")
          return { status: 418, body: { error: "third" } };
        return next({});
      });
      const merged = first.merge(second).merge(third);
      const ready = firstContract
        .merge(secondContract)
        .merge(thirdContract)
        .method("GET")
        .response(200, zodCodec(z.string()));
      const bound = serverEndpoint()
        .contract(ready)
        .use(merged)
        .handler(async () => {
          order.push("handler");
          return { status: 200, body: "ok" };
        });
      const response = await bound.fetchWithContext(
        new Request(`https://example.com/?stop=${stop}`),
        {},
      );
      expect(response.status).toBe(
        stop === "none" ? 200 : stop === "third" ? 418 : 403,
      );
      expect(await response.json()).toEqual(
        stop === "none" ? "ok" : { error: stop },
      );
      const steps = ["first", "second", "third", "handler"];
      expect(order).toEqual(
        steps.slice(0, stop === "none" ? 4 : steps.indexOf(stop) + 1),
      );
      serverEndpoint()
        .contract(firstContract.merge(thirdContract).method("GET"))
        // @ts-expect-error Both distinct bodies for 403 must be declared.
        .use(merged);
      serverEndpoint()
        .contract(firstContract.merge(secondContract).method("GET"))
        // @ts-expect-error The merged middleware can also return 418.
        .use(merged);
    },
  );

  it("retains incoming variable requirements not supplied by earlier middleware", async () => {
    const first = createMiddleware<{}, { session: string }>()(
      contract(),
      (_context, next) => next({ issued: true }),
    );
    const second = createMiddleware<{}, { issued: boolean; token: string }>()(
      contract(),
      ({ vars }, next) => next({ userId: vars.token }),
    );
    const merged = first.merge(second);
    const base = serverEndpoint().contract(testContract);
    // @ts-expect-error Both session and token must exist before the merged middleware.
    base.use(merged);
    // @ts-expect-error Satisfying the first middleware alone is insufficient.
    base.use((_context, next) => next({ session: "s" })).use(merged);
    const bound = base
      .use((_context, next) => next({ session: "s", token: "Ada" }))
      .use(merged)
      .handler(async ({ vars }) => {
        expectTypeOf(vars.session).toEqualTypeOf<string>();
        expectTypeOf(vars.token).toEqualTypeOf<string>();
        expectTypeOf(vars.issued).toEqualTypeOf<boolean>();
        expectTypeOf(vars.userId).toEqualTypeOf<string>();
        return { status: 200, body: { hello: vars.userId } };
      });
    expect(
      await (await bound.fetchWithContext(createRequest(), {})).json(),
    ).toEqual({ hello: "Ada" });
  });

  it("checks the combined request and environment requirements", () => {
    const first = createMiddleware<{ greeting: string }>()(
      contract().path("/:id", zodCodec(z.object({ id: stringToNumber }))),
      (_context, next) => next({}),
    );
    const second = createMiddleware<{ userName: string }>()(
      authContract.request(zodCodec(z.object({ name: z.string() }))),
      (_context, next) => next({}),
    );
    const merged = first.merge(second);
    expectTypeOf(merged)
      .parameter(0)
      .toHaveProperty("req")
      .toEqualTypeOf<
        ServerRequest<{ id: number }, { fail: boolean }, { name: string }>
      >();
    serverEndpoint<ServerEnvironment>().contract(testContract).use(merged);
    // @ts-expect-error The second middleware requires userName in the environment.
    serverEndpoint<{ greeting: string }>().contract(testContract).use(merged);
    // @ts-expect-error The first middleware requires greeting in the environment.
    serverEndpoint<{ userName: string }>().contract(testContract).use(merged);
    serverEndpoint<ServerEnvironment>()
      .contract(authContract.method("GET"))
      // @ts-expect-error The composed middleware requires numeric id and a body with name.
      .use(merged);

    const noBody = createMiddleware()(
      contract().request(zodCodec(z.undefined())),
      (_context, next) => next({}),
    );
    const neutral = createMiddleware()(contract(), (_context, next) =>
      next({}),
    );
    const noBodyMerged = neutral.merge(noBody);
    expectTypeOf(noBodyMerged)
      .parameter(0)
      .toHaveProperty("req")
      .toHaveProperty("body")
      .toBeUndefined();
    // @ts-expect-error An explicit absent body requirement survives merging.
    serverEndpoint().contract(testContract).use(noBodyMerged);
  });

  it("replaces variables in order and supports branching reusable compositions", async () => {
    const first = createMiddleware()(contract(), (_context, next) =>
      next({ traceId: "first" }),
    );
    const second = createMiddleware()(contract(), (_context, next) =>
      next({ traceId: 42 }),
    );
    const third = createMiddleware<{}, { traceId: number }>()(
      contract(),
      ({ vars }, next) => next({ label: String(vars.traceId) }),
    );
    const merged = first.merge(second).merge(third);
    const base = serverEndpoint().contract(testContract);
    const replaced = base.use(merged).handler(async ({ vars }) => {
      expectTypeOf(vars.traceId).toEqualTypeOf<number>();
      expectTypeOf(vars.label).toEqualTypeOf<string>();
      return { status: 200, body: { hello: vars.label } };
    });
    const original = base.use(first).handler(async ({ vars }) => {
      expectTypeOf(vars.traceId).toEqualTypeOf<string>();
      return { status: 200, body: { hello: vars.traceId } };
    });
    const responses = await Promise.all(
      [replaced, original].map((endpoint) =>
        endpoint.fetchWithContext(createRequest(), {}),
      ),
    );
    expect(await responses[0]!.json()).toEqual({ hello: "42" });
    expect(await responses[1]!.json()).toEqual({ hello: "first" });
  });

  it.each([false, true])(
    "preserves conditional variable additions with fail=%s",
    async (fail) => {
      const first = createMiddleware()(contract(), (_context, next) =>
        next({ traceId: "first" }),
      );
      const conditional = createMiddleware()(authContract, ({ req }, next) =>
        req.query.fail ? next({ traceId: 42, userId: "Ada" }) : next({}),
      );
      const bound = serverEndpoint()
        .contract(testContract)
        .use(first.merge(conditional))
        .handler(async ({ vars }) => {
          expectTypeOf(vars.traceId).toEqualTypeOf<string | number>();
          // @ts-expect-error The userId field is only added on one path.
          expectTypeOf(vars.userId);
          if ("userId" in vars)
            expectTypeOf(vars.userId).toEqualTypeOf<string>();
          return { status: 200, body: { hello: String(vars.traceId) } };
        });
      const response = await bound.fetchWithContext(createRequest(7, fail), {});
      expect(await response.json()).toEqual({ hello: fail ? "42" : "first" });
    },
  );

  it("rejects additions incompatible with later variable requirements", () => {
    const needsString = createMiddleware<{}, { userId: string }>()(
      contract(),
      (_context, next) => next({}),
    );
    const number = createMiddleware()(contract(), (_context, next) =>
      next({ userId: 42 }),
    );
    const optionalNumber = createMiddleware<{}, {}, { userId?: number }>()(
      contract(),
      (_context, next) => next({}),
    );
    const conditionalNumber = createMiddleware()(
      authContract,
      ({ req }, next) => (req.query.fail ? next({ userId: 42 }) : next({})),
    );
    // @ts-expect-error A required number replacement cannot satisfy a string requirement.
    number.merge(needsString);
    // @ts-expect-error A possible number replacement is also incompatible.
    optionalNumber.merge(needsString);
    // @ts-expect-error Every continuation branch must be compatible.
    conditionalNumber.merge(needsString);
  });

  it.each([false, true])(
    "retains requirements for optionally supplied variables with fail=%s",
    async (fail) => {
      const optional = createMiddleware<{}, {}, { userId?: string }>()(
        authContract,
        ({ req }, next) => next(req.query.fail ? { userId: "new" } : {}),
      );
      const needsUser = createMiddleware<{}, { userId: string }>()(
        contract(),
        ({ vars }, next) => next({ label: vars.userId }),
      );
      const merged = optional.merge(needsUser);
      const base = serverEndpoint().contract(testContract);
      // @ts-expect-error Optional additions cannot guarantee the userId field exists.
      base.use(merged);
      const bound = base
        .use((_context, next) => next({ userId: "incoming" }))
        .use(merged)
        .handler(async ({ vars }) => ({
          status: 200,
          body: { hello: vars.label },
        }));
      const response = await bound.fetchWithContext(createRequest(7, fail), {});
      expect(await response.json()).toEqual({
        hello: fail ? "new" : "incoming",
      });
    },
  );

  it("propagates errors and checks every merged response before unwinding", async () => {
    const error = new Error("failed");
    const outer = createMiddleware()(testContract, async (_context, next) => {
      await next({});
      return { status: 200, body: { hello: "outer" } };
    });
    const throwing = createMiddleware()(contract(), async () => {
      throw error;
    });
    const invalid = createMiddleware()(
      contract(),
      // @ts-expect-error Simulate an untyped middleware returning no response.
      async () => undefined,
    );
    for (const [inner, expected] of [
      [throwing, error],
      [invalid, new Error("Middleware returned undefined")],
    ] as const) {
      const bound = serverEndpoint()
        .contract(testContract)
        .use(outer.merge(inner))
        .handler(async () => ({ status: 200, body: { hello: "handler" } }));
      const response = await bound.fetchWithContext(createRequest(), {});
      expect(getSidechannelHeader(response)).toBe("internal_server_error");
      await expect(
        bound.handle({
          req: {
            params: { id: 7 },
            query: { fail: false },
            body: { name: "world" },
          },
          env: {},
        }),
      ).rejects.toThrow(expected);
    }
  });
});

describe("middleware composition", () => {
  it("returns a declared unhandled_error through composed middleware and the client", async () => {
    const failures = contract().response(
      500,
      zodCodec(z.object({ error: z.literal("unhandled_error") })),
    );
    const c = testContract.merge(failures);
    const handleError = createMiddleware()(failures, async (_context, next) => {
      try {
        return await next({});
      } catch {
        return { status: 500, body: { error: "unhandled_error" } };
      }
    });
    const addUser = createMiddleware()(contract(), (_context, next) =>
      next({ userId: "user" }),
    );
    const internal_server_error = vi.fn(
      () => new Response("Invariant failure"),
    );
    const endpoint = serverEndpoint({ errors: { internal_server_error } })
      .contract(c)
      .use(handleError.merge(addUser))
      .handler(async ({ vars }) => {
        expectTypeOf(vars.userId).toEqualTypeOf<string>();
        throw new Error("Application failed");
      });
    const call = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => endpoint.fetchWithContext(request, {}),
    }).contract(c);

    const response = await call({
      params: { id: 7 },
      query: { fail: false },
      body: { name: "world" },
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "unhandled_error" });
    expect(response.headers.has(sidechannelHeaderKey)).toBe(false);
    expect(internal_server_error).not.toHaveBeenCalled();
    if (response.status === 500) {
      expectTypeOf(response.body).toEqualTypeOf<
        Readonly<{ error: "unhandled_error" }>
      >();
    }
  });

  it("keeps variable additions separate from shared HTTP metadata", async () => {
    const res = { headers: new Headers() };
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use<{ headers: string }>(async (context, next) => {
        expect(context.res).toBe(res);
        const response = await next({ headers: "variable" });
        expect(context.vars).toEqual({});
        expect(context.res.headers.get("x-variable")).toBe("variable");
        return response;
      })
      .handler(async (context) => {
        expect(context.vars.headers).toBe("variable");
        expect(context.res).toBe(res);
        context.res.headers.set("x-variable", context.vars.headers);
        return { status: 200, body: { hello: context.env.greeting } };
      });
    await expect(
      bound.handle({
        req: {
          params: { id: 7 },
          query: { fail: false },
          body: { name: "world" },
        },
        env,
        res,
      }),
    ).resolves.toEqual({ status: 200, body: { hello: "Hello" } });
  });

  it.each([false, true])(
    "writes middleware response headers with fail=%s",
    async (fail) => {
      const bound = tracedEndpoint()
        .use(async ({ req, res }, next) => {
          expectTypeOf(req.headers).toEqualTypeOf<ReadonlyHeaders>();
          expectTypeOf(res.headers).toEqualTypeOf<Headers>();
          res.headers.set("x-trace-id", req.headers.get("x-trace-id")!);
          const response = await next({});
          res.headers.set("x-status", String(response.status));
          return response;
        })
        .use(authenticate)
        .handler(async ({ vars: variables, res }) => {
          res.headers.set("x-user", variables.user.name);
          return { status: 200, body: { hello: variables.user.name } };
        });
      const request = createRequest(7, fail);
      request.headers.set("x-trace-id", "client-trace");
      request.headers.set("authorization", "Bearer example-token");

      const response = await bound.fetchWithContext(request, env);

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
      const responseState = { headers: new Headers() };
      const bound = serverEndpoint<ServerEnvironment>()
        .contract(testContract)
        .use(async ({ res }, next) => {
          try {
            return await next({});
          } catch (caught) {
            expect(caught).toBe(error);
            return { status: 403, body: { error: "auth_please" } };
          } finally {
            res.headers.set("x-outer", "set");
          }
        })
        .handler(async ({ res }) => {
          res.headers = replacement;
          res.headers.set("x-handler", "set");
          if (throws) throw error;
          return { status: 200, body: { hello: "world" } };
        });

      const response = await bound.handle({
        req: {
          params: { id: 7 },
          query: { fail: false },
          body: { name: "world" },
          headers: new Headers(),
        },
        env,
        res: responseState,
      });

      expect(response.status).toBe(throws ? 403 : 200);
      expect(responseState.headers).toBe(replacement);
      expect([...responseState.headers]).toEqual([
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
        .handler(async ({ req, env: server, vars: variables }) => {
          handlerCalled();
          expect(server).toBe(env);
          expect(variables.traceId).toBe("request-7");
          return {
            status: 200,
            body: {
              hello: `${server.greeting} ${variables.user.name}, ${req.body.name}`,
            },
          };
        });

      await expect(
        bound.handle({
          req: {
            params: { id: 7 },
            query: { fail },
            body: { name: "world" },
            headers: new Headers(),
          },
          env,
        }),
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
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use<TraceVariables>(
        async ({ req, env: server, vars: variables }, next) => {
          expect(variables).toEqual({});
          expect(server).toBe(env);
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
        },
      )
      .use(authenticate)
      .use(async ({ vars: variables }, next) => {
        expect(variables).toEqual({
          traceId: "request-7",
          user: { name: "Ada" },
        });
        order.push("inner before");
        const response = await next({});
        order.push("inner after");
        return response;
      })
      .handler(async ({ req, env: server, vars: variables }) => {
        expectTypeOf(req.params.id).toEqualTypeOf<number>();
        expectTypeOf(req.query.fail).toEqualTypeOf<boolean>();
        expectTypeOf(variables.traceId).toEqualTypeOf<string>();
        expectTypeOf(variables.user).toEqualTypeOf<AuthVariables["user"]>();
        expect(variables.traceId).toBe("request-7");
        order.push("handler");
        return {
          status: 200,
          body: {
            hello: `${server.greeting} ${variables.user.name}, ${req.body.name}`,
          },
        };
      });
    const fetch = createClient({
      baseUrl: "https://example.com",
      fetch: (request) => bound.fetchWithContext(request, env),
    }).contract(testContract);

    await expect(
      fetch({
        params: { id: 7 },
        query: { fail: false },
        body: { name: "world" },
      }),
    ).resolves.toEqual({
      status: 200,
      body: { hello: "Hello Ada, world" },
      headers: expect.any(Headers),
    });
    expect(bound.definition).toEqual(compileContract(testContract));
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
      .use(async (_context, next) => {
        const response = await next({});
        outerResponse(response.status);
        return response;
      })
      .use(authenticate)
      .use(async (_context, next) => {
        afterAuth();
        return next({});
      })
      .handler(async () => {
        handlerCalled();
        return { status: 200, body: { hello: "world" } };
      });

    const response = await bound.fetchWithContext(createRequest(7, true), env);

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "auth_please" });
    expect(outerResponse).toHaveBeenCalledExactlyOnceWith(403);
    expect(afterAuth).not.toHaveBeenCalled();
    expect(handlerCalled).not.toHaveBeenCalled();
  });

  it("reuses middleware across compatible contracts", async () => {
    const otherContract = authContract
      .method("GET")
      .path("/other/:slug", zodCodec(z.object({ slug: z.string() })))
      .query(zodCodec(z.object({ locale: z.string() })))
      .response(201, zodCodec(z.object({ location: z.string() })));
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(otherContract)
      .use<TraceVariables>(async ({ req }, next) =>
        next({ traceId: req.params.slug }),
      )
      .use(authenticate)
      .handler(async ({ req, vars: variables }) => ({
        status: 201,
        body: {
          location: `${req.query.locale}/${variables.user.name}/${variables.traceId}`,
        },
      }));

    const response = await bound.fetchWithContext(
      new Request("https://example.com/other/item?fail=false&locale=en"),
      env,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ location: "en/Ada/item" });
  });

  it("branches chains and replaces request variables fields", async () => {
    const base = tracedEndpoint().use(authenticate);
    const replaced = base
      .use<{ traceId: number }>(async ({ vars: variables }, next) =>
        next({ traceId: variables.traceId.length }),
      )
      .handler(async ({ vars: variables }) => {
        expectTypeOf(variables.traceId).toEqualTypeOf<number>();
        expectTypeOf(variables.user).toEqualTypeOf<AuthVariables["user"]>();
        return {
          status: 200,
          body: { hello: `${variables.user.name}:${variables.traceId}` },
        };
      });
    const original = base.handler(async ({ vars: variables }) => {
      expectTypeOf(variables.traceId).toEqualTypeOf<string>();
      return {
        status: 200,
        body: { hello: `${variables.user.name}:${variables.traceId}` },
      };
    });

    const [left, right] = await Promise.all([
      replaced.fetchWithContext(createRequest(), env),
      original.fetchWithContext(createRequest(), env),
    ]);

    expect(await left.json()).toEqual({ hello: "Ada:9" });
    expect(await right.json()).toEqual({ hello: "Ada:request-7" });
  });

  it("retains variables fields omitted by optional updates", async () => {
    const bound = tracedEndpoint()
      .use<{ traceId?: number }>(async ({ req }, next) =>
        next(req.query.fail ? { traceId: 42 } : {}),
      )
      .handler(async ({ vars: variables }) => {
        expectTypeOf(variables.traceId).toEqualTypeOf<string | number>();
        return { status: 200, body: { hello: String(variables.traceId) } };
      });

    const [unchanged, updated] = await Promise.all([
      bound.fetchWithContext(createRequest(), env),
      bound.fetchWithContext(createRequest(7, true), env),
    ]);

    expect(await unchanged.json()).toEqual({ hello: "request-7" });
    expect(await updated.json()).toEqual({ hello: "42" });
  });

  it("starts concurrent requests with separate contexts and headers", async () => {
    const contexts: object[] = [];
    const responseHeaders: Headers[] = [];
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use<{ requestId: number }>(
        async ({ req, env: server, vars: variables, res }, next) => {
          expect(variables).toEqual({});
          expect(server).toBe(env);
          res.headers.set("x-request-id", String(req.params.id));
          contexts.push(variables);
          responseHeaders.push(res.headers);
          await Promise.resolve();
          return next({ requestId: req.params.id });
        },
      )
      .handler(async ({ env: server, vars: variables }) => {
        await Promise.resolve();
        return {
          status: 200,
          body: { hello: `${server.greeting}:${variables.requestId}` },
        };
      });

    const [first, second, third] = await Promise.all([
      bound.fetchWithContext(createRequest(1), env),
      bound.fetchWithContext(createRequest(2), env),
      bound.handle({
        req: {
          params: { id: 3 },
          query: { fail: false },
          body: { name: "world" },
          headers: new Headers(),
        },
        env,
      }),
    ]);

    expect(contexts).toHaveLength(3);
    expect(new Set(contexts).size).toBe(3);
    expect(new Set(responseHeaders).size).toBe(3);
    expect(first.headers.get("x-request-id")).toBe("1");
    expect(second.headers.get("x-request-id")).toBe("2");
    expect(await first.json()).toEqual({ hello: "Hello:1" });
    expect(await second.json()).toEqual({ hello: "Hello:2" });
    expect(third).toEqual({ status: 200, body: { hello: "Hello:3" } });
    expect(env).toEqual({ greeting: "Hello", userName: "Ada" });
  });

  it("binds a handler directly with both contexts", async () => {
    const bound = contractHandler(
      testContract,
      async ({
        req,
        env: server,
        vars: variables,
      }: RequestContext<
        { id: number },
        { fail: boolean },
        { name: string },
        ServerEnvironment
      >) => {
        expectTypeOf(variables).toEqualTypeOf<Readonly<{}>>();
        expect(variables).toEqual({});
        return {
          status: 200,
          body: { hello: `${server.greeting} ${req.body.name}` },
        };
      },
    );

    const response = await bound.fetchWithContext(createRequest(), env);

    expect(await response.json()).toEqual({ hello: "Hello world" });
  });

  it("validates the request before calling middleware", async () => {
    const called = vi.fn();
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use(async (_context, next) => {
        called();
        return next({});
      })
      .handler(async () => ({ status: 200, body: { hello: "world" } }));
    const request = new Request("https://example.com/test/7?fail=invalid", {
      method: "POST",
      body: JSON.stringify({ name: "world" }),
    });

    const response = await bound.fetchWithContext(request, env);
    expect(response.status).toBe(400);
    expect(getSidechannelHeader(response)).toBe("codec_error");
    expect(called).not.toHaveBeenCalled();
  });

  it.each(["middleware", "handler"] as const)(
    "reports %s failures over HTTP and propagates them from handle",
    async (source) => {
      const error = new Error("Request failed");
      const bound = serverEndpoint<ServerEnvironment>()
        .contract(testContract)
        .use(async (_context, next) => {
          if (source === "middleware") throw error;
          return next({});
        })
        .handler(async () => {
          throw error;
        });

      const response = await bound.fetchWithContext(createRequest(), env);
      expect(response.status).toBe(500);
      expect(getSidechannelHeader(response)).toBe("internal_server_error");
      await expect(
        bound.handle({
          req: {
            params: { id: 7 },
            query: { fail: false },
            body: { name: "world" },
            headers: new Headers(),
          },
          env,
        }),
      ).rejects.toBe(error);
    },
  );

  it("rejects undeclared middleware responses", async () => {
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      // @ts-expect-error Status 500 is not declared by the contract.
      .use(async () => ({ status: 500 as const, body: { error: "failed" } }))
      .handler(async () => ({ status: 200, body: { hello: "world" } }));

    const response = await bound.fetchWithContext(createRequest(), env);
    expect(response.status).toBe(500);
    expect(getSidechannelHeader(response)).toBe("internal_server_error");
  });

  it("validates a short-circuited response body", async () => {
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      // @ts-expect-error The declared error is the literal auth_please.
      .use(async () => ({ status: 403 as const, body: { error: 42 } }))
      .handler(async () => ({ status: 200, body: { hello: "world" } }));

    const response = await bound.fetchWithContext(createRequest(), env);
    expect(response.status).toBe(500);
    expect(getSidechannelHeader(response)).toBe("internal_server_error");
  });

  it("rejects middleware that returns no response", async () => {
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      // @ts-expect-error Middleware must return its own response or next().
      .use(async () => undefined)
      .handler(async () => ({ status: 200, body: { hello: "world" } }));

    const response = await bound.fetchWithContext(createRequest(), env);
    expect(response.status).toBe(500);
    expect(getSidechannelHeader(response)).toBe("internal_server_error");
  });

  it("requires a method before binding a handler", () => {
    expect(() => {
      serverEndpoint<ServerEnvironment>()
        // @ts-expect-error The base contract has no method.
        .contract(authContract)
        .handler(async () => ({
          status: 403,
          body: { error: "auth_please" },
        }));
    }).toThrow("Contract must define a method with .method()");
  });
});

describe("middleware types", () => {
  it("keeps server environment readonly and types next variables", () => {
    const bound = serverEndpoint<ServerEnvironment>()
      .contract(testContract)
      .use<AuthVariables>(async ({ env: server, vars: variables }, next) => {
        expectTypeOf(server).toEqualTypeOf<Readonly<ServerEnvironment>>();
        expectTypeOf(variables).toEqualTypeOf<Readonly<{}>>();
        // @ts-expect-error Middleware cannot reassign server environment fields.
        server.userName = "changed";
        // @ts-expect-error Authentication has not added a user yet.
        variables.user;
        // @ts-expect-error next must receive the declared variables fields.
        next({});
        // @ts-expect-error The user name must be a string.
        next({ user: { name: 42 } });
        // @ts-expect-error next only accepts the declared variable additions.
        next({ user: { name: "Ada" }, headers: "invalid" });
        return next({ user: { name: server.userName } });
      })
      .handler(async ({ env: server, vars: variables }) => {
        expectTypeOf(server).toEqualTypeOf<Readonly<ServerEnvironment>>();
        expectTypeOf(variables.user).toEqualTypeOf<AuthVariables["user"]>();
        // @ts-expect-error Handlers cannot reassign server environment fields.
        server.greeting = "changed";
        return { status: 200, body: { hello: variables.user.name } };
      });

    expectTypeOf(bound.fetchWithContext).toEqualTypeOf<
      (
        request: Request,
        server: Readonly<ServerEnvironment>,
      ) => Promise<Response>
    >();
    expectTypeOf(bound.handle)
      .parameter(0)
      .toHaveProperty("env")
      .toEqualTypeOf<Readonly<ServerEnvironment>>();
    const validRequest = {
      params: { id: 7 },
      query: { fail: false },
      body: { name: "world" },
      headers: new Headers(),
    };
    expectTypeOf(bound.handle).toBeCallableWith({ req: validRequest, env });
    expectTypeOf(bound.handle).toBeCallableWith({
      req: validRequest,
      env,
      res: {
        headers: new Headers(),
      },
    });
    expectTypeOf(bound.handle).toBeCallableWith({
      req: validRequest,
      env,
      res: {
        // @ts-expect-error The response context requires a Headers instance.
        headers: { "x-test": "value" },
      },
    });
    // @ts-expect-error The server environment is required for typed requests too.
    expectTypeOf(bound.handle).toBeCallableWith({ req: validRequest });
    // @ts-expect-error The server environment must supply both configured fields.
    expectTypeOf(bound.handle).toBeCallableWith({ req: validRequest, env: {} });
    expectTypeOf(bound.handle).toBeCallableWith({
      req: validRequest,
      env,
      // @ts-expect-error A supplied response context must include headers.
      res: { user: { name: "injected" } },
    });
    const request = createRequest();
    const url = request.url;
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(request, env);
    // @ts-expect-error The server environment is required at the request boundary.
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(request);
    // @ts-expect-error The server environment must supply both configured fields.
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(request, {});
    // @ts-expect-error The endpoint accepts a Request, not a URL string.
    expectTypeOf(bound.fetchWithContext).toBeCallableWith(url, env);
  });

  it("checks middleware variables dependencies", () => {
    const empty = serverEndpoint<ServerEnvironment>().contract(testContract);
    // @ts-expect-error authenticate requires traceId in the request variables.
    empty.use(authenticate);

    const wrongTrace = empty.use<{ traceId: number }>(async (_context, next) =>
      next({ traceId: 1 }),
    );
    // @ts-expect-error authenticate requires a string traceId.
    wrongTrace.use(authenticate);

    const optionalTrace = empty.use<{ traceId?: string }>(
      async (_context, next) => next({}),
    );
    // @ts-expect-error authenticate requires traceId to be present.
    optionalTrace.use(authenticate);

    // @ts-expect-error authenticate adds a string user name, not a number.
    tracedEndpoint().use<{ user: { name: number } }>(authenticate);

    const missingServer = serverEndpoint<{}>()
      .contract(testContract)
      .use<TraceVariables>(async (_context, next) => next({ traceId: "id" }));
    // @ts-expect-error authenticate requires userName in server environment.
    missingServer.use(authenticate);
  });

  it("checks middleware contract requirements", () => {
    const wrongQueryContract = contract()
      .method("GET")
      .path("/wrong", zodCodec(z.object({})))
      .query(zodCodec(z.object({ fail: z.string() })))
      .response(403, authResponse);
    const wrongQuery = serverEndpoint<ServerEnvironment>()
      .contract(wrongQueryContract)
      .use<TraceVariables>(async (_context, next) => next({ traceId: "id" }));
    // @ts-expect-error authenticate requires a boolean fail query.
    wrongQuery.use(authenticate);

    const missingResponseContract = contract()
      .method("GET")
      .path("/missing", zodCodec(z.object({})))
      .query(authQuery)
      .response(200, zodCodec(z.string()));
    const missingResponse = serverEndpoint<ServerEnvironment>()
      .contract(missingResponseContract)
      .use<TraceVariables>(async (_context, next) => next({ traceId: "id" }));
    // @ts-expect-error authenticate requires a response for status 403.
    missingResponse.use(authenticate);

    const wrongResponse = serverEndpoint<ServerEnvironment>()
      .contract(missingResponseContract.response(403, zodCodec(z.number())))
      .use<TraceVariables>(async (_context, next) => next({ traceId: "id" }));
    // @ts-expect-error authenticate returns an error object, not a number.
    wrongResponse.use(authenticate);
  });

  it("checks final handler variables and responses", () => {
    const builder = tracedEndpoint().use(authenticate);
    // @ts-expect-error Status 500 is not in the contract.
    builder.handler(async () => ({ status: 500, body: { hello: "world" } }));
    // @ts-expect-error The success response must contain hello.
    builder.handler(async () => ({ status: 200, body: { error: "wrong" } }));
    const wrongContextHandler = async (_context: {
      vars: { user: { name: number } };
    }) => ({ status: 200 as const, body: { hello: "world" } });
    // @ts-expect-error The accumulated user name is a string.
    builder.handler(wrongContextHandler);
    // @ts-expect-error Direct binding starts with empty variables.
    contractHandler(testContract, wrongContextHandler);
  });
});

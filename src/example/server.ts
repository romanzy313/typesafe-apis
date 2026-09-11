import { serverEndpoint } from "../server.js";
import { exampleContract } from "./contract.js";
import { exampleAuthService, type ServerEnvironment } from "./dependencies.js";
import {
  exampleAuthMiddleware,
  exampleComposedMiddleware,
} from "./middleware.js";

export const exampleEndpoint = serverEndpoint<ServerEnvironment>()
  .contract(exampleContract)
  .use(exampleAuthMiddleware)
  .use(exampleComposedMiddleware)
  .use((ctx, next) => {
    const requestId = crypto.randomUUID();
    return next({ ...ctx.vars, requestId });
  })
  .handler(async ({ req, res, vars }) => {
    res.headers.set("x-request-id", vars.requestId);
    res.headers.set("x-compose1", String(vars.compose1));
    res.headers.set("x-compose2", String(vars.compose2));
    if (!req.body.requestParam) {
      return { status: 400, body: { error: "requestParam must be true" } };
    }
    return {
      status: 200,
      body: {
        userId: vars.userId,
        pathParam: req.params.pathParam,
        queryParam: req.query.queryParam,
        requestParam: req.body.requestParam,
      },
    };
  });

async function exampleUsage() {
  const serverEnv = {
    authService: exampleAuthService(),
  };

  await exampleEndpoint.handle({
    env: serverEnv,
    req: {
      query: { queryParam: "a" },
      params: { pathParam: 42 },
      body: { requestParam: true },
    },
  });
  await exampleEndpoint.fetchWithContext(
    new Request("https://example.com/test/42?queryParam=a", {
      method: "POST",
      headers: {
        authorization: "Bearer example-user",
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestParam: true }),
    }),
    serverEnv,
  );
}

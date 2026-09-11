import { serverEndpoint } from "../server.js";
import { exampleContract } from "./contract.js";
import { exampleAuthService, type ServerEnvironment } from "./dependencies.js";
import { exampleAuthMiddleware } from "./middleware.js";

export const exampleEndpoint = serverEndpoint<ServerEnvironment>()
  .contract(exampleContract)
  .use(exampleAuthMiddleware)
  .use((ctx, next) => {
    const requestId = crypto.randomUUID();
    return next({ ...ctx.vars, requestId });
  })
  .handler(async ({ req, res, vars }) => {
    res.headers.set("x-request-id", vars.requestId);
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

export function exampleUsage() {
  const serverEnv = {
    authService: exampleAuthService(),
  };

  const request = new Request("https://example.com/test/42?queryParam=a", {
    method: "POST",
    headers: {
      authorization: "Bearer example-user",
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestParam: true }),
  });
  return exampleEndpoint.fetchWithContext(request, serverEnv);
}

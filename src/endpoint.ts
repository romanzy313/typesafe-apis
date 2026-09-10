import type {
  Codec,
  Contract,
  ContractResponse,
  RequestExtract,
  ResponseCodecs,
  ResponseExtract,
  TypedRequest,
} from "./types.js";
import z from "zod";
import { zodCodec } from "./codec.js";
import { contract } from "./contract.js";

export type MiddlewareHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TContext,
  TContextNext,
> = (
  req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
  ctx: TContext,
  next: (
    nextCtx: TContextNext,
  ) => Promise<ContractResponse<NoInfer<TResponses>>>,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

export type EndpointHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TContext,
> = (
  req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
  ctx: TContext,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

type AddContext<TContext, TContextNext> = TContext & TContextNext;

export class EndpointBuilder<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TContext,
> {
  constructor(
    readonly contract: Contract<
      Codec<TParams>,
      Codec<TQuery>,
      Codec<TRequestBody>,
      TResponses
    >,
    readonly middlewares: Array<
      MiddlewareHandler<
        TParams,
        TQuery,
        TRequestBody,
        TResponses,
        TContext,
        any
      >
    >,
  ) {}

  use<TContextNext>(
    middleware: MiddlewareHandler<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TContext,
      TContextNext
    >,
  ) {
    return new EndpointBuilder<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      AddContext<TContext, TContextNext>
    >(this.contract, [...this.middlewares, middleware]);
  }

  handler(
    handler: EndpointHandler<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TContext
    >,
  ) {
    return contractHandler(this.contract, this.middlewares, handler);
  }
}

export function endpoint<TContext>() {
  return {
    contract<TParams, TQuery, TRequestBody, TResponses extends ResponseCodecs>(
      c: Contract<
        Codec<TParams>,
        Codec<TQuery>,
        Codec<TRequestBody>,
        TResponses
      >,
    ) {
      return new EndpointBuilder<
        TParams,
        TQuery,
        TRequestBody,
        TResponses,
        TContext
      >(c, []);
    },
  };
}

export function contractHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TContext,
>(
  contract: Contract<
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >,
  middlewares: Array<
    MiddlewareHandler<TParams, TQuery, TRequestBody, TResponses, any, any>
  >,
  handler: EndpointHandler<TParams, TQuery, TRequestBody, TResponses, TContext>,
) {
  const { definition } = contract;
  if (!definition.route) {
    throw new Error("Contract must define a route with .route()");
  }

  function decodeRequest(req: RequestExtract) {
    return {
      params: definition.params.decode(req.params),
      query: definition.query.decode(req.query),
      body: definition.request.decode(req.body),
    };
  }
  type DecodedRequest = ReturnType<typeof decodeRequest>;

  function encodeResponse(res: ResponseExtract) {
    const codec = definition.responses[res.status];
    if (!codec) throw new Error(`No encoder for status ${res.status}`);

    return {
      status: res.status,
      body: codec.encode(res.body),
    };
  }

  async function resolveWithMiddlewares(
    decodedRequest: DecodedRequest,
    context: TContext,
    index = 0,
  ) {
    if (index >= middlewares.length) return handler(decodedRequest, context);
    const middleware = middlewares[index]!;

    const value = await middleware(decodedRequest, context, (newCtx) =>
      resolveWithMiddlewares(decodedRequest, newCtx, index + 1),
    );
    if (!value) {
      throw new Error(`Middleware ${index} returned undefined`);
    }

    return value;
  }

  const fetchWithContext = async (request: Request, context: TContext) => {
    const requestExtract = await extractJsonRequest(
      request,
      definition.route.path,
    );
    const decodedRequest = decodeRequest(requestExtract);

    // compose all middlewares
    const response = await resolveWithMiddlewares(decodedRequest, context);

    const encodedResponse = encodeResponse(response);
    return createJsonResponse(encodedResponse);
  };

  return {
    definition,
    fetchWithContext,
  };
}

async function extractJsonRequest(
  req: Request,
  path: string,
): Promise<RequestExtract> {
  const url = new URL(req.url);
  const pathSegments = path.split("/");
  const requestSegments = url.pathname.split("/");

  if (pathSegments.length !== requestSegments.length) {
    throw new Error(`Request path does not match ${path}`);
  }

  const params = Object.fromEntries(
    pathSegments.flatMap((segment, index) => {
      const value = requestSegments[index];
      if (segment.startsWith(":")) {
        if (!value) throw new Error(`Request path does not match ${path}`);
        return [[segment.slice(1), decodeURIComponent(value)]];
      }
      if (segment !== value) {
        throw new Error(`Request path does not match ${path}`);
      }
      return [];
    }),
  );

  return {
    params,
    query: Object.fromEntries(url.searchParams),
    body: req.body === null ? undefined : await req.json(),
  };
}

function createJsonResponse(responseExtract: ResponseExtract): Response {
  return Response.json(responseExtract.body, {
    status: responseExtract.status,
  });
}

// example

const base = contract()
  .query(zodCodec(z.object({ fail: z.stringbool() })))
  .response(403, zodCodec(z.object({ error: z.literal("auth_please") })))
  .response(418, zodCodec(z.object({ funFact: z.string() })));

export const testContract = base
  .route("POST", "/test/:id", zodCodec(z.object({ id: z.string() })))
  .request(zodCodec(z.object({ name: z.string() })))
  .response(
    200,
    zodCodec(
      z.object({
        hello: z.string(),
      }),
    ),
  );

async function exampleUsage() {
  const testEndpoint = endpoint<{ one: string }>()
    .contract(testContract)
    .use(async (req, ctx, next) => {
      // logger kinda
      console.log("request", { req, ctx });
      const res = await next(ctx);
      console.log("response", { req, res, ctx });

      return res;
    })
    .use(async (req, ctx, next) => {
      // auth-like example
      if (req.query.fail) {
        return {
          status: 403,
          body: { error: "auth_please" },
        };
      }
      return next({
        ...ctx,
        didntFail: true, // injected context?
      });
    })
    .handler(async (req, ctx) => {
      const { didntFail } = ctx;
      // doesnt work!

      return {
        status: 200,
        body: { hello: "world" },
      };
    });

  await testEndpoint.fetchWithContext(
    new Request("http://localhost:3000/test/1"),
    { one: "okay" },
  );
}

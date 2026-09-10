import {
  composeMiddleware,
  type AddContext,
  type MiddlewareChain,
  type MiddlewareHandler,
} from "./middleware.js";
import type {
  Codec,
  Contract,
  ContractResponse,
  RequestExtract,
  ResponseCodecs,
  ResponseExtract,
  TypedRequest,
} from "./types.js";

export type ServerEndpoint<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
> = {
  definition: Contract<
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >["definition"];
  /** Run middleware and the handler on decoded values. */
  handle(
    request: TypedRequest<TParams, TQuery, TRequestBody>,
    serverContext: Readonly<TServerContext>,
  ): Promise<ContractResponse<NoInfer<TResponses>>>;
  fetchWithContext(
    request: Request,
    serverContext: Readonly<TServerContext>,
  ): Promise<Response>;
};

export type EndpointHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
> = (
  req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
  serverContext: Readonly<TServerContext>,
  requestContext: TRequestContext,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

export class ServerEndpointBuilder<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
> {
  constructor(
    readonly contract: Contract<
      Codec<TParams>,
      Codec<TQuery>,
      Codec<TRequestBody>,
      TResponses
    >,
    private readonly compose: MiddlewareChain<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      TRequestContext
    >,
  ) {}

  /** Declare added fields with .use<{ user: User }>(); next merges them in. */
  use<TRequestContextNext extends object = {}>(
    middleware: MiddlewareHandler<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      TRequestContext,
      TRequestContextNext
    >,
  ) {
    return new ServerEndpointBuilder<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      AddContext<TRequestContext, TRequestContextNext>
    >(this.contract, composeMiddleware(this.compose, middleware));
  }

  handler(
    handler: EndpointHandler<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      TRequestContext
    >,
  ) {
    return contractHandler(this.contract, this.compose(handler));
  }
}

export function serverEndpoint<TServerContext = {}>() {
  return {
    contract<TParams, TQuery, TRequestBody, TResponses extends ResponseCodecs>(
      contract: Contract<
        Codec<TParams>,
        Codec<TQuery>,
        Codec<TRequestBody>,
        TResponses
      >,
    ) {
      return new ServerEndpointBuilder<
        TParams,
        TQuery,
        TRequestBody,
        TResponses,
        TServerContext,
        {}
      >(contract, (handler) => handler);
    },
  };
}

/** Bind a composed handler; every request starts with its own empty context. */
export function contractHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
>(
  contract: Contract<
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >,
  handler: EndpointHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerContext,
    {}
  >,
): ServerEndpoint<TParams, TQuery, TRequestBody, TResponses, TServerContext> {
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
  function encodeResponse(res: ResponseExtract) {
    const codec = definition.responses[res.status];
    if (!codec) throw new Error(`No encoder for status ${res.status}`);

    return {
      status: res.status,
      body: codec.encode(res.body),
    };
  }

  async function handle(
    request: TypedRequest<TParams, TQuery, TRequestBody>,
    serverContext: Readonly<TServerContext>,
  ): Promise<ContractResponse<NoInfer<TResponses>>> {
    return handler(request, serverContext, {});
  }

  async function fetchWithContext(
    request: Request,
    serverContext: Readonly<TServerContext>,
  ): Promise<Response> {
    const requestExtract = await extractJsonRequest(
      request,
      definition.route.path,
    );
    const decodedRequest = decodeRequest(requestExtract);
    const response = await handle(decodedRequest, serverContext);
    const encodedResponse = encodeResponse(response);
    return createJsonResponse(encodedResponse);
  }

  return { definition, handle, fetchWithContext };
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

import {
  compileContract,
  type ContractBuilder,
  type ReadyContractState,
} from "./contract.js";
import {
  composeMiddleware,
  type AddContext,
  type MiddlewareChain,
  type MiddlewareHandler,
} from "./middleware.js";
import type {
  Codec,
  ContractDefinition,
  ContractResponse,
  RequestContext,
  RequestExtract,
  RequestMethod,
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
  TMethod extends RequestMethod = RequestMethod,
> = {
  definition: ContractDefinition<
    TMethod,
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >;
  /** Run middleware and the handler on decoded values. */
  handle(
    request: TypedRequest<TParams, TQuery, TRequestBody>,
    serverContext: Readonly<TServerContext>,
    requestContext?: RequestContext,
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
  requestContext: RequestContext & TRequestContext,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

export class ServerEndpointBuilder<
  TState extends ReadyContractState,
  TServerContext,
  TRequestContext extends object,
> {
  constructor(
    readonly contract: ContractBuilder<TState>,
    private readonly compose: MiddlewareChain<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"],
      TServerContext,
      TRequestContext
    >,
  ) {}

  /** Declare added fields with .use<{ user: User }>(); next merges them in. */
  use<TRequestContextNext extends object = {}>(
    middleware: MiddlewareHandler<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"],
      TServerContext,
      TRequestContext,
      TRequestContextNext
    >,
  ) {
    return new ServerEndpointBuilder<
      TState,
      TServerContext,
      AddContext<TRequestContext, TRequestContextNext>
    >(this.contract, composeMiddleware(this.compose, middleware));
  }

  handler(
    handler: EndpointHandler<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"],
      TServerContext,
      TRequestContext
    >,
  ) {
    return contractHandler(this.contract, this.compose(handler));
  }
}

export function serverEndpoint<TServerContext = {}>() {
  return {
    contract<TState extends ReadyContractState>(
      contract: ContractBuilder<TState>,
    ) {
      return new ServerEndpointBuilder<TState, TServerContext, {}>(
        contract,
        (handler) => handler,
      );
    },
  };
}

/** Bind a composed handler; omitted context gets fresh response headers. */
export function contractHandler<
  TState extends ReadyContractState,
  TServerContext,
>(
  contract: ContractBuilder<TState>,
  handler: EndpointHandler<
    TState["params"],
    TState["query"],
    TState["request"],
    TState["responses"],
    TServerContext,
    {}
  >,
): ServerEndpoint<
  TState["params"],
  TState["query"],
  TState["request"],
  TState["responses"],
  TServerContext,
  TState["method"]
> {
  const definition = compileContract(contract);

  function decodeRequest(req: RequestExtract) {
    return {
      params: definition.params.decode(req.params),
      query: definition.query.decode(req.query),
      body: definition.request.decode(req.body),
      headers: req.headers,
    };
  }
  function encodeResponse(res: ResponseExtract) {
    const codec = definition.responses[res.status];
    if (!codec) throw new Error(`No encoder for status ${res.status}`);

    return {
      status: res.status,
      body: codec.encode(res.body),
      headers: res.headers,
    };
  }

  async function handle(
    request: TypedRequest<TState["params"], TState["query"], TState["request"]>,
    serverContext: Readonly<TServerContext>,
    requestContext: RequestContext = { headers: new Headers() },
  ): Promise<ContractResponse<NoInfer<TState["responses"]>>> {
    return handler(request, serverContext, requestContext);
  }

  async function fetchWithContext(
    request: Request,
    serverContext: Readonly<TServerContext>,
  ): Promise<Response> {
    const requestExtract = await extractJsonRequest(request, definition.path);
    const decodedRequest = decodeRequest(requestExtract);
    const requestContext: RequestContext = { headers: new Headers() };
    const response = await handle(
      decodedRequest,
      serverContext,
      requestContext,
    );
    const encodedResponse = encodeResponse({
      ...response,
      headers: requestContext.headers,
    });
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
    headers: req.headers,
  };
}

function createJsonResponse(responseExtract: ResponseExtract): Response {
  return Response.json(responseExtract.body, {
    status: responseExtract.status,
    headers: responseExtract.headers,
  });
}

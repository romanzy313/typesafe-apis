import {
  compileContract,
  type ContractBuilder,
  type ReadyContractState,
} from "./contract.js";
import {
  composeMiddleware,
  type AddVariables,
  type InferredMiddlewareHandler,
  type InferredMiddlewareResult,
  type InferMiddlewareVariables,
  type MiddlewareChain,
  type MiddlewareHandler,
} from "./middleware.js";
import {
  RedirectError,
  redirectResponse,
  type SidechannelHeaderValue,
  withSidechannel,
} from "./sidechannel.js";
import type {
  Codec,
  ContractDefinition,
  ContractResponse,
  ReadonlyHeaders,
  RequestContext,
  RequestContextInput,
  RequestExtract,
  RequestMethod,
  ResponseCodecs,
  ResponseExtract,
  ServerRequest,
} from "./types.js";

export type ServerErrorContext<TServerEnvironment> = {
  readonly error: unknown;
  readonly env: Readonly<TServerEnvironment>;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyHeaders;
  };
};

export type ServerEndpointOptions<TServerEnvironment = {}> = {
  readonly errors?: {
    readonly request_codec_error?: (
      context: ServerErrorContext<TServerEnvironment>,
    ) => Response | Promise<Response>;
    readonly internal_server_error?: (
      context: ServerErrorContext<TServerEnvironment>,
    ) => Response | Promise<Response>;
  };
};

export type ServerEndpoint<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerEnvironment,
  TMethod extends RequestMethod = RequestMethod,
> = {
  definition: ContractDefinition<
    TMethod,
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >;
  /** Run decoded values through middleware and the handler; uncaught errors reject. */
  handle(
    context: RequestContextInput<
      TParams,
      TQuery,
      TRequestBody,
      TServerEnvironment
    >,
  ): Promise<ContractResponse<NoInfer<TResponses>>>;
  /** Convert transport and uncaught application errors into marked responses. */
  fetchWithContext(
    request: Request,
    env: Readonly<TServerEnvironment>,
  ): Promise<Response>;
};

export type EndpointHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerEnvironment,
  TRequestVariables extends object,
> = (
  context: RequestContext<
    NoInfer<TParams>,
    NoInfer<TQuery>,
    NoInfer<TRequestBody>,
    TServerEnvironment,
    TRequestVariables
  >,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

export class ServerEndpointBuilder<
  TState extends ReadyContractState,
  TServerEnvironment,
  TRequestVariables extends object,
> {
  constructor(
    readonly contract: ContractBuilder<TState>,
    private readonly compose: MiddlewareChain<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"],
      TServerEnvironment,
      TRequestVariables
    >,
    private readonly options: ServerEndpointOptions<TServerEnvironment> = {},
  ) {}

  /** Infer additions from return next(...), or declare them with .use<Variables>(). */
  use<const TResult extends InferredMiddlewareResult<TState["responses"]>>(
    middleware: InferredMiddlewareHandler<
      TState["params"],
      TState["query"],
      TState["request"],
      TServerEnvironment,
      TRequestVariables,
      TResult
    >,
  ): ServerEndpointBuilder<
    TState,
    TServerEnvironment,
    AddVariables<TRequestVariables, InferMiddlewareVariables<TResult>>
  >;
  use<TRequestVariablesNext extends object = {}>(
    middleware: MiddlewareHandler<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"],
      TServerEnvironment,
      TRequestVariables,
      TRequestVariablesNext
    >,
  ): ServerEndpointBuilder<
    TState,
    TServerEnvironment,
    AddVariables<TRequestVariables, TRequestVariablesNext>
  >;
  use<TRequestVariablesNext extends object = {}>(
    middleware:
      | MiddlewareHandler<
          TState["params"],
          TState["query"],
          TState["request"],
          TState["responses"],
          TServerEnvironment,
          TRequestVariables,
          TRequestVariablesNext
        >
      | InferredMiddlewareHandler<
          TState["params"],
          TState["query"],
          TState["request"],
          TServerEnvironment,
          TRequestVariables,
          InferredMiddlewareResult<TState["responses"]>
        >,
  ) {
    return new ServerEndpointBuilder<
      TState,
      TServerEnvironment,
      AddVariables<TRequestVariables, TRequestVariablesNext>
    >(
      this.contract,
      composeMiddleware(
        this.compose,
        middleware as MiddlewareHandler<
          TState["params"],
          TState["query"],
          TState["request"],
          TState["responses"],
          TServerEnvironment,
          TRequestVariables,
          TRequestVariablesNext
        >,
      ),
      this.options,
    );
  }

  handler(
    handler: EndpointHandler<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"],
      TServerEnvironment,
      TRequestVariables
    >,
  ) {
    return contractHandler(this.contract, this.compose(handler), this.options);
  }
}

/** Share an environment type and invariant handlers across contracts. */
export function serverEndpoint<TServerEnvironment = {}>(
  options: ServerEndpointOptions<TServerEnvironment> = {},
) {
  return {
    contract<TState extends ReadyContractState>(
      contract: ContractBuilder<TState>,
    ) {
      return new ServerEndpointBuilder<TState, TServerEnvironment, {}>(
        contract,
        (handler) => handler,
        options,
      );
    },
  };
}

/** Bind a composed handler; typed calls default to fresh headers and variables. */
export function contractHandler<
  TState extends ReadyContractState,
  TServerEnvironment,
>(
  contract: ContractBuilder<TState>,
  handler: EndpointHandler<
    TState["params"],
    TState["query"],
    TState["request"],
    TState["responses"],
    TServerEnvironment,
    {}
  >,
  options: ServerEndpointOptions<NoInfer<TServerEnvironment>> = {},
): ServerEndpoint<
  TState["params"],
  TState["query"],
  TState["request"],
  TState["responses"],
  TServerEnvironment,
  TState["method"]
> {
  const definition = compileContract(contract);

  const codecErrorHandler =
    options.errors?.request_codec_error ?? defaultCodecError;
  const internalServerErrorHandler =
    options.errors?.internal_server_error ?? defaultInternalServerError;

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
    context: RequestContextInput<
      TState["params"],
      TState["query"],
      TState["request"],
      TServerEnvironment
    >,
  ): Promise<ContractResponse<NoInfer<TState["responses"]>>> {
    return handler({
      req: { ...context.req, headers: context.req.headers ?? new Headers() },
      res: context.res ?? { headers: new Headers() },
      env: context.env,
      vars: {},
    });
  }

  async function fetchWithContext(
    request: Request,
    env: Readonly<TServerEnvironment>,
  ): Promise<Response> {
    const context = {
      env,
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers,
      },
    };
    try {
      let decodedRequest: ServerRequest<
        TState["params"],
        TState["query"],
        TState["request"]
      >;
      try {
        const requestExtract = await extractJsonRequest(
          request,
          definition.path,
        );
        decodedRequest = decodeRequest(requestExtract) as ServerRequest<
          TState["params"],
          TState["query"],
          TState["request"]
        >;
      } catch (error) {
        return createErrorResponse("codec_error", () =>
          codecErrorHandler({ ...context, error }),
        );
      }

      const res = { headers: new Headers() };

      const response = await handle({ req: decodedRequest, env, res });

      try {
        const encodedResponse = encodeResponse({
          ...response,
          headers: res.headers,
        });
        return createJsonResponse(encodedResponse);
      } catch (error) {
        return createErrorResponse("internal_server_error", () =>
          internalServerErrorHandler({ ...context, error }),
        );
      }
    } catch (error) {
      if (error instanceof RedirectError) {
        return redirectResponse(error);
      }
      return createErrorResponse("internal_server_error", () =>
        internalServerErrorHandler({ ...context, error }),
      );
    }
  }

  return { definition, handle, fetchWithContext };
}

function defaultCodecError({ error }: ServerErrorContext<unknown>): Response {
  return Response.json(
    {
      error: "codec_error",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 400 },
  );
}

function defaultInternalServerError(): Response {
  return Response.json(
    { error: "internal_server_error", message: "Internal server error" },
    { status: 500 },
  );
}

async function createErrorResponse(
  kind: SidechannelHeaderValue,
  respond: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return withSidechannel(kind, await respond());
  } catch {
    // A failing error handler must not invoke another user error handler.
    return withSidechannel(
      "internal_server_error",
      defaultInternalServerError(),
    );
  }
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

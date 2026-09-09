export type Codec<TInput = unknown> = {
  encode(data: TInput): unknown;
  decode(encoded: unknown): TInput;
};

export type StatusCode = 200 | 400;
export type RequestMethod = "GET" | "POST";

export type Contract<
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponse extends Record<StatusCode, Codec>,
> = {
  method: RequestMethod;
  path: string;
  params: TParams;
  query: TQuery;
  request: TRequestBody;
  responses: TResponse;
};

export function contract<
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponses extends Record<StatusCode, Codec>,
>(input: Contract<TParams, TQuery, TRequestBody, TResponses>) {
  return input;
}

/**
 * Extract of the request. The values are not validated!
 */
export type RequestExtract = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
};

export type TypedRequest<TParams, TQuery, TRequestBody> = {
  params: TParams;
  query: TQuery;
  body: TRequestBody;
};

export type ResponseExtract = {
  status: StatusCode;
  body: unknown;
};

export type TypedResponse<TStatus extends StatusCode, TResponseBody> = {
  status: TStatus;
  body: TResponseBody;
};

type ContractResponse<TResponses extends Record<StatusCode, Codec>> = {
  [TStatus in StatusCode]: TypedResponse<
    TStatus,
    ReturnType<TResponses[TStatus]["decode"]>
  >;
}[StatusCode];

export function serverContractHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends Record<StatusCode, Codec>,
>(
  c: Contract<Codec<TParams>, Codec<TQuery>, Codec<TRequestBody>, TResponses>,
  handler: (
    req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
  ) => Promise<ContractResponse<NoInfer<TResponses>>>,
) {
  function validateRequest(req: RequestExtract) {
    return {
      params: c.params.decode(req.params),
      query: c.query.decode(req.query),
      body: c.request.decode(req.body),
    };
  }
  function validateResponse(res: ResponseExtract) {
    const codec = c.responses[res.status];
    if (!codec) throw new Error(`No encoder for status ${res.status}`);

    return {
      status: res.status,
      body: codec.encode(res.body),
    };
  }

  return {
    method: c.method, // for server router
    path: c.path, // for server router
    handler, // for testing
    async fetch(req: Request) {
      const requestExtract = await extractJsonRequest(req, c.path);

      const typedRequest = validateRequest(requestExtract);

      const response = await handler(typedRequest);

      const typedResponse = validateResponse(response);

      return createJsonResponse(typedResponse.body, typedResponse.status);
    },
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

function createJsonResponse(body: unknown, status: StatusCode): Response {
  return Response.json(body, { status });
}

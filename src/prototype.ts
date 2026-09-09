export type Codec<TInput> = {
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

export function serverContractHandler<
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponse extends Record<StatusCode, Codec>,
  TContract extends Contract<TParams, TQuery, TRequestBody, TResponse>,
>(
  c: TContract,
  handler: (
    req: TypedRequest<TParams, TQuery, TRequestBody>,
  ) => Promise<TypedResponse<TResponse>>,
) {
  function validateRequest(req: RequestExtract) {
    return {
      method: c.method,
      path: c.path,
      params: c.params.decode(req.params),
      query: c.query.decode(req.query),
      body: c.request.decode(req.body),
    };
  }
  function validateResponse(res: ResponseExtract) {
    const codec = c.responses[res.status];
    if (!codec) throw new Error(`No decoder for status ${res.status}`);

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
      // extract complete request
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
  /**
   * extracts params and query values from from the request
   */
  function extractParamAndQuery(url: string, path: string) {
    return {
      params: {},
      query: {},
    };
  }

  const { params, query } = extractParamAndQuery(req.url, path);
  const body = await req.json();

  return {
    params,
    query,
    body,
  };
}

function createJsonResponse(body: any, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
  });
}

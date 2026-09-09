export type Codec<TInput = unknown> = {
  encode(data: TInput): unknown;
  decode(encoded: unknown): TInput;
};

// Matches Hono's StatusCode
// https://hono.dev/docs/api/context#status
// https://github.com/honojs/hono/blob/main/src/utils/http-status.ts
// https://www.iana.org/assignments/http-status-codes/
export type StatusCode =
  | 100 // Continue
  | 101 // Switching Protocols
  | 102 // Processing
  | 103 // Early Hints
  | 200 // OK
  | 201 // Created
  | 202 // Accepted
  | 203 // Non-Authoritative Information
  | 204 // No Content
  | 205 // Reset Content
  | 206 // Partial Content
  | 207 // Multi-Status
  | 208 // Already Reported
  | 226 // IM Used
  | 300 // Multiple Choices
  | 301 // Moved Permanently
  | 302 // Found
  | 303 // See Other
  | 304 // Not Modified
  | 305 // Use Proxy (deprecated)
  | 306 // Unused (deprecated)
  | 307 // Temporary Redirect
  | 308 // Permanent Redirect
  | 400 // Bad Request
  | 401 // Unauthorized
  | 402 // Payment Required
  | 403 // Forbidden
  | 404 // Not Found
  | 405 // Method Not Allowed
  | 406 // Not Acceptable
  | 407 // Proxy Authentication Required
  | 408 // Request Timeout
  | 409 // Conflict
  | 410 // Gone
  | 411 // Length Required
  | 412 // Precondition Failed
  | 413 // Content Too Large
  | 414 // URI Too Long
  | 415 // Unsupported Media Type
  | 416 // Range Not Satisfiable
  | 417 // Expectation Failed
  | 418 // I'm a teapot (reserved)
  | 421 // Misdirected Request
  | 422 // Unprocessable Content
  | 423 // Locked
  | 424 // Failed Dependency
  | 425 // Too Early
  | 426 // Upgrade Required
  | 428 // Precondition Required
  | 429 // Too Many Requests
  | 431 // Request Header Fields Too Large
  | 451 // Unavailable For Legal Reasons
  | 500 // Internal Server Error
  | 501 // Not Implemented
  | 502 // Bad Gateway
  | 503 // Service Unavailable
  | 504 // Gateway Timeout
  | 505 // HTTP Version Not Supported
  | 506 // Variant Also Negotiates
  | 507 // Insufficient Storage
  | 508 // Loop Detected
  | 510 // Not Extended (obsolete)
  | 511; // Network Authentication Require

export type RequestMethod = "GET" | "POST";

type ResponseCodecs = Partial<Record<StatusCode, Codec>>;

export type Contract<
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponse extends ResponseCodecs,
> = {
  method: RequestMethod;
  path: string;
  params: TParams;
  query: TQuery;
  request: TRequestBody;
  responses: TResponse & Record<Exclude<keyof TResponse, StatusCode>, never>;
};

export function contract<
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponses extends ResponseCodecs,
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

type ContractResponse<TResponses extends ResponseCodecs> = {
  [TStatus in keyof TResponses & StatusCode]: TypedResponse<
    TStatus,
    ReturnType<NonNullable<TResponses[TStatus]>["decode"]>
  >;
}[keyof TResponses & StatusCode];

export function serverContractHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
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

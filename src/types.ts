export type MinFetch = (request: Request) => Promise<Response>;

export type Codec<TInput = unknown> = {
  /** Prepare the complete codec for reuse when a contract is bound. */
  compile(): Codec<TInput>;
  encode(data: TInput): unknown;
  decode(encoded: unknown): TInput;
  union<TOther>(other: Codec<TOther>): Codec<TInput | TOther>;
  intersection<TOther>(other: Codec<TOther>): Codec<TInput & TOther>;
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

export type ResponseCodecs = Partial<Record<StatusCode, Codec>>;

export type ContractDefinition<
  TMethod extends RequestMethod,
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponse extends ResponseCodecs,
> = {
  readonly method: TMethod;
  readonly path: string;
  readonly params: TParams;
  readonly query: TQuery;
  readonly request: TRequestBody;
  readonly responses: TResponse;
};

/**
 * Extract of the request. The values are not validated!
 */
export type RequestExtract = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Headers;
};

export type ValidRequest<TParams, TQuery, TRequestBody> = {
  params: TParams;
  query: TQuery;
  body: TRequestBody;
};

/** Read methods only, including the collection passed to forEach callbacks. */
export type ReadonlyHeaders = Readonly<
  Omit<Headers, "append" | "delete" | "set" | "forEach"> & {
    forEach(
      callback: (value: string, key: string, headers: ReadonlyHeaders) => void,
      thisArg?: unknown,
    ): void;
  }
>;

/** Preserve unconstrained and primitive inputs while making object fields readonly. */
export type ReadonlyValue<T> = T extends object ? Readonly<T> : T;

export type ServerRequest<TParams, TQuery, TRequestBody> = Readonly<
  ValidRequest<
    ReadonlyValue<TParams>,
    ReadonlyValue<TQuery>,
    ReadonlyValue<TRequestBody>
  >
> & { readonly headers: ReadonlyHeaders };

/** One request's input, outgoing headers, environment, and middleware variables. */
export type RequestContext<
  TParams,
  TQuery,
  TRequestBody,
  TServerEnvironment,
  TRequestVariables extends object = {},
> = {
  readonly req: ServerRequest<TParams, TQuery, TRequestBody>;
  readonly res: { headers: Headers };
  readonly env: Readonly<TServerEnvironment>;
  readonly var: Readonly<TRequestVariables>;
};

/** Typed calls may omit headers; variables always start empty. */
export type RequestContextInput<
  TParams,
  TQuery,
  TRequestBody,
  TServerEnvironment,
> = {
  readonly req: Omit<
    ServerRequest<TParams, TQuery, TRequestBody>,
    "headers"
  > & {
    readonly headers?: ReadonlyHeaders;
  };
  readonly res?: { headers: Headers };
  readonly env: Readonly<TServerEnvironment>;
};

export type ResponseExtract = {
  status: StatusCode;
  body: unknown;
  headers: Headers;
};

export type ValidResponse<TStatus extends StatusCode, TResponseBody> = {
  status: TStatus;
  body: TResponseBody;
};

export type ContractResponse<TResponses extends ResponseCodecs> = {
  [TStatus in keyof TResponses & StatusCode]: ValidResponse<
    TStatus,
    ReturnType<NonNullable<TResponses[TStatus]>["decode"]>
  >;
}[keyof TResponses & StatusCode];

/** Adapt native fetch to a transport that accepts a single Request. */
export function constrainFetch(
  fetchFn: typeof globalThis.fetch,
): (request: Request) => Promise<Response> {
  return (request) => fetchFn(request);
}

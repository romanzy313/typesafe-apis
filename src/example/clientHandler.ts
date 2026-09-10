import { createClient } from "../client.js";
import { exampleContract } from "./contract.js";
import { exampleHandler } from "./serverHandler.js";

export const exampleClient = createClient({
  baseUrl: "",
  doRequest: fetch, // never use or mock real fetch in tests!
});

export const exampleFetch = exampleClient.contract(exampleContract);

function interesting() {
  return createClient({
    doRequest: exampleHandler.fetch,
  }).contract(exampleContract);
}

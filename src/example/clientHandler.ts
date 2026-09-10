import { createClient } from "../client.js";
import { exampleContract } from "./contract.js";

const exampleClient = createClient({
  baseUrl: "",
  doRequest: fetch, // never use or mock real fetch in tests!
});

export const exampleFetch = exampleClient.contract(exampleContract);

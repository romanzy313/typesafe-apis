import { createClient } from "../client.js";
import { exampleContract } from "./contract.js";

const exampleClient = createClient();

export const exampleFetch = exampleClient.contract(exampleContract);

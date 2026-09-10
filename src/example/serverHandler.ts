import { serverContractHandler } from "../server.js";
import { exampleContract } from "./contract.js";

export const exampleHandler = serverContractHandler(
  exampleContract,
  async (req) => {
    if (!req.body.requestParam) {
      return { status: 400, body: { error: "requestParam must be true" } };
    }

    return {
      status: 200,
      body: {
        hi: "Hello",
        pathParam: req.params.pathParam,
        queryParam: req.query.queryParam,
        requestParam: req.body.requestParam,
      },
    };
  },
);

export function exampleAuthService() {
  return {
    async getUserIdByBearer(bearer: string) {
      if (bearer === "fail") {
        return null;
      }
      return bearer;
    },
  };
}
export type ExampleAuthService = ReturnType<typeof exampleAuthService>;
export type ExampleAuthServiceEnvironment = {
  authService: ExampleAuthService;
};

export type ServerEnvironment = ExampleAuthServiceEnvironment; //& ... & ...

import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router";
import { appRoutes } from "../src/router";

function matchedPath(admin: boolean, path: string) {
  return matchRoutes(appRoutes(admin), path)?.at(-1)?.route.path;
}

describe("channel management routes", () => {
  it("registers only the channel page in the admin router", () => {
    expect(matchedPath(true, "/channels")).toBe("/channels");
    expect(matchedPath(true, "/models")).toBe("*");
    expect(matchedPath(true, "/publications/models")).toBe("*");
  });

  it("keeps the user settings entry but does not expose channel administration there", () => {
    expect(matchedPath(false, "/models")).toBe("/models");
    expect(matchedPath(false, "/channels")).toBe("*");
  });
});

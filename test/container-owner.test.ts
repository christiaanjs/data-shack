import { describe, expect, it } from "vitest";
import { isContainerOwner } from "../src/session/container-owner.ts";

describe("isContainerOwner", () => {
  it("matches only the configured user", () => {
    expect(isContainerOwner({ CONTAINER_OWNER_USER_ID: "usr_a" }, "usr_a")).toBe(true);
    expect(isContainerOwner({ CONTAINER_OWNER_USER_ID: "usr_a" }, "usr_b")).toBe(false);
  });

  it("fails closed when unset or blank", () => {
    expect(isContainerOwner({}, "usr_a")).toBe(false);
    expect(isContainerOwner({ CONTAINER_OWNER_USER_ID: "" }, "usr_a")).toBe(false);
    expect(isContainerOwner({ CONTAINER_OWNER_USER_ID: "  " }, "")).toBe(false);
  });

  it("tolerates surrounding whitespace in the var", () => {
    expect(isContainerOwner({ CONTAINER_OWNER_USER_ID: " usr_a\n" }, "usr_a")).toBe(true);
  });
});

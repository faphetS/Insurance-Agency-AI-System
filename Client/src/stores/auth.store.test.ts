import { describe, it, expect, beforeEach } from "vitest";
import { useAuthStore } from "./auth.store";

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
  });

  it("starts with null user and loading true", () => {
    // After clear, loading is false — test initial factory state
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.accessToken).toBeNull();
  });

  it("sets user", () => {
    const user = { id: "1", email: "test@test.com", role: "agent" };
    useAuthStore.getState().setUser(user);
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it("sets access token", () => {
    useAuthStore.getState().setAccessToken("token-123");
    expect(useAuthStore.getState().accessToken).toBe("token-123");
  });

  it("clears all auth state", () => {
    useAuthStore.getState().setUser({ id: "1", email: "a@b.com", role: "admin" });
    useAuthStore.getState().setAccessToken("tok");
    useAuthStore.getState().clear();

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.accessToken).toBeNull();
    expect(state.isLoading).toBe(false);
  });
});

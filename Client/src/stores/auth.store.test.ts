import { describe, it, expect, beforeEach } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { useAuthStore } from "./auth.store";

// Minimal session fixture
const makeSession = (role?: string): Session =>
  ({
    access_token: "tok-123",
    refresh_token: "ref-abc",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Date.now() / 1000 + 3600,
    user: {
      id: "u1",
      email: "admin@test.com",
      app_metadata: role ? { role } : {},
      user_metadata: {},
      aud: "authenticated",
      created_at: new Date().toISOString(),
      role: "",
      updated_at: new Date().toISOString(),
    },
  }) as Session;

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
  });

  it("starts with null session after clear", () => {
    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it("accessToken is null when no session", () => {
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it("setSession populates user and isAdmin from app_metadata", () => {
    useAuthStore.getState().setSession(makeSession("admin"));
    const state = useAuthStore.getState();
    expect(state.user?.email).toBe("admin@test.com");
    expect(state.isAdmin).toBe(true);
    expect(state.accessToken).toBe("tok-123");
  });

  it("isAdmin is false when role is not admin", () => {
    useAuthStore.getState().setSession(makeSession("agent"));
    expect(useAuthStore.getState().isAdmin).toBe(false);
  });

  it("clear resets all auth state", () => {
    useAuthStore.getState().setSession(makeSession("admin"));
    useAuthStore.getState().clear();
    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.isAdmin).toBe(false);
  });
});

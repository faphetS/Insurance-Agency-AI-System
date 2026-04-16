import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

interface AuthState {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isLoading: boolean;
  hasHydrated: boolean;
  setSession: (session: Session | null) => void;
  markHydrated: () => void;
  signOut: () => Promise<void>;
  /** Derived access token — convenience getter for Axios interceptor */
  get accessToken(): string | null;
  /** Reset to unauthenticated state (used by Axios 401 handler) */
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  isAdmin: false,
  isLoading: true,
  hasHydrated: false,

  get accessToken() {
    return get().session?.access_token ?? null;
  },

  setSession: (session) =>
    set({
      session,
      user: session?.user ?? null,
      isAdmin: session?.user?.app_metadata?.["role"] === "admin",
      isLoading: false,
      hasHydrated: true,
    }),

  markHydrated: () => set({ hasHydrated: true }),

  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null, user: null, isAdmin: false, isLoading: false });
  },

  clear: () => {
    set({ session: null, user: null, isAdmin: false, isLoading: false });
  },
}));

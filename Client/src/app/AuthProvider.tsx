import { useEffect, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth.store";
import { logAuth } from "@/lib/authDebug";

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Bootstraps the Supabase session on mount and subscribes to auth state
 * changes. Must wrap the router so all routes have access to auth state.
 * Renders nothing until the initial session hydration resolves, preventing
 * a flash-to-login-redirect race condition.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const setSession = useAuthStore((s) => s.setSession);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);

  useEffect(() => {
    logAuth("hydrate:start");

    // Hydrate from existing session (persisted in localStorage by supabase-js)
    supabase.auth.getSession().then(({ data }) => {
      logAuth("hydrate:resolved", { hasSession: !!data.session });
      setSession(data.session);
      // Belt-and-suspenders: if setSession(null) was called, hasHydrated is
      // already true via setSession, but call markHydrated explicitly too in
      // case the store implementation ever diverges.
      useAuthStore.getState().markHydrated();
    });

    // Keep store in sync with supabase auth events (sign in, sign out, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      logAuth("authState:change", { event: _event, hasSession: !!session });
      setSession(session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [setSession]);

  if (!hasHydrated) {
    return null;
  }

  return <>{children}</>;
}

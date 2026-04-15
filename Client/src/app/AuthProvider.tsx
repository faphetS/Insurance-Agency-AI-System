import { useEffect, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth.store";

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Bootstraps the Supabase session on mount and subscribes to auth state
 * changes. Must wrap the router so all routes have access to auth state.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const setSession = useAuthStore((s) => s.setSession);

  useEffect(() => {
    // Hydrate from existing session (persisted in localStorage by supabase-js)
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    // Keep store in sync with supabase auth events (sign in, sign out, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [setSession]);

  return <>{children}</>;
}

import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "@/stores/auth.store";

/**
 * Protects routes that require an authenticated session.
 * Shows nothing while the session is being hydrated from storage,
 * then either renders children (authenticated) or redirects to /login.
 */
export function AuthGuard() {
  const session = useAuthStore((s) => s.session);
  const isLoading = useAuthStore((s) => s.isLoading);

  if (isLoading) {
    // Avoid a flash of the login page while supabase restores the session
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

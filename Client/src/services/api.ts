import axios from "axios";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { logAuth } from "@/lib/authDebug";
import { useAuthStore } from "@/stores/auth.store";
import { router } from "@/app/router";

const apiDomain = import.meta.env.VITE_API_DOMAIN ?? "";

const api = axios.create({
  baseURL: `${apiDomain}/api`,
  timeout: 10000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Attach auth token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().session?.access_token ?? null;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle errors — smart 401 handling: only clear + redirect if Supabase has no live session
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      const url = error.config?.url ?? "unknown";
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        // Supabase session is still live — backend is misconfigured or token mismatch
        logAuth("api:401-with-live-session", { url });
        toast.error("Request failed — backend may be misconfigured");
        // Do NOT clear store or redirect
      } else {
        // Session is truly gone — clean up and send to login
        logAuth("api:401-no-session", { url });
        useAuthStore.getState().clear();
        void router.navigate("/login");
      }
    }
    return Promise.reject(error);
  },
);

export default api;

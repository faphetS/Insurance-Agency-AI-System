import axios from "axios";
import { useAuthStore } from "@/stores/auth.store";

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

// Handle errors — redirect to login on 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clear();
      window.location.href = "/login";
    }
    return Promise.reject(error);
  },
);

export default api;

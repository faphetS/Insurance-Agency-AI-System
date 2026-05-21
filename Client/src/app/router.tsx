/* eslint-disable react-refresh/only-export-components */
import { lazy } from "react";
import type { ComponentType } from "react";
import { createBrowserRouter } from "react-router-dom";
import App from "@/app/App";
import { AuthGuard } from "@/app/AuthGuard";
import { RouteError } from "@/app/RouteError";
import { logAuth } from "@/lib/authDebug";

const lazyWithReload = <T extends ComponentType<unknown>>(
  importer: () => Promise<{ default: T }>,
) =>
  lazy(() =>
    importer().catch((err) => {
      const key = "__chunk_reload_attempted";
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        logAuth("chunk:reload", { message: err?.message ?? String(err) });
        window.location.reload();
      }
      throw err;
    }),
  );

const HomePage = lazyWithReload(() => import("@/pages/HomePage/HomePage"));
const NotFoundPage = lazyWithReload(() => import("@/pages/NotFoundPage"));
const LoginPage = lazyWithReload(() => import("@/pages/LoginPage/LoginPage"));
const OpsInspectorPage = lazyWithReload(() => import("@/pages/OpsInspectorPage/index"));

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    errorElement: <RouteError />,
    children: [
      // Public routes
      {
        path: "login",
        element: <LoginPage />,
      },
      // Protected routes — require a valid Supabase session
      {
        element: <AuthGuard />,
        children: [
          {
            index: true,
            element: <HomePage />,
          },
          {
            path: "ops-inspector",
            element: <OpsInspectorPage />,
          },
        ],
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);

/* eslint-disable react-refresh/only-export-components */
import { lazy } from "react";
import { createBrowserRouter } from "react-router-dom";
import App from "@/app/App";
import { AuthGuard } from "@/app/AuthGuard";

const HomePage = lazy(() => import("@/pages/HomePage/HomePage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));
const LoginPage = lazy(() => import("@/pages/LoginPage/LoginPage"));

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
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
        ],
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);

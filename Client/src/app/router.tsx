/* eslint-disable react-refresh/only-export-components */
import { lazy } from "react";
import { createBrowserRouter } from "react-router-dom";
import App from "@/app/App";

const HomePage = lazy(() => import("@/pages/HomePage/HomePage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      // Future routes:
      // { path: "login", element: <LoginPage /> },
      // { path: "dashboard", element: <DashboardPage /> },
      // { path: "policies", element: <PoliciesPage /> },
      // { path: "claims", element: <ClaimsPage /> },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);

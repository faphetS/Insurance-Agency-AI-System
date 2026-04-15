import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Mail, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (values: LoginFormValues) => {
    setServerError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });

    if (error) {
      // Surface a clean message — Supabase returns "Invalid login credentials" for bad creds
      setServerError(
        error.message === "Invalid login credentials"
          ? "Incorrect email or password. Please try again."
          : error.message,
      );
      return;
    }

    navigate("/", { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-neutral-50 to-neutral-100 px-4">
      {/* Brand mark */}
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 shadow-lg">
          <svg width="26" height="26" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" rx="1.5" fill="white" />
            <rect x="10" y="2" width="6" height="6" rx="1.5" fill="white" opacity="0.6" />
            <rect x="2" y="10" width="6" height="6" rx="1.5" fill="white" opacity="0.6" />
            <rect x="10" y="10" width="6" height="6" rx="1.5" fill="white" opacity="0.3" />
          </svg>
        </div>
        <div className="text-center">
          <p className="font-sans text-lg font-bold leading-tight text-neutral-900">
            Insurance Agency AI
          </p>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-neutral-400">
            Admin Portal
          </p>
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 font-sans text-xl font-bold text-neutral-900">Admin Login</h1>

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
          {/* Email field */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="font-mono text-[11px] font-medium uppercase tracking-widest text-neutral-500">
              Email
            </label>
            <div className="relative">
              <Mail
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
                aria-hidden="true"
              />
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="admin@agency.com"
                {...register("email")}
                className={`w-full rounded-lg border bg-neutral-50 py-2.5 pl-9 pr-3 font-sans text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-neutral-900 focus:bg-white focus:ring-2 focus:ring-neutral-900/10 ${
                  errors.email ? "border-red-400" : "border-neutral-200"
                }`}
              />
            </div>
            {errors.email && (
              <p className="font-mono text-[11px] text-red-500">{errors.email.message}</p>
            )}
          </div>

          {/* Password field */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="font-mono text-[11px] font-medium uppercase tracking-widest text-neutral-500">
              Password
            </label>
            <div className="relative">
              <Lock
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
                aria-hidden="true"
              />
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                {...register("password")}
                className={`w-full rounded-lg border bg-neutral-50 py-2.5 pl-9 pr-3 font-sans text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-neutral-900 focus:bg-white focus:ring-2 focus:ring-neutral-900/10 ${
                  errors.password ? "border-red-400" : "border-neutral-200"
                }`}
              />
            </div>
            {errors.password && (
              <p className="font-mono text-[11px] text-red-500">{errors.password.message}</p>
            )}
          </div>

          {/* Server-level error */}
          {serverError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 font-mono text-[11px] text-red-600">
              {serverError}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2.5 font-sans text-sm font-semibold text-white transition hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>
      </div>

      <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-neutral-400">
        Authorized personnel only
      </p>
    </div>
  );
}

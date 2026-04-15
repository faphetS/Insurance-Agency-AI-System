import { SignJWT } from "jose";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../lib/errors.js";
import type { LoginInput, RegisterInput } from "./auth.validator.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

export const authService = {
  async register(input: RegisterInput) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      user_metadata: { full_name: input.fullName },
      email_confirm: true,
    });

    if (error) {
      throw new AppError(400, error.message, "REGISTRATION_FAILED");
    }

    return { userId: data.user.id };
  },

  async login(input: LoginInput) {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    if (error) {
      throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }

    const accessToken = await new SignJWT({
      sub: data.user.id,
      email: data.user.email,
      role: data.user.user_metadata?.role ?? "customer",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(secret);

    return {
      accessToken,
      user: {
        id: data.user.id,
        email: data.user.email!,
        role: data.user.user_metadata?.role ?? "customer",
      },
    };
  },

  async refresh(userId: string) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (error || !data.user) {
      throw new AppError(401, "Invalid refresh", "REFRESH_FAILED");
    }

    const accessToken = await new SignJWT({
      sub: data.user.id,
      email: data.user.email,
      role: data.user.user_metadata?.role ?? "customer",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(secret);

    return { accessToken };
  },
};

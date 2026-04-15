import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { validate } from "./validate.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return { body: {}, params: {}, query: {}, ...overrides } as Request;
}

const mockRes = {} as Response;

describe("validate middleware", () => {
  it("passes when body matches schema", () => {
    const schema = z.object({ name: z.string() });
    const middleware = validate({ body: schema });
    const req = mockReq({ body: { name: "test" } });
    const next = vi.fn();

    middleware(req, mockRes, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: "test" });
  });

  it("throws ZodError when body is invalid", () => {
    const schema = z.object({ name: z.string() });
    const middleware = validate({ body: schema });
    const req = mockReq({ body: { name: 123 } });
    const next = vi.fn();

    expect(() => middleware(req, mockRes, next)).toThrow(z.ZodError);
    expect(next).not.toHaveBeenCalled();
  });

  it("trims and transforms string inputs via Zod", () => {
    const schema = z.object({ email: z.string().trim().toLowerCase() });
    const middleware = validate({ body: schema });
    const req = mockReq({ body: { email: "  TEST@EXAMPLE.COM  " } });
    const next = vi.fn();

    middleware(req, mockRes, next);

    expect(req.body.email).toBe("test@example.com");
  });

  it("validates query params when schema provided", () => {
    const schema = z.object({ page: z.coerce.number().min(1) });
    const middleware = validate({ query: schema });
    const req = mockReq({ query: { page: "3" } as Record<string, string> });
    const next = vi.fn();

    middleware(req, mockRes, next as NextFunction);

    expect(next).toHaveBeenCalled();
  });
});

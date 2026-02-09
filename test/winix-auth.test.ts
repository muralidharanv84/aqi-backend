import { describe, expect, it, vi } from "vitest";
import {
  resolveWinixAuthState,
  type WinixAuthProvider,
} from "../src/winix/auth";
import type { StoredWinixAuthState } from "../src/winix/types";

function buildAuth(overrides: Partial<StoredWinixAuthState> = {}): StoredWinixAuthState {
  return {
    userId: "user-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessExpiresAt: 10_000,
    ...overrides,
  };
}

describe("resolveWinixAuthState", () => {
  it("uses login when there is no stored auth", async () => {
    const provider: WinixAuthProvider = {
      login: vi.fn().mockResolvedValue(buildAuth({ accessToken: "new-access" })),
      refresh: vi.fn(),
    };

    const auth = await resolveWinixAuthState(
      "u@example.com",
      "password",
      null,
      1000,
      provider,
    );

    expect(auth.accessToken).toBe("new-access");
    expect(provider.login).toHaveBeenCalledTimes(1);
    expect(provider.refresh).toHaveBeenCalledTimes(0);
  });

  it("keeps stored auth when token is still fresh", async () => {
    const stored = buildAuth({ accessExpiresAt: 5_000 });
    const provider: WinixAuthProvider = {
      login: vi.fn(),
      refresh: vi.fn(),
    };

    const auth = await resolveWinixAuthState(
      "u@example.com",
      "password",
      stored,
      1_000,
      provider,
    );

    expect(auth).toEqual(stored);
    expect(provider.login).toHaveBeenCalledTimes(0);
    expect(provider.refresh).toHaveBeenCalledTimes(0);
  });

  it("refreshes expired stored auth", async () => {
    const provider: WinixAuthProvider = {
      login: vi.fn(),
      refresh: vi.fn().mockResolvedValue(buildAuth({ accessToken: "refreshed" })),
    };

    const auth = await resolveWinixAuthState(
      "u@example.com",
      "password",
      buildAuth({ accessExpiresAt: 1_001 }),
      1_000,
      provider,
    );

    expect(auth.accessToken).toBe("refreshed");
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.login).toHaveBeenCalledTimes(0);
  });

  it("falls back to login when refresh fails", async () => {
    const provider: WinixAuthProvider = {
      login: vi.fn().mockResolvedValue(buildAuth({ accessToken: "login-fallback" })),
      refresh: vi.fn().mockRejectedValue(new Error("refresh failed")),
    };

    const auth = await resolveWinixAuthState(
      "u@example.com",
      "password",
      buildAuth({ accessExpiresAt: 1_001 }),
      1_000,
      provider,
    );

    expect(auth.accessToken).toBe("login-fallback");
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.login).toHaveBeenCalledTimes(1);
  });
});

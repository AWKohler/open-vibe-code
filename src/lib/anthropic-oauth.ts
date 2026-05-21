/**
 * Anthropic OAuth helpers — refresh + access-token resolution.
 *
 * Shared by /api/agent (BYOK path) and /api/agent/claude-code (Claude Code
 * subprocess path). Both paths need a valid access token, just used differently:
 *  - /api/agent: as the Authorization bearer on direct API calls
 *  - /api/agent/claude-code: written into ~/.claude/.credentials.json inside
 *    the sandbox, then used by the `claude` binary itself
 */
import { setUserCredentials } from "@/lib/user-credentials";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";

export interface AnthropicOAuthCreds {
  claudeOAuthAccessToken: string | null;
  claudeOAuthRefreshToken: string | null;
  claudeOAuthExpiresAt: number | null;
}

/**
 * Refresh the user's Anthropic OAuth access token using the stored refresh
 * token. On success: persists the new tokens back to Clerk metadata + returns
 * the new access token. On failure: returns null (caller decides whether to
 * fall back to a BYOK API key or surface an auth error).
 */
export async function refreshAnthropicOAuthToken(
  creds: Pick<AnthropicOAuthCreds, "claudeOAuthRefreshToken">,
  userId: string,
): Promise<string | null> {
  if (!creds.claudeOAuthRefreshToken) return null;

  try {
    const refreshRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: creds.claudeOAuthRefreshToken,
      }),
    });

    if (!refreshRes.ok) return null;

    const refreshed = (await refreshRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpiresAt = refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000
      : null;

    await setUserCredentials(userId, {
      claudeOAuthAccessToken: refreshed.access_token,
      claudeOAuthRefreshToken: refreshed.refresh_token ?? creds.claudeOAuthRefreshToken,
      claudeOAuthExpiresAt: newExpiresAt,
    });

    return refreshed.access_token;
  } catch {
    return null;
  }
}

/**
 * Returns a usable Anthropic OAuth access token for `userId`, refreshing it
 * proactively if it's within 5 minutes of expiry. Returns null when the user
 * has no OAuth credentials at all or the refresh fails.
 */
export async function getFreshAnthropicAccessToken(
  creds: AnthropicOAuthCreds,
  userId: string,
): Promise<string | null> {
  if (!creds.claudeOAuthAccessToken) return null;

  const expiresAt = creds.claudeOAuthExpiresAt ?? 0;
  const needsRefresh = expiresAt > 0 && expiresAt < Date.now() + 5 * 60 * 1000;

  if (!needsRefresh) return creds.claudeOAuthAccessToken;

  const refreshed = await refreshAnthropicOAuthToken(creds, userId);
  return refreshed ?? creds.claudeOAuthAccessToken;
}

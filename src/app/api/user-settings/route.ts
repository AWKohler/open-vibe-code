import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getUserCredentials, setUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const creds = await getUserCredentials(userId);

    return NextResponse.json({
      hasOpenAIKey: Boolean(creds.openaiApiKey),
      hasAnthropicKey: Boolean(creds.anthropicApiKey),
      hasMoonshotKey: Boolean(creds.moonshotApiKey),
      hasFireworksKey: Boolean(creds.fireworksApiKey),
      hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
      hasCodexOAuth: Boolean(creds.codexOAuthAccessToken),
    });
  } catch (e) {
    console.error('GET /api/user-settings failed:', e);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { openaiApiKey, anthropicApiKey, moonshotApiKey, fireworksApiKey } = body as {
      openaiApiKey?: string | null;
      anthropicApiKey?: string | null;
      moonshotApiKey?: string | null;
      fireworksApiKey?: string | null;
    };

    // Read existing credentials to preserve fields not being updated
    const existing = await getUserCredentials(userId);

    const updates: Parameters<typeof setUserCredentials>[1] = {};
    if (openaiApiKey !== undefined) updates.openaiApiKey = openaiApiKey || null;
    if (anthropicApiKey !== undefined) updates.anthropicApiKey = anthropicApiKey || null;
    if (moonshotApiKey !== undefined) updates.moonshotApiKey = moonshotApiKey || null;
    if (fireworksApiKey !== undefined) updates.fireworksApiKey = fireworksApiKey || null;

    await setUserCredentials(userId, updates);

    // Re-read to return accurate has* flags
    const merged = { ...existing, ...updates };

    return NextResponse.json({
      ok: true,
      hasOpenAIKey: Boolean(merged.openaiApiKey),
      hasAnthropicKey: Boolean(merged.anthropicApiKey),
      hasMoonshotKey: Boolean(merged.moonshotApiKey),
      hasFireworksKey: Boolean(merged.fireworksApiKey),
    });
  } catch (e) {
    console.error('POST /api/user-settings failed:', e);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}

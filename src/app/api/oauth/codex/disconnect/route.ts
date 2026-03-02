import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { userSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = getDb();
    await db
      .update(userSettings)
      .set({
        codexOAuthAccessToken: null,
        codexOAuthRefreshToken: null,
        codexOAuthExpiresAt: null,
        codexOAuthAccountId: null,
        updatedAt: new Date(),
      })
      .where(eq(userSettings.userId, userId));

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('Codex OAuth disconnect failed:', e);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}

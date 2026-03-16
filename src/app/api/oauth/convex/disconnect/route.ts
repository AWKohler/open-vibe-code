import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { clearUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await clearUserCredentials(userId, [
    'convexOAuthAccessToken',
    'convexOAuthRefreshToken',
    'convexOAuthExpiresAt',
  ]);

  return NextResponse.json({ ok: true });
}

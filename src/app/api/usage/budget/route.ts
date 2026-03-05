import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getUserTier } from '@/lib/tier';
import { getWeeklyCredits, getMonthlyCredits, getWeeklyLimit, getMonthlyLimit } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const tier = await getUserTier(userId);
  const weeklyLimit = getWeeklyLimit(tier);
  const monthlyLimit = getMonthlyLimit(tier);

  const [weeklyUsed, monthlyUsed] = await Promise.all([
    getWeeklyCredits(userId),
    getMonthlyCredits(userId),
  ]);

  const pct = weeklyLimit > 0 ? Math.min(100, Math.round((weeklyUsed / weeklyLimit) * 100)) : 0;

  return NextResponse.json({
    tier,
    weeklyUsed,
    weeklyLimit,
    monthlyUsed,
    monthlyLimit,
    pct,
  });
}

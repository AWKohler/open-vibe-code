import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getUserTierAndLimits } from '@/lib/tier';
import { getMonthlyTokenUsage } from '@/lib/usage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const model = req.nextUrl.searchParams.get('model');
  if (!model) return NextResponse.json({ error: 'model param required' }, { status: 400 });

  const limits = await getUserTierAndLimits(userId);
  const budget = limits.tokenBudgets[model];

  if (budget === undefined || budget === 0) {
    // Model not on a server-side budget for this user
    return NextResponse.json({ model, used: 0, limit: 0, pct: 0 });
  }

  const usage = await getMonthlyTokenUsage(userId, model);
  const pct = budget > 0 ? Math.round((usage.total / budget) * 100) : 0;

  return NextResponse.json({
    model,
    used: usage.total,
    limit: budget,
    pct,
  });
}

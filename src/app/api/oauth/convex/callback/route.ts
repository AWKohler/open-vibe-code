import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { setUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = process.env.CONVEX_OAUTH_CLIENT_ID!;
const CLIENT_SECRET = process.env.CONVEX_OAUTH_CLIENT_SECRET!;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;
const REDIRECT_URI = `${APP_URL}/api/oauth/convex/callback`;

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const { userId } = await auth();
  if (!userId) return NextResponse.redirect(`${origin}/sign-in`);

  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');

  let returnTo = '/';
  if (stateParam) {
    try {
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf-8')) as { returnTo?: string };
      if (decoded.returnTo) returnTo = decoded.returnTo;
    } catch { /* use default */ }
  }

  if (!code) return NextResponse.redirect(`${origin}${returnTo}?convex_error=no_code`);

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code,
    });

    const tokenRes = await fetch('https://api.convex.dev/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
      console.error('Convex token exchange failed:', tokenData);
      return NextResponse.redirect(`${origin}${returnTo}?convex_error=token_exchange`);
    }

    await setUserCredentials(userId, {
      convexOAuthAccessToken: tokenData.access_token,
      // Convex doesn't return refresh tokens in the standard flow
      convexOAuthRefreshToken: null,
      convexOAuthExpiresAt: null,
    });

    return NextResponse.redirect(`${origin}${returnTo}?convex_connected=1`);
  } catch (e) {
    console.error('Convex OAuth callback failed:', e);
    return NextResponse.redirect(`${origin}${returnTo}?convex_error=server`);
  }
}

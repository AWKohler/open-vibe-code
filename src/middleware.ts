import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher([
  '/workspace(.*)',
  '/api/(.*)'
]);

// Server-to-server endpoints authenticate themselves (svix signature for
// Clerk webhooks, shared bearer for Vercel cron); they MUST bypass Clerk's
// user-auth gate or the verification step never runs.
const isPublicApi = createRouteMatcher([
  '/api/webhooks/(.*)',
  '/api/cron/(.*)',
]);

export default clerkMiddleware((auth, req) => {
  if (isPublicApi(req)) return;
  if (isProtectedRoute(req)) auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)'
  ],
};

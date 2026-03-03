import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import Link from 'next/link';
import { Workspace } from '@/components/workspace';

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, redirectToSignIn } = await auth();
  const { id: projectId } = await params;
  const searchParamsResolved = searchParams ? await searchParams : {};
  const initialPrompt = typeof searchParamsResolved.prompt === 'string' ? searchParamsResolved.prompt : undefined;
  const platform = typeof searchParamsResolved.platform === 'string' ? (searchParamsResolved.platform as 'web' | 'mobile') : undefined;

  if (!userId) {
    return redirectToSignIn({ returnBackUrl: `/workspace/${projectId}` });
  }

  const db = getDb();
  const [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

  if (!proj) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-elevated text-[var(--sand-text)]">
        <div className="max-w-md text-center space-y-4 p-8 rounded-2xl border border-border bg-white shadow-sm">
          <h1 className="text-2xl font-semibold">No access to this workspace</h1>
          <p className="text-sm text-neutral-600">
            You don&apos;t have permission to view this project. If you think this is a mistake, check that you&apos;re
            signed in with the correct account.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link
              href="/projects"
              className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition"
            >
              Go to my projects
            </Link>
            <Link
              href="/"
              className="inline-flex items-center rounded-xl border border-border bg-elevated px-4 py-2 text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-neutral-50 transition"
            >
              Back home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  await db
    .update(projects)
    .set({ lastOpened: new Date() })
    .where(eq(projects.id, projectId));

  return <Workspace projectId={projectId} initialPrompt={initialPrompt} platform={platform} />;
}

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { ConvexDashboard } from '@/components/convex/ConvexDashboard';
import { getDb } from '@/db';
import { projects } from '@/db/schema';

export default async function DatabasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { userId, redirectToSignIn } = await auth();

  if (!userId) {
    return redirectToSignIn({ returnBackUrl: `/workspace/${id}/database` });
  }

  const db = getDb();
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)));

  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-elevated text-[var(--sand-text)]">
        <div className="max-w-md text-center space-y-4 p-8 rounded-2xl border border-border bg-white shadow-sm">
          <h1 className="text-2xl font-semibold">No access to this project</h1>
          <p className="text-sm text-neutral-600">
            You don&apos;t have permission to view this database.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link
              href="/projects"
              className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition"
            >
              Go to my projects
            </Link>
          </div>
        </div>
      </div>
    );
  }

  await db
    .update(projects)
    .set({ lastOpened: new Date() })
    .where(eq(projects.id, id));

  return (
    <div className="w-screen h-screen">
      <ConvexDashboard projectId={id} />
    </div>
  );
}

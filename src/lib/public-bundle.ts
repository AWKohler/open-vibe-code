import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { tarSandboxProject } from '@/lib/vercel-sandbox';
import { generateUniquePublicSlug } from '@/lib/public-slug';

export interface PublicReconcileResult {
  isPublic: boolean;
  slug: string | null;
}

/**
 * Reconcile a project's public/showcase state, called after a successful deploy.
 *
 *  - makePublic + web platform: tar the sandbox source (no node_modules), upload
 *    it to UploadThing as the project's source bundle, and mark the project
 *    public (generating a slug if needed). Any previous bundle is deleted first.
 *  - otherwise: delete the source bundle from UploadThing and mark the project
 *    private. The Cloudflare deployment is left untouched.
 *
 * Public visibility is therefore always gated on deployment + an explicit opt-in.
 */
export async function reconcilePublicState(
  projectId: string,
  opts: { makePublic: boolean; description?: string | null },
): Promise<PublicReconcileResult> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error('Project not found');

  const { UTApi } = await import('uploadthing/server');
  const utapi = new UTApi();

  // Always delete any existing bundle first (replace on re-publish, or remove on
  // unpublish) so we never orphan UploadThing storage.
  if (project.publicSourceKey) {
    try {
      await utapi.deleteFiles([project.publicSourceKey]);
    } catch (e) {
      console.warn('[public-bundle] failed to delete old bundle (non-fatal)', e);
    }
  }

  const isWeb = project.platform === 'sandboxed-web' || project.platform === 'web';

  if (!opts.makePublic || !isWeb) {
    await db
      .update(projects)
      .set({
        isPublic: false,
        publicSourceUrl: null,
        publicSourceKey: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    return { isPublic: false, slug: project.publicSlug };
  }

  // Tar the project source from the sandbox and upload it.
  const buf = await tarSandboxProject(projectId);
  const file = new File([new Uint8Array(buf)], `${projectId}-source.tar.gz`, {
    type: 'application/gzip',
  });
  const res = await utapi.uploadFiles(file);
  if (res.error || !res.data) {
    throw new Error(`Source bundle upload failed: ${res.error?.message ?? 'unknown error'}`);
  }

  const slug = project.publicSlug ?? (await generateUniquePublicSlug(project.name));
  await db
    .update(projects)
    .set({
      isPublic: true,
      publicSlug: slug,
      publicSourceUrl: res.data.url,
      publicSourceKey: res.data.key,
      publicDescription: opts.description ?? project.publicDescription ?? null,
      publishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  return { isPublic: true, slug };
}

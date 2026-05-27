import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { UTApi } from 'uploadthing/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const utapi = new UTApi();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Verify authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;

    // 2. Verify project ownership
    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // 3. Check if HTML snapshot exists
    if (!project.htmlSnapshotUrl) {
      return NextResponse.json(
        { error: 'No HTML snapshot available for this project' },
        { status: 400 }
      );
    }

    console.log(`🖼️  Fetching HTML from: ${project.htmlSnapshotUrl}`);

    // 4. Fetch the HTML content from UploadThing
    const htmlResponse = await fetch(project.htmlSnapshotUrl);
    if (!htmlResponse.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch HTML snapshot' },
        { status: 500 }
      );
    }

    const htmlContent = await htmlResponse.text();
    console.log(`📄 Fetched HTML: ${htmlContent.length} bytes`);

    // 5. Launch Puppeteer with Chromium
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // Set viewport for thumbnail
    await page.setViewport({
      width: 1200,
      height: 630,
      deviceScaleFactor: 1,
    });

    // 6. Set HTML content. puppeteer-core types only accept 'load' /
    // 'domcontentloaded' for setContent; 'networkidle0' is goto-only and
    // wouldn't fire meaningfully for inline HTML anyway.
    await page.setContent(htmlContent, {
      waitUntil: 'load',
      timeout: 10000,
    });

    // 7. Take screenshot
    console.log('📸 Taking screenshot...');
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
    });

    await browser.close();

    console.log(`✅ Screenshot taken: ${screenshot.length} bytes`);

    // 8. Delete old thumbnail if it exists
    if (project.thumbnailKey) {
      try {
        await utapi.deleteFiles([project.thumbnailKey]);
        console.log(`🗑️  Deleted old thumbnail: ${project.thumbnailKey}`);
      } catch (error) {
        console.warn('Failed to delete old thumbnail:', error);
      }
    }

    // 9. Upload to UploadThing
    // Convert Uint8Array to Buffer for proper Blob compatibility
    const buffer = Buffer.from(screenshot);
    const imageBlob = new Blob([buffer], { type: 'image/png' });
    const imageFile = new File([imageBlob], `${projectId}-thumbnail.png`, { type: 'image/png' });

    const uploadResponse = await utapi.uploadFiles(imageFile);

    if (!uploadResponse.data) {
      return NextResponse.json(
        { error: 'Failed to upload thumbnail' },
        { status: 500 }
      );
    }

    const thumbnailUrl = uploadResponse.data.url;
    const thumbnailKey = uploadResponse.data.key;

    console.log(`✅ Thumbnail uploaded: ${thumbnailUrl}`);

    // 10. Update project record
    await db
      .update(projects)
      .set({
        thumbnailUrl,
        thumbnailKey,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return NextResponse.json({
      success: true,
      thumbnailUrl,
      thumbnailKey,
    });
  } catch (error) {
    console.error('Error generating thumbnail from HTML:', error);
    return NextResponse.json(
      { error: 'Failed to generate thumbnail', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import chromium from '@sparticuz/chromium';
import { getUserTierAndLimits } from '@/lib/tier';
import { getDailyScreenshots, incrementDailyScreenshots } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { createCanvas } from 'canvas';

export const maxDuration = 30; // 30 seconds timeout

// Detect if we're running in production (Vercel) or local
const isProduction = process.env.NODE_ENV === 'production' && process.env.VERCEL;

// For local development, you need Chrome/Chromium installed
// Common paths where Chrome might be installed
const localChromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
  '/Applications/Chromium.app/Contents/MacOS/Chromium', // macOS Chromium
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // Windows
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // Windows x86
  '/usr/bin/google-chrome', // Linux
  '/usr/bin/chromium-browser', // Linux
];

async function findLocalChrome(): Promise<string | null> {
  for (const path of localChromePaths) {
    try {
      if (fs.existsSync(path)) {
        return path;
      }
    } catch {
      // Continue to next path
    }
  }
  return null;
}

/** Validate the screenshot target URL to prevent SSRF attacks.
 *  Only WebContainer preview origins and explicit localhost dev origins are allowed.
 *  Blocks: file://, metadata endpoints, private IP ranges, arbitrary external hosts.
 */
function validateScreenshotUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }

  // Only http(s) allowed — no file://, ftp://, etc.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http/https URLs are allowed' };
  }

  const host = parsed.hostname.toLowerCase();

  // Block AWS/GCP/Azure metadata endpoints
  const metadataHosts = [
    '169.254.169.254', // AWS/GCP/Azure IMDS
    'metadata.google.internal',
    '100.100.100.200', // Alibaba Cloud metadata
  ];
  if (metadataHosts.includes(host)) {
    return { ok: false, reason: 'URL not allowed' };
  }

  // Block private IP ranges
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^::1$/,
    /^fd[0-9a-f]{2}:/i, // IPv6 ULA
    /^0\./,
  ];
  for (const range of privateRanges) {
    if (range.test(host)) {
      // Allow localhost only on known WebContainer/dev ports
      if (host === '127.0.0.1' || host === 'localhost') {
        break; // handled in the allowlist below
      }
      return { ok: false, reason: 'URL not allowed' };
    }
  }

  // Allowlist: WebContainer preview domains and localhost
  const isWebContainer = host.endsWith('.webcontainer.io') || host.endsWith('.webcontainer-api.io');
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';

  if (!isWebContainer && !isLocalhost) {
    return { ok: false, reason: 'Screenshots are only allowed for WebContainer preview URLs' };
  }

  return { ok: true, url: parsed.toString() };
}

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const { url, captureHtml = true } = await request.json();

    if (!url) {
      return new NextResponse('URL is required', { status: 400 });
    }

    // SSRF protection — validate before any network access
    const validated = validateScreenshotUrl(url);
    if (!validated.ok) {
      return new NextResponse(validated.reason, { status: 400 });
    }

    // Rate limiting per tier
    const limits = await getUserTierAndLimits(userId);
    if (isFinite(limits.maxScreenshotsPerDay)) {
      const ssUsed = await getDailyScreenshots(userId);
      if (ssUsed >= limits.maxScreenshotsPerDay) {
        return limitReachedResponse({
          limitType: 'screenshot_daily',
          current: ssUsed,
          limit: limits.maxScreenshotsPerDay,
          tier: limits.tier,
        });
      }
      await incrementDailyScreenshots(userId);
    }

    console.log('📸 Starting screenshot capture for URL:', url);
    console.log('Environment:', isProduction ? 'production' : 'development');

    // Fetch HTML if requested - simple server-side fetch, no CORS issues
    const safeUrl = validated.url;
    let htmlContent: string | null = null;
    if (captureHtml) {
      try {
        console.log('📄 Fetching HTML...');
        const htmlResponse = await fetch(safeUrl);
        if (htmlResponse.ok) {
          htmlContent = await htmlResponse.text();
          console.log('✅ HTML fetched, length:', htmlContent.length);
        } else {
          console.warn('⚠️ HTML fetch failed:', htmlResponse.status);
        }
      } catch (error) {
        console.warn('⚠️ HTML fetch error:', error);
      }
    }

    // Launch browser
    let browser;

    if (isProduction) {
      // Production: Use @sparticuz/chromium for Vercel
      console.log('Using @sparticuz/chromium for production');
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: {
          width: 1280,
          height: 720,
        },
        executablePath: await chromium.executablePath(),
        headless: true,
      });
    } else {
      // Development: Use local Chrome/Chromium
      const chromePath = await findLocalChrome();
      if (!chromePath) {
        console.warn('⚠️ Chrome/Chromium not found. Creating placeholder image.');
        // Create a simple placeholder image for development
        const canvasEl = createCanvas(1280, 720);
        const ctx = canvasEl.getContext('2d');

        // Draw placeholder
        ctx.fillStyle = '#f3f4f6';
        ctx.fillRect(0, 0, 1280, 720);

        ctx.fillStyle = '#6b7280';
        ctx.font = '48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Screenshot Preview', 640, 300);

        ctx.font = '24px Arial';
        ctx.fillText('Install Chrome to capture real screenshots', 640, 360);
        ctx.fillText(url.substring(0, 80), 640, 420);

        const screenshot = canvasEl.toBuffer('image/png');

        // Return placeholder as base64 in same format as real screenshot
        return NextResponse.json({
          screenshot: screenshot.toString('base64'),
          html: htmlContent,
        });
      }
      console.log('Using local Chrome at:', chromePath);
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }

    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });

    console.log('🌐 Navigating to URL...');
    await page.goto(safeUrl, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });

    // Wait a bit for any dynamic content to render
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('📷 Taking screenshot...');
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
    });

    await browser.close();

    console.log('✅ Screenshot captured, size:', screenshot.length, 'bytes');

    // Return both screenshot and HTML as JSON
    return NextResponse.json({
      screenshot: Buffer.from(screenshot).toString('base64'),
      html: htmlContent,
    });

  } catch (error) {
    console.error('❌ Screenshot error:', error);
    return new NextResponse(`Screenshot failed: ${String(error)}`, { status: 500 });
  }
}

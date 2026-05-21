import { NextRequest } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const editorOrigin = searchParams.get('editorOrigin') || request.headers.get('origin') || 'https://botflow.io';
  
  console.log('WebContainer connect request:', {
    id,
    editorOrigin,
    userAgent: request.headers.get('user-agent')
  });

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Connecting to WebContainer</title>
    <style>
      body {
        margin: 0;
        padding: 40px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
      }
      .loading {
        text-align: center;
      }
      .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid #334155;
        border-top: 3px solid #3b82f6;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin: 0 auto 20px;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div class="loading">
      <div class="spinner"></div>
      <h2>Connecting to WebContainer</h2>
      <p>Establishing secure connection...</p>
    </div>
    <script type="module">
      (async () => {
        try {
          console.log('Loading WebContainer connect script...');
          console.log('Window opener:', window.opener);
          console.log('Origin:', window.location.origin);
          
          const { setupConnect } = await import('https://cdn.jsdelivr.net/npm/@webcontainer/api@latest/dist/connect.js');
          
          console.log('Setting up WebContainer connection with origin:', '${editorOrigin}');
          await setupConnect({
            editorOrigin: '${editorOrigin}'
          });
          
          console.log('WebContainer connection established successfully');
          document.body.innerHTML = '<div style="text-align: center; color: #10b981; padding: 40px; font-family: system-ui; min-height: 100vh; display: flex; align-items: center; justify-content: center;"><div><h2>✓ Connected</h2><p>WebContainer connection established</p></div></div>';
        } catch (error) {
          console.error('Failed to establish WebContainer connection:', error);
          document.body.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 40px; font-family: system-ui; min-height: 100vh; display: flex; align-items: center; justify-content: center;"><div><h2>✗ Connection Failed</h2><p>Failed to establish WebContainer connection</p><p style="font-size: 0.8em; margin-top: 10px;">' + error.message + '</p></div></div>';
        }
      })();
    </script>
  </body>
</html>`;

  return new Response(htmlContent, {
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache', 
      'Expires': '0',
      // WebContainer required headers for cross-origin isolation
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // Cross-origin headers
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
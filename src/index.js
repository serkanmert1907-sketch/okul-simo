import realtimeWorker, { LiveRoom } from './realtime.js';
import zoomWorker, { ZoomSessionDO } from './zoom.js';

export { LiveRoom, ZoomSessionDO };

const TEACHER_COOKIE = '__Host-okul_simo_teacher';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return base64Url(new Uint8Array(sig));
}

async function sha256(value) {
  const out = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')));
  return new Uint8Array(out);
}

function constantTimeBytes(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

async function secureCodeMatch(input, expected) {
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  return constantTimeBytes(a, b);
}

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function makeTeacherSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `v1.${exp}`;
  const signature = await hmac(env.AUTH_SECRET, payload);
  return `${payload}.${signature}`;
}

async function hasTeacherSession(request, env) {
  if (!env.AUTH_SECRET || !env.TEACHER_ACCESS_CODE) return false;
  const token = cookieValue(request, TEACHER_COOKIE);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(env.AUTH_SECRET, `v1.${exp}`);
  const [a, b] = await Promise.all([sha256(parts[2]), sha256(expected)]);
  return constantTimeBytes(a, b);
}

function teacherCookie(token) {
  return `${TEACHER_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearTeacherCookie() {
  return `${TEACHER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function securityHeaders(extra = {}) {
  const h = new Headers(extra);
  h.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  h.set('Pragma', 'no-cache');
  h.set('Expires', '0');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  return h;
}

function loginPage(message = '', status = 200) {
  const safeMessage = String(message || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>Okul Simo — Öğretmen Girişi</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#f5f7fb;color:#0f172a;font:15px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial}.card{width:min(430px,100%);background:#fff;border:1px solid #e2e8f0;border-radius:22px;padding:28px;box-shadow:0 18px 55px rgba(15,23,42,.10)}.logo{width:64px;height:64px;border-radius:18px;background:#0f172a;color:#fff;display:grid;place-items:center;font-size:28px;margin-bottom:16px}h1{font-size:25px;margin:0 0 6px}p{margin:0 0 20px;color:#64748b}.field{display:grid;gap:7px}.field label{font-weight:800}.field input{width:100%;border:1px solid #cbd5e1;border-radius:12px;padding:13px 14px;font:inherit;outline:0}.field input:focus{border-color:#60a5fa;box-shadow:0 0 0 3px #dbeafe}.btn{width:100%;margin-top:12px;border:0;border-radius:12px;background:#1467f5;color:#fff;padding:13px 14px;font:inherit;font-weight:850;cursor:pointer}.msg{margin:0 0 14px;padding:10px 11px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:13px}.note{font-size:12px;color:#94a3b8;margin-top:14px;text-align:center}
</style>
</head>
<body>
<main class="card">
<div class="logo">🎓</div>
<h1>Okul Simo</h1>
<p>Öğretmen paneline girmek için öğretmen giriş kodunu yaz.</p>
${safeMessage ? `<div class="msg">${safeMessage}</div>` : ''}
<form method="post" action="/teacher/login" autocomplete="on">
<div class="field">
<label for="code">Öğretmen giriş kodu</label>
<input id="code" name="code" type="password" maxlength="256" required autofocus autocomplete="current-password">
</div>
<button class="btn" type="submit">Giriş yap</button>
</form>
<div class="note">Bu cihazda giriş 30 gün hatırlanır.</div>
</main>
</body>
</html>`;

  const headers = securityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  return new Response(html, { status, headers });
}

function isStudentPage(url) {
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  const room = String(url.searchParams.get('room') || '');
  return /^\d{4}$/.test(room);
}

async function assetNoStore(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/teacher/login') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await hasTeacherSession(request, env)) {
          return Response.redirect(`${url.origin}/`, 302);
        }
        return loginPage();
      }

      if (request.method === 'POST') {
        if (!env.TEACHER_ACCESS_CODE || !env.AUTH_SECRET) {
          return loginPage('Öğretmen giriş sistemi Cloudflare tarafında henüz tamamlanmamış.', 503);
        }

        let code = '';
        try {
          const form = await request.formData();
          code = String(form.get('code') || '').slice(0, 256);
        } catch {
          return loginPage('Giriş isteği okunamadı. Tekrar dene.', 400);
        }

        const ok = await secureCodeMatch(code, env.TEACHER_ACCESS_CODE);
        if (!ok) {
          await new Promise(resolve => setTimeout(resolve, 650));
          return loginPage('Giriş kodu yanlış.', 401);
        }

        const token = await makeTeacherSession(env);
        const headers = securityHeaders({ Location: '/' });
        headers.append('Set-Cookie', teacherCookie(token));
        return new Response(null, { status: 303, headers });
      }

      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
    }

    if (url.pathname === '/teacher/logout') {
      const headers = securityHeaders({ Location: '/teacher/login' });
      headers.append('Set-Cookie', clearTeacherCookie());
      return new Response(null, { status: 303, headers });
    }

    if (url.pathname === '/system/health') {
      const bindings = {
        assets: !!env.ASSETS,
        liveRooms: !!env.LIVE_ROOMS,
        zoomSessions: !!env.ZOOM_SESSIONS,
        liveMedia: !!env.LIVE_MEDIA
      };
      const zoomSecrets = {
        oauthClientId: !!env.ZOOM_CLIENT_ID,
        oauthClientSecret: !!env.ZOOM_CLIENT_SECRET,
        sdkClientId: !!(env.ZOOM_SDK_CLIENT_ID || env.ZOOM_CLIENT_ID),
        sdkClientSecret: !!(env.ZOOM_SDK_CLIENT_SECRET || env.ZOOM_CLIENT_SECRET),
        tokenEncryptionKey: !!env.TOKEN_ENCRYPTION_KEY
      };
      const coreReady = Object.values(bindings).every(Boolean);
      const zoomReady = Object.values(zoomSecrets).every(Boolean);
      const teacherAuthReady = !!env.TEACHER_ACCESS_CODE && !!env.AUTH_SECRET;
      return new Response(JSON.stringify({
        ok: coreReady,
        service: 'okul-simo',
        origin: url.origin,
        coreReady,
        teacherAuthReady,
        zoomReady,
        sdkVersion: env.ZOOM_SDK_VERSION || '6.2.0',
        bindings,
        zoomSecrets,
        endpoints: {
          realtime: '/health',
          websocket: '/ws?room=...',
          zoom: '/zoom/health',
          teacherLogin: '/teacher/login'
        }
      }), {
        status: coreReady ? 200 : 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }

    // Zoom API remains same-origin. Existing Zoom behavior is preserved.
    if (url.pathname.startsWith('/zoom/')) {
      const origin = request.headers.get('Origin') || '';
      if (origin && origin === url.origin) {
        const headers = new Headers(request.headers);
        headers.delete('Origin');
        request = new Request(request, { headers });
      }
      return zoomWorker.fetch(request, env);
    }

    // Realtime room, WebSocket and media routes stay available to students.
    if (url.pathname === '/health' || url.pathname === '/ws' || url.pathname.startsWith('/media/')) {
      return realtimeWorker.fetch(request, env);
    }

    // Student room links remain public, e.g. /?room=4821.
    if (isStudentPage(url)) {
      return assetNoStore(request, env);
    }

    // The main teacher app requires the signed HttpOnly teacher session.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!(await hasTeacherSession(request, env))) return loginPage();
      return assetNoStore(request, env);
    }

    // Manifest, service worker and other static support files contain no teacher data.
    return env.ASSETS.fetch(request);
  }
};

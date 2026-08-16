// Cloudflare Worker — Zoom OAuth + Meeting SDK connector (Durable Object edition)
// Secrets (`wrangler secret put ...`):
//   ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET,
//   ZOOM_SDK_CLIENT_ID (optional; fallback ZOOM_CLIENT_ID),
//   ZOOM_SDK_CLIENT_SECRET (optional; fallback ZOOM_CLIENT_SECRET),
//   TOKEN_ENCRYPTION_KEY
// Binding: ZOOM_SESSIONS (Durable Object namespace -> ZoomSessionDO)
// Vars: APP_ORIGINS, ZOOM_REDIRECT_URI, ZOOM_SDK_VERSION (optional, default 6.2.0)

import { DurableObject } from 'cloudflare:workers';

const ZOOM_API = 'https://api.zoom.us/v2';
const ZOOM_OAUTH = 'https://zoom.us/oauth';
const SESSION_COOKIE = 'ogt_zs';

export class ZoomSessionDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/auth' && request.method === 'GET') {
      const value = await this.ctx.storage.get('auth');
      return json(value || null);
    }
    if (url.pathname === '/auth' && request.method === 'PUT') {
      const value = await request.text();
      await this.ctx.storage.put('auth', value);
      return json({ ok: true });
    }
    if (url.pathname === '/auth' && request.method === 'DELETE') {
      await this.ctx.storage.delete('auth');
      return json({ ok: true });
    }
    if (url.pathname.startsWith('/state/') && request.method === 'PUT') {
      const key = url.pathname.slice('/state/'.length);
      const value = await request.text();
      await this.ctx.storage.put('state:' + key, value);
      return json({ ok: true });
    }
    if (url.pathname.startsWith('/state/') && request.method === 'GET') {
      const key = url.pathname.slice('/state/'.length);
      const value = await this.ctx.storage.get('state:' + key);
      if (value) await this.ctx.storage.delete('state:' + key); // one-time state
      return json(value || null);
    }
    return json({ error: 'not found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

      if (url.pathname === '/zoom/health') {
        return json({ ok: true, service: 'teacher-zoom-connector', sdkVersion: env.ZOOM_SDK_VERSION || '6.2.0' }, 200, cors);
      }
      if (url.pathname === '/zoom/oauth/start' && request.method === 'GET') return oauthStart(request, env);
      if (url.pathname === '/zoom/oauth/callback' && request.method === 'GET') return oauthCallback(request, env);

      if (!originAllowed(origin, env) && origin) return json({ error: 'Bu uygulama adresine izin verilmemiş.' }, 403, cors);
      const session = await ensureSession(request);
      const apiHeaders = new Headers(cors);
      if (session.setCookie) apiHeaders.append('Set-Cookie', session.setCookie);

      if (url.pathname === '/zoom/status' && request.method === 'GET') {
        const auth = await getAuth(env, session.sid);
        return json({
          ok: true,
          connected: !!auth,
          account: auth?.profile ? {
            id: auth.profile.id,
            email: auth.profile.email,
            displayName: auth.profile.display_name || auth.profile.first_name || auth.profile.email
          } : null,
          sdkVersion: env.ZOOM_SDK_VERSION || '6.2.0'
        }, 200, apiHeaders);
      }

      if (url.pathname === '/zoom/disconnect' && request.method === 'POST') {
        await deleteAuth(env, session.sid);
        return json({ ok: true, connected: false }, 200, apiHeaders);
      }

      if (url.pathname === '/zoom/meeting' && request.method === 'POST') {
        const body = await safeJson(request);
        if (body.action && body.action !== 'create') return json({ error: 'Desteklenmeyen işlem.' }, 400, apiHeaders);
        const auth = await requireAccess(env, session.sid);
        const topic = cleanText(body.topic || 'Canlı Ders', 180);
        const start = new Date(Date.now() + 60_000).toISOString();
        const meeting = await zoomFetch(auth.access_token, '/users/me/meetings', {
          method: 'POST',
          body: {
            topic,
            type: 2,
            start_time: start,
            duration: 90,
            timezone: 'UTC',
            settings: {
              host_video: true,
              participant_video: true,
              join_before_host: false,
              waiting_room: true,
              mute_upon_entry: true,
              approval_type: 2,
              audio: 'both',
              auto_recording: 'none'
            }
          }
        });
        return json({
          ok: true,
          meetingNumber: String(meeting.id || ''),
          password: meeting.password || '',
          joinUrl: meeting.join_url || '',
          topic: meeting.topic || topic,
          startTime: meeting.start_time || start
        }, 200, apiHeaders);
      }

      if (url.pathname === '/zoom/host-session' && request.method === 'POST') {
        const body = await safeJson(request);
        const meetingNumber = String(body.meetingNumber || '').replace(/\D/g, '');
        if (meetingNumber.length < 8 || meetingNumber.length > 13) return json({ error: 'Geçerli Zoom toplantı numarası gerekli.' }, 400, apiHeaders);
        const auth = await requireAccess(env, session.sid);
        const zakResp = await zoomFetch(auth.access_token, '/users/me/zak', { method: 'GET' });
        if (!zakResp.token) return json({ error: 'Zoom ZAK tokenı alınamadı.' }, 502, apiHeaders);
        const signature = await makeMeetingSdkJwt(env, meetingNumber, 1);
        return json({
          ok: true,
          signature,
          meetingNumber,
          password: cleanText(body.passcode || '', 32),
          userName: cleanText(body.userName || auth.profile?.display_name || 'Öğretmen', 80),
          zak: zakResp.token,
          sdkVersion: env.ZOOM_SDK_VERSION || '6.2.0',
          sdkKey: env.ZOOM_SDK_CLIENT_ID || env.ZOOM_CLIENT_ID // compatibility with current preview
        }, 200, apiHeaders);
      }

      return json({ error: 'Bulunamadı.' }, 404, apiHeaders);
    } catch (err) {
      console.error(err);
      return json({ error: publicError(err) }, err?.status || 500, cors);
    }
  }
};

async function oauthStart(request, env) {
  mustConfig(env);
  const url = new URL(request.url);
  const session = await ensureSession(request);
  const state = randomId(24);
  const requestedReturnUrl = url.searchParams.get('returnUrl') || '';
  const returnUrl = safeReturnUrl(requestedReturnUrl, env, url.origin);
  const stub = sessionStub(env, session.sid);
  await stub.fetch('https://internal/state/' + encodeURIComponent(state), { method: 'PUT', body: JSON.stringify({ returnUrl, createdAt: Date.now() }) });

  const redirectUri = env.ZOOM_REDIRECT_URI || `${url.origin}/zoom/oauth/callback`;
  const authUrl = new URL('https://zoom.us/oauth/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.ZOOM_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  const headers = new Headers({ Location: authUrl.toString(), 'Cache-Control': 'no-store' });
  if (session.setCookie) headers.append('Set-Cookie', session.setCookie);
  return new Response(null, { status: 302, headers });
}

async function oauthCallback(request, env) {
  mustConfig(env);
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const sid = readCookie(request.headers.get('Cookie') || '', SESSION_COOKIE);
  if (!sid || !code || !state) return oauthResultPage(false, 'Zoom bağlantısı doğrulanamadı.', '');

  const stateRes = await sessionStub(env, sid).fetch('https://internal/state/' + encodeURIComponent(state));
  const stateText = await stateRes.json().catch(() => null);
  if (!stateText) return oauthResultPage(false, 'OAuth doğrulaması süresi doldu veya daha önce kullanıldı.', '');
  let st;
  try { st = JSON.parse(stateText); } catch { return oauthResultPage(false, 'Geçersiz OAuth durumu.', ''); }
  if (Date.now() - Number(st.createdAt || 0) > 10 * 60 * 1000) return oauthResultPage(false, 'OAuth doğrulamasının süresi doldu.', st.returnUrl || '');

  const redirectUri = env.ZOOM_REDIRECT_URI || `${url.origin}/zoom/oauth/callback`;
  const tokenRes = await fetch(`${ZOOM_OAUTH}/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + base64(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) return oauthResultPage(false, tokenData.reason || tokenData.error || 'Zoom erişim tokenı alınamadı.', st.returnUrl || '');

  const profileRes = await fetch(`${ZOOM_API}/users/me`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
  const profile = profileRes.ok ? await profileRes.json() : {};
  const auth = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || '',
    expires_at: Date.now() + Math.max(60, Number(tokenData.expires_in || 3600) - 60) * 1000,
    scope: tokenData.scope || '',
    profile: { id: profile.id || '', email: profile.email || '', display_name: profile.display_name || profile.first_name || profile.email || '' }
  };
  await putAuth(env, sid, auth);
  return oauthResultPage(true, 'Zoom hesabı bağlandı. Bu pencereyi kapatabilirsin.', st.returnUrl || '');
}

async function requireAccess(env, sid) {
  let auth = await getAuth(env, sid);
  if (!auth) throw statusError(401, 'Zoom hesabı bağlı değil. Önce Zoom hesabını bağla.');
  if (Date.now() < Number(auth.expires_at || 0) - 30_000) return auth;
  if (!auth.refresh_token) throw statusError(401, 'Zoom oturumunun süresi doldu. Hesabı yeniden bağla.');

  const tokenRes = await fetch(`${ZOOM_OAUTH}/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + base64(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token })
  });
  const d = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !d.access_token) {
    await deleteAuth(env, sid);
    throw statusError(401, 'Zoom oturumu yenilenemedi. Hesabı tekrar bağla.');
  }
  auth = {
    ...auth,
    access_token: d.access_token,
    refresh_token: d.refresh_token || auth.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(d.expires_in || 3600) - 60) * 1000,
    scope: d.scope || auth.scope || ''
  };
  await putAuth(env, sid, auth);
  return auth;
}

async function zoomFetch(accessToken, path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(ZOOM_API + path, { method: opts.method || 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw statusError(res.status === 401 ? 401 : 502, data.message || data.reason || `Zoom API hatası (${res.status})`);
  return data;
}

async function makeMeetingSdkJwt(env, meetingNumber, role) {
  const clientId = env.ZOOM_SDK_CLIENT_ID || env.ZOOM_CLIENT_ID;
  const clientSecret = env.ZOOM_SDK_CLIENT_SECRET || env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw statusError(500, 'Meeting SDK anahtarları sunucuda ayarlı değil.');
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2;
  const unsigned = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({ appKey: clientId, sdkKey: clientId, mn: String(meetingNumber), role: Number(role), iat, exp, tokenExp: exp }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(clientSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64urlBytes(new Uint8Array(sig));
}

function sessionStub(env, sid) {
  if (!env.ZOOM_SESSIONS) throw statusError(500, 'ZOOM_SESSIONS Durable Object binding ayarlı değil.');
  return env.ZOOM_SESSIONS.get(env.ZOOM_SESSIONS.idFromName(sid));
}
async function putAuth(env, sid, obj) {
  const sealed = await seal(env, JSON.stringify(obj));
  await sessionStub(env, sid).fetch('https://internal/auth', { method: 'PUT', body: sealed });
}
async function getAuth(env, sid) {
  const res = await sessionStub(env, sid).fetch('https://internal/auth');
  const sealed = await res.json().catch(() => null);
  if (!sealed) return null;
  try { return JSON.parse(await unseal(env, sealed)); } catch { await deleteAuth(env, sid); return null; }
}
async function deleteAuth(env, sid) { await sessionStub(env, sid).fetch('https://internal/auth', { method: 'DELETE' }); }

async function cryptoKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY) throw statusError(500, 'TOKEN_ENCRYPTION_KEY secret ayarlı değil.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey(env);
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return b64urlBytes(iv) + '.' + b64urlBytes(new Uint8Array(enc));
}
async function unseal(env, sealed) {
  const [a, b] = String(sealed).split('.');
  if (!a || !b) throw new Error('bad seal');
  const iv = fromB64url(a), data = fromB64url(b), key = await cryptoKey(env);
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(out);
}

async function ensureSession(request) {
  let sid = readCookie(request.headers.get('Cookie') || '', SESSION_COOKIE), setCookie = '';
  if (!sid || !/^[A-Za-z0-9_-]{20,80}$/.test(sid)) {
    sid = randomId(32);
    // SameSite=None allows the Pages app and Worker connector to be on different domains.
    // Prefer a same-site custom subdomain in production for maximum browser compatibility.
    setCookie = `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`;
  }
  return { sid, setCookie };
}

function corsHeaders(origin, env) {
  const h = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin' });
  if (originAllowed(origin, env)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Allow-Credentials', 'true');
    h.set('Access-Control-Allow-Headers', 'Content-Type');
    h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  return h;
}
function originAllowed(origin, env) {
  if (!origin) return true;
  const allowed = String(env.APP_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  return allowed.includes(origin);
}
function safeReturnUrl(raw, env, sameOrigin = '') {
  try {
    const u = new URL(raw);
    if (sameOrigin && u.origin === sameOrigin) return u.toString();
    return originAllowed(u.origin, env) ? u.toString() : '';
  } catch { return ''; }
}
function oauthResultPage(ok, message, returnUrl) {
  const safeMsg = html(message), ret = JSON.stringify(returnUrl || '');
  const targetOrigin = (() => { try { return JSON.stringify(new URL(returnUrl).origin); } catch { return JSON.stringify('*'); } })();
  return new Response(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zoom Bağlantısı</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;font:15px system-ui;color:#0f172a}.c{max-width:480px;padding:28px;background:white;border:1px solid #e2e8f0;border-radius:20px;text-align:center;box-shadow:0 18px 50px #0f172a14}.i{font-size:42px}.ok{color:#15803d}.bad{color:#b91c1c}a{display:inline-block;margin-top:16px;padding:10px 14px;border-radius:10px;background:#2563eb;color:white;text-decoration:none}</style><div class="c"><div class="i">${ok ? '✅' : '⚠️'}</div><h2 class="${ok ? 'ok' : 'bad'}">${ok ? 'Zoom bağlandı' : 'Zoom bağlanamadı'}</h2><p>${safeMsg}</p>${returnUrl ? `<a href="${htmlAttr(returnUrl)}">Uygulamaya dön</a>` : ''}</div><script>try{if(window.opener){window.opener.postMessage({type:${JSON.stringify(ok ? 'zoom:oauth-connected' : 'zoom:oauth-error')},message:${JSON.stringify(message)}},${targetOrigin});setTimeout(()=>window.close(),700)}}catch(e){}${returnUrl ? `setTimeout(()=>{if(!window.opener)location.href=${ret}},1500);` : ''}</script></html>`, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function mustConfig(env) {
  if (!env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) throw statusError(500, 'Zoom OAuth Client ID/Secret ayarlı değil.');
  if (!env.ZOOM_SESSIONS) throw statusError(500, 'ZOOM_SESSIONS Durable Object binding ayarlı değil.');
}
function statusError(status, message) { const e = new Error(message); e.status = status; return e; }
function publicError(e) { return e?.message || 'Beklenmeyen sunucu hatası.'; }
function cleanText(v, max) { return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
async function safeJson(request) { try { return await request.json(); } catch { return {}; } }
function json(data, status = 200, headers = {}) { const h = new Headers(headers); h.set('Content-Type', 'application/json; charset=utf-8'); h.set('Cache-Control', 'no-store'); return new Response(JSON.stringify(data), { status, headers: h }); }
function randomId(bytes = 24) { return b64urlBytes(crypto.getRandomValues(new Uint8Array(bytes))); }
function readCookie(str, name) { for (const part of String(str).split(';')) { const i = part.indexOf('='); if (i < 0) continue; if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); } return ''; }
function base64(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64url(s) { return b64urlBytes(new TextEncoder().encode(s)); }
function b64urlBytes(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function fromB64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function html(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function htmlAttr(s) { return html(s); }

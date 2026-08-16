import realtimeWorker, { LiveRoom } from './realtime.js';
import zoomWorker, { ZoomSessionDO } from './zoom.js';

export { LiveRoom, ZoomSessionDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      return new Response(JSON.stringify({
        ok: coreReady,
        service: 'okul-simo',
        origin: url.origin,
        coreReady,
        zoomReady,
        sdkVersion: env.ZOOM_SDK_VERSION || '6.2.0',
        bindings,
        zoomSecrets,
        endpoints: { realtime: '/health', websocket: '/ws?room=...', zoom: '/zoom/health' }
      }), {
        status: coreReady ? 200 : 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // Zoom API is same-origin in Okul Simo. Strip the Origin header only for
    // same-origin requests so the Zoom connector's strict CORS logic remains
    // useful if it is ever called from another site.
    if (url.pathname.startsWith('/zoom/')) {
      const origin = request.headers.get('Origin') || '';
      if (origin && origin === url.origin) {
        const headers = new Headers(request.headers);
        headers.delete('Origin');
        request = new Request(request, { headers });
      }
      return zoomWorker.fetch(request, env);
    }

    if (url.pathname === '/health' || url.pathname === '/ws' || url.pathname.startsWith('/media/')) {
      return realtimeWorker.fetch(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

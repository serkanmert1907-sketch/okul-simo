import realtimeWorker, { LiveRoom } from './realtime.js';
import zoomWorker, { ZoomSessionDO } from './zoom.js';

export { LiveRoom, ZoomSessionDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    if (url.pathname === '/health' || url.pathname === '/ws' || url.pathname === '/sync' || url.pathname.startsWith('/media/')) {
      return realtimeWorker.fetch(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

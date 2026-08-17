import liveWorker, { LiveRoom } from './realtime.js';
import zoomWorker, { ZoomSessionDO } from './zoom.js';

export { LiveRoom, ZoomSessionDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/live/') || url.pathname === '/health' || url.pathname.startsWith('/media/')) {
      return liveWorker.fetch(request, env);
    }

    if (url.pathname.startsWith('/zoom/')) {
      const origin = request.headers.get('Origin') || '';
      if (origin && origin === url.origin) {
        const headers = new Headers(request.headers);
        headers.delete('Origin');
        request = new Request(request, { headers });
      }
      return zoomWorker.fetch(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

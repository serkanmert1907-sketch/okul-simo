const CACHE='okul-simo-live-v4.3-20260817-presentation-fix';
const SHELL=['./','./index.html','./manifest.webmanifest','./zoom_meeting_embed.html'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
  const c=await caches.open(CACHE);
  await c.addAll(SHELL).catch(()=>{});
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const u=new URL(event.request.url);
  if(u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/media/')||u.pathname.startsWith('/zoom/'))return;
  if(event.request.method!=='GET')return;
  event.respondWith((async()=>{
    try{
      const r=await fetch(event.request,{cache:'no-store'});
      if(r&&r.ok){const c=await caches.open(CACHE);c.put(event.request,r.clone()).catch(()=>{});}
      return r;
    }catch(_){return (await caches.match(event.request))||(await caches.match('./index.html'))||Response.error();}
  })());
});

const CACHE='simo-classroom-assistant-v1-20260817';
const SHELL=['/','/index.html','/student.html','/app.css','/teacher.js','/student.js','/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim()})()));
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(u.origin!==location.origin||u.pathname==='/ws'||u.pathname.startsWith('/api/'))return;if(event.request.method!=='GET')return;event.respondWith((async()=>{try{const r=await fetch(event.request);if(r.ok){const c=await caches.open(CACHE);c.put(event.request,r.clone()).catch(()=>{})}return r}catch{return (await caches.match(event.request))||(await caches.match('/index.html'))}})())});

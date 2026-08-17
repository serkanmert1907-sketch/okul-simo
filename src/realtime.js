import { DurableObject } from "cloudflare:workers";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-File-Name",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (url.pathname === "/health") return json({ ok: true, service: "ogretmen-live-realtime" });

    const room = (url.searchParams.get("room") || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32);
    if (!room) return json({ ok: false, error: "room gerekli" }, 400);

    if (url.pathname === "/ws" || url.pathname.startsWith("/media/")) {
      const stub = env.LIVE_ROOMS.getByName(room);
      return stub.fetch(request);
    }
    return json({ ok: true, endpoints: ["/health", "/ws?room=...", "/media/:id?room=..."] });
  },
};

export class LiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att) this.sessions.set(ws, att);
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async state(roomCode = "") {
    return (await this.ctx.storage.get("roomState")) || {
      code: roomCode,
      students: {},
      confusions: [],
      question: null,
      questionCount: 0,
      lesson: null,
      board: null,
      zoom: null,
      paused: false,
      startedAt: null,
      endedAt: null,
      teacherUpdatedAt: 0,
      updated: Date.now(),
    };
  }

  async validTeacher(token, create = false) {
    if (!token) return false;
    let saved = await this.ctx.storage.get("teacherToken");
    if (!saved && create) {
      await this.ctx.storage.put("teacherToken", token);
      saved = token;
    }
    if (saved && saved !== token && create) {
      const state = await this.ctx.storage.get("roomState");
      const stale = !!state?.endedAt || !state?.updated || (Date.now() - Number(state.updated || 0) > 12 * 60 * 60 * 1000);
      if (stale) {
        await this.ctx.storage.put("teacherToken", token);
        await this.ctx.storage.delete("roomState");
        saved = token;
      }
    }
    return saved === token;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = (url.searchParams.get("room") || "").slice(0, 32);

    if (url.pathname === "/ws") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("Upgrade: websocket gerekli", { status: 426, headers: corsHeaders });
      }
      const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";
      if (role === "teacher") {
        const ok = await this.validTeacher(url.searchParams.get("token") || "", true);
        if (!ok) return new Response("Öğretmen anahtarı geçersiz", { status: 403, headers: corsHeaders });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const attachment = { role, studentId: null, name: null };
      server.serializeAttachment(attachment);
      this.sessions.set(server, attachment);
      const current = await this.state(room);
      server.send(JSON.stringify({ type: "room", room: this.roomFor(role, current, attachment.studentId) }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.startsWith("/media/")) {
      const mediaId = decodeURIComponent(url.pathname.slice("/media/".length)).replace(/[^0-9A-Za-z._-]/g, "").slice(0, 160);
      if (!mediaId) return json({ ok: false, error: "media id gerekli" }, 400);
      const key = `rooms/${room}/${mediaId}`;

      if (request.method === "PUT") {
        const ok = await this.validTeacher(url.searchParams.get("token") || "", false);
        if (!ok) return json({ ok: false, error: "yetkisiz" }, 403);
        const contentType = request.headers.get("Content-Type") || "application/octet-stream";
        await this.env.LIVE_MEDIA.put(key, request.body, {
          httpMetadata: { contentType, cacheControl: "public, max-age=3600" },
          customMetadata: { room, uploadedAt: new Date().toISOString() },
        });
        const publicUrl = `${url.origin}/media/${encodeURIComponent(mediaId)}?room=${encodeURIComponent(room)}`;
        return json({ ok: true, url: publicUrl });
      }

      if (request.method === "GET") {
        const object = await this.env.LIVE_MEDIA.get(key);
        if (!object) return new Response("Dosya bulunamadı", { status: 404, headers: corsHeaders });
        const headers = new Headers(corsHeaders);
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", headers.get("Cache-Control") || "public, max-age=3600");
        return new Response(object.body, { headers });
      }
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    return json({ ok: false, error: "endpoint yok" }, 404);
  }

  presence() {
    const ids = new Set();
    let teacherConnections = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() || this.sessions.get(ws);
        if (att?.role === "student" && att.studentId) ids.add(String(att.studentId));
        if (att?.role === "teacher") teacherConnections++;
      } catch {}
    }
    return { onlineStudents: ids.size, onlineStudentIds: [...ids], teacherOnline: teacherConnections > 0, teacherConnections };
  }

  roomFor(role, state, studentId) {
    const presence = this.presence();
    if (role === "teacher") return { ...state, presence };
    const own = studentId && state.students?.[studentId] ? { [studentId]: state.students[studentId] } : {};
    const safeQuestion = state.question
      ? { ...state.question, correct: state.question.revealed ? state.question.correct : null }
      : null;
    return {
      code: state.code,
      question: safeQuestion,
      questionCount: state.questionCount || 0,
      lesson: state.lesson,
      board: state.board,
      zoom: state.zoom || null,
      paused: !!state.paused,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      teacherUpdatedAt: state.teacherUpdatedAt || 0,
      updated: state.updated,
      presence: { onlineStudents: presence.onlineStudents, teacherOnline: presence.teacherOnline },
      students: own,
      confusions: (state.confusions || []).filter((x) => x.studentId === studentId),
    };
  }

  async persistAndBroadcast(state) {
    state.updated = Date.now();
    await this.ctx.storage.put("roomState", state);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() || this.sessions.get(ws) || { role: "student", studentId: null };
        ws.send(JSON.stringify({ type: "room", room: this.roomFor(att.role, state, att.studentId) }));
      } catch {}
    }
  }

  async webSocketMessage(ws, raw) {
    const rawText = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (rawText.length > 600000) return ws.send(JSON.stringify({ type: "error", message: "Mesaj çok büyük" }));
    let msg;
    try { msg = JSON.parse(rawText); }
    catch { return ws.send(JSON.stringify({ type: "error", message: "Geçersiz mesaj" })); }

    const att = ws.deserializeAttachment() || this.sessions.get(ws) || { role: "student", studentId: null, name: null };
    const state = await this.state();

    if (msg.type === "hello") {
      if (att.role === "student" && msg.studentId && !att.studentId) {
        att.studentId = String(msg.studentId).slice(0, 120);
        att.name = String(msg.name || "Öğrenci").slice(0, 80);
        ws.serializeAttachment(att);
        this.sessions.set(ws, att);
        await this.persistAndBroadcast(state);
      }
      return;
    }

    // Telefon, ilk broadcast oturum kimliği oluşmadan geldiyse güncel oda/tahtayı tekrar çekebilir.
    if (msg.type === "request_room") {
      try {
        const fresh = await this.state();
        ws.send(JSON.stringify({ type: "room", room: this.roomFor(att.role, fresh, att.studentId) }));
      } catch {}
      return;
    }

    if (msg.type === "teacher_update") {
      if (att.role !== "teacher") return;
      const t = msg.room || {};
      const newLesson = !!t.startedAt && Number(t.startedAt) !== Number(state.startedAt || 0);
      const newQuestion = !!t.question?.id && String(t.question.id) !== String(state.question?.id || "");
      const students = { ...(state.students || {}) };
      if (newLesson) {
        for (const st of Object.values(students)) {
          st.answer = null; st.totalAnswered = 0; st.totalCorrect = 0; st.joined = Date.now();
        }
      } else if (newQuestion) {
        for (const st of Object.values(students)) st.answer = null;
      }
      const merged = {
        ...state,
        code: t.code || state.code,
        question: t.question ?? state.question,
        questionCount: Number.isFinite(t.questionCount) ? t.questionCount : (state.questionCount || 0),
        lesson: t.lesson ?? state.lesson,
        board: t.board ?? state.board,
        zoom: t.zoom ?? state.zoom,
        paused: typeof t.paused === "boolean" ? t.paused : !!state.paused,
        startedAt: t.startedAt ?? state.startedAt,
        endedAt: t.endedAt ?? state.endedAt,
        teacherUpdatedAt: Number(t.teacherUpdatedAt || Date.now()),
        students,
        confusions: state.confusions || [],
      };
      await this.persistAndBroadcast(merged);
      return;
    }

    if (msg.type === "teacher_confusions") {
      if (att.role !== "teacher") return;
      state.confusions = Array.isArray(msg.confusions) ? msg.confusions.slice(0, 1000) : state.confusions || [];
      await this.persistAndBroadcast(state);
      return;
    }

    if (msg.type === "student_update") {
      if (att.role !== "student") return;
      const requestedSid = String(msg.studentId || "").slice(0, 120);
      const sid = String(att.studentId || requestedSid).slice(0, 120);
      if (!sid) return;
      if (att.studentId && requestedSid && requestedSid !== att.studentId) {
        return ws.send(JSON.stringify({ type: "error", message: "Öğrenci kimliği değiştirilemez" }));
      }
      att.studentId = sid;
      att.name = String(msg.student?.name || att.name || "Öğrenci").slice(0, 80);
      ws.serializeAttachment(att);
      this.sessions.set(ws, att);

      state.students = state.students || {};
      const prev = state.students[sid] || { id: sid, name: att.name, answer: null, joined: Date.now(), totalAnswered: 0, totalCorrect: 0 };
      let answer = prev.answer ?? null;
      let totalAnswered = Number(prev.totalAnswered || 0);
      let totalCorrect = Number(prev.totalCorrect || 0);
      const incomingAnswer = Number.isInteger(msg.student?.answer) && msg.student.answer >= 0 && msg.student.answer <= 3 ? msg.student.answer : null;
      const canAnswer = !!state.question && !state.paused && !state.endedAt;
      if (canAnswer && answer == null && incomingAnswer != null) {
        answer = incomingAnswer;
        totalAnswered += 1;
        if (incomingAnswer === state.question.correct) totalCorrect += 1;
      }
      state.students[sid] = {
        id: sid,
        name: att.name,
        answer,
        joined: prev.joined || Date.now(),
        totalAnswered,
        totalCorrect,
      };

      const others = (state.confusions || []).filter((x) => x.studentId !== sid);
      const resolvedOwn = (state.confusions || []).filter((x) => x.studentId === sid && x.resolved);
      const own = Array.isArray(msg.confusions)
        ? msg.confusions.filter((x) => String(x.studentId) === sid && !x.resolved).slice(0, 200).map((x) => ({
            id: String(x.id || "").slice(0, 160),
            studentId: sid,
            studentName: att.name,
            target: String(x.target || "").slice(0, 220),
            label: String(x.label || "").slice(0, 300),
            note: String(x.note || "").slice(0, 240),
            at: Number(x.at || Date.now()),
            resolved: false,
          }))
        : [];
      state.confusions = [...others, ...resolvedOwn, ...own].slice(-1000);
      await this.persistAndBroadcast(state);
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
    try { await this.persistAndBroadcast(await this.state()); } catch {}
  }
  async webSocketError(ws) {
    this.sessions.delete(ws);
    try { await this.persistAndBroadcast(await this.state()); } catch {}
  }
}

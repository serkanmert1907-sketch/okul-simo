import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Simo-Live": "v4-memory",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}
function cleanRoom(value) { return String(value || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32); }
function cleanId(value, max = 120) { return String(value || "").replace(/[<>]/g, "").trim().slice(0, max); }
function cleanName(value) { return cleanId(value || "Öğrenci", 80) || "Öğrenci"; }
function now() { return Date.now(); }
function byteLength(value) { return new TextEncoder().encode(value).byteLength; }
function makeState(code = "") {
  return {
    code,
    version: 0,
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
    updated: 0,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,X-File-Name",
          "Access-Control-Max-Age": "86400",
          "X-Simo-Live": "v4-memory",
        },
      });
    }

    if (url.pathname === "/health" || url.pathname === "/api/live/health") {
      return json({
        ok: true,
        service: "simo-live-v4",
        transport: "https-heartbeat",
        sameOrigin: true,
        liveState: "durable-object-memory",
        sqliteWrites: 0,
      });
    }

    const room = cleanRoom(url.searchParams.get("room"));
    if (!room) return json({ ok: false, error: "room gerekli" }, 400);

    if (url.pathname.startsWith("/api/live/") || url.pathname.startsWith("/media/")) {
      return env.LIVE_ROOMS.getByName(room).fetch(request);
    }

    return json({ ok: false, error: "endpoint yok" }, 404);
  },
};

export class LiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.teacherToken = "";
    this.teacherLastSeen = 0;
    this.studentPresence = new Map();
  }

  ensureRoom(code) {
    if (!this.room || this.room.code !== code) this.room = makeState(code);
    return this.room;
  }

  touchTeacher() { this.teacherLastSeen = now(); }

  touchStudent(id, name) {
    if (!id) return;
    this.studentPresence.set(id, { at: now(), name: cleanName(name) });
    const cutoff = now() - 60000;
    for (const [sid, x] of this.studentPresence) {
      if (!x || Number(x.at || 0) < cutoff) this.studentPresence.delete(sid);
    }
  }

  presence() {
    const cutoff = now() - 15000;
    const ids = [];
    for (const [id, x] of this.studentPresence) {
      if (x && Number(x.at || 0) >= cutoff) ids.push(id);
    }
    const teacherOnline = this.teacherLastSeen >= cutoff;
    return {
      onlineStudents: ids.length,
      onlineStudentIds: ids,
      teacherOnline,
      teacherConnections: teacherOnline ? 1 : 0,
    };
  }

  validTeacher(token, create = false) {
    token = cleanId(token, 160);
    if (!token) return false;
    if (!this.teacherToken && create) {
      this.teacherToken = token;
      return true;
    }
    if (this.teacherToken === token) return true;
    if (!create) return false;

    const state = this.room || makeState();
    const empty = Number(state.version || 0) === 0 && !state.startedAt && !state.board && !state.lesson && !state.question;
    const stale = !!state.endedAt || (!!state.updated && now() - Number(state.updated) > 6 * 60 * 60 * 1000);
    if (empty || stale) {
      this.teacherToken = token;
      if (stale) this.room = makeState(state.code || "");
      return true;
    }
    return false;
  }

  roomFor(role, state, studentId = "") {
    const presence = this.presence();
    if (role === "teacher") return { ...state, presence };

    const sid = cleanId(studentId);
    const own = sid && state.students?.[sid] ? { [sid]: state.students[sid] } : {};
    const safeQuestion = state.question
      ? { ...state.question, correct: state.question.revealed ? state.question.correct : null }
      : null;

    return {
      code: state.code,
      version: state.version || 0,
      question: safeQuestion,
      questionCount: state.questionCount || 0,
      lesson: state.lesson || null,
      board: state.board || null,
      zoom: state.zoom || null,
      paused: !!state.paused,
      startedAt: state.startedAt || null,
      endedAt: state.endedAt || null,
      teacherUpdatedAt: state.teacherUpdatedAt || 0,
      updated: state.updated || 0,
      presence: { onlineStudents: presence.onlineStudents, teacherOnline: presence.teacherOnline },
      students: own,
      confusions: (state.confusions || []).filter((x) => x.studentId === sid),
    };
  }

  async teacherUpdate(request, url, roomCode) {
    const token = url.searchParams.get("token") || "";
    const state = this.ensureRoom(roomCode);
    if (!this.validTeacher(token, true)) {
      return json({ ok: false, error: "Öğretmen anahtarı geçersiz", code: "TEACHER_TOKEN" }, 403);
    }

    this.touchTeacher();
    const raw = await request.text();
    if (byteLength(raw) > 2_000_000) {
      return json({ ok: false, error: "Canlı tahta paketi çok büyük", code: "PAYLOAD_TOO_LARGE" }, 413);
    }

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { return json({ ok: false, error: "Geçersiz JSON", code: "BAD_JSON" }, 400); }

    const t = body.room || {};
    const newLesson = !!t.startedAt && Number(t.startedAt) !== Number(state.startedAt || 0);
    const newQuestion = !!t.question?.id && String(t.question.id) !== String(state.question?.id || "");
    const students = { ...(state.students || {}) };

    if (newLesson) {
      for (const st of Object.values(students)) {
        st.answer = null;
        st.totalAnswered = 0;
        st.totalCorrect = 0;
        st.joined = now();
      }
    } else if (newQuestion) {
      for (const st of Object.values(students)) st.answer = null;
    }

    this.room = {
      ...state,
      code: roomCode,
      version: Number(state.version || 0) + 1,
      question: t.question ?? state.question,
      questionCount: Number.isFinite(t.questionCount) ? t.questionCount : (state.questionCount || 0),
      lesson: t.lesson ?? state.lesson,
      board: t.board ?? state.board,
      zoom: t.zoom ?? state.zoom,
      paused: typeof t.paused === "boolean" ? t.paused : !!state.paused,
      startedAt: t.startedAt ?? state.startedAt,
      endedAt: t.endedAt ?? state.endedAt,
      teacherUpdatedAt: Number(t.teacherUpdatedAt || now()),
      updated: now(),
      students,
      confusions: Array.isArray(body.confusions) ? body.confusions.slice(-1000) : (state.confusions || []),
    };

    return json({ ok: true, room: this.roomFor("teacher", this.room) });
  }

  async studentUpdate(request, url, roomCode) {
    const state = this.ensureRoom(roomCode);
    const raw = await request.text();
    if (byteLength(raw) > 300_000) return json({ ok: false, error: "Öğrenci paketi çok büyük" }, 413);

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { return json({ ok: false, error: "Geçersiz JSON" }, 400); }

    const sid = cleanId(body.studentId || url.searchParams.get("studentId"));
    if (!sid) return json({ ok: false, error: "studentId gerekli" }, 400);
    const name = cleanName(body.student?.name || body.name || "Öğrenci");
    this.touchStudent(sid, name);

    state.students ||= {};
    const prev = state.students[sid] || {
      id: sid, name, answer: null, joined: now(), totalAnswered: 0, totalCorrect: 0,
    };

    let answer = prev.answer ?? null;
    let totalAnswered = Number(prev.totalAnswered || 0);
    let totalCorrect = Number(prev.totalCorrect || 0);
    const incomingAnswer = Number.isInteger(body.student?.answer) && body.student.answer >= 0 && body.student.answer <= 3
      ? body.student.answer : null;
    const canAnswer = !!state.question && !state.paused && !state.endedAt;

    if (canAnswer && answer == null && incomingAnswer != null) {
      answer = incomingAnswer;
      totalAnswered += 1;
      if (incomingAnswer === state.question.correct) totalCorrect += 1;
    }

    state.students[sid] = {
      id: sid,
      name,
      answer,
      joined: prev.joined || now(),
      totalAnswered,
      totalCorrect,
    };

    if (Array.isArray(body.confusions)) {
      const others = (state.confusions || []).filter((x) => x.studentId !== sid);
      const resolvedOwn = (state.confusions || []).filter((x) => x.studentId === sid && x.resolved);
      const own = body.confusions
        .filter((x) => String(x.studentId) === sid && !x.resolved)
        .slice(-200)
        .map((x) => ({
          id: cleanId(x.id, 160),
          studentId: sid,
          studentName: name,
          target: cleanId(x.target, 220),
          label: cleanId(x.label, 300),
          note: cleanId(x.note, 240),
          at: Number(x.at || now()),
          resolved: false,
        }));
      state.confusions = [...others, ...resolvedOwn, ...own].slice(-1000);
    }

    state.version = Number(state.version || 0) + 1;
    state.updated = now();
    this.room = state;
    return json({ ok: true, room: this.roomFor("student", state, sid) });
  }

  stateRead(url, roomCode) {
    const state = this.ensureRoom(roomCode);
    const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";
    const sid = cleanId(url.searchParams.get("studentId"));

    if (role === "teacher") {
      if (!this.validTeacher(url.searchParams.get("token") || "", true)) {
        return json({ ok: false, error: "Öğretmen anahtarı geçersiz", code: "TEACHER_TOKEN" }, 403);
      }
      this.touchTeacher();
    } else if (sid) {
      this.touchStudent(sid, url.searchParams.get("name") || "Öğrenci");
    }

    return json({ ok: true, room: this.roomFor(role, state, sid) });
  }

  async media(request, url, roomCode) {
    const mediaId = decodeURIComponent(url.pathname.slice("/media/".length))
      .replace(/[^0-9A-Za-z._-]/g, "")
      .slice(0, 160);
    if (!mediaId) return json({ ok: false, error: "media id gerekli" }, 400);

    const key = `rooms-v4/${roomCode}/${mediaId}`;
    if (request.method === "PUT") {
      if (!this.validTeacher(url.searchParams.get("token") || "", false)) {
        return json({ ok: false, error: "yetkisiz" }, 403);
      }
      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      await this.env.LIVE_MEDIA.put(key, request.body, {
        httpMetadata: { contentType, cacheControl: "public, max-age=3600" },
        customMetadata: { room: roomCode, uploadedAt: new Date().toISOString() },
      });
      return json({ ok: true, url: `${url.origin}/media/${encodeURIComponent(mediaId)}?room=${encodeURIComponent(roomCode)}` });
    }

    if (request.method === "GET") {
      const object = await this.env.LIVE_MEDIA.get(key);
      if (!object) return new Response("Dosya bulunamadı", { status: 404 });
      const headers = new Headers({ "Cache-Control": "public, max-age=3600" });
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = cleanRoom(url.searchParams.get("room"));
    if (!room) return json({ ok: false, error: "room gerekli" }, 400);

    try {
      if (url.pathname === "/api/live/state" && request.method === "GET") return this.stateRead(url, room);
      if (url.pathname === "/api/live/teacher" && request.method === "POST") return await this.teacherUpdate(request, url, room);
      if (url.pathname === "/api/live/student" && request.method === "POST") return await this.studentUpdate(request, url, room);
      if (url.pathname.startsWith("/media/")) return await this.media(request, url, room);
      return json({ ok: false, error: "endpoint yok" }, 404);
    } catch (err) {
      console.error("Simo Live V4 error", err);
      return json({ ok: false, error: String(err?.message || err), code: "LIVE_V4_ERROR" }, 500);
    }
  }
}

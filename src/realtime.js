import { DurableObject } from "cloudflare:workers";

const STATE_KEY = "roomStateV3";
const TOKEN_KEY = "teacherTokenV3";
const PRESENCE_KEY = "presenceV3";
const MAX_STATE_BYTES = 1_900_000;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Simo-Live": "v3",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function cleanRoom(value) {
  return String(value || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32);
}
function cleanId(value, max = 120) {
  return String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
}
function cleanName(value) {
  return cleanId(value || "Öğrenci", 80) || "Öğrenci";
}
function now() {
  return Date.now();
}
function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}
function emptyState(roomCode = "") {
  return {
    code: roomCode,
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
          "X-Simo-Live": "v3",
        },
      });
    }

    if (url.pathname === "/health" || url.pathname === "/api/live/health") {
      return json({
        ok: true,
        service: "simo-live-v3",
        transport: "https-polling",
        sameOrigin: true,
        storage: "sqlite-durable-object",
      });
    }

    const room = cleanRoom(url.searchParams.get("room"));
    if (!room) return json({ ok: false, error: "room gerekli" }, 400);

    if (url.pathname.startsWith("/api/live/") || url.pathname.startsWith("/media/")) {
      const stub = env.LIVE_ROOMS.getByName(room);
      return stub.fetch(request);
    }

    return json({ ok: false, error: "endpoint yok" }, 404);
  },
};

export class LiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.presenceCache = null;
    this.presenceWriteAt = 0;
  }

  async state(roomCode = "") {
    const saved = await this.ctx.storage.get(STATE_KEY);
    if (saved) return saved;
    return emptyState(roomCode);
  }

  async putState(state) {
    state.version = Number(state.version || 0) + 1;
    state.updated = now();
    const encoded = JSON.stringify(state);
    if (byteLength(encoded) > MAX_STATE_BYTES) {
      throw new Error("Canlı tahta verisi 1,9 MB sınırını aştı. Çok uzun çizimleri veya büyük metinleri azaltın.");
    }
    await this.ctx.storage.put(STATE_KEY, state);
    return state;
  }

  async loadPresence() {
    if (this.presenceCache) return this.presenceCache;
    this.presenceCache = (await this.ctx.storage.get(PRESENCE_KEY)) || {
      teacherSeenAt: 0,
      students: {},
    };
    this.presenceCache.students ||= {};
    return this.presenceCache;
  }

  async persistPresence(force = false) {
    if (!this.presenceCache) return;
    const t = now();
    if (!force && t - this.presenceWriteAt < 3000) return;
    this.presenceWriteAt = t;
    await this.ctx.storage.put(PRESENCE_KEY, this.presenceCache);
  }

  async touchTeacher() {
    const p = await this.loadPresence();
    p.teacherSeenAt = now();
    await this.persistPresence(false);
  }

  async touchStudent(id, name) {
    if (!id) return;
    const p = await this.loadPresence();
    p.students[id] = { at: now(), name: cleanName(name) };
    const cutoff = now() - 60_000;
    for (const [sid, x] of Object.entries(p.students)) {
      if (!x || Number(x.at || 0) < cutoff) delete p.students[sid];
    }
    await this.persistPresence(false);
  }

  async presence() {
    const p = await this.loadPresence();
    const cutoff = now() - 15_000;
    const onlineStudentIds = Object.entries(p.students || {})
      .filter(([, x]) => Number(x?.at || 0) >= cutoff)
      .map(([id]) => id);

    return {
      onlineStudents: onlineStudentIds.length,
      onlineStudentIds,
      teacherOnline: Number(p.teacherSeenAt || 0) >= cutoff,
      teacherConnections: Number(p.teacherSeenAt || 0) >= cutoff ? 1 : 0,
    };
  }

  async validTeacher(token, create = false) {
    token = cleanId(token, 160);
    if (!token) return false;

    let saved = await this.ctx.storage.get(TOKEN_KEY);
    if (!saved && create) {
      await this.ctx.storage.put(TOKEN_KEY, token);
      return true;
    }
    if (saved === token) return true;
    if (!create) return false;

    const state = await this.state();
    const noStudents = !Object.keys(state.students || {}).length;
    const empty =
      Number(state.version || 0) === 0 &&
      !state.startedAt &&
      !state.endedAt &&
      !state.board &&
      !state.lesson &&
      !state.question &&
      noStudents;

    const stale =
      !!state.endedAt ||
      (!!state.updated && now() - Number(state.updated || 0) > 6 * 60 * 60 * 1000);

    // Empty rooms may be safely reclaimed. This prevents a dead token from
    // permanently locking a brand-new room before the first board write.
    if (empty || stale) {
      await this.ctx.storage.put(TOKEN_KEY, token);
      if (stale && !empty) {
        await this.ctx.storage.delete(STATE_KEY);
        this.presenceCache = { teacherSeenAt: 0, students: {} };
        await this.ctx.storage.put(PRESENCE_KEY, this.presenceCache);
      }
      return true;
    }

    return false;
  }

  async roomFor(role, state, studentId = "") {
    const presence = await this.presence();
    if (role === "teacher") return { ...state, presence };

    const sid = cleanId(studentId);
    const own = sid && state.students?.[sid] ? { [sid]: state.students[sid] } : {};
    const safeQuestion = state.question
      ? {
          ...state.question,
          correct: state.question.revealed ? state.question.correct : null,
        }
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
      presence: {
        onlineStudents: presence.onlineStudents,
        teacherOnline: presence.teacherOnline,
      },
      students: own,
      confusions: (state.confusions || []).filter((x) => x.studentId === sid),
    };
  }

  async teacherUpdate(request, url, room) {
    const token = url.searchParams.get("token") || "";
    if (!(await this.validTeacher(token, true))) {
      return json(
        { ok: false, error: "Öğretmen anahtarı geçersiz", code: "TEACHER_TOKEN" },
        403,
      );
    }

    await this.touchTeacher();

    const raw = await request.text();
    if (byteLength(raw) > 2_000_000) {
      return json({ ok: false, error: "Canlı tahta paketi çok büyük", code: "PAYLOAD_TOO_LARGE" }, 413);
    }

    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json({ ok: false, error: "Geçersiz JSON", code: "BAD_JSON" }, 400);
    }

    const state = await this.state(room);
    const t = body.room || {};
    const newLesson =
      !!t.startedAt && Number(t.startedAt) !== Number(state.startedAt || 0);
    const newQuestion =
      !!t.question?.id &&
      String(t.question.id) !== String(state.question?.id || "");

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

    const merged = {
      ...state,
      code: room,
      question: t.question ?? state.question,
      questionCount: Number.isFinite(t.questionCount)
        ? t.questionCount
        : state.questionCount || 0,
      lesson: t.lesson ?? state.lesson,
      board: t.board ?? state.board,
      zoom: t.zoom ?? state.zoom,
      paused: typeof t.paused === "boolean" ? t.paused : !!state.paused,
      startedAt: t.startedAt ?? state.startedAt,
      endedAt: t.endedAt ?? state.endedAt,
      teacherUpdatedAt: Number(t.teacherUpdatedAt || now()),
      students,
      confusions: Array.isArray(body.confusions)
        ? body.confusions.slice(-1000)
        : state.confusions || [],
    };

    const saved = await this.putState(merged);
    await this.persistPresence(true);
    return json({ ok: true, room: await this.roomFor("teacher", saved) });
  }

  async studentUpdate(request, url, room) {
    const raw = await request.text();
    if (byteLength(raw) > 300_000) {
      return json({ ok: false, error: "Öğrenci paketi çok büyük" }, 413);
    }

    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json({ ok: false, error: "Geçersiz JSON" }, 400);
    }

    const sid = cleanId(body.studentId || url.searchParams.get("studentId"));
    if (!sid) return json({ ok: false, error: "studentId gerekli" }, 400);

    const name = cleanName(body.student?.name || body.name || "Öğrenci");
    await this.touchStudent(sid, name);

    const state = await this.state(room);
    state.students ||= {};

    const prev = state.students[sid] || {
      id: sid,
      name,
      answer: null,
      joined: now(),
      totalAnswered: 0,
      totalCorrect: 0,
    };

    let answer = prev.answer ?? null;
    let totalAnswered = Number(prev.totalAnswered || 0);
    let totalCorrect = Number(prev.totalCorrect || 0);

    const incomingAnswer =
      Number.isInteger(body.student?.answer) &&
      body.student.answer >= 0 &&
      body.student.answer <= 3
        ? body.student.answer
        : null;

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
      const resolvedOwn = (state.confusions || []).filter(
        (x) => x.studentId === sid && x.resolved,
      );
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

    const saved = await this.putState(state);
    return json({ ok: true, room: await this.roomFor("student", saved, sid) });
  }

  async stateRead(url, room) {
    const role =
      url.searchParams.get("role") === "teacher" ? "teacher" : "student";
    const sid = cleanId(url.searchParams.get("studentId"));

    if (role === "teacher") {
      const token = url.searchParams.get("token") || "";
      if (!(await this.validTeacher(token, true))) {
        return json(
          { ok: false, error: "Öğretmen anahtarı geçersiz", code: "TEACHER_TOKEN" },
          403,
        );
      }
      await this.touchTeacher();
    } else if (sid) {
      await this.touchStudent(sid, url.searchParams.get("name") || "Öğrenci");
    }

    const state = await this.state(room);
    return json({ ok: true, room: await this.roomFor(role, state, sid) });
  }

  async media(request, url, room) {
    const mediaId = decodeURIComponent(url.pathname.slice("/media/".length))
      .replace(/[^0-9A-Za-z._-]/g, "")
      .slice(0, 160);
    if (!mediaId) return json({ ok: false, error: "media id gerekli" }, 400);

    const key = `rooms-v3/${room}/${mediaId}`;

    if (request.method === "PUT") {
      if (!(await this.validTeacher(url.searchParams.get("token") || "", false))) {
        return json({ ok: false, error: "yetkisiz" }, 403);
      }

      const contentType =
        request.headers.get("Content-Type") || "application/octet-stream";
      await this.env.LIVE_MEDIA.put(key, request.body, {
        httpMetadata: {
          contentType,
          cacheControl: "public, max-age=3600",
        },
        customMetadata: {
          room,
          uploadedAt: new Date().toISOString(),
        },
      });

      const publicUrl = `${url.origin}/media/${encodeURIComponent(
        mediaId,
      )}?room=${encodeURIComponent(room)}`;
      return json({ ok: true, url: publicUrl });
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
      if (url.pathname === "/api/live/state" && request.method === "GET") {
        return await this.stateRead(url, room);
      }
      if (url.pathname === "/api/live/teacher" && request.method === "POST") {
        return await this.teacherUpdate(request, url, room);
      }
      if (url.pathname === "/api/live/student" && request.method === "POST") {
        return await this.studentUpdate(request, url, room);
      }
      if (url.pathname.startsWith("/media/")) {
        return await this.media(request, url, room);
      }
      return json({ ok: false, error: "endpoint yok" }, 404);
    } catch (err) {
      console.error("Simo Live V3 error", err);
      return json(
        {
          ok: false,
          error: String(err?.message || err),
          code: "LIVE_V3_ERROR",
        },
        500,
      );
    }
  }
}

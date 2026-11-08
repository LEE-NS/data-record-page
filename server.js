// 데이터 확보 문서 생성기 - 정적 파일 + DeepL 번역 프록시 서버 (의존성 없음, Node 18+)
const http = require("http");
const fs = require("fs");
const path = require("path");

// .env 간이 로더
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  });
} catch (e) {}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.DEEPL_API_KEY || "").trim();
// 무료 키는 ':fx' 로 끝납니다. 키 형태에 따라 Free/Pro 주소를 자동 선택하며, DEEPL_API_URL 로 직접 지정할 수도 있습니다.
const API_URL = (process.env.DEEPL_API_URL || (API_KEY.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com")).replace(/\/+$/, "");
const BASIC_AUTH = process.env.BASIC_AUTH || ""; // 예: admin:비밀번호 (비우면 인증 없음)
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN) || 20; // IP당 분당 번역 횟수
const MAX_CHARS = 2000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml" };

// 한글 자모음만 제거했을 때 글자가 하나도 없으면 번역 불가로 판단
const JAMO = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/g;
const meaningful = (t) => /\p{L}/u.test(t.replace(JAMO, ""));
const HANGUL = /[\uAC00-\uD7A3]/;
const norm = (s) => s.replace(/\s+/g, "").toLowerCase();

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return arr.length > RATE_PER_MIN;
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("too_long"), { code: "too_long" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// DeepL: 원문 언어는 자동 감지, 영어(미국)로 번역
async function translate(text) {
  const r = await fetch(API_URL + "/v2/translate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "DeepL-Auth-Key " + API_KEY },
    body: JSON.stringify({ text: [text], target_lang: "EN-US" }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const err = new Error("upstream " + r.status);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const first = data.translations && data.translations[0];
  return String((first && first.text) || "").trim();
}

function authorized(req) {
  if (!BASIC_AUTH) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  return Buffer.from(h.slice(6), "base64").toString("utf8") === BASIC_AUTH;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="task-doc"' });
      return res.end("Authentication required");
    }
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/translate") {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      if (!API_KEY) return send(res, 500, { error: "not_configured" });
      const ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "unknown";
      if (limited(ip)) return send(res, 429, { error: "rate_limited" });

      let text = "";
      try {
        text = String(JSON.parse(await readBody(req)).text || "").trim();
      } catch (e) {
        if (e.code === "too_long") return send(res, 413, { error: "too_long" });
        return send(res, 400, { error: "bad_request" });
      }
      if (!text) return send(res, 400, { error: "bad_request" });
      if (text.length > MAX_CHARS) return send(res, 413, { error: "too_long" });

      // 의미 없는 입력은 DeepL 호출(글자 수 차감) 없이 바로 거절
      if (!meaningful(text)) return send(res, 200, { untranslatable: true });

      try {
        const out = await translate(text);
        // 결과가 비었거나, 한글 입력이 그대로 돌아온 경우는 번역되지 않은 것으로 판단
        if (!out || (HANGUL.test(text) && norm(out) === norm(text))) return send(res, 200, { untranslatable: true });
        return send(res, 200, { translation: out });
      } catch (e) {
        console.error("translate error:", e.message);
        if (e.status === 456) return send(res, 503, { error: "quota_exceeded" }); // 월 한도 초과
        if (e.status === 403) return send(res, 500, { error: "not_configured" }); // 키 오류
        if (e.status === 429) return send(res, 429, { error: "rate_limited" });
        return send(res, 502, { error: "upstream" });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    let rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "server_error" });
  }
});

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT} (DeepL: ${API_URL}, key: ${API_KEY ? "set" : "NOT SET"})`));

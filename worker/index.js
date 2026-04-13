// Cloudflare Worker — Highlight Generator v2
// Endpoints: POST /recommend, POST /save, GET /load?id=xxx

const SYSTEM_PROMPT = `당신은 유튜브 인터뷰 채널 'ttimes'의 하이라이트 편집자입니다.
인터뷰 원고를 읽고, 30~40초 분량의 하이라이트 영상에 쓸 수 있는 인상적인 발언 구간을 추천합니다.

## 하이라이트란?
- 인터뷰에서 가장 임팩트 있는 발언 5~8개를 뽑아 이어 붙인 30~40초짜리 쇼츠/프리뷰 영상
- 시청자가 "이 인터뷰 본편을 봐야겠다"고 느끼게 만드는 것이 목적
- 각 발언은 2~8초 분량 (10~50자 정도)

## 좋은 하이라이트 구간의 조건
1. 그 자체로 임팩트가 있는 문장 (맥락 없이 들어도 "오?" 하는 발언)
2. 구체적 숫자나 사실이 포함된 발언 ("토큰을 월 4000달러 씁니다")
3. 감정이 실린 단언 ("적게 써서 잘할 가능성은 없어요")
4. 대비/반전이 있는 발언 ("주니어는 400불, 시니어는 4000불")
5. 게스트만의 독특한 표현이나 비유
6. 호스트(홍재의)의 날카로운 질문이나 반응도 포함 가능

## 피해야 할 구간
- 너무 긴 설명이나 나열
- 맥락 없이는 이해 불가능한 발언
- "네", "그렇죠" 같은 맞장구만 있는 부분

## 출력 형식 (JSON만 출력)
{
  "candidates": [
    {
      "text": "원고에서 발췌한 정확한 텍스트",
      "speaker": "화자명",
      "reason": "왜 하이라이트에 적합한지",
      "impact": "high|medium",
      "estimated_seconds": 3
    }
  ],
  "suggested_flow": "추천 순서대로 이어붙였을 때의 흐름 설명 (1문장)"
}

## 규칙
- 후보를 8~12개 추천 (편집자가 그중 5~8개를 선택)
- impact가 high인 것을 5개 이상 포함
- 원고의 텍스트를 정확히 발췌 (수정하지 말 것)
- estimated_seconds는 ttimes 인터뷰 말하기 속도 기준 (초당 약 9자, 분당 540자)
- 총 후보의 합산이 60~90초 분량이 되도록`;

function compressScript(text, maxChars) {
  if (text.length <= maxChars) return text;
  var h = Math.floor(maxChars * 0.4), t = Math.floor(maxChars * 0.4);
  var mid = maxChars - h - t - 50, ms = Math.floor(text.length * 0.4);
  return text.substring(0, h) + "\n[...중략...]\n" + text.substring(ms, ms + mid) + "\n[...중략...]\n" + text.substring(text.length - t);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

const ALLOWED_ORIGINS = [
  "https://ttimesvibe.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
];
function getAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

async function verifyJWT(token, secret) {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Invalid token");
  const encoder = new TextEncoder();
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sig = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(data));
  if (!valid) throw new Error("Invalid signature");
  const payloadBytes = Uint8Array.from(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  if (payload.exp < Date.now() / 1000) throw new Error("Token expired");
  return payload;
}

async function verifyAuth(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  try { return await verifyJWT(auth.slice(7), env.JWT_SECRET); }
  catch { return null; }
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    const allowedOrigin = getAllowedOrigin(request);
    var cors = { "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const user = await verifyAuth(request, env);
    if (!user) return new Response(JSON.stringify({ error: "인증이 필요합니다" }), { status: 401, headers: cors });

    // POST /recommend — LLM 하이라이트 추천
    if (url.pathname === "/recommend" && request.method === "POST") {
      try {
        var body = await request.json();
        if (!body.script) return Response.json({ success: false, error: "script required" }, { headers: cors });
        var apiKey = env.OPENAI_API_KEY;
        if (!apiKey) return Response.json({ success: false, error: "OPENAI_API_KEY not configured" }, { headers: cors, status: 500 });

        var res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4.1",
            messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: compressScript(body.script, 14000) }],
            temperature: 0.5, max_tokens: 2000,
          }),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error.message);
        var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
        var jm = content.match(/\{[\s\S]*\}/);
        if (!jm) throw new Error("JSON parse failed");
        return Response.json({ success: true, result: JSON.parse(jm[0]) }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    // POST /save — 최종 저장 (TTL 365일)
    if (url.pathname === "/save" && request.method === "POST") {
      try {
        if (!env.SESSIONS) return Response.json({ success: false, error: "KV not configured" }, { headers: cors, status: 500 });
        var body = await request.json();
        var id = body.id || generateId();
        await env.SESSIONS.put("save_" + id, JSON.stringify(body.session), { expirationTtl: 60 * 60 * 24 * 365 });
        return Response.json({ success: true, id: id }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    // POST /autosave — 자동 저장 (TTL 7일)
    if (url.pathname === "/autosave" && request.method === "POST") {
      try {
        if (!env.SESSIONS) return Response.json({ success: false, error: "KV not configured" }, { headers: cors, status: 500 });
        var body = await request.json();
        var id = body.id || generateId();
        await env.SESSIONS.put("auto_" + id, JSON.stringify(body.session), { expirationTtl: 60 * 60 * 24 * 7 });
        return Response.json({ success: true, id: id }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    // GET /load?id=xxx — KV에서 세션 로드 (save_ 우선, auto_ 폴백)
    if (url.pathname === "/load" && request.method === "GET") {
      try {
        if (!env.SESSIONS) return Response.json({ success: false, error: "KV not configured" }, { headers: cors, status: 500 });
        var id = url.searchParams.get("id");
        if (!id) return Response.json({ success: false, error: "id required" }, { headers: cors });
        var data = await env.SESSIONS.get("save_" + id);
        if (!data) data = await env.SESSIONS.get("auto_" + id);
        if (!data) return Response.json({ success: false, error: "session not found" }, { headers: cors });
        return Response.json({ success: true, session: JSON.parse(data) }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    // POST /timestamps — 유튜브 타임스탬프 생성
    if (url.pathname === "/timestamps" && request.method === "POST") {
      try {
        var body = await request.json();
        if (!body.script) return Response.json({ success: false, error: "script required" }, { headers: cors });
        var apiKey = env.OPENAI_API_KEY;
        if (!apiKey) return Response.json({ success: false, error: "OPENAI_API_KEY not configured" }, { headers: cors, status: 500 });

        var tsPrompt = `당신은 유튜브 인터뷰 영상의 챕터(타임스탬프)를 생성하는 전문가입니다.

## 작업
인터뷰 원고를 읽고, 유튜브 영상 설명란에 넣을 타임스탬프(챕터)를 생성합니다.

## 핵심 규칙
1. 토픽이 전환되는 지점을 찾아서 5~10개의 챕터로 나누기
2. 각 챕터의 제목은 시청자가 검색할 만한 구체적이고 흥미로운 문구 (SEO 최적화)
3. "인트로", "아웃트로", "마무리" 같은 일반적인 제목 대신 내용을 반영한 제목 사용
4. 각 챕터 전환점이 원고 어디에 있는지 "해당 구간의 첫 문장"을 anchor_text로 제공

## 중요
- 원고의 화자 타임스탬프는 편집 전 원본 시간이므로 무시하세요
- 최종 영상 시간은 별도로 계산됩니다
- 당신은 오직 "토픽 전환점"과 "소제목"만 잡아주면 됩니다

## 출력 형식 (JSON만 출력)
{
  "chapters": [
    {
      "title": "챕터 제목 (검색 최적화된 구체적 문구)",
      "anchor_text": "이 챕터가 시작되는 원고의 첫 문장 또는 핵심 구절 (정확히 발췌)",
      "summary": "이 구간에서 다루는 내용 한 줄 요약"
    }
  ],
  "video_title_suggestion": "영상 전체를 아우르는 제목 제안 (선택)"
}

## 규칙
- 첫 번째 챕터는 영상 시작 부분 (인트로 대신 내용 반영 제목)
- 5~10개 챕터 생성
- anchor_text는 원고에서 정확히 발췌 (수정하지 말 것)
- 챕터 제목은 15자 이내로 간결하게`;

        var res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4.1",
            messages: [{ role: "system", content: tsPrompt }, { role: "user", content: compressScript(body.script, 14000) }],
            temperature: 0.4, max_tokens: 2000,
          }),
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error.message);
        var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
        var jm = content.match(/\{[\s\S]*\}/);
        if (!jm) throw new Error("JSON parse failed");
        return Response.json({ success: true, result: JSON.parse(jm[0]) }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    return new Response("Highlight Generator v2", { headers: cors });
  },
};

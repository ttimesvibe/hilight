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

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

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

    // POST /save — KV에 세션 저장
    if (url.pathname === "/save" && request.method === "POST") {
      try {
        if (!env.SESSIONS) return Response.json({ success: false, error: "KV not configured" }, { headers: cors, status: 500 });
        var body = await request.json();
        var id = body.id || generateId();
        await env.SESSIONS.put("hl_" + id, JSON.stringify(body.session), { expirationTtl: 60 * 60 * 24 * 30 }); // 30일
        return Response.json({ success: true, id: id }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    // GET /load?id=xxx — KV에서 세션 로드
    if (url.pathname === "/load" && request.method === "GET") {
      try {
        if (!env.SESSIONS) return Response.json({ success: false, error: "KV not configured" }, { headers: cors, status: 500 });
        var id = url.searchParams.get("id");
        if (!id) return Response.json({ success: false, error: "id required" }, { headers: cors });
        var data = await env.SESSIONS.get("hl_" + id);
        if (!data) return Response.json({ success: false, error: "session not found" }, { headers: cors });
        return Response.json({ success: true, session: JSON.parse(data) }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors, status: 500 });
      }
    }

    return new Response("Highlight Generator v2", { headers: cors });
  },
};

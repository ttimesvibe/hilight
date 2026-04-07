import { useState, useCallback, useRef, useEffect } from "react";
import * as mammoth from "mammoth";

const WORKER_URL = "https://hilight.ttimes.workers.dev";
const FN = "'Pretendard Variable','Pretendard','Noto Sans KR',-apple-system,sans-serif";
const C = {
  bg:"#F5F6FA",sf:"#FFFFFF",bd:"#D8DBE5",tx:"#1A1D2E",txM:"#5C6078",txD:"#8B8FA3",
  ac:"#0891B2",acS:"rgba(8,145,178,0.08)",
  hl:"#00E5FF",hlBg:"rgba(0,229,255,0.18)",hlBd:"rgba(0,229,255,0.4)",
  ok:"#16A34A",okBg:"rgba(22,163,74,0.08)",
  wn:"#D97706",wnBg:"rgba(217,119,6,0.06)",wnBd:"rgba(217,119,6,0.15)",
  host:"rgba(0,0,0,0.02)",hostBd:"rgba(0,0,0,0.06)",
  inputBg:"rgba(0,0,0,0.03)",glass:"rgba(0,0,0,0.02)",glass2:"rgba(0,0,0,0.04)",
  btnTx:"#fff",gradHl:"linear-gradient(135deg,#0891B2,#06B6D4)",
};
const CPS = 9.0; // ttimes 학습 데이터 기준 542.7자/분

export default function App() {
  const [fn, setFn] = useState("");
  const [script, setScript] = useState("");
  const [blocks, setBlocks] = useState([]);
  const [clips, setClips] = useState([]);
  const [recs, setRecs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showRecs, setShowRecs] = useState(true);
  const [shareUrl, setShareUrl] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [timestamps, setTimestamps] = useState(null); // LLM 생성 챕터
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [tsLoading, setTsLoading] = useState(false);
  const [tsCopied, setTsCopied] = useState(false);

  // URL에서 세션 로드
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("s");
    if (sid) {
      setSessionId(sid);
      fetch(WORKER_URL + "/load?id=" + sid)
        .then(r => r.json())
        .then(data => {
          if (data.success && data.session) {
            setFn(data.session.filename || "");
            setScript(data.session.script || "");
            setBlocks(data.session.blocks || []);
            setClips(data.session.clips || []);
            setRecs(data.session.recs || []);
          }
        }).catch(() => {});
    }
  }, []);

  const parseScript = (text) => {
    const lines = text.split("\n").filter(l => l.trim());
    const result = [];
    let id = 0;
    const speakerRe = /^([가-힣a-zA-Z]+)\s+(\d{1,2}:\d{2}(?::\d{2})?)/;
    let current = null;
    for (const line of lines) {
      const m = line.match(speakerRe);
      if (m) {
        if (current) result.push(current);
        current = { speaker: m[1], time: m[2], text: line.substring(m[0].length).trim(), id: id++ };
      } else if (current) {
        current.text += " " + line.trim();
      }
    }
    if (current) result.push(current);
    return result;
  };

  const processFile = useCallback(async (file) => {
    if (!file) return;
    setFn(file.name); setErr(null); setClips([]); setRecs([]); setShareUrl(null); setSessionId(null);
    try {
      let text;
      if (file.name.endsWith(".docx")) {
        const buf = await file.arrayBuffer();
        text = (await mammoth.extractRawText({ arrayBuffer: buf })).value;
      } else { text = await file.text(); }
      setScript(text);
      setBlocks(parseScript(text));
    } catch (e) { setErr("파일 읽기 실패: " + e.message); }
  }, []);

  const getRecommendations = useCallback(async () => {
    if (!script) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch(WORKER_URL + "/recommend", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setRecs(data.result.candidates || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [script]);

  // 최종 저장 (TTL 1년)
  const saveSession = useCallback(async () => {
    setSaving(true);
    try {
      const session = { filename: fn, script, blocks, clips, recs, savedAt: new Date().toISOString() };
      const res = await fetch(WORKER_URL + "/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, session }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setSessionId(data.id);
      const url = window.location.origin + window.location.pathname + "?s=" + data.id;
      setShareUrl(url);
      window.history.replaceState(null, "", "?s=" + data.id);
      setLastSavedClips(JSON.stringify(clips));
    } catch (e) { setErr("저장 실패: " + e.message); }
    finally { setSaving(false); }
  }, [fn, script, blocks, clips, recs, sessionId]);

  // 자동 저장 (TTL 7일) — 변경 감지 + 3분 디바운스
  const [lastSavedClips, setLastSavedClips] = useState("");
  const [autoSaveStatus, setAutoSaveStatus] = useState(""); // "", "pending", "saving", "saved"
  const autoSaveTimer = useRef(null);

  useEffect(() => {
    // clips가 변경됐고, 이전 저장 상태와 다르면 3분 타이머 시작
    if (!script || clips.length === 0) return;
    const currentState = JSON.stringify(clips);
    if (currentState === lastSavedClips) return; // 변경 없음

    setAutoSaveStatus("pending");
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);

    autoSaveTimer.current = setTimeout(async () => {
      setAutoSaveStatus("saving");
      try {
        const session = { filename: fn, script, blocks, clips, recs, savedAt: new Date().toISOString() };
        const id = sessionId || (Date.now().toString(36) + Math.random().toString(36).substring(2, 8));
        const res = await fetch(WORKER_URL + "/autosave", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, session }),
        });
        const data = await res.json();
        if (data.success) {
          if (!sessionId) {
            setSessionId(data.id);
            window.history.replaceState(null, "", "?s=" + data.id);
          }
          setLastSavedClips(JSON.stringify(clips));
          setAutoSaveStatus("saved");
          setTimeout(() => setAutoSaveStatus(""), 3000);
        }
      } catch (e) {
        setAutoSaveStatus("");
      }
    }, 3 * 60 * 1000); // 3분

    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [clips, script, fn, blocks, recs, sessionId, lastSavedClips]);

  // 공유 URL 복사
  const copyShareUrl = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleTextSelect = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const text = sel.toString().trim();
    if (text.length < 3) return;
    if (clips.some(c => c.originalText === text)) return;
    // Find which block the selection is in
    let blockId = null;
    let node = sel.anchorNode;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.blockid !== undefined) { blockId = parseInt(node.dataset.blockid); break; }
      node = node.parentNode;
    }
    setClips(prev => [...prev, { id: Date.now() + Math.random(), text, originalText: text, blockId, seconds: Math.round(text.length / CPS) }]);
    sel.removeAllRanges();
  }, [clips]);

  const addFromRec = (rec) => {
    if (clips.some(c => c.originalText === rec.text || c.text === rec.text)) return;
    // Find blockId using robust matching
    let blockId = null;
    for (const b of blocks) {
      if (findBestMatch(b.text, rec.text)) { blockId = b.id; break; }
    }
    setClips(prev => [...prev, { id: Date.now() + Math.random(), text: rec.text, originalText: rec.text, blockId, seconds: Math.round(rec.text.length / CPS), reason: rec.reason }]);
    // Scroll to the matching block in the left panel
    const targetId = blockId !== null ? blockId : (() => {
      for (const b of blocks) { if (findBestMatch(b.text, rec.text)) return b.id; }
      return null;
    })();
    if (targetId !== null) {
      setTimeout(() => {
        const el = document.querySelector(`[data-blockid="${targetId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.style.transition = "box-shadow 0.3s";
          el.style.boxShadow = `0 0 0 2px ${C.ac}`;
          setTimeout(() => { el.style.boxShadow = ""; }, 1500);
        }
      }, 50);
    }
  };

  const removeClip = (id) => setClips(prev => prev.filter(c => c.id !== id));

  const handleDragStart = (idx) => setDragIdx(idx);
  const handleDragOver = (e, idx) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    setClips(prev => { const next = [...prev]; const [m] = next.splice(dragIdx, 1); next.splice(idx, 0, m); return next; });
    setDragIdx(idx);
  };
  const handleDragEnd = () => setDragIdx(null);

  const totalSeconds = clips.reduce((s, c) => s + (c.seconds || Math.round(c.text.length / CPS)), 0);

  const copyAll = () => {
    const text = clips.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  // Find best matching position of clipText within blockText, tolerating LLM variations
  const findBestMatch = (blockText, clipText) => {
    // 1) Exact match
    let idx = blockText.indexOf(clipText);
    if (idx >= 0) return { start: idx, end: idx + clipText.length, exact: true };
    // 2) Try progressively shorter substrings from the clip (sliding window)
    // Use chunks of 20+ chars from the clip to find the block region
    const minChunk = 3;
    if (clipText.length < minChunk) return null;
    // Try to find the longest matching substring
    let bestStart = -1, bestEnd = -1, bestLen = 0;
    // Check first half and second half anchors
    for (let len = Math.min(clipText.length, 40); len >= minChunk; len -= 5) {
      // Try from start of clip
      const headChunk = clipText.substring(0, len);
      const hIdx = blockText.indexOf(headChunk);
      if (hIdx >= 0 && len > bestLen) {
        // Found start anchor — now find end anchor
        const tailChunk = clipText.slice(-Math.min(len, 30));
        const tIdx = blockText.indexOf(tailChunk, hIdx);
        if (tIdx >= 0) {
          bestStart = hIdx;
          bestEnd = tIdx + tailChunk.length;
          bestLen = bestEnd - bestStart;
          break;
        } else {
          // End anchor not found, use estimated end
          bestStart = hIdx;
          bestEnd = Math.min(hIdx + clipText.length + 10, blockText.length);
          bestLen = len;
        }
      }
    }
    if (bestStart >= 0 && bestLen >= minChunk) return { start: bestStart, end: bestEnd, exact: false };
    // 3) Try from end of clip
    for (let len = Math.min(clipText.length, 40); len >= minChunk; len -= 5) {
      const tailChunk = clipText.slice(-len);
      const tIdx = blockText.indexOf(tailChunk);
      if (tIdx >= 0) {
        const estimatedStart = Math.max(0, tIdx - clipText.length + len);
        return { start: estimatedStart, end: tIdx + tailChunk.length, exact: false };
      }
    }
    return null;
  };

  const renderBlock = (block) => {
    let html = block.text;
    for (const clip of clips) {
      if (clip.blockId !== null && clip.blockId !== undefined && clip.blockId !== block.id) continue;
      const matchText = clip.originalText || clip.text;
      const match = findBestMatch(html, matchText);
      if (match) {
        // Don't highlight inside existing <mark> tags
        const before = html.substring(0, match.start);
        if (before.lastIndexOf("<mark") > before.lastIndexOf("</mark>")) continue;
        const snippet = html.substring(match.start, match.end);
        html = before + `<mark style="background:${C.hlBg};border-bottom:2px solid ${C.hl};padding:1px 0">${snippet}</mark>` + html.substring(match.end);
      }
    }
    if (showRecs) {
      for (const rec of recs) {
        if (clips.some(c => (c.originalText || c.text) === rec.text)) continue;
        const idx = html.indexOf(rec.text);
        if (idx >= 0 && !html.substring(Math.max(0, idx - 50), idx).includes("<mark")) {
          html = html.substring(0, idx) + `<span style="background:${C.wnBg};border-bottom:1px dashed ${C.wn};padding:1px 0;cursor:pointer" title="💡 AI 추천: ${rec.reason}">${rec.text}</span>` + html.substring(idx + rec.text.length);
        }
      }
    }
    return html;
  };

  const reset = () => { setFn(""); setScript(""); setBlocks([]); setClips([]); setRecs([]); setErr(null); setShareUrl(null); setSessionId(null); setTimestamps(null); window.history.replaceState(null, "", window.location.pathname); };

  // 영상 길이 예측 (선형회귀: 영상길이(분) = 0.001210 × 글자수 + 7.05)
  const SLOPE = 0.001210;
  const INTERCEPT = 7.05;
  const predictMinutes = (totalChars) => SLOPE * totalChars + INTERCEPT;

  // 타임스탬프 생성
  const generateTimestamps = useCallback(async () => {
    if (!script) return;
    setTsLoading(true); setErr(null);
    try {
      const res = await fetch(WORKER_URL + "/timestamps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const chapters = data.result.chapters || [];
      // 전체 원고 글자수 기반 영상 길이 예측
      const totalChars = blocks.reduce((s, b) => s + b.text.length, 0);
      const totalMin = predictMinutes(totalChars);
      // 각 챕터의 원고 내 위치를 찾아서 시간 배분
      const fullText = blocks.map(b => b.text).join(" ");
      const withTimes = chapters.map((ch, i) => {
        let charPos = 0;
        if (i === 0) {
          charPos = 0; // 첫 챕터는 항상 0:00
        } else {
          // anchor_text로 원고 내 위치 찾기
          const match = findBestMatch(fullText, ch.anchor_text || "");
          if (match) {
            charPos = match.start;
          } else {
            // 폴백: 균등 분배
            charPos = Math.round((i / chapters.length) * fullText.length);
          }
        }
        const ratio = charPos / fullText.length;
        const timeMin = ratio * totalMin;
        const mm = Math.floor(timeMin);
        const ss = Math.round((timeMin - mm) * 60);
        return { ...ch, time: `${mm}:${ss.toString().padStart(2, "0")}`, ratio, charPos };
      });
      setTimestamps(withTimes);
      setShowTimestamps(true);
    } catch (e) { setErr("타임스탬프 생성 실패: " + e.message); }
    finally { setTsLoading(false); }
  }, [script, blocks]);

  const copyTimestamps = () => {
    if (!timestamps) return;
    const text = timestamps.map(t => `${t.time} ${t.title}`).join("\n");
    navigator.clipboard.writeText(text);
    setTsCopied(true); setTimeout(() => setTsCopied(false), 2000);
  };

  const getTimeColor = () => {
    if (totalSeconds >= 30 && totalSeconds <= 40) return C.ok;
    if (totalSeconds > 40) return "#DC2626";
    return C.txD;
  };

  return <div style={{fontFamily:FN,background:C.bg,minHeight:"100vh",color:C.tx}}>
    {/* Header */}
    <div style={{background:C.sf,borderBottom:"1px solid "+C.bd,padding:"14px 20px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <div style={{fontSize:16,fontWeight:800,color:C.ac}}>✂️ 하이라이트 편집기</div>
      {fn && <span style={{fontSize:12,color:C.txM,background:C.glass2,padding:"3px 10px",borderRadius:6}}>{fn}</span>}
      {clips.length > 0 && <span style={{fontSize:12,fontWeight:700,color:getTimeColor(),background:totalSeconds>=30&&totalSeconds<=40?C.okBg:"transparent",padding:"3px 10px",borderRadius:6}}>
        {totalSeconds}초 / 30~40초
      </span>}
      {autoSaveStatus && <span style={{fontSize:11,color:autoSaveStatus==="saved"?C.ok:C.txD,padding:"3px 8px",borderRadius:6,background:autoSaveStatus==="saved"?C.okBg:C.glass2}}>
        {autoSaveStatus==="pending"?"⏳ 자동 저장 대기":autoSaveStatus==="saving"?"💾 자동 저장 중...":"✓ 자동 저장됨"}
      </span>}
      <div style={{marginLeft:"auto",display:"flex",gap:8}}>
        {blocks.length > 0 && <button onClick={generateTimestamps} disabled={tsLoading}
          style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"1px solid #8B5CF6",background:tsLoading?"#999":"rgba(139,92,246,0.08)",color:tsLoading?"#fff":"#8B5CF6",fontWeight:600,cursor:"pointer"}}>
          {tsLoading ? "생성 중..." : "📌 타임스탬프"}</button>}
        {clips.length > 0 && <>
          <button onClick={saveSession} disabled={saving}
            style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"none",background:saving?"#999":C.ac,color:C.btnTx,fontWeight:600,cursor:"pointer"}}>
            {saving ? "저장 중..." : shareUrl ? "💾 다시 저장" : "💾 저장"}</button>
          {shareUrl && <button onClick={copyShareUrl}
            style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"1px solid "+C.ac,background:copied?C.ac:C.sf,color:copied?C.btnTx:C.ac,fontWeight:600,cursor:"pointer"}}>
            {copied ? "✓ 복사됨" : "🔗 공유"}</button>}
          <button onClick={copyAll}
            style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"1px solid "+C.bd,background:C.sf,color:C.txM,cursor:"pointer"}}>
            📋 텍스트 복사</button>
        </>}
        {fn && <button onClick={reset} style={{fontSize:12,padding:"5px 14px",borderRadius:6,border:"1px solid "+C.bd,background:C.sf,color:C.txM,cursor:"pointer"}}>× 새 파일</button>}
      </div>
    </div>

    {/* Upload */}
    {!script && !loading && <div style={{maxWidth:560,margin:"80px auto",padding:"0 24px"}}>
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{fontSize:48,marginBottom:16}}>✂️</div>
        <h1 style={{fontSize:24,fontWeight:700,marginBottom:8}}>하이라이트 편집기</h1>
        <p style={{fontSize:14,color:C.txM,lineHeight:1.7}}>인터뷰 원고에서 하이라이트 구간을 선택하고<br/>순서를 조정하여 30~40초 하이라이트를 만듭니다.</p>
      </div>
      <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{e.preventDefault();setDragOver(false);processFile(e.dataTransfer.files[0])}}
        style={{border:"2px dashed "+(dragOver?C.ac:C.bd),borderRadius:16,padding:"48px 32px",textAlign:"center",background:dragOver?C.acS:C.sf,cursor:"pointer"}}
        onClick={()=>document.getElementById("fi").click()}>
        <div style={{fontSize:32,marginBottom:12,opacity:0.5}}>📄</div>
        <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>원고 파일 업로드</div>
        <div style={{fontSize:12,color:C.txD}}>.docx 또는 .txt</div>
        <input id="fi" type="file" accept=".docx,.txt" onChange={e=>processFile(e.target.files[0])} style={{display:"none"}}/>
      </div>
    </div>}

    {/* Main Editor */}
    {blocks.length > 0 && <div style={{display:"flex",height:"calc(100vh - 53px)",overflow:"hidden"}}>
      {/* Left: Script */}
      <div style={{flex:1,overflowY:"auto",padding:"16px 20px",borderRight:"1px solid "+C.bd}} onMouseUp={handleTextSelect}>
        {recs.length === 0 && <div style={{marginBottom:16,display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={getRecommendations} disabled={loading}
            style={{padding:"8px 18px",borderRadius:8,border:"none",background:C.gradHl,color:C.btnTx,fontSize:13,fontWeight:600,cursor:loading?"wait":"pointer",opacity:loading?0.6:1}}>
            {loading ? "⏳ AI 분석 중..." : "💡 AI 하이라이트 추천"}</button>
          <span style={{fontSize:12,color:C.txD}}>원고를 드래그하여 직접 선택할 수도 있습니다</span>
        </div>}

        {recs.length > 0 && <div style={{marginBottom:16,display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={()=>setShowRecs(!showRecs)}
            style={{padding:"5px 12px",borderRadius:6,border:"1px solid "+C.wnBd,background:C.wnBg,color:C.wn,fontSize:12,fontWeight:600,cursor:"pointer"}}>
            {showRecs ? "💡 AI 추천 숨기기" : "💡 AI 추천 표시"}</button>
          <span style={{fontSize:12,color:C.txD}}>
            <span style={{color:C.hl}}>■</span> 선택됨
            {showRecs && <> &nbsp;<span style={{color:C.wn}}>┅</span> AI 추천</>}
          </span>
        </div>}

        {err && <div style={{marginBottom:12,padding:"10px 14px",borderRadius:8,background:"rgba(220,38,38,0.08)",color:"#DC2626",fontSize:13}}>⚠️ {err}</div>}

        {blocks.map(block => {
          const isHost = ["홍재의"].includes(block.speaker);
          return <div key={block.id} data-blockid={block.id} style={{marginBottom:12,padding:"8px 12px",borderRadius:8,
            background:isHost?C.host:C.sf,border:"1px solid "+(isHost?C.hostBd:C.bd)}}>
            <div style={{fontSize:11,color:isHost?C.txD:C.txM,marginBottom:4,fontWeight:600}}>
              {block.speaker} <span style={{fontWeight:400}}>{block.time}</span>
            </div>
            <div style={{fontSize:14,lineHeight:1.8,color:isHost?C.txM:C.tx}}
              dangerouslySetInnerHTML={{__html: renderBlock(block)}}/>
          </div>;
        })}
      </div>

      {/* Right: Clip Panel */}
      <div style={{width:360,flexShrink:0,overflowY:"auto",background:C.sf,padding:"16px 16px"}}>
        {/* Timestamp Section */}
        {timestamps && <div style={{marginBottom:20,borderRadius:10,border:"1px solid rgba(139,92,246,0.3)",background:"rgba(139,92,246,0.04)",overflow:"hidden"}}>
          <div style={{padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:showTimestamps?"1px solid rgba(139,92,246,0.15)":"none"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#8B5CF6"}}>📌 타임스탬프 ({timestamps.length}개)</div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={copyTimestamps}
                style={{fontSize:11,padding:"3px 10px",borderRadius:5,border:"1px solid rgba(139,92,246,0.3)",background:tsCopied?"#8B5CF6":"transparent",color:tsCopied?"#fff":"#8B5CF6",cursor:"pointer",fontWeight:600}}>
                {tsCopied ? "✓ 복사됨" : "📋 복사"}</button>
              <button onClick={()=>setShowTimestamps(!showTimestamps)}
                style={{fontSize:11,padding:"3px 8px",borderRadius:5,border:"1px solid rgba(139,92,246,0.2)",background:"transparent",color:"#8B5CF6",cursor:"pointer"}}>
                {showTimestamps ? "▲" : "▼"}</button>
            </div>
          </div>
          {showTimestamps && <div style={{padding:"8px 14px 12px"}}>
            {timestamps.map((t, i) => <div key={i} style={{padding:"6px 0",borderBottom:i<timestamps.length-1?"1px solid rgba(139,92,246,0.08)":"none",display:"flex",gap:10,alignItems:"flex-start"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#8B5CF6",flexShrink:0,fontVariantNumeric:"tabular-nums",minWidth:36}}>{t.time}</span>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:C.tx,lineHeight:1.5}}>{t.title}</div>
                {t.summary && <div style={{fontSize:11,color:C.txD,marginTop:2,lineHeight:1.4}}>{t.summary}</div>}
              </div>
            </div>)}
            <div style={{marginTop:10,padding:"8px 10px",borderRadius:6,background:"rgba(139,92,246,0.06)",fontSize:11,color:C.txD,lineHeight:1.5}}>
              ⏱ 예상 영상 길이: <strong style={{color:"#8B5CF6"}}>{Math.floor(predictMinutes(blocks.reduce((s,b)=>s+b.text.length,0)))}분 {Math.round((predictMinutes(blocks.reduce((s,b)=>s+b.text.length,0)) % 1) * 60)}초</strong>
              <span style={{marginLeft:4,fontSize:10,color:C.txD}}>(오차 ±3%)</span>
            </div>
          </div>}
        </div>}

        <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>✂️ 하이라이트 구성</div>
        <div style={{fontSize:12,color:C.txD,marginBottom:12}}>
          {clips.length}개 클립 · <span style={{fontWeight:700,color:getTimeColor()}}>{totalSeconds}초</span> / 30~40초
        </div>

        <div style={{height:6,background:C.bd,borderRadius:3,marginBottom:16,overflow:"hidden",position:"relative"}}>
          <div style={{height:"100%",borderRadius:3,transition:"width 0.3s",
            width:Math.min(totalSeconds/40*100,100)+"%",
            background:totalSeconds>40?"#DC2626":totalSeconds>=30?C.ok:C.ac}}/>
          <div style={{position:"absolute",left:"75%",top:0,width:1,height:"100%",background:C.txD,opacity:0.4}}/>
        </div>

        {clips.length === 0 && <div style={{textAlign:"center",padding:"40px 16px",color:C.txD,fontSize:13}}>
          왼쪽 원고에서 텍스트를 드래그하여<br/>하이라이트 구간을 추가하세요.
        </div>}

        {clips.map((clip, idx) => <div key={clip.id} draggable
          onDragStart={()=>handleDragStart(idx)}
          onDragOver={e=>handleDragOver(e,idx)}
          onDragEnd={handleDragEnd}
          style={{padding:"10px 12px",marginBottom:8,borderRadius:8,border:"1px solid "+C.hlBd,
            background:C.hlBg,cursor:"grab",opacity:dragIdx===idx?0.5:1}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
            <span style={{fontSize:11,color:C.ac,fontWeight:800,flexShrink:0,marginTop:8,cursor:"grab"}}>{idx+1}</span>
            <div style={{flex:1,minWidth:0}}>
              <textarea value={clip.text}
                onMouseDown={e=>e.stopPropagation()}
                onDragStart={e=>e.stopPropagation()}
                onChange={e=>{const v=e.target.value;setClips(prev=>prev.map(c=>c.id===clip.id?{...c,text:v,seconds:Math.round(v.length/CPS)}:c))}}
                style={{fontSize:13,lineHeight:1.6,color:C.tx,width:"100%",border:"1px solid transparent",
                  background:"rgba(255,255,255,0.5)",borderRadius:4,resize:"none",outline:"none",fontFamily:FN,
                  padding:"4px 6px",cursor:"text"}}
                onFocus={e=>{e.target.style.borderColor=C.ac;e.target.style.background="#fff"}}
                onBlur={e=>{e.target.style.borderColor="transparent";e.target.style.background="rgba(255,255,255,0.5)"}}
                rows={Math.max(2,Math.ceil(clip.text.length/28))}/>
              <div style={{fontSize:11,color:C.txD,marginTop:4}}>~{clip.seconds || Math.round(clip.text.length/CPS)}초</div>
            </div>
            <button onClick={()=>removeClip(clip.id)}
              style={{fontSize:14,color:C.txD,background:"none",border:"none",cursor:"pointer",flexShrink:0,padding:"0 4px"}}>×</button>
          </div>
        </div>)}

        {recs.length > 0 && <div style={{marginTop:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.wn,marginBottom:8}}>
            💡 AI 추천 ({recs.filter(r=>!clips.some(c=>c.text===r.text)).length}개 남음)
          </div>
          {recs.filter(r => !clips.some(c => c.text === r.text)).map((rec, i) => <div key={i}
            onClick={() => addFromRec(rec)}
            style={{padding:"8px 10px",marginBottom:6,borderRadius:8,border:"1px solid "+C.wnBd,
              background:C.wnBg,cursor:"pointer"}}>
            <div style={{fontSize:12,lineHeight:1.6,color:C.tx}}>{rec.text}</div>
            <div style={{fontSize:11,color:C.wn,marginTop:4}}>
              {rec.impact === "high" ? "⭐" : "○"} {rec.reason} · ~{rec.estimated_seconds || Math.round(rec.text.length/CPS)}초
            </div>
          </div>)}
        </div>}
      </div>
    </div>}
  </div>;
}

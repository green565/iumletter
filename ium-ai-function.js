/* 이움 AI — 실제 AI 연동용 서버 함수 예시 (Netlify Functions 형식)
 *
 * ※ 이 파일은 예시이며 기본 배포에는 포함되어 동작하지 않습니다. (docs 폴더는 배포 기능으로 인식되지 않음)
 * 사용하려면:
 *   1) 이 파일을 netlify/functions/ium-ai.js 로 옮깁니다.
 *   2) Netlify 사이트 설정 → Environment variables 에 ANTHROPIC_API_KEY 를 등록합니다. (키는 절대 프런트엔드 코드에 넣지 마세요)
 *   3) netlify.toml 의 SPA 대체 규칙보다 위에 아래 규칙을 추가합니다.
 *        [[redirects]]
 *          from = "/api/ium-ai"
 *          to = "/.netlify/functions/ium-ai"
 *          status = 200
 *   4) app/ium-ai.js 의 config.mode 를 'remote' 로 바꿉니다.
 *
 * 서버는 app/ium-ai.js 상단에 적힌 '응답 형식'(text · proposals · suggestions)을 그대로 돌려주면 됩니다.
 * 프런트엔드는 받은 응답을 IumAI.sanitizeResponse()로 검증한 뒤 편집기의 같은 명령 실행 코드(runCmds)로 적용합니다.
 */
const SYSTEM = `너는 모바일 청첩장 서비스 '이움레터'의 편집 도우미 '이움 AI'다.
반드시 JSON 하나만 출력한다. 형식:
{"text": "사용자에게 보여줄 답변",
 "proposals": [ ...아래 중 필요한 것만... ],
 "suggestions": [{"label": "짧은 버튼 문구", "text": "보낼 문장"}]}
proposal 종류:
- {"type":"text","kind":"invite|thanks|transport|rsvp|account|custom","title":"...","text":"적용할 문구","target":"inviteText|thanks.text|transport.car|transport.subway|transport.bus|transport.shuttle|rsvpDesc|accountIntro|custom:<섹션id>:desc"}
- {"type":"section","title":"...","note":"...","after":"<기존 섹션 id 또는 빈 문자열>","section":{"layout":"text|cards|timeline|imagetext|list|buttons","title":"...","desc":"...","items":[{"time":"","title":"","desc":"","icon":""}],"buttons":[{"label":"","url":""}]}}
- {"type":"changes","title":"변경 예정 사항","rows":["사람이 읽을 변경 내용"],"cmds":[{"type":"setOrder","order":["섹션 id 전체 순서"]},{"type":"setVisible","id":"...","on":true}]}
- {"type":"check","issues":[{"label":"...","detail":"...","sec":"섹션 id"}],"ok":["입력된 항목"]}
- {"type":"compare","title":"...","rows":[{"target":"inviteText","label":"...","before":"기존","after":"제안"}]}
규칙: 사용자가 말하지 않은 사실(주소, 시간, 금액 등)을 지어내지 말고 [ ] 자리표시로 남긴다. HTML이나 코드를 만들지 않는다.
context로 주어진 현재 청첩장 데이터만 근거로 점검한다.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ text: 'AI 서버 키가 설정되지 않았어요.' }) };
  let req = {};
  try { req = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Bad Request' }; }
  // v10: 청첩장 'AI로 만들기'(정보 정리)와 'AI로 다듬기'(문구) 요청
  if (req.task === 'extractWedding' || req.task === 'polish') return weddingTask(req, key);
  const history = (Array.isArray(req.history) ? req.history : []).slice(-8).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 2000) }));
  const messages = history.concat([{ role: 'user', content: 'context: ' + JSON.stringify(req.context || {}).slice(0, 12000) + '\n\n요청: ' + String(req.message || '').slice(0, 1000) }]);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.IUM_AI_MODEL || 'claude-sonnet-4-5', max_tokens: 1500, system: SYSTEM, messages })
    });
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    const out = m ? JSON.parse(m[0]) : { text: text };
    out.source = 'remote';
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ text: 'AI 응답을 받지 못했어요.' }) };
  }
};

/* ---------- v10: 청첩장 정보 정리 · 문구 다듬기 ----------
 * extractWedding: { text, images:[dataURL] } → { f:{groom,bride,date(YYYY-MM-DD),time(HH:MM),venue,floor,hall,address,groomFather,groomMother,groomRel,brideFather,brideMother,brideRel,car,subway,bus,shuttle,extra}, flags:{필드:true}, notes:[] }
 * polish: { kind, text, request } → { text, note }
 */
const EXTRACT_SYS = `너는 모바일 청첩장 정보 정리 도우미다. 사용자가 준 글과 종이청첩장 사진에서 '적혀 있는 정보만' 찾아 JSON 하나로만 답한다.
형식: {"f":{"groom":"","bride":"","date":"YYYY-MM-DD","time":"HH:MM","venue":"","floor":"","hall":"","address":"","groomFather":"","groomMother":"","groomRel":"","brideFather":"","brideMother":"","brideRel":"","car":"","subway":"","bus":"","shuttle":"","extra":""},"flags":{},"notes":[]}
규칙: 없거나 읽을 수 없는 값은 빈 문자열로 둔다. 추측하지 않는다. 연도·오전/오후처럼 모호한 값을 해석했다면 flags에 그 필드를 true로, notes에 이유를 쓴다. 관계(groomRel/brideRel)는 장남·차남·삼남·막내·아들 / 장녀·차녀·삼녀·막내·딸 중 하나만.`;
const POLISH_SYS = `너는 청첩장 문구를 다듬는 도우미다. 사용자의 요청 분위기에 맞게 문장 표현만 고쳐 JSON {"text":"","note":""} 하나로만 답한다.
규칙: 날짜·시간·장소·이름·금액 같은 사실 정보는 새로 넣거나 바꾸지 않는다. 원문에 없는 사실을 지어내지 않는다. 줄바꿈으로 읽기 좋게 나눈다.`;
async function weddingTask(req, key) {
  const isEx = req.task === 'extractWedding';
  const content = [];
  if (isEx) (Array.isArray(req.images) ? req.images : []).slice(0, 4).forEach((u) => {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(u || ''));
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });
  content.push({ type: 'text', text: isEx ? '입력한 글:\n' + String(req.text || '').slice(0, 4000) : '종류: ' + String(req.kind || '') + '\n요청: ' + String(req.request || '').slice(0, 300) + '\n원문:\n' + String(req.text || '').slice(0, 2000) });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.IUM_AI_MODEL || 'claude-sonnet-4-5', max_tokens: 1200, system: isEx ? EXTRACT_SYS : POLISH_SYS, messages: [{ role: 'user', content }] })
    });
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: m ? m[0] : JSON.stringify(isEx ? { f: {}, notes: ['정보를 정리하지 못했어요.'] } : { text: '' }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ text: 'AI 응답을 받지 못했어요.' }) };
  }
}

/* 이움레터 — 이움 AI (청첩장 편집 도우미)
 *
 * 구조
 *  1) 데모 응답 처리 (기본값, API 키 불필요)
 *     메시지 정규화 → 의도 분류(키워드·유사 표현 규칙) → 정보 추출 → 데모 시나리오 선택
 *     → 답변 문장 + 구조화된 제안(proposals) 반환
 *  2) 실제 AI 응답 처리 (선택)
 *     IumAI.config.mode = 'remote' 로 바꾸면 서버 엔드포인트(기본 /api/ium-ai)에 요청합니다.
 *     서버는 API 키를 보관하고, 아래와 '같은 응답 형식'을 돌려주면 됩니다. (README 참고)
 *  3) 공통 편집 명령 실행은 청첩장 편집기(svc-wedding)의 runCmds()가 담당합니다.
 *     데모든 실제 AI든 같은 명령 형식을 쓰므로 편집기를 다시 만들 필요가 없습니다.
 *
 * 응답 형식
 *  { text, proposals: [...], suggestions: [{label,text}], ctx, source: 'demo'|'remote' }
 *  proposal 종류
 *   { type:'text', kind, title, text, target, targets:[{value,label}] }      → setText 명령으로 적용
 *   { type:'section', title, note, section:{layout,title,desc,items,buttons,image}, after } → addSection
 *   { type:'changes', title, rows:[{label}], cmds:[ setOrder / setVisible ... ] }   → 승인 후 적용
 *   { type:'check', issues:[{label,detail,sec}], ok:[string] }                        → 바로 가기
 *   { type:'compare', title, rows:[{target,label,before,after}] }                    → 선택한 것만 적용
 *  편집 명령
 *   { type:'setText', target:'inviteText'|'thanks.text'|'transport.car'|...|'custom:<id>:desc', value }
 *   { type:'addSection', section:{...}, after:'<sectionId>' }
 *   { type:'setOrder', order:['cover','invite',...] }
 *   { type:'setVisible', id, on }
 *   { type:'openSection', id }   (화면 이동만, 데이터 변경 없음)
 *
 *  AI가 HTML·JavaScript를 만들어 넣는 방식은 사용하지 않습니다. 미리 정의된 레이아웃과 데이터만 다룹니다.
 */
(function () {
  'use strict';

  var config = { mode: 'demo', endpoint: '/api/ium-ai', timeoutMs: 20000 };

  /* ------------------------------------------------------------------ 공통 */
  var LAYOUTS = ['text', 'cards', 'timeline', 'imagetext', 'list', 'buttons'];
  var LAYOUT_NAMES = { text: '텍스트형', cards: '카드형', timeline: '타임라인형', imagetext: '이미지 + 텍스트형', list: '목록형', buttons: '버튼·링크형' };
  var STYLE_ADJ = { plain: '담백한', emotional: '감성적인', formal: '정중한', warm: '따뜻한', cute: '친근한' };
  var SEC_LABEL = { cover: '메인 표지', invite: '초대의 글', info: '웨딩데이', location: '오시는 길', gallery: '사진 갤러리', rsvp: 'RSVP 참석 여부', account: '마음 전하기', message: '축하 메시지(방명록)', guestphoto: '하객 사진 공유', thanks: '결혼식 후 감사 인사' };
  var TEXT_TARGETS = [
    ['inviteText', '초대의 글 본문', 'invite'],
    ['thanks.text', '감사 인사 문구', 'thanks'],
    ['transport.car', '오시는 길 · 자가용 및 주차', 'location'],
    ['transport.subway', '오시는 길 · 지하철', 'location'],
    ['transport.bus', '오시는 길 · 버스', 'location'],
    ['transport.shuttle', '오시는 길 · 셔틀버스', 'location'],
    ['rsvpDesc', 'RSVP 참석 여부 안내 문구', 'rsvp'],
    ['accountIntro', '마음 전하기 안내 문구', 'account']
  ];

  function norm(s) {
    return String(s || '').replace(/[​ ]/g, ' ').replace(/[“”"'‘’`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function has(t, re) { return re.test(t); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function sugg(label, text) { return { label: label, text: text || label }; }
  function josa(word, a, b) {
    var w = String(word || '').replace(/\([^)]*\)\s*$/, '').trim(), c = w.charCodeAt(w.length - 1);
    if (!(c >= 0xac00 && c <= 0xd7a3)) return word + a + '(' + b + ')';
    return word + ((c - 0xac00) % 28 ? a : b);
  }
  function shorten(text) { var l = String(text).split('\n').filter(function (x) { return x.trim(); }); return l.slice(0, 2).join('\n'); }

  var EXAMPLES = [
    sugg('초대 문구 (8년 연애, 담백하게)', '저희는 8년 연애 끝에 결혼해요. 담백한 초대 문구를 작성해 줘.'),
    sugg('감사 인사 작성', '결혼식에 와주신 분들께 감사 인사를 하고 싶어. 멀리서 와주신 분들도 많아.'),
    sugg('주차 · 대중교통 안내', '주차 공간이 좁아서 대중교통을 이용해 달라고 정중하게 안내하고 싶어.'),
    sugg('당일 일정 카드 3칸', '결혼식 당일 일정을 3칸으로 나눠서 보여주고 싶어.'),
    sugg('우천 시 안내 추가', '야외 결혼식이라 비가 오면 실내로 변경된다는 안내를 넣고 싶어.'),
    sugg('갤러리 위로 · 방명록 숨김', '갤러리를 위로 올리고 방명록은 숨겨 줘.'),
    sugg('빠진 정보 점검', '청첩장에서 빠진 정보가 있는지 확인해 줘.'),
    sugg('전체 문구 따뜻하게', '청첩장 문구를 전체적으로 조금 더 따뜻하게 바꿔줘.')
  ];
  var TEXT_FOLLOW = [sugg('조금 더 짧게', '조금 더 짧게 써줘.'), sugg('더 담백하게', '너무 오글거려. 담백하게 바꿔줘.'), sugg('더 정중하게', '좀 더 정중하게 써줘.'), sugg('친근하게', '친근한 느낌으로 바꿔줘.'), sugg('다른 버전', '다른 버전으로 다시 써줘.')];
  var UNSUPPORTED = '현재 데모에서는 문구 작성, 일정 안내 추가, 우천 안내 추가, 섹션 구성 변경 등을 체험하실 수 있어요.';

  /* ------------------------------------------------------------------ 정보 추출 */
  var HNUM = { '한': 1, '두': 2, '세': 3, '네': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9, '열': 10 };
  var SINO = { '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5, '육': 6, '칠': 7, '팔': 8, '구': 9, '십': 10 };
  var RE_REL = /연애|사귀|사귄|사겼|사귐|커플|연인|교제|만난\s?지|만났|만난|오래\s?만|씨씨|캠퍼스\s?커플/;

  function extract(t) {
    var f = {};
    if (RE_REL.test(t)) {
      var m = t.match(/(\d{1,2})\s*년/);
      if (m) f.years = +m[1];
      else { var h = t.match(/(십|일|이|삼|사|오|육|칠|팔|구)\s?년\s?(간|동안|째|의|이나|연애|사귀|사귄|만|넘|가까이)?/); if (h && h[2]) f.years = SINO[h[1]]; }
      var mo = t.match(/(\d{1,2})\s*개월/); if (mo) f.months = +mo[1];
      f.rel = true;
    }
    if (/오래|오랜|오랫동안|장기\s?연애|긴\s?연애|긴\s?시간|십\s?년|10년\s?넘/.test(t) || (f.years && f.years >= 3)) f.longRel = true;
    // 문구 스타일
    if (/담백|자연스럽|자연스러|오글|느끼|과하지|부담스럽지|심플|깔끔|덤덤|무난|평범하게|군더더기/.test(t)) f.style = 'plain';
    else if (/격식|정중|공손|예의|점잖|어른|품위|정식으로|예를 갖/.test(t)) f.style = 'formal';
    else if (/감성|로맨틱|낭만|시적|서정|감동/.test(t)) f.style = 'emotional';
    else if (/따뜻|따듯|다정|포근|훈훈/.test(t)) f.style = 'warm';
    else if (/귀엽|귀여운|발랄|유쾌|위트|재밌|재미있|친근|편한\s?느낌|캐주얼|가볍게|친구한테|친구들한테/.test(t)) f.style = 'cute';
    // 길이
    if (/짧게|짧은|짧았|줄여|간단|간결|한두\s?줄|한\s?줄/.test(t)) f.length = 'short';
    else if (/길게|늘려|자세히|자세하게|풍성|더\s?길/.test(t)) f.length = 'long';
    // 개수
    var c = t.match(/(\d{1,2})\s*(개|칸|단계|장|가지|카드|줄)/);
    if (c) f.count = +c[1];
    else { var hc = t.match(/(한|두|세|네|다섯|여섯)\s?(개|칸|단계|가지|장)/); if (hc) f.count = HNUM[hc[1]]; }
    if (/하나\s?더|한\s?개\s?더|한\s?칸\s?더|추가로\s?하나/.test(t)) f.countDelta = 1;
    if (/하나\s?(빼|줄|삭제)|한\s?개\s?(빼|줄)|한\s?칸\s?(빼|줄)/.test(t)) f.countDelta = -1;
    // 레이아웃 언급
    if (/타임라인|시간\s?순|흐름/.test(t)) f.layout = 'timeline';
    else if (/카드/.test(t)) f.layout = 'cards';
    else if (/목록|리스트|체크\s?리스트|항목별/.test(t)) f.layout = 'list';
    else if (/버튼|링크|바로\s?가기/.test(t)) f.layout = 'buttons';
    else if (/이미지|그림|사진과\s?(글|텍스트)|사진\s?\+/.test(t)) f.layout = 'imagetext';
    else if (/텍스트형|글로만|문단/.test(t)) f.layout = 'text';
    // 기타 상황
    if (/멀리|먼\s?길|먼\s?곳|지방|원거리|타지|해외|비행기|ktx|기차/.test(t)) f.far = true;
    if (/좁|협소|부족|복잡|혼잡|붐비|모자라|적어서|적은|넉넉하지/.test(t)) f.narrow = true;
    if (/대중교통|지하철|버스/.test(t)) f.publicTr = true;
    return f;
  }

  /* ------------------------------------------------------------------ 문구 생성 (데모용 규칙 기반) */
  function genInvite(f) {
    var y = f.years, m = f.months, st = f.style || 'plain', v = (f.variant || 0) % 2;
    var who = y ? (y >= 3 ? y + '년이라는 오랜 시간 서로의 곁을 지켜온 저희가' : y + '년이라는 시간 동안 서로의 곁을 지켜온 저희가')
      : m ? m + '개월이라는 시간 동안 서로를 알아 온 저희가'
      : f.longRel ? '오랜 시간 서로의 곁을 지켜온 저희가' : '저희 두 사람이';
    var whoE = y ? y + '년, 수많은 계절을 함께 건너온 저희가' : f.longRel ? '수많은 계절을 함께 건너온 저희가' : who;
    var whoC = y ? y + '년 연애한 저희,' : m ? m + '개월 연애한 저희,' : f.longRel ? '오래 연애한 저희,' : '저희 두 사람,';
    var T = {
      plain: [who + ' 이제 부부로서 새로운 시작을 하려 합니다.\n소중한 분들과 이 기쁜 순간을 함께 나누고 싶습니다.',
        who + ' 이제 같은 길을 함께 걸어가려 합니다.\n그 시작을 소중한 분들과 나누고 싶습니다.'],
      formal: [who + ' 이제 부부의 연을 맺고자 합니다.\n바쁘시더라도 부디 오셔서\n저희의 새로운 출발을 축복해 주시면 감사하겠습니다.',
        who + ' 평생을 함께하기로 약속하였습니다.\n부디 오셔서 저희의 앞날을 축복해 주시면\n더없는 영광으로 여기겠습니다.'],
      emotional: [whoE + ' 이제 같은 이름으로 내일을 약속합니다.\n저희의 가장 빛나는 순간에\n소중한 당신이 함께해 주세요.',
        whoE + ' 이제 하나의 이야기를 시작합니다.\n그 첫 장에 당신의 축복을 더해 주세요.'],
      warm: [who + ' 이제 한 가족이 됩니다.\n늘 응원해 주신 고마운 분들과\n따뜻한 마음을 나누고 싶습니다.',
        who + ' 서로의 가족이 되기로 했습니다.\n고마운 분들과 따뜻한 밥 한 끼 나누며\n새 출발을 축하받고 싶습니다.'],
      cute: [whoC + ' 드디어 결혼합니다!\n맛있는 식사 준비해 두고 기다릴게요.\n꼭 놀러 와 주세요!',
        whoC + ' 결국 평생 짝꿍이 되기로 했어요!\n맛있는 밥 먹으러 꼭 와 주세요!']
    };
    var S = {
      plain: who + ' 부부가 됩니다.\n함께 축하해 주세요.',
      formal: who + ' 백년가약을 맺습니다.\n귀한 걸음으로 축복해 주시면 감사하겠습니다.',
      emotional: whoE + ' 같은 내일을 약속합니다.\n그 시작에 함께해 주세요.',
      warm: who + ' 한 가족이 됩니다.\n따뜻한 마음으로 함께해 주세요.',
      cute: whoC + ' 드디어 결혼해요!\n꼭 축하하러 와 주세요!'
    };
    var L = {
      plain: '\n\n귀한 걸음으로 자리를 빛내 주시면\n오래도록 감사한 마음으로 간직하겠습니다.',
      formal: '\n\n두 사람이 서로 아끼며 바르게 살아갈 수 있도록\n따뜻한 격려 부탁드립니다.',
      emotional: '\n\n그날의 햇살과 웃음을\n여러분과 함께 기억하고 싶습니다.',
      warm: '\n\n오셔서 두 사람의 앞날을\n다정하게 응원해 주세요.',
      cute: '\n\n그날 만나서 신나게 축하해 주세요!'
    };
    if (f.length === 'short') return S[st];
    return T[st][v] + (f.length === 'long' ? L[st] : '');
  }
  function genThanks(f) {
    var st = f.style || 'formal', far = !!f.far;
    var T = {
      formal: '바쁘신 가운데 ' + (far ? '먼 길 마다하지 않고 ' : '') + '저희의 시작을 축복해 주셔서 진심으로 감사드립니다.\n보내주신 따뜻한 마음을 오래도록 간직하며 행복하게 살아가겠습니다.',
      plain: (far ? '먼 길 ' : '') + '와 주셔서 감사합니다.\n보내주신 마음 잊지 않고 잘 살겠습니다.',
      emotional: (far ? '먼 길을 달려와 ' : '') + '함께해 주신 그날의 축복이\n저희에게 오래도록 빛나는 기억이 되었습니다.\n그 마음 잊지 않고 예쁘게 살겠습니다.',
      warm: (far ? '먼 길 와주셔서' : '와주셔서') + ', 축하해 주셔서 정말 고맙습니다.\n보내주신 따뜻한 마음 덕분에\n더없이 행복한 하루였어요.',
      cute: (far ? '먼 길까지 ' : '') + '와 주셔서 고마워요!\n덕분에 최고의 하루가 됐어요.\n행복하게 잘 살게요!'
    };
    var L = { formal: '\n\n일일이 찾아뵙고 인사드리지 못하는 점 너그러이 양해해 주시기 바랍니다.', plain: '\n\n늘 건강하시고 행복하세요.', emotional: '\n\n받은 사랑을 오래도록 나누며 살겠습니다.', warm: '\n\n받은 사랑, 오래오래 나누며 살게요.', cute: '\n\n앞으로도 예쁘게 지켜봐 주세요!' };
    if (f.length === 'short') return st === 'formal' ? (far ? '먼 길 마다하지 않고 ' : '') + '축복해 주셔서 진심으로 감사드립니다.\n행복하게 살겠습니다.' : shorten(T[st]);
    return T[st] + (f.length === 'long' ? L[st] : '');
  }
  function genTransport(f) {
    var st = f.style || 'formal';
    if (f.trMode === 'narrow') {
      var T = {
        formal: '예식장 주차 공간이 다소 협소한 관계로, 가능하시다면 대중교통을 이용해 주시면 감사하겠습니다.',
        plain: '주차 공간이 협소합니다.\n가능하시면 대중교통을 이용해 주세요.',
        warm: '주차 공간이 넉넉하지 않아 불편을 드릴까 걱정됩니다.\n가능하시다면 대중교통으로 편안히 와 주세요.',
        emotional: '예식장 주차 공간이 협소한 점 양해 부탁드립니다.\n대중교통으로 오시면 한결 편안하실 거예요.',
        cute: '주차 자리가 넉넉하지 않아요!\n가능하면 대중교통으로 편하게 와 주세요.'
      };
      return f.length === 'short' ? '주차 공간이 협소하니\n대중교통 이용을 부탁드립니다.' : T[st];
    }
    if (f.trMode === 'public') return st === 'cute' ? '가능하면 대중교통으로 편하게 와 주세요!' : '가능하시다면 대중교통을 이용해 주시면 감사하겠습니다.';
    var tpl = {
      car: '[주차장 위치]에 주차하실 수 있으며,\n하객은 [N]시간 무료 주차가 가능합니다.',
      subway: '[노선] [역 이름]역 [N]번 출구에서\n도보 약 [N]분 거리입니다.',
      bus: '[정류장 이름] 정류장에서 하차 후\n도보 약 [N]분 거리입니다.',
      shuttle: '[출발 장소]에서 [운행 간격] 간격으로\n셔틀버스가 운행됩니다.'
    };
    return tpl[f.trKey || 'car'];
  }
  function genRsvp(f, ctx) {
    var st = f.style || 'formal', dl = '';
    var d = ctx && ctx.data && ctx.data.rsvpDeadline ? new Date(ctx.data.rsvpDeadline + 'T00:00') : null;
    if (d && !isNaN(d)) dl = (d.getMonth() + 1) + '월 ' + d.getDate() + '일까지 ';
    var T = {
      formal: '축하의 마음으로 참석해 주시는 분들을 위해\n정성껏 준비하고자 합니다.\n' + dl + '참석 여부를 알려주시면 감사하겠습니다.',
      plain: '원활한 예식 준비를 위해\n' + dl + '참석 여부를 알려주세요.',
      warm: '오시는 분들 모두 편안히 머무실 수 있도록\n정성껏 준비하겠습니다.\n' + dl + '참석 여부를 알려주시면 감사해요.',
      emotional: '그날의 설렘을 함께 나눌 분들을 위해\n한 분 한 분 자리를 준비하고 싶습니다.\n' + dl + '참석 여부를 전해 주세요.',
      cute: '오실 수 있는지 ' + dl + '살짝 알려주세요!\n맛있는 식사 넉넉히 준비해 둘게요.'
    };
    return f.length === 'short' ? (dl ? dl + '참석 여부를 알려주세요.' : '참석 여부를 미리 알려주세요.') : T[st];
  }
  function genAccount(f) {
    var P = window.IumPhrases;
    var list = P ? P.get('account', f.style || 'plain') : [];
    return list[0] || '참석이 어려우신 분들을 위해 계좌번호를 안내드립니다.';
  }
  function genCustomDesc(sec, f) {
    var t = (sec && sec.title) || '';
    if (/일정|순서|스케줄/.test(t)) return '당일 일정을 미리 확인하시고\n여유 있게 와 주세요.';
    if (/우천|비/.test(t)) return '비가 올 경우 실내로 장소가 변경됩니다.\n변경 장소: [실내 예식장 이름과 주소를 입력해 주세요]';
    if (/드레스|복장/.test(t)) return '[원하시는 드레스코드를 적어 주세요]';
    if (/주차|교통/.test(t)) return genTransport({ trMode: 'narrow', style: f.style });
    return f.style === 'cute' ? '꼭 알아두시면 좋은 내용이에요!\n아래 내용을 확인해 주세요.' : '하객분들께서 알아두시면 좋은 내용을 정리했습니다.\n아래 내용을 확인해 주세요.';
  }
  var GEN = { invite: genInvite, thanks: genThanks, transport: genTransport, rsvp: genRsvp, account: genAccount };
  var KIND_TITLE = { invite: '초대 문구 제안', thanks: '감사 인사 제안', transport: '교통 안내 제안', rsvp: '참석 여부 안내 제안', account: '마음 전하기 안내 제안', custom: '섹션 안내 문구 제안' };

  function targetsFor(ctx) {
    var out = TEXT_TARGETS.map(function (t) { return { value: t[0], label: t[1] }; });
    (ctx && ctx.sections || []).forEach(function (s) { if (s.custom) out.push({ value: 'custom:' + s.id + ':desc', label: '추가 항목 · ' + (s.title || s.label) + ' (설명)' }); });
    return out;
  }
  function textProposal(kind, text, target, ctx) {
    return { type: 'text', kind: kind, title: KIND_TITLE[kind] || '문구 제안', text: text, target: target || '', targets: targetsFor(ctx) };
  }

  /* ------------------------------------------------------------------ 섹션 생성 */
  var SCHEDULE = [
    { time: '11:30', title: '하객 맞이', desc: '로비에서 인사드려요.', icon: 'heart' },
    { time: '12:00', title: '결혼식', desc: '본식이 시작됩니다.', icon: 'ring' },
    { time: '13:00', title: '식사', desc: '연회장으로 이동해 주세요.', icon: 'meal' },
    { time: '13:40', title: '기념 촬영', desc: '함께 사진을 남겨요.', icon: 'camera' },
    { time: '14:10', title: '마무리', desc: '와 주셔서 감사합니다.', icon: 'gift' },
    { time: '14:30', title: '배웅', desc: '조심히 돌아가세요.', icon: 'heart' }
  ];
  function scheduleSection(f, title) {
    var n = clamp(f.count || 3, 2, 6), layout = f.layout === 'timeline' || f.layout === 'list' ? f.layout : 'cards';
    var items = SCHEDULE.slice(0, n).map(function (x) {
      return layout === 'list' ? { title: x.time + ' ' + x.title + ' · ' + x.desc } : { time: x.time, title: x.title, desc: x.desc, icon: layout === 'cards' ? x.icon : '' };
    });
    return { layout: layout, title: title || '결혼식 당일 일정', desc: '', items: items };
  }
  function rainSection(f) {
    if (f.layout === 'list') return { layout: 'list', title: '우천 시 안내', desc: '', items: [{ title: '비가 올 경우 실내 예식장으로 장소가 변경됩니다.' }, { title: '변경 장소: [실내 예식장 이름과 주소를 입력해 주세요]' }, { title: '변경 안내: [안내 방법과 시점을 입력해 주세요]' }] };
    if (f.layout === 'cards') return { layout: 'cards', title: '우천 시 안내', desc: '', items: [{ title: '맑은 날', desc: '야외 정원에서 예식을 진행해요.', icon: 'pin' }, { title: '비 오는 날', desc: '[실내 예식장 이름과 주소를 입력해 주세요]', icon: 'pin' }] };
    return { layout: 'text', title: '우천 시 안내', desc: '야외 예식으로 준비하고 있으나,\n비가 올 경우 실내로 장소가 변경됩니다.\n\n변경 장소: [실내 예식장 이름과 주소를 입력해 주세요]' };
  }
  function genericSection(layout) {
    var D = {
      text: { layout: 'text', title: '안내', desc: '[안내할 내용을 입력해 주세요]' },
      cards: { layout: 'cards', title: '안내 카드', desc: '', items: [{ title: '[카드 제목]', desc: '[설명]', time: '', icon: '' }, { title: '[카드 제목]', desc: '[설명]', time: '', icon: '' }, { title: '[카드 제목]', desc: '[설명]', time: '', icon: '' }] },
      timeline: { layout: 'timeline', title: '진행 순서', desc: '', items: [{ time: '[시간]', title: '[단계 이름]', desc: '' }, { time: '[시간]', title: '[단계 이름]', desc: '' }, { time: '[시간]', title: '[단계 이름]', desc: '' }] },
      imagetext: { layout: 'imagetext', title: '우리의 이야기', desc: '[사진과 함께 보여줄 이야기를 입력해 주세요]', image: '' },
      list: { layout: 'list', title: '안내 사항', desc: '', items: [{ title: '[안내 사항 1]' }, { title: '[안내 사항 2]' }, { title: '[안내 사항 3]' }] },
      buttons: { layout: 'buttons', title: '바로가기', desc: '[버튼 위에 보여줄 설명을 입력해 주세요]', buttons: [{ label: '[버튼 문구]', url: '' }] }
    };
    return JSON.parse(JSON.stringify(D[layout] || D.text));
  }
  function describeSection(sec) {
    var n = (sec.items || []).length;
    if (sec.layout === 'cards') return '카드 ' + n + '개';
    if (sec.layout === 'timeline') return n + '단계 타임라인';
    if (sec.layout === 'list') return '목록 ' + n + '개';
    return LAYOUT_NAMES[sec.layout];
  }

  /* ------------------------------------------------------------------ 섹션 구성 변경 */
  var SEC_ALIASES = [
    ['guestphoto', /하객\s?사진/g],
    ['gallery', /갤러리|사진첩|사진\s?앨범|앨범/g],
    ['message', /방명록|축하\s?메(시|세)지|메(시|세)지/g],
    ['account', /계좌|마음\s?전하기|축의금/g],
    ['rsvp', /rsvp|참석\s?여부|참석\s?의사|회신/g],
    ['location', /오시는\s?길|지도|약도|위치/g],
    ['info', /예식\s?정보|달력|캘린더|디데이|d-day/g],
    ['invite', /초대의\s?글|초대\s?글|인사말/g],
    ['thanks', /감사\s?인사|감사장|감사\s?카드/g],
    ['cover', /메인\s?표지|표지|커버/g]
  ];
  function findMentions(t, ctx) {
    var out = [], taken = [];
    function free(a, b) { return !taken.some(function (r) { return a < r[1] && b > r[0]; }); }
    (ctx.sections || []).forEach(function (s) {
      if (!s.custom || !s.title || s.title.length < 2) return;
      var i = t.indexOf(norm(s.title));
      if (i >= 0 && free(i, i + s.title.length)) { out.push({ id: s.id, i: i, e: i + s.title.length }); taken.push([i, i + s.title.length]); }
    });
    SEC_ALIASES.forEach(function (a) {
      var re = new RegExp(a[1].source, 'g'), m;
      while ((m = re.exec(t))) { var b = m.index, e = b + m[0].length; if (free(b, e)) { out.push({ id: a[0], i: b, e: e }); taken.push([b, e]); } }
    });
    out.sort(function (x, y) { return x.i - y.i; });
    var seen = {}; return out.filter(function (m) { if (seen[m.id]) return false; seen[m.id] = 1; return true; });
  }
  function actionOf(seg) {
    if (/보이지\s?않|안\s?보이|숨겨|숨기|숨김|빼\s?줘|빼고|빼|감춰|감추|지워|없애|꺼\s?줘|끄고|제외|비공개/.test(seg)) return 'hide';
    if (/맨\s?위|제일\s?위|가장\s?위|맨\s?앞|제일\s?앞|최상단|맨\s?처음|처음으로/.test(seg)) return 'top';
    if (/맨\s?아래|맨\s?밑|제일\s?아래|가장\s?아래|맨\s?뒤|마지막|끝으로|최하단/.test(seg)) return 'bottom';
    if (/한\s?칸\s?(위|앞|올)/.test(seg)) return 'up1';
    if (/한\s?칸\s?(아래|뒤|내)/.test(seg)) return 'down1';
    if (/위로|올려|올리|앞으로|앞쪽|먼저|상단|위쪽/.test(seg)) return 'up';
    if (/아래로|내려|내리|뒤로|뒤쪽|하단|아래쪽|밑으로/.test(seg)) return 'down';
    if (/보여|보이게|표시|켜\s?줘|켜고|다시\s?넣|넣어|공개/.test(seg)) return 'show';
    return '';
  }
  function planReorder(t, ctx) {
    var ms = findMentions(t, ctx);
    if (!ms.length) return null;
    var acts = [];
    for (var k = 0; k < ms.length; k++) {
      var seg = t.slice(ms[k].e, k + 1 < ms.length ? ms[k + 1].i : t.length);
      var nseg = k + 1 < ms.length ? t.slice(ms[k + 1].e, k + 2 < ms.length ? ms[k + 2].i : t.length) : '';
      if (k + 1 < ms.length && /^\s*(을|를)\s*$/.test(seg) && /^\s*(의\s*)?(바로\s*)?(위|앞|아래|뒤|다음)/.test(nseg)) {
        acts.push({ id: ms[k].id, act: /^\s*(의\s*)?(바로\s*)?(위|앞)/.test(nseg) ? 'before' : 'after', ref: ms[k + 1].id });
        k++; continue;
      }
      acts.push({ id: ms[k].id, act: actionOf(seg) });
    }
    for (var j = acts.length - 1; j >= 0; j--) if (!acts[j].act) { var nx = acts.slice(j + 1).filter(function (a) { return a.act && a.act !== 'before' && a.act !== 'after'; })[0]; if (nx) acts[j].act = nx.act; }
    acts = acts.filter(function (a) { return a.act; });
    if (!acts.length) return null;

    var order = (ctx.sections || []).map(function (s) { return { id: s.id, on: !!s.on }; });
    var before = order.map(function (s) { return s.id; });
    var labelOf = function (id) { var s = (ctx.sections || []).filter(function (x) { return x.id === id; })[0]; return s ? (s.custom ? (s.title || s.label) : SEC_LABEL[id] || s.label) : id; };
    var rows = [], vis = [], notes = [];
    function idx(id) { for (var i = 0; i < order.length; i++) if (order[i].id === id) return i; return -1; }
    function moveTo(id, to) { var i = idx(id); if (i < 0) return; var it = order.splice(i, 1)[0]; to = clamp(to, 0, order.length); order.splice(to, 0, it); }
    acts.forEach(function (a) {
      var i = idx(a.id); if (i < 0) return;
      var minTop = a.id === 'cover' ? 0 : (order[0] && order[0].id === 'cover' ? 1 : 0);
      if (a.act === 'hide' || a.act === 'show') {
        var want = a.act === 'show';
        if (order[i].on === want) notes.push(josa(labelOf(a.id), '은', '는') + (want ? ' 이미 청첩장에 표시되고 있어요.' : ' 이미 청첩장에서 숨겨진 상태예요.'));
        else { order[i].on = want; vis.push({ id: a.id, on: want }); rows.push(labelOf(a.id) + ': ' + (want ? '숨김 → 표시' : '표시 → 숨김')); }
        return;
      }
      if (a.act === 'top') moveTo(a.id, minTop);
      else if (a.act === 'bottom') moveTo(a.id, order.length - 1);
      else if (a.act === 'up1') moveTo(a.id, Math.max(minTop, i - 1));
      else if (a.act === 'down1') moveTo(a.id, i + 1);
      else if (a.act === 'up') { var inv = idx('invite'); var tgt = inv >= 0 && inv + 1 < i && a.id !== 'invite' ? inv + 1 : i - 1; moveTo(a.id, Math.max(minTop, tgt)); }
      else if (a.act === 'down') moveTo(a.id, i + 2);
      else if (a.act === 'before') { var r = idx(a.ref); moveTo(a.id, r > i ? r - 1 : r); }
      else if (a.act === 'after') { var r2 = idx(a.ref); moveTo(a.id, r2 >= i ? r2 : r2 + 1); }
      var ni = idx(a.id);
      if (ni === i) notes.push(josa(labelOf(a.id), '은', '는') + ' 이미 그 위치에 있어요.');
      else rows.push(labelOf(a.id) + ': ' + (i + 1) + '번째 → ' + (ni + 1) + '번째' + (a.act === 'up' && order[ni - 1] && order[ni - 1].id === 'invite' ? ' (초대의 글 바로 아래)' : ''));
    });
    var after = order.map(function (s) { return s.id; });
    var cmds = [];
    if (after.join() !== before.join()) cmds.push({ type: 'setOrder', order: after });
    vis.forEach(function (v) { cmds.push({ type: 'setVisible', id: v.id, on: v.on }); });
    return { rows: rows, notes: notes, cmds: cmds };
  }

  /* ------------------------------------------------------------------ 완성도 점검 */
  function isSample(s) { return /샘플|○|예시\)|\(예시|데모 주소|000-0000/.test(String(s || '')); }
  function runCheck(ctx) {
    var d = ctx.data || {}, secs = ctx.sections || [], issues = [], ok = [];
    var on = {}; secs.forEach(function (s) { on[s.id] = !!s.on; });
    function add(label, detail, sec) { issues.push({ label: label, detail: detail || '', sec: sec || '' }); }
    var blank = function (v) { return !String(v || '').trim(); };
    if (blank(d.groom) || blank(d.bride)) add('신랑·신부 이름 미입력', '메인 표지와 초대의 글에 이름이 표시돼요.', 'cover'); else ok.push('신랑·신부 이름');
    var dt = new Date((d.date || '') + 'T00:00');
    if (blank(d.date) || isNaN(dt)) add('예식 날짜 미입력', '', 'info'); else ok.push('예식 날짜');
    if (blank(d.time)) add('예식 시간 미입력', '', 'info'); else ok.push('예식 시간');
    if (blank(d.venue)) add('예식장 이름 미입력', '', 'location'); else if (isSample(d.venue)) add('예식장 이름이 예시 그대로예요', '“' + d.venue + '” → 실제 예식장 이름으로 바꿔 주세요.', 'location'); else ok.push('예식장 이름');
    if (blank(d.address)) add('예식장 주소 미입력', '하객이 길찾기·주소 복사를 할 수 없어요.', 'location'); else if (isSample(d.address)) add('예식장 주소가 예시 주소 그대로예요', '실제 주소로 바꿔 주세요.', 'location'); else ok.push('예식장 주소');
    if (!d.hasCover) add('메인 표지 사진 미등록', '사진이 없으면 표지에 빈 사진 자리가 보여요.', 'cover'); else ok.push('메인 표지 사진');
    if (on.gallery) { if (!d.galleryPhotos) add('갤러리 사진 미등록', '사진 갤러리 항목이 켜져 있지만 올린 사진이 없어요.', 'gallery'); else ok.push('갤러리 사진 ' + d.galleryPhotos + '장'); }
    var tr = d.transport || {};
    var trKeys = ['car', 'subway', 'bus', 'shuttle'];
    if (trKeys.every(function (k) { return blank(tr[k]); })) add('교통 안내 미입력', '', 'location');
    else {
      if (blank(tr.car)) add('주차 안내 확인 필요', '자가용 및 주차 안내가 비어 있어요. 주차가 어렵다면 그 내용을 알려 주세요.', 'location');
      if (trKeys.some(function (k) { return isSample(tr[k]); })) add('교통 안내가 예시 문구 그대로예요', '“(샘플 문구)” 표시가 남아 있어요.', 'location');
      else ok.push('교통 안내');
    }
    if (on.invite && blank(d.inviteText)) add('초대의 글 본문이 비어 있어요', '', 'invite');
    if (on.invite && d.showParents && [d.groomFather, d.groomMother, d.brideFather, d.brideMother].some(blank)) add('혼주 이름 일부 미입력', '혼주 표시가 켜져 있어요. 비워 둔 이름은 표시되지 않아요.', 'invite');
    if (on.rsvp) {
      var dl = new Date((d.rsvpDeadline || '') + 'T00:00');
      if (blank(d.rsvpDeadline) || isNaN(dl)) add('RSVP 회신 기한 미설정', '', 'rsvp');
      else if (!isNaN(dt) && dl > dt) add('RSVP 회신 기한이 예식일보다 늦어요', '', 'rsvp');
      else ok.push('RSVP 회신 기한');
    }
    if (on.account) {
      var acc = d.accounts || [];
      if (!acc.length) add('계좌 정보 없음', '마음 전하기 항목이 켜져 있어요.', 'account');
      else if (acc.some(function (a) { return blank(a.number) || blank(a.bank) || isSample(a.number) || isSample(a.bank); })) add('계좌 정보 확인 필요', '비어 있거나 예시(○○은행, 000-0000…)로 남은 계좌가 있어요.', 'account');
    }
    secs.filter(function (s) { return s.custom && s.on; }).forEach(function (s) {
      var name = '‘' + (s.title || s.label) + '’';
      if (blank(s.title)) add('추가 항목 제목 미입력', '', s.id);
      if (s.placeholder) add(name + '에 입력이 필요한 자리 [ ]가 남아 있어요', '대괄호 안의 내용을 실제 정보로 바꿔 주세요.', s.id);
      if (s.badLinks) add(name + '의 버튼 링크 확인 필요', '주소가 비었거나 안전하지 않은 링크는 하객 화면에 표시되지 않아요.', s.id);
      if (s.emptyImage) add(name + ' 이미지 미등록', '', s.id);
    });
    return { issues: issues, ok: ok };
  }

  /* ------------------------------------------------------------------ 데모 응답 */
  function reply(text, proposals, suggestions, ctx) {
    return { text: text, proposals: proposals || [], suggestions: suggestions || [], ctx: ctx || {}, source: 'demo' };
  }
  function trMode(t, f) {
    if (f.narrow && (f.publicTr || /주차|차/.test(t))) return 'narrow';
    if (/대중교통/.test(t) && /이용|부탁|권장|와\s?달|오시/.test(t)) return 'public';
    return 'template';
  }
  function trKey(t) { return /셔틀/.test(t) ? 'shuttle' : /지하철|역\s|역에서|출구/.test(t) ? 'subway' : /버스/.test(t) ? 'bus' : 'car'; }

  function demoRespond(req) {
    var raw = String(req.message || '');
    var t = norm(raw);
    var ctx = req.context || { sections: [], data: {} };
    var prev = req.ctx || {};
    var facts = prev.facts || {};
    var f = extract(t);
    if (f.years || f.months || f.longRel) facts = { years: f.years || (f.months ? 0 : facts.years), months: f.months || (f.years ? 0 : facts.months), longRel: f.longRel || facts.longRel };
    var base = { facts: facts };
    function withCtx(o) { var c = { facts: facts }; for (var k in o) c[k] = o[k]; return c; }

    if (!t) return reply('무엇을 도와드릴까요?', [], EXAMPLES.slice(0, 4), base);

    // 1. 완성도 점검
    if (/빠진|빠뜨|누락|빠졌|점검|완성도|체크해|확인해|검토해|부족한\s?(정보|부분)|빠진\s?게/.test(t) && !/문구|써\s?줘|작성/.test(t)) {
      var r = runCheck(ctx);
      var head = r.issues.length ? '현재 입력된 내용을 기준으로 확인했어요. 확인이 필요한 항목이 ' + r.issues.length + '개 있어요.' : '현재 입력된 내용을 기준으로 확인했어요. 빠진 필수 정보는 없어요.';
      return reply(head, [{ type: 'check', issues: r.issues, ok: r.ok }], [sugg('주차 안내 문구 써줘', '주차 공간이 좁아서 대중교통을 이용해 달라고 정중하게 안내하고 싶어.'), sugg('당일 일정 추가', '결혼식 당일 일정을 3칸으로 나눠서 보여주고 싶어.')], withCtx({ last: { type: 'check' } }));
    }

    // 2. 섹션 구성 변경 (섹션 이름 + 이동/숨김 동작)
    var isAddLike = /추가|만들|생성|새로/.test(t) && !/숨|올려|내려|위로|아래로/.test(t);
    if (!isAddLike) {
      var plan = planReorder(t, ctx);
      if (plan) {
        if (!plan.cmds.length) return reply(plan.notes.join(' ') || '바꿀 내용이 없어요.', [], [sugg('빠진 정보 점검', '청첩장에서 빠진 정보가 있는지 확인해 줘.')], base);
        var q = '다음과 같이 섹션 구성을 변경할까요?' + (plan.notes.length ? '\n' + plan.notes.join(' ') : '');
        return reply(q, [{ type: 'changes', title: '변경 예정 사항', rows: plan.rows, cmds: plan.cmds }], [], withCtx({ last: { type: 'changes' } }));
      }
    }

    // 3. 전체 문구 분위기 통일
    if (/전체|전반|모든\s?문구|문구\s?전부|전부|통일|다\s?바꿔|싹/.test(t) && f.style) {
      var rows = [];
      var d = ctx.data || {}, on = {}; (ctx.sections || []).forEach(function (s) { on[s.id] = s.on; });
      var ff = { style: f.style, years: facts.years, months: facts.months, longRel: facts.longRel, far: f.far };
      var add = function (target, label, after, before) { if (String(before || '').trim() !== after.trim()) rows.push({ target: target, label: label, before: before || '', after: after }); };
      add('inviteText', '초대의 글 본문', genInvite(ff), d.inviteText);
      add('rsvpDesc', 'RSVP 안내 문구', genRsvp(ff, ctx), d.rsvpDesc);
      add('accountIntro', '마음 전하기 안내 문구', genAccount(ff), d.accountIntro);
      add('thanks.text', '감사 인사 문구', genThanks(ff), d.thanks && d.thanks.text);
      return reply('청첩장 문구를 ' + STYLE_ADJ[f.style] + ' 분위기로 다듬어 봤어요. 기존 문구와 비교해 보고 마음에 드는 것만 골라 적용하세요.', [{ type: 'compare', title: STYLE_ADJ[f.style] + ' 분위기로 수정 제안', rows: rows }], [], withCtx({ last: { type: 'compare' } }));
    }

    // 4. 섹션 생성 의도
    var last = prev.last || {};
    if (/우천|비가|비\s?오|비\s?올|비\s?소식|장마|궂은\s?날/.test(t) || (/야외/.test(t) && /실내/.test(t))) {
      var rs = rainSection(f);
      return reply('우천 시 안내 섹션을 만들어 드릴게요. 변경되는 실내 예식장 위치도 함께 안내할 수 있습니다.', [{ type: 'section', title: rs.title, note: '실내 예식장 이름과 주소는 추가한 뒤 직접 입력해 주세요.', section: rs, after: 'location' }], [sugg('목록형으로 바꿔줘'), sugg('카드형으로 보여줘')], withCtx({ last: { type: 'section', which: 'rain', f: f } }));
    }
    if (/일정|스케줄|스케쥴|타임\s?테이블|식순|순서\s?안내|진행\s?순서|하루\s?흐름|타임라인/.test(t) && !/숨|위로|아래로/.test(t)) {
      var title = /식순|예식\s?순서/.test(t) ? '예식 순서' : '결혼식 당일 일정';
      var sf = { count: f.count, layout: f.layout };
      if (last.type === 'section' && last.which === 'schedule') { if (!sf.count) sf.count = last.f.count; if (!sf.layout) sf.layout = last.f.layout; title = last.title || title; }
      var ss = scheduleSection(sf, title);
      var how = ss.layout === 'cards' ? '카드 ' + ss.items.length + '개로' : ss.layout === 'timeline' ? '타임라인 ' + ss.items.length + '단계로' : '목록 ' + ss.items.length + '개로';
      return reply(josa(title, '을', '를') + ' ' + how + ' 나누어 보여드릴게요. 각 ' + (ss.layout === 'list' ? '줄' : '칸') + '에 시간과 일정을 입력할 수 있도록 구성했습니다.', [{ type: 'section', title: ss.title, note: '시간과 내용은 예시예요. 추가한 뒤 실제 일정으로 고쳐 주세요.', section: ss, after: 'info' }], [sugg('카드 4개로 바꿔줘'), sugg('타임라인으로 보여줘')], withCtx({ last: { type: 'section', which: 'schedule', f: { count: ss.items.length, layout: ss.layout }, title: title } }));
    }
    if (/드레스\s?코드|복장/.test(t)) {
      var dc = { layout: 'text', title: '드레스코드', desc: '[원하시는 드레스코드를 적어 주세요]' };
      return reply('드레스코드 안내 섹션을 만들어 드릴게요. 원하시는 복장은 추가한 뒤 직접 적어 주세요.', [{ type: 'section', title: dc.title, note: '내용은 직접 입력해 주세요.', section: dc, after: 'location' }], [], withCtx({ last: { type: 'section', which: 'dress' } }));
    }
    if (/(추가|만들|넣|생성)/.test(t) && /(섹션|항목|블록|카드|목록|리스트|버튼|링크|타임라인|텍스트형|이미지)/.test(t) && !/문구|글\s?써|작성/.test(t)) {
      var lay = f.layout || 'text';
      var gs = genericSection(lay);
      if ((lay === 'cards' || lay === 'timeline' || lay === 'list') && f.count) { var tmpl = genericSection(lay).items[0]; gs.items = []; for (var gi = 0; gi < clamp(f.count, 1, 6); gi++) gs.items.push(JSON.parse(JSON.stringify(tmpl))); }
      return reply(LAYOUT_NAMES[lay] + ' 항목 초안을 만들었어요. [ ] 부분은 추가한 뒤 직접 채워 주세요.', [{ type: 'section', title: gs.title, note: '자리표시 [ ]를 실제 내용으로 바꿔 주세요.', section: gs, after: '' }], [], withCtx({ last: { type: 'section', which: 'generic', f: { layout: lay } } }));
    }

    // 5. 섹션 후속 요청 (방금 제안한 섹션 다시 구성)
    if (last.type === 'section' && (last.which === 'schedule' || last.which === 'rain') && (f.count || f.countDelta || f.layout) && !/문구/.test(t)) {
      if (last.which === 'schedule') {
        var nf = { count: f.count || clamp((last.f.count || 3) + (f.countDelta || 0), 2, 6), layout: f.layout || last.f.layout };
        var s2 = scheduleSection(nf, last.title);
        return reply('알겠어요. ' + describeSection(s2) + '로 다시 구성했어요.', [{ type: 'section', title: s2.title, note: '시간과 내용은 예시예요. 추가한 뒤 실제 일정으로 고쳐 주세요.', section: s2, after: 'info' }], [sugg('카드형으로 보여줘'), sugg('타임라인으로 보여줘')], withCtx({ last: { type: 'section', which: 'schedule', f: nf, title: last.title } }));
      }
      var r2 = rainSection(f);
      return reply('우천 시 안내를 ' + LAYOUT_NAMES[r2.layout] + '으로 다시 구성했어요.', [{ type: 'section', title: r2.title, note: '실내 예식장 이름과 주소는 직접 입력해 주세요.', section: r2, after: 'location' }], [], withCtx({ last: { type: 'section', which: 'rain', f: f } }));
    }

    // 6. 문구 작성 의도
    var kind = '';
    if (/감사\s?(인사|카드|장|문구|메(시|세)지|드리|하다|한\s?마음)|와\s?주신|와주신|와주셔|와\s?주셔|참석해\s?주신|답례|고마운\s?마음|고맙다고/.test(t)) kind = 'thanks';
    else if (/주차|대중교통|교통|지하철|버스|셔틀|자가용/.test(t)) kind = 'transport';
    else if (/참석\s?여부|참석\s?의사|rsvp|회신/.test(t)) kind = 'rsvp';
    else if (/계좌|마음\s?전하기|축의금/.test(t)) kind = 'account';
    else if (/(추가한|만든|새로\s?만든|내가\s?만든|직접\s?만든)\s?(섹션|항목)/.test(t) || (/섹션|항목/.test(t) && /(설명|안내)\s?문구/.test(t))) kind = 'custom';
    else if (/초대|청첩장\s?(문구|글)|인사말|초대\s?글/.test(t) || f.rel) kind = 'invite';

    var REWRITE = /짧게|줄여|간단|간결|길게|늘려|자세|담백|오글|느끼|과하|정중|격식|공손|친근|편하게|캐주얼|귀엽|발랄|따뜻|다정|감성|로맨틱|다시|다른\s?버전|다르게|바꿔/;
    if (!kind && last.type === 'text' && REWRITE.test(t)) {
      var lf = last.f || {};
      var nf2 = {}; for (var k in lf) nf2[k] = lf[k];
      var changed = [];
      if (f.style && f.style !== lf.style) { nf2.style = f.style; changed.push(STYLE_ADJ[f.style] + ' 느낌으로'); }
      if (f.length) { nf2.length = f.length; changed.push(f.length === 'short' ? '조금 더 짧게' : '조금 더 길게'); }
      if (!changed.length || /다시|다른\s?버전|다르게/.test(t)) { nf2.variant = (lf.variant || 0) + 1; if (!changed.length) changed.push('다른 표현으로'); }
      if (f.style === lf.style && !f.length && !/다시|다른|다르게/.test(t)) changed = [STYLE_ADJ[f.style] + ' 느낌을 조금 더 살려'];
      nf2.years = facts.years; nf2.months = facts.months; nf2.longRel = facts.longRel;
      var text2 = last.kind === 'custom' ? genCustomDesc(last.sec, nf2) : GEN[last.kind](nf2, ctx);
      if (text2 === last.text) {
        if (nf2.length === 'short' && !f.length) delete nf2.length;
        nf2.variant = (nf2.variant || 0) + 1;
        text2 = last.kind === 'custom' ? genCustomDesc(last.sec, nf2) : GEN[last.kind](nf2, ctx);
      }
      var note = text2 === last.text ? ' (이 조건에서는 같은 문구가 가장 잘 맞아요. 다른 분위기도 시도해 보세요.)' : '';
      return reply(changed.join(', ') + ' 다시 써 봤어요.' + note, [textProposal(last.kind, text2, last.target, ctx)], TEXT_FOLLOW, withCtx({ last: { type: 'text', kind: last.kind, f: nf2, target: last.target, text: text2, sec: last.sec } }));
    }

    if (kind) {
      var g = { style: f.style, length: f.length, years: facts.years, months: facts.months, longRel: facts.longRel, far: f.far };
      var text, target, intro;
      if (kind === 'invite') {
        g.style = g.style || 'plain';
        text = genInvite(g); target = 'inviteText';
        intro = (g.years ? g.years + '년의 연애를 담아 ' : g.months ? g.months + '개월의 연애를 담아 ' : g.longRel ? '오랜 연애를 담아 ' : '') + STYLE_ADJ[g.style] + ' 초대 문구를 써 봤어요.';
      } else if (kind === 'thanks') {
        g.style = g.style || 'formal';
        text = genThanks(g); target = 'thanks.text';
        intro = (g.far ? '먼 길 와주신 분들께 드리는 마음까지 담아 ' : '') + STYLE_ADJ[g.style] + ' 감사 인사를 써 봤어요. 감사 인사장 문구에 적용할 수 있어요.';
      } else if (kind === 'transport') {
        g.style = g.style || 'formal'; g.trMode = trMode(t, f); g.trKey = trKey(t);
        text = genTransport(g);
        target = g.trMode === 'template' ? 'transport.' + g.trKey : 'transport.car';
        intro = g.trMode === 'template' ? '정확한 정보를 알 수 없어서 [ ] 칸으로 남긴 안내 문구 틀이에요. 적용한 뒤 실제 정보로 채워 주세요.' : STYLE_ADJ[g.style] + ' 교통 안내 문구를 써 봤어요. 오시는 길의 ‘자가용 및 주차’ 안내에 적용돼요.';
      } else if (kind === 'rsvp') {
        g.style = g.style || 'formal'; text = genRsvp(g, ctx); target = 'rsvpDesc';
        intro = STYLE_ADJ[g.style] + ' 참석 여부 안내 문구를 써 봤어요.' + (/일까지/.test(text) ? ' 회신 기한은 입력하신 날짜를 그대로 사용했어요.' : '');
      } else if (kind === 'account') {
        g.style = g.style || 'plain'; text = genAccount(g); target = 'accountIntro';
        intro = STYLE_ADJ[g.style] + ' 마음 전하기 안내 문구예요.';
      } else {
        var cs = (ctx.sections || []).filter(function (s) { return s.custom; });
        if (!cs.length) return reply('아직 직접 추가한 항목이 없어요. 먼저 편집기의 ‘+ 항목 추가’로 섹션을 만들거나, 저에게 “우천 시 안내를 넣고 싶어”처럼 요청해 보세요.', [], [sugg('우천 시 안내 추가', '야외 결혼식이라 비가 오면 실내로 변경된다는 안내를 넣고 싶어.'), sugg('당일 일정 카드 3칸', '결혼식 당일 일정을 3칸으로 나눠서 보여주고 싶어.')], base);
        var pick = cs.filter(function (s) { return s.id === ctx.openSec; })[0] || (cs.length === 1 ? cs[0] : null);
        g.style = g.style || 'plain';
        text = genCustomDesc(pick || cs[cs.length - 1], g);
        target = pick ? 'custom:' + pick.id + ':desc' : '';
        intro = pick ? '‘' + (pick.title || pick.label) + '’ 항목에 넣을 안내 문구를 써 봤어요.' : '추가한 항목이 여러 개라 어디에 넣을지 몰라요. 아래에서 적용할 항목을 골라 주세요.';
        return reply(intro, [textProposal('custom', text, target, ctx)], TEXT_FOLLOW, withCtx({ last: { type: 'text', kind: 'custom', f: g, target: target, text: text, sec: pick || cs[cs.length - 1] } }));
      }
      return reply(intro, [textProposal(kind, text, target, ctx)], TEXT_FOLLOW, withCtx({ last: { type: 'text', kind: kind, f: g, target: target, text: text } }));
    }

    // 7. 막연한 문구 요청 → 어떤 문구인지 확인
    if (/문구|글\s?(좀\s?)?(써|작성|만들)|멘트/.test(t)) {
      return reply('어떤 문구가 필요하세요? 아래에서 고르거나 상황을 조금 더 알려 주세요.', [], [sugg('초대 문구', '담백한 초대 문구를 작성해 줘.'), sugg('감사 인사', '결혼식에 와주신 분들께 감사 인사를 하고 싶어.'), sugg('교통 안내', '주차 공간이 좁아서 대중교통을 이용해 달라고 정중하게 안내하고 싶어.'), sugg('참석 여부 안내', '참석 여부 안내 문구를 정중하게 써줘.')], base);
    }

    // 8. 인사 · 도움말
    if (/^(안녕|하이|hello|hi)|뭐\s?(할\s?수|해\s?줄|가능)|무엇을|뭘\s?할|도와줄|도움|사용법|어떻게\s?(써|쓰|사용)|기능/.test(t)) {
      return reply('안녕하세요, 이움 AI예요. 상황을 편하게 설명해 주시면 문구를 써 드리고, 일정·우천 안내 같은 항목을 만들어 청첩장에 바로 넣어 드려요. 섹션 순서 변경이나 빠진 정보 점검도 할 수 있어요.', [], EXAMPLES, base);
    }

    // 9. 지원하지 않는 요청 (작동하는 척하지 않음)
    var extra = '';
    if (/색|컬러|글꼴|폰트|배경|디자인|템플릿/.test(t)) extra = ' 글꼴·색상·템플릿은 편집기의 ‘디자인 세부 수정’과 ‘템플릿 변경’에서 직접 바꿀 수 있어요.';
    else if (/사진|이미지/.test(t)) extra = ' 사진은 각 항목의 ‘사진 올리기’에서 직접 등록할 수 있어요.';
    return reply(UNSUPPORTED + extra, [], EXAMPLES.slice(0, 6), base);
  }

  /* ------------------------------------------------------------------ 응답 · 명령 검증 (실제 AI 응답에도 적용) */
  var TARGET_RE = /^(inviteText|inviteTitle|rsvpTitle|rsvpDesc|accountIntro|guestPhotoDesc|thanks\.text|thanks\.title|transport\.(car|subway|bus|shuttle)|custom:[a-z0-9_-]{1,40}:(desc|title))$/i;
  function str(v, n) { return String(v == null ? '' : v).slice(0, n || 2000); }
  function cleanSection(s) {
    s = s || {};
    var layout = LAYOUTS.indexOf(s.layout) >= 0 ? s.layout : 'text';
    var items = Array.isArray(s.items) ? s.items.slice(0, 8).map(function (it) { return { time: str(it.time, 40), title: str(it.title, 200), desc: str(it.desc, 600), icon: str(it.icon, 20) }; }) : [];
    var buttons = Array.isArray(s.buttons) ? s.buttons.slice(0, 4).map(function (b) { return { label: str(b.label, 60), url: str(b.url, 500) }; }) : [];
    return { layout: layout, title: str(s.title, 100), desc: str(s.desc, 2000), items: items, buttons: buttons };
  }
  function validateCommands(cmds) {
    if (!Array.isArray(cmds)) return [];
    return cmds.map(function (c) {
      if (!c || typeof c !== 'object') return null;
      if (c.type === 'setText' && TARGET_RE.test(String(c.target || ''))) return { type: 'setText', target: c.target, value: str(c.value) };
      if (c.type === 'addSection') return { type: 'addSection', section: cleanSection(c.section), after: str(c.after, 60) };
      if (c.type === 'setOrder' && Array.isArray(c.order)) return { type: 'setOrder', order: c.order.map(function (x) { return str(x, 60); }) };
      if (c.type === 'setVisible' && c.id) return { type: 'setVisible', id: str(c.id, 60), on: !!c.on };
      if (c.type === 'openSection' && c.id) return { type: 'openSection', id: str(c.id, 60) };
      return null;
    }).filter(Boolean);
  }
  function sanitizeResponse(res) {
    res = res || {};
    var out = { text: str(res.text, 3000), proposals: [], suggestions: [], ctx: res.ctx && typeof res.ctx === 'object' ? res.ctx : {}, source: res.source || 'remote' };
    (Array.isArray(res.proposals) ? res.proposals : []).slice(0, 4).forEach(function (p) {
      if (!p) return;
      if (p.type === 'text') out.proposals.push({ type: 'text', kind: str(p.kind, 20), title: str(p.title, 60) || '문구 제안', text: str(p.text), target: TARGET_RE.test(String(p.target || '')) ? p.target : '', targets: Array.isArray(p.targets) ? p.targets.filter(function (x) { return x && TARGET_RE.test(String(x.value)); }).map(function (x) { return { value: x.value, label: str(x.label, 80) }; }) : [] });
      else if (p.type === 'section') out.proposals.push({ type: 'section', title: str(p.title, 100), note: str(p.note, 300), section: cleanSection(p.section), after: str(p.after, 60) });
      else if (p.type === 'changes') out.proposals.push({ type: 'changes', title: str(p.title, 60) || '변경 예정 사항', rows: (p.rows || []).map(function (r) { return str(r, 200); }), cmds: validateCommands(p.cmds) });
      else if (p.type === 'compare') out.proposals.push({ type: 'compare', title: str(p.title, 60), rows: (p.rows || []).filter(function (r) { return r && TARGET_RE.test(String(r.target)); }).map(function (r) { return { target: r.target, label: str(r.label, 60), before: str(r.before), after: str(r.after) }; }) });
      else if (p.type === 'check') out.proposals.push({ type: 'check', issues: (p.issues || []).map(function (i) { return { label: str(i.label, 120), detail: str(i.detail, 300), sec: str(i.sec, 60) }; }), ok: (p.ok || []).map(function (x) { return str(x, 60); }) });
    });
    (Array.isArray(res.suggestions) ? res.suggestions : []).slice(0, 8).forEach(function (s) { if (s && (s.text || s.label)) out.suggestions.push({ label: str(s.label || s.text, 40), text: str(s.text || s.label, 300) }); });
    return out;
  }

  /* ------------------------------------------------------------------ 실제 AI (서버 경유) */
  function remoteRespond(req) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, config.timeoutMs) : null;
    // API 키는 절대 프런트엔드에 두지 않습니다. 서버가 키를 보관하고 AI 서비스에 대신 요청합니다.
    return fetch(config.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({ message: req.message, history: req.history, context: req.context, ctx: req.ctx })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (timer) clearTimeout(timer); return sanitizeResponse(j); });
  }

  function respond(req) {
    if (config.mode === 'remote') {
      return remoteRespond(req).catch(function () {
        var r = demoRespond(req); r.text = '(AI 서버에 연결하지 못해 데모 응답으로 대신했어요)\n' + r.text; return r;
      });
    }
    try { return Promise.resolve(demoRespond(req)); } catch (e) { return Promise.resolve(reply('요청을 처리하지 못했어요. 다시 시도해 주세요.', [], EXAMPLES.slice(0, 4), {})); }
  }

  /* ------------------------------------------------------------------ v10: 결혼식 정보 자유 입력 → 항목 정리
   * extractWedding(text, images) → Promise<{ f:{...}, flags:{필드:true(확인 필요)}, notes:[문장], source }>
   *  - 데모(기본): 입력한 글에서 '적혀 있는 내용만' 규칙으로 찾습니다. 없거나 모호한 값은 만들지 않고 비워 둡니다.
   *  - 사진: 데모에서는 사진 속 글자를 읽지 않습니다(OCR·이미지 AI 미연결). config.mode='remote' 이면 서버로 사진과 글을 함께 보냅니다.
   */
  var REL_G = ['장남', '차남', '삼남', '외아들'], REL_B = ['장녀', '차녀', '삼녀', '외동딸']; // v14: 자녀 호칭 (그 밖의 호칭은 '기타'로 그대로 보존)
  var REGION = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(특별시|광역시|특별자치시|특별자치도|도|시)?$/;
  var VENUE_W = /(웨딩|홀|컨벤션|호텔|예식장|채플|가든|하우스|센터|클럽|성당|교회|빌라|타워|파티|볼룸|스퀘어|아트|더\s?\S+)/;
  var NAME = '([가-힣]{2,4})';
  function pad2(n) { return String(n).padStart(2, '0'); }
  function cleanName(n) { n = String(n || '').trim(); return /^(아버지|어머니|부친|모친|측|이름|혼주|신랑|신부|님)$/.test(n) ? '' : n; }
  function extractWedding(text, images) {
    var raw = String(text || '').replace(/\r/g, '');
    var f = { groom: '', bride: '', date: '', time: '', venue: '', floor: '', hall: '', address: '', groomFather: '', groomMother: '', groomRel: '', brideFather: '', brideMother: '', brideRel: '', car: '', subway: '', bus: '', shuttle: '', extra: '' };
    var flags = {}, notes = [], used = {};
    var lines = raw.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    var m;
    // 1) '…의 장남 민준' 형태 (혼주 · 관계 · 이름을 한 번에)
    var reRel = /([가-힣]{2,4})\s*[·ㆍ,\/&]\s*([가-힣]{2,4})\s*의\s*(장남|차남|삼남|외동아들|외아들|막내아들|막내|아들|장녀|차녀|삼녀|외동딸|외딸|막내딸|딸)\s*([가-힣]{1,4})?/g;
    while ((m = reRel.exec(raw))) {
      var rel = m[3].replace('외동아들', '외아들').replace('외딸', '외동딸').replace('막내아들', '막내').replace('막내딸', '막내');
      var boy = /남|아들/.test(m[3]) || (rel === '막내' && !/딸/.test(m[3]) && !f.groomRel);
      if (boy) { f.groomFather = f.groomFather || m[1]; f.groomMother = f.groomMother || m[2]; f.groomRel = f.groomRel || rel; if (m[4] && !f.groom) { f.groom = m[4]; flags.groom = m[4].length < 3; } }
      else { f.brideFather = f.brideFather || m[1]; f.brideMother = f.brideMother || m[2]; f.brideRel = f.brideRel || rel; if (m[4] && !f.bride) { f.bride = m[4]; flags.bride = m[4].length < 3; } }
    }
    // 2) 줄 단위로 신랑측/신부측을 나눠 혼주 찾기 ("신랑 아버지 김영수, 어머니 박미정")
    lines.forEach(function (line, li) {
      var parts = line.split(/(?=신랑|신부)/);
      parts.forEach(function (p) {
        var side = /^신랑/.test(p) ? 'groom' : /^신부/.test(p) ? 'bride' : '';
        if (!side) return;
        var fa = new RegExp('(아버지|부친|父)\\s*[:：]?\\s*(故\\s*)?' + NAME).exec(p), mo = new RegExp('(어머니|모친|母)\\s*[:：]?\\s*(故\\s*)?' + NAME).exec(p);
        if (fa && cleanName(fa[3])) { f[side + 'Father'] = f[side + 'Father'] || fa[3]; used[li] = 1; }
        if (mo && cleanName(mo[3])) { f[side + 'Mother'] = f[side + 'Mother'] || mo[3]; used[li] = 1; }
        var nm = new RegExp('^(신랑|신부)\\s*(이름|님)?\\s*[:：]?\\s*' + NAME + '(?![가-힣])').exec(p);
        if (nm && cleanName(nm[3]) && !/^(아버|어머|부친|모친|측|혼주)/.test(nm[3])) { if (!f[side]) f[side] = nm[3]; used[li] = 1; }
      });
    });
    // 3) 날짜
    var dm = /(\d{4})\s*[년.\-\/]\s*(\d{1,2})\s*[월.\-\/]\s*(\d{1,2})\s*일?/.exec(raw);
    if (dm) f.date = dm[1] + '-' + pad2(dm[2]) + '-' + pad2(dm[3]);
    else if ((dm = /(?:^|[^\d])(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(raw))) {
      var now = new Date(), y = now.getFullYear(), cand = new Date(y, +dm[1] - 1, +dm[2]);
      if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y += 1;
      f.date = y + '-' + pad2(dm[1]) + '-' + pad2(dm[2]); flags.date = true;
      notes.push('연도가 적혀 있지 않아 다가오는 ' + y + '년으로 넣었어요. 맞는지 확인해 주세요.');
    }
    if (f.date) { var wd = /(월|화|수|목|금|토|일)요일/.exec(raw), dt = new Date(f.date + 'T00:00'); if (wd && !isNaN(dt) && '일월화수목금토'.charAt(dt.getDay()) !== wd[1]) { flags.date = true; notes.push('입력한 요일(' + wd[1] + '요일)과 날짜의 실제 요일이 달라요. 날짜를 확인해 주세요.'); } }
    // 4) 시간
    var tm = /(오전|오후|낮|저녁|밤|AM|PM|am|pm)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분|(반))?/.exec(raw) || /(오전|오후|낮|저녁)?\s*(\d{1,2}):(\d{2})/.exec(raw);
    if (tm) {
      var h = +tm[2], mi = tm[4] ? 30 : (+tm[3] || 0), ap = tm[1] || '';
      if (/오후|저녁|밤|pm/i.test(ap) && h < 12) h += 12;
      else if (!ap && h >= 1 && h <= 9) { h += 12; flags.time = true; notes.push('오전/오후 표시가 없어 오후 ' + (h - 12) + '시로 넣었어요. 맞는지 확인해 주세요.'); }
      if (h <= 23 && mi <= 59) f.time = pad2(h) + ':' + pad2(mi);
    }
    // 5) 예식장 · 층 · 홀
    var lab = /(예식장|장소|웨딩홀|식장)\s*[:：]\s*(.+)/.exec(raw);
    var vline = lab ? lab[2] : '';
    if (!vline) lines.forEach(function (l, li) { if (!vline && VENUE_W.test(l) && !/주차|셔틀|버스|지하철|출구|주소/.test(l) && !/신랑|신부/.test(l)) { vline = l; used[li] = 1; } });
    if (vline) {
      if (dm) vline = vline.replace(dm[0].trim(), ' ');
      if (tm) vline = vline.replace(tm[0], ' ');
      vline = vline.replace(/(월|화|수|목|금|토|일)요일/g, ' ').replace(/\(\s*\)/g, ' ');
      var toks = vline.replace(/[,·]/g, ' ').split(/\s+/).filter(Boolean);
      if (toks.length > 1 && REGION.test(toks[0])) toks.shift();
      var fi = -1;
      toks.forEach(function (t, i) { if (fi < 0 && /^(지하\s*)?\d+층$|^B\d+(층)?$|^지하$/i.test(t)) fi = i; });
      if (fi >= 0) {
        f.floor = toks[fi]; f.venue = toks.slice(0, fi).join(' '); f.hall = toks.slice(fi + 1).join(' ');
      } else {
        var hi = -1; toks.forEach(function (t, i) { if (i > 0 && /(홀|룸|채플|가든|볼룸|스퀘어|테라스)$/.test(t)) hi = i; });
        if (hi > 0 && toks.length > 1 && hi === toks.length - 1) { f.venue = toks.slice(0, hi).join(' '); f.hall = toks[hi]; }
        else f.venue = toks.join(' ');
      }
    }
    // 6) 주소
    var am = /(주소\s*[:：]\s*)(.+)/.exec(raw);
    if (am) f.address = am[2].trim();
    else lines.forEach(function (l) { if (f.address) return; var ar = /((?:(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도))(?:특별시|광역시|특별자치시|특별자치도|도|시)?[ \t]+)?[가-힣]+(?:구|군|시)[ \t]+[가-힣0-9]+(?:로|길|동)(?:[ \t]*\d+(?:-\d+)?)?)/.exec(l); if (ar) f.address = ar[1].trim(); });
    // 7) 교통 (쉼표·마침표 단위로 나눠 분류)
    lines.forEach(function (l, li) {
      l.split(/[,，]|(?:\.\s)/).map(function (c) { return c.trim(); }).filter(Boolean).forEach(function (c) {
        var k = /셔틀/.test(c) ? 'shuttle' : /주차|발렛|자가용/.test(c) ? 'car' : /지하철|호선|역\s*\d*\s*번?\s*출구|출구/.test(c) ? 'subway' : /버스|정류장/.test(c) ? 'bus' : '';
        if (!k) return;
        f[k] = f[k] ? f[k] + '\n' + c : c; used[li] = 1;
      });
    });
    // 8) 기타 (정리되지 않은 줄)
    var known = [f.groom, f.bride, f.venue, f.address].filter(Boolean);
    var extra = lines.filter(function (l, li) {
      if (used[li]) return false;
      if (dm && l.indexOf(dm[0].trim()) >= 0) return false;
      if (tm && l.indexOf(tm[0]) >= 0 && l.length < tm[0].length + 14) return false;
      if (lab && l.indexOf(lab[0].split('\n')[0]) >= 0) return false;
      if (am && l.indexOf(am[0].split('\n')[0]) >= 0) return false;
      if (f.address && l.indexOf(f.address) >= 0) return false;
      if (/^(신랑|신부)/.test(l)) return false;
      if (reRel.test(l)) { reRel.lastIndex = 0; return false; }
      reRel.lastIndex = 0;
      return l.length > 1 && !known.some(function (k) { return l === k; });
    });
    if (extra.length) f.extra = extra.join('\n');
    if ((images || []).length) notes.unshift(config.mode === 'remote' ? '사진은 AI 서버에서 함께 분석했어요.' : '체험 모드에서는 사진 속 글자를 읽지 않아요(이미지 AI 미연결). 사진에 있는 정보는 아래 칸에 직접 입력하거나, 글로 함께 적어 주세요.');
    return { f: f, flags: flags, notes: notes, source: 'demo' };
  }
  function extractWeddingAsync(text, images) {
    if (config.mode === 'remote') {
      return fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'extractWedding', text: String(text || '').slice(0, 4000), images: (images || []).slice(0, 4) }) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          var base = extractWedding('', []), out = { f: base.f, flags: {}, notes: Array.isArray(j.notes) ? j.notes.map(function (x) { return str(x, 200); }) : [], source: 'remote' };
          Object.keys(base.f).forEach(function (k) { if (j.f && typeof j.f[k] === 'string') out.f[k] = str(j.f[k], k === 'extra' ? 1200 : 200); if (j.flags && j.flags[k]) out.flags[k] = true; });
          return out;
        })
        .catch(function () { var r = extractWedding(text, images); r.notes.unshift('AI 서버에 연결하지 못해 체험용 규칙으로 정리했어요.'); return r; });
    }
    return new Promise(function (res) { setTimeout(function () { res(extractWedding(text, images)); }, 700); });
  }

  /* ------------------------------------------------------------------ v10: 문구 'AI로 다듬기'
   * polish({ kind, text, request, n }) → Promise<{ text, note }>
   *  kind: invite | thanks | rsvp | account | guestphoto | custom
   *  사실 정보(날짜·장소·이름)는 넣거나 바꾸지 않습니다. 데모는 준비된 문구와 표현 규칙을 사용합니다.
   */
  var POL_STYLE = [[/따뜻|다정|포근/, 'warm', '따뜻한'], [/격식|정중|예의|공손|어른|부모님/, 'formal', '격식 있는'], [/밝|귀엽|귀여|발랄|유쾌|친근|재밌|재미/, 'cute', '밝고 귀여운'], [/감성|낭만|로맨틱|서정/, 'emotional', '감성적인'], [/담백|심플|단순|깔끔|오글/, 'plain', '담백한']];
  var GUESTPHOTO = {
    plain: ['결혼식에서 찍은 사진을 나눠 주세요.'],
    warm: ['함께해 주신 순간을 사진으로 나눠 주세요.\n오래도록 따뜻한 추억으로 간직하겠습니다.'],
    formal: ['예식 당일 촬영하신 사진을 공유해 주시면\n소중한 기록으로 간직하겠습니다.'],
    cute: ['그날 찍은 사진, 저희에게도 보내 주세요!\n한 장 한 장 소중히 볼게요.'],
    emotional: ['당신의 시선에 담긴 그날의 저희를\n함께 나눠 주세요.']
  };
  function softTone(t, style) {
    var s = String(t || '');
    if (style === 'formal') s = s.replace(/해요\./g, '합니다.').replace(/해요$/gm, '합니다').replace(/주세요\./g, '주시기 바랍니다.').replace(/있어요/g, '있습니다').replace(/돼요/g, '됩니다').replace(/예요/g, '입니다').replace(/이에요/g, '입니다');
    else if (style === 'cute' || style === 'warm') s = s.replace(/합니다\./g, '해요.').replace(/습니다\./g, '어요.').replace(/주시기 바랍니다/g, '주세요').replace(/입니다\./g, '이에요.');
    return s;
  }
  function polishDemo(o) {
    var req = String(o.request || ''), kind = o.kind || 'custom', cur = String(o.text || ''), n = o.n || 0;
    var style = '', label = '';
    POL_STYLE.forEach(function (p) { if (!style && p[0].test(req)) { style = p[1]; label = p[2]; } });
    var short = /짧|간결|줄여|간단|한\s?줄|요약/.test(req);
    if (!style && !short) { style = ['warm', 'formal', 'plain', 'emotional', 'cute'][n % 5]; label = { warm: '따뜻한', formal: '격식 있는', plain: '담백한', emotional: '감성적인', cute: '밝고 귀여운' }[style]; }
    var lib = kind === 'guestphoto' ? GUESTPHOTO : (window.IumPhrases && ['invite', 'thanks', 'rsvp', 'account'].indexOf(kind) >= 0 ? null : undefined);
    var pool = [];
    if (lib === null) {
      if (style) pool = window.IumPhrases.get(kind, style);
      else window.IumPhrases.styles.forEach(function (st) { pool = pool.concat(window.IumPhrases.get(kind, st.id)); });
    } else if (lib) pool = (lib[style] || []).concat(style ? [] : lib.plain);
    var out = '';
    if (pool.length) {
      if (short) pool = pool.slice().sort(function (a, b) { return a.length - b.length; });
      var cand = pool.filter(function (t) { return t.trim() !== cur.trim(); });
      out = (cand.length ? cand : pool)[n % (cand.length || pool.length)];
    } else {
      out = softTone(cur, style) || cur;
    }
    if (short && out) { var ls = out.split('\n').filter(function (x) { return x.trim(); }); if (ls.length > 3) out = ls.slice(0, 3).join('\n'); }
    var what = [label ? label + ' 분위기' : '', short ? '짧고 간결하게' : ''].filter(Boolean).join(', ');
    var note = (pool.length ? '' : '체험 모드에서는 직접 쓴 문장의 말투만 바꿔요. ') + (what ? what + '로 다듬었어요.' : '');
    if (out.trim() === cur.trim()) note = '지금 문구와 같은 결과예요. 다른 분위기를 요청해 보세요.';
    return { text: out, note: note };
  }
  function polish(o) {
    if (config.mode === 'remote') {
      return fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'polish', kind: o.kind, text: String(o.text || '').slice(0, 2000), request: String(o.request || '').slice(0, 300) }) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { return { text: str(j.text, 2000), note: str(j.note, 200) }; })
        .catch(function () { var r = polishDemo(o); r.note = 'AI 서버에 연결하지 못해 체험용 문구로 제안했어요. ' + r.note; return r; });
    }
    return new Promise(function (res) { setTimeout(function () { res(polishDemo(o)); }, 450); });
  }

  /* v13: 예식장 약도 · 교통 안내 이미지/PDF 분석 → { status:'ok'|'off'|'error', result:{ car, subway, bus, shuttle } }
   *  - 실제 AI(remote)가 연결된 경우에만 분석합니다. 데모 모드에서는 가상 결과를 만들지 않고 'off' 를 돌려줍니다.
   *  - 서버 요청: POST config.endpoint { task:'analyzeTransport', name, file(dataURL) } → { result:{ car, subway, bus, shuttle } } */
  function analyzeTransport(o) {
    o = o || {};
    if (config.mode !== 'remote') return Promise.resolve({ status: 'off', result: {} });
    if (!o.dataUrl) return Promise.resolve({ status: 'error', result: {} });
    return fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'analyzeTransport', name: str(o.name, 200), file: String(o.dataUrl).slice(0, 12000000) }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var res = {}; ['car', 'subway', 'bus', 'shuttle'].forEach(function (k) { res[k] = j && j.result && typeof j.result[k] === 'string' ? str(j.result[k], 600) : ''; });
        return { status: 'ok', result: res };
      })
      .catch(function () { return { status: 'error', result: {} }; });
  }

  window.IumAI = {
    analyzeTransport: analyzeTransport,
    config: config,
    respond: respond,
    demo: demoRespond,
    validateCommands: validateCommands,
    sanitizeResponse: sanitizeResponse,
    examples: EXAMPLES,
    layouts: LAYOUTS,
    layoutNames: LAYOUT_NAMES,
    extractWedding: extractWeddingAsync,
    parseWedding: extractWedding,
    polish: polish,
    _extract: extract,
    _norm: norm
  };
})();

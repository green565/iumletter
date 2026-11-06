/* 이움레터 — 청첩장 '오시는 길' 교통정보 자동 조회용 서버 함수 예시 (Netlify Functions) · v13
 *
 * 기본 배포에서는 동작하지 않습니다. 사용하려면:
 *  1) 이 파일을 netlify/functions/ium-transit.js 로 옮깁니다.
 *  2) netlify.toml 의 SPA 대체 규칙(/* → /index.html)보다 '위'에 아래 규칙을 추가합니다.
 *       [[redirects]]
 *         from = "/api/transit"
 *         to = "/.netlify/functions/ium-transit"
 *         status = 200
 *  3) Netlify 환경 변수에 KAKAO_REST_API_KEY (카카오 디벨로퍼스 REST API 키)를 넣습니다.
 *     (선택) 버스 정차 노선까지 넣으려면 공공데이터포털 '국토교통부_(TAGO)_버스정류소정보' 서비스 키를 TAGO_SERVICE_KEY 로 넣습니다.
 *  4) index.html 의 <head> 에서 app/ium-wedding-place.js 보다 먼저 아래 설정을 넣습니다.
 *       <script>window.IUM_WEDDING_PLACE_CONFIG = { placeEndpoint: '/api/place', transitEndpoint: '/api/transit' };</script>
 *
 * 응답 형식 (app/ium-wedding-place.js 의 transit() 이 문장으로 정리합니다)
 *  { parking: { own: { name, address, distance } | null, nearby: [{ name, address, distance, public }] },
 *    subway: [{ name, line, exit, distance }], bus: [{ name, distance, routes: [] }], shuttle: '' }
 *
 * 원칙
 *  - 카카오 로컬 API 로 '확인되는' 정보만 돌려줍니다. 주차 요금 · 무료 시간 · 지하철 출구 · 버스 노선은 확인된 경우에만 채웁니다.
 *  - 셔틀버스는 지도 데이터로 확인할 수 없으므로 항상 '' 입니다. (예식장 공식 안내문 · 업로드 자료에서만 입력)
 */
const KAKAO = 'https://dapi.kakao.com/v2/local';

async function kakao(path, params, key) {
  const url = KAKAO + path + '?' + new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!r.ok) throw new Error('kakao ' + r.status);
  return r.json();
}
function coreName(n) { return String(n || '').replace(/\s+/g, '').replace(/(웨딩홀|웨딩|컨벤션|예식장|주차장)$/g, ''); }

async function busRoutes(stop, tagoKey) {
  // (선택) TAGO 정류소별 경유노선 — 좌표로 가까운 정류소 ID 를 찾은 뒤 노선 목록 조회
  if (!tagoKey) return [];
  try {
    const base = 'https://apis.data.go.kr/1613000/BusSttnInfoInqireService';
    const q = new URLSearchParams({ serviceKey: tagoKey, gpsLati: stop.y, gpsLong: stop.x, _type: 'json', numOfRows: '1' });
    const a = await (await fetch(base + '/getCrdntPrxmtSttnList?' + q)).json();
    const it = a && a.response && a.response.body && a.response.body.items && a.response.body.items.item;
    const s = Array.isArray(it) ? it[0] : it; if (!s) return [];
    const q2 = new URLSearchParams({ serviceKey: tagoKey, cityCode: s.citycode, nodeid: s.nodeid, _type: 'json', numOfRows: '30' });
    const b = await (await fetch(base.replace('BusSttnInfoInqireService', 'BusRouteInfoInqireService') + '/getRouteAcctoThrghSttnList?' + q2)).json();
    const its = b && b.response && b.response.body && b.response.body.items && b.response.body.items.item;
    return (Array.isArray(its) ? its : its ? [its] : []).map(x => String(x.routeno || '')).filter(Boolean).slice(0, 12);
  } catch (e) { return []; }
}

exports.handler = async (event) => {
  const key = process.env.KAKAO_REST_API_KEY;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' };
  if (!key) return { statusCode: 503, headers, body: JSON.stringify({ error: 'not_configured' }) };
  const q = event.queryStringParameters || {};
  const name = String(q.name || '').slice(0, 80).trim();
  const address = String(q.address || '').slice(0, 160).trim();
  if (!name && !address) return { statusCode: 400, headers, body: JSON.stringify({ error: 'bad_request' }) };
  try {
    let pt = null;
    if (q.lat && q.lng && isFinite(+q.lat) && isFinite(+q.lng)) pt = { x: String(q.lng), y: String(q.lat), road: address, jibun: '' };
    if (!pt && address) {
      const a = await kakao('/search/address.json', { query: address, size: 1 }, key);
      const d = a.documents && a.documents[0];
      if (d) pt = { x: d.x, y: d.y, road: d.road_address ? d.road_address.address_name : '', jibun: d.address ? d.address.address_name : '' };
    }
    if (!pt && name) {
      const k = await kakao('/search/keyword.json', { query: name, size: 1 }, key);
      const d = k.documents && k.documents[0];
      if (d) pt = { x: d.x, y: d.y, road: d.road_address_name || '', jibun: d.address_name || '' };
    }
    if (!pt) return { statusCode: 200, headers, body: JSON.stringify({ parking: { own: null, nearby: [] }, subway: [], bus: [], shuttle: '' }) };

    // 주차장 (PK6) — 예식장과 같은 주소이거나 이름이 같은 주차장은 '예식장 주차장', 나머지는 인근 주차장
    const pk = await kakao('/search/category.json', { category_group_code: 'PK6', x: pt.x, y: pt.y, radius: 600, sort: 'distance', size: 10 }, key);
    const core = coreName(name);
    let own = null; const nearby = [];
    (pk.documents || []).forEach(p => {
      const same = (pt.road && p.road_address_name === pt.road) || (pt.jibun && p.address_name === pt.jibun);
      const isOwn = !!(same || (core.length >= 2 && String(p.place_name).replace(/\s+/g, '').includes(core)));
      const row = { name: p.place_name, address: p.road_address_name || p.address_name, distance: +p.distance, public: /공영/.test(p.place_name) };
      if (isOwn && !own) own = row; else nearby.push(row);
    });

    // 지하철역 (SW8) — 역 이름 · 노선 · 거리 (출구는 '○번 출구' 장소가 함께 검색될 때만)
    const sw = await kakao('/search/category.json', { category_group_code: 'SW8', x: pt.x, y: pt.y, radius: 1500, sort: 'distance', size: 3 }, key);
    const subway = [];
    for (const s of (sw.documents || []).slice(0, 2)) {
      const m = /^(.*역)\s*(.*)$/.exec(s.place_name) || [];
      let exit = '';
      try {
        const ex = await kakao('/search/keyword.json', { query: (m[1] || s.place_name) + ' 출구', x: pt.x, y: pt.y, radius: 600, sort: 'distance', size: 1 }, key);
        const e = ex.documents && ex.documents[0];
        const em = e ? /(\d+)\s*번\s*출구/.exec(e.place_name) : null;
        if (em) exit = em[1] + '번 출구';
      } catch (e) {}
      subway.push({ name: m[1] || s.place_name, line: (m[2] || '').trim(), exit, distance: +s.distance });
    }

    // 버스 정류장 — 키워드 '정류장' 근처 검색 (카테고리 코드가 없어 키워드 사용)
    const bs = await kakao('/search/keyword.json', { query: '버스정류장', x: pt.x, y: pt.y, radius: 400, sort: 'distance', size: 3 }, key);
    const bus = [];
    for (const s of (bs.documents || []).filter(d => /정류|버스/.test(d.category_name || '')).slice(0, 2)) {
      bus.push({ name: String(s.place_name).replace(/\s*(버스)?정류장$/, ''), distance: +s.distance, routes: await busRoutes(s, process.env.TAGO_SERVICE_KEY) });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ parking: { own, nearby: nearby.slice(0, 3) }, subway, bus, shuttle: '' }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'upstream' }) };
  }
};

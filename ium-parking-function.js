/* 이움레터 — 조문객 퀵 가이드 '주차' 조회용 서버 함수 예시 (Netlify Functions)
 *
 * 기본 배포에서는 동작하지 않습니다. 사용하려면:
 *  1) 이 파일을 netlify/functions/ium-parking.js 로 옮깁니다.
 *  2) netlify.toml 의 SPA 대체 규칙(/* → /index.html)보다 '위'에 아래 규칙을 추가합니다.
 *       [[redirects]]
 *         from = "/api/parking"
 *         to = "/.netlify/functions/ium-parking"
 *         status = 200
 *  3) Netlify 환경 변수에 KAKAO_REST_API_KEY (카카오 디벨로퍼스 REST API 키)를 넣습니다. 키는 프런트엔드 코드에 넣지 마세요.
 *  4) app/ium-guide.js 의 config.parkingEndpoint 를 '/api/parking' 으로 바꿉니다.
 *
 * 응답 형식: { lots: [{ name, address, lat, lng, distance, own, phone, placeUrl, fee: { type:'free'|'paid'|'mixed', text } | null, hours }] }
 *  - 카카오 로컬 API(주차장 카테고리 PK6)에는 요금·무료 여부·운영시간이 없습니다. 그래서 fee 는 null, hours 는 '' 로 둡니다.
 *  - 요금·운영시간을 보여주려면 공공데이터포털 '전국주차장정보표준데이터' 같은 출처를 이름·좌표로 대조해 채우세요.
 *    대조에 실패한 주차장은 비워 두어야 합니다. (화면은 '확인된 정보 없음'으로 표시)
 */
const KAKAO = 'https://dapi.kakao.com/v2/local';

async function kakao(path, params, key) {
  const url = KAKAO + path + '?' + new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!r.ok) throw new Error('kakao ' + r.status);
  return r.json();
}

function coreName(n) { return String(n || '').replace(/\s+/g, '').replace(/(장례식장|장례문화원|추모의집|장례예식장|장례식|주차장)$/g, ''); }

exports.handler = async (event) => {
  const key = process.env.KAKAO_REST_API_KEY;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' };
  if (!key) return { statusCode: 503, headers, body: JSON.stringify({ error: 'not_configured', lots: [] }) };
  const q = event.queryStringParameters || {};
  const name = String(q.name || '').slice(0, 80).trim();
  const address = String(q.address || '').slice(0, 160).trim();
  if (!name && !address) return { statusCode: 400, headers, body: JSON.stringify({ error: 'bad_request', lots: [] }) };
  try {
    // 1) 장례식장 위치(좌표) 찾기: 주소 → 실패하면 이름 검색
    let pt = null;
    if (address) {
      const a = await kakao('/search/address.json', { query: address, size: 1 }, key);
      const d = a.documents && a.documents[0];
      if (d) pt = { x: d.x, y: d.y, road: d.road_address ? d.road_address.address_name : '', jibun: d.address ? d.address.address_name : '' };
    }
    if (!pt && name) {
      const k = await kakao('/search/keyword.json', { query: name, size: 1 }, key);
      const d = k.documents && k.documents[0];
      if (d) pt = { x: d.x, y: d.y, road: d.road_address_name || '', jibun: d.address_name || '' };
    }
    if (!pt) return { statusCode: 200, headers, body: JSON.stringify({ lots: [] }) };
    // 2) 반경 700m 주차장(PK6), 가까운 순
    const c = await kakao('/search/category.json', { category_group_code: 'PK6', x: pt.x, y: pt.y, radius: 700, sort: 'distance', size: 15 }, key);
    const core = coreName(name);
    const lots = (c.documents || []).map(p => {
      const same = (pt.road && p.road_address_name === pt.road) || (pt.jibun && p.address_name === pt.jibun);
      const own = !!(same || (core.length >= 2 && String(p.place_name).replace(/\s+/g, '').includes(core)));
      return { name: p.place_name, address: p.road_address_name || p.address_name, lat: +p.y, lng: +p.x, distance: +p.distance, own, phone: p.phone || '', placeUrl: p.place_url || '', fee: null, hours: '' };
    });
    return { statusCode: 200, headers, body: JSON.stringify({ lots }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'upstream', lots: [] }) };
  }
};

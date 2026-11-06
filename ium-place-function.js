/**
 * 이움레터 v8 · 장례식장 검색 서버 함수 예시 (기본 배포에서는 동작하지 않음)
 *
 * 사용 방법
 * 1. 이 파일을 netlify/functions/ium-place.js 로 옮깁니다.
 * 2. netlify.toml / _redirects 에 SPA 규칙보다 위에 `/api/place  /.netlify/functions/ium-place  200` 을 추가합니다.
 * 3. Netlify 환경 변수 KAKAO_REST_KEY 에 카카오 REST API 키를 넣습니다. (프런트엔드 코드에 넣지 마세요)
 * 4. app/ium-guide.js 의 config.placeEndpoint = '/api/place' 로 바꿉니다.
 *
 * 응답 형식 (app/ium-guide.js 의 searchPlaces 가 그대로 사용)
 *   { places: [{ id, name, address(도로명), jibun, lat, lng, phone, category }] }
 * 검색 결과가 없으면 places: [] — 결과를 임의로 만들어 내지 않습니다.
 */
exports.handler = async (event) => {
  const q = String((event.queryStringParameters || {}).q || '').trim().slice(0, 60);
  if (!q) return { statusCode: 200, body: JSON.stringify({ places: [] }) };
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return { statusCode: 503, body: JSON.stringify({ error: 'not_configured' }) };
  const url = 'https://dapi.kakao.com/v2/local/search/keyword.json?size=15&query=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'upstream' }) };
  const j = await r.json();
  const places = (j.documents || []).map(d => ({
    id: 'kakao:' + d.id, name: d.place_name, address: d.road_address_name || '', jibun: d.address_name || '',
    lat: Number(d.y), lng: Number(d.x), phone: d.phone || '', category: d.category_name || ''
  }));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify({ places }) };
};

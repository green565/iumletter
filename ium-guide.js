/* 이움레터 — 부고장 '조문객 퀵 가이드' 공통 모듈 (window.IumGuide)
 *
 * 부고장 제작 화면의 실시간 미리보기와 받는 분(조문객) 화면이 같은 모듈을 씁니다.
 *  1) 지도 연결: 목적지(장례식장 또는 주차장)를 지도 앱·웹 지도로 엽니다.
 *     - 미리보기: 편집 중인 화면이 사라지지 않도록 항상 새 탭의 웹 지도로 엽니다.
 *     - PC: 새 탭의 웹 지도
 *     - Android: intent:// 주소로 앱 실행, 앱이 없으면 브라우저가 웹 지도로 대신 엽니다.
 *     - iOS: 앱 주소(scheme)로 실행을 시도하고, 앱이 열리지 않으면 '웹 지도로 열기' 버튼을 안내합니다.
 *       (Apple 지도 · 구글 지도는 https 주소라 앱이 있으면 앱, 없으면 웹으로 열립니다.)
 *  2) 주차장 조회: 장례식장 이름·주소로 장례식장 주차장과 인근 주차장을 찾습니다.
 *     - 'kakao'  : 카카오맵 JavaScript SDK(services) — config.kakaoJsKey 필요, 사이트 도메인 등록 필요
 *     - 'remote' : 서버 함수(config.parkingEndpoint) — docs/server-example/ium-parking-function.js 참고
 *     - 키·서버가 없으면 조회하지 않고 '확인된 주차장 정보가 없습니다'를 보여줍니다.
 *     - 데모용 가상 장례식장(주소에 '가상 주소' 포함)은 체험용 예시 주차장을 '예시' 표시와 함께 보여줍니다.
 *     요금·무료 여부·운영시간은 조회 결과에 실제로 들어 있을 때만 표시합니다. (카카오 장소 검색에는 요금 정보가 없습니다)
 *
 * 설정 바꾸기: 이 파일의 config 값을 고치거나, 이 스크립트보다 먼저
 *   <script>window.IUM_GUIDE_CONFIG = { kakaoJsKey: '...', parkingRadius: 700 }</script> 를 넣으세요.
 */
(function () {
  'use strict';

  var config = {
    kakaoJsKey: '',            // 카카오 디벨로퍼스 JavaScript 키 (플랫폼 > Web 에 사이트 도메인 등록)
    parkingEndpoint: '',       // 예: '/api/parking'  (서버 함수를 배포한 경우)
    placeEndpoint: '',         // 예: '/api/place'    장례식장 검색 서버 함수 (docs/server-example/ium-place-function.js)
    placeLimit: 10,            // 장례식장 검색 결과 최대 개수
    parkingRadius: 700,        // 인근 주차장 검색 반경(m)
    parkingLimit: 6,           // 최대 표시 개수
    timeoutMs: 9000,
    appName: 'iumletter'       // 네이버 지도 앱 호출 시 appname 값 (보통 사이트 도메인)
  };
  try { if (window.IUM_GUIDE_CONFIG && typeof window.IUM_GUIDE_CONFIG === 'object') Object.keys(window.IUM_GUIDE_CONFIG).forEach(function (k) { config[k] = window.IUM_GUIDE_CONFIG[k]; }); } catch (e) {}

  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function str(s) { return String(s == null ? '' : s).trim(); }
  function num(n) { var x = Number(n); return isFinite(x) ? x : null; }

  /* ------------------------------------------------------------ 기기 판별 */
  function env() {
    var ua = (navigator.userAgent || '');
    var iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    var android = /Android/i.test(ua);
    return { iOS: iOS, android: android, mobile: iOS || android || /Mobi/i.test(ua) };
  }

  /* ------------------------------------------------------------ 지도 주소 */
  // dest: { name, address, lat, lng }
  function hasCoord(d) { return d && num(d.lat) !== null && num(d.lng) !== null && !(+d.lat === 0 && +d.lng === 0); }
  function query(d) { return str(d.address) || str(d.name); }
  function label(d) { return str(d.name) || str(d.address) || '목적지'; }

  var PROVIDERS = {
    kakao: {
      label: '카카오맵',
      web: function (d) { return hasCoord(d) ? 'https://map.kakao.com/link/to/' + enc(label(d)) + ',' + d.lat + ',' + d.lng : 'https://map.kakao.com/link/search/' + enc(query(d)); },
      app: function (d) { return hasCoord(d) ? 'kakaomap://route?ep=' + d.lat + ',' + d.lng + '&by=CAR' : 'kakaomap://search?q=' + enc(query(d)); }
    },
    naver: {
      label: '네이버 지도',
      web: function (d) { return 'https://map.naver.com/p/search/' + enc(hasCoord(d) ? (str(d.address) || label(d)) : query(d)); },
      app: function (d) {
        var an = enc(config.appName || location.hostname || 'iumletter');
        return hasCoord(d) ? 'nmap://route/car?dlat=' + d.lat + '&dlng=' + d.lng + '&dname=' + enc(label(d)) + '&appname=' + an : 'nmap://search?query=' + enc(query(d)) + '&appname=' + an;
      }
    },
    tmap: {
      label: '티맵',
      mobileOnly: true,
      web: function (d) { return PROVIDERS.kakao.web(d); }, // 티맵은 웹 지도가 없어 앱이 없으면 카카오맵 웹으로 안내
      app: function (d) { return hasCoord(d) ? 'tmap://route?goalname=' + enc(label(d)) + '&goalx=' + d.lng + '&goaly=' + d.lat : 'tmap://search?name=' + enc(query(d)); }
    },
    google: {
      label: '구글 지도',
      web: function (d) { return 'https://www.google.com/maps/dir/?api=1&destination=' + enc(hasCoord(d) ? d.lat + ',' + d.lng : query(d)); }
    },
    apple: {
      label: 'Apple 지도',
      iOSOnly: true,
      web: function (d) { return 'https://maps.apple.com/?daddr=' + enc(hasCoord(d) ? d.lat + ',' + d.lng : query(d)) + (str(d.name) ? '&q=' + enc(d.name) : ''); }
    }
  };

  // 화면에 보여줄 지도 선택지 (기기에 맞춰 순서·종류 조정)
  function providers(opts) {
    var e = env(); var preview = !!(opts && opts.preview);
    var ids = (e.mobile && !preview) ? (e.iOS ? ['kakao', 'naver', 'tmap', 'apple', 'google'] : ['kakao', 'naver', 'tmap', 'google']) : ['kakao', 'naver', 'google'];
    return ids.map(function (id) { return { id: id, label: PROVIDERS[id].label, app: !!PROVIDERS[id].app && e.mobile && !preview }; });
  }

  function webUrl(id, d) { var p = PROVIDERS[id] || PROVIDERS.kakao; return p.web(d); }

  function openNewTab(url) {
    // 'noopener' 옵션을 주면 window.open 이 항상 null 을 돌려줘 성공 여부를 알 수 없으므로, 연 뒤 opener 를 끊습니다.
    var w = null;
    try { w = window.open(url, '_blank'); if (w) { try { w.opener = null; } catch (e1) {} } } catch (e) {}
    if (!w) {
      // 팝업이 막힌 환경: 새 탭 링크를 직접 눌러 엽니다.
      try { var a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; document.body.appendChild(a); a.click(); document.body.removeChild(a); } catch (e2) {}
    }
  }

  /* open(id, dest, { preview, onFallback(webUrl) })
   * 반환: 'web' | 'app' | 'intent' */
  function open(id, dest, opts) {
    opts = opts || {};
    var p = PROVIDERS[id] || PROVIDERS.kakao; var e = env();
    var web = p.web(dest);
    if (opts.preview || !e.mobile || !p.app) { openNewTab(web); return 'web'; }
    var app = p.app(dest);
    if (e.android) {
      // intent:// → 앱이 있으면 앱, 없으면 브라우저가 S.browser_fallback_url(웹 지도)로 이동
      var i = app.indexOf('://'); var scheme = app.slice(0, i); var rest = app.slice(i + 3);
      location.href = 'intent://' + rest + '#Intent;scheme=' + scheme + ';S.browser_fallback_url=' + enc(web) + ';end';
      return 'intent';
    }
    // iOS 등: 앱 주소로 시도 → 1.6초 뒤에도 화면이 그대로면 앱이 없는 것으로 보고 웹 지도 버튼 안내
    var left = false;
    var onHide = function () { if (document.hidden) left = true; };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    setTimeout(function () {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (!left && !document.hidden && typeof opts.onFallback === 'function') opts.onFallback(web);
    }, 1600);
    try { location.href = app; } catch (err) { if (typeof opts.onFallback === 'function') opts.onFallback(web); }
    return 'app';
  }

  /* ------------------------------------------------------------ 주차장 조회 */
  var cache = {};
  function keyOf(h) { return (str(h && h.name) + '|' + str(h && h.address)).toLowerCase(); }

  function isDemoHall(h) { return /가상\s*주소/.test(str(h && h.address)) || /가상\s*주소/.test(str(h && h.name)); }

  // 체험용 가상 장례식장 전용 예시 데이터 (실제 장소 아님 — 화면에 '예시'로 표시)
  function demoLots(h) {
    var base = str(h.name).replace(/\s*(장례식장|장례문화원|추모의집|장례예식장)\s*$/, '') || '장례식장';
    var road = str(h.address).replace(/\s*\(가상 주소\)\s*$/, '');
    return [
      { name: str(h.name) + ' 주차장', address: str(h.address), own: true, distance: 0, fee: { type: 'free', text: '조문객 이용 시 (예시)' }, hours: '24시간 (예시)', demo: true },
      { name: base + ' 공영주차장 (예시)', address: road + ' 인근 (가상 주소)', own: false, distance: 180, fee: { type: 'paid', text: '30분 1,000원 (예시)' }, hours: '평일 08:00–22:00 (예시)', demo: true },
      { name: '이움로 노상 공영주차장 (예시)', address: road + ' 건너편 (가상 주소)', own: false, distance: 320, fee: null, hours: '', demo: true }
    ];
  }

  // 결과 정리: 확인되지 않은 항목은 비워 둡니다.
  function cleanLot(x) {
    if (!x || typeof x !== 'object') return null;
    var name = str(x.name).slice(0, 80); if (!name) return null;
    var fee = null;
    if (x.fee && typeof x.fee === 'object') {
      var t = ['free', 'paid', 'mixed'].indexOf(x.fee.type) >= 0 ? x.fee.type : '';
      var tx = str(x.fee.text).slice(0, 120);
      if (t || tx) fee = { type: t, text: tx };
    }
    return {
      name: name, address: str(x.address).slice(0, 160), own: !!x.own,
      lat: num(x.lat), lng: num(x.lng), distance: num(x.distance),
      fee: fee, hours: str(x.hours).slice(0, 120), phone: str(x.phone).slice(0, 30),
      placeUrl: /^https?:\/\//.test(str(x.placeUrl)) ? str(x.placeUrl).replace(/^http:/, 'https:') : '', demo: !!x.demo
    };
  }

  function coreName(n) { return str(n).replace(/\s+/g, '').replace(/(장례식장|장례문화원|추모의집|장례예식장|장례식|주차장)$/g, ''); }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }

  // 카카오맵 JavaScript SDK
  var sdkP = null;
  function loadKakao() {
    if (sdkP) return sdkP;
    sdkP = new Promise(function (res, rej) {
      if (window.kakao && window.kakao.maps && window.kakao.maps.services) { res(window.kakao); return; }
      var s = document.createElement('script');
      s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + enc(config.kakaoJsKey) + '&libraries=services&autoload=false';
      s.async = true;
      s.onload = function () { try { window.kakao.maps.load(function () { res(window.kakao); }); } catch (e) { rej(e); } };
      s.onerror = function () { sdkP = null; rej(new Error('sdk')); };
      document.head.appendChild(s);
    });
    return sdkP;
  }

  function kakaoLookup(h) {
    return loadKakao().then(function (kakao) {
      var sv = kakao.maps.services; var places = new sv.Places(); var geo = new sv.Geocoder();
      var locate = new Promise(function (res) {
        var byName = function () {
          if (!str(h.name)) { res(null); return; }
          places.keywordSearch(str(h.name), function (r, st) { res(st === sv.Status.OK && r[0] ? { x: +r[0].x, y: +r[0].y, road: r[0].road_address_name || '', jibun: r[0].address_name || '' } : null); });
        };
        if (str(h.address)) geo.addressSearch(str(h.address), function (r, st) { if (st === sv.Status.OK && r[0]) res({ x: +r[0].x, y: +r[0].y, road: (r[0].road_address && r[0].road_address.address_name) || '', jibun: (r[0].address && r[0].address.address_name) || '' }); else byName(); });
        else byName();
      });
      return locate.then(function (pt) {
        if (!pt) return { status: 'empty', lots: [], source: 'kakao' };
        return new Promise(function (res) {
          places.categorySearch('PK6', function (r, st) {
            if (st !== sv.Status.OK || !r || !r.length) { res({ status: 'empty', lots: [], source: 'kakao' }); return; }
            var core = coreName(h.name);
            var lots = r.map(function (p) {
              var sameAddr = (pt.road && p.road_address_name === pt.road) || (pt.jibun && p.address_name === pt.jibun);
              var own = !!(sameAddr || (core.length >= 2 && str(p.place_name).replace(/\s+/g, '').indexOf(core) >= 0));
              return cleanLot({ name: p.place_name, address: p.road_address_name || p.address_name, lat: p.y, lng: p.x, distance: p.distance, own: own, phone: p.phone, placeUrl: p.place_url });
            }).filter(Boolean);
            res({ status: lots.length ? 'ok' : 'empty', lots: lots, source: 'kakao' });
          }, { location: new kakao.maps.LatLng(pt.y, pt.x), radius: config.parkingRadius, sort: sv.SortBy.DISTANCE });
        });
      });
    });
  }

  function remoteLookup(h) {
    var url = config.parkingEndpoint + (config.parkingEndpoint.indexOf('?') >= 0 ? '&' : '?') + 'name=' + enc(h.name) + '&address=' + enc(h.address);
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(function (j) {
      var lots = (j && Array.isArray(j.lots) ? j.lots : []).map(cleanLot).filter(Boolean);
      return { status: lots.length ? 'ok' : 'empty', lots: lots, source: 'remote' };
    });
  }

  function sortLots(lots) {
    return lots.slice().sort(function (a, b) {
      if (a.own !== b.own) return a.own ? -1 : 1;
      return (a.distance == null ? 1e9 : a.distance) - (b.distance == null ? 1e9 : b.distance);
    }).slice(0, config.parkingLimit);
  }

  /* lookupParking({ name, address }) → Promise<{ status:'ok'|'empty'|'off'|'error', lots, source }>
   *  - 'off'   : 지도 API(키·서버)가 연결되지 않음
   *  - 'empty' : 조회했지만 주차장을 찾지 못함
   *  - 'error' : 조회 중 오류 */
  function lookupParking(h) {
    h = { name: str(h && h.name), address: str(h && h.address) };
    if (!h.name && !h.address) return Promise.resolve({ status: 'empty', lots: [], source: 'none' });
    var k = keyOf(h);
    if (cache[k]) return cache[k];
    var p;
    if (isDemoHall(h)) p = new Promise(function (res) { setTimeout(function () { res({ status: 'ok', lots: demoLots(h).map(cleanLot), source: 'demo' }); }, 450); });
    else if (config.kakaoJsKey) p = withTimeout(kakaoLookup(h), config.timeoutMs);
    else if (config.parkingEndpoint) p = withTimeout(remoteLookup(h), config.timeoutMs);
    else p = Promise.resolve({ status: 'off', lots: [], source: 'none' });
    p = p.then(function (r) { r.lots = sortLots(r.lots || []); if (!r.lots.length && r.status === 'ok') r.status = 'empty'; return r; }, function () { delete cache[k]; return { status: 'error', lots: [], source: config.kakaoJsKey ? 'kakao' : 'remote' }; });
    cache[k] = p;
    return p;
  }

  /* ---------- 장례식장 검색 (v8) ----------
   * 반환: Promise<{ status: 'ok'|'empty'|'off'|'error', source: 'kakao'|'remote'|'none', places: [{ id, name, address(도로명), jibun, lat, lng, phone, category }] }>
   * - 카카오 SDK(config.kakaoJsKey) 또는 서버 함수(config.placeEndpoint)가 있을 때만 실제로 조회합니다.
   * - 둘 다 없으면 status 'off' — 검색 결과를 만들어 내지 않습니다. (화면은 '체험용 가상 장소'만 따로 표시) */
  function placeSearchMode() { return config.kakaoJsKey ? 'kakao' : (config.placeEndpoint ? 'remote' : 'off'); }
  function funeralFirst(list) {
    var re = /장례|추모|빈소|영안/;
    return list.slice().sort(function (a, b) { return (re.test(b.name + ' ' + b.category) ? 1 : 0) - (re.test(a.name + ' ' + a.category) ? 1 : 0); });
  }
  function kakaoPlaces(q) {
    return loadKakao().then(function (kakao) {
      var places = new kakao.maps.services.Places(); var sv = kakao.maps.services;
      return new Promise(function (res) {
        places.keywordSearch(q, function (r, st) {
          if (st === sv.Status.ZERO_RESULT) return res({ status: 'empty', places: [], source: 'kakao' });
          if (st !== sv.Status.OK) return res({ status: 'error', places: [], source: 'kakao' });
          var list = r.map(function (p) { return { id: 'kakao:' + p.id, name: str(p.place_name), address: str(p.road_address_name), jibun: str(p.address_name), lat: num(p.y), lng: num(p.x), phone: str(p.phone), category: str(p.category_name) }; });
          res({ status: 'ok', places: funeralFirst(list).slice(0, config.placeLimit), source: 'kakao' });
        }, { size: 15 });
      });
    });
  }
  function remotePlaces(q) {
    return fetch(config.placeEndpoint + (config.placeEndpoint.indexOf('?') >= 0 ? '&' : '?') + 'q=' + enc(q), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) { var list = (j && j.places || []).map(function (p) { return { id: str(p.id), name: str(p.name), address: str(p.address), jibun: str(p.jibun), lat: num(p.lat), lng: num(p.lng), phone: str(p.phone), category: str(p.category) }; }).filter(function (p) { return p.name; }); return { status: list.length ? 'ok' : 'empty', places: funeralFirst(list).slice(0, config.placeLimit), source: 'remote' }; });
  }
  function searchPlaces(q) {
    q = str(q); if (!q) return Promise.resolve({ status: 'empty', places: [], source: 'none' });
    var mode = placeSearchMode();
    if (mode === 'off') return Promise.resolve({ status: 'off', places: [], source: 'none' });
    var p = mode === 'kakao' ? kakaoPlaces(q) : remotePlaces(q);
    return withTimeout(p, config.timeoutMs).then(null, function () { return { status: 'error', places: [], source: mode }; });
  }

  // 지도 앱에서 '주변 주차장'을 직접 찾아보는 검색 링크 (API 없이도 동작, 데이터를 만들어 내지 않음)
  function nearbySearchUrl(h) {
    var q = (str(h && h.address) || str(h && h.name)) + ' 주차장';
    return 'https://map.kakao.com/link/search/' + enc(q);
  }

  window.IumGuide = {
    config: config,
    env: env,
    providers: providers,
    webUrl: webUrl,
    open: open,
    openNewTab: openNewTab,
    lookupParking: lookupParking,
    parkingKey: keyOf,
    isDemoHall: isDemoHall,
    nearbySearchUrl: nearbySearchUrl,
    searchPlaces: searchPlaces,
    placeSearchMode: placeSearchMode,
    apiConnected: function () { return !!(config.kakaoJsKey || config.parkingEndpoint); }
  };
})();

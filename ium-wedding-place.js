/* 이움레터 — 청첩장 전용 '예식장 장소 검색' 모듈 (window.IumWeddingPlace)
 *
 * 부고장의 app/ium-guide.js 와 완전히 분리된 청첩장 전용 파일입니다. (부고장 동작에 영향 없음)
 *
 * 실제 장소 검색 연결 방법 (둘 중 하나)
 *  1) 카카오맵 JavaScript SDK  : config.kakaoJsKey 에 JavaScript 키 입력 (카카오 디벨로퍼스 > 플랫폼 > Web 에 사이트 도메인 등록)
 *  2) 서버 함수(권장)          : config.placeEndpoint = '/api/place'
 *     - docs/server-example/ium-place-function.js (카카오 로컬 키워드 검색 · REST 키는 서버 환경변수에만)
 *     - 응답 형식 { places: [{ id, name, address(도로명), jibun, lat, lng, phone, category }] }
 *  네이버 지역 검색 API 도 같은 응답 형식으로 서버 함수를 만들면 그대로 연결됩니다.
 *
 * 둘 다 없으면 status 'off' 를 돌려주고, 검색 결과를 만들어 내지 않습니다.
 * (화면에서는 '직접 입력' 또는 '체험용 가상 장소'를 별도로, 명확히 표시합니다)
 *
 * 설정 바꾸기: 이 스크립트보다 먼저 <script>window.IUM_WEDDING_PLACE_CONFIG = { placeEndpoint: '/api/place' }</script>
 */
(function () {
  'use strict';
  var config = {
    kakaoJsKey: '',
    placeEndpoint: '',
    transitEndpoint: '',   // v13: 예식장 위치 기반 교통정보 조회 서버 함수 (예: '/api/transit' · docs/server-example/ium-transit-function.js)
    limit: 10,
    timeoutMs: 9000
  };
  try { var c = window.IUM_WEDDING_PLACE_CONFIG; if (c && typeof c === 'object') Object.keys(c).forEach(function (k) { config[k] = c[k]; }); } catch (e) {}

  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function str(s) { return String(s == null ? '' : s).trim(); }
  function num(n) { var x = Number(n); return isFinite(x) ? x : null; }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  // 예식장 관련 장소를 앞으로 (순서만 바꾸고 결과를 추가·삭제하지 않음)
  function weddingFirst(list) {
    var re = /웨딩|예식|컨벤션|채플|호텔|가든|하우스|볼룸|성당|교회/;
    return list.map(function (p, i) { return { p: p, i: i, w: re.test(p.name + ' ' + p.category) ? 0 : 1 }; })
      .sort(function (a, b) { return a.w - b.w || a.i - b.i; }).map(function (x) { return x.p; });
  }
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
  function norm(p) { return { id: str(p.id), name: str(p.name), address: str(p.address), jibun: str(p.jibun), lat: num(p.lat), lng: num(p.lng), phone: str(p.phone), category: str(p.category) }; }
  function kakaoSearch(q) {
    return loadKakao().then(function (kakao) {
      var sv = kakao.maps.services, places = new sv.Places();
      return new Promise(function (res) {
        places.keywordSearch(q, function (r, st) {
          if (st === sv.Status.ZERO_RESULT) return res({ status: 'empty', places: [], source: 'kakao' });
          if (st !== sv.Status.OK) return res({ status: 'error', places: [], source: 'kakao' });
          var list = r.map(function (p) { return norm({ id: 'kakao:' + p.id, name: p.place_name, address: p.road_address_name, jibun: p.address_name, lat: p.y, lng: p.x, phone: p.phone, category: p.category_name }); });
          res({ status: 'ok', places: weddingFirst(list).slice(0, config.limit), source: 'kakao' });
        }, { size: 15 });
      });
    });
  }
  function remoteSearch(q) {
    return fetch(config.placeEndpoint + (config.placeEndpoint.indexOf('?') >= 0 ? '&' : '?') + 'q=' + enc(q), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        var list = (j && j.places || []).map(norm).filter(function (p) { return p.name; });
        return { status: list.length ? 'ok' : 'empty', places: weddingFirst(list).slice(0, config.limit), source: 'remote' };
      });
  }
  function mode() { return config.kakaoJsKey ? 'kakao' : (config.placeEndpoint ? 'remote' : 'off'); }
  // 반환: Promise<{ status: 'ok'|'empty'|'off'|'error', source, places: [...] }>
  function search(q) {
    q = str(q).slice(0, 60);
    if (!q) return Promise.resolve({ status: 'empty', places: [], source: 'none' });
    var m = mode();
    if (m === 'off') return Promise.resolve({ status: 'off', places: [], source: 'none' });
    var p = m === 'kakao' ? kakaoSearch(q) : remoteSearch(q);
    return withTimeout(p, config.timeoutMs).then(null, function () { return { status: 'error', places: [], source: m }; });
  }
  /* v13: 예식장 위치 기반 교통정보 조회
   * transit({ name, address, lat, lng }) → Promise<{ status: 'ok'|'empty'|'off'|'error', source, info: { car, subway, bus, shuttle }, raw }>
   *  - 서버 함수(config.transitEndpoint)가 없으면 'off' 를 돌려주고 아무 정보도 만들지 않습니다.
   *  - 서버 응답 형식: { parking: { own: {name,address,distance}|null, nearby: [{name,address,distance}] },
   *                     subway: [{ name, line, exit, distance }], bus: [{ name, distance, routes: [] }], shuttle: '' }
   *  - 셔틀버스는 장소 검색으로 확인할 수 없으므로 서버가 공식 안내문에서 확인한 경우(shuttle 문자열)에만 채웁니다.
   */
  function meters(n) { n = Number(n); if (!isFinite(n) || n <= 0) return ''; return n >= 1000 ? '약 ' + (Math.round(n / 100) / 10) + 'km' : '약 ' + (Math.round(n / 10) * 10) + 'm'; }
  function walk(n) { n = Number(n); if (!isFinite(n) || n <= 0) return ''; return '도보 약 ' + Math.max(1, Math.round(n / 67)) + '분'; }
  function fmtTransit(j) {
    var out = { car: '', subway: '', bus: '', shuttle: '' };
    var pk = j && j.parking || {};
    if (pk.own && str(pk.own.name)) {
      out.car = '주차 가능 · 예식장 주차장\n' + str(pk.own.name) + (str(pk.own.address) ? ' (' + str(pk.own.address) + ')' : '');
      if (str(pk.own.fee)) out.car += '\n' + str(pk.own.fee);
    } else if (Array.isArray(pk.nearby) && pk.nearby.length) {
      out.car = '예식장 자체 주차장은 확인되지 않았어요. 인근 주차장을 이용해 주세요.\n' + pk.nearby.slice(0, 2).map(function (x) {
        return '· ' + str(x.name) + (x.public ? ' (공영)' : '') + (meters(x.distance) ? ' · ' + meters(x.distance) : '') + (str(x.fee) ? ' · ' + str(x.fee) : '');
      }).join('\n');
    }
    if (Array.isArray(j && j.subway) && j.subway.length) {
      out.subway = j.subway.slice(0, 2).map(function (x) {
        return str(x.name) + (str(x.line) ? ' ' + str(x.line) : '') + (str(x.exit) ? ' ' + str(x.exit) : '') + (x.distance ? ' · ' + walk(x.distance) + ' (' + meters(x.distance) + ')' : '');
      }).join('\n');
    }
    if (Array.isArray(j && j.bus) && j.bus.length) {
      out.bus = j.bus.slice(0, 2).map(function (x) {
        var r = Array.isArray(x.routes) && x.routes.length ? '\n  정차 노선: ' + x.routes.slice(0, 8).map(str).join(', ') : '';
        return str(x.name) + ' 정류장' + (x.distance ? ' 하차 · ' + walk(x.distance) : '') + r;
      }).join('\n');
    }
    if (str(j && j.shuttle)) out.shuttle = str(j.shuttle).slice(0, 400);
    return out;
  }
  function transit(place) {
    place = place || {};
    if (!config.transitEndpoint) return Promise.resolve({ status: 'off', source: 'none', info: { car: '', subway: '', bus: '', shuttle: '' } });
    var qs = 'name=' + enc(str(place.name).slice(0, 80)) + '&address=' + enc(str(place.address).slice(0, 160)) + (place.lat != null ? '&lat=' + enc(place.lat) + '&lng=' + enc(place.lng) : '');
    var p = fetch(config.transitEndpoint + (config.transitEndpoint.indexOf('?') >= 0 ? '&' : '?') + qs, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        var info = fmtTransit(j);
        var any = Object.keys(info).some(function (k) { return !!info[k]; });
        return { status: any ? 'ok' : 'empty', source: 'remote', info: info, raw: j };
      });
    return withTimeout(p, config.timeoutMs).then(null, function () { return { status: 'error', source: 'remote', info: { car: '', subway: '', bus: '', shuttle: '' } }; });
  }
  /* v14: 체험 모드용 '사전 확인 예식장 데이터' (실제로 존재하는 예식장 · 공개 자료로 확인한 도로명주소)
   *  - 장소 검색 서비스가 연결되지 않은 체험 모드에서만 사용합니다. 실제 검색(카카오 · 서버 함수)이 연결되면 쓰지 않습니다.
   *  - 주소: 웨딩홀 정보 사이트 · 행사 안내 페이지에서 확인 (sources 참고, 확인일 checkedAt)
   *  - 교통 안내: 공개 자료를 바탕으로 정리한 '체험용 예시'입니다. 예식장 운영 정책(무료 주차 시간 · 셔틀 등)은 바뀔 수 있으므로
   *    화면에서 항상 '체험용 예시 · 발행 전 확인'으로 표시하고, 발행 전에 제작자가 확인해야 공개됩니다.
   *  - 확인하지 못한 항목은 비워 둡니다(지어내지 않음).
   */
  var CATALOG = [
    { key: 'bexco-wedding', name: '부산벡스코웨딩홀', aliases: ['벡스코웨딩홀', '벡스코웨딩', '벡스코 웨딩홀', 'BEXCO웨딩홀', '부산벡스코웨딩'], group: ['벡스코'],
      address: '부산광역시 해운대구 APEC로 55', jibun: '', detail: '벡스코 제1전시장 지하1층', category: '웨딩홀 > 컨벤션',
      transport: {
        car: '벡스코 주차장 이용 (약 1,500대)\n하객 무료 주차 1시간 · 이후 60분당 1,800원\n주차권 등록 위치는 예식 당일 안내데스크에 문의해 주세요',
        subway: '부산 지하철 2호선 벡스코(시립미술관)역 하차 후 도보 약 3분\n동해선 센텀시티역 이용 시 벡스코 방향 지하통로로 이동',
        bus: '센텀시티역·벡스코 정류장 하차\n일반버스 5-1, 39, 40, 63, 115, 141, 155, 181번 · 급행버스 1001, 1002번\n벡스코(시립미술관) 정류장 하차\n일반버스 31, 39, 40, 63, 100, 100-1, 115-1, 139, 141, 181, 200번',
        shuttle: ''
      },
      sources: ['https://www.directwedding.co.kr/weddinghall/hall0239', 'https://ictweek.kr/ko/html/06_board/map.php', 'https://netzeroexpo.or.kr/Contents.asp?LoadPage=Location'] },
    { key: 'busan-w-wedding', name: '부산W웨딩 팔레드시즈', aliases: ['W웨딩홀', 'W웨딩', '부산W웨딩', '부산W웨딩홀', '팔레드시즈웨딩홀', '팔레드시즈', '부산W웨딩팔레드시즈웨딩홀'], group: [],
      address: '부산광역시 해운대구 해운대해변로298번길 24', jibun: '부산 해운대구 중동 1124-2', detail: '', category: '웨딩홀',
      transport: {
        car: '건물 주차장 이용 (약 700대)\n하객 무료 주차 3시간',
        subway: '부산 지하철 2호선 해운대역 3번 출구 이용\n출구에서 예식장까지 도보 이동',
        bus: '', shuttle: ''
      },
      sources: ['https://www.directwedding.co.kr/weddinghall/hall0227', 'https://www.ifamily.co.kr/icard/main/card_view/235421'] },
    { key: 'thechapel-cheongdam', name: '더채플앳청담', aliases: ['더채플앳청담', '더채플 청담', '채플앳청담', '더채플앳청담웨딩홀'], group: ['더채플', '채플앳', '더채플웨딩홀'],
      address: '서울특별시 강남구 선릉로 757', jibun: '', detail: '', category: '웨딩홀 > 채플',
      transport: {
        car: '예식장 주차장 이용 (내부 약 200대 · 외부 약 300대)\n하객 무료 주차 1시간 30분',
        subway: '지하철 7호선 · 수인분당선 강남구청역 3-1번 출구에서 도보 약 8분',
        bus: '',
        shuttle: '예식 당일 셔틀버스 운행\n승차 장소와 운행 간격은 예식장 안내문을 확인해 주세요'
      },
      sources: ['https://weddingcrowd.kr/hall/view.php?idx=1233', 'https://smartwedding-besthall.com/thechapel', 'https://thefirstwedding.com/114/?idx=51', 'https://www.directwedding.co.kr/weddinghall/hall0141'] },
    { key: 'thechapel-nonhyeon', name: '더채플앳논현', aliases: ['더채플앳논현', '더채플 논현', '채플앳논현'], group: ['더채플', '채플앳', '더채플웨딩홀'],
      address: '서울특별시 강남구 논현로 549', jibun: '', detail: '와이타워', category: '웨딩홀 > 채플',
      transport: {
        car: '건물 주차장 이용 (유료 운영)\n하객 무료 주차 시간은 예식장에 확인해 주세요',
        subway: '지하철 9호선 언주역 인근\n출구 번호와 도보 시간은 예식장 안내문을 확인해 주세요',
        bus: '', shuttle: ''
      },
      sources: ['https://polle.com/place/3pl4du/'] }
  ];
  var CHECKED_AT = '2026-11-06';
  function key(s) { return str(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[\s·ㆍ.,\-_]/g, ''); }
  function stripRegion(k) { return k.replace(/^(서울특별시|서울시|서울|부산광역시|부산시|부산|대구|인천|광주|대전|울산|세종|경기도|경기|제주)/, ''); }
  function catPlace(c, match) {
    return { id: 'catalog:' + c.key, name: c.name, address: c.address, jibun: c.jibun, lat: null, lng: null, phone: '', category: c.category,
      detail: c.detail, src: 'catalog', match: match, checkedAt: CHECKED_AT, sources: c.sources.slice() };
  }
  // 반환: { status: 'ok'|'empty', source: 'catalog', places: [{ ..., match: 'exact'|'partial' }] }
  function catalogSearch(q) {
    var k = key(q), k2 = stripRegion(k); if (!k) return { status: 'empty', places: [], source: 'catalog' };
    var exact = [], partial = [];
    CATALOG.forEach(function (c) {
      var names = [c.name].concat(c.aliases).map(key);
      if (names.indexOf(k) >= 0 || names.indexOf(k2) >= 0) { exact.push(catPlace(c, 'exact')); return; }
      var grp = (c.group || []).map(key);
      var hit = names.some(function (n) { return (k2.length >= 2 && n.indexOf(k2) >= 0) || (n.length >= 3 && k2.indexOf(n) >= 0); }) || grp.some(function (g) { return g && (g === k2 || k2.indexOf(g) === 0); });
      if (hit) partial.push(catPlace(c, 'partial'));
    });
    var list = exact.concat(partial);
    return { status: list.length ? 'ok' : 'empty', places: list, source: 'catalog' };
  }
  function catalogTransit(id) {
    var c = CATALOG.filter(function (x) { return 'catalog:' + x.key === id; })[0];
    if (!c) return null;
    return { car: c.transport.car || '', subway: c.transport.subway || '', bus: c.transport.bus || '', shuttle: c.transport.shuttle || '' };
  }
  // 검색어와 '정확히 일치'하는 결과인지 (실제 검색 결과에도 사용)
  function isExact(q, p) {
    if (p && p.match) return p.match === 'exact';
    var a = stripRegion(key(q)), b = stripRegion(key(p && p.name));
    return !!a && a === b;
  }
  /* v14: 예식장 이름 → 실제 장소 자동 확인
   * resolve(name) → Promise<{ status: 'found'|'multi'|'none'|'off'|'error', place, candidates, source }>
   *  - found : 정확히 일치하는 장소가 한 곳 → 이름 · 주소 자동 연결
   *  - multi : 같은/비슷한 이름이 여러 곳 → 사용자가 선택
   *  - none  : 확인하지 못함 → '검색해서 선택'
   */
  function resolve(name) {
    var q = str(name); if (!q) return Promise.resolve({ status: 'none', candidates: [], source: 'none' });
    return search(q).then(function (r) {
      var list = (r && r.places) || [];
      if (!r || r.status === 'error') return { status: 'error', candidates: [], source: r ? r.source : 'none' };
      if (!list.length) return { status: r.status === 'off' ? 'off' : 'none', candidates: [], source: r.source };
      var ex = list.filter(function (p) { return isExact(q, p); });
      if (ex.length === 1) return { status: 'found', place: ex[0], candidates: list, source: r.source };
      return { status: 'multi', candidates: (ex.length > 1 ? ex : list).slice(0, 8), source: r.source };
    });
  }
  var searchLive = search;
  search = function (q) {
    return searchLive(q).then(function (r) {
      if (r && r.status === 'off') { var c = catalogSearch(q); if (c.status === 'ok') return c; }
      return r;
    });
  };
  var transitLive = transit;
  transit = function (place) {
    place = place || {};
    if (String(place.id || '').indexOf('catalog:') === 0) {
      var info = catalogTransit(place.id);
      if (!info) return Promise.resolve({ status: 'empty', source: 'catalog', info: { car: '', subway: '', bus: '', shuttle: '' } });
      var any = Object.keys(info).some(function (k) { return !!info[k]; });
      return new Promise(function (res) { setTimeout(function () { res({ status: any ? 'ok' : 'empty', source: 'catalog', info: info }); }, 350); });
    }
    return transitLive(place);
  };
  window.IumWeddingPlace = { config: config, mode: mode, search: function (q) { return search(q); }, resolve: resolve, transit: function (p) { return transit(p); }, catalogSearch: catalogSearch,
    transitMode: function () { return config.transitEndpoint ? 'remote' : 'off'; } };
})();

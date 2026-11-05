/* Hodoku モック共通スクリプト（動作確認用。本番実装の代わりではありません） */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* API呼び出し：CSRFトークン（Cookie→ヘッダー）を自動付与。年齢確認はサーバー側で強制 */
  const csrf = () => (document.cookie.match(/(?:^|; )hodoku_csrf=([^;]+)/) || [])[1] || '';
  window.hodokuApi = async (path, opts = {}) => {
    const method = opts.method || (opts.body ? 'POST' : 'GET');
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: {'content-type': 'application/json', 'x-csrf-token': csrf()},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { const err = new Error((data && data.message) || '通信に失敗しました'); err.status = res.status; err.code = data && data.error; throw err; }
    return data;
  };

  /* ---------- 描画ヘルパー（ユーザー投稿は必ずtextContent経由。innerHTMLに入れない） ---------- */
  window.h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  window.yen = n => '¥' + Number(n).toLocaleString('ja-JP');
  window.mmdd = d => { const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; };
  window.ymd = d => { const x = new Date(d); return `${x.getFullYear()}年${x.getMonth() + 1}月${x.getDate()}日`; };
  window.TRUST = {high: ['trust', '信頼度 高'], mid: ['trust mid', '信頼度 中'], low: ['trust low', '要確認']};
  window.trustBadge = level => window.h('span', {class: window.TRUST[level][0], text: window.TRUST[level][1]});
  const TEX = ['silk', 'b', 'c', ''];
  window.texClass = slug => { let n = 0; for (const c of slug) n = (n * 31 + c.charCodeAt(0)) >>> 0; return 'tex ' + TEX[n % TEX.length]; };
  window.changeLabel = hours => hours == null ? ['no', '変更は有料'] : hours >= 24 ? ['', '前日まで変更無料'] : ['', `${hours}時間前まで変更無料`];
  window.showError = (el, e) => { el.replaceChildren(window.h('p', {class: 'msg show bad', role: 'alert', text: e.message || '読み込めませんでした。時間をおいてもう一度お試しください。'})); };

  /* 公開フィーチャーフラグ（有料販売の可否など）。画面の出し分けに使う */
  window.hodokuFlags = window.hodokuApi('/config').catch(() => ({salesEnabled: false}));

  /* ナビ：ログイン状態に応じて「ログイン」→「マイページ／ログアウト」 */
  window.hodokuMe = window.hodokuApi('/auth/me').then(r => r.user).catch(() => null);
  window.hodokuMe.then(user => {
    const ul = $('.site-header nav ul');
    if (!ul) return;
    const doLogout = async e => { e.preventDefault(); await window.hodokuApi('/auth/logout', {method: 'POST', body: {}}); location.href = '/'; };
    if (user) {
      let a = $$('.site-header nav a').find(x => x.textContent.trim() === 'ログイン');
      if (!a) { const li = document.createElement('li'); a = document.createElement('a'); li.append(a); ul.append(li); }
      a.textContent = 'ログアウト'; a.href = '#'; a.addEventListener('click', doLogout);
      if (!$$('.site-header nav a').some(x => /account/.test(x.getAttribute('href') || ''))) {
        const li = document.createElement('li'); const m = document.createElement('a'); m.href = '/account'; m.textContent = 'マイページ'; li.append(m); ul.insertBefore(li, a.closest('li'));
      }
    } else {
      $$('.site-header nav a[href$="account.html"], .site-header nav a[href="/account"]').forEach(a => a.closest('li')?.remove());
    }
  });

  /* スマホのメニュー */
  const menu = $('.menu');
  if (menu) {
    menu.setAttribute('aria-expanded', 'false');
    menu.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      menu.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
        document.body.classList.remove('nav-open');
        menu.setAttribute('aria-expanded', 'false');
        menu.focus();
      }
    });
  }

  /* 評価バー：数値から長さを決める（初版の「長さが数値と連動しない」崩れの修正） */
  $$('[data-score]').forEach(el => {
    const v = parseFloat(el.dataset.score);
    const max = parseFloat(el.dataset.max || '5');
    el.style.setProperty('--w', Math.max(0, Math.min(1, v / max)) * 100 + '%');
  });

  /* トースト */
  const toast = msg => {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2600);
  };
  window.hodokuToast = toast;
  $$('[data-toast]').forEach(el => el.addEventListener('click', e => {
    if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    toast(el.dataset.toast);
  }));

  /* 文字数カウンタ */
  $$('[data-count]').forEach(area => {
    const out = document.getElementById(area.dataset.count);
    const max = +area.getAttribute('maxlength');
    const upd = () => { out.textContent = `${area.value.length} / ${max}`; };
    area.addEventListener('input', upd); upd();
  });

  /* ========== モーション（stageshow の原則：1回の入場・原因のある動き） ========== */
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ヘッダー：スクロール位置で薄い境界を出す（位置は動かさない） */
  const onScroll = () => document.body.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, {passive: true}); onScroll();

  if (!reduce && 'IntersectionObserver' in window) {
    /* 入場：セクション見出し・カード群・評価バーを、画面に入ったら1回だけ整える */
    const revealSel = [
      'section.block', '.sec', '.voices', '.guides', '.cmp', '.plans',
      '.ptable', '.staff', '.timeline', '.safety', '.bill', '.scores',
      '.summary-row', '.item', '.rv', '.ptable tbody'
    ].join(',');
    const groups = new Set(['voices', 'guides', 'plans', 'staff', 'summary-row', 'cmp']);
    const io = new IntersectionObserver((es, ob) => {
      es.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        ob.unobserve(e.target);
      });
    }, {rootMargin: '0px 0px -8% 0px', threshold: 0.12});

    $$(revealSel).forEach(el => {
      /* 折りたたみ要素やダイアログ内、既に入場済みは対象外 */
      if (el.closest('dialog') || el.classList.contains('in')) return;
      el.classList.add('reveal');
      /* カード群は子を読み順にstaggerで出す */
      if ([...groups].some(c => el.classList.contains(c))) el.classList.add('reveal-group');
      io.observe(el);
    });

    /* 何らかの理由で監視が外れても、最終的に必ず表示されるフォールバック */
    addEventListener('load', () => setTimeout(() => $$('.reveal:not(.in)').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight) el.classList.add('in');
    }), 400));
  } else {
    /* reduced-motion：即表示（評価バーも最終長さに） */
    $$('.scores, .meter').forEach(el => el.classList.add('in'));
  }
})();

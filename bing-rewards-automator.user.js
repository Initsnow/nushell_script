// ==UserScript==
// @name         Bing Rewards 自动领取与任务助手
// @namespace    https://github.com/yourname/bing-rewards-auto
// @version      2.0.0
// @description  在 Bing 搜索页自动领取 Rewards 积分、完成“打开即得/搜索即得”任务、自动跳过拼图任务；支持手动/空闲自动后台执行，多标签页协作，Violentmonkey 菜单控制与页内轻量状态
// @author       you
// @match        https://www.bing.com/*
// @match        https://rewards.bing.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_log
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_notification
// @grant        GM_openInTab
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ========== 可调配置 ==========
  const CONFIG = {
    AUTO_START: false,            // 安装后是否立即开始（手动启动仍可通过菜单）
    AUTO_IDLE_ENABLED: true,      // 默认开启“空闲自动”检测（可由 Violentmonkey 菜单关闭）
    IDLE_THRESHOLD_MS: 60000,     // 空闲多久后自动开始（无鼠标/键盘/滚动等操作）
    IDLE_CHECK_INTERVAL_MS: 5000, // 空闲检测轮询间隔
    ACTIVITY_THROTTLE_MS: 2000,   // 活动写入共享状态的最小间隔
    WORKER_HEARTBEAT_MS: 5000,    // 后台工作标签页心跳
    WORKER_TIMEOUT_MS: 20000,     // 超过该时间未心跳视为工作标签失效
    WORKER_OPEN_COOLDOWN_MS: 15000, // 自动打开后台工作标签的最小间隔
    PREFER_HIDDEN_TAB: true,      // 优先在隐藏/后台 Bing 标签页执行，避免影响当前浏览
    OPEN_BACKGROUND_WORKER: true, // 没有后台标签时是否自动打开一个后台工作标签
    ALLOW_FALLBACK_VISIBLE: true, // 实在无法打开后台标签时，是否允许在当前标签执行（手动模式更可用）
    AUTO_SEARCH_ENABLED: true,    // 是否自动做每日搜索
    MAX_SEARCHES_PER_RUN: 8,      // 每轮最多自动搜索次数（趋势词/相关搜索）
    TASK_WAIT_MIN_MS: 4000,       // 打开搜索/任务页后最短等待
    TASK_WAIT_MAX_MS: 9000,       // 打开搜索/任务页后最长等待
    PUZZLE_WAIT_MIN_MS: 2500,     // 点击“跳过拼图”前随机等待范围
    PUZZLE_WAIT_MAX_MS: 5000,
    CLAIM_WAIT_MIN_MS: 2000,      // 领取页随机等待范围
    CLAIM_WAIT_MAX_MS: 4000,
    HUMAN_PAUSE_EVERY: 3,         // 每完成 N 个任务暂停一次
    HUMAN_PAUSE_MIN_MS: 10000,    // 暂停范围（模拟人离开/浏览）
    HUMAN_PAUSE_MAX_MS: 30000,
    SCROLL_BEFORE_LEAVE: true,    // 离开任务页前随机滚动，更像真人
    TAB_BADGE: true,              // 是否在任务执行标签页修改标题/图标，方便观察
    TAB_BADGE_ON_WORKER_ONLY: true, // 只改执行任务的那个标签；false = 所有 Bing 标签都显示状态
    TAB_BADGE_EMOJI: '🤖',        // 标签图标使用的 emoji
    TAB_TITLE_PREFIX: 'BingRewards ' // 标签标题前缀
  };

  const STATE_KEY = 'bingRewardsAutoState_v2';
  const LEGACY_STATE_KEY = 'bingRewardsAutoState_v1';
  const TASK_KEY = 'bingRewardsTask_v2';
  const LEGACY_TASK_KEY = 'bingRewardsTask_v1';
  const TABS_KEY = 'bingRewardsAutoTabs_v2';
  const ACTIVITY_KEY = 'bingRewardsAutoActivity_v2';
  const STATUS_KEY = 'bingRewardsAutoStatus_v2';
  const DEFAULT_STATE = {
    enabled: false,              // 当前是否允许自动执行
    idleAuto: CONFIG.AUTO_IDLE_ENABLED, // 是否开启空闲自动检测
    runSource: 'manual',         // 'manual' | 'idle'
    processed: {},
    queue: [],
    sessionTaskCount: 0,
    worker: null,                // { tabId, ts } 当前唯一后台工作标签
    lastWorkerRequestAt: 0,      // 上一次请求打开后台工作标签的时间
    workerRequestBy: null,       // 当前正在负责打开后台标签的标签 ID
    idleStartRequest: null,      // 空闲自动启动的临时占位，避免多个标签同时启动
    doneDate: ''                 // 当天任务全部完成日期（避免空闲自动反复空跑）
  };

  // ========== 存储 ==========
  function loadState() {
    const s = GM_getValue(STATE_KEY, null);
    if (s) return Object.assign({}, DEFAULT_STATE, s);

    // 从旧版状态迁移，避免升级后丢失已完成记录
    const legacy = GM_getValue(LEGACY_STATE_KEY, null);
    if (legacy) {
      const migrated = Object.assign({}, DEFAULT_STATE, {
        enabled: !!legacy.enabled,
        processed: legacy.processed || {},
        queue: legacy.queue || [],
        sessionTaskCount: legacy.sessionTaskCount || 0
      });
      GM_setValue(STATE_KEY, migrated);
      return migrated;
    }

    return Object.assign({}, DEFAULT_STATE);
  }
  function saveState(state) { GM_setValue(STATE_KEY, state); }
  function loadTask() {
    return GM_getValue(TASK_KEY, GM_getValue(LEGACY_TASK_KEY, null));
  }
  function saveTask(task) { GM_setValue(TASK_KEY, task); }
  function clearTask() {
    GM_deleteValue(TASK_KEY);
    GM_deleteValue(LEGACY_TASK_KEY);
  }

  // 标签注册/活动/状态使用独立存储，避免频繁心跳覆盖任务队列等核心状态
  function loadTabs() { return GM_getValue(TABS_KEY, {}); }
  function saveTabs(tabs) { GM_setValue(TABS_KEY, tabs); }
  function loadActivity() {
    const a = GM_getValue(ACTIVITY_KEY, null);
    if (a) return a;
    const init = { lastActivityAt: Date.now() };
    try { saveActivity(init); } catch (e) {}
    return init;
  }
  function saveActivity(activity) { GM_setValue(ACTIVITY_KEY, activity); }
  function loadStatusMessage() { return GM_getValue(STATUS_KEY, ''); }
  function saveStatusMessage(msg) { GM_setValue(STATUS_KEY, msg); }

  // ========== 标签页身份 / 空闲检测 / 多标签协作 ==========
  const TAB_PREFIX = '__bingRewardsAutoTab_';
  function getTabId() {
    try {
      if (window.name && window.name.indexOf(TAB_PREFIX) === 0) {
        return window.name.slice(TAB_PREFIX.length);
      }
    } catch (e) {}
    const id = 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try { window.name = TAB_PREFIX + id; } catch (e) {}
    return id;
  }
  const TAB_ID = getTabId();

  let statusEl = null;
  let idleTimer = null;
  let heartbeatTimer = null;

  function workerActive(state) {
    return !!(state && state.worker && state.worker.tabId &&
      Date.now() - state.worker.ts < CONFIG.WORKER_TIMEOUT_MS);
  }
  function isCurrentWorker(state) {
    return !!(state && state.worker && state.worker.tabId === TAB_ID &&
      Date.now() - state.worker.ts < CONFIG.WORKER_TIMEOUT_MS);
  }
  function hiddenWorkerActive(state) {
    if (!workerActive(state) || state.worker.tabId === TAB_ID) return false;
    const tabs = loadTabs();
    const t = tabs[state.worker.tabId];
    // 工作标签没来得及注册心跳时也先按“有后台工作标签”处理，避免双跑
    return !t ? true : t.visible === false;
  }
  function hiddenTabAvailable(state) {
    const now = Date.now();
    return Object.values(loadTabs()).some(t =>
      t.visible === false &&
      /^https:\/\/www\.bing\.com(?:\/|$)/.test(t.url || '') &&
      now - (t.heartbeat || 0) < CONFIG.WORKER_TIMEOUT_MS
    );
  }

  function claimWorker() {
    const state = loadState();
    if (workerActive(state) && state.worker.tabId !== TAB_ID) return false;
    // 优先把执行权交给隐藏标签；当前标签可见且已有隐藏标签时，不抢占
    if (CONFIG.PREFER_HIDDEN_TAB && document.visibilityState !== 'hidden' && hiddenTabAvailable(state)) {
      return false;
    }
    if (CONFIG.PREFER_HIDDEN_TAB && document.visibilityState !== 'hidden') {
      // 可见标签只有在没有隐藏标签可用时才允许接管（便于手动模式兜底）
      if (hiddenTabAvailable(state)) return false;
    }
    state.worker = { tabId: TAB_ID, ts: Date.now() };
    saveState(state);
    log('当前标签接管后台执行');
    return true;
  }

  function ensureWorkerTab() {
    const state = loadState();

    // 已经有可用的工作标签就直接复用，避免不断开新标签
    if (workerActive(state) && state.worker.tabId !== TAB_ID) return;

    // 当前标签本身就是隐藏标签，直接作为工作标签
    if (document.visibilityState === 'hidden') {
      claimWorker();
      return;
    }

    // 已经有隐藏 Bing 标签时，交给它接管，不再重复开新标签
    if (CONFIG.PREFER_HIDDEN_TAB && hiddenTabAvailable(state)) return;

    // 可见标签：优先尝试自动打开一个后台工作标签
    if (CONFIG.OPEN_BACKGROUND_WORKER && typeof GM_openInTab === 'function') {
      const now = Date.now();
      if (now - (state.lastWorkerRequestAt || 0) > CONFIG.WORKER_OPEN_COOLDOWN_MS) {
        state.lastWorkerRequestAt = now;
        state.workerRequestBy = TAB_ID;
        saveState(state);
        log('准备打开后台工作标签页...');
        // 短暂延迟后确认自己仍是唯一负责打开者，避免多个标签同时开新标签
        setTimeout(() => {
          const st = loadState();
          if (st.workerRequestBy !== TAB_ID) return;
          if (workerActive(st) || !st.enabled) return;
          if (CONFIG.PREFER_HIDDEN_TAB && hiddenTabAvailable(st)) return;
          st.workerRequestBy = null;
          saveState(st);
          try {
            GM_openInTab('https://www.bing.com/?__rwdAuto=1', { active: false, insert: true });
            log('已打开后台工作标签页');
          } catch (e) {
            log('打开后台工作标签失败: ' + e.message);
            // 打开失败时按配置允许在当前可见标签兜底执行
            if (CONFIG.ALLOW_FALLBACK_VISIBLE && !workerActive(loadState()) && !hiddenTabAvailable(loadState())) {
              if (claimWorker()) runAutomation();
            }
          }
        }, randomInt(300, 900));
      }
      return;
    }

    // 没有打开后台标签的能力或已关闭该功能，才允许在当前可见标签执行
    if (CONFIG.ALLOW_FALLBACK_VISIBLE) {
      claimWorker();
    } else {
      log('没有可用的后台标签页，已跳过自动执行（可手动打开一个 Bing 后台标签）');
    }
  }

  // 用户活动上报：所有 Bing 标签都会更新“最后活动时间”
  function reportActivity() {
    const now = Date.now();
    const activity = loadActivity();
    if (now - (activity.lastActivityAt || 0) >= CONFIG.ACTIVITY_THROTTLE_MS) {
      activity.lastActivityAt = now;
      saveActivity(activity);
    }

    const state = loadState();
    // 若当前是空闲自动在跑，且用户正在操作当前可见 Bing 标签，立即暂停避免影响浏览
    if (state.enabled && state.runSource === 'idle' &&
        document.visibilityState === 'visible' && document.hasFocus()) {
      state.enabled = false;
      saveState(state);
      log('检测到你在使用 Bing，已自动暂停');
    }
    updateStatusUI();
  }

  function installActivityListeners() {
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart', 'pointerdown'];
    for (const ev of events) {
      window.addEventListener(ev, reportActivity, { passive: true, capture: true });
    }
    window.addEventListener('focus', reportActivity);
    document.addEventListener('visibilitychange', () => {
      reportActivity();
      heartbeat();
      updateStatusUI();
    });
    window.addEventListener('pagehide', () => {
      try {
        const tabs = loadTabs();
        delete tabs[TAB_ID];
        saveTabs(tabs);
        // 不在这里清空 worker：跨页面/跨域导航时旧 worker 继续作为“占位”，
        // 新页面加载后会用相同 TAB_ID 刷新心跳，避免其他标签抢跑。
      } catch (e) {}
    });
  }

  function heartbeat() {
    const now = Date.now();
    const tabs = loadTabs();
    tabs[TAB_ID] = {
      heartbeat: now,
      visible: !document.hidden,
      focused: document.hasFocus(),
      url: location.href
    };
    // 清理失联标签
    for (const id of Object.keys(tabs)) {
      if (id !== TAB_ID && now - (tabs[id].heartbeat || 0) > CONFIG.WORKER_TIMEOUT_MS * 2) {
        delete tabs[id];
      }
    }
    saveTabs(tabs);

    // 刷新工作标签心跳（只有工作标签才写主状态，尽量避免覆盖任务状态）
    const state = loadState();
    if (isCurrentWorker(state)) {
      state.worker.ts = now;
      saveState(state);
    }
  }

  // ========== 页内轻量状态（嵌入 Bing 页面，不遮挡内容） ==========
  function ensureStatusEl() {
    if (statusEl && document.documentElement.contains(statusEl)) return statusEl;
    statusEl = document.createElement('div');
    statusEl.id = 'bingRewardsAutoStatusChip';
    statusEl.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:4px',
      'margin:0 0 0 10px', 'padding:2px 8px',
      'background:rgba(255,255,255,.88)', 'border:1px solid rgba(0,0,0,.10)',
      'border-radius:999px', 'font:11px/1.4 system-ui,-apple-system,sans-serif',
      'color:#444', 'box-shadow:0 1px 3px rgba(0,0,0,.07)',
      'vertical-align:middle', 'white-space:nowrap', 'overflow:hidden',
      'text-overflow:ellipsis', 'max-width:320px'
    ].join(';');
    statusEl.title = 'Bing Rewards 自动助手';

    // 优先嵌入 Bing 顶部 header，让状态条随页面排版出现，而不是悬浮遮挡正文
    const header = document.querySelector('#b_header, header, .b_header');
    if (header) {
      header.appendChild(statusEl);
    } else if (document.body) {
      statusEl.style.position = 'fixed';
      statusEl.style.left = '10px';
      statusEl.style.bottom = '10px';
      statusEl.style.zIndex = '2147483647';
      statusEl.style.pointerEvents = 'none';
      document.body.appendChild(statusEl);
    }
    return statusEl;
  }

  function updateStatusUI() {
    const el = ensureStatusEl();
    if (!el) return;
    const s = loadState();
    const statusMessage = loadStatusMessage();
    let text = statusMessage || '';
    if (!text) {
      text = s.enabled ? '🟢 运行中' : '⚪ 待机';
      if (s.idleAuto) text += ' · 空闲自动';
      if (s.queue && s.queue.length) text += ` · 队列${s.queue.length}`;
      if (s.worker) text += s.worker.tabId === TAB_ID ? ' · 本页执行' : ' · 后台执行';
    }
    el.textContent = text;
    const queued = (s.queue || []).length;
    el.title = `Bing Rewards 助手\n启用: ${s.enabled ? '是' : '否'} (${s.runSource})\n空闲自动: ${s.idleAuto ? '开' : '关'}\n队列: ${queued}\n已完成: ${Object.keys(s.processed || {}).length}\n最近: ${statusMessage || '无'}`;
    updateTabBadge();
  }

  // ========== 标签页标题/图标标记（方便识别执行中的工作标签） ==========
  let originalTitle = null;
  let originalFaviconHref = null;
  let tabBadgeApplied = false;

  function getFaviconLink() {
    return document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
  }

  function setTabFavicon(emoji) {
    let link = getFaviconLink();
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='88'>${emoji}</text></svg>`;
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function restoreTabFavicon() {
    const link = getFaviconLink();
    if (!link) return;
    if (originalFaviconHref) {
      link.href = originalFaviconHref;
    } else {
      // 原本没有 favicon 时移除我们添加的
      if (tabBadgeApplied && link.href && link.href.indexOf('data:image/svg+xml') === 0) {
        link.remove();
      }
    }
  }

  function updateTabBadge() {
    if (!CONFIG.TAB_BADGE) return;
    const s = loadState();
    const isWorkerTab = isCurrentWorker(s);
    const shouldBadge = s.enabled && (CONFIG.TAB_BADGE_ON_WORKER_ONLY ? isWorkerTab : true);

    if (originalTitle === null) {
      originalTitle = document.title;
    }
    if (originalFaviconHref === null) {
      const link = getFaviconLink();
      originalFaviconHref = link ? link.href : null;
    }

    if (shouldBadge) {
      const done = Object.keys(s.processed || {}).length;
      const queued = (s.queue || []).length;
      document.title = `${CONFIG.TAB_BADGE_EMOJI} ${CONFIG.TAB_TITLE_PREFIX}${s.runSource === 'idle' ? '空闲' : '手动'} · 队列${queued} · 已完成${done}`;
      setTabFavicon(CONFIG.TAB_BADGE_EMOJI);
      tabBadgeApplied = true;
    } else if (tabBadgeApplied) {
      if (originalTitle !== null) document.title = originalTitle;
      restoreTabFavicon();
      tabBadgeApplied = false;
    }
  }

  // ========== 控制（Violentmonkey 菜单） ==========
  function setEnabled(on, source) {
    const s = loadState();
    s.enabled = !!on;
    s.runSource = source || 'manual';
    saveState(s);
    log(on ? `已${source === 'idle' ? '空闲自动' : '手动'}启动` : '已停止');
    if (on) {
      ensureWorkerTab();
      // 若当前标签就是工作标签（隐藏标签或可见兜底），立即开始跑
      const st = loadState();
      if (isCurrentWorker(st)) runAutomation();
    }
    updateStatusUI();
  }

  function startAutomation(source) {
    setEnabled(true, source || 'manual');
  }

  function stopAutomation() {
    setEnabled(false, 'manual');
  }

  function setIdleAuto(on) {
    const s = loadState();
    s.idleAuto = !!on;
    saveState(s);
    log(`空闲自动已${on ? '开启' : '关闭'}`);
    updateStatusUI();
  }

  function toggleIdleAuto() {
    setIdleAuto(!loadState().idleAuto);
  }

  function clearAll() {
    const s = loadState();
    s.processed = {};
    s.queue = [];
    s.doneDate = '';
    saveState(s);
    log('已清空完成记录与队列');
    updateStatusUI();
  }

  function showStatus() {
    const s = loadState();
    const activity = loadActivity();
    const msg = [
      'Bing Rewards 助手',
      `启用: ${s.enabled ? '是' : '否'} (${s.runSource})`,
      `空闲自动: ${s.idleAuto ? '开' : '关'}`,
      `队列: ${(s.queue || []).length}`,
      `已完成: ${Object.keys(s.processed || {}).length}`,
      `工作标签: ${s.worker ? s.worker.tabId : '无'}`,
      `上次活动: ${activity.lastActivityAt ? new Date(activity.lastActivityAt).toLocaleTimeString() : '未知'}`
    ].join('\n');
    if (typeof GM_notification === 'function') {
      try { GM_notification({ title: 'Bing Rewards 助手', text: msg }); } catch (e) {}
    } else {
      try { alert(msg); } catch (e) {}
    }
    log(msg.replace(/\n/g, ' | '));
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('▶ 开始手动运行', () => startAutomation('manual'));
      GM_registerMenuCommand('⏹ 停止', stopAutomation);
      GM_registerMenuCommand('🌙 开启空闲自动', () => setIdleAuto(true));
      GM_registerMenuCommand('🌙 关闭空闲自动', () => setIdleAuto(false));
      GM_registerMenuCommand('⚡ 立即开启一轮', () => startAutomation('manual'));
      GM_registerMenuCommand('🗑 清空记录', clearAll);
      GM_registerMenuCommand('📊 查看状态', showStatus);
    } catch (e) {
      log('注册 Violentmonkey 菜单失败: ' + e.message);
    }
  }

  // 空闲检测：在所有匹配页面轮询，发现空闲就自动开启后台执行
  function tryRequestIdleStart() {
    const now = Date.now();
    let s = loadState();
    if (!s.idleAuto || s.enabled) return;
    const activity = loadActivity();
    const idleMs = now - (activity.lastActivityAt || now);
    if (idleMs < CONFIG.IDLE_THRESHOLD_MS) return;

    // 当天已完成且队列为空时，空闲自动不再反复空跑
    if (s.doneDate === todayKey() && !((s.queue || []).length)) return;

    // 如果有其他人刚申请启动，不重复排队
    if (s.idleStartRequest && now - s.idleStartRequest.ts < 5000) return;

    s.idleStartRequest = { tabId: TAB_ID, ts: now };
    saveState(s);
    log('检测到浏览器空闲，准备自动开始...');

    // 短暂等待后确认自己仍是唯一的启动者，避免多标签同时抢跑
    setTimeout(() => {
      const st = loadState();
      if (!st.idleAuto || st.enabled) return;
      if (!st.idleStartRequest || st.idleStartRequest.tabId !== TAB_ID) return;
      if (workerActive(st)) return;
      st.idleStartRequest = null;
      saveState(st);
      startAutomation('idle');
    }, randomInt(400, 1200));
  }

  function startIdleMonitor() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      heartbeat();
      tryRequestIdleStart();

      // 已启用但没有工作标签时，定时尝试恢复（例如后台标签打开失败后自动兜底）
      const s = loadState();
      if (s.enabled && !workerActive(s)) {
        if (document.visibilityState === 'hidden') {
          if (claimWorker()) runAutomation();
        } else {
          ensureWorkerTab();
          const st = loadState();
          if (isCurrentWorker(st)) runAutomation();
        }
      }

      updateStatusUI();
    }, CONFIG.IDLE_CHECK_INTERVAL_MS);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, CONFIG.WORKER_HEARTBEAT_MS);
  }

  // ========== 工具 ==========
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log('[BingRewardsAuto]', msg);
    try { GM_log('[BingRewardsAuto] ' + msg); } catch (e) {}
    try { saveStatusMessage(msg); } catch (e) {}
    if (typeof updateStatusUI === 'function') updateStatusUI();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function randomDelay(min, max) { return randomInt(min, max); }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function waitFor(fn, timeout = 10000, interval = 250) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) {}
      await sleep(interval + randomInt(0, 120));
    }
    return null;
  }

  // 平滑分段滚动，模拟真人浏览
  async function humanScroll() {
    if (!CONFIG.SCROLL_BEFORE_LEAVE || !document.body) return;
    const maxY = Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight);
    if (maxY <= 0) return;

    const target = Math.floor(maxY * (0.3 + Math.random() * 0.5));
    const steps = randomInt(8, 20);
    const stepDelay = randomInt(60, 180);
    const startY = window.scrollY;
    const delta = target - startY;

    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      // easeInOut 曲线，滚动不是匀速
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      window.scrollTo(0, startY + delta * eased);
      await sleep(stepDelay + randomInt(0, 80));
    }

    // 偶尔往回滚一点，更像人
    if (Math.random() < 0.5) {
      await sleep(randomInt(200, 800));
      window.scrollBy(0, randomInt(-180, -40));
    }
  }

  // 模拟真人点击：先移动鼠标事件，再按下/抬起，最后触发 click
  async function humanClick(el) {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      const opts = {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0
      };

      el.dispatchEvent(new MouseEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('pointerenter', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      await sleep(randomInt(50, 200));

      el.dispatchEvent(new MouseEvent('mousemove', opts));
      el.dispatchEvent(new MouseEvent('pointermove', opts));
      await sleep(randomInt(80, 250));

      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('pointerdown', opts));
      await sleep(randomInt(60, 180));

      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('pointerup', opts));
      await sleep(randomInt(20, 80));
    } catch (e) {}

    // 最后用原生 click 触发默认行为
    try { el.click(); } catch (e) {}
  }

  // ========== Rewards 面板 ==========
  function getRewardsButton() {
    return [...document.querySelectorAll('button, [role="button"], a')].find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
      return /Microsoft Rewards/.test(t) || /^Rewards/i.test(t) || /rewards/i.test(aria);
    });
  }

  function getRewardsIframe() {
    return [...document.querySelectorAll('iframe')].find(f => f.src && f.src.includes('rewards/panelflyout'));
  }

  function getRewardsDoc() {
    const iframe = getRewardsIframe();
    if (!iframe) return null;
    try { return iframe.contentDocument; } catch (e) { return null; }
  }

  async function openRewardsFlyout() {
    // 随机小延迟，避免一进页面就立刻点
    await sleep(randomDelay(600, 2000));

    // 如果 iframe 还没出现，先等 Rewards 按钮渲染出来再点击
    if (!getRewardsIframe()) {
      const btn = await waitFor(() => getRewardsButton() || null, 10000, 300);
      if (btn) {
        try {
          await humanClick(btn);
          log('已点击 Rewards 按钮');
        } catch (e) {}
      } else {
        log('未找到 Rewards 按钮');
        return null;
      }
    }

    // 等待 iframe 内容加载
    return await waitFor(() => {
      const d = getRewardsDoc();
      return d && d.body && /积分|Rewards|每日/.test(d.body.innerText || '') ? d : null;
    }, 12000);
  }

  // ========== URL 处理 ==========
  function normalizeUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete('__rwdTask');
      u.searchParams.delete('__rwdAuto');
      u.searchParams.delete('__rwdContinue');
      return u.href;
    } catch (e) { return url; }
  }

  function withTaskParam(url) {
    const u = new URL(url, location.href);
    u.searchParams.set('__rwdTask', '1');
    return u.href;
  }

  // ========== 从 Rewards 数据模型读取任务（比 DOM 更准确） ==========
  function getFlyoutResult(doc) {
    try {
      const vm = doc.defaultView && doc.defaultView.flyoutViewModel;
      return vm && vm.flyoutResult ? vm.flyoutResult : null;
    } catch (e) { return null; }
  }

  function todayKey() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  function promotionToTask(p) {
    if (!p) return null;
    const a = p.attributes || {};
    const dest = a.destination || '';
    if (!dest) return null;
    if (a.hidden === 'True') return null;

    const complete = p.complete === true || a.complete === 'True' || a.State === 'Complete';
    if (complete) return null;

    const title = a.title || p.title || '';
    const desc = a.description || p.description || '';
    const points = p.pointProgressMax || a.max || '';
    const pts = Number(points);
    if (!pts || pts <= 0) return null; // 过滤 0 分推广/引荐卡片

    let type = 'open';
    if (/imagepuzzle/i.test(dest)) type = 'puzzle';
    else if (/rewards\.bing\.com\/dashboard/i.test(dest) && /领取|claim/i.test(title + ' ' + desc)) type = 'claim';

    return {
      id: p.offerId || p.name || p.hash || normalizeUrl(dest),
      url: normalizeUrl(dest),
      type,
      title,
      description: desc,
      text: `${title} ${desc} ${points}分`.trim(),
      points
    };
  }

  function getTasksFromData(doc) {
    const fr = getFlyoutResult(doc);
    if (!fr) return [];
    const tasks = [];
    const seen = new Set();

    const addPromo = (p) => {
      const t = promotionToTask(p);
      if (!t) return;
      const key = t.type + '|' + (t.id || t.url);
      if (!seen.has(key)) {
        seen.add(key);
        tasks.push(t);
      }
    };

    // 每日任务：只取今天的
    const daily = fr.dailySetPromotions || {};
    const today = todayKey();
    for (const p of (daily[today] || [])) addPromo(p);

    // 更多任务
    for (const p of (fr.morePromotions || [])) addPromo(p);

    // 其他可做的 urlreward 类任务
    for (const p of (fr.impressionPromotions || [])) addPromo(p);
    for (const p of (fr.exploreOnBingPromotions || [])) addPromo(p);

    return tasks;
  }

  function getSearchTrendsFromData(doc) {
    const fr = getFlyoutResult(doc);
    if (!fr) return [];
    const items = (fr.suggestedSearches && fr.suggestedSearches.suggestedItems) || [];
    return items.map(item => {
      const query = item.query || '';
      // 优先用 query 构造干净 URL，避免 Bing 跳转链接里的双斜杠
      let url = query
        ? normalizeUrl('https://www.bing.com/search?q=' + encodeURIComponent(query))
        : (item.url ? normalizeUrl(item.url) : '');
      return { id: url, url, type: 'search', title: query, text: '搜索趋势：' + query, el: null };
    }).filter(x => x.url);
  }

  function getSearchProgress(doc) {
    // 优先从 Rewards 数据模型读搜索计数，最准确
    const fr = getFlyoutResult(doc);
    const counters = fr && fr.userStatus && fr.userStatus.counters;
    const pc = counters && counters.PCSearch;
    if (Array.isArray(pc)) {
      for (const item of pc) {
        const max = item.pointProgressMax || Number(item.attributes && item.attributes.max) || 0;
        const cur = item.pointProgress != null ? item.pointProgress : Number(item.attributes && item.attributes.progress) || 0;
        if (max > 0) return { current: cur, max };
      }
    }

    // 兼容：从面板文本解析
    const text = doc.body.innerText || '';
    const m = text.match(/每日搜索\s*(\d+)\s*\/\s*(\d+)/);
    if (m) return { current: parseInt(m[1], 10), max: parseInt(m[2], 10) };

    // 如果已经显示“你已获得 60 积分”，也视为已满
    if (/你已获得\s*60\s*积分|已获得 60 积分/.test(text) && /最多\s*60/.test(text)) {
      return { current: 60, max: 60 };
    }

    return null;
  }

  // 如果每日搜索已满，把队列里的搜索任务全部移除
  function dropSearchTasksIfFull(doc) {
    const prog = getSearchProgress(doc);
    if (!prog || prog.current < prog.max) return false;

    const state = loadState();
    const before = state.queue.length;
    state.queue = state.queue.filter(t => t.type !== 'search');
    if (state.queue.length !== before) {
      saveState(state);
      log('每日搜索已满，已移除剩余搜索任务');
      return true;
    }
    return false;
  }

  // 从搜索结果页的“相关搜索/深入了解”里解码出真实搜索 URL
  function extractRelatedSearches() {
    if (location.hostname !== 'www.bing.com') return [];
    const results = [];
    const seen = new Set();
    const candidates = document.querySelectorAll(
      '.richrswrapper a[href*="/ck/a?"], a[data-partnertag*="RelatedSearches"]'
    );

    for (const a of candidates) {
      const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      let url = null;
      try {
        const uParam = new URL(a.href).searchParams.get('u') || '';
        const b64 = uParam.replace(/^a1/, '');
        const decoded = decodeURIComponent(atob(b64));
        if (decoded.startsWith('/search?q=')) {
          url = normalizeUrl('https://www.bing.com' + decoded);
        }
      } catch (e) {}
      if (url && text) {
        const key = 'search|' + url;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ id: url, url, type: 'search', title: text, text: '相关搜索：' + text, el: null });
        }
      }
    }
    return results;
  }

  function harvestRelatedSearches() {
    const items = extractRelatedSearches();
    if (items.length === 0) return;
    const state = loadState();
    const seen = new Set(state.queue.map(x => x.type + '|' + (x.id || x.url)));
    let added = 0;
    for (const item of items) {
      if (added >= CONFIG.MAX_SEARCHES_PER_RUN) break;
      const key = item.type + '|' + (item.id || item.url);
      if (!state.processed[item.id || item.url] && !state.processed[item.url] && !seen.has(key)) {
        state.queue.push({ id: item.id, url: item.url, type: item.type, title: item.title, text: item.text });
        seen.add(key);
        added++;
      }
    }
    if (added) {
      saveState(state);
      log(`从相关搜索中收集到 ${added} 个新搜索词`);
    }
  }

  // ========== 任务队列 ==========
  function buildQueue(doc) {
    const state = loadState();
    let fresh = getTasksFromData(doc);

    // 如果数据模型里任务仍然未完成，但之前被标记成已完成，说明是误标记，重新加入
    for (const t of fresh) {
      if (t.type !== 'search' && (state.processed[t.id] || state.processed[t.url])) {
        delete state.processed[t.id];
        delete state.processed[t.url];
        log(`检测到“${t.text}”仍未完成，重新加入队列`);
      }
    }
    saveState(state);

    // 过滤掉真正已完成/已处理的任务
    fresh = fresh.filter(t => !state.processed[t.id] && !state.processed[t.url]);

    // 每日搜索：使用 Rewards 数据模型里的趋势词，限制数量并随机排序
    if (CONFIG.AUTO_SEARCH_ENABLED) {
      const prog = getSearchProgress(doc);
      let remaining = CONFIG.MAX_SEARCHES_PER_RUN;
      if (prog) remaining = Math.min(remaining, Math.max(0, prog.max - prog.current));

      const trends = getSearchTrendsFromData(doc).filter(t => !state.processed[t.id] && !state.processed[t.url]);
      const searchTasks = shuffle(trends).slice(0, remaining);
      fresh = fresh.concat(searchTasks);
    }

    // 优先级：领取 > 拼图 > 打开即得 > 每日搜索
    const order = { claim: 0, puzzle: 1, open: 2, search: 3 };
    const grouped = {};
    for (const item of fresh) {
      const o = order[item.type] || 9;
      (grouped[o] = grouped[o] || []).push(item);
    }

    const result = [];
    for (const key of Object.keys(grouped).sort((a, b) => a - b)) {
      // 同优先级内随机打乱，减少固定模式
      result.push(...shuffle(grouped[key]));
    }
    return result;
  }

  function addToQueue(items) {
    const state = loadState();
    const seen = new Set(state.queue.map(x => x.type + '|' + (x.id || x.url)));
    for (const item of items) {
      const key = item.type + '|' + (item.id || item.url);
      if (!state.processed[item.id || item.url] && !state.processed[item.url] && !seen.has(key)) {
        state.queue.push({
          id: item.id,
          url: item.url,
          type: item.type,
          title: item.title,
          description: item.description,
          text: item.text,
          points: item.points
        });
        seen.add(key);
      }
    }
    saveState(state);
  }

  function nextTask() {
    const state = loadState();
    state.queue = state.queue.filter(t => !state.processed[t.id] && !state.processed[t.url]);
    if (state.queue.length === 0) return null;

    const order = { claim: 0, puzzle: 1, open: 2, search: 3 };
    state.queue.sort((a, b) => (order[a.type] || 9) - (order[b.type] || 9));
    const firstPriority = order[state.queue[0].type] || 9;
    const group = state.queue.filter(t => (order[t.type] || 9) === firstPriority);
    const task = group[Math.floor(Math.random() * group.length)];
    state.queue = state.queue.filter(t => t !== task);
    saveState(state);
    return task;
  }

  function markProcessed(task) {
    const state = loadState();
    const id = typeof task === 'string' ? task : (task.id || task.url);
    const url = typeof task === 'string' ? task : task.url;
    if (id) state.processed[id] = true;
    if (url) state.processed[url] = true;
    state.queue = state.queue.filter(t => t !== task && t.id !== id && t.url !== url);
    saveState(state);
  }

  // 在 Rewards 面板里找到对应的任务卡片（优先按标题匹配，避免同 URL 不同任务混淆）
  function findTaskAnchor(doc, task) {
    if (!doc) return null;
    const anchors = doc.querySelectorAll(
      'a.block, a[href*="ML2"], a[href*="imagepuzzle"], a[href*="rnoreward"], a[href*="rewards.bing.com/dashboard"]'
    );
    const title = (task.title || '').trim();
    const desc = (task.description || '').trim();

    if (title) {
      const matches = [...anchors].filter(a => {
        const t = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
        if (!t.includes(title)) return false;
        if (desc && !t.includes(desc)) return false;
        return true;
      });
      if (matches.length === 1) return matches[0];
      // 多个匹配说明有歧义，继续走 URL 精确匹配/直接打开
    }

    const urlMatches = [...anchors].filter(a => normalizeUrl(a.href || a.getAttribute('href') || '') === task.url);
    return urlMatches.length === 1 ? urlMatches[0] : null;
  }

  function goHome() {
    location.href = 'https://www.bing.com/?__rwdAuto=1&__rwdContinue=1';
  }

  // ========== 任务完成（带随机暂停） ==========
  async function finishTask(task) {
    markProcessed(task);
    clearTask();

    const s = loadState();
    s.sessionTaskCount = (s.sessionTaskCount || 0) + 1;
    if (CONFIG.HUMAN_PAUSE_EVERY > 0 && s.sessionTaskCount % CONFIG.HUMAN_PAUSE_EVERY === 0) {
      const pause = randomDelay(CONFIG.HUMAN_PAUSE_MIN_MS, CONFIG.HUMAN_PAUSE_MAX_MS);
      log(`模拟人类暂停 ${Math.round(pause / 1000)} 秒`);
      await sleep(pause);
    }
    saveState(s);
    log('任务完成');
    goHome();
  }

  // ========== 页面任务处理 ==========
  async function claimOnCurrentPage() {
    const clickables = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      return /^领取$|立即领取|领取奖励|领取积分|确认领取/.test(t);
    });
    for (const el of clickables) {
      try {
        el.focus();
        await sleep(randomDelay(300, 1000));
        await humanClick(el);
        log('点击领取按钮: ' + (el.innerText || '').trim().slice(0, 30));
      } catch (e) {}
      await sleep(randomDelay(600, 1500));
    }
  }

  async function handleCurrentTask() {
    const task = loadTask();
    if (!task) return false;

    log(`处理任务 [${task.type}] ${task.text || task.url}`);

    if (task.type === 'puzzle') {
      const skip = await waitFor(() => {
        return [...document.querySelectorAll('a, button, [role="button"]')].find(el => {
          const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          return t.includes('跳过拼图') || t.includes('Skip Puzzle');
        }) || null;
      }, 8000);

      if (skip) {
        const wait = randomDelay(CONFIG.PUZZLE_WAIT_MIN_MS, CONFIG.PUZZLE_WAIT_MAX_MS);
        log(`找到“跳过拼图”，${Math.round(wait / 1000)} 秒后点击`);
        await sleep(wait);
        try { skip.focus(); } catch (e) {}
        // 如果点击后跳转，定时器会随页面销毁；由下一个 Bing 页面再次进入本函数完成收尾
        setTimeout(() => { finishTask(task); }, randomDelay(1500, 3000));
        await humanClick(skip);
      } else {
        log('未找到“跳过拼图”，视为已完成');
        await finishTask(task);
      }
      return true;
    }

    if (task.type === 'claim') {
      await waitFor(() => document.readyState === 'complete', 8000);
      await sleep(randomDelay(800, 2000));
      await claimOnCurrentPage();
      await sleep(randomDelay(CONFIG.CLAIM_WAIT_MIN_MS, CONFIG.CLAIM_WAIT_MAX_MS));
      await finishTask(task);
      return true;
    }

    // open / search
    await waitFor(() => document.readyState === 'complete', 10000);

    // 如果页面上有“跳过”按钮（非拼图类），也点一下
    const skipBtn = await waitFor(() => {
      return [...document.querySelectorAll('button, a, [role="button"]')].find(el => {
        const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        return /^(跳过|跳过任务|跳过此任务|Skip)$/i.test(t) || /^(跳过|跳过任务|跳过此任务|Skip)$/i.test(t.replace(/[\s\n]+/g, ''));
      }) || null;
    }, 3000);
    if (skipBtn) {
      const waitBeforeSkip = randomDelay(800, 2500);
      log(`找到“跳过”按钮，${Math.round(waitBeforeSkip / 1000)} 秒后点击`);
      await sleep(waitBeforeSkip);
      try { skipBtn.focus(); } catch (e) {}
      await humanClick(skipBtn);
      await sleep(randomDelay(1000, 2500));
    }

    // 随机滚动，模拟浏览
    await humanScroll();

    // 搜索页顺便收集相关搜索词，下一轮用
    if (task.type === 'search') {
      harvestRelatedSearches();
    }

    const wait = randomDelay(CONFIG.TASK_WAIT_MIN_MS, CONFIG.TASK_WAIT_MAX_MS);
    log(`等待 ${Math.round(wait / 1000)} 秒让积分到账...`);
    await sleep(wait);

    if (CONFIG.SCROLL_BEFORE_LEAVE) {
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
      await sleep(randomInt(300, 800));
    }

    await finishTask(task);
    return true;
  }

  // ========== 模拟人工搜索（逐字输入 + 随机停顿） ==========
  async function performSearch(task) {
    if (location.hostname !== 'www.bing.com') return false;

    const input = document.querySelector('#sb_form_q, input[name="q"], input[type="search"]');
    if (!input) return false;

    const query = new URL(task.url, location.href).searchParams.get('q') || '';
    if (!query) return false;

    try {
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // 逐字输入，模拟真人打字
      for (let i = 0; i < query.length; i++) {
        input.value = query.slice(0, i + 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(randomInt(30, 120));
      }

      await sleep(randomDelay(400, 1400));

      const form = input.closest('form');
      if (form) {
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
        return true;
      }
    } catch (e) {
      log('模拟搜索失败，改用直接跳转: ' + e.message);
    }
    return false;
  }

  // ========== 主流程 ==========
  async function runAutomation() {
    let state = loadState();
    if (!state.enabled) return;

    // 多标签协作：已有其他工作标签时，当前标签不执行
    if (workerActive(state) && state.worker.tabId !== TAB_ID) return;

    // 刚请求打开后台工作标签，给后台标签一点加载/接管时间
    if (document.visibilityState !== 'hidden' &&
        state.lastWorkerRequestAt &&
        Date.now() - state.lastWorkerRequestAt < CONFIG.WORKER_OPEN_COOLDOWN_MS) {
      return;
    }

    // 可见标签不抢占已有隐藏工作标签
    if (document.visibilityState !== 'hidden' && hiddenWorkerActive(state)) return;

    // 成为工作标签（隐藏标签优先；可见标签仅作为兜底）
    if (!isCurrentWorker(state) && !claimWorker()) return;
    state = loadState();

    // 如果当前正在处理任务，先收尾
    if (loadTask()) {
      await handleCurrentTask();
      return;
    }

    // 主流程需要在 Bing 页面运行
    if (location.hostname !== 'www.bing.com') {
      log('请先打开 Bing 搜索页再开始');
      return;
    }

    // 如果当前就是搜索结果页，先把相关搜索收进队列
    harvestRelatedSearches();

    log('打开 Rewards 面板...');
    let doc = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      doc = await openRewardsFlyout();
      if (doc) break;
      log(`第 ${attempt} 次打开失败，2 秒后重试`);
      await sleep(2000);
    }
    if (!doc) {
      log('无法打开 Rewards 面板，请手动点一次 Rewards 按钮后重试');
      return;
    }

    // 如果每日搜索已经满了，就不再处理搜索任务
    dropSearchTasksIfFull(doc);

    const tasks = buildQueue(doc);

    // 非搜索任务以面板实时数据为准，清掉旧格式/已失效的队列项
    const currentNonSearch = new Set(tasks.filter(t => t.type !== 'search').map(t => t.id || t.url));
    const s = loadState();
    s.queue = s.queue.filter(t => t.type === 'search' || currentNonSearch.has(t.id || t.url));
    saveState(s);

    addToQueue(tasks);

    const state2 = loadState();
    log(`发现 ${state2.queue.length} 个待完成任务`);
    if (state2.queue.length === 0) {
      log('今天好像都完成了 🎉');
      state2.enabled = false;
      state2.doneDate = todayKey();
      saveState(state2);
      updateStatusUI();
      return;
    }

    const task = nextTask();
    if (!task) return;
    saveTask(task);
    log(`开始任务: [${task.type}] ${task.text || task.url}`);

    // 每日搜索优先用搜索框模拟输入
    if (task.type === 'search' && await performSearch(task)) {
      return;
    }

    // 其他任务优先点击面板里的任务卡片，保留任务上下文（拼图同 URL 也能区分）
    const anchor = findTaskAnchor(doc, task);
    if (anchor) {
      const beforeUrl = location.href;
      log(`点击面板任务卡片: ${task.title || task.text}`);
      await humanClick(anchor);
      await sleep(1200);
      if (location.href === beforeUrl) {
        log('面板卡片未跳转，改用直接链接');
        location.href = withTaskParam(task.url);
      }
      return;
    }

    location.href = withTaskParam(task.url);
  }

  // ========== 启动 ==========
  async function main() {
    installActivityListeners();
    registerMenuCommands();
    heartbeat();
    // 用户正在看这个 Bing 标签时记为一次活动，避免刚打开就立刻被空闲逻辑接管
    if (document.visibilityState === 'visible') reportActivity();
    ensureStatusEl();
    updateStatusUI();
    startIdleMonitor();

    // 当前有未完成任务：只交给工作标签处理，避免多个标签重复执行
    if (loadTask()) {
      const st = loadState();
      if (isCurrentWorker(st)) {
        await handleCurrentTask();
      } else if (!workerActive(st)) {
        // 没有工作标签时：隐藏标签直接接管；可见标签先尝试开后台标签
        if (document.visibilityState === 'hidden') {
          if (claimWorker()) await handleCurrentTask();
        } else {
          ensureWorkerTab();
          const st2 = loadState();
          if (isCurrentWorker(st2)) await handleCurrentTask();
        }
      }
      return;
    }

    if (CONFIG.AUTO_START) {
      startAutomation('manual');
      return;
    }

    const state = loadState();
    if (state.enabled) {
      ensureWorkerTab();
      await runAutomation();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();

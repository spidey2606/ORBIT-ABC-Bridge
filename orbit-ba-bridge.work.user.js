// ==UserScript==
// @name         ORBIT–BC Bridge
// @namespace    orbit-ba-bridge
// @version      3.3.0
// @description  One-click: extract customer query → send to BC → paste response into Expected Response
// @author       piyushts
// @match        https://*.harmony.a2z.com/*
// @match        https://pre-prod.amazon.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '3.3.0';
  console.log('[ORBIT Bridge ' + VERSION + '] loaded on:', location.href);

  const SEL = {
    QUERY_SELECTED : '#conversation-display > div.message.customer.selected > div.message-bubble',
    QUERY_ALL      : '#conversation-display > div.message.customer > div.message-bubble',
    EXPECTED       : 'textarea[placeholder*="expected" i]',
    BA_INPUT       : [
      'textarea[name="messageInput"]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="ask" i]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
    ],
    BA_SEND        : [
      'button[aria-label*="send" i]',
      'button[title*="send" i]',
      'button[data-testid*="send" i]',
      'svg.ink_1ca9dc8c_icon_h0h6q4c',
      'svg.ink_1ca9dc8c_icon_h0h6q47',
    ],
    ASSISTANT_MSG  : '.bc-bot-chat-bubble-group [aria-label="chat-bubble"]',
  };

  const BA_URL      = 'https://pre-prod.amazon.com/businessprime';
  const STREAM_IDLE = 500;
  const QUERY_GAP   = 500;
  const MAX_WAIT    = 90000;
  const KEY_REQ     = 'orbit_ba_req';
  const KEY_RES     = 'orbit_ba_res';
  const KEY_READY      = 'orbit_ba_ready';
  const KEY_PROCESSING = 'orbit_ba_proc';
  const KEY_CMD        = 'orbit_ba_cmd';
  const TOOLBAR_ID  = 'orbit-bridge-toolbar-v120';

  const IS_ANNOTATOR = /harmony\.a2z\.com/.test(location.host);
  const IS_BA        = /pre-prod\.amazon\.com/.test(location.host);

  console.log('[ORBIT Bridge ' + VERSION + '] page: ' + (IS_ANNOTATOR ? 'ANNOTATOR' : IS_BA ? 'BA' : 'none'));

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function css(el, styles) {
    Object.entries(styles).forEach(([k, v]) =>
      el.style.setProperty(k.replace(/([A-Z])/g, m => '-' + m.toLowerCase()), String(v), 'important')
    );
  }

  function isVisible(el, allowDisabled = false) {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return (allowDisabled || !el.disabled)
      && s.visibility !== 'hidden' && s.display !== 'none'
      && r.width > 0 && r.height > 0;
  }

  function setReactValue(el, value) {
    const proto  = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function makeDraggable(el, handle) {
    let drag = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', e => {
      drag = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      el.style.setProperty('left',   Math.max(0, e.clientX - ox) + 'px', 'important');
      el.style.setProperty('top',    Math.max(0, e.clientY - oy) + 'px', 'important');
      el.style.setProperty('right',  'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  function makeResizable(el) {
    const STOR = 'ob_panel_size', MIN_W = 200, MIN_H = 180;

    function mkH(right, bottom, left, top, w, h, cur) {
      const d = document.createElement('div');
      d.style.position = 'absolute'; d.style.zIndex = '2147483647';
      d.style.background = 'transparent'; d.style.cursor = cur;
      d.className = 'ob-resize-handle';
      if (w      !== null) d.style.width  = w;
      if (h      !== null) d.style.height = h;
      if (right  !== null) d.style.right  = right;
      if (bottom !== null) d.style.bottom = bottom;
      if (left   !== null) d.style.left   = left;
      if (top    !== null) d.style.top    = top;
      el.appendChild(d); return d;
    }
    /* right edge: top:0+bottom:0 stretches full height without needing height:100% */
    const rH = mkH('0',   '0',   null, '0',   '8px',  null,   'ew-resize');
    /* bottom edge: left:0+right:0 stretches full width without needing width:100% */
    const bH = mkH('0',   '0',   '0',  null,  null,   '8px',  's-resize');
    /* SE corner - slightly larger for easier grab */
    const cH = mkH('0',   '0',   null, null,  '18px', '18px', 'se-resize');

    function onDown(doW, doH) {
      return function(e) {
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, sy = e.clientY;
        const r = el.getBoundingClientRect();
        const sw = r.width, sh = r.height;
        function mv(e) {
          if (doW) el.style.setProperty('width',  Math.max(MIN_W, sw + e.clientX - sx) + 'px', 'important');
          if (doH) { el.style.setProperty('height', Math.max(MIN_H, sh + e.clientY - sy) + 'px', 'important'); el.classList.add('ob-sized'); }
        }
        function up() {
          document.removeEventListener('mousemove', mv);
          document.removeEventListener('mouseup', up);
          try {
            const r2 = el.getBoundingClientRect();
            localStorage.setItem(STOR, JSON.stringify({ w: Math.round(r2.width), h: el.classList.contains('ob-sized') ? Math.round(r2.height) : null }));
          } catch(e) {}
        }
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      };
    }
    rH.addEventListener('mousedown', onDown(true,  false));
    bH.addEventListener('mousedown', onDown(false, true));
    cH.addEventListener('mousedown', onDown(true,  true));
  }

  function waitFor(selectors, ms = 8000) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    return new Promise((resolve, reject) => {
      const find = () => { for (const s of list) { const e = document.querySelector(s); if (e) return e; } return null; };
      const el = find(); if (el) return resolve(el);
      const deadline = Date.now() + ms;
      const iv = setInterval(() => {
        const found = find();
        if (found) { clearInterval(iv); resolve(found); }
        else if (Date.now() >= deadline) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

  function waitForText(selector, text, ms = 3000) {
    return new Promise((resolve, reject) => {
      const find = () => {
        for (const el of document.querySelectorAll(selector)) {
          if (el.textContent.trim() === text && isVisible(el)) return el;
        }
        return null;
      };
      const found = find(); if (found) return resolve(found);
      const deadline = Date.now() + ms;
      const iv = setInterval(() => {
        const f = find();
        if (f) { clearInterval(iv); resolve(f); }
        else if (Date.now() >= deadline) { clearInterval(iv); resolve(null); }
      }, 100);
    });
  }

  function makeBtn(label, bg, fg = '#fff') {
    const b = document.createElement('button');
    b.textContent = label;
    css(b, {
      flex: '1', padding: '7px 8px', border: 'none', borderRadius: '5px',
      background: bg, color: fg, cursor: 'pointer',
      fontSize: '12px', fontWeight: '700',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    });
    b.addEventListener('mouseover', () => b.style.setProperty('filter', 'brightness(1.1)', 'important'));
    b.addEventListener('mouseout',  () => b.style.removeProperty('filter'));
    return b;
  }

  if (IS_ANNOTATOR) {
    const boot = () => {
      if (document.getElementById(TOOLBAR_ID)) return;
      buildToolbar();
      listenForBAResponse();
      console.log('[ORBIT Bridge ' + VERSION + '] toolbar mounted');
    };
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', boot)
      : boot();
  }


  /* ── Styles injection ────────────────────────────────────────── */
  let _stylesInjected = false;
  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const _css = [
      '#orbit-bridge-toolbar-v120 *{box-sizing:border-box!important;margin:0!important;padding:0!important}',
      '#orbit-bridge-toolbar-v120{position:fixed!important;top:120px!important;right:20px!important;width:262px!important;min-width:220px!important;background:linear-gradient(160deg,#1c2030 0%,#141720 100%)!important;border-radius:16px!important;border:1px solid rgba(255,255,255,.07)!important;box-shadow:0 32px 64px rgba(0,0,0,.55),0 0 0 1px rgba(255,153,0,.05),inset 0 1px 0 rgba(255,255,255,.05)!important;z-index:2147483647!important;overflow:visible!important;color:rgba(255,255,255,.72)!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:11px 13px 10px!important;background:linear-gradient(135deg,rgba(255,153,0,.09),rgba(255,255,255,.02))!important;border-bottom:1px solid rgba(255,255,255,.05)!important;cursor:move!important;user-select:none!important;border-radius:16px 16px 0 0!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-left{display:flex!important;align-items:center!important;gap:8px!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-icon{width:26px!important;height:26px!important;border-radius:7px!important;flex-shrink:0!important;background:linear-gradient(135deg,#ff9900,#c97a00)!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:13px!important;box-shadow:0 3px 10px rgba(255,153,0,.4)!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-text{display:flex!important;flex-direction:column!important;gap:1px!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-title{font-size:12px!important;font-weight:700!important;color:#eef0f8!important;letter-spacing:.15px!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-ver{font-size:9px!important;color:rgba(255,255,255,.25)!important;letter-spacing:.7px!important;text-transform:uppercase!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-right{display:flex!important;align-items:center!important;gap:4px!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-btn{width:22px!important;height:22px!important;border-radius:6px!important;border:none!important;background:rgba(255,255,255,.05)!important;color:rgba(255,255,255,.3)!important;cursor:pointer!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:11px!important;line-height:1!important}',
      '#orbit-bridge-toolbar-v120 .ob-hdr-btn:hover{background:rgba(255,153,0,.18)!important;color:#ff9900!important}',
      '#orbit-bridge-toolbar-v120 .ob-sbar{display:flex!important;align-items:center!important;gap:7px!important;padding:5px 13px!important;background:rgba(0,0,0,.18)!important;border-bottom:1px solid rgba(255,255,255,.04)!important}',
      '@keyframes ob-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.7)}}',
      '@keyframes ob-spin{to{transform:rotate(360deg)}}',
      '#orbit-bridge-toolbar-v120 .ob-sdot{width:6px!important;height:6px!important;border-radius:50%!important;flex-shrink:0!important;background:#4ade80!important;box-shadow:0 0 5px rgba(74,222,128,.8)!important;animation:ob-pulse 2.2s ease-in-out infinite!important}',
      '#orbit-bridge-toolbar-v120 .ob-sdot.busy{background:#f59e0b!important;box-shadow:0 0 5px rgba(245,158,11,.8)!important}',
      '#orbit-bridge-toolbar-v120 .ob-sdot.err{background:#f87171!important;box-shadow:0 0 5px rgba(248,113,113,.8)!important;animation:none!important}',
      '#orbit-bridge-toolbar-v120 .ob-sdot.ok{background:#4ade80!important;animation:none!important}',
      '#orbit-bridge-toolbar-v120 .ob-stext{font-size:10px!important;color:rgba(255,255,255,.28)!important;letter-spacing:.3px!important}',
      '#orbit-bridge-toolbar-v120 .ob-pane{display:none!important;flex-direction:column!important}',
      '#orbit-bridge-toolbar-v120 .ob-pane.ob-active{display:flex!important}',
      '#orbit-bridge-toolbar-v120 .ob-body{padding:12px 12px 0!important}',
      '#orbit-bridge-toolbar-v120 .ob-sec-lbl{font-size:9px!important;font-weight:700!important;letter-spacing:1px!important;text-transform:uppercase!important;color:rgba(255,255,255,.2)!important;margin-bottom:7px!important}',
      '#orbit-bridge-toolbar-v120 .ob-toggle{display:flex!important;background:rgba(0,0,0,.28)!important;border-radius:9px!important;padding:3px!important;gap:2px!important;border:1px solid rgba(255,255,255,.06)!important;margin-bottom:10px!important}',
      '#orbit-bridge-toolbar-v120 .ob-toggle input[type=radio]{display:none!important}',
      '#orbit-bridge-toolbar-v120 .ob-toggle-lbl{display:flex!important;align-items:center!important;justify-content:center!important;padding:6px!important;border-radius:7px!important;cursor:pointer!important;font-size:11px!important;font-weight:500!important;color:rgba(255,255,255,.65)!important;user-select:none!important;white-space:nowrap!important;width:100%!important;transition:all .2s ease!important}',
      '#orbit-bridge-toolbar-v120 .ob-toggle input:checked+.ob-toggle-lbl{background:linear-gradient(135deg,#ff9900,#d97b00)!important;color:#fff!important;font-weight:700!important;box-shadow:0 2px 10px rgba(255,153,0,.38)!important}',
      '#orbit-bridge-toolbar-v120 .ob-toggle input:checked+.ob-toggle-lbl .ob-icon-lbl{filter:brightness(0)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-send .ob-icon-lbl{filter:brightness(0)!important}',
      '#orbit-bridge-toolbar-v120 .ob-toggle-lbl:hover{color:rgba(255,255,255,.6)!important;background:rgba(255,255,255,.05)!important}',
      '#orbit-bridge-toolbar-v120 .ob-action-row{display:grid!important;grid-template-columns:1fr 30px!important;gap:6px!important;align-items:center!important;margin-bottom:9px!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn{height:30px!important;padding:0 10px!important;font-size:11px!important;font-weight:600!important;font-family:inherit!important;border-radius:8px!important;border:1px solid transparent!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;cursor:pointer!important;white-space:nowrap!important;transition:transform .18s ease,box-shadow .18s ease,filter .15s ease!important;letter-spacing:.1px!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn:hover:not(:disabled){filter:brightness(1.1)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn:active:not(:disabled){transform:scale(.93)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn:disabled{opacity:.3!important;cursor:not-allowed!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-send{background:linear-gradient(135deg,#ff9900,#d07800)!important;color:#fff!important;border-color:rgba(255,153,0,.4)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-send:hover:not(:disabled){transform:translateY(-1px)!important;box-shadow:0 5px 14px rgba(255,153,0,.32)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-edit{background:rgba(93,214,204,.07)!important;color:#5dd6cc!important;border-color:rgba(93,214,204,.22)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-edit:hover:not(:disabled){transform:translateY(-1px)!important;background:rgba(93,214,204,.13)!important;box-shadow:0 4px 10px rgba(93,214,204,.12)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-mode{width:30px!important;padding:0!important;font-size:14px!important;background:rgba(255,255,255,.05)!important;color:rgba(255,255,255,.32)!important;border-color:rgba(255,255,255,.1)!important;flex-shrink:0!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-mode:hover:not(:disabled){background:rgba(93,214,204,.09)!important;color:rgba(93,214,204,.85)!important;border-color:rgba(93,214,204,.28)!important}',
      '#orbit-bridge-toolbar-v120 .ob-abtn-mode.edit-active{background:rgba(93,214,204,.08)!important;color:rgba(93,214,204,.72)!important;border-color:rgba(93,214,204,.24)!important}',
      '#orbit-bridge-toolbar-v120 .ob-sline{font-size:10.5px!important;min-height:15px!important;color:rgba(255,255,255,.28)!important;padding:0 1px 10px!important}',
      '#orbit-bridge-toolbar-v120 .ob-sline.ok{color:#4ade80!important}',
      '#orbit-bridge-toolbar-v120 .ob-sline.err{color:#f87171!important}',
      '#orbit-bridge-toolbar-v120 .ob-sline.warn{color:#f59e0b!important}',
      '#orbit-bridge-toolbar-v120 .ob-sline.info{color:#60a5fa!important}',
      '#orbit-bridge-toolbar-v120 .ob-divider{height:1px!important;background:linear-gradient(90deg,transparent,rgba(255,255,255,.07),transparent)!important}',
      '#orbit-bridge-toolbar-v120 .ob-footer{display:grid!important;grid-template-columns:1fr 1fr!important;gap:6px!important;padding:10px 12px 12px!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;border-radius:8px!important;font-family:inherit!important;font-weight:600!important;cursor:pointer!important;white-space:nowrap!important;transition:transform .18s ease,box-shadow .18s ease!important;letter-spacing:.1px!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn:disabled{opacity:.3!important;cursor:not-allowed!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-clear{height:30px!important;padding:0 10px!important;font-size:11px!important;background:rgba(239,68,68,.08)!important;color:#f87171!important;border:1px solid rgba(239,68,68,.16)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-clear:hover:not(:disabled){background:rgba(239,68,68,.14)!important;transform:translateY(-1px)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-reload{height:30px!important;padding:0 10px!important;font-size:11px!important;background:rgba(255,153,0,.08)!important;color:#ff9900!important;border:1px solid rgba(255,153,0,.16)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-reload:hover:not(:disabled){background:rgba(255,153,0,.14)!important;transform:translateY(-1px)!important}',
      '#orbit-bridge-toolbar-v120 .ob-busy-inner{display:flex!important;flex-direction:column!important;align-items:center!important;gap:12px!important;padding:20px 12px 16px!important}',
      '#orbit-bridge-toolbar-v120 .ob-spinner{width:28px!important;height:28px!important;border-radius:50%!important;border:2.5px solid rgba(255,153,0,.13)!important;border-top-color:#ff9900!important;animation:ob-spin .75s linear infinite!important}',
      '#orbit-bridge-toolbar-v120 .ob-busy-lbl{font-size:11.5px!important;font-weight:600!important;color:rgba(255,255,255,.48)!important;text-align:center!important}',
      '#orbit-bridge-toolbar-v120 .ob-busy-sub{font-size:10px!important;color:rgba(255,255,255,.2)!important;text-align:center!important;line-height:1.5!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-cancel{height:28px!important;padding:0 13px!important;font-size:10.5px!important;font-weight:700!important;border-radius:7px!important;border:1px solid rgba(239,68,68,.18)!important;background:rgba(239,68,68,.07)!important;color:rgba(248,113,113,.65)!important;cursor:pointer!important;font-family:inherit!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-cancel:hover{background:rgba(239,68,68,.14)!important;color:#f87171!important;transform:translateY(-1px)!important}',
      '#orbit-bridge-toolbar-v120 .ob-resp-body{display:flex!important;flex-direction:column!important;gap:9px!important;padding:12px!important}',
      '#orbit-bridge-toolbar-v120 .ob-resp-hdr{display:flex!important;align-items:center!important;gap:6px!important;font-size:11px!important;font-weight:700!important;color:#4ade80!important}',
      '#orbit-bridge-toolbar-v120 .ob-check-ico{width:16px!important;height:16px!important;border-radius:50%!important;flex-shrink:0!important;background:rgba(74,222,128,.12)!important;border:1px solid rgba(74,222,128,.28)!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:9px!important}',
      '#orbit-bridge-toolbar-v120 .ob-resp-ta{background:rgba(0,0,0,.25)!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:9px!important;padding:9px 10px!important;font-size:11px!important;line-height:1.6!important;color:rgba(255,255,255,.72)!important;font-family:inherit!important;resize:none!important;height:100px;min-height:60px!important;width:100%!important;outline:none!important;overflow:auto!important}',
      '#orbit-bridge-toolbar-v120 .ob-resp-ta:focus{border-color:rgba(255,153,0,.3)!important}',
      '#orbit-bridge-toolbar-v120 .ob-resp-btns{display:grid!important;grid-template-columns:1fr 1fr 1fr!important;gap:5px!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-use{height:30px!important;padding:0 8px!important;font-size:11px!important;border-radius:8px!important;background:linear-gradient(135deg,#16a34a,#0f7a38)!important;color:#fff!important;border:1px solid rgba(22,163,74,.3)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-use:hover:not(:disabled){transform:translateY(-1px)!important;box-shadow:0 5px 12px rgba(22,163,74,.32)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-retest{height:30px!important;padding:0 8px!important;font-size:11px!important;border-radius:8px!important;background:rgba(96,165,250,.08)!important;color:#60a5fa!important;border:1px solid rgba(96,165,250,.18)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-retest:hover:not(:disabled){background:rgba(96,165,250,.14)!important;transform:translateY(-1px)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-discard{height:30px!important;padding:0 8px!important;font-size:11px!important;border-radius:8px!important;background:rgba(239,68,68,.08)!important;color:#f87171!important;border:1px solid rgba(239,68,68,.16)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-discard:hover:not(:disabled){background:rgba(239,68,68,.14)!important;transform:translateY(-1px)!important}',
      '#orbit-bridge-toolbar-v120 .ob-sources{display:flex!important;flex-direction:column!important;gap:4px!important}',
      '#orbit-bridge-toolbar-v120 .ob-src-lbl{font-size:10px!important;font-weight:700!important;color:#a78bfa!important;letter-spacing:.3px!important}',
      '#orbit-bridge-toolbar-v120 .ob-src-row{display:flex!important;align-items:center!important;gap:5px!important;padding:5px 8px!important;border-radius:7px!important;background:rgba(167,139,250,.05)!important;border:1px solid rgba(167,139,250,.1)!important}',
      '#orbit-bridge-toolbar-v120 .ob-src-name{flex:1!important;font-size:10px!important;color:rgba(255,255,255,.5)!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-src{flex:none!important;height:20px!important;padding:0 7px!important;font-size:9.5px!important;font-weight:700!important;border-radius:5px!important;border:none!important;cursor:pointer!important;font-family:inherit!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-src-open{background:rgba(96,165,250,.12)!important;color:#60a5fa!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-src-open:hover{background:rgba(96,165,250,.24)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-src-paste{background:rgba(167,139,250,.12)!important;color:#a78bfa!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-src-paste:hover{background:rgba(167,139,250,.24)!important}',
      '#orbit-bridge-toolbar-v120 .ob-rp-body{display:flex!important;flex-direction:column!important;gap:9px!important;padding:12px!important}',
      '#orbit-bridge-toolbar-v120 .ob-rp-hdr{font-size:11px!important;font-weight:700!important;color:#5dd6cc!important}',
      '#orbit-bridge-toolbar-v120 .ob-rp-qlbl{font-size:9px!important;font-weight:700!important;color:rgba(255,255,255,.25)!important;margin-bottom:3px!important;letter-spacing:.4px!important;text-transform:uppercase!important}',
      '#orbit-bridge-toolbar-v120 .ob-rp-ta{background:rgba(0,0,0,.25)!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:8px!important;padding:8px 10px!important;font-size:11px!important;line-height:1.55!important;color:rgba(255,255,255,.72)!important;font-family:inherit!important;resize:vertical!important;width:100%!important;outline:none!important;overflow:auto!important}',
      '#orbit-bridge-toolbar-v120 .ob-rp-ta:focus{border-color:rgba(93,214,204,.32)!important}',
      '#orbit-bridge-toolbar-v120 .ob-rp-btns{display:grid!important;grid-template-columns:2fr 1fr!important;gap:6px!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-rp-send{height:32px!important;padding:0 12px!important;font-size:11px!important;font-weight:700!important;border-radius:8px!important;background:linear-gradient(135deg,#1a6b5c,#0d4a3e)!important;color:#5dd6cc!important;border:1px solid rgba(93,214,204,.2)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-rp-send:hover:not(:disabled){transform:translateY(-1px)!important;box-shadow:0 5px 12px rgba(93,214,204,.16)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-back{height:32px!important;padding:0 10px!important;font-size:11px!important;font-weight:600!important;border-radius:8px!important;background:rgba(255,255,255,.05)!important;color:rgba(255,255,255,.38)!important;border:1px solid rgba(255,255,255,.08)!important}',
      '#orbit-bridge-toolbar-v120 .ob-btn-back:hover:not(:disabled){background:rgba(255,255,255,.09)!important;color:rgba(255,255,255,.65)!important;transform:translateY(-1px)!important}',
      '#orbit-bridge-toolbar-v120.ob-light{background:linear-gradient(160deg,#ffffff 0%,#f4f6fb 100%)!important;border-color:rgba(0,0,0,.09)!important;box-shadow:0 16px 40px rgba(0,0,0,.10),0 0 0 1px rgba(255,153,0,.08),inset 0 1px 0 rgba(255,255,255,.9)!important;color:rgba(0,0,0,.65)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-hdr{background:linear-gradient(135deg,rgba(255,153,0,.07),rgba(0,0,0,.01))!important;border-bottom-color:rgba(0,0,0,.06)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-hdr-title{color:#1a1f2e!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-hdr-btn{background:rgba(0,0,0,.05)!important;color:rgba(0,0,0,.4)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-hdr-btn:hover{background:rgba(255,153,0,.12)!important;color:#c97a00!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sbar{background:rgba(0,0,0,.04)!important;border-bottom-color:rgba(0,0,0,.06)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-stext{color:rgba(0,0,0,.45)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sec-lbl{color:rgba(0,0,0,.32)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-toggle{background:rgba(0,0,0,.06)!important;border-color:rgba(0,0,0,.08)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-toggle-lbl{color:rgba(0,0,0,.45)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-toggle-lbl:hover{color:rgba(0,0,0,.65)!important;background:rgba(0,0,0,.05)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-abtn-edit{background:rgba(93,214,204,.09)!important;color:#0a8a87!important;border-color:rgba(93,214,204,.28)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-abtn-mode{background:rgba(0,0,0,.04)!important;color:rgba(0,0,0,.3)!important;border-color:rgba(0,0,0,.1)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-abtn-mode:hover:not(:disabled){background:rgba(93,214,204,.1)!important;color:#0a8a87!important;border-color:rgba(93,214,204,.3)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-abtn-mode.edit-active{background:rgba(93,214,204,.09)!important;color:#0a8a87!important;border-color:rgba(93,214,204,.28)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sline{color:rgba(0,0,0,.38)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sline.ok{color:#16a34a!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sline.err{color:#dc2626!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sline.warn{color:#d97706!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-sline.info{color:#2563eb!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-divider{background:linear-gradient(90deg,transparent,rgba(0,0,0,.08),transparent)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-btn-clear{background:rgba(239,68,68,.06)!important;color:#dc2626!important;border-color:rgba(239,68,68,.2)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-btn-reload{background:rgba(255,153,0,.07)!important;color:#c97a00!important;border-color:rgba(255,153,0,.22)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-busy-lbl{color:rgba(0,0,0,.55)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-busy-sub{color:rgba(0,0,0,.32)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-resp-ta{background:rgba(0,0,0,.03)!important;border-color:rgba(0,0,0,.12)!important;color:rgba(0,0,0,.75)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-resp-ta:focus{border-color:rgba(255,153,0,.4)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-src-lbl{color:#6d28d9!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-src-name{color:rgba(0,0,0,.42)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-src-row{background:rgba(0,0,0,.03)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-btn-src-open{background:rgba(37,99,235,.1)!important;color:#1d4ed8!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-btn-src-paste{background:rgba(109,40,217,.1)!important;color:#6d28d9!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-rp-hdr{color:#0a8a87!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-rp-qlbl{color:rgba(0,0,0,.3)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-rp-ta{background:rgba(0,0,0,.03)!important;border-color:rgba(0,0,0,.12)!important;color:rgba(0,0,0,.75)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-rp-ta:focus{border-color:rgba(93,214,204,.4)!important}',
      '#orbit-bridge-toolbar-v120.ob-light .ob-btn-back{background:rgba(0,0,0,.05)!important;color:rgba(0,0,0,.45)!important;border-color:rgba(0,0,0,.1)!important}',
      '#orbit-bridge-toolbar-v120.ob-sized{display:flex!important;flex-direction:column!important;overflow:hidden!important}',
      '#orbit-bridge-toolbar-v120.ob-sized .ob-pane.ob-active{flex:1!important;overflow-y:auto!important;min-height:0!important}',
      '#orbit-bridge-toolbar-v120.ob-sized .ob-resp-body{flex:1!important;min-height:0!important}',
      '#orbit-bridge-toolbar-v120.ob-sized .ob-resp-hdr{flex-shrink:0!important}',
      '#orbit-bridge-toolbar-v120.ob-sized .ob-sources{flex-shrink:0!important}',
      '#orbit-bridge-toolbar-v120.ob-sized .ob-resp-btns{flex-shrink:0!important}',
      '#orbit-bridge-toolbar-v120.ob-sized .ob-resp-ta{flex:1!important;height:auto!important;min-height:60px!important}',
      '#orbit-bridge-toolbar-v120 .ob-resp-ta::-webkit-scrollbar{display:none!important}',
      '#orbit-bridge-toolbar-v120 .ob-resize-handle{display:none!important}',
      '#orbit-bridge-toolbar-v120.ob-resp-active .ob-resize-handle{display:block!important}',
    ].join('\n');
    if (typeof GM_addStyle !== 'undefined') {
      GM_addStyle(_css);
    } else {
      const _s = document.createElement('style');
      _s.textContent = _css;
      (document.head || document.documentElement).appendChild(_s);
    }
  }


  function buildToolbar() {
    injectStyles();
    const wrap = document.createElement('div');
    wrap.id = TOOLBAR_ID;

    /* ── HEADER ── */
    const hdr = document.createElement('div');
    hdr.className = 'ob-hdr';
    const hdrLeft = document.createElement('div');
    hdrLeft.className = 'ob-hdr-left';
    const hdrIcon = document.createElement('div');
    hdrIcon.className = 'ob-hdr-icon';
    hdrIcon.textContent = '\uD83D\uDD17';
    const hdrText = document.createElement('div');
    hdrText.className = 'ob-hdr-text';
    const hdrTitle = document.createElement('div');
    hdrTitle.className = 'ob-hdr-title';
    hdrTitle.textContent = 'ORBIT–ABC Bridge';
    hdrText.append(hdrTitle);
    hdrLeft.append(hdrIcon, hdrText);
    const hdrRight = document.createElement('div');
    hdrRight.className = 'ob-hdr-right';
    const themeBtn = document.createElement('button');
    themeBtn.id = 'ob-theme-btn';
    themeBtn.className = 'ob-hdr-btn';
    themeBtn.textContent = '\u2600\uFE0F';
    themeBtn.title = 'Switch to light mode';
    const minBtn = document.createElement('button');
    minBtn.id = 'ob-min-btn';
    minBtn.className = 'ob-hdr-btn ob-min';
    minBtn.textContent = '\u2212';
    minBtn.title = 'Minimise';
    hdrRight.append(themeBtn, minBtn);
    hdr.append(hdrLeft, hdrRight);

    /* ── STATUS BAR ── */
    const sbar = document.createElement('div');
    sbar.className = 'ob-sbar';
    const sbarDot = document.createElement('span');
    sbarDot.id = 'ob-sbar-dot';
    sbarDot.className = 'ob-sdot';
    const sbarText = document.createElement('span');
    sbarText.id = 'ob-sbar-text';
    sbarText.className = 'ob-stext';
    sbarText.textContent = 'Ready';
    sbar.append(sbarDot, sbarText);

    /* ── FETCH PANE ── */
    const fetchPane = document.createElement('div');
    fetchPane.id = 'ob-fetch-pane';
    fetchPane.className = 'ob-pane ob-active';

    const body = document.createElement('div');
    body.className = 'ob-body';

    const secLbl = document.createElement('div');
    secLbl.className = 'ob-sec-lbl';
    secLbl.textContent = 'Query Mode';

    /* mode toggle — CSS radio trick (input:checked + label) */
    const toggle = document.createElement('div');
    toggle.className = 'ob-toggle';
    [['single', '\u26A1 Single query', true], ['context', '\uD83D\uDD04 With context', false]].forEach(([val, lbl, checked]) => {
      const w = document.createElement('div');
      w.style.flex = '1';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'ob-mode'; radio.value = val; radio.checked = checked;
      radio.id = 'ob-mode-' + val;
      const label = document.createElement('label');
      label.htmlFor = 'ob-mode-' + val;
      label.className = 'ob-toggle-lbl';
      if (val === 'single') {
        const ico = document.createElement('span');
        ico.className = 'ob-icon-lbl';
        ico.textContent = '\u26A1';
        label.appendChild(ico);
        label.appendChild(document.createTextNode(' Single query'));
      } else {
        label.textContent = lbl;
      }
      w.append(radio, label);
      toggle.appendChild(w);
    });

    /* action row */
    const actionRow = document.createElement('div');
    actionRow.className = 'ob-action-row';
    actionRow.id = 'ob-action-row';

    const fetchBtn = document.createElement('button');
    fetchBtn.id = 'ob-fetch-btn';
    fetchBtn.className = 'ob-abtn ob-abtn-send';
    fetchBtn.title = 'Send query to ABC';
    const _fi = document.createElement('span');
    _fi.className = 'ob-icon-lbl';
    _fi.textContent = '\u26A1';
    fetchBtn.appendChild(_fi);
    fetchBtn.appendChild(document.createTextNode(' Send Directly'));

    const editBtn = document.createElement('button');
    editBtn.id = 'ob-edit-btn';
    editBtn.className = 'ob-abtn ob-abtn-edit';
    editBtn.title = 'Edit before sending';
    editBtn.textContent = '\u270F\uFE0F Edit & Ask';

    const MODE_KEY = 'ob_action_mode';
    const getMode = () => localStorage.getItem(MODE_KEY) || 'send';
    const modeTgl = document.createElement('button');
    modeTgl.id = 'ob-mode-tgl';
    modeTgl.className = 'ob-abtn ob-abtn-mode';
    modeTgl.textContent = '\u21C4';
    modeTgl.title = 'Switch mode \u00B7 Send / Edit';
    const applyMode = () => {
      const isSend = getMode() === 'send';
      modeTgl.classList.toggle('edit-active', !isSend);
      fetchBtn.style.setProperty('display', isSend ? 'flex' : 'none', 'important');
      editBtn.style.setProperty('display', isSend ? 'none' : 'flex', 'important');
    };
    applyMode();
    modeTgl.addEventListener('click', () => {
      localStorage.setItem(MODE_KEY, getMode() === 'send' ? 'edit' : 'send');
      applyMode();
    });
    actionRow.append(fetchBtn, editBtn, modeTgl);

    const statusLine = document.createElement('div');
    statusLine.id = 'ob-status-line';
    statusLine.className = 'ob-sline';
    statusLine.textContent = 'Ready \u2014 select a customer message';

    body.append(secLbl, toggle, actionRow, statusLine);

    const divider1 = document.createElement('div');
    divider1.className = 'ob-divider';

    const footer1 = document.createElement('div');
    footer1.className = 'ob-footer';
    const clearChatBtn = document.createElement('button');
    clearChatBtn.id = 'ob-clear-chat-btn';
    clearChatBtn.className = 'ob-btn ob-btn-clear';
    clearChatBtn.textContent = '\uD83D\uDDD1 Clear Chat';
    const reloadBCBtn = document.createElement('button');
    reloadBCBtn.id = 'ob-reload-bc-btn';
    reloadBCBtn.className = 'ob-btn ob-btn-reload';
    reloadBCBtn.textContent = '\u21BA Reload ABC';
    footer1.append(clearChatBtn, reloadBCBtn);

    fetchPane.append(body, divider1, footer1);

    /* ── BUSY PANE ── */
    const busyPane = document.createElement('div');
    busyPane.id = 'ob-busy-pane';
    busyPane.className = 'ob-pane';

    const busyInner = document.createElement('div');
    busyInner.className = 'ob-busy-inner';
    const spinner = document.createElement('div');
    spinner.className = 'ob-spinner';
    const busyLbl = document.createElement('div');
    busyLbl.id = 'ob-busy-lbl';
    busyLbl.className = 'ob-busy-lbl';
    busyLbl.textContent = 'Waiting for ABC response\u2026';
    const busySub = document.createElement('div');
    busySub.className = 'ob-busy-sub';
    busySub.textContent = 'SSE stream open \u00B7 up to 90s timeout';
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ob-cancel-btn';
    cancelBtn.className = 'ob-btn-cancel';
    cancelBtn.textContent = '\u2715 Cancel';
    busyInner.append(spinner, busyLbl, busySub, cancelBtn);

    const divider2 = document.createElement('div');
    divider2.className = 'ob-divider';

    const footer2 = document.createElement('div');
    footer2.className = 'ob-footer';
    const clearDisabled = document.createElement('button');
    clearDisabled.className = 'ob-btn ob-btn-clear';
    clearDisabled.textContent = '\uD83D\uDDD1 Clear Chat';
    clearDisabled.disabled = true;
    const reloadDisabled = document.createElement('button');
    reloadDisabled.className = 'ob-btn ob-btn-reload';
    reloadDisabled.textContent = '\u21BA Reload ABC';
    reloadDisabled.disabled = true;
    footer2.append(clearDisabled, reloadDisabled);

    busyPane.append(busyInner, divider2, footer2);

    /* ── RESPONSE PANE ── */
    const respPane = document.createElement('div');
    respPane.id = 'ob-resp-pane';
    respPane.className = 'ob-pane';

    const respBody = document.createElement('div');
    respBody.className = 'ob-resp-body';

    const respHdr = document.createElement('div');
    respHdr.className = 'ob-resp-hdr';
    const checkIco = document.createElement('div');
    checkIco.className = 'ob-check-ico';
    checkIco.textContent = '\u2713';
    respHdr.append(checkIco, document.createTextNode('Response ready'));

    const respText = document.createElement('textarea');
    respText.id = 'ob-resp-text';
    respText.className = 'ob-resp-ta';
    respText.spellcheck = false;

    const sourcesSection = document.createElement('div');
    sourcesSection.id = 'ob-sources-section';
    sourcesSection.className = 'ob-sources';
    sourcesSection.style.setProperty('display', 'none', 'important');

    const sourcesLabel = document.createElement('div');
    sourcesLabel.id = 'ob-sources-label';
    sourcesLabel.className = 'ob-src-lbl';
    sourcesLabel.textContent = '\uD83D\uDCCE Sources';

    const sourcesList = document.createElement('div');
    sourcesList.id = 'ob-sources-list';

    sourcesSection.append(sourcesLabel, sourcesList);

    const respBtns = document.createElement('div');
    respBtns.className = 'ob-resp-btns';

    const useBtn = document.createElement('button');
    useBtn.className = 'ob-btn ob-btn-use';
    useBtn.textContent = '\u2713 Use this';

    const retestBtn = document.createElement('button');
    retestBtn.className = 'ob-btn ob-btn-retest';
    retestBtn.textContent = '\u21BA Retest';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'ob-btn ob-btn-discard';
    discardBtn.textContent = '\u2715 Discard';

    respBtns.append(useBtn, retestBtn, discardBtn);
    respBody.append(respHdr, respText, sourcesSection, respBtns);
    respPane.appendChild(respBody);

    /* ── REPHRASE PANE ── */
    const rpPane = document.createElement('div');
    rpPane.id = 'ob-rephrase-pane';
    rpPane.className = 'ob-pane';

    const rpBody = document.createElement('div');
    rpBody.className = 'ob-rp-body';

    const rpHdr = document.createElement('div');
    rpHdr.className = 'ob-rp-hdr';
    rpHdr.textContent = '\u270F\uFE0F Edit queries before sending';

    const rpContainer = document.createElement('div');
    rpContainer.id = 'ob-rp-container';

    const rpBtns = document.createElement('div');
    rpBtns.className = 'ob-rp-btns';

    const rpSendBtn = document.createElement('button');
    rpSendBtn.id = 'ob-rp-send-btn';
    rpSendBtn.className = 'ob-btn ob-btn-rp-send';
    rpSendBtn.textContent = '\u26A1 Send to ABC';

    const rpBackBtn = document.createElement('button');
    rpBackBtn.className = 'ob-btn ob-btn-back';
    rpBackBtn.textContent = '\u2190 Back';

    rpBtns.append(rpSendBtn, rpBackBtn);
    rpBody.append(rpHdr, rpContainer, rpBtns);
    rpPane.appendChild(rpBody);

    /* ── ASSEMBLE ── */
    wrap.append(hdr, sbar, fetchPane, busyPane, respPane, rpPane);
    document.body.appendChild(wrap);
    makeDraggable(wrap, hdr);
    makeResizable(wrap);

    /* theme toggle */
    const THEME_KEY = 'ob_theme';
    const applyTheme = (t) => {
      wrap.classList.toggle('ob-light', t === 'light');
      themeBtn.textContent = t === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
      themeBtn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    };
    applyTheme(GM_getValue(THEME_KEY, 'dark'));
    themeBtn.addEventListener('click', () => {
      const nt = wrap.classList.contains('ob-light') ? 'dark' : 'light';
      GM_setValue(THEME_KEY, nt);
      applyTheme(nt);
    });

    /* minimise */
    minBtn.addEventListener('click', () => {
      const panes = wrap.querySelectorAll('.ob-pane');
      const active = Array.from(panes).find(p => p.classList.contains('ob-active'));
      if (active) {
        wrap.dataset.lastPane = active.id || 'ob-fetch-pane';
        panes.forEach(p => p.classList.remove('ob-active'));
        body.style.setProperty('display', 'none', 'important');
        sbar.style.setProperty('display', 'none', 'important');
        minBtn.textContent = '+';
      } else {
        body.style.removeProperty('display');
        sbar.style.removeProperty('display');
        (document.getElementById(wrap.dataset.lastPane) || fetchPane).classList.add('ob-active');
        minBtn.textContent = '\u2212';
      }
    });

    fetchBtn.addEventListener('click',     onFetchClick);
    editBtn.addEventListener('click',      onEditAskClick);
    rpBackBtn.addEventListener('click',    () => showFetchPane());
    rpSendBtn.addEventListener('click',    onSendRephrase);
    clearChatBtn.addEventListener('click', onClearChatClick);
    reloadBCBtn.addEventListener('click',  onReloadBCClick);
    cancelBtn.addEventListener('click',    () => { showFetchPane(); setSBar('Cancelled', 'err'); setStatus('\u26A0\uFE0F Request cancelled', 'warn'); });
    useBtn.addEventListener('click',       async () => {
      const _respText = document.getElementById('ob-resp-text').value;
      // Re-select the original message if user navigated away while BC was fetching
      if (_anchorRow && _anchorRow.isConnected && !_anchorRow.classList.contains('selected')) {
        _anchorRow.click();
        await sleep(400);
      }
      _anchorRow = null;
      pasteResponse(_respText);
      showFetchPane();
    });
    retestBtn.addEventListener('click',    () => { showFetchPane(); onFetchClick(); });
    discardBtn.addEventListener('click',   () => { _anchorRow = null; showFetchPane(); setStatus('Ready \u2014 select a customer message', ''); });
  }


  /* ── Pane helpers ─────────────────────────────────────────────── */
  function _showPane(id) {
    document.querySelectorAll('#' + TOOLBAR_ID + ' .ob-pane').forEach(p => p.classList.remove('ob-active'));
    const t = document.getElementById(id);
    if (t) t.classList.add('ob-active');
    const _spW = document.getElementById(TOOLBAR_ID);
    if (!_spW) return;
    const isResp = id === 'ob-resp-pane';
    _spW.classList.toggle('ob-resp-active', isResp);
    if (isResp) {
      try {
        const _s = JSON.parse(localStorage.getItem('ob_panel_size') || '{}');
        if (_s.w) _spW.style.setProperty('width',  _s.w + 'px', 'important');
        if (_s.h) { _spW.style.setProperty('height', _s.h + 'px', 'important'); _spW.classList.add('ob-sized'); }
      } catch(_e) {}
    } else {
      _spW.classList.remove('ob-sized');
      _spW.style.removeProperty('width');
      _spW.style.removeProperty('height');
    }
  }

  function showBusyPane(label) {
    const wrap = document.getElementById(TOOLBAR_ID);
    if (wrap) wrap.dataset.lastPane = 'ob-fetch-pane';
    const lbl = document.getElementById('ob-busy-lbl');
    if (lbl) lbl.textContent = label || 'Waiting for ABC response\u2026';
    _showPane('ob-busy-pane');
    setSBar('Fetching\u2026', 'busy');
  }

  function setSBar(text, dotClass) {
    const dot = document.getElementById('ob-sbar-dot');
    const lbl = document.getElementById('ob-sbar-text');
    if (dot) dot.className = 'ob-sdot' + (dotClass ? ' ' + dotClass : '');
    if (lbl) lbl.textContent = text || 'Ready';
  }

  function showFetchPane() {
    const wrap = document.getElementById(TOOLBAR_ID);
    if (wrap) wrap.dataset.lastPane = 'ob-fetch-pane';
    _showPane('ob-fetch-pane');
    const btn = document.getElementById('ob-fetch-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="ob-icon-lbl">\u26A1</span> Send Directly'; }
  }

  function showRespPane(text, sourceLinks) {
    const el = document.getElementById('ob-resp-text');
    if (el) el.value = text;

    const sourcesList    = document.getElementById('ob-sources-list');
    const sourcesSection = document.getElementById('ob-sources-section');
    const sourcesLabel   = document.getElementById('ob-sources-label');
    if (sourcesList && sourcesSection) {
      sourcesList.innerHTML = '';
      const links = sourceLinks && sourceLinks.length ? sourceLinks : [];
      if (links.length > 0) {
        if (sourcesLabel) sourcesLabel.textContent = '\uD83D\uDCCE Sources (' + links.length + ')';
        links.forEach(function({ url, text: linkText }) {
          const row = document.createElement('div');
          row.className = 'ob-src-row';
          const lbl = document.createElement('span');
          lbl.className = 'ob-src-name';
          lbl.title = url;
          lbl.textContent = linkText || url;
          const openBtn = document.createElement('button');
          openBtn.className = 'ob-btn-src ob-btn-src-open';
          openBtn.textContent = 'Open';
          openBtn.addEventListener('click', function() { window.open(url, '_blank'); });
          const pasteBtn = document.createElement('button');
          pasteBtn.className = 'ob-btn-src ob-btn-src-paste';
          pasteBtn.textContent = 'Paste';
          pasteBtn.addEventListener('click', function() {
            const respEl = document.getElementById('ob-resp-text');
            if (!respEl) return;
            respEl.value = (respEl.value || '') + (respEl.value ? '\n' : '') + url;
            respEl.focus();
          });
          row.append(lbl, openBtn, pasteBtn);
          sourcesList.appendChild(row);
        });
        sourcesSection.style.setProperty('display', 'flex', 'important');
        sourcesSection.style.setProperty('flex-direction', 'column', 'important');
      } else {
        sourcesSection.style.setProperty('display', 'none', 'important');
      }
    }
    const wrap = document.getElementById(TOOLBAR_ID);
    if (wrap) wrap.dataset.lastPane = 'ob-resp-pane';
    _showPane('ob-resp-pane');
    setSBar('Response captured', 'ok');
    setStatus('', '');
  }


  async function onFetchClick() {
    const inFlight = GM_getValue(KEY_PROCESSING, '');
    if (inFlight) {
      setStatus('\u29D7 BC still busy \u2014 please wait\u2026', 'warn');
      return;
    }
    const mode = document.querySelector('input[name="ob-mode"]:checked')?.value || 'single';
    const queries = extractQueries(mode);
    if (!queries.length) {
      setStatus('\u26A0\uFE0F No customer query found \u2014 select a message first.', 'err');
      return;
    }
        _anchorRow = document.querySelector('#conversation-display > div.message.customer.selected');
    showBusyPane('Waiting for BC response\u2026');
    setStatus('', '');
    await dispatchToBC(queries, mode);
  }

  async function dispatchToBC(queries, mode) {
    const reqId = Date.now();
    await GM_setValue(KEY_REQ, JSON.stringify({ queries, mode, reqId }));
    const baReady = GM_getValue(KEY_READY, '');
    if (baReady !== '1') {
      console.log('[ORBIT Bridge] BA tab not ready, opening\u2026');
      if (typeof GM_openInTab !== 'undefined') {
        GM_openInTab(BA_URL, { active: false, insert: true });
      } else {
        window.open(BA_URL, 'orbit_ba_tab');
        setTimeout(() => { try { window.focus(); } catch(e){} }, 100);
      }
    } else {
      console.log('[ORBIT Bridge] BA tab ready, request dispatched silently');
    }
    setSBar(queries.length + ' quer' + (queries.length > 1 ? 'ies' : 'y') + ' sent to BC\u2026', 'busy');
  }

  function showRephrasePane(queries) {
    const container = document.getElementById('ob-rp-container');
    if (!container) return;
    container.innerHTML = '';
    queries.forEach((q, i) => {
      const lbl = document.createElement('div');
      lbl.className = 'ob-rp-qlbl';
      lbl.textContent = queries.length > 1 ? 'Query ' + (i + 1) : 'Query';
      const ta = document.createElement('textarea');
      ta.className = 'ob-rp-query ob-rp-ta';
      ta.value = q;
      ta.rows = 3;
      ta.spellcheck = false;
      container.append(lbl, ta);
    });
    _showPane('ob-rephrase-pane');
    setSBar('Edit mode \u00B7 ' + queries.length + ' quer' + (queries.length > 1 ? 'ies' : 'y'), '');
  }

  async function onEditAskClick() {
    const inFlight = GM_getValue(KEY_PROCESSING, '');
    if (inFlight) {
      setStatus('\u29D7 BC still busy \u2014 please wait\u2026', 'warn');
      return;
    }
    const mode = document.querySelector('input[name="ob-mode"]:checked')?.value || 'single';
    const queries = extractQueries(mode);
    if (!queries.length) {
      setStatus('\u26A0\uFE0F No customer query found \u2014 select a message first.', 'err');
      return;
    }
    const rpPane = document.getElementById('ob-rephrase-pane');
    if (rpPane) rpPane.dataset.mode = mode;
    showRephrasePane(queries);
  }

  async function onSendRephrase() {
    const rpPane = document.getElementById('ob-rephrase-pane');
    const mode = rpPane?.dataset.mode || 'single';
    const queries = Array.from(document.querySelectorAll('.ob-rp-query'))
      .map(ta => ta.value.trim()).filter(Boolean);
    if (!queries.length) {
      setStatus('\u26A0\uFE0F Query box is empty.', 'err');
      return;
    }
        _anchorRow = document.querySelector('#conversation-display > div.message.customer.selected');
    showBusyPane('Sending queries to BC\u2026');
    setStatus('', '');
    await dispatchToBC(queries, mode);
  }

  function extractQueries(mode) {
    if (mode === 'single') {
      const el = document.querySelector(SEL.QUERY_SELECTED);
      const text = el?.textContent?.trim();
      return text ? [text] : [];
    } else {
      const allRows = Array.from(document.querySelectorAll('#conversation-display > div.message.customer'));
      const selectedIdx = allRows.findIndex(row => row.classList.contains('selected'));
      const rows = selectedIdx === -1 ? allRows : allRows.slice(0, selectedIdx + 1);
      return rows.map(row => row.querySelector('div.message-bubble')?.textContent?.trim()).filter(Boolean);
    }
  }

  function setStatus(msg, cls) {
    const el = document.getElementById('ob-status-line');
    if (!el) return;
    el.textContent = msg;
    el.className = 'ob-sline';
    if (cls) el.classList.add(cls);
  }

  function onClearChatClick() { sendBCCommand('clear'); }
  function onReloadBCClick()  { sendBCCommand('reload'); }
  async function sendBCCommand(action) {
    await GM_setValue(KEY_CMD, JSON.stringify({ action, cmdId: Date.now() }));
    setStatus(action === 'clear' ? '\uD83D\uDDD1 Clearing BC chat\u2026' : '\u21BA Reloading BC page\u2026', 'info');
    setSBar(action === 'clear' ? 'Clearing\u2026' : 'Reloading\u2026', 'busy');
    setTimeout(() => {
      const s = document.getElementById('ob-status-line');
      if (s && (s.textContent.includes('Clearing') || s.textContent.includes('Reloading'))) {
        setStatus('Ready \u2014 select a customer message', '');
        setSBar('Ready', '');
      }
    }, 3000);
  }

  function listenForBAResponse() {
    GM_addValueChangeListener(KEY_RES, (_, __, newVal) => {
      if (!newVal) return;
      try {
        const d = JSON.parse(newVal);
        if (d.status === 'success') {
          showRespPane(d.text, d.sourceLinks || []);
        } else {
          showFetchPane();
          setSBar('Error', 'err');
          setStatus('\u274C ' + (d.error || 'ABC returned no response'), 'err');
        }
      } catch(e) { /* ignore */ }
    });
  }

  function pasteResponse(text) {
    let ta = document.querySelector(SEL.EXPECTED);
    if (!ta) {
      for (const node of document.querySelectorAll('label, span, div, p')) {
        if (/^expected response$/i.test(node.textContent.trim())) {
          let sib = node.nextElementSibling;
          while (sib) {
            const found = sib.tagName === 'TEXTAREA' ? sib : sib.querySelector('textarea');
            if (found) { ta = found; break; }
            sib = sib.nextElementSibling;
          }
          if (ta) break;
        }
      }
    }
    if (!ta) { alert('[ORBIT Bridge] Expected Response field not found.\nPaste manually:\n\n' + text); return; }
    setReactValue(ta, text);
    ta.focus();
    ta.style.setProperty('outline', '2px solid #4ade80', 'important');
    setTimeout(() => ta.style.removeProperty('outline'), 2000);
    setSBar('Pasted!', 'ok');
    setStatus('\u2705 Pasted into Expected Response', 'ok');
    setTimeout(() => { setSBar('Ready', ''); setStatus('Ready \u2014 select a customer message', ''); }, 3000);
  }


  // Module-level callback — shared between XHR hook (document-start) and captureResponse closure.
  // Using a plain variable avoids Tampermonkey sandbox cross-realm event issues.
  let _xhrCaptureCallback = null;
  let _anchorRow = null; // message row that triggered the active BC request

  if (IS_BA) {
    window.name = 'orbit_ba_tab';

    window.__bcSSE = { done: null, start: null, text: '' };
    (function installSSEHook() {
      const _ES = window.EventSource;
      if (!_ES) return;
      function _sseChunk(data) {
        if (!data || data === '[DONE]') return '';
        try {
          const d = JSON.parse(data);
          return d.content || d.text || d.delta || d.chunk || d.token ||
                 d.message || d.answer || d.output ||
                 (d.choices && d.choices[0] &&
                   (d.choices[0].delta?.content || d.choices[0].text)) || '';
        } catch(_) { return data === '[DONE]' ? '' : data; }
      }
      window.EventSource = function(url, init) {
        const inst = new _ES(url, init);
        window.__bcSSE.start = Date.now();
        window.__bcSSE.done  = null;
        window.__bcSSE.text  = '';
        console.log('[ORBIT Bridge] SSE intercepted:', url);
        inst.addEventListener('message', function(e) {
          const c = _sseChunk(e.data); if (c) window.__bcSSE.text += c;
        });
        ['token','chunk','delta','content','response','answer'].forEach(function(n) {
          inst.addEventListener(n, function(e) {
            const c = _sseChunk(e.data); if (c) window.__bcSSE.text += c;
          });
        });
        inst.addEventListener('error', function() {
          if (inst.readyState === 2) {
            window.__bcSSE.done = Date.now();
            console.log('[ORBIT Bridge] SSE done. Direct text: ' + window.__bcSSE.text.length + 'ch');
          }
        });
        return inst;
      };
      window.EventSource.prototype    = _ES.prototype;
      window.EventSource.CONNECTING   = 0;
      window.EventSource.OPEN         = 1;
      window.EventSource.CLOSED       = 2;
    })();

    // XHR hook — intercepts BC's streaming XHR at BOTH readyState 3 (first chunk, pre-typewriting)
    // and readyState 4 (load, fallback). Uses _xhrCaptureCallback (plain closure var) to call
    // captureResponse directly — avoids Tampermonkey sandbox cross-realm event issues.
    (function installXHRHook() {
      var _origOpen = XMLHttpRequest.prototype.open;
      var _origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url) {
        try { this._bcUrl = (typeof url === 'string') ? url : String(url); } catch(_) {}
        return _origOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        if (this._bcUrl) {
          var lo = this._bcUrl.toLowerCase();
          var isMatch = (
            lo.indexOf('chat') !== -1 || lo.indexOf('message') !== -1 ||
            lo.indexOf('conversation') !== -1 || lo.indexOf('bot') !== -1 ||
            lo.indexOf('assist') !== -1 || lo.indexOf('query') !== -1 ||
            lo.indexOf('copilot') !== -1
          ) && lo.indexOf('telemetry') === -1 && lo.indexOf('analytics') === -1
            && lo.indexOf('tracking') === -1 && lo.indexOf('login') === -1
            && lo.indexOf('auth') === -1 && lo.indexOf('token') === -1;

          if (isMatch) {
            var _url = this._bcUrl;
            var _fired = false;   // prevent duplicate fires per XHR instance
            console.log('[ORBIT Bridge] XHR watching:', _url);

            // Shared extractor — tries JSON then SSE-over-XHR format
            var _extract = function(responseText) {
              // Path A: complete JSON body
              try {
                var res = JSON.parse(responseText);
                var t = res.response || res.message || res.botMessage || res.botResponse ||
                        res.answer || res.text || res.output || res.reply ||
                        (res.data && (res.data.response || res.data.message || res.data.text)) || '';
                if (t && String(t).length > 10) return String(t);
              } catch(ea) {}
              // Path B: SSE-over-XHR — walk "data: {...}" lines from the end for last real chunk
              try {
                var lines = responseText.split('\n');
                for (var i = lines.length - 1; i >= 0; i--) {
                  var line = lines[i].trim();
                  if (line.indexOf('data:') !== 0) continue;
                  var payload = line.replace(/^data:\s*/, '').trim();
                  if (payload === '[DONE]') continue;
                  try {
                    var d = JSON.parse(payload);
                    var t2 = d.response || d.message || d.text || d.answer || d.output || d.reply || '';
                    if (t2 && String(t2).length > 10) return String(t2);
                  } catch(eb) {}
                }
              } catch(ec) {}
              return null;
            };

            var _notify = function(text, stage, raw) {
              if (_fired) return;
              _fired = true;
              var _now = Date.now();
              // Store raw body so extractSourceLinksFromXHR() can pull sources from it
              window.__bcXHR = { text: text, time: _now, url: _url, raw: raw || '' };
              console.log('[ORBIT Bridge] XHR captured (' + stage + '):', text.length, 'ch from', _url);
              // Direct closure call — same sandbox scope, no cross-realm boundary
              try { if (typeof _xhrCaptureCallback === 'function') _xhrCaptureCallback(text, _now); } catch(e) {}
            };

            // readystatechange at state 3 = first streaming chunk arrives (BEFORE typewriting starts)
            this.addEventListener('readystatechange', function() {
              if (_fired) return;
              if (this.readyState === 3 && this.status >= 200 && this.status < 300) {
                var raw = this.responseText || '';
                var t = _extract(raw);
                if (t) _notify(t, 'streaming-rs3', raw);
              }
            });

            // load = full response received (fallback if streaming parse didn't fire)
            this.addEventListener('load', function() {
              if (this.status >= 200 && this.status < 300) {
                var raw = this.responseText || '';
                var t = _extract(raw);
                if (t) _notify(t, 'final-load', raw);
              }
            });
          }
        }
        return _origSend.apply(this, arguments);
      };
    })();

    async function bootBA() {
      console.log('[ORBIT Bridge] BA: waiting for SPA to mount...');
      const anySpaEl = await waitFor(['button', '[role="button"]', 'textarea'], 30000);
      if (!anySpaEl) {
        console.error('[ORBIT Bridge] BA: SPA never hydrated after 30s, aborting');
        return;
      }
      console.log('[ORBIT Bridge] BA: SPA ready, building pill');
      buildPill();
      listenForRequest();
      console.log('[ORBIT Bridge] BA pill mounted');
      listenForBCCommands();
      window.addEventListener('beforeunload', () => { try { GM_setValue(KEY_READY, ''); } catch(e){} });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootBA);
    } else {
      bootBA();
    }
  }

  let pillEl      = null;
  let lastReqId   = 0;
  let panelBefore = '';

  function buildPill() {
    GM_setValue(KEY_READY, '1');
    window.name = 'orbit_ba_tab';
    pillEl = document.createElement('div');
    pillEl.id = 'orbit-ba-pill-v120';
    pillEl.textContent = '\uD83D\uDD17 ORBIT–ABC Bridge: Ready';
    css(pillEl, {
      position: 'fixed', bottom: '16px', right: '16px',
      background: '#232f3e', color: '#fff', padding: '5px 14px',
      borderRadius: '20px', fontSize: '12px', zIndex: '2147483647',
      boxShadow: '0 2px 8px rgba(0,0,0,.3)', pointerEvents: 'none',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    });
    document.body.appendChild(pillEl);
  }

  function setPill(text, bg = '#232f3e') {
    if (!pillEl) return;
    pillEl.textContent = '\uD83D\uDD17 ORBIT: ' + text;
    pillEl.style.setProperty('background', bg, 'important');
  }

  function listenForRequest() {
    const queue = [];
    let busy = false;

    const runNext = async () => {
      if (busy || queue.length === 0) return;
      busy = true;
      const d = queue.shift();
      GM_setValue(KEY_PROCESSING, String(d.reqId));
      try {
        await processRequest(d);
        GM_setValue(KEY_REQ, '');
      } finally {
        GM_setValue(KEY_PROCESSING, '');
        busy = false;
        runNext();
      }
    };

    const enqueue = (d) => {
      if (!d || !d.reqId || d.reqId === lastReqId) return;
      lastReqId = d.reqId;
      if (busy) console.log('[ORBIT Bridge] BC busy \u2014 queueing reqId', d.reqId);
      queue.push(d);
      runNext();
    };

    try {
      const pending = GM_getValue(KEY_REQ, null);
      if (pending) {
        const d = JSON.parse(pending);
        const ageMs = Date.now() - (d.reqId || 0);
        if (d.reqId && ageMs < 120000) enqueue(d);
        else if (ageMs >= 120000) GM_setValue(KEY_REQ, '');
      }
    } catch(e) { /* ignore */ }

    GM_addValueChangeListener(KEY_REQ, (_, __, newVal) => {
      if (!newVal) return;
      try {
        const d = JSON.parse(newVal);
        console.log('[ORBIT Bridge] BC received request, queries:', d.queries);
        enqueue(d);
      } catch (e) { console.error('[ORBIT Bridge] BC listener error:', e); }
    });
  }

  function listenForBCCommands() {
    GM_addValueChangeListener(KEY_CMD, async (_, __, newVal) => {
      if (!newVal) return;
      try {
        const { action } = JSON.parse(newVal);
        console.log('[ORBIT Bridge] BC command received:', action);
        if (action === 'reload') {
          location.reload();
        } else if (action === 'clear') {
          await clearChat();
        }
      } catch (e) { console.error('[ORBIT Bridge] cmd error:', e); }
    });
  }

  async function clearChat() {
    const input = await waitFor(SEL.BA_INPUT, 8000);
    if (input) {
      await ensureChatOpen(input);
      await sleep(400);
    }
    const dotsBtn = document.querySelector('button[data-testid="show-more-options"]');
    if (!dotsBtn) {
      console.warn('[ORBIT Bridge] clear chat: three-dots button not found');
      return;
    }
    dotsBtn.click();
    const clearItem = await waitForText('[slot="label"]', 'Clear chat', 2000);
    if (!clearItem) {
      console.warn('[ORBIT Bridge] clear chat: "Clear chat" menu item not found');
      return;
    }
    (clearItem.closest('[role="menuitem"]') || clearItem).click();
    const yesBtn = await waitFor('button[data-testid="confirm-clear-chat"]', 3000);
    if (!yesBtn) {
      console.warn('[ORBIT Bridge] clear chat: confirm button not found');
      return;
    }
    yesBtn.click();
    console.log('[ORBIT Bridge] clear chat: confirmed \u2713');
  }

  function getBubbleContainer(bubble) {
    if (!bubble) return null;
    let node = bubble.parentElement;
    for (let d = 0; node && node !== document.body && d < 5; d++, node = node.parentElement) {
      if (node.querySelector('details')) return node;
    }
    return bubble.parentElement?.parentElement || bubble.parentElement || bubble;
  }

  // Extracts source links from the raw XHR body captured by the XHR hook.
  // Called immediately after captureResponse resolves — no typewriting wait needed.
  // Falls back to empty array if the XHR body doesn't contain source data.
  function extractSourceLinksFromXHR() {
    const raw = window.__bcXHR && window.__bcXHR.raw;
    if (!raw) return [];
    const _parseSources = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const mapped = arr.map(s => {
        const url = (typeof s === 'string') ? s
          : (s.url || s.href || s.link || s.uri || s.source || s.id || '');
        const text = (typeof s === 'string') ? s
          : (s.title || s.name || s.text || s.label || s.displayText || url);
        return url ? { url: String(url), text: String(text || url) } : null;
      }).filter(Boolean);
      return mapped.length ? mapped : null;
    };
    const SOURCE_KEYS = ['sources', 'citations', 'references', 'sourceLinks',
                         'sourceDocuments', 'grounding', 'groundingChunks',
                         'context', 'docs', 'passages'];
    // Path A: complete JSON body
    try {
      const res = JSON.parse(raw);
      // BC-specific: additionalContent.urls = [{ link, placeholderText }, ...]
      const _urls = res.additionalContent && res.additionalContent.urls;
      if (Array.isArray(_urls) && _urls.length) {
        return _urls
          .filter(u => u.link)
          .map(u => ({ url: u.link, text: 'Reference source ' + (u.placeholderText || u.link) }));
      }
      for (const key of SOURCE_KEYS) {
        const r = _parseSources(res[key]); if (r) return r;
      }
      if (res.data) {
        for (const key of SOURCE_KEYS) {
          const r = _parseSources(res.data[key]); if (r) return r;
        }
      }
    } catch(e) {}
    // Path B: SSE-over-XHR — check each data: line from the end
    try {
      const lines = raw.split('\n').reverse();
      for (const line of lines) {
        if (!line.trim().startsWith('data:')) continue;
        const payload = line.replace(/^data:\s*/, '').trim();
        if (payload === '[DONE]') continue;
        try {
          const d = JSON.parse(payload);
          for (const key of SOURCE_KEYS) {
            const r = _parseSources(d[key]); if (r) return r;
          }
        } catch(e) {}
      }
    } catch(e) {}
    return [];
  }

  function extractSourceLinks() {
    const bubbles = document.querySelectorAll(SEL.ASSISTANT_MSG);
    const last = bubbles[bubbles.length - 1];
    if (!last) return [];
    const container = getBubbleContainer(last);
    return Array.from(container.querySelectorAll('details a[href]'))
      .filter(a => a.href && !/^javascript/i.test(a.href))
      .map(a => ({ url: a.href, text: a.textContent.trim() || a.href }));
  }

  async function processRequest({ queries, mode, reqId }) {
    setPill('Processing\u2026', '#2980b9');
    try {
      const input = await waitFor(SEL.BA_INPUT, 20000);
      if (!input) throw new Error('BC chat input not found \u2014 check the BC page is fully loaded');
      const panelOpen = await ensureChatOpen(input);
      if (!panelOpen) throw new Error('BC chat panel did not open \u2014 click the chat button on the BC page first');
      console.log('[ORBIT Bridge] BA input found:', input.tagName, input.name || input.placeholder);

      let finalResponse = '';
      if (mode === 'single') {
        finalResponse = await sendAndCapture(input, queries[0]);
      } else {
        for (let i = 0; i < queries.length; i++) {
          setPill('Query ' + (i + 1) + '/' + queries.length + '\u2026', '#2980b9');
          const resp = await sendAndCapture(input, queries[i]);
          if (i === queries.length - 1) finalResponse = resp;
          if (i < queries.length - 1) {
            // Wait for BC to finish typewriting before sending the next query.
            // captureResponse resolves at the first XHR chunk (before typewriting),
            // so without this wait BC silently drops the next send while still animating.
            await waitForBCIdle(25000);
            window.__bcXHR = null; // clear stale XHR so next captureResponse starts clean
            await sleep(QUERY_GAP);
          }
        }
      }

      if (!finalResponse) throw new Error('BC response was empty');
      // Send response immediately — don't block on source extraction.
      await GM_setValue(KEY_RES, JSON.stringify({ status: 'success', text: finalResponse, sourceLinks: [], reqId }));
      setPill('Done ✓', '#27ae60');
      // Try to get source links from the XHR body immediately (same payload as response text).
      // If not present there, fall back to DOM extraction after typewriting ends.
      const _bgReqId = reqId, _bgText = finalResponse;
      const _xhrSL = extractSourceLinksFromXHR();
      if (_xhrSL.length > 0) {
        // Sources found in XHR — update right away, no wait
        console.log('[ORBIT Bridge] source links from XHR:', _xhrSL.length);
        await GM_setValue(KEY_RES, JSON.stringify({ status: 'success', text: _bgText, sourceLinks: _xhrSL, reqId: _bgReqId }));
      } else {
        // XHR had no sources — wait for DOM (sources appear after typewriting ends)
        (async () => {
          try {
            await waitForBCIdle(25000);
            let _dw = 0;
            while (_dw < 5000) {
              const _bubs = document.querySelectorAll(SEL.ASSISTANT_MSG);
              const _lb = _bubs[_bubs.length - 1];
              const _lbc = getBubbleContainer(_lb);
              if (_lbc && _lbc.querySelector('details')) break;
              await sleep(200);
              _dw += 200;
            }
            const _sl = extractSourceLinks();
            console.log('[ORBIT Bridge] source links from DOM (bg):', _sl.length);
            if (_sl.length > 0) {
              await GM_setValue(KEY_RES, JSON.stringify({ status: 'success', text: _bgText, sourceLinks: _sl, reqId: _bgReqId }));
            }
          } catch(_e) { console.warn('[ORBIT Bridge] source bg error:', _e); }
        })();
      }
    } catch (err) {
      console.error('[ORBIT Bridge BA]', err);
      await GM_setValue(KEY_RES, JSON.stringify({ status: 'error', error: err.message, reqId }));
      setPill('Error \u2014 ' + err.message, '#c0392b');
    }
    setTimeout(() => setPill('Ready', '#232f3e'), 4000);
  }

  async function sendAndCapture(input, query) {
    const panel = getChatPanel(input);
    panelBefore = panel?.innerText ?? '';
    const bubbleCountBeforeSend = document.querySelectorAll(SEL.ASSISTANT_MSG).length;
    console.log('[ORBIT Bridge] bubbleCountBeforeSend:', bubbleCountBeforeSend);

    input.focus();
    setReactValue(input, query);
    await sleep(500);

    const btn = findSendButton(input);
    console.log('[ORBIT Bridge] send button found:', btn ? btn.outerHTML.slice(0, 120) : 'NONE');

    const pressEnter = () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup',    { key: 'Enter', keyCode: 13, bubbles: true }));
    };

    if (btn) {
      await waitForEnabled(btn, 3000);
      btn.click();
      console.log('[ORBIT Bridge] send button clicked');
    } else {
      console.log('[ORBIT Bridge] no button found, trying Enter key');
      pressEnter();
    }

    await sleep(800);
    if (input.value.trim() !== '') {
      console.log('[ORBIT Bridge] input still has text after click \u2014 retrying with Enter key');
      pressEnter();
      await sleep(600);
    }

    return captureResponse(panel, query, input, bubbleCountBeforeSend);
  }

  function getChatPanel(inputEl) {
    let node = inputEl?.parentElement;
    for (let i = 0; node && i < 15; i++, node = node.parentElement) {
      if (node.textContent.toLowerCase().includes('amazon business assistant')) return node;
    }
    return inputEl?.closest('main') || document.body;
  }

  function isChatPanelOpen(inputEl) {
    if (isVisible(inputEl)) return true;
    const closeBtn = document.querySelector('button[aria-label*="close" i], button[aria-label*="minimize" i], button[title*="close" i]');
    if (closeBtn && isVisible(closeBtn, true)) return true;
    const headers = document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,p,div');
    for (const h of headers) {
      if (h.childElementCount === 0 && /amazon business assistant/i.test(h.textContent) && isVisible(h)) return true;
    }
    return false;
  }

  async function ensureChatOpen(inputEl) {
    if (isChatPanelOpen(inputEl)) return true;

    const launcherSels = [
      'button[aria-label*="business assistant" i]',
      'button[aria-label*="chat" i]',
      'button[aria-label*="open chat" i]',
      'button[aria-label*="assistant" i]',
      '[data-testid*="chat-launcher"]',
      '[data-testid*="launcher"]',
      '[data-testid*="chat-toggle"]',
      '[class*="launcher"]',
      '[class*="chat-button"]',
    ];

    for (const sel of launcherSels) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn, true)) {
        console.log('[ORBIT Bridge] Clicking chat launcher:', sel, btn.outerHTML.slice(0, 120));
        btn.click();
        for (let i = 0; i < 30; i++) {
          await sleep(200);
          if (isChatPanelOpen(inputEl)) return true;
        }
        break;
      }
    }

    const brBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => {
        if (!isVisible(b, true)) return false;
        const r = b.getBoundingClientRect();
        return r.bottom > window.innerHeight * 0.55
            && r.right  > window.innerWidth  * 0.55
            && r.width  < 90 && r.height < 90;
      });
    for (const b of brBtns) {
      console.log('[ORBIT Bridge] Trying bottom-right launcher:', b.outerHTML.slice(0, 140));
      b.click();
      for (let j = 0; j < 30; j++) {
        await sleep(200);
        if (isChatPanelOpen(inputEl)) return true;
      }
    }

    const visibleBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => isVisible(b, true))
      .map((b, i) => {
        const r = b.getBoundingClientRect();
        return '[' + i + '] aria="' + (b.getAttribute('aria-label')||'') +
               '" testid="' + (b.getAttribute('data-testid')||'') +
               '" text="' + b.textContent.trim().slice(0,30) +
               '" pos=' + Math.round(r.right) + 'x' + Math.round(r.bottom);
      });
    console.warn('[ORBIT Bridge] Could not open chat panel. Buttons:\n' + visibleBtns.join('\n'));

    return isChatPanelOpen(inputEl);
  }

  function findSendButton(inputEl) {
    const panel = getChatPanel(inputEl);

    for (const sel of SEL.BA_SEND) {
      if (sel.startsWith('svg') || sel.includes('.ink_')) {
        for (const el of panel.querySelectorAll(sel)) {
          const btn = el.closest('button') || el.closest('[role="button"]');
          if (btn && isVisible(btn, true)) return btn;
        }
      } else {
        for (const btn of panel.querySelectorAll(sel)) {
          if (isVisible(btn, true)) return btn;
        }
      }
    }

    const ir2 = inputEl.getBoundingClientRect();
    let container = inputEl.parentElement;
    for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
      const rowBtns = Array.from(container.querySelectorAll('button, [role="button"]'))
        .filter(b => {
          if (!isVisible(b, true) || b.contains(inputEl)) return false;
          const r = b.getBoundingClientRect();
          const vD = Math.abs((r.top + r.height / 2) - (ir2.top + ir2.height / 2));
          return vD <= ir2.height * 1.5 && r.left >= ir2.left;
        });
      if (rowBtns.length > 0) {
        const rightOfInput = rowBtns.filter(b => b.getBoundingClientRect().left >= ir2.right - 4);
        const chosen = rightOfInput.length > 0
          ? rightOfInput.reduce((a, b) => a.getBoundingClientRect().left < b.getBoundingClientRect().left ? a : b)
          : rowBtns[rowBtns.length - 1];
        console.log('[ORBIT Bridge] send button via DOM-proximity row (depth ' + depth + '):', chosen.outerHTML.slice(0, 100));
        return chosen;
      }
    }
    return null;
  }

  function waitForEnabled(btn, timeout = 3000) {
    return new Promise(resolve => {
      if (!btn.disabled) return resolve();
      const deadline = Date.now() + timeout;
      const iv = setInterval(() => {
        if (!btn.disabled || Date.now() >= deadline) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }

  // Waits until BC finishes typewriting the last response (DOM text stable for 1s).
  // captureResponse resolves at the first XHR chunk — before typewriting — so we must
  // wait here before sending the next query in context mode, otherwise BC silently
  // drops the send (it won't accept input while animating a response).
  async function waitForBCIdle(timeout = 25000) {
    const start = Date.now();
    let lastText = '';
    let stableFor = 0;
    while (Date.now() - start < timeout) {
      const bubs = document.querySelectorAll(SEL.ASSISTANT_MSG);
      const lb = bubs[bubs.length - 1];
      const text = lb ? (lb.innerText || lb.textContent || '').trim() : '';
      if (text !== lastText) { lastText = text; stableFor = 0; }
      else stableFor += 150;
      if (stableFor >= 1000 && text.length > 20) return; // stable 1s with real content
      await sleep(150);
    }
  }

  function captureResponse(panel, query, inputEl, bubbleCountBefore) {
    if (bubbleCountBefore === undefined) {
      bubbleCountBefore = document.querySelectorAll(SEL.ASSISTANT_MSG).length;
    }
    const queryStartTime = Date.now();
    return new Promise((resolve, reject) => {
      const before = panelBefore;
      const preExistingDetails = new Set();
      document.querySelectorAll(SEL.ASSISTANT_MSG).forEach(b => {
        const c = getBubbleContainer(b);
        if (c && c.querySelector('details')) preExistingDetails.add(c);
      });
      const _snapBubs = document.querySelectorAll(SEL.ASSISTANT_MSG);
      const _lastBubEl = _snapBubs.length ? _snapBubs[_snapBubs.length - 1] : null;
      const _lastBubClone = _lastBubEl ? _lastBubEl.cloneNode(true) : null;
      if (_lastBubClone) _lastBubClone.querySelectorAll('.top-divider, details').forEach(n => n.remove());
      const lastBubSnapshot = _lastBubClone ? stripNoise(_lastBubClone.innerText || '') : '';

      const getNewBubbleText = () => {
        const bubs = document.querySelectorAll(SEL.ASSISTANT_MSG);
        if (!bubs.length) return '';
        if (bubs.length > bubbleCountBefore) {
          let _gbt = '';
          for (let _gi = bubbleCountBefore; _gi < bubs.length; _gi++) {
            const _gc = bubs[_gi].cloneNode(true);
            _gc.querySelectorAll('.top-divider, details').forEach(n => n.remove());
            const _gt = stripNoise(_gc.innerText || _gc.textContent || '');
            if (_gt.length > _gbt.length) _gbt = _gt;
          }
          return _gbt;
        }
        const lb = bubs[bubs.length - 1];
        const clone = lb.cloneNode(true);
        clone.querySelectorAll('.top-divider, details').forEach(n => n.remove());
        const text = stripNoise(clone.innerText || clone.textContent || '');
        return text !== lastBubSnapshot ? text : '';
      };
      const _chatRootFB = document.querySelector('.chat-container') || panel;
      const feedbackCountBefore = _chatRootFB
        ? (_chatRootFB.innerText.match(/was this helpful\?/gi) || []).length
        : (before.match(/was this helpful\?/gi) || []).length;

      let lastBubbleText = '';
      let stableAt       = Date.now();
      let helpfulSeen    = false;
      let done           = false;
      let mo             = null;
      let moSend         = null;
      let _wkr           = null;

      const doFinish = (reason, _forced) => {
        if (done) return;
        done = true;
        if (_wkr) { try { _wkr.postMessage('stop'); _wkr.terminate(); } catch(_){} }
        clearInterval(iv);
        clearTimeout(hardStop);
        if (mo) { mo.disconnect(); mo = null; }
        if (moSend) { moSend.disconnect(); moSend = null; }
        _xhrCaptureCallback = null;
        if (sendEnableTimer) { clearTimeout(sendEnableTimer); sendEnableTimer = null; }
        panelBefore = panel?.innerText ?? '';
        const result = _forced || getNewBubbleText() || diffResponse('', before, query);
        console.log('[ORBIT Bridge] resolved (' + reason + ') ' + result.length + ' chars: ' + result.slice(0, 120).replace(/\n/g, ' '));
        resolve(result);
      };

      const doError = (msg) => {
        if (done) return;
        done = true;
        if (_wkr) { try { _wkr.postMessage('stop'); _wkr.terminate(); } catch(_){} }
        clearInterval(iv);
        clearTimeout(hardStop);
        if (mo)     { mo.disconnect();     mo = null; }
        if (moSend) { moSend.disconnect(); moSend = null; }
        _xhrCaptureCallback = null;
        if (sendEnableTimer) { clearTimeout(sendEnableTimer); sendEnableTimer = null; }
        console.error('[ORBIT Bridge] bot error detected:', msg);
        reject(new Error(msg));
      };

      const hardStop = setTimeout(() => doFinish('hard-timeout'), MAX_WAIT);

      // Direct XHR callback — set here so the module-level XHR hook can call doFinish
      // the moment BC's streaming XHR first returns data (readyState 3 = before typewriting).
      _xhrCaptureCallback = (text, time) => {
        if (done) return;
        if (time <= queryStartTime) return;
        const _xt = stripNoise(text || '');
        if (_xt.length > 30) {
          console.log('[ORBIT Bridge] XHR callback: ' + _xt.length + 'ch — resolving (xhr-cb)');
          doFinish('xhr-cb', _xt);
        }
      };

      const moRoot = panel || document.body;
      mo = new MutationObserver(() => {
        if (done) return;
        const _errEl = document.querySelector('div.error-message');
        if (_errEl && _errEl.offsetParent !== null && /something went wrong/i.test(_errEl.textContent)) { doError('Sorry, something went wrong on the ABC page. Please refresh and try again.'); return; }
        const bubs = document.querySelectorAll(SEL.ASSISTANT_MSG);
        const hasNewContent = getNewBubbleText().length > 10;
        if (bubs.length <= bubbleCountBefore && !hasNewContent) return;
        const lc = getBubbleContainer(bubs[bubs.length - 1]);
        if (lc && lc.querySelector('details') && !preExistingDetails.has(lc)) {
          console.log('[ORBIT Bridge] MO: new <details> appeared \u2014 resolved (sources-mo)');
          doFinish('sources-mo');
          return;
        }
        const chatRoot = document.querySelector('.chat-container') || panel;
        if (chatRoot) {
          const ct = (chatRoot.innerText.match(/was this helpful\?/gi) || []).length;
          if (ct > feedbackCountBefore) {
            console.log('[ORBIT Bridge] MO: "Was this helpful?" appeared \u2014 resolved (helpful-mo)');
            doFinish('helpful-mo');
          }
        }
      });
      mo.observe(moRoot, { childList: true, subtree: true });

      const sendBtnRef = findSendButton(inputEl);
      let sendEnableTimer = null;
      if (sendBtnRef) {
        console.log('[ORBIT Bridge] watching send btn:', sendBtnRef.id || sendBtnRef.outerHTML.slice(0, 80));
        const checkSendEnabled = () => {
          if (done) return;
          const bubbles = document.querySelectorAll(SEL.ASSISTANT_MSG);
          const hasNewContent2 = getNewBubbleText().length > 10;
          if (bubbles.length <= bubbleCountBefore && !hasNewContent2) return;
          const btn2 = findSendButton(inputEl) || sendBtnRef;
          const isEnabled = !btn2.disabled && btn2.getAttribute('data-disabled') !== 'true';
          if (isEnabled && !sendEnableTimer) {
            sendEnableTimer = setTimeout(() => {
              sendEnableTimer = null;
              if (done) return;
              const stillEnabled = !btn2.disabled && btn2.getAttribute('data-disabled') !== 'true';
              const currentText = getNewBubbleText();
              if (stillEnabled && currentText.length > 30) {
                console.log('[ORBIT Bridge] send btn stable-enabled \u2014 resolved (send-enabled)');
                doFinish('send-enabled');
              } else if (stillEnabled) {
                console.log('[ORBIT Bridge] send btn enabled but response too short (' + currentText.length + ' chars) \u2014 waiting');
              }
            }, 600);
          } else if (!isEnabled && sendEnableTimer) {
            clearTimeout(sendEnableTimer);
            sendEnableTimer = null;
            console.log('[ORBIT Bridge] send btn briefly enabled \u2014 false positive, continuing');
          }
        };
        moSend = new MutationObserver(checkSendEnabled);
        moSend.observe(sendBtnRef, { attributes: true });
        if (sendBtnRef.parentElement) {
          moSend.observe(sendBtnRef.parentElement, { childList: true, subtree: false });
        }
      }

      /* Web Worker keeps poll at 100ms even when BC tab is in background.
         Falls back to plain setInterval if Worker/Blob URL is blocked by CSP. */
      let iv = null;
      try {
        const _wBlob = new Blob(
          ['var _t=null;onmessage=function(e){if(e.data==="start"){_t=setInterval(function(){postMessage(1);},100);}else{clearInterval(_t);}};'],
          { type: 'application/javascript' }
        );
        const _wUrl = URL.createObjectURL(_wBlob);
        _wkr = new Worker(_wUrl);
        URL.revokeObjectURL(_wUrl);
        _wkr.onmessage = _pollFn;
        _wkr.postMessage('start');
      } catch(_wErr) {
        console.log('[ORBIT Bridge] Worker unavailable, using setInterval fallback');
        iv = setInterval(_pollFn, 100);
      }
      function _pollFn() {
        // XHR-direct: fastest path — response body captured by XHR hook
        if (window.__bcXHR && window.__bcXHR.time > queryStartTime) {
          const _xt = stripNoise(window.__bcXHR.text || '');
          if (_xt.length > 30) {
            console.log('[ORBIT Bridge] XHR direct: ' + _xt.length + 'ch — resolving instantly (xhr-direct)');
            doFinish('xhr-direct', _xt);
            return;
          }
        }

        const bubbleCount = document.querySelectorAll(SEL.ASSISTANT_MSG).length;
        const onNewBubble = bubbleCount > bubbleCountBefore;

        const bubbleText = getNewBubbleText();
        if (bubbleText !== lastBubbleText) {
          lastBubbleText = bubbleText;
          stableAt       = Date.now();
        }
        const silenceMs = Date.now() - stableAt;

        const _ivErrEl = document.querySelector('div.error-message');
        if (_ivErrEl && _ivErrEl.offsetParent !== null && /something went wrong/i.test(_ivErrEl.textContent)) { doError('Sorry, something went wrong on the ABC page. Please refresh and try again.'); return; }

        if (!onNewBubble && bubbleText.length <= 10) return;

        // SSE only carries telemetry status strings, never response text.
        // Use stream-closed + 500ms DOM-stable as a fallback signal only.
        if (window.__bcSSE?.done > queryStartTime && silenceMs >= 500) {
          console.log('[ORBIT Bridge] SSE stream closed + DOM stable 500ms \u2014 fallback (sse-done)');
          doFinish('sse-done');
          return;
        }

        const bubbles2  = document.querySelectorAll(SEL.ASSISTANT_MSG);
        const lastBub   = bubbles2[bubbles2.length - 1];
        const lastCont  = getBubbleContainer(lastBub);
        const hasDetails = lastCont && lastCont.querySelector('details') && !preExistingDetails.has(lastCont);
        if (hasDetails) {
          console.log('[ORBIT Bridge] poll: new <details> in DOM \u2014 resolved (sources-appeared)');
          doFinish('sources-appeared');
          return;
        }

        if (silenceMs >= 10000 && Math.floor(silenceMs / 10000) !== Math.floor((silenceMs - 100) / 10000)) {
          const sseDone = window.__bcSSE?.done;
          console.log('[ORBIT Bridge] poll@' + Math.round(silenceMs/1000) + 's \u2014 bubble:' + bubbleText.length + 'ch sse:' + (sseDone ? 'DONE' : 'none') + ' details:' + !!hasDetails + ' helpful:' + helpfulSeen);
        }

        if (!helpfulSeen) {
          const bodyText = document.body?.innerText ?? '';
          if ((bodyText.match(/was this helpful\?/gi) || []).length > feedbackCountBefore) {
            helpfulSeen = true;
            console.log('[ORBIT Bridge] poll: "Was this helpful?" seen \u2014 resolving');
          }
        }
        if (helpfulSeen) {
          console.log('[ORBIT Bridge] helpful seen \u2014 resolving immediately (helpful-done)');
          doFinish('helpful+stable');
          return;
        }

        if (silenceMs >= 2500 && lastBubbleText.length > 10) {
          console.log('[ORBIT Bridge] 2.5s stable \u2014 resolving (fallback-B)');
          doFinish('2.5s-stable');
        }
      }
    });
  }

  function stripNoise(text) {
    text = text.replace(/\n[ \t]*>?[ \t]*sources[ \t]*(\n|$)[\s\S]*/i, '');
    text = text.replace(/\s*Was this helpful\?[\s\S]*/i, '');
    text = text.replace(/\s*Thumbs (?:Up|Down) Button[\s\S]*/i, '');
    text = text.replace(/\s*\d+\/\d+\s*$/m, '');
    text = text.replace(/\s*Send\s*$/m, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  function diffResponse(after, before, query) {
    if (SEL.ASSISTANT_MSG) {
      const els = document.querySelectorAll(SEL.ASSISTANT_MSG);
      if (els.length) {
        const bubble = els[els.length - 1];
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll('.top-divider, details').forEach(n => n.remove());
        const raw = clone.innerText || clone.textContent || '';
        const text = stripNoise(raw);
        if (text) return text;
        return stripNoise(bubble.innerText);
      }
    }
    if (!after) return '';

    if (before && after.length > before.length && after.startsWith(before)) {
      let part = after.slice(before.length).trim();
      const qn = query.toLowerCase().trim();
      if (part.toLowerCase().startsWith(qn)) {
        part = part.slice(qn.length).trim();
      } else {
        const pl = part.split('\n');
        const qi = pl.findIndex(l => l.toLowerCase().includes(qn));
        if (qi !== -1 && qi < 5) part = pl.slice(qi + 1).join('\n').trim();
      }
      if (part) return stripNoise(part);
    }

    const qLow = query.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineEchoRe = new RegExp('(?:^|\\n)' + qLow + '\\n', 'i');
    const echoMatch = (before + after).match(lineEchoRe);
    if (echoMatch) {
      const echoEnd = after.toLowerCase().lastIndexOf(query.toLowerCase().trim() + '\n');
      if (echoEnd !== -1) {
        const candidate = after.slice(echoEnd + query.length).trim();
        if (candidate) return stripNoise(candidate);
      }
    }

    if (before) {
      let lcp = 0;
      const minLen = Math.min(before.length, after.length);
      while (lcp < minLen && before[lcp] === after[lcp]) lcp++;
      const tail = after.slice(lcp).trim();
      if (tail && tail.length > 10) return stripNoise(tail);
    }

    return stripNoise(after);
  }

})();

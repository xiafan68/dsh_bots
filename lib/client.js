window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-bots",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var Fragment = react.Fragment;
    // 必须用 createElement：jsx(type, props, key) 会丢掉第三个及之后的孩子。
    var h = react.createElement;

    var API = "/dsh-bots/api";
    var pluginCtx = null;
    var botsById = {};
    var bindingsBySession = {};
    var bindingListeners = [];

    function publishDirectory(data) {
      var next = {};
      (data.bots || []).forEach(function (bot) { next[bot.id] = bot; });
      botsById = next;
      var map = {};
      (data.bindings || []).forEach(function (binding) {
        if (binding && binding.sessionId) map[binding.sessionId] = binding;
      });
      bindingsBySession = map;
      bindingListeners.slice().forEach(function (fn) {
        try { fn(); } catch (e) { /* ignore */ }
      });
    }

    function subscribeBindings(fn) {
      bindingListeners.push(fn);
      return function () {
        var index = bindingListeners.indexOf(fn);
        if (index >= 0) bindingListeners.splice(index, 1);
      };
    }
    var NS = "dsh-bots";
    var EMOJIS = ["🤖", "🧭", "✨", "🛠️", "📚", "🧪", "🧠", "🎨", "📊", "🔍", "💬", "🗂️"];

    var LANES = [
      { id: "you", title: "等你", statuses: ["in_review", "blocked"], hint: "待验收 / 受阻" },
      { id: "doing", title: "处理中", statuses: ["in_progress"], hint: "agent 正在干" },
      { id: "todo", title: "等待认领", statuses: ["todo"], hint: "可以派了" },
      { id: "done", title: "已完成", statuses: ["done", "canceled"], collapsed: true },
      { id: "backlog", title: "待立项", statuses: ["backlog"], collapsed: true },
    ];

    var STATUS_LABEL = {
      backlog: "待立项",
      todo: "等待认领",
      in_progress: "处理中",
      in_review: "待验收",
      done: "已完成",
      blocked: "受阻",
      canceled: "已取消",
    };

    var PRIORITY_LABEL = { low: "低", normal: "普通", high: "高", urgent: "紧急" };

    function api(path, options) {
      var opts = options || {};
      var headers = { accept: "application/json" };
      // GET 不带 body 时不要发 content-type：本地网关会把它当成写请求处理。
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      return fetch(API + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }).then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!res.ok) throw new Error(data && data.error ? data.error : "HTTP " + res.status);
            return data;
          });
      });
    }

    function ensureStyle() {
      if (document.getElementById("dsh-bots-style")) return;
      var style = document.createElement("style");
      style.id = "dsh-bots-style";
      style.textContent = [
        ".dxb{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-text-primary,#111)}",
        ".dxb-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:9px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e5e7eb)}",
        ".dxb-head .dxb-btn{padding:3px 9px;font-size:11.5px;white-space:nowrap}",
        ".dxb-title{font-weight:600;font-size:14px;margin-right:auto;display:flex;align-items:center;gap:6px}",
        ".dxb-tabs{display:flex;gap:2px;background:var(--dsw-alias-bg-subtle,#f3f4f6);border-radius:8px;padding:2px}",
        ".dxb-tab{border:0;background:transparent;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-tab.on{background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,#111);box-shadow:0 1px 2px rgba(0,0,0,.08)}",
        ".dxb-btn{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fff);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px;color:inherit}",
        ".dxb-btn.danger{color:#c0392b;border-color:color-mix(in srgb,#c0392b 30%,transparent)}",
        ".dxb-btn.danger:hover{background:color-mix(in srgb,#c0392b 8%,transparent)}",
        ".dxb-btn:hover{background:var(--dsw-alias-bg-hover,#f3f4f6)}",
        ".dxb-btn.primary{background:var(--dsw-alias-accent,#2563eb);border-color:transparent;color:#fff}",
        ".dxb-btn.ghost{border-color:transparent;background:transparent}",
        ".dxb-btn:disabled{opacity:.5;cursor:default}",
        ".dxb-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 16px}",
        ".dxb-card{background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:8px;padding:8px;cursor:pointer;display:flex;flex-direction:column;gap:5px;min-width:0}",
        ".dxb-card.dim{opacity:.72}",
        ".dxb-card-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-text-tertiary,#9ca3af)}",
        ".dxb-avatar{width:18px;height:18px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;background:var(--dsw-alias-bg-subtle,#f3f4f6)}",
        ".dxb-avatar.lg{width:34px;height:34px;font-size:18px;border-radius:10px}",
        ".dxb-prio{width:6px;height:6px;border-radius:50%;display:inline-block}",
        ".dxb-prio.high{background:#f59e0b}.dxb-prio.urgent{background:#ef4444}.dxb-prio.normal{background:#9ca3af}.dxb-prio.low{background:#cbd5e1}",
        ".dxb-chip{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-subtle,#f3f4f6);color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-chip.wait{background:color-mix(in srgb,var(--dsw-alias-warning,#f59e0b) 14%,transparent);color:var(--dsw-alias-warning,#b45309)}",
        ".dxb-chip.id{font-family:ui-monospace,monospace}",
        ".dxb-empty{font-size:12px;color:var(--dsw-alias-text-tertiary,#9ca3af);padding:14px 4px;text-align:center}",
        ".dxb-bots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}",
        ".dxb-bot{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fff);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}",
        ".dxb-bot-top{display:flex;gap:8px;align-items:center}",
        ".dxb-bot-name{font-weight:600;font-size:13px}",
        ".dxb-bot-sub{font-size:11px;color:var(--dsw-alias-text-tertiary,#9ca3af)}",
        ".dxb-bot-actions{display:flex;gap:6px;flex-wrap:wrap}",
        ".dxb-mask{position:fixed;inset:0;background:rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;z-index:80;padding:24px}",
        ".dxb-dialog{background:var(--dsw-alias-bg-elevated,#fff);border-radius:12px;width:min(620px,100%);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.22)}",
        ".dxb-dialog-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e5e7eb);font-weight:600}",
        ".dxb-dialog-body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}",
        ".dxb-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-subtle,#e5e7eb)}",
        ".dxb-field{display:flex;flex-direction:column;gap:4px}",
        ".dxb-field label{font-size:11px;color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-input,.dxb-textarea,.dxb-select{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fff);border-radius:7px;padding:6px 8px;font-size:12.5px;color:inherit;font-family:inherit;width:100%;box-sizing:border-box}",
        ".dxb-textarea{min-height:110px;resize:vertical;line-height:1.5}",
        ".dxb-row{display:flex;gap:10px}.dxb-row>*{flex:1}",
        ".dxb-icons{display:flex;gap:6px;flex-wrap:wrap}",
        ".dxb-icon{border:1px solid transparent;background:var(--dsw-alias-bg-subtle,#f3f4f6);border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer}",
        ".dxb-icon.on{border-color:var(--dsw-alias-accent,#2563eb);background:var(--dsw-alias-bg-elevated,#fff)}",
        ".dxb-comments{display:flex;flex-direction:column;gap:6px;max-height:170px;overflow:auto;border-top:1px dashed var(--dsw-alias-border-subtle,#e5e7eb);padding-top:8px}",
        ".dxb-comment{font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-subtle,#f7f7f8);border-radius:7px;padding:6px 8px;white-space:pre-wrap}",
        ".dxb-comment b{font-weight:600;margin-right:4px}",
        ".dxb-err{color:#ef4444;font-size:12px;padding:4px 12px}",
        ".dxb-check{display:flex;align-items:center;gap:6px;font-size:12px}",
        // --- 覆盖：更紧凑的头部、自适应 5 列泳道、卡片与 Toast ---
        ".dxb{background:var(--dsw-alias-bg-root,transparent);-webkit-font-smoothing:antialiased}",
        ".dxb *{box-sizing:border-box}",
        ".dxb-head{min-height:46px;height:auto;padding:4px 12px;gap:8px;row-gap:6px;flex-wrap:wrap;background:var(--dsw-alias-bg-root,transparent)}",
        ".dxb-title{font-size:13px;font-weight:600;letter-spacing:.01em}",
        ".dxb-title .dxb-glyph{opacity:.75}",
        ".dxb-tabs{background:var(--dsw-alias-bg-subtle,#f3f4f6);border-radius:9px;padding:2px;gap:0}",
        ".dxb-tab{padding:4px 12px;border-radius:7px;font-size:12px;transition:background .12s}",
        ".dxb-tab:not(.on):hover{color:var(--dsw-alias-text-primary,#111)}",
        ".dxb-btn{height:26px;padding:0 10px;border-radius:7px;font-size:12px;line-height:1;transition:background .12s,border-color .12s,color .12s}",
        ".dxb-btn.primary{background:var(--dsw-alias-accent,#2563eb);box-shadow:0 1px 2px rgba(37,99,235,.25)}",
        ".dxb-btn.primary:hover{filter:brightness(1.05)}",
        ".dxb-btn.ghost:hover{background:var(--dsw-alias-bg-subtle,#f3f4f6)}",
        ".dxb-btn.danger{color:#dc2626}",
        ".dxb-body{padding:12px 12px 18px}",
        ".dxb-lanes{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:start}",
        // Fixed-track fallback for narrow viewports: mixing `1fr` with an
        // overflow container can oscillate (layout <-> scrollbar) and pin the
        // renderer at 100% CPU, so the two are kept mutually exclusive.
        "@media (max-width: 980px){.dxb-lanes{grid-template-columns:repeat(5,196px);overflow-x:auto;overflow-y:visible;padding-bottom:6px}}",
        "@media (max-width: 720px){.dxb-lanes{grid-template-columns:repeat(2,minmax(0,1fr));overflow-x:visible}}",
        ".dxb-lane{border:1px solid var(--dsw-alias-border-subtle,#e8eaed);border-radius:10px;padding:8px;gap:7px;min-height:96px;min-width:0;width:auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-subtle,#f7f7f8);transition:border-color .12s}",
        ".dxb-lane:hover{border-color:var(--dsw-alias-border,#d9dce1)}",
        ".dxb-lane.you{background:color-mix(in srgb,var(--dsw-alias-warning,#f59e0b) 7%,var(--dsw-alias-bg-subtle,#f7f7f8));border-color:color-mix(in srgb,var(--dsw-alias-warning,#f59e0b) 26%,transparent)}",
        ".dxb-lane.done,.dxb-lane.backlog{opacity:.92}",
        ".dxb-lane-head{font-size:12px;font-weight:600;height:20px;color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-count{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-subtle,#e8eaed);font-size:11px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-text-tertiary,#6b7280)}",
        ".dxb-lane-hint{margin-top:-3px;font-size:11px}",
        ".dxb-card{padding:9px 10px;gap:6px;border-radius:9px;box-shadow:0 1px 1px rgba(16,24,40,.03);transition:transform .12s,box-shadow .12s,border-color .12s}",
        ".dxb-card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(16,24,40,.1);border-color:var(--dsw-alias-border,#c9cdd4)}",
        ".dxb-card:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:1px}",
        ".dxb-card-title{font-size:12.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}",
        ".dxb-card-meta{gap:5px;font-size:11px}",
        ".dxb-chip{padding:1px 6px;line-height:16px;font-weight:500}",
        ".dxb-chip.id{color:var(--dsw-alias-text-tertiary,#6b7280);background:transparent;border:1px solid var(--dsw-alias-border-subtle,#e8eaed)}",
        ".dxb-prio{width:6px;height:6px;margin-left:auto}",
        ".dxb-avatar{width:20px;height:20px;border-radius:6px;color:var(--dsw-alias-text-secondary,#4b5563);border:1px solid var(--dsw-alias-border-subtle,#e8eaed);background:var(--dsw-alias-bg-elevated,#fff)}",
        ".dxb-avatar.lg{width:36px;height:36px;border-radius:10px}",
        ".dxb-glyph{display:block}",
        ".dxb-glyph-emoji{line-height:1}",
        ".dxb-empty{font-size:12px;color:var(--dsw-alias-text-tertiary,#9ca3af);padding:18px 6px;text-align:center;border:1px dashed var(--dsw-alias-border-subtle,#e8eaed);border-radius:8px;background:transparent}",
        ".dxb-bots{grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}",
        ".dxb-bot{padding:12px;gap:10px;border-radius:11px;min-height:124px;justify-content:space-between;transition:box-shadow .12s,border-color .12s,transform .12s}",
        ".dxb-bot:hover{box-shadow:0 4px 14px rgba(16,24,40,.08);border-color:var(--dsw-alias-border,#d9dce1);transform:translateY(-1px)}",
        ".dxb-bot-name{font-size:13px;display:flex;align-items:center;gap:6px}",
        ".dxb-bot-sub{font-size:11px;color:var(--dsw-alias-text-tertiary,#6b7280);line-height:1.5}",
        ".dxb-skill{font-size:10.5px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-subtle,#f3f4f6);color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-bot-actions{gap:6px}",
        ".dxb-mask{backdrop-filter:blur(1.5px);background:rgba(15,23,42,.32)}",
        ".dxb-dialog{border-radius:13px;width:min(640px,100%);box-shadow:0 24px 60px rgba(15,23,42,.28)}",
        ".dxb-dialog-head{padding:13px 16px;font-size:13px}",
        ".dxb-dialog-body{padding:14px 16px;gap:12px}",
        ".dxb-dialog-foot{padding:11px 16px;gap:8px}",
        ".dxb-field label{font-size:11px;font-weight:500;color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-input,.dxb-textarea,.dxb-select{padding:7px 9px;border-radius:8px;font-size:12.5px;transition:border-color .12s,box-shadow .12s}",
        ".dxb-input:focus,.dxb-textarea:focus,.dxb-select:focus{outline:none;border-color:var(--dsw-alias-accent,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 16%,transparent)}",
        ".dxb-icons{gap:7px}",
        ".dxb-icon{width:34px;height:34px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-text-secondary,#4b5563)}",
        ".dxb-icon.on{color:var(--dsw-alias-accent,#2563eb);border-color:var(--dsw-alias-accent,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 14%,transparent)}",
        ".dxb-icon:hover{border-color:var(--dsw-alias-border,#c9cdd4)}",
        ".dxb-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#111827;color:#fff;font-size:12px;padding:8px 14px;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:120;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dxb-toast.err{background:#b91c1c}",
        ".dxb-row-badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:6px;color:var(--dsw-alias-text-secondary,#6b7280);background:var(--dsw-alias-bg-subtle,#f2f3f5);flex:none}",
        ".dxb-row-badge.crown{color:var(--dsw-alias-accent,#2563eb);background:color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 12%,transparent)}",
        ".dxb-row-badge svg{display:block}",
        ".dxb-chip.ws{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:10px}",
        ".dxb-session{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#e8eaed);border-radius:10px;background:var(--dsw-alias-bg-subtle,#f7f8f9)}",
        ".dxb-session-main{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".dxb-session-label{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-text-tertiary,#8b9099)}",
        ".dxb-session-id{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-text-secondary,#5b6270);background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-subtle,#e8eaed);border-radius:6px;padding:1px 6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dxb-session-warn{font-size:11px;color:#b45309}",
        ".dxb-muted{font-size:11px;color:var(--dsw-alias-text-tertiary,#9aa0a8)}",
        ".dxb-side{display:flex;flex-direction:column;gap:10px;padding:12px 12px 16px;height:100%;min-height:0;overflow:auto}",
        ".dxb-side-head{display:flex;align-items:center;gap:8px;padding-bottom:2px}",
        ".dxb-side-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-text-tertiary,#8b9099)}",
        ".dxb-side-title .dxb-glyph{opacity:.7}",
        ".dxb-side-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--dsw-alias-text-secondary,#6b7280);background:var(--dsw-alias-bg-subtle,#f2f3f5)}",
        ".dxb-icon-btn{margin-left:auto;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-text-tertiary,#8b9099);cursor:pointer;font-size:13px;line-height:1}",
        ".dxb-icon-btn:hover{background:var(--dsw-alias-bg-subtle,#f2f3f5);color:var(--dsw-alias-text-primary,#1f2328)}",
        ".dxb-side-filter{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border-subtle,#e8eaed);border-radius:8px;background:var(--dsw-alias-bg-subtle,#f7f8f9);font-size:12px;color:var(--dsw-alias-text-primary,#1f2328);outline:none}",
        ".dxb-side-filter:focus{border-color:var(--dsw-alias-accent,#2563eb);background:var(--dsw-alias-bg-elevated,#fff)}",
        ".dxb-side-list{display:flex;flex-direction:column;gap:4px;min-height:0}",
        ".dxb-side-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:8px 8px;border:1px solid transparent;border-radius:10px;background:transparent;text-align:left;cursor:pointer;min-width:0;transition:background .12s ease,border-color .12s ease}",
        ".dxb-side-row:hover{background:var(--dsw-alias-bg-subtle,#f4f5f7);border-color:var(--dsw-alias-border-subtle,#e8eaed)}",
        ".dxb-side-row:active{background:var(--dsw-alias-bg-subtle,#eef0f3)}",
        ".dxb-side-row:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:1px}",
        ".dxb-side-row.busy{opacity:.6}",
        ".dxb-side-avatar{flex:none;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;color:var(--dsw-alias-text-secondary,#5b6270);background:var(--dsw-alias-bg-subtle,#eff1f4)}",
        ".dxb-side-row.crown .dxb-side-avatar{color:var(--dsw-alias-accent,#2563eb);background:color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 11%,transparent)}",
        ".dxb-side-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
        ".dxb-side-name{font-size:13px;font-weight:600;color:var(--dsw-alias-text-primary,#1f2328);display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dxb-side-pill{flex:none;font-size:10px;font-weight:600;line-height:16px;padding:0 6px;border-radius:999px;color:var(--dsw-alias-accent,#2563eb);background:color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 11%,transparent)}",
        ".dxb-side-sub{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-text-tertiary,#9aa0a8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dxb-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-border,#d5d9de);flex:none}",
        ".dxb-dot.on{background:#22c55e}",
        ".dxb-side-sep{opacity:.55}",
        ".dxb-side-go{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-text-tertiary,#9aa0a8);opacity:0;transition:opacity .12s ease,color .12s ease}",
        ".dxb-side-row:hover .dxb-side-go{opacity:1;color:var(--dsw-alias-accent,#2563eb)}",
        ".dxb-side-row:hover .dxb-side-go{opacity:1;color:var(--dsw-alias-accent,#2563eb)}",
        ".dxb-side-foot{font-size:11px;color:var(--dsw-alias-text-tertiary,#b0b5bc);padding:2px 2px 0}",
        ".dxb-side-hint{font-size:11px;color:var(--dsw-alias-text-tertiary,#9aa0a8);margin-top:4px}",
        ".dxb-lane::-webkit-scrollbar,.dxb-body::-webkit-scrollbar{width:8px;height:8px}",
        ".dxb-lane::-webkit-scrollbar-thumb,.dxb-body::-webkit-scrollbar-thumb{background:rgba(120,120,130,.25);border-radius:4px}",
      ].join("\n");
      document.head.appendChild(style);
    }

    // 线性图标集：存 iconId，不依赖 DSH 内部图标表。老数据里的 emoji 仍可显示。
    var GLYPHS = {
      robot: ["r:4,8,16,12,3", "l:12,8,12,4", "dot:9.2,13,1", "dot:14.8,13,1", "l:9,17,15,17"],
      compass: ["c:12,12,9", "p:M15.2 8.8 13.3 13.3 8.8 15.2 10.7 10.7Z"],
      wrench: ["p:M14.7 6.3a3.8 3.8 0 0 0 5 5L10 21a2.1 2.1 0 0 1-3-3l9.7-9.7Z", "l:3,3,5.5,5.5"],
      spark: ["p:M12 3.5 13.8 9.2 19.5 11 13.8 12.8 12 18.5 10.2 12.8 4.5 11 10.2 9.2Z", "l:18.5,17.5,20.5,19.5"],
      book: ["p:M5 4.5h9a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3Z", "l:17,7,20,7", "l:8,8,8,18"],
      flask: ["l:9.5,3,14.5,3", "p:M10.5 3v5.4L6.4 17a2.2 2.2 0 0 0 2 3.2h7.2a2.2 2.2 0 0 0 2-3.2l-4.1-8.6V3", "l:8,15,16,15"],
      brain: ["c:12,12,8.4", "p:M12 4v16", "l:4.6,8.4,8.2,10.4", "l:19.4,8.4,15.8,10.4"],
      palette: ["c:12,12,8.6", "dot:9,9.5,.9", "dot:15,9.5,.9", "dot:8.6,14,.9", "p:M12 20.6a2 2 0 0 1 0-4h2.2a2.4 2.4 0 0 0 2.4-2.4"],
      chart: ["l:4,20,20,20", "r:6.4,12.5,3,7.5,1", "r:11.2,9,3,11,1", "r:16,5.5,3,14.5,1"],
      search: ["c:11,11,6.6", "l:15.8,15.8,20.5,20.5"],
      chat: ["p:M4 6.5a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.4V16H6.5A2.5 2.5 0 0 1 4 13.5Z"],
      folder: ["p:M3.5 7.5a2 2 0 0 1 2-2h4l2 2.4h7a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"],
    };
    var EMOJI_TO_GLYPH = { "🤖": "robot", "🧭": "compass", "🛠️": "wrench", "🛠": "wrench", "✨": "spark", "📚": "book", "🧪": "flask", "🧠": "brain", "🎨": "palette", "📊": "chart", "🔍": "search", "💬": "chat", "🗂️": "folder", "🗂": "folder" };
    var ICON_IDS = ["compass", "wrench", "spark", "book", "flask", "brain", "palette", "chart", "search", "chat", "folder", "robot"];

    function glyphId(icon) {
      if (!icon) return "robot";
      if (GLYPHS[icon]) return icon;
      return EMOJI_TO_GLYPH[icon] || "";
    }

    function glyphNode(spec, key) {
      var parts = spec.split(":");
      var nums = (parts[1] || "").split(",").map(Number);
      if (parts[0] === "c") return h("circle", { key: key, cx: nums[0], cy: nums[1], r: nums[2] });
      if (parts[0] === "dot") return h("circle", { key: key, cx: nums[0], cy: nums[1], r: nums[2], fill: "currentColor", stroke: "none" });
      if (parts[0] === "r") return h("rect", { key: key, x: nums[0], y: nums[1], width: nums[2], height: nums[3], rx: nums[4] || 0 });
      if (parts[0] === "l") return h("line", { key: key, x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] });
      return h("path", { key: key, d: (parts[1] || "").trim() });
    }

    function BotGlyph(props) {
      var id = glyphId(props.icon);
      var size = props.size || 18;
      if (!id) return h("span", { className: "dxb-glyph-emoji", style: { fontSize: Math.round(size * 0.8) } }, props.icon);
      return h(
        "svg",
        { className: "dxb-glyph", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        GLYPHS[id].map(glyphNode),
      );
    }

    function Avatar(props) {
      var size = props.size === "lg" ? " dxb-avatar lg" : " dxb-avatar";
      return h("span", { className: size, title: props.name || "" }, h(BotGlyph, { icon: props.icon, size: props.size === "lg" ? 20 : 13 }));
    }

    function TaskCard(props) {
      var task = props.task;
      var bot = props.bot;
      var onClick = props.onClick;
      var prio = task.priority && task.priority !== "normal" ? PRIORITY_LABEL[task.priority] : "";
      var ws = props.workspace || "";
      return h(
        "div",
        {
          className: "dxb-card" + (task.status === "canceled" || task.status === "done" ? " dim" : ""),
          onClick: onClick,
          role: "button",
          tabIndex: 0,
          onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } },
        },
        h(
          "div",
          { className: "dxb-card-meta" },
          h("span", { className: "dxb-chip id" }, task.id),
          prio ? h("span", { className: "dxb-chip" }, prio) : null,
          ws ? h("span", { className: "dxb-chip ws", title: props.workspaceTitle || ws }, ws) : null,
          h("span", { className: "dxb-prio " + (task.priority || "normal"), title: PRIORITY_LABEL[task.priority] || "" }),
        ),
        h("div", { className: "dxb-card-title" }, task.title),
        h(
          "div",
          { className: "dxb-card-meta" },
          bot ? h(Avatar, { icon: bot.icon, name: bot.name }) : h("span", { className: "dxb-avatar" }, "○"),
          h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, bot ? bot.name : task.assignee ? "我" : "未指派"),
          // Unassigned but agent-required: this one is waiting for a human or the
          // orchestrator to pick an owner, so say that instead of a bare "未指派".
          !task.assignee && task.agentRequired && task.status === "todo" ? h("span", { className: "dxb-chip wait" }, "等待分派") : null,
          task.status !== "todo" && task.status !== "backlog" ? h("span", { className: "dxb-chip", style: { marginLeft: "auto" } }, STATUS_LABEL[task.status] || task.status) : null,
        ),
      );
    }

    function Board(props) {
      var tasks = props.tasks;
      var bots = props.bots;
      var workspaces = props.workspaces || [];
      var onOpen = props.onOpen;
      var collapsed = props.collapsed;
      var toggle = props.toggle;
      var botOf = function (task) {
        if (!task.assignee || task.assignee.kind !== "bot") return null;
        for (var i = 0; i < bots.length; i += 1) if (bots[i].id === task.assignee.id) return bots[i];
        return null;
      };
      var lanes = LANES.map(function (lane) {
        var items = tasks.filter(function (task) {
          return lane.statuses.indexOf(task.status) >= 0;
        });
        var isCollapsed = Boolean(lane.collapsed && collapsed[lane.id]);
        return h(
          "div",
          { className: "dxb-lane " + lane.id, key: lane.id },
          h(
            "div",
            { className: "dxb-lane-head", onClick: lane.collapsed ? function () { toggle(lane.id); } : undefined, style: lane.collapsed ? { cursor: "pointer", userSelect: "none" } : undefined, title: lane.collapsed ? "点击展开 / 收起" : undefined },
            lane.collapsed ? h("span", { style: { width: 10, opacity: 0.7 } }, isCollapsed ? "▸" : "▾") : null,
            h("span", null, lane.title),
            h("span", { className: "dxb-count" }, items.length),
          ),
          isCollapsed ? null : lane.hint ? h("div", { className: "dxb-lane-hint" }, lane.hint) : null,
          isCollapsed
            ? null
            : items.length
              ? items.map(function (task) {
                  return h(TaskCard, {
                    key: task.id,
                    task: task,
                    bot: botOf(task),
                    workspace: workspaceShort(workspaces, task.workspaceId),
                    workspaceTitle: workspaceTitle(workspaces, task.workspaceId),
                    onClick: function () { onOpen(task); },
                  });
                })
              : h("div", { className: "dxb-empty" }, "空"),
        );
      });
      return h("div", { className: "dxb-lanes" }, lanes);
    }

    function BotsGrid(props) {
      var bots = props.bots;
      var tasks = props.tasks;
      var onChat = props.onChat;
      var onEdit = props.onEdit;
      var onDelete = props.onDelete;
      if (!bots.length) {
        return h("div", { className: "dxb-empty" }, h("div", null, "还没有 bot。"), h("div", { style: { marginTop: 6 } }, "点右上角「新建 Bot」，先给你自己配一个主控助理。"));
      }
      return h(
        "div",
        { className: "dxb-bots" },
        bots.map(function (bot) {
          var count = tasks.filter(function (task) {
            return task.assignee && task.assignee.id === bot.id && task.status !== "done" && task.status !== "canceled";
          }).length;
          return h(
            "div",
            { className: "dxb-bot", key: bot.id },
            h(
              "div",
              { className: "dxb-bot-top" },
              h(Avatar, { icon: bot.icon, name: bot.name, size: "lg" }),
              h(
                "div",
                { style: { minWidth: 0, flex: 1 } },
                h("div", { className: "dxb-bot-name" }, bot.name, bot.isOrchestrator ? h("span", { className: "dxb-chip", style: { background: "color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 14%,transparent)", color: "var(--dsw-alias-accent,#2563eb)" } }, "主控") : null),
                h("div", { className: "dxb-bot-sub" }, bot.id + (count ? " · " + count + " 个在办" : " · 空闲") + (bot.sessionId ? " · 已有会话" : "")),
              ),
            ),
            (bot.skills || []).length
              ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } }, bot.skills.slice(0, 5).map(function (skill) { return h("span", { className: "dxb-skill", key: skill }, skill); }), bot.skills.length > 5 ? h("span", { className: "dxb-skill" }, "+" + (bot.skills.length - 5)) : null)
              : h("div", { className: "dxb-bot-sub" }, bot.systemPrompt ? "已配置人格提示" : "未配置人格提示"),
            h(
              "div",
              { className: "dxb-bot-actions" },
              h("button", { className: "dxb-btn primary", onClick: function () { onChat(bot); } }, "私聊"),
              h("button", {
                className: "dxb-btn",
                title: "重置：为这个 bot 开一个新的私有对话（旧对话留在会话列表里）",
                onClick: function () {
                  if (!window.confirm("重置会为「" + bot.name + "」开一个新的私有对话，旧对话仍保留在会话列表里。继续？")) return;
                  onChat(bot, { rebuild: true });
                },
              }, "重置"),
              h("button", { className: "dxb-btn", onClick: function () { onEdit(bot); } }, "编辑"),
              h("button", { className: "dxb-btn ghost", onClick: function () { onDelete(bot); } }, "删除"),
            ),
          );
        }),
      );
    }

    // ---- 右侧栏 Bots 标签页 -------------------------------------------------
    // 右侧栏窄，用行式列表而不是主面板那种卡片。
    var SIDE_TAB_ID = "@dsh-external/dsh-bots/bots";
    var SIDE_TAB_KIND = "dsh-bots";

    function uiNow() {
      return pickUi();
    }

    function currentCwdNow() {
      var ws = uiNow();
      if (!ws) return undefined;
      try {
        var cur = typeof ws.currentWorkspace === "function" ? ws.currentWorkspace() : ws.currentWorkspace;
        if (cur && cur.path) return cur.path;
      } catch (e) { /* ignore */ }
      return undefined;
    }

    function workspaceIdForPath(path) {
      try {
        var ws = uiNow();
        if (!ws || !path) return undefined;
        var list = ws.workspaces && ws.workspaces.list;
        var snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : list;
        var items = (snap && snap.items) || (Array.isArray(snap) ? snap : []);
        for (var i = 0; i < items.length; i += 1) {
          var item = items[i];
          var wsPath = item && (item.path || (item.header && item.header.path));
          if (wsPath && String(wsPath).toLowerCase() === String(path).toLowerCase()) return item.workspaceId || item.id;
        }
      } catch (e) { /* ignore */ }
      return undefined;
    }

    // Workspaces are the unit a task's execution session is filed under. Boards
    // show a short folder name; dialogs show the full path in a title tooltip.
    function shortPath(path) {
      if (!path) return "";
      var parts = String(path).replace(/[\\/]+$/, "").split(/[\\/]/);
      return parts[parts.length - 1] || String(path);
    }

    function workspaceOf(workspaces, workspaceId) {
      if (!workspaceId) return null;
      var list = workspaces || [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && String(list[i].id) === String(workspaceId)) return list[i];
      }
      return null;
    }

    function workspaceShort(workspaces, workspaceId) {
      if (!workspaceId) return "";
      var hit = workspaceOf(workspaces, workspaceId);
      if (!hit) return String(workspaceId).slice(0, 8) + "…";
      return shortPath(hit.path) || hit.title || String(workspaceId).slice(0, 8) + "…";
    }

    function workspaceTitle(workspaces, workspaceId) {
      var hit = workspaceOf(workspaces, workspaceId);
      if (!hit) return String(workspaceId || "");
      return (hit.title ? hit.title + " — " : "") + (hit.path || hit.id);
    }

    function sessionCatalog() {
      var ui = pickUi();
      if (ui && ui.sessions && typeof ui.sessions === "object") return ui.sessions;
      try {
        var svc = pluginCtx && pluginCtx.get ? pluginCtx.get("sessions", false) : null;
        if (svc) return svc;
      } catch (e) { /* no catalog */ }
      return null;
    }

    // A bot has exactly one private conversation. The host owns that id, but the
    // Web client can only reveal a session that is already in its catalog, so we
    // pull the catalog (and retain the session) before handing it to openSession.
    function catalogHasSession(sessions, id) {
      try {
        var snap = typeof sessions.list === "object" && sessions.list && typeof sessions.list.getSnapshot === "function"
          ? sessions.list.getSnapshot()
          : typeof sessions.snapshot === "function" ? sessions.snapshot() : null;
        if (!snap) return false;
        // The catalog snapshot is { ids, byId, phase, projectionsBySession }.
        if (Array.isArray(snap.ids)) return snap.ids.indexOf(id) >= 0;
        if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, id)) return true;
        var items = snap.items || snap.sessions || snap.entries || [];
        return items.some(function (row) { return row && (row.sessionId === id || row.id === id); });
      } catch (e) {
        return false;
      }
    }

    function revealSession(sessionId) {
      var sessions = sessionCatalog();

      if (!sessions || typeof sessionId !== "string" || !sessionId) return Promise.resolve(false);
      var known = function () { return catalogHasSession(sessions, sessionId); };
      return Promise.resolve()
        .then(function () { return known() ? true : (typeof sessions.refresh === "function" ? sessions.refresh() : null); })
        .then(function () { return known() ? true : (typeof sessions.retain === "function" ? sessions.retain(sessionId, { source: "dsh-bots" }) : null); })
        .then(function () { return known(); })
        .catch(function () { return false; });
    }

    // openSession() silently falls back to the workspace chooser when the session's
    // workspace is not part of this instance, so check that a composer actually
    // mounted before telling the user the chat is open.
    function sessionViewLooksOpen() {
      // A mounted conversation always has a composer. Anything else (chooser, blank
      // frame, still-loading) means the session did not open.
      try {
        return document.querySelectorAll('[contenteditable="true"], textarea').length > 0;
      } catch (e) {
        return false;
      }
    }

    // One bot = one private conversation, fixed for good.
    //
    // The host owns the session id, but the Web client can only open a session that
    // its own catalog knows. A conversation created by the client is therefore the
    // only one we can reliably reveal; when the stored id was created elsewhere we
    // adopt a client-created replacement exactly once (via replace:true) and reuse it
    // from then on.
    function wait(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function openExistingSession(sessionId) {
      return revealSession(sessionId).then(function (known) {
        if (!known) return false;
        var workspace = uiNow();
        if (!workspace || typeof workspace.openSession !== "function") return false;
        try { workspace.openSession(sessionId); } catch (e) { return false; }
        return wait(1600).then(function () { return sessionViewLooksOpen(); });
      });
    }

    // Ask the host for this bot's conversation. The host creates it through the
    // session controller, which announces it to every client, so the shell can then
    // open it by id. The client never creates the session itself: a client-created
    // session keeps a write handle, and the host agent would collide with it.
    function requestSession(bot, targetPath, reset) {
      return api("/bots/" + bot.id + "/chat", {
        method: "POST",
        body: reset ? { cwd: targetPath, reset: true } : { cwd: targetPath },
      }).then(function (payload) {
        var sessionId = payload && payload.sessionId;
        if (!sessionId) throw new Error("「" + bot.name + "」的会话创建失败");
        if (bot.isOrchestrator) {
          var workspace = uiNow();
          if (workspace && typeof workspace.pinSession === "function") {
            try { workspace.pinSession(sessionId); } catch (e) { /* best effort */ }
          }
        }
        return sessionId;
      });
    }

    // A freshly announced session can take a moment to appear in the client
    // catalog; refresh and retry before declaring it unopenable.
    function openAnnouncedSession(sessionId) {
      var attempt = function (left) {
        return openExistingSession(sessionId).then(function (opened) {
          if (opened) return true;
          if (left <= 0) return false;
          var sessions = sessionCatalog();
          return Promise.resolve(sessions && typeof sessions.refresh === "function" ? sessions.refresh() : null)
            .then(function () { return wait(700); })
            .then(function () { return attempt(left - 1); });
        });
      };
      return attempt(3);
    }

    // The decision table for "open this bot's conversation". Kept free of network
    // and UI so tests/chat-flow.test.mjs can pin it down:
    //   existing + opened      -> reuse it
    //   existing + not opened  -> error (never silently create a replacement)
    //   no existing            -> create one
    //   reset asked            -> create one, without looking at the old one
    function chatFlow(bot, options, deps) {
      var targetPath = bot.workspaceId || currentCwdNow();
      var reset = !!(options && (options.rebuild || options.reset));
      function finish(sessionId, created, opened, wasReset) {
        return { sessionId: sessionId, botId: bot.id, opened: opened, created: created, reset: !!wasReset };
      }
      if (reset) {
        return deps.request(bot, targetPath, true).then(function (fresh) {
          return deps.open(fresh).then(function (opened) { return finish(fresh, true, opened, true); });
        });
      }
      return deps.peek(bot, targetPath).then(function (existing) {
        if (!existing) {
          return deps.request(bot, targetPath, false).then(function (fresh) {
            return deps.open(fresh).then(function (opened) { return finish(fresh, true, opened, false); });
          });
        }
        return deps.open(existing).then(function (opened) {
          if (opened) return finish(existing, false, true, false);
          var error = new Error("这个对话在当前窗口里打不开（可能属于别的工作区，或会话历史已损坏）。点「重置」可以新开一个对话。");
          error.code = "CANNOT_OPEN";
          error.sessionId = existing;
          throw error;
        });
      });
    }

    function launchChat(bot, options) {
      return chatFlow(bot, options, {
        peek: function (target, targetPath) {
          return api("/bots/" + target.id + "/chat", { method: "POST", body: { cwd: targetPath, peek: true } })
            .then(function (peeked) { return peeked && peeked.sessionId; });
        },
        request: function (target, targetPath, shouldReset) {
          return requestSession(target, targetPath, shouldReset);
        },
        open: function (sessionId) { return openAnnouncedSession(sessionId); },
      });
    }

    function BotsSidePane() {
      var dataPair = react.useState(null);
      var data = dataPair[0], setData = dataPair[1];
      var errPair = react.useState("");
      var error = errPair[0], setError = errPair[1];
      var busyPair = react.useState("");
      var busy = busyPair[0], setBusy = busyPair[1];
      var filterPair = react.useState("");
      var filter = filterPair[0], setFilter = filterPair[1];

      function load() {
        return api("/state")
          .then(function (next) {
            publishDirectory(next);
            setData(next);
            setError("");
            return next;
          })
          .catch(function (err) {
            setError((err && err.message) || String(err));
          });
      }

      react.useEffect(function () {
        load();
        var timer = setInterval(load, 15000);
        return function () { clearInterval(timer); };
      }, []);

      function reset(bot) {
        setBusy(bot.id);
        setError("");
        launchChat(bot, { rebuild: true })
          .catch(function (err) { setError((err && err.message) || String(err)); })
          .then(function () { setBusy(""); load(); });
      }

      function open(bot) {
        setBusy(bot.id);
        setError("");
        launchChat(bot)
          .catch(function (err) { setError((err && err.message) || String(err)); })
          .then(function () { setBusy(""); load(); });
      }

      var all = (data && data.bots) || [];
      var tasks = (data && data.tasks) || [];
      var needle = filter.trim().toLowerCase();
      var bots = all
        .filter(function (bot) { return !needle || bot.name.toLowerCase().indexOf(needle) >= 0 || bot.id.indexOf(needle) >= 0; })
        .sort(function (a, b) { return (b.isOrchestrator ? 1 : 0) - (a.isOrchestrator ? 1 : 0); });

      return h(
        "div",
        { className: "dxb dxb-side" },
        h(
          "div",
          { className: "dxb-side-head" },
          h("span", { className: "dxb-side-title" }, h(BotGlyph, { icon: "robot", size: 13 }), "Bots", h("span", { className: "dxb-side-count" }, all.length)),
          h("button", { className: "dxb-icon-btn", onClick: load, title: "刷新" }, "↻"),
        ),
        all.length > 5 ? h("input", { className: "dxb-side-filter", value: filter, placeholder: "筛选 bot", onChange: function (event) { setFilter(event.target.value); } }) : null,
        error ? h("div", { className: "dxb-err" }, h("span", { style: { flex: 1 } }, error)) : null,
        !data ? h("div", { className: "dxb-empty" }, "加载中…") : null,
        data && !all.length ? h("div", { className: "dxb-empty" }, h("div", null, "还没有 bot。"), h("div", { className: "dxb-side-hint" }, "去「任务板」新建一个主控助理。")) : null,
        data && all.length && !bots.length ? h("div", { className: "dxb-empty" }, "没有匹配的 bot。") : null,
        h(
          "div",
          { className: "dxb-side-list" },
          bots.map(function (bot) {
            var count = tasks.filter(function (task) {
              return task.assignee && task.assignee.id === bot.id && task.status !== "done" && task.status !== "canceled";
            }).length;
            return h(
              "div",
              {
                role: "button",
                tabIndex: 0,
                className: "dxb-side-row" + (bot.isOrchestrator ? " crown" : "") + (busy === bot.id ? " busy" : ""),
                key: bot.id,
                title: "与「" + bot.name + "」私聊",
                onClick: function () { if (busy !== bot.id) open(bot); },
                onKeyDown: function (event) {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (busy !== bot.id) open(bot); }
                },
              },
              h("span", { className: "dxb-side-avatar" }, h(BotGlyph, { icon: bot.icon, size: 17 })),
              h(
                "span",
                { className: "dxb-side-main" },
                h("span", { className: "dxb-side-name" }, bot.name, bot.isOrchestrator ? h("span", { className: "dxb-side-pill" }, "主控") : null),
                h(
                  "span",
                  { className: "dxb-side-sub" },
                  h("i", { className: "dxb-dot" + (count ? " on" : "") }),
                  count ? count + " 个在办" : "空闲",
                  h("span", { className: "dxb-side-sep" }, "·"),
                  bot.sessionId ? "已有会话" : "新会话",
                ),
              ),
              h(
                "span",
                { className: "dxb-side-acts" },
                h("span", { className: "dxb-side-go" }, busy === bot.id ? "…" : "私聊"),
                h("button", {
                  type: "button",
                  className: "dxb-side-reset",
                  title: "重置：开一个新的私有对话",
                  onClick: function (event) {
                    event.stopPropagation();
                    if (busy === bot.id) return;
                    if (!window.confirm("重置会为「" + bot.name + "」开一个新的私有对话，旧对话仍保留在会话列表里。继续？")) return;
                    reset(bot);
                  },
                }, "↺"),
              ),
            );
          }),
        ),
        bots.length ? h("div", { className: "dxb-side-foot" }, "点任意一行直接开私聊") : null,
      );
    }

    function TaskDialog(props) {
      var task = props.task;
      var bots = props.bots;
      var onClose = props.onClose;
      var onSaved = props.onSaved;
      var onError = props.onError;
      var titleState = react.useState(task.title);
      var title = titleState[0], setTitle = titleState[1];
      var briefState = react.useState(task.brief || "");
      var brief = briefState[0], setBrief = briefState[1];
      var statusState = react.useState(task.status);
      var status = statusState[0], setStatus = statusState[1];
      var prioState = react.useState(task.priority);
      var priority = prioState[0], setPriority = prioState[1];
      var assigneeState = react.useState(task.assignee && task.assignee.kind === "bot" ? task.assignee.id : "");
      var assignee = assigneeState[0], setAssignee = assigneeState[1];
      var notifyState = react.useState(task.notify || "");
      var notifyMode = notifyState[0], setNotifyMode = notifyState[1];
      var workspaces = props.workspaces || [];
      var wsState = react.useState(task.workspaceId || "");
      var ws = wsState[0], setWs = wsState[1];
      var commentState = react.useState("");
      var comment = commentState[0], setComment = commentState[1];
      var busyState = react.useState("");
      var busy = busyState[0], setBusy = busyState[1];
      // The dialog may outlive a server-side change (dispatch rebuilds the session,
      // a rebuild moves it to another workspace): follow the task, not stale state.
      react.useEffect(function () {
        setWs(task.workspaceId || "");
      }, [task.id, task.workspaceId]);

      function run(label, promise) {
        setBusy(label);
        promise
          .then(function () {
            setBusy("");
            onSaved();
          })
          .catch(function (error) {
            setBusy("");
            onError(error.message);
          });
      }

      function save() {
        run(
          "save",
          api("/tasks/" + task.id, {
            method: "PATCH",
            body: {
              title: title,
              brief: brief,
              status: status,
              priority: priority,
              notify: notifyMode,
              workspaceId: ws || null,
              assignee: assignee ? { kind: "bot", id: assignee } : null,
            },
          }),
        );
      }

      // Jump straight into the task's conversation: the host confirms the id is
      // openable (its workspace/log belongs to this profile) before the client
      // hands it to openSession(), which would otherwise fail silently.
      function openSession() {
        setBusy("open");
        api("/tasks/" + task.id + "/open-session", { method: "POST", body: {} })
          .then(function (result) {
            return openAnnouncedSession(result.sessionId).then(function (opened) {
              setBusy("");
              if (!opened) onError("会话 " + result.sessionId + " 没能在这个界面打开；确认它属于当前 profile，或点「新开会话」重建一个。");
            });
          })
          .catch(function (error) {
            setBusy("");
            onError(error.message);
          });
      }

      // Replace the task's conversation (wrong workspace, unreadable log, or a
      // conversation too dirty to continue). The task, rounds and comments stay.
      function newSession() {
        if (!window.confirm("给这个任务换一个新会话？旧会话会被解绑（正在跑的轮次会被停止），任务与评论都保留。")) return;
        setBusy("new");
        api("/tasks/" + task.id + "/session", { method: "POST", body: { workspaceId: ws || undefined } })
          .then(function (result) {
            return openAnnouncedSession(result.sessionId).then(function (opened) {
              setBusy("");
              onSaved();
              if (!opened) onError("新会话 " + result.sessionId + " 已建好，但这个界面还打不开它；刷新后再试。");
            });
          })
          .catch(function (error) {
            setBusy("");
            onError(error.message);
          });
      }

      function dispatch() {
        run("dispatch", api("/tasks/" + task.id + "/dispatch", { method: "POST", body: {} }));
      }

      function stopRound() {
        run("stop", api("/tasks/" + task.id + "/stop", { method: "POST", body: { reason: "用户在任务详情里手动停止" } }));
      }

      function addComment() {
        if (!comment.trim()) return;
        run(
          "comment",
          api("/tasks/" + task.id + "/comment", { method: "POST", body: { author: "human", text: comment.trim() } }).then(function () {
            setComment("");
          }),
        );
      }

      var wsMoved = (task.workspaceId || "") !== (ws || "");

      return h(
        "div",
        { className: "dxb-mask", onMouseDown: function (event) { if (event.target === event.currentTarget) onClose(); } },
        h(
          "div",
          { className: "dxb-dialog" },
          h("div", { className: "dxb-dialog-head" }, h("span", { className: "dxb-chip id" }, task.id), h("span", { style: { flex: 1 } }, "任务详情"), h("button", { className: "dxb-btn ghost", onClick: onClose }, "✕")),
          h(
            "div",
            { className: "dxb-dialog-body" },
            h("div", { className: "dxb-field" }, h("label", null, "标题"), h("input", { className: "dxb-input", value: title, onChange: function (e) { setTitle(e.target.value); } })),
            h("div", { className: "dxb-field" }, h("label", null, "任务全文（执行者只看到这段）"), h("textarea", { className: "dxb-textarea", value: brief, onChange: function (e) { setBrief(e.target.value); }, placeholder: "背景 / 目标 / 验收标准 / 相关位置 / 禁止事项" })),
            h(
              "div",
              { className: "dxb-row" },
              h("div", { className: "dxb-field" }, h("label", null, "状态"), h("select", { className: "dxb-select", value: status, onChange: function (e) { setStatus(e.target.value); } }, Object.keys(STATUS_LABEL).map(function (key) { return h("option", { key: key, value: key }, STATUS_LABEL[key]); }))),
              h(
                "div",
                { className: "dxb-field" },
                h("label", null, "指派"),
                h(
                  "select",
                  { className: "dxb-select", value: assignee, onChange: function (e) { setAssignee(e.target.value); } },
                  h("option", { value: "" }, "未指派 / 我自己"),
                  bots.map(function (bot) {
                    return h("option", { key: bot.id, value: bot.id }, bot.name + (bot.isOrchestrator ? "（主控）" : ""));
                  }),
                ),
              ),
              h("div", { className: "dxb-field" }, h("label", null, "优先级"), h("select", { className: "dxb-select", value: priority, onChange: function (e) { setPriority(e.target.value); } }, Object.keys(PRIORITY_LABEL).map(function (key) { return h("option", { key: key, value: key }, PRIORITY_LABEL[key]); }))),
            ),
            h(
              "div",
              { className: "dxb-row" },
              h(
                "div",
                { className: "dxb-field" },
                h("label", null, "Workspace（执行会话开在这里）"),
                h(
                  "select",
                  { className: "dxb-select", value: ws, onChange: function (e) { setWs(e.target.value); }, title: "执行 bot 的会话会开在这个 workspace 里；改完派发时会自动重建会话" },
                  h("option", { value: "" }, "默认（跟随 bot）"),
                  workspaces.map(function (item) {
                    return h("option", { key: item.id, value: item.id }, (item.title ? item.title + " · " : "") + shortPath(item.path));
                  }),
                ),
              ),
              h("div", { className: "dxb-field" }, h("label", null, "结束通知"), h("select", { className: "dxb-select", value: notifyMode, onChange: function (e) { setNotifyMode(e.target.value); } },
                h("option", { value: "", title: "交回静默进收件箱，受阻与异常才发可见通知" }, "默认"),
                h("option", { value: "silent", title: "只落库，主控需要时用 inbox_list 拉取" }, "静默"),
                h("option", { value: "visible", title: "直接把通知发进主控私聊" }, "可见"),
              )),
            ),
            h(
              "div",
              { className: "dxb-session" },
              h(
                "div",
                { className: "dxb-session-main" },
                h("span", { className: "dxb-session-label" }, "执行会话"),
                task.sessionId
                  ? h("code", { className: "dxb-session-id", title: task.sessionId }, task.sessionId)
                  : h("span", { className: "dxb-muted" }, "还没有 · 派发时自动创建"),
                wsMoved ? h("span", { className: "dxb-session-warn" }, "workspace 已改，派发时会自动重建会话") : null,
              ),
              task.sessionId
                ? h("button", { className: "dxb-btn", onClick: openSession, disabled: busy !== "" }, busy === "open" ? "打开中…" : "打开会话")
                : null,
              h("button", { className: "dxb-btn" + (task.sessionId ? "" : " primary"), onClick: newSession, disabled: busy !== "" }, busy === "new" ? "新建中…" : task.sessionId ? "新开会话" : "建会话"),
            ),
            task.comments && task.comments.length
              ? h(
                  "div",
                  { className: "dxb-comments" },
                  task.comments.map(function (item) {
                    return h("div", { className: "dxb-comment", key: item.id }, h("b", null, item.author), item.text);
                  }),
                )
              : null,
            h(
              "div",
              { className: "dxb-field" },
              h("label", null, "加评论"),
              h(
                "div",
                { style: { display: "flex", gap: 6 } },
                h("input", { className: "dxb-input", value: comment, placeholder: "补充上下文 / 打回原因", onChange: function (e) { setComment(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") addComment(); } }),
                h("button", { className: "dxb-btn", onClick: addComment, disabled: busy !== "" }, "发送"),
              ),
            ),
            task.result ? h("div", { className: "dxb-comment" }, task.result) : null,
          ),
          h(
            "div",
            { className: "dxb-dialog-foot" },
            h("button", { className: "dxb-btn", onClick: function () { setStatus("done"); }, disabled: busy !== "" }, "标为已完成"),
            task.activeRoundId ? h("button", { className: "dxb-btn danger", onClick: stopRound, disabled: busy !== "" }, busy === "stop" ? "停止中…" : "停止本轮") : null,
            h("button", { className: "dxb-btn", onClick: dispatch, disabled: busy !== "" || Boolean(task.activeRoundId) }, busy === "dispatch" ? "派发中…" : "派发给 bot"),
            h("button", { className: "dxb-btn primary", onClick: save, disabled: busy !== "" }, busy === "save" ? "保存中…" : "保存"),
          ),
        ),
      );
    }

    function BotDialog(props) {
      var bot = props.bot;
      var onClose = props.onClose;
      var onSaved = props.onSaved;
      var onError = props.onError;
      var isNew = !bot.id;
      var nameState = react.useState(bot.name || "");
      var name = nameState[0], setName = nameState[1];
      var iconState = react.useState(bot.icon || "compass");
      var icon = iconState[0], setIcon = iconState[1];
      var promptState = react.useState(bot.systemPrompt || "");
      var prompt = promptState[0], setPrompt = promptState[1];
      var skillsState = react.useState((bot.skills || []).join(", "));
      var skills = skillsState[0], setSkills = skillsState[1];
      var orchState = react.useState(Boolean(bot.isOrchestrator));
      var isOrchestrator = orchState[0], setIsOrchestrator = orchState[1];
      var busyState = react.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      function save() {
        setBusy(true);
        var body = {
          name: name.trim(),
          icon: icon,
          systemPrompt: prompt,
          skills: skills.split(",").map(function (item) { return item.trim(); }).filter(Boolean),
          isOrchestrator: isOrchestrator,
        };
        var request = isNew ? api("/bots", { method: "POST", body: body }) : api("/bots/" + bot.id, { method: "PATCH", body: body });
        request
          .then(function () {
            setBusy(false);
            onSaved();
          })
          .catch(function (error) {
            setBusy(false);
            onError(error.message);
          });
      }

      return h(
        "div",
        { className: "dxb-mask", onMouseDown: function (event) { if (event.target === event.currentTarget) onClose(); } },
        h(
          "div",
          { className: "dxb-dialog" },
          h("div", { className: "dxb-dialog-head" }, h("span", { style: { flex: 1 } }, isNew ? "新建 Bot" : "编辑 " + bot.name), h("button", { className: "dxb-btn ghost", onClick: onClose }, "✕")),
          h(
            "div",
            { className: "dxb-dialog-body" },
            h("div", { className: "dxb-row" }, h("div", { className: "dxb-field" }, h("label", null, "名字"), h("input", { className: "dxb-input", value: name, placeholder: "例如：前端工程师 / 私人助理", onChange: function (e) { setName(e.target.value); } }))),
            h("div", { className: "dxb-field" }, h("label", null, "图标"), h("div", { className: "dxb-icons" }, ICON_IDS.map(function (id) { return h("button", { key: id, type: "button", className: "dxb-icon" + (id === glyphId(icon) ? " on" : ""), onClick: function () { setIcon(id); }, title: id }, h(BotGlyph, { icon: id, size: 18 })); }))),
            h("div", { className: "dxb-field" }, h("label", null, "额外 system prompt（人格与工作规范）"), h("textarea", { className: "dxb-textarea", value: prompt, placeholder: "例如：你是一名资深前端，偏保守，改动前先读现有代码……", onChange: function (e) { setPrompt(e.target.value); } })),
            h("div", { className: "dxb-field" }, h("label", null, "启用的技能（用户级，逗号分隔；项目自带技能会自动加载）"), h("input", { className: "dxb-input", value: skills, placeholder: "downloads、browser-skill", onChange: function (e) { setSkills(e.target.value); } })),
            h("label", { className: "dxb-check" }, h("input", { type: "checkbox", checked: isOrchestrator, onChange: function (e) { setIsOrchestrator(e.target.checked); } }), "设为主控 bot（负责分派任务与汇总汇报，全局只有一个）"),
          ),
          h("div", { className: "dxb-dialog-foot" }, h("button", { className: "dxb-btn", onClick: onClose }, "取消"), h("button", { className: "dxb-btn primary", onClick: save, disabled: busy || !name.trim() }, busy ? "保存中…" : "保存")),
        ),
      );
    }

    function NewTaskDialog(props) {
      var bots = props.bots;
      var onClose = props.onClose;
      var onSaved = props.onSaved;
      var onError = props.onError;
      var titleState = react.useState("");
      var title = titleState[0], setTitle = titleState[1];
      var briefState = react.useState("");
      var brief = briefState[0], setBrief = briefState[1];
      var assigneeState = react.useState("");
      var assignee = assigneeState[0], setAssignee = assigneeState[1];
      var prioState = react.useState("normal");
      var priority = prioState[0], setPriority = prioState[1];
      var workspaces = props.workspaces || [];
      // Empty means "the workspace this panel is filed from"; the picker only
      // overrides it when the user targets another project.
      var wsState = react.useState("");
      var ws = wsState[0], setWs = wsState[1];
      var busyState = react.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      function save() {
        setBusy(true);
        Promise.resolve()
          .then(function () { return ws || workspaceIdForPath(currentCwdNow()); })
          .catch(function () { return null; })
          .then(function (workspaceId) {
            // A task carries the workspace it targets, so the bot session
            // it spawns lives in that project instead of the profile default.
            return api("/tasks", {
              method: "POST",
              body: {
                title: title.trim(),
                brief: brief,
                priority: priority,
                status: "todo",
                workspaceId: workspaceId || null,
                assignee: assignee ? { kind: "bot", id: assignee } : null,
              },
            });
          })
          .then(function () {
            setBusy(false);
            onSaved();
          })
          .catch(function (error) {
            setBusy(false);
            onError(error.message);
          });
      }

      return h(
        "div",
        { className: "dxb-mask", onMouseDown: function (event) { if (event.target === event.currentTarget) onClose(); } },
        h(
          "div",
          { className: "dxb-dialog" },
          h("div", { className: "dxb-dialog-head" }, h("span", { style: { flex: 1 } }, "新建任务"), h("button", { className: "dxb-btn ghost", onClick: onClose }, "✕")),
          h(
            "div",
            { className: "dxb-dialog-body" },
            h("div", { className: "dxb-field" }, h("label", null, "标题"), h("input", { className: "dxb-input", value: title, placeholder: "一句话说清要做什么", onChange: function (e) { setTitle(e.target.value); } })),
            h("div", { className: "dxb-field" }, h("label", null, "任务全文（执行者只看到这段，尽量自包含）"), h("textarea", { className: "dxb-textarea", value: brief, placeholder: "背景 / 目标 / 验收标准 / 相关位置 / 禁止事项", onChange: function (e) { setBrief(e.target.value); } })),
            h(
              "div",
              { className: "dxb-row" },
              h(
                "div",
                { className: "dxb-field" },
                h("label", null, "Workspace（执行会话开在这里）"),
                h(
                  "select",
                  { className: "dxb-select", value: ws, onChange: function (e) { setWs(e.target.value); }, title: "留空 = 当前窗口所在的工作区" },
                  h("option", { value: "" }, "当前工作区（" + (shortPath(currentCwdNow()) || "默认") + "）"),
                  workspaces.map(function (item) {
                    return h("option", { key: item.id, value: item.id }, (item.title ? item.title + " · " : "") + shortPath(item.path));
                  }),
                ),
              ),
              h("div", { className: "dxb-field" }, h("label", null, "指派"), h("select", { className: "dxb-select", value: assignee, onChange: function (e) { setAssignee(e.target.value); } }, h("option", { value: "" }, "未指派 / 我自己"), bots.map(function (bot) { return h("option", { key: bot.id, value: bot.id }, bot.name + (bot.isOrchestrator ? "（主控）" : "")); }))),
              h("div", { className: "dxb-field" }, h("label", null, "优先级"), h("select", { className: "dxb-select", value: priority, onChange: function (e) { setPriority(e.target.value); } }, Object.keys(PRIORITY_LABEL).map(function (key) { return h("option", { key: key, value: key }, PRIORITY_LABEL[key]); }))),
            ),
          ),
          h("div", { className: "dxb-dialog-foot" }, h("button", { className: "dxb-btn", onClick: onClose }, "取消"), h("button", { className: "dxb-btn primary", onClick: save, disabled: busy || !title.trim() }, busy ? "创建中…" : "创建")),
        ),
      );
    }

    function SessionRowBadge(props) {
      var tickState = react.useState(0);
      var setTick = tickState[1];
      react.useEffect(function () {
        return subscribeBindings(function () { setTick(function (n) { return n + 1; }); });
      }, []);
      var sessionId = props && (props.sessionId || props.session || props.id);
      var binding = sessionId ? bindingsBySession[sessionId] : null;
      if (!binding) return null;
      var bot = botsById[binding.botId];
      if (!bot) return null;
      return h("span", {
        className: "dxb-row-badge" + (bot.isOrchestrator ? " crown" : ""),
        title: (bot.isOrchestrator ? "主控 bot · " : "bot · ") + bot.name,
      }, h(BotGlyph, { id: bot.icon, size: 13 }));
    }

    function Panel(props) {
      var mode = (props && props.mode) || "all";
      var stateState = react.useState(null);
      var state = stateState[0], setState = stateState[1];
      var tabState = react.useState(mode === "bots" ? "bots" : "tasks");
      var tab = tabState[0], setTab = tabState[1];
      var errState = react.useState("");
      var error = errState[0], setError = errState[1];
      var fixState = react.useState(null);
      var errorFix = fixState[0], setErrorFix = fixState[1];
      var noteState = react.useState(null);
      var note = noteState[0], setNote = noteState[1];
      var noteTimer = react.useRef(null);
      var flash = react.useCallback(function (message, isError) {
        setNote({ text: message, err: Boolean(isError) });
        if (noteTimer.current) clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(function () { setNote(null); }, 2600);
      }, []);
      var taskState = react.useState(null);
      var openTask = taskState[0], setOpenTask = taskState[1];
      var botState = react.useState(null);
      var editBot = botState[0], setEditBot = botState[1];
      var newTaskState = react.useState(false);
      var newTask = newTaskState[0], setNewTask = newTaskState[1];
      var collapseState = react.useState({ done: true, backlog: true });
      var collapsed = collapseState[0], setCollapsed = collapseState[1];

      var reload = react.useCallback(function () {
        return api("/state")
          .then(function (data) {
            publishDirectory(data);
            setState(data);
            setError("");
            return data;
          })
          .catch(function (err) {
            setError(err.message);
          });
      }, []);

      react.useEffect(function () {
        reload();
        var timer = setInterval(reload, 10000);
        return function () {
          clearInterval(timer);
        };
      }, [reload]);

      react.useEffect(function () {
        function onKey(event) {
          if (event.key !== "Escape") return;
          if (newTask) setNewTask(false);
          else if (editBot) setEditBot(null);
          else if (openTask) setOpenTask(null);
        }
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, [newTask, editBot, openTask]);

      function ui() {
        var names = ["uiWorkspace", "workspace", "workspaces", "ui"];
        for (var i = 0; i < names.length; i += 1) {
          try {
            var service = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get(names[i], false) : null;
            if (service && typeof service.openSession === "function") return service;
          } catch (e) {
            /* try next */
          }
        }
        try {
          if (pluginCtx && pluginCtx.uiWorkspace && typeof pluginCtx.uiWorkspace.openSession === "function") return pluginCtx.uiWorkspace;
        } catch (e) {
          /* ignore */
        }
        try {
          if (window.__DSH_UI__ && typeof window.__DSH_UI__.openSession === "function") return window.__DSH_UI__;
        } catch (e) {
          /* ignore */
        }
        return null;
      }

      function chat(bot, options) {
        setError("");
        setErrorFix(null);
        // Same path as the right pane: one private conversation per bot, reused.
        launchChat(bot, options)
          .then(function (result) {
            if (result && result.opened === false) {
              setError("「" + bot.name + "」的会话没能打开（工作区不在当前实例？）。可以点「重置」开一个新的。");
              flash("会话打不开：试试点「重置」", true);
            } else {
              flash("已打开与「" + bot.name + "」的私聊");
            }
            reload();
          })
          .catch(function (err) {
            var message = err && err.message ? err.message : String(err);
            console.error("[dsh-bots] open chat failed", err);
            setError(message);
          });
      }
      function removeBot(bot) {
        if (!window.confirm("删除 " + bot.name + "？它的私聊会话不会被删除。")) return;
        api("/bots/" + bot.id, { method: "DELETE" })
          .then(function () {
            flash("已删除「" + bot.name + "」");
            return reload();
          })
          .catch(function (err) {
            setError(err.message);
            flash(err.message, true);
          });
      }

      function openRightPane() {
        var svc = null;
        try {
          svc = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sidebarRight", false) : null;
        } catch (e) {
          svc = null;
        }
        if (!svc || typeof svc.openTab !== "function") {
          setError("当前界面没有右侧栏，无法打开 Bots 侧栏");
          return;
        }
        try {
          svc.openTab(SIDE_TAB_KIND);
          return;
        } catch (err) {
          // 右侧栏只在有会话时存在。先打开一个私聊，再把标签页顶出来。
          var fallback = (bots || []).filter(function (item) { return item.isOrchestrator; })[0] || (bots || [])[0];
          if (!fallback) {
            setError("右侧栏只在会话里显示。先点某个 bot 的「私聊」，再打开右侧栏。");
            return;
          }
          flash("先打开「" + fallback.name + "」的私聊，右侧栏随后打开");
          launchChat(fallback)
            .then(function () {
              // 会话面板挂载需要几帧，openTab 早调用会抛 no session surface。
              var attempts = 0;
              var timer = setInterval(function () {
                attempts += 1;
                try {
                  svc.openTab(SIDE_TAB_KIND);
                  clearInterval(timer);
                } catch (e) {
                  if (attempts >= 8) {
                    clearInterval(timer);
                    setError("右侧栏没有顶出来，请从会话头部手动展开");
                  }
                }
              }, 700);
            })
            .catch(function (e) {
              setError((e && e.message) || String(e));
            });
        }
      }

      function refreshTask() {
        reload().then(function (data) {
          if (!data || !openTask) return;
          for (var i = 0; i < data.tasks.length; i += 1) {
            if (data.tasks[i].id === openTask.id) {
              setOpenTask(data.tasks[i]);
              return;
            }
          }
          setOpenTask(null);
        });
      }

      if (!state) {
        return h("div", { className: "dxb" }, h("div", { className: "dxb-head" }, h("div", { className: "dxb-title" }, mode === "bots" ? "Bots" : "任务板 · Bots"),), h("div", { className: "dxb-body" }, h("div", { className: "dxb-empty" }, error || "加载中…")));
      }

      var tasks = state.tasks || [];
      var bots = state.bots || [];
      var workspaces = state.workspaces || [];

      return h(
        "div",
        { className: "dxb" },
        h(
          "div",
          { className: "dxb-head" },
          h("div", { className: "dxb-title" }, h(BotGlyph, { icon: mode === "bots" ? "robot" : "robot", size: 15 }), mode === "bots" ? "Bots" : "任务板"),
          mode === "all"
            ? h(
                "div",
                { className: "dxb-tabs" },
                h("button", { className: "dxb-tab" + (tab === "tasks" ? " on" : ""), onClick: function () { setTab("tasks"); } }, "任务 " + tasks.filter(function (task) { return task.status !== "done" && task.status !== "canceled"; }).length),
                h("button", { className: "dxb-tab" + (tab === "bots" ? " on" : ""), onClick: function () { setTab("bots"); } }, "Bots " + bots.length),
              )
            : null,
          h("button", { className: "dxb-btn ghost", onClick: function () { reload(); }, title: "刷新" }, "↻"),
          h("button", { className: "dxb-btn ghost", onClick: openRightPane, title: "在右侧栏打开 Bots 列表" }, "右侧栏"),
          mode === "all" ? h("button", { className: "dxb-btn", onClick: function () { setNewTask(true); }, title: "新建任务" }, "+ 任务") : null,
          h("button", { className: "dxb-btn primary", onClick: function () { setEditBot({}); }, title: "新建 Bot" }, "+ Bot"),
        ),
        error ? h(
          "div",
          { className: "dxb-err" },
          h("span", { style: { flex: 1 } }, error),
          errorFix ? h("button", {
            className: "dxb-btn",
            onClick: function () { chat(errorFix.bot, { rebuild: true }); },
          }, errorFix.label) : null,
          h("button", { className: "dxb-btn ghost", onClick: function () { setError(""); setErrorFix(null); } }, "✕")
        ) : null,
        h(
          "div",
          { className: "dxb-body" },
          tab === "tasks"
            ? h(Board, {
                tasks: tasks,
                bots: bots,
                workspaces: workspaces,
                collapsed: collapsed,
                toggle: function (id) {
                  var next = Object.assign({}, collapsed);
                  next[id] = !next[id];
                  setCollapsed(next);
                },
                onOpen: function (task) { setOpenTask(task); },
              })
            : h(BotsGrid, {
                bots: bots,
                tasks: tasks,
                onChat: chat,
                onEdit: function (bot) { setEditBot(bot); },
                onDelete: removeBot,
              }),
        ),
        openTask ? h(TaskDialog, { task: openTask, bots: bots, workspaces: workspaces, onClose: function () { setOpenTask(null); }, onSaved: refreshTask, onError: setError }) : null,
        editBot ? h(BotDialog, { bot: editBot, onClose: function () { setEditBot(null); }, onSaved: function () { setEditBot(null); reload(); }, onError: setError }) : null,
        newTask ? h(NewTaskDialog, { bots: bots, workspaces: workspaces, onClose: function () { setNewTask(false); }, onSaved: function () { setNewTask(false); reload(); flash("任务已创建"); }, onError: setError }) : null,
        note ? h("div", { className: "dxb-toast" + (note.err ? " err" : "") }, note.text) : null,
      );
    }

    function PanelIcon() {
      return h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" },
        h("rect", { x: 3.25, y: 7.25, width: 5.5, height: 12.5, rx: 1.6 }),
        h("rect", { x: 10.75, y: 3.25, width: 5.5, height: 16.5, rx: 1.6 }),
        h("rect", { x: 18.25, y: 10.25, width: 2.5, height: 9.5, rx: 1.2, opacity: 0.55 }),
      );
    }

    // 左侧「Bots」行：比「任务板」再浅一层，点开就是 bot 列表。
    function BotsPanel() {
      return h(Panel, { mode: "bots" });
    }

    function BotsPanelIcon() {
      return h(BotGlyph, { id: "robot", size: 16 });
    }

    function pickUi() {
      var names = ["uiWorkspace", "workspace", "workspaces", "ui"];
      for (var i = 0; i < names.length; i += 1) {
        try {
          var service = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get(names[i], false) : null;
          if (service && typeof service.openSession === "function") return service;
        } catch (e) { /* try next */ }
      }
      try {
        if (pluginCtx && pluginCtx.uiWorkspace && typeof pluginCtx.uiWorkspace.openSession === "function") return pluginCtx.uiWorkspace;
      } catch (e) { /* ignore */ }
      try {
        if (window.__DSH_UI__ && typeof window.__DSH_UI__.openSession === "function") return window.__DSH_UI__;
      } catch (e) { /* ignore */ }
      return null;
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ensureStyle();
      try {
        window.__dshBotsProbe = function (sessionId) {
      try {
        var ui = pickUi();
        if (!ui) return { error: 'no ui' };
        var snap = ui.sessions && ui.sessions.list && typeof ui.sessions.list.getSnapshot === 'function' ? ui.sessions.list.getSnapshot() : null;
        var wsSnap = ui.workspaces && ui.workspaces.list && typeof ui.workspaces.list.getSnapshot === 'function' ? ui.workspaces.list.getSnapshot() : null;
        var items = (wsSnap && wsSnap.items) || [];
        return {
          inCatalog: !!(snap && snap.byId && snap.byId[sessionId]),
          catalogPhase: snap && snap.phase,
          workspaceHolding: items.filter(function (w) { return (w.sessionIds || []).indexOf(sessionId) >= 0; }).map(function (w) { return w.workspaceId || w.id; }),
          workspaceCount: items.length,
          mainRef: ui.mainReference && ui.mainReference.sessionId,
          hasOpenWorkspace: typeof ui.openWorkspace === 'function',
          hasPin: typeof ui.pinSession === 'function',
        };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    };
    window.__dshBots = function (sessionId) {
          var service = pickUi();
          if (!service) return "no-service";
          try { service.openSession(sessionId); return "called:" + Object.keys(service).length; } catch (e) { return "error:" + (e && e.message); }
        };
        window.__dshBotsKeys = function () {
          var service = pickUi();
          if (!service) return "no-service";
          window.__dshBotsSvc = service;
          return Object.keys(service).join(",");
        };
        window.__dshBotsOpenRight = function () {
          var svc = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sidebarRight", false) : null;
          if (!svc || typeof svc.openTab !== "function") return "no-right-service";
          try {
            svc.openTab(SIDE_TAB_KIND);
            return "opened";
          } catch (e) {
            return "error:" + (e && e.message ? e.message : e);
          }
        };
      } catch (e) { /* ignore */ }
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({ name: "sidebar.panellist", id: "dsh-bots", order: 51, label: function () { return "任务板"; } }, PanelIcon);
        });
      }, "dsh-bots: panellist");
      ctx.effect(function () {
        return ctx.slots.inject("main", function* () {
          yield ctx.slots.register({ name: "main", key: "dsh-bots" }, Panel);
        });
      }, "dsh-bots: panel");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({ name: "sidebar.panellist", id: "dsh-bots-bots", order: 52, label: function () { return "Bots"; } }, BotsPanelIcon);
        });
      }, "dsh-bots: bots panellist");
      ctx.effect(function () {
        return ctx.slots.inject("main", function* () {
          yield ctx.slots.register({ name: "main", key: "dsh-bots-bots" }, BotsPanel);
        });
      }, "dsh-bots: bots panel");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.session.row.trailing", function () {
          return ctx.slots.register({ name: "sidebar.session.row.trailing", id: "dsh-bots", order: 60 }, SessionRowBadge);
        });
      }, "dsh-bots: session badge");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: SIDE_TAB_ID }, BotsSidePane);
        });
      }, "dsh-bots: right pane body");
      ctx.effect(function () {
        // sidebarRightTabs 可能晚于本插件就绪：先用依赖注入，拿不到再轮询。
        var disposer = null;
        var timer = null;
        function register(tabs) {
          if (!tabs || typeof tabs.register !== "function" || disposer) return;
          try {
            disposer = tabs.register({
              id: SIDE_TAB_ID,
              kind: SIDE_TAB_KIND,
              title: function () { return "Bots"; },
              keepMounted: true,
            });
          } catch (err) {
            console.warn("[dsh-bots] right tab registration failed", err);
          }
        }
        function cleanup() {
          if (timer) clearInterval(timer);
          if (disposer) { try { disposer(); } catch (e) { /* ignore */ } }
        }
        var injected = false;
        if (typeof ctx.inject === "function") {
          try {
            ctx.inject(["sidebarRightTabs"], function (scope) {
              var tabs = null;
              try {
                tabs = scope.sidebarRightTabs || (typeof scope.get === "function" ? scope.get("sidebarRightTabs", false) : null);
              } catch (e) { /* ignore */ }
              register(tabs);
            });
            injected = true;
          } catch (e) {
            injected = false;
          }
        }
        if (!injected) {
          var tries = 0;
          timer = setInterval(function () {
            tries += 1;
            var tabs = null;
            try { tabs = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sidebarRightTabs", false) : null; } catch (e) { /* ignore */ }
            if (tabs) { clearInterval(timer); timer = null; register(tabs); }
            else if (tries > 40) { clearInterval(timer); timer = null; }
          }, 250);
        }
        return cleanup;
      }, "dsh-bots: right tab type");
      api("/state").then(publishDirectory).catch(function () { /* host may be starting */ });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.__chatFlow = chatFlow;
    return module.exports;
  },
});

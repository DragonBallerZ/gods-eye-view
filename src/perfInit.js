// src/perfInit.js — runtime perf knobs for the worldview fork.
// Loaded BEFORE src/main.js (see index.html script order). Patches
// the constructed Cesium viewer AFTER src/main.js creates it, plus
// exports the diagnostic surface and the #perf-mode-toggle handler.
// No upstream src/* file is edited.

const DEFAULTS_KEY = '__worldviewPerf';
const GLASS_KEY = '__worldviewPerf.glass';
const DISABLED_KEY = '__worldviewPerf.disabled';

function readFlags() {
  try {
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}');
    const rawGlass = localStorage.getItem(GLASS_KEY);
    const rawDisabled = localStorage.getItem(DISABLED_KEY);
    return {
      disabled: rawDisabled === '1',
      glass: rawGlass === 'low' ? 'low' : 'high',
      noMsaa: raw.noMsaa === '1',
      noPreserve: raw.noPreserve === '1',
      raw,
    };
  } catch {
    return { disabled: false, glass: 'high', noMsaa: false, noPreserve: false, raw: {} };
  }
}

function writeFlags(partial) {
  try {
    if (partial.glass) localStorage.setItem(GLASS_KEY, partial.glass);
    if (partial.disabled !== undefined) localStorage.setItem(DISABLED_KEY, partial.disabled ? '1' : '0');
    const cur = readFlags();
    const out = { ...cur.raw, ...(partial.raw || {}) };
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(out));
  } catch {}
}

function setGlassMode(mode) {
  document.body.dataset.perf = mode === 'low' ? 'low' : 'high';
  writeFlags({ glass: mode });
  updateToggleLabel();
  return document.body.dataset.perf;
}

function updateToggleLabel() {
  const btn = document.getElementById('perf-mode-toggle');
  if (!btn) return;
  const mode = document.body.dataset.perf || 'high';
  btn.textContent = `PERF · ${mode.toUpperCase()}`;
  btn.setAttribute('aria-pressed', mode === 'low' ? 'true' : 'false');
}

function applyPostConstructionKnobs(viewer) {
  if (!viewer) return;
  // targetFrameRate is settable on the live viewer.
  try { viewer.targetFrameRate = 60; } catch {}
  // Some Cesium versions expose a Scene render property we can throttle:
  try {
    if (viewer.scene && viewer.scene.maximumRenderTimeChange == null) {
      viewer.scene.maximumRenderTimeChange = Infinity;
    }
  } catch {}
  // Resolution scaling — drop device pixel ratio for hot scenes. Keep 1.0 by
  // default but expose a knob for users who set resolutionScale <1.
  try {
    if (viewer.resolutionScale === undefined) viewer.resolutionScale = window.devicePixelRatio > 1 ? 0.85 : 1;
  } catch {}
}

function installGovernorsHook() {
  let warned = false;
  const govTimer = setInterval(() => {
    if (warned) return;
    const g = window.__godsEyeView;
    if (g?.getRenderGovernorDiagnostics) {
      try {
        const diag = g.getRenderGovernorDiagnostics();
        // Log every held-continuous-render owner once. This is exactly
        // the diagnostic the user needs when "toggling lots of layers"
        // makes the renderer hot — it tells them which layers are
        // forcing continuous mode.
        const holds = Array.isArray(diag?.holds) ? diag.holds
          : (diag?._holds ? Array.from(diag._holds) : []);
        console.info('[perf-init] governor owners',
          { mode: diag?.mode, holds });
      } catch (e) {
        console.info('[perf-init] governor hook error:', String(e));
      }
      warned = true;
      clearInterval(govTimer);
    }
  }, 1000);
  setTimeout(() => clearInterval(govTimer), 30000);
}

function installLongtaskObserver() {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 200) {
          console.info('[perf-init] longtask',
            Math.round(entry.duration), 'ms @',
            entry.startTime.toFixed(0));
        }
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {}
}

function watchViewer() {
  const start = Date.now();
  let knobsApplied = false;
  let coalescerInstalled = false;
  let serializerInstalled = false;
  const iv = setInterval(() => {
    const g = window.__godsEyeView;
    if (g?.viewer && !knobsApplied) {
      applyPostConstructionKnobs(g.viewer);
      knobsApplied = true;
    }
    if (g && !coalescerInstalled) {
      installRenderCoalescer(g);
      coalescerInstalled = g.__perfCoalescerInstalled || false;
    }
    if (g?.dataManager && !serializerInstalled) {
      installLayerEnableSerializer(g);
      serializerInstalled = g.dataManager?.__perfSerializerInstalled || false;
    }
    if (knobsApplied && coalescerInstalled && serializerInstalled) {
      clearInterval(iv);
    } else if (Date.now() - start > 30000) {
      console.info('[perf-init] watchViewer timed out waiting for',
        { knobsApplied, coalescerInstalled, serializerInstalled });
      clearInterval(iv);
    }
  }, 500);
}

// Serialize dataManager.setEnabled() so a rapid burst of toggle clicks
// does not spawn 15 concurrent fetches/scene mutations. We keep the fix
// upstream-compatible by wrapping the original call, but we make it usable
// by (a) collapsing redundant same-layer requests to the final desired state
// and (b) allowing a small, safe amount of concurrency so the queue drains
// quickly. Each call still goes through the upstream code path.
function installLayerEnableSerializer(g) {
  if (!g?.dataManager) return;
  const dm = g.dataManager;
  if (dm.__perfSerializerInstalled) return;
  const originalSetEnabled = dm.setEnabled?.bind(dm);
  if (typeof originalSetEnabled !== 'function') return;

  const MAX_CONCURRENT = 2;
  const MIN_START_GAP_MS = 80; // keep sequential main-thread spikes from overlapping
  const pending = new Map(); // id -> { id, want, opts, promises: [{resolve,reject}] }
  let inFlight = 0;
  let totalSerialized = 0;
  let lastStartTime = 0;
  let scheduleTimer = null;

  function schedule() {
    if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
    if (inFlight >= MAX_CONCURRENT || pending.size === 0) return;
    const now = performance.now();
    if (inFlight > 0 && now - lastStartTime < MIN_START_GAP_MS) {
      scheduleTimer = setTimeout(schedule, MIN_START_GAP_MS - (now - lastStartTime));
      return;
    }
    // Prefer OFF jobs first: they are cheaper and free resources.
    let job = null;
    for (const entry of pending.values()) {
      if (entry.want === false) { job = entry; break; }
    }
    if (!job) job = pending.values().next().value;
    pending.delete(job.id);
    inFlight++;
    lastStartTime = performance.now();
    run(job);
    schedule();
  }

  async function run(job) {
    const start = performance.now();
    try {
      const out = await originalSetEnabled(job.id, job.want, job.opts);
      job.promises.forEach(p => p.resolve(out));
    } catch (err) {
      job.promises.forEach(p => p.reject(err));
    } finally {
      inFlight--;
      totalSerialized++;
      const took = Math.round(performance.now() - start);
      if (took > 50) {
        console.info('[perf-init] setEnabled', job.id, job.want ? 'ON' : 'OFF', took + 'ms');
      }
      if (g.requestRender) g.requestRender('serialised-enable');
      schedule();
    }
  }

  dm.setEnabled = function perfSerializedSetEnabled(id, want, opts) {
    return new Promise((resolve, reject) => {
      const existing = pending.get(id);
      if (existing) {
        // Collapse rapid same-layer toggles: only the final state matters.
        existing.want = want;
        existing.opts = opts;
        existing.promises.push({ resolve, reject });
      } else {
        pending.set(id, { id, want, opts, promises: [{ resolve, reject }] });
      }
      schedule();
    });
  };
  dm.__perfSerializerInstalled = true;
  g.__perfSerializerStats = () => ({
    queueDepth: pending.size,
    inFlight,
    totalSerialized,
  });
  console.info('[perf-init] layer-enable serializer installed (collapse-same-layer, max-concurrent=' + MAX_CONCURRENT + ')');
}

// Coalesce concurrent render requests so toggling 5+ layers in the same
// JS turn queues 1 frame, not 5. Bottleneck when toggling many streams:
// each dataManager.setEnabled() fires governorRequestRender() and Cesium
// schedules a frame for every call — that's the crash / stall symptom the
// user is reporting. Coalescing on microtask preserves correctness (1
// frame still completes) and reduces the per-burst CPU/GPU spike.
function installRenderCoalescer(g) {
  if (!g || g.__perfCoalescerInstalled) return;
  const originalRequest = g.requestRender?.bind(g);
  if (typeof originalRequest !== 'function') return;
  let scheduled = false;
  let pendingReasons = [];
  g.requestRender = function perfCoalescedRequestRender(reason = 'unspecified') {
    pendingReasons.push(reason);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const reasons = pendingReasons;
      pendingReasons = [];
      const summary = reasons.length === 1
        ? reasons[0]
        : `${reasons.length} calls coalesced (last: ${reasons[reasons.length - 1]})`;
      originalRequest(summary);
    });
  };
  g.__perfCoalescerInstalled = true;
  console.info('[perf-init] render-request coalescer installed');
}

// Exposed via window.__perfBatchToggle — when callers (UI ribbons, voice
// actions, dev fixtures) want to flip N layers in one shot, route through
// here and only one frame is interleaved between them. setEnabled calls
// themselves stay on the upstream path (no upstream code mutation).
async function batchToggleLayerEnables(layerIdToEnabled, opts = {}) {
  const g = window.__godsEyeView;
  if (!g?.dataManager) return { ok: false, reason: 'no-dataManager' };
  const results = [];
  const entries = Object.entries(layerIdToEnabled || {});
  for (const [id, want] of entries) {
    if (typeof g.dataManager.setEnabled !== 'function') {
      results.push({ id, ok: false, reason: 'no-setEnabled' });
      continue;
    }
    try {
      const layer = g.dataManager.layers?.get?.(id);
      const cur = layer?.enabled ?? false;
      if (cur === want) {
        results.push({ id, ok: true, unchanged: true });
        continue;
      }
      await Promise.resolve(
        g.dataManager.setEnabled(id, want, { origin: opts.origin || 'perf-batch' }),
      );
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, reason: String(err?.message || err) });
    }
  }
  return { ok: true, count: entries.length, results };
}

export function installPerfInit() {
  const flags = readFlags();
  if (flags.disabled) {
    window.__worldviewPerf = { flags, setGlassMode, disabled: true };
    return;
  }

  document.body.dataset.perf = flags.glass === 'low' ? 'low' : 'high';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireToggleButton);
  } else {
    wireToggleButton();
  }

  installLongtaskObserver();
  installGovernorsHook();
  watchViewer();

  window.__worldviewPerf = {
    flags,
    setGlassMode,
    toggleGlassLow: () => setGlassMode('low'),
    setHigh: () => setGlassMode('high'),
    batchToggleLayers: batchToggleLayerEnables,
    diagnostics: () => {
      const out = {
        perf: document.body.dataset.perf || 'high',
        holds: null,
        coalescerInstalled: false,
      };
      try {
        const g = window.__godsEyeView;
        const diag = g?.getRenderGovernorDiagnostics?.();
        out.holds = Array.isArray(diag?.holds) ? diag.holds
          : (diag?._holds ? Array.from(diag._holds) : (diag?.mode ?? null));
        out.targetFrameRate = g?.viewer?.targetFrameRate ?? null;
        out.resolutionScale = g?.viewer?.resolutionScale ?? null;
        out.coalescerInstalled = !!g?.__perfCoalescerInstalled;
        out.serializerInstalled = !!g?.dataManager?.__perfSerializerInstalled;
      } catch {}
      return out;
    },
    disabled: false,
  };
  window.__perfBatchToggle = batchToggleLayerEnables;
}

function wireToggleButton() {
  const btn = document.getElementById('perf-mode-toggle');
  if (!btn) return;
  updateToggleLabel();
  btn.addEventListener('click', () => {
    const now = document.body.dataset.perf === 'low' ? 'high' : 'low';
    setGlassMode(now);
  });
}

installPerfInit();

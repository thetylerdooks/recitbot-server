// Recitbot share page player: custom controls over a native <video>, transcript seek/highlight and view beacons.
// No dependencies. Without this script the page falls back to the browser's own controls.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const p = $("player");
  const v = $("v");
  if (!p || !v) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const fmt = (t) => {
    if (!isFinite(t) || t < 0) return "--:--";
    const s = Math.floor(t);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const dur = () => (isFinite(v.duration) && v.duration > 0 ? v.duration : 0);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  // ---------- view beacons (protocol in worker/src/stats.ts) ----------
  // First beacon on load counts the view; then 25/50/75/100 % as playback passes them, 100 on ended, and the
  // furthest point on pagehide. Owner and link-preview pages carry no data-vt, so they send nothing. A prerendered page
  // (the browser loading it before anyone opens it) counts only once it is actually shown.
  const vt = v.dataset.vt;
  if (vt) {
    let sent = -1;
    let m = 0;
    const send = (pct) => {
      if (pct <= sent) return;
      sent = pct;
      navigator.sendBeacon(location.pathname + "/b", new URLSearchParams({ t: vt, p: String(pct) }));
    };
    if (document.prerendering) document.addEventListener("prerenderingchange", () => send(0), { once: true });
    else send(0);
    v.addEventListener("timeupdate", () => {
      if (!dur() || v.seeking) return;
      m = Math.max(m, Math.min(100, Math.floor((v.currentTime / dur()) * 100)));
      const k = [100, 75, 50, 25].find((x) => m >= x);
      if (k) send(k);
    });
    v.addEventListener("ended", () => {
      m = 100;
      send(100);
    });
    addEventListener("pagehide", () => send(m));
  }

  // ---------- enhance: swap native controls for ours ----------
  v.controls = false;
  p.classList.add("on");
  v.addEventListener("contextmenu", (e) => e.preventDefault());

  const big = $("big");
  const playBtn = $("play");
  const muteBtn = $("mute");
  const vol = $("vol");
  const speed = $("speed");
  const fsBtn = $("fs");
  const scrub = $("scrub");
  const buf = $("buf");
  const fill = $("fill");
  const knob = $("knob");
  const tip = $("tip");
  const cur = $("cur");
  const total = $("dur");

  const toggle = () => (v.paused || v.ended ? v.play().catch(() => {}) : v.pause());
  big.addEventListener("click", toggle);
  playBtn.addEventListener("click", toggle);

  // ---------- time + scrub bar ----------
  let dragging = false;
  const paint = (t) => {
    const d = dur();
    const f = d ? clamp(t / d, 0, 1) : 0;
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
    cur.textContent = fmt(t);
    scrub.setAttribute("aria-valuenow", String(Math.floor(t)));
    scrub.setAttribute("aria-valuetext", `${fmt(t)} of ${fmt(d)}`);
  };
  const paintBuffered = () => {
    const d = dur();
    if (!d || !v.buffered.length) return;
    // the range that contains the playhead (or the last one before it)
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) end = v.buffered.end(i);
    }
    buf.style.width = `${clamp(end / d, 0, 1) * 100}%`;
  };
  const onMeta = () => {
    total.textContent = fmt(dur());
    scrub.setAttribute("aria-valuemax", String(Math.floor(dur())));
    paint(v.currentTime);
    paintBuffered();
  };
  v.addEventListener("loadedmetadata", onMeta);
  v.addEventListener("durationchange", onMeta);
  v.addEventListener("progress", paintBuffered);
  v.addEventListener("timeupdate", () => {
    if (!dragging) paint(v.currentTime);
    paintBuffered();
  });
  if (v.readyState >= 1) onMeta();
  // e.g. the short-lived media cookie lapsed during a long pause; the page (and its share link) can mint a new one
  v.addEventListener("error", () => ($("fail").hidden = false));

  const timeAt = (clientX) => {
    const r = scrub.getBoundingClientRect();
    const f = clamp((clientX - r.left) / r.width, 0, 1);
    return { t: f * dur(), x: f * r.width };
  };
  const showTip = (clientX) => {
    if (!dur()) return;
    const { t, x } = timeAt(clientX);
    const w = scrub.clientWidth;
    tip.textContent = fmt(t);
    tip.hidden = false;
    tip.style.left = `${clamp(x, 24, w - 24)}px`;
  };
  const seek = (t) => {
    if (!dur()) return;
    v.currentTime = clamp(t, 0, dur());
    paint(v.currentTime);
  };

  let lastSeek = 0;
  scrub.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || dragging) showTip(e.clientX);
    if (!dragging) return;
    const { t } = timeAt(e.clientX);
    paint(t);
    // throttle real seeks while dragging; each one is a Range request
    if (performance.now() - lastSeek > 120) {
      lastSeek = performance.now();
      seek(t);
    }
  });
  scrub.addEventListener("pointerleave", () => {
    if (!dragging) tip.hidden = true;
  });
  scrub.addEventListener("pointerdown", (e) => {
    if (!dur() || (e.pointerType === "mouse" && e.button !== 0)) return;
    dragging = true;
    scrub.classList.add("drag");
    scrub.setPointerCapture(e.pointerId);
    showTip(e.clientX);
    paint(timeAt(e.clientX).t);
    wake();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    scrub.classList.remove("drag");
    seek(timeAt(e.clientX).t);
    if (e.pointerType !== "mouse") tip.hidden = true;
  };
  scrub.addEventListener("pointerup", endDrag);
  scrub.addEventListener("pointercancel", endDrag);
  scrub.addEventListener("keydown", (e) => {
    if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(dur());
    else return;
    e.preventDefault();
  });

  // ---------- volume, mute, speed ----------
  const syncVol = () => {
    const off = v.muted || v.volume === 0;
    p.classList.toggle("muted-on", off);
    muteBtn.setAttribute("aria-label", off ? "Unmute (m)" : "Mute (m)");
    vol.value = String(v.muted ? 0 : v.volume);
    vol.setAttribute("aria-valuetext", `${Math.round((v.muted ? 0 : v.volume) * 100)}%`);
  };
  muteBtn.addEventListener("click", () => {
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else v.muted = true;
  });
  vol.addEventListener("input", () => {
    v.volume = Number(vol.value);
    v.muted = v.volume === 0;
  });
  v.addEventListener("volumechange", syncVol);
  // iOS ignores scripted volume; show only mute there.
  const before = v.volume;
  v.volume = 0.5;
  if (v.volume !== 0.5) p.classList.add("novol");
  v.volume = before;
  syncVol();
  const nudgeVol = (d) => {
    v.muted = false;
    v.volume = clamp(Math.round((v.volume + d) * 20) / 20, 0, 1);
  };

  speed.addEventListener("change", () => {
    v.playbackRate = Number(speed.value);
  });
  v.addEventListener("ratechange", () => {
    speed.value = String(v.playbackRate);
  });

  // ---------- fullscreen (container; iPhone Safari only has the video's own fullscreen) ----------
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  const canFs = !!(p.requestFullscreen || p.webkitRequestFullscreen);
  const toggleFs = () => {
    if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (canFs) (p.requestFullscreen || p.webkitRequestFullscreen).call(p);
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  };
  const syncFs = () => {
    const on = fsEl() === p;
    p.classList.toggle("fs", on);
    fsBtn.setAttribute("aria-label", on ? "Exit full screen (f)" : "Full screen (f)");
  };
  fsBtn.addEventListener("click", toggleFs);
  document.addEventListener("fullscreenchange", syncFs);
  document.addEventListener("webkitfullscreenchange", syncFs);
  if (!canFs && !v.webkitEnterFullscreen) fsBtn.hidden = true;

  // ---------- play state + auto-hide ----------
  let idleTimer = 0;
  const wake = () => {
    p.classList.remove("idle");
    clearTimeout(idleTimer);
    if (!v.paused && !dragging) idleTimer = setTimeout(() => p.classList.add("idle"), 2500);
  };
  const syncPlay = () => {
    const playing = !v.paused && !v.ended;
    p.classList.toggle("playing", playing);
    const label = playing ? "Pause (k)" : "Play (k)";
    playBtn.setAttribute("aria-label", label);
    big.setAttribute("aria-label", label);
    wake();
  };
  ["play", "pause", "ended"].forEach((ev) => v.addEventListener(ev, syncPlay));
  p.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") wake();
  });
  p.addEventListener("focusin", wake);
  p.addEventListener("mouseleave", () => {
    if (!v.paused && !dragging) p.classList.add("idle");
  });

  // Mouse: click toggles play, double-click toggles full screen. Touch: tap shows/hides the controls.
  v.addEventListener("click", (e) => {
    if (e.pointerType === "touch" || (e.pointerType === undefined && matchMedia("(hover: none)").matches)) {
      if (p.classList.contains("idle") || v.paused) wake();
      else {
        clearTimeout(idleTimer);
        p.classList.add("idle");
      }
      return;
    }
    toggle();
  });
  v.addEventListener("dblclick", toggleFs);
  syncPlay();

  // ---------- keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    const tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el && el.isContentEditable)) return;
    const onButton = tag === "BUTTON";
    switch (e.key) {
      case " ":
      case "Spacebar":
        if (onButton) return; // the focused button handles its own activation
        toggle();
        break;
      case "k":
      case "K":
        toggle();
        break;
      case "ArrowLeft":
        seek(v.currentTime - 5);
        break;
      case "ArrowRight":
        seek(v.currentTime + 5);
        break;
      case "ArrowUp":
        nudgeVol(0.05);
        break;
      case "ArrowDown":
        nudgeVol(-0.05);
        break;
      case "m":
      case "M":
        v.muted = !v.muted;
        break;
      case "f":
      case "F":
        toggleFs();
        break;
      default:
        return;
    }
    e.preventDefault();
    wake();
  });

  // ---------- transcript: click to seek, highlight the active line, keep it near the middle of the panel ----------
  // Only the list's own scrollTop ever moves, never the page's. Following pauses while the viewer
  // scrolls the list by hand and resumes 3 s after their last manual scroll, or at once when they click a line.
  const list = $("lines");
  const lines = list ? [...list.querySelectorAll("button.l")] : [];
  if (!lines.length) return;
  const starts = lines.map((b) => Number(b.dataset.t) || 0);
  const HOLD_MS = 3000;
  const EASE_MS = 450;
  let active = -1;
  let manualUntil = 0;
  let anim = 0;
  let wrote = 0; // the scrollTop the follow animation last set; a scroll to anywhere else is the viewer's
  const stopEase = () => {
    cancelAnimationFrame(anim);
    anim = 0;
  };
  const manual = () => {
    manualUntil = performance.now() + HOLD_MS;
    stopEase();
  };
  list.addEventListener("wheel", manual, { passive: true });
  list.addEventListener("touchstart", manual, { passive: true });
  list.addEventListener("touchmove", manual, { passive: true });
  list.addEventListener("pointerdown", (e) => {
    if (e.target === list) manual(); // the list's own scrollbar (lines are buttons)
  });
  list.addEventListener("keydown", (e) => {
    if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) manual();
  });
  // catches anything the listeners above don't (scrollbar drag, keyboard, find-in-page). Not the browser bringing a
  // just-clicked line into view as it takes focus: a click resumes following.
  let clickedAt = -1e9;
  list.addEventListener("scroll", () => {
    if (performance.now() - clickedAt < 300) wrote = list.scrollTop;
    else if (Math.abs(list.scrollTop - wrote) > 2) manual();
  }, { passive: true });

  const easeTo = (to) => {
    stopEase();
    const from = list.scrollTop;
    if (Math.abs(to - from) < 1) return;
    if (reduced.matches) {
      wrote = to;
      list.scrollTop = to;
      wrote = list.scrollTop;
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / EASE_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease-in-out cubic
      list.scrollTop = from + (to - from) * e;
      wrote = list.scrollTop;
      anim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  };
  // Re-centre once the active line's middle passes ~50 % of the visible height, or when it is out of view (a seek).
  const follow = () => {
    if (active < 0 || anim || performance.now() < manualUntil) return;
    const b = lines[active];
    const view = list.clientHeight;
    const mid = b.offsetTop + b.offsetHeight / 2; // the list is position:relative, so this is relative to it
    const y = mid - list.scrollTop;
    if (y >= b.offsetHeight / 2 && y <= view * 0.55) return;
    easeTo(Math.max(0, Math.min(list.scrollHeight - view, mid - view / 2)));
  };
  lines.forEach((b, i) => {
    b.addEventListener("pointerdown", () => (clickedAt = performance.now())); // focus (and its scroll) comes before click
    b.addEventListener("click", () => {
      clickedAt = performance.now();
      manualUntil = 0;
      seek(starts[i]);
      if (v.paused) v.play().catch(() => {});
    });
  });
  const highlight = () => {
    const t = v.currentTime + 0.05;
    let i = -1;
    for (let k = 0; k < starts.length && starts[k] <= t; k++) i = k;
    if (i !== active) {
      if (active >= 0) lines[active].removeAttribute("aria-current");
      active = i;
      if (i >= 0) lines[i].setAttribute("aria-current", "true");
    }
    follow(); // every tick, so following catches up when a manual-scroll hold ends
  };
  v.addEventListener("timeupdate", highlight);
  v.addEventListener("seeked", highlight);
})();

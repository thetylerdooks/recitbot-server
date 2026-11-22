// Recitbot watch page: comments on a shared video. The section is server-rendered at its final size; this only enables
// the form, posts and deletes through <page path>/comments, and seeks the player from pinned times. Every user-supplied
// string goes in through textContent: nothing is parsed as HTML and URLs are not linkified.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const sec = $("cm");
  if (!sec) return;
  const list = $("cm-list");
  const empty = $("cm-empty");
  const n = $("cm-n");
  const v = $("v");
  const ck = sec.dataset.ck || "";
  const owner = sec.dataset.owner === "1";
  const api = location.pathname.replace(/\/+$/, "") + "/comments";
  const NAME_KEY = "recitbot.commentName";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const headers = (body) => ({ ...(body ? { "content-type": "application/json" } : {}), ...(ck ? { "x-comment-key": ck } : {}) });
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const pad = (x) => String(x).padStart(2, "0");
  const clock = (t) => {
    const s = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  };

  const st = $("cm-st");
  let stTimer = 0;
  const status = (text, err) => {
    if (!st) return;
    clearTimeout(stTimer);
    st.textContent = text;
    st.classList.toggle("err", !!err);
    if (text && !err) stTimer = setTimeout(() => (st.textContent = ""), 2500);
  };
  const bump = (d) => {
    const total = Math.max(0, (Number(n.textContent) || 0) + d);
    n.textContent = String(total);
    empty.hidden = list.children.length > 0;
  };

  // ---------- pinned times ----------
  const seekTo = (t) => {
    if (!v || !Number.isFinite(t)) return;
    v.currentTime = t; // player.js repaints on timeupdate / seeked
    if (v.paused) v.play().catch(() => {});
    const r = $("player").getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) $("player").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  };

  // ---------- delete (owner: any comment; viewer: their own, for 10 minutes) ----------
  const expire = (b) => {
    const until = Number(b.dataset.until) || 0;
    if (until > 0) setTimeout(() => b.remove(), Math.max(0, until * 1000 - Date.now()));
  };
  const del = async (b) => {
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Confirm delete";
      setTimeout(() => {
        if (b.isConnected && b.dataset.armed === "1") {
          b.dataset.armed = "";
          b.textContent = "Delete";
        }
      }, 4000);
      return;
    }
    const li = b.closest("li.c");
    b.disabled = true;
    try {
      const res = await fetch(`${api}/${encodeURIComponent(li.dataset.id)}`, { method: "DELETE", headers: headers(false), credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't delete the comment.");
      li.remove();
      bump(-1);
      status("Comment deleted");
    } catch (e) {
      b.disabled = false;
      b.dataset.armed = "";
      b.textContent = "Delete";
      status(e instanceof Error && e.message ? e.message : "Couldn't delete the comment.", true);
    }
  };

  list.addEventListener("click", (e) => {
    const t = e.target.closest("button.c-t");
    if (t) return seekTo(Number(t.dataset.t));
    const x = e.target.closest("button.c-x");
    if (x) del(x);
  });
  list.querySelectorAll("button.c-x").forEach(expire);

  /** A new comment, same markup as the server's (comments.ts commentHtml), text only. */
  const render = (c) => {
    const li = el("li", "c");
    li.dataset.id = c.id;
    const h = el("div", "c-h");
    h.append(el("span", "c-a", c.author));
    if (c.is_owner) h.append(el("span", "badge", "Owner"));
    const tm = el("time", "", "just now");
    tm.dateTime = new Date(c.created_at * 1000).toISOString();
    h.append(tm);
    if (c.t_seconds !== null && c.t_seconds !== undefined) {
      const b = el("button", "c-t", clock(c.t_seconds));
      b.type = "button";
      b.dataset.t = String(c.t_seconds);
      b.setAttribute("aria-label", `Play from ${clock(c.t_seconds)}`);
      h.append(b);
    }
    if (c.can_delete) {
      const x = el("button", "c-x", "Delete");
      x.type = "button";
      x.dataset.until = String(c.delete_until || 0);
      x.setAttribute("aria-label", `Delete comment by ${c.author}`);
      h.append(x);
      expire(x);
    }
    li.append(h, el("p", "c-b", c.body));
    return li;
  };

  // ---------- form ----------
  const form = $("cm-form");
  if (!form) return;
  const name = $("cm-name");
  const body = $("cm-body");
  const at = $("cm-at");
  const atT = $("cm-at-t");
  const count = $("cm-count");
  const post = $("cm-post");
  const MAX = body.maxLength > 0 ? body.maxLength : 500;
  let pinned = null;
  let busy = false;

  const showCount = () => {
    count.textContent = `${body.value.length}/${MAX}`;
    count.classList.toggle("near", body.value.length > MAX - 50);
  };
  body.addEventListener("input", showCount);
  showCount();
  if (name) {
    try {
      name.value = localStorage.getItem(NAME_KEY) || "";
    } catch {
      // storage blocked: the viewer types it
    }
  }
  // Unchecked, the toggle shows where the video is now; checking it pins that moment.
  const live = () => {
    if (!at.checked) atT.textContent = clock(v ? v.currentTime : 0);
  };
  if (v) {
    v.addEventListener("timeupdate", live);
    v.addEventListener("seeked", live);
  }
  at.addEventListener("change", () => {
    pinned = at.checked ? Math.round((v ? v.currentTime : 0) * 10) / 10 : null;
    if (pinned !== null) atT.textContent = clock(pinned);
    else live();
  });
  live();

  const resetTurnstile = () => {
    const box = form.querySelector(".cf-turnstile");
    try {
      if (box && window.turnstile) window.turnstile.reset(box);
    } catch {
      // widget gone; the next submit asks for the check again
    }
  };

  post.disabled = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    if (name && !name.value.trim()) {
      status("Add your name.", true);
      return name.focus();
    }
    if (!body.value.trim()) {
      status("Write a comment first.", true);
      return body.focus();
    }
    let turnstile;
    if (!owner) {
      const f = form.querySelector('[name="cf-turnstile-response"]');
      turnstile = f ? f.value : "";
      if (!turnstile) return status("Please complete the check below and try again.", true);
    }
    busy = true;
    post.disabled = true;
    status("Posting…");
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: headers(true),
        credentials: "same-origin",
        body: JSON.stringify({ name: name ? name.value : undefined, body: body.value, t: pinned, turnstile }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : res.status === 404 ? "This video isn't shared anymore." : "Couldn't post your comment.");
      }
      if (name) {
        try {
          localStorage.setItem(NAME_KEY, name.value.trim());
        } catch {
          // not remembered; fine
        }
      }
      list.prepend(render(data.comment));
      bump(1);
      body.value = "";
      showCount();
      at.checked = false;
      pinned = null;
      live();
      status("Posted");
    } catch (err) {
      status(err instanceof Error && err.message ? err.message : "Couldn't post your comment.", true);
    } finally {
      busy = false;
      post.disabled = false;
      if (!owner) resetTurnstile();
    }
  });
})();

// Recitbot watch page, owner only: in-place title + description editing and the Share popover. Clicking the text or its
// pencil makes it contenteditable; Enter (title) or Ctrl/Cmd+Enter (description) or blur saves, Escape reverts. PATCHes
// <page path>/meta. Text only ever goes through .textContent / .value.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const st = $("meta-st");
  if (!st) return;
  const chars = (s) => [...s];
  let stTimer = 0;
  const status = (text, err) => {
    clearTimeout(stTimer);
    st.textContent = text;
    st.classList.toggle("err", !!err);
    if (text && !err && text !== "Saving…") stTimer = setTimeout(() => (st.textContent = ""), 2000);
  };

  const fields = [
    { el: $("ttl"), pen: $("ttl-pen"), key: "title", multi: false },
    { el: $("desc"), pen: $("desc-pen"), key: "description", multi: true },
  ].filter((f) => f.el && f.pen);

  // What the field reads as text: titles are one line; descriptions keep their line breaks.
  const read = (f) => {
    const t = (f.el.innerText ?? f.el.textContent).replace(/\r\n?/g, "\n");
    return f.multi ? t.replace(/\n$/, "") : t.replace(/\n/g, " ");
  };

  const caretAt = (x, y) => {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      return r;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  };
  const caretEnd = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    return r;
  };
  const place = (r) => {
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };

  // Insert plain text at the caret, capped so the field stays within its limit.
  const insert = (f, text) => {
    const max = Number(f.el.dataset.max) || 0;
    const sel = window.getSelection();
    const picked = sel.rangeCount ? chars(sel.toString()).length : 0;
    if (!f.multi) text = text.replace(/[\r\n]+/g, " ");
    const room = max - (chars(read(f)).length - picked);
    if (room <= 0) return status(`${f.key === "title" ? "Title" : "Description"}: ${max} characters max`, true);
    const t = chars(text).slice(0, room).join("");
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const node = document.createTextNode(t);
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    place(r);
    if (chars(t).length < chars(text).length) status(`${f.key === "title" ? "Title" : "Description"}: ${max} characters max`, true);
  };

  const begin = (f, range) => {
    if (f.editing) return;
    f.editing = true;
    f.original = f.el.textContent;
    f.el.contentEditable = "plaintext-only";
    if (f.el.contentEditable !== "plaintext-only") f.el.contentEditable = "true";
    f.el.classList.add("on");
    f.el.focus();
    place(range || caretEnd(f.el));
  };

  const end = (f) => {
    f.editing = false;
    f.el.removeAttribute("contenteditable");
    f.el.classList.remove("on");
  };

  const save = async (f) => {
    if (!f.editing) return;
    const value = read(f);
    end(f);
    // Normalise what is on screen to plain text (drops anything a browser without plaintext-only put in).
    f.el.textContent = value;
    // Unchanged (including the default title, or the transcript-line default description): write nothing.
    if (value === f.original) return;
    const max = Number(f.el.dataset.max) || 0;
    if (max && chars(value.trim()).length > max) {
      f.el.textContent = f.original;
      return status(`${f.key === "title" ? "Title" : "Description"}: ${max} characters max`, true);
    }
    status("Saving…");
    try {
      const res = await fetch(location.pathname + "/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [f.key]: value }),
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't save");
      // Show what the server kept (trimmed, control characters gone); an empty title shows the default again.
      if (!f.editing) f.el.textContent = data[f.key] || f.el.dataset.default || "";
      if (f.key === "description") f.el.classList.remove("fb");
      if (f.key === "title") document.title = `${data.title || "Recitbot recording"} · Recitbot`;
      status("Saved");
    } catch (e) {
      if (!f.editing) f.el.textContent = f.original;
      status(e instanceof Error && e.message ? e.message : "Couldn't save", true);
    }
  };

  const cancel = (f) => {
    f.el.textContent = f.original;
    end(f);
    status("");
    f.pen.focus();
  };

  for (const f of fields) {
    f.el.addEventListener("click", (e) => {
      if (!f.editing) begin(f, caretAt(e.clientX, e.clientY));
    });
    f.pen.addEventListener("mousedown", (e) => f.editing && e.preventDefault()); // keep focus (no blur-save) mid-edit
    f.pen.addEventListener("click", () => (f.editing ? f.el.focus() : begin(f, null)));
    f.el.addEventListener("blur", () => save(f));
    f.el.addEventListener("keydown", (e) => {
      if (!f.editing || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel(f);
      } else if (e.key === "Enter" && (!f.multi || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        f.el.blur();
      } else if (e.key === "Enter" && f.multi) {
        e.preventDefault();
        insert(f, "\n");
      }
    });
    f.el.addEventListener("beforeinput", (e) => {
      if (!f.editing) return;
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
        if (f.multi) insert(f, "\n");
      } else if (e.inputType === "insertFromDrop" || e.inputType.startsWith("format")) {
        e.preventDefault();
      }
    });
    // Typing past the limit (IME and autocorrect included): cut back to the limit.
    f.el.addEventListener("input", () => {
      const max = Number(f.el.dataset.max) || 0;
      const t = read(f);
      if (!f.editing || !max || chars(t).length <= max) return;
      f.el.textContent = chars(t).slice(0, max).join("");
      place(caretEnd(f.el));
      status(`${f.key === "title" ? "Title" : "Description"}: ${max} characters max`, true);
    });
    // Paste: plain text only, whatever was copied.
    f.el.addEventListener("paste", (e) => {
      if (!f.editing) return;
      e.preventDefault();
      insert(f, e.clipboardData ? e.clipboardData.getData("text/plain") : "");
    });
  }
})();

// Share popover (owner only). The link is the server-rendered clean public URL in #pop-url, never location.href.
(() => {
  "use strict";
  const shr = document.getElementById("shr");
  const pop = document.getElementById("pop");
  if (!shr || !pop) return;
  const input = document.getElementById("pop-url");
  const cpb = document.getElementById("cpb");
  const live = document.getElementById("pop-live");
  let timer = 0;

  const open = () => {
    pop.hidden = false;
    shr.setAttribute("aria-expanded", "true");
    if (cpb) cpb.focus();
    if (input) input.select();
  };
  const close = (refocus) => {
    if (pop.hidden) return;
    pop.hidden = true;
    shr.setAttribute("aria-expanded", "false");
    if (refocus) shr.focus();
  };
  shr.addEventListener("click", () => (pop.hidden ? open() : close(true)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      e.preventDefault();
      close(true);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !shr.contains(e.target)) close(false);
  });
  pop.addEventListener("focusout", (e) => {
    if (e.relatedTarget && !pop.contains(e.relatedTarget) && e.relatedTarget !== shr) close(false);
  });

  if (!input || !cpb) return;
  input.addEventListener("focus", () => input.select());

  const say = (text) => {
    live.textContent = "";
    // Reset then set, so a second copy is announced again.
    setTimeout(() => (live.textContent = text), 50);
  };
  const fallback = () => {
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  };

  // Private video: Copy link first makes it public (POST ./share) and copies the URL that returns. Nothing is copied
  // unless that succeeds.
  const makePublic = async () => {
    const res = await fetch(location.pathname + "/share", { method: "POST", credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.url !== "string") throw new Error();
    input.value = data.url;
    delete cpb.dataset.private;
    const priv = document.getElementById("priv");
    if (priv) priv.remove();
  };

  let busy = false;
  cpb.addEventListener("click", async () => {
    if (busy) return;
    if (cpb.dataset.private) {
      busy = true;
      try {
        await makePublic();
      } catch {
        return say("Couldn't share the video. Try again.");
      } finally {
        busy = false;
      }
    }
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(input.value);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = fallback();
    if (!ok) {
      // Leave the link selected in the read-only field so it can be copied by hand.
      input.focus();
      input.select();
      return say("Copy failed. The link is selected, copy it by hand.");
    }
    clearTimeout(timer);
    cpb.textContent = "Copied";
    say("Link copied");
    timer = setTimeout(() => (cpb.textContent = "Copy link"), 2000);
  });
})();

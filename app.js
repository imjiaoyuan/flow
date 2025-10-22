// Cleaned front-end logic: no WebRTC, supports Worker API or localStorage fallback.

(() => {
  // Helpers
  const $ = sel => document.querySelector(sel);
  const uid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);
  const uidShort = (n = 4) => Math.random().toString(36).slice(2, 2 + n);
  const randPick = arr => arr[Math.floor(Math.random() * arr.length)];
  const mkSender = (n = 5) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  };

  // English names (device)
  const mkDeviceName = () => {
    const adjs = ['Sunny','Swift','Silent','Lone','Bright','Lightning','Gentle','Atomic','Calm','Clever'];
    const nouns = ['Falcon','Comet','Harbor','Echo','Atlas','Nimbus','Voyager','Pulse','Orbit','Quill'];
    return `${randPick(adjs)}-${randPick(nouns)}-${uidShort(4)}`;
  };

  // Config & state
  const STORE_KEY = 'flow.convs.v1';
  const THEME_KEY = 'flow.theme';
  const DEVICE_KEY = 'flow.deviceName';
  const WORKER_API = window.FLOW_WORKER_API || null; // set in index.html

  // DOM
  const deviceNameEl = $('#deviceName');
  const newConvBtn = $('#newConvBtn');
  const convsEl = $('#conversations');
  const messagesEl = $('#messages');
  const msgInput = $('#msgInput');
  const sendBtn = $('#sendBtn');
  const fileInput = $('#fileInput');
  const connStatus = $('#connStatus');

  // state
  let deviceName = localStorage.getItem(DEVICE_KEY);
  const containsNonAscii = name => /[^\x00-\x7F]/.test(name || '');
  if (!deviceName || containsNonAscii(deviceName)) {
    deviceName = mkDeviceName();
    try { localStorage.setItem(DEVICE_KEY, deviceName); } catch (e) { /* ignore */ }
  }
  if (deviceNameEl) deviceNameEl.textContent = deviceName;

  let convs = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  function saveLocalConvs() { localStorage.setItem(STORE_KEY, JSON.stringify(convs)); }
  if (!convs || !Array.isArray(convs)) convs = [];
  // do NOT auto-create a default conversation; allow empty state
  let activeConv = convs.length ? convs[0].id : null;

  // Time helpers
  function fmtTimeForIndex(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtTimestampForFilename(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  // Worker API helpers (Worker or local-server)
  async function uploadToWorker(key, blob, contentType) {
    if (!WORKER_API) throw new Error('no worker api configured');
    const url = new URL('/upload', WORKER_API);
    url.searchParams.set('key', key);
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(url.toString(), { method: 'PUT', headers, body: blob });
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    return await res.json(); // expect { url }
  }

  async function getJsonFromWorker(key) {
    if (!WORKER_API) return null;
    const url = new URL('/json', WORKER_API);
    url.searchParams.set('key', key);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return await res.json();
  }

  async function putJsonToWorker(key, obj) {
    if (!WORKER_API) throw new Error('no worker api configured');
    const url = new URL('/json', WORKER_API);
    url.searchParams.set('key', key);
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    if (!res.ok) throw new Error('put json failed: ' + res.status);
    return await res.json();
  }

  async function listConversationsFromWorker() {
    if (!WORKER_API) return null;
    const url = new URL('/list-conversations', WORKER_API);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return await res.json();
  }

  // helper: copy text to clipboard (fallback)
  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
  }

  // enable/disable composer UI based on whether a conversation exists/selected
  function updateComposerState() {
    const empty = !convs || convs.length === 0 || !activeConv;
    if (msgInput) msgInput.disabled = !!empty;
    if (fileInput) fileInput.disabled = !!empty;
    if (sendBtn) sendBtn.disabled = !!empty;
    const emptyEl = document.getElementById('emptyState');
    if (emptyEl) emptyEl.style.display = empty ? 'block' : 'none';
    if (messagesEl) messagesEl.style.display = empty ? 'none' : 'block';
  }

  // UI rendering
  function renderConvs() {
    if (!convsEl) return;
    convsEl.innerHTML = '';
    // filter out any malformed entries without title
    const visibleConvs = (convs || []).filter(c => c && c.title);
    if (!visibleConvs || visibleConvs.length === 0) {
      updateComposerState();
      return;
    }
    visibleConvs.forEach(c => {
      const li = document.createElement('li');
      li.className = c.id === activeConv ? 'active' : '';

      const titleSpan = document.createElement('span');
      titleSpan.textContent = c.title;
      titleSpan.style.cursor = 'pointer';
      titleSpan.onclick = () => { activeConv = c.id; renderConvs(); renderMessages(); updateComposerState(); };
      li.appendChild(titleSpan);

      const btns = document.createElement('span');
      btns.className = 'conv-btns';

      // Export icon (download)
      const be = document.createElement('button');
      be.className = 'conv-icon';
      be.title = 'Export conversation';
      be.innerHTML = '<i class="fas fa-file-export"></i>';
      be.onclick = (ev) => { ev.stopPropagation(); exportConversation(c.id); };
      btns.appendChild(be);

      // Delete icon (trash)
      const bd = document.createElement('button');
      bd.className = 'conv-icon';
      bd.title = 'Delete conversation';
      bd.innerHTML = '<i class="fas fa-trash-alt"></i>';
      bd.onclick = (ev) => { ev.stopPropagation(); deleteConversation(c.id); };
      btns.appendChild(bd);

      li.appendChild(btns);
      convsEl.appendChild(li);
    });
    updateComposerState();
  }

  function humanSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function escapeHtml(s = '') {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderMessages() {
    if (!messagesEl) return;
    const conv = convs.find(c => c.id === activeConv);
    messagesEl.innerHTML = '';
    if (!conv) { updateComposerState(); return; }
    const msgs = conv.messages || [];
    msgs.forEach(m => {
      const li = document.createElement('li');
      li.className = 'msg ' + ((m.sender || '') === deviceName ? 'me' : 'peer');
      const when = m.time || '';
      if (m.type === 'file' || m.url) {
        // show extension tag instead of folder emoji
        const rawName = m.text || m.filename || 'file';
        const ext = (rawName.split('.').pop() || '').substring(0,6).toUpperCase();
        const extTag = ext ? `<span class="ext-tag">[${escapeHtml(ext)}]</span>` : '';
        const fileName = escapeHtml(rawName);
        const downloadBtn = `<button class="action-btn download-file" data-url="${m.url || ''}" data-fname="${escapeHtml(rawName)}" title="Download"><i class="fas fa-download"></i></button>`;
        const copyBtn = m.url ? `<button class="action-btn copy-link" data-url="${m.url}" title="Copy link"><i class="fas fa-copy"></i></button>` : '';
        const delBtn = `<button class="action-btn msg-del" data-id="${m.id}" title="Delete message"><i class="fas fa-trash-alt"></i></button>`;
        li.innerHTML = `<div>${extTag} ${fileName} ${downloadBtn} ${copyBtn} ${delBtn}</div><div class="meta">${escapeHtml(m.sender || '')} · ${escapeHtml(when)}</div>`;
      } else {
        const delBtn = `<button class="action-btn msg-del" data-id="${m.id}" title="Delete message"><i class="fas fa-trash-alt"></i></button>`;
        li.innerHTML = `<div>${escapeHtml(m.text)} ${delBtn}</div><div class="meta">${escapeHtml(m.sender || '')} · ${escapeHtml(when)}</div>`;
      }
      messagesEl.appendChild(li);
    });

    // Delegated click handling for download / copy / delete buttons
    messagesEl.querySelectorAll('.download-file, .copy-link, .msg-del').forEach(btn => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        if (btn.classList.contains('copy-link')) {
          const url = btn.getAttribute('data-url');
          copyToClipboard(url);
          const old = btn.innerHTML;
          btn.innerHTML = '<i class="fas fa-check"></i>';
          setTimeout(()=> btn.innerHTML = old, 1200);
          return;
        }
        if (btn.classList.contains('download-file')) {
          const url = btn.getAttribute('data-url');
          const fname = btn.getAttribute('data-fname') || 'file';
          if (!url) { alert('No download URL available'); return; }
          try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('Fetch failed: ' + r.status);
            const blob = await r.blob();
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(objUrl);
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(()=> btn.innerHTML = '<i class="fas fa-download"></i>', 1200);
          } catch (e) {
            console.error('download failed', e);
            alert('Download failed: ' + (e.message || e));
          }
          return;
        }
        if (btn.classList.contains('msg-del')) {
          const mid = btn.getAttribute('data-id');
          await deleteMessage(activeConv, mid);
          return;
        }
      };
    });

    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateComposerState();
  }

  // Create conversation: id is 8-char alnum, title == id, sender uppercase 5 chars
  async function createConversation() {
    const title = prompt('Enter conversation title (A-Z, a-z, 0-9, _, / allowed):', '');
    if (!title || !/^[A-Za-z0-9_/]+$/.test(title)) {
      alert('Invalid title. Use A-Z, a-z, 0-9, _, / only.');
      return;
    }
    const id = uid(8);
    const sender = mkSender(5);
    convs.unshift({ id, title, messages: [] });
    activeConv = id;
    saveLocalConvs();
    renderConvs();
    renderMessages();
    // create index.json on worker/local
    const key = `conversations/${id}/index.json`;
    const indexObj = { messages: [], title: title, sender: sender };
    try {
      if (WORKER_API) {
        await putJsonToWorker(key, indexObj);
        await updateConversationsIndexOnWorker(id, title);
      }
    } catch (e) {
      console.warn('createConversation: worker init failed', e);
    }
  }

  // Append message to conversations/<id>/index.json (schema: {messages:[{time,text},...], title, sender})
  // appendMessageToIndex: accepts either a string (text) or an object message {...}
  async function appendMessageToIndex(convId, payload) {
    const key = `conversations/${convId}/index.json`;
    const now = new Date();
    const timeStr = fmtTimeForIndex(now);
    // build entry
    let entry;
    if (typeof payload === 'string') {
      entry = { id: uid(8), time: timeStr, text: payload, sender: deviceName, type: 'text' };
    } else {
      entry = Object.assign({ id: uid(8), time: timeStr, sender: deviceName }, payload);
      if (!entry.type) entry.type = entry.url ? 'file' : 'text';
    }

    try {
      let indexObj = null;
      if (WORKER_API) indexObj = await getJsonFromWorker(key);
      if (!indexObj) {
        const conv = convs.find(c => c.id === convId);
        indexObj = { messages: [], title: conv ? conv.title : convId, sender: mkSender(5) };
      }
      indexObj.messages = indexObj.messages || [];
      indexObj.messages.push(entry);
      if (WORKER_API) {
        await putJsonToWorker(key, indexObj);
      }
      // local mirror
      const convLocal = convs.find(c => c.id === convId);
      if (convLocal) {
        convLocal.messages = convLocal.messages || [];
        convLocal.messages.push(entry);
        saveLocalConvs();
        renderMessages();
      }
      await updateConversationsIndexOnWorker(convId, indexObj.title || convId);
    } catch (e) {
      console.warn('appendMessageToIndex failed', e);
      // fallback local only
      const convLocal = convs.find(c => c.id === convId);
      if (convLocal) {
        convLocal.messages = convLocal.messages || [];
        convLocal.messages.push(entry);
        saveLocalConvs();
        renderMessages();
      }
    }
  }

  // Ensure each message has an id; if added and WORKER_API is set, persist the index.json back.
  async function ensureMessageIdsForConv(conv) {
    if (!conv || !Array.isArray(conv.messages)) return false;
    let changed = false;
    for (const m of conv.messages) {
      if (!m.id) { m.id = uid(8); changed = true; }
    }
    if (changed) {
      saveLocalConvs();
      // try persist to backend index.json if available
      if (WORKER_API) {
        try {
          const key = `conversations/${conv.id}/index.json`;
          // read existing, merge ids to avoid overwriting accidental changes
          const remote = await getJsonFromWorker(key);
          if (remote && Array.isArray(remote.messages)) {
            // apply ids by matching time+text when remote lacks ids
            for (const localMsg of conv.messages) {
              // find remote message by id or by time+text
              let rm = remote.messages.find(r => r.id && r.id === localMsg.id);
              if (!rm) {
                rm = remote.messages.find(r => (!r.id) && String(r.time) === String(localMsg.time) && String(r.text) === String(localMsg.text));
              }
              if (rm && !rm.id && localMsg.id) rm.id = localMsg.id;
            }
            await putJsonToWorker(key, remote);
          } else {
            // remote missing or non-structured, write our conv index
            await putJsonToWorker(`conversations/${conv.id}/index.json`, { messages: conv.messages, title: conv.title, sender: conv.sender || '' });
          }
        } catch (e) {
          console.warn('ensureMessageIdsForConv: backend persist failed', e);
        }
      }
    }
    return changed;
  }

  // delete a single message by id from a conversation (backend + local)
  async function deleteMessage(convId, msgId) {
    if (!convId || !msgId) return;
    if (!confirm('Delete this message?')) return;

    // local-first removal
    const conv = convs.find(c => c.id === convId);
    if (!conv || !Array.isArray(conv.messages)) return;
    const msg = conv.messages.find(m => m.id === msgId) || conv.messages.find(m => String(m.time) === String(msgId));
    const before = conv.messages.length;
    conv.messages = conv.messages.filter(m => m.id !== msgId);
    if (conv.messages.length !== before) {
      saveLocalConvs();
      renderConvs();
      renderMessages();
    }

    // backend sync: remove entry from index.json, then try to delete asset files (best-effort)
    (async () => {
      const key = `conversations/${convId}/index.json`;
      try {
        if (!WORKER_API) return;

        // 1) update index.json on backend: remove by id first, else by time+text
        try {
          const idx = await getJsonFromWorker(key);
          if (idx && Array.isArray(idx.messages)) {
            const origLen = idx.messages.length;
            const newMsgs = idx.messages.filter(r => {
              if (r.id && r.id === msgId) return false;
              if (!r.id && msg) {
                if (String(r.time) === String(msg.time) && String(r.text) === String(msg.text)) return false;
              }
              return true;
            });
            if (newMsgs.length !== origLen) {
              idx.messages = newMsgs;
              await putJsonToWorker(key, idx);
            }
          }
        } catch (e) {
          // index update failed — log as warning but continue to try deleting files
          console.warn('deleteMessage: update index.json failed', e);
        }

        // 2) if this was a file message, attempt to delete asset and its meta file.
        if (msg && msg.type === 'file' && msg.filename) {
          const base = `conversations/${convId}/assets/`;
          const candidates = [];

          // candidate variants: as-is, decoded, encoded, original text, meta variants
          candidates.push(base + msg.filename);
          try { candidates.push(base + decodeURIComponent(msg.filename)); } catch(e){}
          candidates.push(base + encodeURIComponent(msg.filename));
          if (msg.text && msg.text !== msg.filename) candidates.push(base + msg.text);
          // also attempt meta.json variants
          candidates.push(base + msg.filename + '.meta.json');
          candidates.push(base + encodeURIComponent(msg.filename) + '.meta.json');

          // unique and filter
          const uniq = [...new Set(candidates.filter(Boolean))];

          // try each candidate until we get a 200 or 204; treat 404 as "not found" and continue
          let anyDeleted = false;
          for (const candidate of uniq) {
            try {
              const url = new URL('/delete-file', WORKER_API);
              url.searchParams.set('key', candidate);
              const res = await fetch(url.toString(), { method: 'DELETE' });
              if (res.ok) { anyDeleted = true; break; }
              // if 404, continue trying other variants
              if (res.status === 404) {
                // continue
                continue;
              }
              // other errors: log and continue
              console.warn('delete-file attempt returned', res.status, await res.text().catch(()=>''), 'for', candidate);
            } catch (e) {
              // network or other error; don't spam console with stack traces, log minimal
              console.warn('delete-file request error for', candidate, e && e.message ? e.message : e);
            }
          }
          if (!anyDeleted) {
            // nothing deleted on backend; log info (no error thrown)
            console.info('deleteMessage: asset not found/removed on backend for', msg.filename);
          }
        }
      } catch (e) {
        console.warn('deleteMessage backend update failed', e);
      }
    })();
  }

  // Update global conversations/index.json (id,title,updatedAt)
  async function updateConversationsIndexOnWorker(updatedConvId, title) {
    const key = 'conversations/index.json';
    try {
      let list = null;
      if (WORKER_API) list = await getJsonFromWorker(key);
      if (!Array.isArray(list)) list = [];
      const now = Date.now();
      const entry = { id: updatedConvId, title: title || updatedConvId, updatedAt: now };
      const idx = list.findIndex(i => i.id === entry.id);
      if (idx >= 0) list[idx] = entry; else list.unshift(entry);
      if (WORKER_API) {
        await putJsonToWorker(key, list);
      }
      // local ensure convs contains it
      if (!convs.find(c => c.id === entry.id)) {
        convs.unshift({ id: entry.id, title: entry.title, messages: [] });
        saveLocalConvs();
        renderConvs();
      }
    } catch (e) {
      console.warn('updateConversationsIndexOnWorker failed', e);
    }
  }

  async function loadConversationsFromWorker() {
    if (!WORKER_API) return;
    try {
      const list = await listConversationsFromWorker();
      if (!Array.isArray(list) || list.length === 0) return;

      // fetch each conversation's index.json in parallel
      const convsWithMsgs = await Promise.all(list.map(async (it) => {
        const idxKey = `conversations/${it.id}/index.json`;
        try {
          const idx = await getJsonFromWorker(idxKey);
          const messages = (idx && Array.isArray(idx.messages)) ? idx.messages : [];
          return { id: it.id, title: it.title || it.id, messages: messages };
        } catch (err) {
          // if reading index fails, still include conv with empty messages
          console.warn('failed to load index for', it.id, err);
          return { id: it.id, title: it.title || it.id, messages: [] };
        }
      }));

      convs = convsWithMsgs;
      // ensure ids for each conv and persist back to worker if needed
      await Promise.all(convs.map(async c => {
        try { await ensureMessageIdsForConv(c); } catch(e){/*ignore*/ }
      }));
      activeConv = convs[0]?.id || activeConv;
      saveLocalConvs();
      renderConvs();
      renderMessages();
    } catch (e) {
      console.warn('loadConversationsFromWorker failed', e);
    }
  }

  // Sending text: store directly in index.json as {time,text}
  async function sendText(text) {
    if (!text) return;
    await appendMessageToIndex(activeConv, text);
  }

  // Send file: upload file to conversations/<id>/assets/<timestamp>-origname, and store original filename as text in index.json
  async function sendFile(file) {
    if (!file) return;
    const convId = activeConv;
    const tsName = fmtTimestampForFilename(new Date()); // YYYY-MM-DD-HHMMSS
    const safeName = file.name.replace(/\s+/g, '_');
    const filename = `${tsName}-${safeName}`;
    const key = `conversations/${convId}/assets/${filename}`;
    try {
      let publicUrl = null;
      if (WORKER_API) {
        const ret = await uploadToWorker(key, file, file.type || 'application/octet-stream');
        publicUrl = ret && ret.url ? ret.url : null;
      } else {
        // local-server may not be available; no upload => no url
      }
      const meta = { type: 'file', text: file.name, filename, url: publicUrl, size: file.size, sender: deviceName };
      await appendMessageToIndex(convId, meta);
    } catch (e) {
      console.error('sendFile failed', e);
      alert('Upload failed: ' + (e.message || e));
    }
  }

  // --- New functions: export / delete / rename conversation ---
  async function exportConversation(convId) {
    if (!convId) { alert('No conversation selected'); return; }
    try {
      if (WORKER_API) {
        const url = new URL('/export', WORKER_API);
        url.searchParams.set('conv', convId);
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error('export failed: ' + res.status);
        const txt = await res.text();
        const fname = `${convId}.txt`;
        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
        return;
      }
      const conv = convs.find(c => c.id === convId);
      if (!conv) { alert('Conversation not found'); return; }
      const lines = [`Conversation: ${conv.title}`, '---'];
      (conv.messages || []).forEach(m => lines.push(`${m.time || ''}\t${m.text || ''}`));
      const fname = `${conv.title}.txt`;
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error('exportConversation failed', e);
      alert('Export failed: ' + (e.message || e));
    }
  }

  async function deleteConversation(convId) {
    if (!convId) { alert('No conversation selected'); return; }
    if (!confirm('Delete conversation and all files?')) return;
    try {
      if (WORKER_API) {
        const url = new URL('/delete-conversation', WORKER_API);
        url.searchParams.set('id', convId);
        const res = await fetch(url.toString(), { method: 'DELETE' });
        // if backend returns 404 (already removed), ignore and proceed to local cleanup
        if (!res.ok && res.status !== 404) {
          const txt = await res.text().catch(()=>null);
          throw new Error('delete failed: ' + res.status + (txt ? (' - ' + txt) : ''));
        }
      }
      // remove locally regardless of backend result
      const idx = convs.findIndex(c => c.id === convId);
      if (idx >= 0) convs.splice(idx, 1);
      activeConv = convs[0] ? convs[0].id : null;
      saveLocalConvs();
      renderConvs();
      renderMessages();
      // update global index on backend (best-effort)
      try { await updateConversationsIndexOnWorker(null, null); } catch (e) { /* ignore */ }
    } catch (e) {
      console.error('deleteConversation failed', e);
      alert('Delete failed: ' + (e.message || e));
    }
  }

  // Event wiring
  if (newConvBtn) newConvBtn.onclick = () => createConversation();
  if (sendBtn) sendBtn.onclick = () => { const t = msgInput && msgInput.value && msgInput.value.trim(); if (t) { sendText(t); if (msgInput) msgInput.value = ''; } };
  if (msgInput) msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const t = msgInput.value && msgInput.value.trim(); if (t) { sendText(t); msgInput.value = ''; } } });
  if (fileInput) fileInput.onchange = e => { const f = e.target.files && e.target.files[0]; if (f) sendFile(f); fileInput.value = ''; };

  // Paste support (text or files)
  if (msgInput) msgInput.addEventListener('paste', async ev => {
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) await sendFile(f);
      } else if (it.kind === 'string') {
        it.getAsString(async s => { if (s && s.trim()) await sendText(s.trim()); });
      }
    }
  });

  // Theme support (unchanged)
  function applyTheme(t) {
    try {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {}
  }
  (function setupThemeUI() {
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
    if (!document.getElementById('flow-theme-toggle')) {
      const btn = document.createElement('button');
      btn.id = 'flow-theme-toggle';
      btn.title = 'Toggle theme';
      btn.textContent = theme === 'dark' ? '🌙' : '☀️';
      Object.assign(btn.style, {
        position: 'fixed', right: '12px', bottom: '80px', zIndex: 9999,
        padding: '8px 10px', borderRadius: '6px', border: 'none', cursor: 'pointer',
        background: 'rgba(0,0,0,0.35)', color: '#fff'
      });
      btn.onclick = () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        const nxt = cur === 'dark' ? 'light' : 'dark';
        applyTheme(nxt);
        btn.textContent = nxt === 'dark' ? '🌙' : '☀️';
      };
      document.body.appendChild(btn);
    }
  })();

  // Init
  function init() {
    renderConvs();
    renderMessages();
    if (connStatus) connStatus.textContent = WORKER_API ? 'backend' : 'local';
    if (WORKER_API) loadConversationsFromWorker().catch(() => {});
  }

  init();
})();
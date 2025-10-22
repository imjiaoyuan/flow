addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, ''); // trim trailing
  const route = pathname.split('/').pop();

  try {
    if (route === 'upload' && request.method === 'PUT') {
      // PUT /upload?key=convs/...
      const key = url.searchParams.get('key');
      if (!key) return jsonResponse({ error: 'missing key' }, 400);
      const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
      const body = await request.arrayBuffer();
      // CONV_BUCKET binding must be added in wrangler.toml
      await CONV_BUCKET.put(key, body, { httpMetadata: { contentType } });
      // Return a public retrieval endpoint (this worker's GET /get?key=...)
      const publicUrl = new URL(request.url);
      publicUrl.pathname = publicUrl.pathname.replace(/\/upload$/, '/get');
      publicUrl.searchParams.set('key', key);
      return jsonResponse({ url: publicUrl.toString() }, 200);
    }

    if (route === 'get' && request.method === 'GET') {
      // GET /get?key=...
      const key = url.searchParams.get('key');
      if (!key) return jsonResponse({ error: 'missing key' }, 400);
      const obj = await CONV_BUCKET.get(key);
      if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders() });
      const headers = new Headers();
      const ct = obj.httpMetadata && obj.httpMetadata.contentType ? obj.httpMetadata.contentType : 'application/octet-stream';
      headers.set('Content-Type', ct);
      // Expose CORS
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(obj.body, { status: 200, headers });
    }

    if (route === 'json') {
      // GET /json?key=...   -> return JSON
      // PUT /json?key=...   -> write JSON body
      const key = url.searchParams.get('key');
      if (!key) return jsonResponse({ error: 'missing key' }, 400);
      if (request.method === 'GET') {
        const obj = await CONV_BUCKET.get(key);
        if (!obj) return jsonResponse(null, 404);
        const text = await obj.text();
        try {
          const parsed = JSON.parse(text);
          return jsonResponse(parsed, 200);
        } catch (e) {
          return jsonResponse({ error: 'invalid json in storage' }, 500);
        }
      } else if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.text();
        // ensure valid JSON
        try {
          JSON.parse(body);
        } catch (e) {
          return jsonResponse({ error: 'invalid json body' }, 400);
        }
        await CONV_BUCKET.put(key, body, { httpMetadata: { contentType: 'application/json' } });
        return jsonResponse({ ok: true }, 200);
      } else {
        return jsonResponse({ error: 'method not allowed' }, 405);
      }
    }

    if (route === 'list-conversations' && request.method === 'GET') {
      // Read conversations/index.json if exists
      const key = 'conversations/index.json';
      const obj = await CONV_BUCKET.get(key);
      if (!obj) return jsonResponse([], 200);
      try {
        const parsed = JSON.parse(await obj.text());
        return jsonResponse(parsed, 200);
      } catch (e) {
        return jsonResponse([], 200);
      }
    }

    // DELETE /delete-conversation?id=<id>
    if (route === 'delete-conversation' && request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return jsonResponse({ error: 'missing id' }, 400);
      const prefix = `conversations/${id}/`;
      // list and delete
      for await (const obj of CONV_BUCKET.list({ prefix })) {
        await CONV_BUCKET.delete(obj.key);
      }
      return jsonResponse({ ok: true }, 200);
    }

    // POST /rename-conversation  body JSON { oldId, newId }
    if (route === 'rename-conversation' && (request.method === 'POST' || request.method === 'PUT')) {
      try {
        const body = await request.json();
        const { oldId, newId } = body || {};
        if (!oldId || !newId) return jsonResponse({ error: 'missing params' }, 400);
        const oldPrefix = `conversations/${oldId}/`;
        const newPrefix = `conversations/${newId}/`;
        for await (const obj of CONV_BUCKET.list({ prefix: oldPrefix })) {
          const oldKey = obj.key;
          const newKey = newPrefix + oldKey.slice(oldPrefix.length);
          const o = await CONV_BUCKET.get(oldKey);
          if (o) {
            const buf = await o.arrayBuffer();
            await CONV_BUCKET.put(newKey, buf, { httpMetadata: o.httpMetadata });
            await CONV_BUCKET.delete(oldKey);
          }
        }
        return jsonResponse({ ok: true }, 200);
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    // GET /export?conv=<id>  -> returns text/plain
    if (route === 'export' && request.method === 'GET') {
      const id = url.searchParams.get('conv') || url.searchParams.get('key');
      if (!id) return jsonResponse({ error: 'missing conv id' }, 400);
      const idxKey = `conversations/${id}/index.json`;
      const obj = await CONV_BUCKET.get(idxKey);
      if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders() });
      const txt = await obj.text();
      try {
        const idx = JSON.parse(txt);
        const lines = [];
        lines.push(`Conversation: ${idx.title || id}`);
        lines.push(`Sender: ${idx.sender || ''}`);
        lines.push('---');
        (idx.messages || []).forEach(m => lines.push(`${m.time || ''}\t${m.text || ''}`));
        return new Response(lines.join('\n'), { status: 200, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, corsHeaders()) });
      } catch (e) {
        return new Response('invalid index json', { status: 500, headers: corsHeaders() });
      }
    }

    return jsonResponse({ error: 'not found' }, 404);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function jsonResponse(obj, status = 200) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, corsHeaders());
  return new Response(JSON.stringify(obj), { status, headers });
}

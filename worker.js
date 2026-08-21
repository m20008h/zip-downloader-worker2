// ZIP Downloader Worker — fetches files, zips them, uploads to Backblaze B2
// No external dependencies — ZIP implementation is built-in

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // API routes
    if (url.pathname === "/api/download" && request.method === "POST") {
      return await handleDownload(request, env);
    }

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", time: new Date().toISOString() });
    }

    // Serve UI
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleDownload(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return jsonError(400, "Missing 'files' array");
  }
  if (body.files.length > 50) {
    return jsonError(400, "Max 50 files per request");
  }

  // 1. Fetch all files in parallel
  const results = await Promise.allSettled(
    body.files.map((f) => fetchFile(f.url))
  );

  const files = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      const name = body.files[i].name || results[i].value.name;
      files.push({ name, data: results[i].value.data });
    } else {
      errors.push(`Failed: ${body.files[i].url}`);
    }
  }

  if (files.length === 0) {
    return jsonError(502, "All downloads failed", { errors });
  }

  // 2. Create ZIP (STORE mode — no compression, fastest)
  const zipData = createZip(files);

  // 3. Upload to B2
  const zipName = (body.zipName || "download-" + Date.now()) + ".zip";
  const finalZipName = zipName.replace(/\.zip\.zip$/, ".zip");

  try {
    const auth = await b2Authorize(env);
    const upload = await b2GetUploadUrl(env, auth.apiUrl, auth.token);
    const result = await b2Upload(
      upload.uploadUrl,
      upload.token,
      finalZipName,
      zipData
    );

    return Response.json({
      success: true,
      zipName: result.fileName,
      fileId: result.fileId,
      sizeBytes: zipData.byteLength,
      fileCount: files.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return jsonError(502, "B2 upload failed", { error: String(err) });
  }
}

// ── File fetcher ──
async function fetchFile(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const data = new Uint8Array(buffer);
  const name = url.split("/").pop() || "file";
  return { name, data };
}

// ── B2 helpers ──
async function b2Authorize(env) {
  const creds = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
  const resp = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${creds}` },
  });
  if (!resp.ok) throw new Error(`B2 auth failed: ${resp.status}`);
  const data = await resp.json();
  return { apiUrl: data.apiUrl, token: data.authorizationToken };
}

async function b2GetUploadUrl(env, apiUrl, authToken) {
  const resp = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: "POST",
    headers: { Authorization: authToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID }),
  });
  if (!resp.ok) throw new Error(`B2 upload URL failed: ${resp.status}`);
  const data = await resp.json();
  return { uploadUrl: data.uploadUrl, token: data.authorizationToken };
}

async function b2Upload(uploadUrl, authToken, fileName, zipData) {
  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: authToken,
      "X-Bz-File-Name": encodeURIComponent(fileName),
      "Content-Type": "application/zip",
      "X-Bz-Content-Sha1": "do_not_verify",
    },
    body: zipData,
  });
  if (!resp.ok) throw new Error(`B2 upload failed: ${resp.status}`);
  const data = await resp.json();
  return { fileId: data.fileId, fileName: data.fileName };
}

// ── Built-in ZIP creator (STORE mode, no external deps) ──
function createZip(files) {
  // Minimal ZIP writer — local file headers + central directory
  const chunks = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const fileData = file.data;
    const crc = crc32(fileData);

    // Local file header
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(localHeader.buffer);
    dv.setUint32(0, 0x04034b50, true);  // signature
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0, true);           // flags
    dv.setUint16(8, 0, true);           // compression (0=store)
    dv.setUint16(10, 0, true);           // mod time
    dv.setUint16(12, 0, true);           // mod date
    dv.setUint32(14, crc, true);         // CRC-32
    dv.setUint32(18, fileData.byteLength, true);  // compressed size
    dv.setUint32(22, fileData.byteLength, true);  // uncompressed size
    dv.setUint16(26, nameBytes.length, true);     // filename length
    dv.setUint16(28, 0, true);           // extra field length
    localHeader.set(nameBytes, 30);

    // Central directory entry
    const cdEntry = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdEntry.buffer);
    cdv.setUint32(0, 0x02014b50, true);  // signature
    cdv.setUint16(4, 20, true);          // version made by
    cdv.setUint16(6, 20, true);          // version needed
    cdv.setUint16(8, 0, true);           // flags
    cdv.setUint16(10, 0, true);           // compression
    cdv.setUint16(12, 0, true);           // mod time
    cdv.setUint16(14, 0, true);           // mod date
    cdv.setUint32(16, crc, true);         // CRC-32
    cdv.setUint32(20, fileData.byteLength, true);  // compressed size
    cdv.setUint32(24, fileData.byteLength, true);  // uncompressed size
    cdv.setUint16(28, nameBytes.length, true);     // filename length
    cdv.setUint16(30, 0, true);           // extra field length
    cdv.setUint16(32, 0, true);           // comment length
    cdv.setUint16(34, 0, true);           // disk number start
    cdv.setUint16(36, 0, true);           // internal attrs
    cdv.setUint32(38, 0, true);           // external attrs
    cdv.setUint32(42, offset, true);      // offset of local header
    cdEntry.set(nameBytes, 46);

    centralDir.push(cdEntry);
    chunks.push(localHeader);
    chunks.push(fileData);
    offset += localHeader.length + fileData.byteLength;
  }

  // End of central directory
  let cdSize = 0;
  for (const cd of centralDir) cdSize += cd.length;
  const cdOffset = offset;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);   // signature
  edv.setUint16(4, 0, true);             // disk number
  edv.setUint16(6, 0, true);             // disk with CD
  edv.setUint16(8, files.length, true);  // entries on disk
  edv.setUint16(10, files.length, true); // total entries
  edv.setUint32(12, cdSize, true);       // CD size
  edv.setUint32(16, cdOffset, true);      // CD offset
  edv.setUint16(20, 0, true);             // comment length

  chunks.push(...centralDir);
  chunks.push(eocd);

  // Combine all chunks
  let totalSize = 0;
  for (const c of chunks) totalSize += c.length;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const c of chunks) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
}

// ── CRC-32 ──
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crc ^ data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Utils ──
function jsonError(status, message, extra) {
  return Response.json({ success: false, error: message, ...extra }, { status });
}

// ── HTML UI ──
const HTML_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZIP Downloader</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e4e4e7; min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; padding: 2rem 1rem; }
    .container { max-width: 640px; width: 100%; }
    h1 { font-size: 1.5rem; margin-bottom: .5rem; }
    .subtitle { color: #a1a1aa; margin-bottom: 2rem; font-size: .9rem; }
    .file-row { display: flex; gap: .5rem; margin-bottom: .5rem; }
    .file-row input { flex: 1; padding: .6rem .8rem; border-radius: 8px; border: 1px solid #27272a; background: #18181b; color: #e4e4e7; font-size: .9rem; }
    .file-row input:focus { outline: none; border-color: #f97316; }
    .file-row .name-input { max-width: 180px; }
    .btn-remove { background: #27272a; border: none; color: #f87171; width: 38px; border-radius: 8px; cursor: pointer; font-size: 1.1rem; }
    .btn-add, .btn-submit { padding: .7rem 1.2rem; border-radius: 8px; border: none; font-size: .9rem; cursor: pointer; font-weight: 600; }
    .btn-add { background: #27272a; color: #e4e4e7; margin-bottom: 1.5rem; }
    .btn-submit { background: #f97316; color: #fff; width: 100%; }
    .btn-submit:disabled { opacity: .5; cursor: not-allowed; }
    .zip-name-field { padding: .6rem .8rem; border-radius: 8px; border: 1px solid #27272a; background: #18181b; color: #e4e4e7; font-size: .9rem; width: 100%; margin-bottom: 1rem; }
    .label { font-size: .8rem; color: #a1a1aa; margin-bottom: .4rem; }
    #result { margin-top: 1.5rem; padding: 1rem; border-radius: 8px; display: none; font-size: .9rem; line-height: 1.6; }
    .result-success { background: #052e16; border: 1px solid #166534; }
    .result-error { background: #2e0505; border: 1px solid #991b1b; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff3; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; vertical-align: middle; margin-left: .5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>ZIP Downloader</h1>
    <p class="subtitle">Enter file URLs - the system will fetch, zip, and upload to Backblaze B2</p>
    <div id="files"></div>
    <button class="btn-add" onclick="addRow()">+ Add file</button>
    <div class="label">ZIP file name (optional)</div>
    <input class="zip-name-field" id="zipName" placeholder="my-download.zip" />
    <button class="btn-submit" id="submitBtn" onclick="submit()">Zip and upload to B2</button>
    <div id="result"></div>
  </div>
  <script>
    let fc = 0;
    function addRow(u, n) {
      u = u || ''; n = n || ''; fc++;
      var c = document.getElementById('files');
      var r = document.createElement('div');
      r.className = 'file-row'; r.id = 'row-' + fc;
      r.innerHTML = '<input type="url" placeholder="https://example.com/file.pdf" value="' + u + '" /><input type="text" class="name-input" placeholder="name" value="' + n + '" /><button class="btn-remove" onclick="removeRow(' + fc + ')">x</button>';
      c.appendChild(r);
    }
    function removeRow(id) { var e = document.getElementById('row-' + id); if (e) e.remove(); }
    async function submit() {
      var rows = document.querySelectorAll('.file-row');
      var files = [];
      rows.forEach(function(row) {
        var i = row.querySelectorAll('input');
        var u = i[0].value.trim(), n = i[1].value.trim();
        if (u) { var e = { url: u }; if (n) e.name = n; files.push(e); }
      });
      if (!files.length) { show('error', 'Enter at least one file'); return; }
      var zn = document.getElementById('zipName').value.trim();
      var body = { files: files }; if (zn) body.zipName = zn;
      var btn = document.getElementById('submitBtn');
      btn.disabled = true; btn.innerHTML = 'Processing...<span class="spinner"></span>';
      document.getElementById('result').style.display = 'none';
      try {
        var resp = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var data = await resp.json();
        if (data.success) {
          var mb = (data.sizeBytes / 1048576).toFixed(2);
          var h = 'Uploaded!<br><b>File:</b> ' + data.zipName + '<br><b>Size:</b> ' + mb + ' MB<br><b>Files:</b> ' + data.fileCount + '<br><b>File ID:</b> ' + data.fileId;
          if (data.errors) h += '<br><br>Warnings:<br>' + data.errors.join('<br>');
          show('success', h);
        } else { show('error', 'Error: ' + data.error); }
      } catch (err) { show('error', 'Network error: ' + err.message); }
      finally { btn.disabled = false; btn.innerHTML = 'Zip and upload to B2'; }
    }
    function show(t, h) { var e = document.getElementById('result'); e.className = 'result-' + t; e.innerHTML = h; e.style.display = 'block'; }
    addRow(); addRow(); addRow();
  </script>
</body>
</html>`;

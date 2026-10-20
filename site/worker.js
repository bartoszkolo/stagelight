// Serves the site's static files and adds HTTP Range support for the demo's audio.
// Browsers seek in an <audio> element with Range requests, and iOS Safari won't play audio
// without them; static assets alone answer every request with the whole file.
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const range = request.headers.get("range");
    if (res.status !== 200 || !range) return withAcceptRanges(res);

    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const body = await res.arrayBuffer();
    const size = body.byteLength;
    let start, end;
    if (m && m[1] !== "") { start = Number(m[1]); end = m[2] !== "" ? Number(m[2]) : size - 1; }
    else if (m && m[2] !== "") { start = Math.max(0, size - Number(m[2])); end = size - 1; } // "bytes=-500"
    if (!m || start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    const headers = new Headers(res.headers);
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    headers.set("Accept-Ranges", "bytes");
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  },
};

function withAcceptRanges(res) {
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

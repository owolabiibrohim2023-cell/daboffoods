// Shared frontend helper: call a Vercel Serverless endpoint with the
// signed-in user's Firebase ID token. Replaces httpsCallable().
// Lives in lib/ (static) — NOT in api/ — so Vercel serves it as a plain
// static file at /lib/client.js instead of a 404 function route.
async function apiCall(path, body, auth) {
  const token = auth?.currentUser ? await auth.currentUser.getIdToken(true) : "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err && err.name === "AbortError"
      ? "Request timed out. Please try again."
      : "Network error. Please check your connection and try again.";
    throw Object.assign(new Error(msg), { cause: err });
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text().catch(() => "");
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { error: "bad-response", message: `Server returned non-JSON (status ${res.status})` }; }
  }
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

export { apiCall };

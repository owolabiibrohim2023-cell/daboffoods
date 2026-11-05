// Shared frontend helper: call a Vercel Serverless endpoint with the
// signed-in user's Firebase ID token. Replaces httpsCallable().
async function apiCall(path, body, auth) {
  const token = auth?.currentUser ? await auth.currentUser.getIdToken(true) : "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

export { apiCall };

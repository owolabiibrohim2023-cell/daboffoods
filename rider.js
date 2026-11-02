/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — rider.js
   Rider login, availability, assigned jobs, status updates,
   and live GPS sharing (watchPosition → riderLocations/{orderId}).
============================================================ */
import { CONFIG, $, $$, esc, toast, confirmDialog, db, firebaseReady, fmtMoney,
  fmtDateTime, waLink, normalizeNgPhone, isValidEmail, setFieldError } from "./app.js";
import { watchAuth, signInWithEmail, signOutUser, friendlyAuthError, setupPasswordToggles } from "./auth.js";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where,
  onSnapshot, arrayUnion, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

setupPasswordToggles();

let riderUser = null, riderProfile = null, jobsStarted = false, jobs = [];
let trip = null; // { orderId, watchId, lastWrite }
let wakeLock = null;

const initials = n => String(n || "R").split(" ").filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join("") || "R";
const mapsDir = addr => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;
const telHref = p => "tel:" + normalizeNgPhone(p || "");
const waNum = p => normalizeNgPhone(p || "").replace("+", "");

/* ---------- Network indicator ---------- */
function syncNetwork() {
  const b = $("#networkBadge"); if (!b) return;
  const on = navigator.onLine;
  b.className = "badge " + (on ? "badge-green" : "badge-red");
  b.innerHTML = `<i class="fa-solid fa-${on ? "wifi" : "triangle-exclamation"}"></i> ${on ? "Network OK" : "No network"}`;
}
addEventListener("online", syncNetwork); addEventListener("offline", syncNetwork);

/* ---------- Login ---------- */
$("#riderLogin").addEventListener("submit", async e => {
  e.preventDefault();
  const errBox = $("#riderLoginError"); errBox.classList.remove("show");
  const email = $("#riderEmail").value.trim(), pw = $("#riderPassword").value;
  let ok = true;
  if (!isValidEmail(email)) { setFieldError($("#riderEmail"), "Enter the rider email given by the office."); ok = false; } else setFieldError($("#riderEmail"), "");
  if (!pw) { setFieldError($("#riderPassword"), "Enter your password."); ok = false; } else setFieldError($("#riderPassword"), "");
  if (!ok) return;
  const btn = $("#riderLoginBtn"), original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Signing in…`;
  try { await signInWithEmail(email, pw, true); /* watchAuth takes over */ }
  catch (err) { errBox.textContent = friendlyAuthError(err); errBox.classList.add("show"); btn.disabled = false; btn.innerHTML = original; }
});
const doLogout = async () => { await stopTrip(true, true); await signOutUser(); location.reload(); };
$("#riderLogout").addEventListener("click", doLogout);
$("#riderDeniedLogout").addEventListener("click", doLogout);

/* ---------- Auth gate ---------- */
watchAuth(async (user, profile) => {
  $("#riderLoading").classList.add("hidden");
  if (!user) { $("#riderLogin").classList.remove("hidden"); return; }
  $("#riderLogin").classList.add("hidden");
  $("#riderLogout").classList.remove("hidden");

  if (!profile || profile.role !== "rider" || profile.disabled) {
    $("#riderDenied").classList.remove("hidden");
    $("#riderDeniedText").textContent = profile?.disabled
      ? "This rider account has been deactivated. Please contact the DABOFFOODS & LOGISTICS SERVICES office."
      : profile?.role === "admin"
        ? "You are signed in as Admin. Please use the Admin Dashboard to manage riders."
        : "This account is not a rider account. Rider accounts are created by the office.";
    $("#riderHeaderName").textContent = user.email;
    return;
  }

  riderUser = user; riderProfile = profile;
  // Vehicle may also live in riders/{uid}
  try {
    const r = await getDoc(doc(db, "riders", user.uid));
    if (r.exists()) riderProfile = { ...r.data(), ...profile, vehicle: profile.vehicle || r.data().vehicle || "" };
  } catch {}

  const name = riderProfile.fullName || riderProfile.name || user.displayName || "Rider";
  riderProfile.fullName = name;
  $("#riderAvatar").textContent = initials(name);
  $("#riderWelcome").textContent = `Hello, ${name.split(" ")[0]} 👋`;
  $("#riderHeaderName").textContent = name;
  $("#riderMeta").textContent = [riderProfile.phone, riderProfile.vehicle].filter(Boolean).join(" · ") || user.email;
  $("#riderApp").classList.remove("hidden");
  syncNetwork();
  setAvailabilityUI(!!riderProfile.available);

  if (!jobsStarted && db) { jobsStarted = true; listenJobs(user.uid); }
});

/* ---------- Availability ---------- */
function setAvailabilityUI(on) {
  $("#availabilityToggle").checked = on;
  $("#availabilityLabel").innerHTML = on
    ? `<span class="live-dot"></span> You are Online`
    : `You are Offline`;
}
$("#availabilityToggle").addEventListener("change", async e => {
  const on = e.target.checked;
  if (!on && trip) {
    const yes = await confirmDialog("Go offline?", "You are sharing live location for an active trip. Going offline will stop location sharing.", "Go offline & end trip");
    if (!yes) { e.target.checked = true; return; }
    await stopTrip(true);
  }
  setAvailabilityUI(on);
  try {
    const data = { available: on, updatedAt: serverTimestamp() };
    await Promise.allSettled([
      updateDoc(doc(db, "users", riderUser.uid), data),
      setDoc(doc(db, "riders", riderUser.uid), { uid: riderUser.uid, name: riderProfile.fullName, phone: riderProfile.phone || "", email: riderUser.email, vehicle: riderProfile.vehicle || "", ...data }, { merge: true })
    ]);
    toast(on ? "You are now Online. Safe riding!" : "You are now Offline.", "success");
  } catch { toast("Couldn't update availability. Check your network.", "error"); }
});

/* ---------- Jobs ---------- */
function listenJobs(uid) {
  const q = query(collection(db, "orders"), where("riderId", "==", uid));
  onSnapshot(q, snap => {
    jobs = [];
    snap.forEach(d => jobs.push({ orderId: d.id, ...d.data() }));
    const score = o => {
      const t = o.createdAt?.toMillis ? o.createdAt.toMillis() : (o.createdAt?.seconds || 0) * 1000;
      return `${o.pickupDate || ""}` ? t : t; // newest first within groups
    };
    jobs.sort((a, b) => score(b) - score(a));
    renderJobs();
  }, err => {
    console.error(err);
    $("#jobsLoading").innerHTML = `<h3>Couldn't load jobs</h3><p class="muted">Check your network and refresh.</p>`;
  });
}
function codInfo(o) {
  const isCod = o.paymentStatus === "COD" || o.paymentOption === "Cash on delivery";
  if (!isCod || o.paymentStatus === "Paid") return "";
  const amt = o.codAmount ?? o.finalPrice ?? o.estimatedPrice;
  const exact = (o.codAmount != null || o.finalPrice != null);
  return `<p style="background:var(--amber-bg);border-radius:10px;padding:10px 12px" class="small">
    <b><i class="fa-solid fa-money-bill-wave"></i> COLLECT CASH ON DELIVERY: ${fmtMoney(amt)}</b>
    ${exact ? "" : "<br>This is the estimate — confirm the exact amount with the office/customer."}</p>`;
}
function statusBadge(s) {
  return s === "Delivered" ? "badge-green" : s === "Cancelled" ? "badge-red"
    : ["In Transit", "Out for Delivery"].includes(s) ? "badge-orange" : "badge-blue";
}
function jobCard(o, done = false) {
  const idx = CONFIG.statuses.indexOf(o.status);
  const stops = (o.stops && o.stops.length ? o.stops : [{ receiverName: o.receiverName, receiverPhone: o.receiverPhone, dropoffAddress: o.dropoffAddress }]);
  const isSharing = trip?.orderId === o.orderId;
  const nextBtns = ["Picked Up", "In Transit", "Out for Delivery", "Delivered"].map(s => {
    const dis = done || CONFIG.statuses.indexOf(s) <= idx;
    return `<button type="button" class="btn ${s === "Delivered" ? "btn-blue" : "btn-ghost"} btn-sm" data-action="status" data-status="${s}" data-id="${esc(o.orderId)}" ${dis ? "disabled" : ""}>${CONFIG.statuses.indexOf(s) < idx ? "✓ " : ""}${s}</button>`;
  }).join("");
  return `<article class="order-row" ${done ? 'style="opacity:.75"' : ""}>
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div><b style="color:var(--blue-dark);font-size:1.05rem">${esc(o.orderId)}</b>
      <div class="small muted">${esc(o.serviceType || "")} · ${esc(o.packageType || "")} (${esc(o.weightKg || 1)}kg) · Pickup: ${esc(o.pickupDate || "—")} ${esc(o.pickupTime || "")}</div></div>
      <span class="badge ${statusBadge(o.status)}">${esc(o.status)}</span>
    </div>
    ${o.packageDescription ? `<p class="small" style="margin-top:8px"><i class="fa-solid fa-box"></i> ${esc(o.packageDescription)}</p>` : ""}
    ${o.instructions ? `<p class="small" style="background:var(--blue-light);border-radius:10px;padding:9px 12px;margin-top:8px"><b>Instructions:</b> ${esc(o.instructions)}</p>` : ""}
    <div style="display:grid;gap:10px;margin:14px 0">
      <div class="small"><b style="color:var(--blue)">⬤ PICKUP</b> — ${esc(o.senderName || "")}<br>${esc(o.pickupAddress || "")}<br>
        <a class="btn btn-ghost btn-sm" style="margin-top:6px" target="_blank" rel="noopener" href="${mapsDir(o.pickupAddress || "")}"><i class="fa-solid fa-diamond-turn-right"></i> Navigate to pickup</a></div>
      ${stops.map((s, i) => `<div class="small"><b style="color:var(--green)">⬤ DROP-OFF ${stops.length > 1 ? i + 1 : ""}</b> — ${esc(s.receiverName || "")} · ${esc(s.receiverPhone || "")}<br>${esc(s.dropoffAddress || "")}<br>
        <a class="btn btn-ghost btn-sm" style="margin-top:6px" target="_blank" rel="noopener" href="${mapsDir(s.dropoffAddress || "")}"><i class="fa-solid fa-diamond-turn-right"></i> Navigate to drop-off</a></div>`).join("")}
    </div>
    ${codInfo(o)}
    <p class="small muted">Payment: <b>${esc(o.paymentStatus || "Pending")}</b> · ${esc(o.paymentOption || "")} · ${o.finalPrice != null ? fmtMoney(o.finalPrice) + " confirmed" : fmtMoney(o.estimatedPrice) + " estimate"}</p>
    ${done ? "" : `
    <div class="btn-row" style="margin-top:12px">
      <a class="btn btn-blue btn-sm" href="${telHref(o.senderPhone)}"><i class="fa-solid fa-phone"></i> Call customer</a>
      <a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="${waLink(`Hello ${o.senderName || ""}, this is ${riderProfile?.fullName || "your DABOFFOODS & LOGISTICS SERVICES rider"} about shipment ${o.orderId}.`, waNum(o.senderPhone))}"><i class="fa-brands fa-whatsapp"></i> WhatsApp customer</a>
      <a class="btn btn-ghost btn-sm" href="${telHref(o.receiverPhone)}"><i class="fa-solid fa-phone"></i> Call receiver</a>
      <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${waLink(`Hello ${o.receiverName || ""}, this is your DABOFFOODS & LOGISTICS SERVICES rider about shipment ${o.orderId}.`, waNum(o.receiverPhone))}"><i class="fa-brands fa-whatsapp"></i> WhatsApp receiver</a>
    </div>
    <div style="border-top:1px dashed var(--line);margin-top:14px;padding-top:14px">
      ${isSharing
        ? `<button type="button" class="btn btn-danger btn-block" data-action="end" data-id="${esc(o.orderId)}"><i class="fa-solid fa-stop"></i> End trip (stop sharing location)</button>`
        : `<button type="button" class="btn btn-orange btn-block" data-action="start" data-id="${esc(o.orderId)}"><i class="fa-solid fa-satellite-dish"></i> Start trip — share my live location</button>`}
      <p class="small muted" style="margin:12px 0 8px;font-weight:700">UPDATE JOURNEY:</p>
      <div class="btn-row">${nextBtns}</div>
    </div>`}
  </article>`;
}
function renderJobs() {
  const active = jobs.filter(o => !["Delivered", "Cancelled"].includes(o.status));
  const done = jobs.filter(o => ["Delivered", "Cancelled"].includes(o.status));
  $("#activeCount").textContent = active.length;
  $("#jobsLoading").classList.add("hidden");
  $("#jobsEmpty").classList.toggle("hidden", active.length > 0);
  $("#jobsList").innerHTML = active.map(o => jobCard(o)).join("");
  $("#doneList").innerHTML = done.length ? done.map(o => jobCard(o, true)).join("") : `<p class="muted small">Nothing completed yet.</p>`;
}

/* Job buttons (event delegation) */
document.addEventListener("click", async e => {
  const btn = e.target.closest("[data-action]"); if (!btn) return;
  const order = jobs.find(j => j.orderId === btn.dataset.id); if (!order) return;
  if (btn.dataset.action === "start") startTrip(order);
  if (btn.dataset.action === "end") stopTrip(true);
  if (btn.dataset.action === "status") updateStatus(order, btn.dataset.status, btn);
});

async function updateStatus(order, newStatus, btn) {
  if (newStatus === "Delivered") {
    const cod = (order.paymentStatus === "COD" || order.paymentOption === "Cash on delivery") && order.paymentStatus !== "Paid";
    const yes = await confirmDialog("Mark as Delivered?",
      cod ? "Confirm the receiver has the parcel AND you have collected the cash on delivery." : "Confirm the receiver has received the parcel.",
      "Yes, delivered");
    if (!yes) return;
  }
  btn.disabled = true; const original = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>`;
  try {
    if (newStatus === "Delivered" && trip?.orderId === order.orderId) await stopTrip(true, true);
    await updateDoc(doc(db, "orders", order.orderId), {
      status: newStatus,
      statusHistory: arrayUnion({ status: newStatus, at: new Date().toISOString(), note: `Updated by rider ${riderProfile.fullName}` }),
      updatedAt: serverTimestamp()
    });
    if (newStatus === "Delivered") { try { await deleteDoc(doc(db, "riderLocations", order.orderId)); } catch {} }
    toast(`Order ${order.orderId}: ${newStatus}. Customer alert will be sent automatically.`, "success");
  } catch (err) {
    console.error(err);
    toast("Couldn't update status. Check your network and try again.", "error");
    btn.disabled = false; btn.innerHTML = original;
  }
}

/* ---------- Live GPS trip ---------- */
async function startTrip(order) {
  if (!firebaseReady || !db) return toast("Live tracking is not connected yet. Please inform the office.", "error");
  if (!("geolocation" in navigator)) return toast("This phone/browser does not support GPS location sharing.", "error");
  if (trip?.orderId === order.orderId) return;
  if (trip) {
    const yes = await confirmDialog("Switch trip?", `You are already sharing location for ${trip.orderId}. Start sharing for ${order.orderId} instead?`, "Yes, switch");
    if (!yes) return;
    await stopTrip(true, true);
  }
  if (!sessionStorage.getItem("fl_gps_explained")) {
    const yes = await confirmDialog("Share live location?",
      `The customer for shipment ${order.orderId} and the DABOFFOODS & LOGISTICS SERVICES office will see your live location on a map only while this trip is on. Keep this page open — closing it stops sharing. Location is deleted when delivered.`,
      "I understand — start");
    if (!yes) return;
    sessionStorage.setItem("fl_gps_explained", "1");
  }
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}

  const watchId = navigator.geolocation.watchPosition(async pos => {
    const now = Date.now();
    if (trip && now - trip.lastWrite < 5000) return; // write at most every 5s (saves battery/data)
    if (trip) trip.lastWrite = now;
    const { latitude: lat, longitude: lng, speed, heading, accuracy } = pos.coords;
    try {
      await setDoc(doc(db, "riderLocations", order.orderId), {
        orderId: order.orderId, riderId: riderUser.uid, riderName: riderProfile.fullName,
        riderPhone: riderProfile.phone || "", vehicle: riderProfile.vehicle || "",
        lat, lng, speed: speed ?? null, speedKmh: speed != null ? Math.round(speed * 3.6) : null,
        heading: heading ?? null, accuracy: accuracy ?? null,
        active: true, ts: now, updatedAt: serverTimestamp()
      }, { merge: true });
      $("#sharingText").textContent =
        `Order ${order.orderId} · Sent ${new Date(now).toLocaleTimeString("en-NG")} · GPS ±${Math.round(accuracy || 0)}m${speed != null ? " · " + Math.round(speed * 3.6) + " km/h" : ""}`;
    } catch (err) {
      console.warn("Location write failed (will retry):", err);
      $("#sharingText").textContent = `Order ${order.orderId} · Network hiccup — retrying automatically…`;
    }
  }, err => {
    console.error(err);
    stopWatchOnly();
    const msg = err.code === 1
      ? "Location permission was denied. Please allow location for this site in your browser/phone settings, then tap Start trip again. Meanwhile, call the customer with updates."
      : err.code === 3
        ? "GPS timed out. Step outside / check your phone's Location is ON, then try again."
        : "GPS is unavailable right now. Check that phone Location is ON and try again.";
    toast(msg, "error");
    renderJobs();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });

  trip = { orderId: order.orderId, watchId, lastWrite: 0 };
  $("#sharingBanner").classList.remove("hidden");
  $("#sharingText").textContent = `Order ${order.orderId} · Waiting for first GPS fix…`;
  toast("Live location sharing started. Keep this page open", "success");
  renderJobs();
}
function stopWatchOnly() {
  if (trip?.watchId != null) navigator.geolocation?.clearWatch(trip.watchId);
  trip = null;
  try { wakeLock?.release(); } catch {}
  $("#sharingBanner").classList.add("hidden");
}
async function stopTrip(deleteLocation = true, silent = false) {
  const orderId = trip?.orderId;
  stopWatchOnly();
  if (orderId && deleteLocation && db) { try { await deleteDoc(doc(db, "riderLocations", orderId)); } catch {} }
  if (!silent && orderId) toast("Trip ended. Location sharing is OFF.", "success");
  renderJobs();
}
$("#endTripBtn").addEventListener("click", () => stopTrip(true));
addEventListener("pagehide", () => { if (trip?.watchId != null) navigator.geolocation?.clearWatch(trip.watchId); });
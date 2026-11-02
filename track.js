/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — track.js
   Real-time order tracking (onSnapshot) + Leaflet live rider map.
   riderLocations/{orderId} schema (written by rider.js, Part 4):
   { riderId, riderName, lat, lng, speed, heading, accuracy,
     active:true, ts: <millis>, updatedAt: serverTimestamp }
============================================================ */
import { CONFIG, renderChrome, $, esc, toast, db, firebaseReady,
  fmtMoney, fmtDateTime, normalizeNgPhone, waLink, copyText,
  rememberOrderId, recentOrderIds } from "./app.js";
import { doc, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

renderChrome("track.html");

const STATUS_ICONS = {
  "Order Placed": "fa-receipt", "Confirmed": "fa-circle-check", "Picked Up": "fa-hand",
  "In Transit": "fa-truck-fast", "Out for Delivery": "fa-motorcycle", "Delivered": "fa-house-circle-check"
};
const LIVE_STATUSES = ["In Transit", "Out for Delivery"];
const Lagos = [6.5244, 3.3792];

let unsubOrder = null, unsubLoc = null, currentId = "";
let map = null, riderMarker = null, pickupMarker = null, dropMarker = null, routeLine = null;
let mapFitted = false, geocodedFor = "", lastLocTs = 0, lastOrder = null;

/* ---------- Recent order chips ---------- */
function renderRecent() {
  const ids = recentOrderIds();
  $("#recentWrap").classList.toggle("hidden", !ids.length);
  $("#recentChips").innerHTML = ids.map(id => `<button type="button" class="chip" data-id="${esc(id)}">${esc(id)}</button>`).join("");
  $$("#recentChips .chip").forEach(c => c.addEventListener("click", () => startTracking(c.dataset.id)));
}
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
renderRecent();

/* ---------- Search ---------- */
$("#trackForm").addEventListener("submit", e => {
  e.preventDefault();
  const id = $("#orderIdInput").value.trim().toUpperCase();
  if (!id) return toast("Please enter your Order ID.", "error");
  history.replaceState(null, "", "?id=" + encodeURIComponent(id));
  startTracking(id);
});

/* Auto-open shared links: track.html?id=shipment-reference */
const paramId = new URLSearchParams(location.search).get("id");
if (paramId) { $("#orderIdInput").value = paramId.toUpperCase(); startTracking(paramId.toUpperCase()); }

function startTracking(id) {
  if (!firebaseReady || !db) {
    toast("Online tracking is not connected yet. Please WhatsApp us your Order ID and we'll update you immediately.", "error");
    showNotFound(id);
    return;
  }
  unsubOrder?.(); unsubLoc?.();
  currentId = id; mapFitted = false; geocodedFor = ""; lastLocTs = 0;
  $("#orderIdInput").value = id;
  $("#loading").classList.remove("hidden");
  $("#notFound").classList.add("hidden");
  $("#result").classList.add("hidden");

  unsubOrder = onSnapshot(doc(db, "orders", id), snap => {
    $("#loading").classList.add("hidden");
    if (!snap.exists()) { showNotFound(id); return; }
    rememberOrderId(id); renderRecent();
    lastOrder = { orderId: id, ...snap.data() };
    renderOrder(lastOrder);
    manageLocationListener(lastOrder);
  }, err => {
    console.error(err);
    $("#loading").classList.add("hidden");
    toast("Network problem while loading your order. Please check your connection and try again.", "error");
    showNotFound(id);
  });
}

function showNotFound(id) {
  $("#result").classList.add("hidden");
  $("#notFound").classList.remove("hidden");
  $("#notFoundWa").href = waLink(`Hello DABOFFOODS & LOGISTICS SERVICES, I need help tracking a shipment. Tracking number: ${id || "(I don't have it)"}`);
  unsubLoc?.(); hideMapCards();
}

/* ---------- Render order ---------- */
function statusTime(order, status) {
  const hits = (order.statusHistory || []).filter(h => h.status === status);
  return hits.length ? hits[hits.length - 1].at : null;
}
function renderOrder(o) {
  $("#notFound").classList.add("hidden");
  $("#result").classList.remove("hidden");
  $("#rOrderId").textContent = o.orderId;

  const cancelled = o.status === "Cancelled";
  const sb = $("#rStatusBadge");
  sb.textContent = o.status;
  sb.className = "badge " + (cancelled ? "badge-red" : o.status === "Delivered" ? "badge-green" : "badge-blue");
  const pb = $("#rPayBadge");
  pb.textContent = "Payment: " + (o.paymentStatus || "Pending");
  pb.className = "badge " + (o.paymentStatus === "Paid" ? "badge-green" : o.paymentStatus === "COD" ? "badge-orange" : "badge-amber");

  const cb = $("#cancelledBanner");
  cb.classList.toggle("show", cancelled);
  if (cancelled) cb.innerHTML = `<b>This order was cancelled.</b> If this is a mistake or you paid already, please WhatsApp us right away and we'll sort it out.`;

  /* Timeline */
  const idx = CONFIG.statuses.indexOf(o.status);
  $("#timeline").innerHTML = CONFIG.statuses.map((s, i) => {
    const done = !cancelled && i < idx, current = !cancelled && i === idx;
    const at = statusTime(o, s);
    return `<li class="${done ? "done" : current ? "current" : ""}">
      <span class="t-dot"><i class="fa-solid ${done ? "fa-check" : STATUS_ICONS[s] || "fa-circle"}"></i></span>
      <div class="t-body"><b>${s}${current ? ' <span class="badge badge-orange">Now</span>' : ""}</b>
      <span>${at ? fmtDateTime(at) : done || current ? "" : "Pending"}</span></div></li>`;
  }).join("");

  /* Rider contact card */
  const hasRider = !!(o.riderName && o.riderPhone);
  $("#riderCard").classList.toggle("hidden", !hasRider || cancelled || o.status === "Delivered");
  if (hasRider) {
    $("#riderName").textContent = o.riderName;
    $("#riderPhoneText").textContent = "· " + o.riderPhone;
    $("#callRider").href = "tel:" + normalizeNgPhone(o.riderPhone);
    $("#waRider").href = waLink(
      `Hello ${o.riderName}, I'm contacting you about my DABOFFOODS & LOGISTICS SERVICES shipment (${o.orderId}).`,
      normalizeNgPhone(o.riderPhone).replace("+", ""));
    $("#mapRiderName").textContent = o.riderName;
  }

  /* Details */
  const price = o.finalPrice != null
    ? `${fmtMoney(o.finalPrice)} (confirmed)`
    : `${fmtMoney(o.estimatedPrice)} (estimate — final price confirmed on WhatsApp)`;
  const kv = [
    ["Sender", `${o.senderName || "—"} · ${o.senderPhone || ""}`],
    ["Pickup", o.pickupAddress || "—"],
    ["Receiver", `${o.receiverName || "—"} · ${o.receiverPhone || ""}`],
    ["Drop-off", o.dropoffAddress || "—"],
    ["Package", `${o.packageType || "—"}${o.packageDescription ? " — " + o.packageDescription : ""} (${o.weightKg || 1}kg)`],
    ["Service", `${o.serviceType || "—"}${o.zone ? " · " + o.zone : ""}`],
    ["Pickup date", `${o.pickupDate || "—"} ${o.pickupTime || ""}`],
    ["Price", price],
    ["Payment option", o.paymentOption || "—"],
    ["Booked on", fmtDateTime(o.createdAt)]
  ];
  $("#rDetails").innerHTML = kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");

  /* Extra stops (bulk orders) */
  const extras = (o.stops || []).slice(1);
  $("#rStops").innerHTML = extras.length ? `
    <h4 style="color:var(--blue-dark);margin-bottom:8px">Extra drop-offs (${extras.length})</h4>
    ${extras.map((s, i) => `<p class="small" style="padding:8px 0;border-bottom:1px dashed var(--line)">
      <b>${i + 2}.</b> ${esc(s.receiverName)} · ${esc(s.receiverPhone)}<br><span class="muted">${esc(s.dropoffAddress)}</span></p>`).join("")}` : "";

  $("#helpWa").href = waLink(`Hello DABOFFOODS & LOGISTICS SERVICES, I need help with shipment ${o.orderId} (currently: ${o.status}).`);
  $("#shareBtn").onclick = async () => {
    const url = new URL(`track.html?id=${o.orderId}`, location.href).href;
    const text = `Track my DABOFFOODS & LOGISTICS SERVICES shipment (${o.orderId}) here: ${url}`;
    if (navigator.share) { try { await navigator.share({ title: "DABOFFOODS Shipment Tracking", text, url }); } catch {} }
    else copyText(url, "Tracking link copied — send it to your receiver!");
  };

  /* Map visibility rules */
  if (!LIVE_STATUSES.includes(o.status)) { hideMapCards(); unsubLoc?.(); }
}

/* ---------- Live location listener + Leaflet map ---------- */
function hideMapCards() {
  $("#mapCard").classList.add("hidden");
  $("#mapWaiting").classList.add("hidden");
}
function manageLocationListener(o) {
  if (!LIVE_STATUSES.includes(o.status)) return;
  if (unsubLoc) return; // already listening for this order
  unsubLoc = onSnapshot(doc(db, "riderLocations", o.orderId), snap => {
    const fresh = snap.exists() && snap.data().active && (Date.now() - (snap.data().ts || 0) < 5 * 60 * 1000);
    if (!fresh) {
      $("#mapCard").classList.add("hidden");
      $("#mapWaiting").classList.toggle("hidden", !(lastOrder && LIVE_STATUSES.includes(lastOrder.status)));
      return;
    }
    const loc = snap.data();
    lastLocTs = loc.ts || Date.now();
    $("#mapWaiting").classList.add("hidden");
    $("#mapCard").classList.remove("hidden");
    showOnMap(loc, lastOrder);
  }, () => { /* no permission/no doc → timeline still works */ hideMapCards(); });
}

function pinIcon(cls, icon) {
  return L.divIcon({ className: "", html: `<div class="fl-pin ${cls}"><i class="fa-solid ${icon}"></i></div>`,
    iconSize: [38, 38], iconAnchor: [19, 36] });
}
async function geocode(address) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address + ", Nigeria")}`);
    const j = await r.json();
    return j.length ? [Number(j[0].lat), Number(j[0].lon)] : null;
  } catch { return null; } // map still works with rider marker alone
}
async function showOnMap(loc, order) {
  if (!map) {
    map = L.map("map").setView(Lagos, 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 60); // fixes grey tiles when un-hidden
  const riderPos = [loc.lat, loc.lng];
  if (!riderMarker) {
    riderMarker = L.marker(riderPos, { icon: pinIcon("rider", "fa-motorcycle") }).addTo(map)
      .bindPopup(`<b>${esc(loc.riderName || "Your rider")}</b><br>Delivering order ${esc(order.orderId)}`);
  } else riderMarker.setLatLng(riderPos);

  /* Pickup / drop-off markers: use saved coords if present, else best-effort geocode once */
  if (order && geocodedFor !== order.orderId) {
    geocodedFor = order.orderId;
    const p = order.pickupLat ? [order.pickupLat, order.pickupLng] : await geocode(order.pickupAddress || "");
    const d = order.dropoffLat ? [order.dropoffLat, order.dropoffLng] : await geocode(order.dropoffAddress || "");
    if (p) { pickupMarker?.remove(); pickupMarker = L.marker(p, { icon: pinIcon("pickup", "fa-box") }).addTo(map).bindPopup("<b>Pickup</b><br>" + esc(order.pickupAddress)); }
    if (d) { dropMarker?.remove(); dropMarker = L.marker(d, { icon: pinIcon("drop", "fa-house") }).addTo(map).bindPopup("<b>Drop-off</b><br>" + esc(order.dropoffAddress)); }
  }
  const pts = [riderPos];
  if (pickupMarker) pts.unshift(pickupMarker.getLatLng());
  if (dropMarker) pts.push(dropMarker.getLatLng());
  routeLine?.remove();
  if (pts.length > 1) routeLine = L.polyline(pts, { color: "#0B3D91", weight: 4, dashArray: "8 8", opacity: .65 }).addTo(map);
  if (!mapFitted) { map.fitBounds(L.latLngBounds(pts).pad(0.25)); mapFitted = true; }
  else map.panTo(riderPos, { animate: true });
}

/* "Last updated X seconds ago" */
setInterval(() => {
  if (!lastLocTs || $("#mapCard").classList.contains("hidden")) return;
  const s = Math.max(0, Math.round((Date.now() - lastLocTs) / 1000));
  $("#mapUpdated").innerHTML = `<span class="live-dot"></span> Last updated ${s < 5 ? "just now" : s < 60 ? s + "s ago" : Math.round(s / 60) + " min ago"}`;
}, 1000);
/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — track.js
   Real-time order tracking (onSnapshot) + Leaflet live rider map.
   riderLocations/{orderId} schema (written by rider.js, Part 4):
   { riderId, riderName, lat, lng, speed, heading, accuracy,
     active:true, ts: <millis>, updatedAt: serverTimestamp }
============================================================ */
import { CONFIG, renderChrome, $, esc, toast, db, auth, firebaseReady,
  fmtDateTime, normalizeNgPhone, waLink, copyText,
  rememberOrderId, recentOrderIds } from "./app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

renderChrome("track.html");

const STATUS_ICONS = {
  "Order Placed": "fa-receipt", "Shipment Registered": "fa-box", "Awaiting Pickup": "fa-clock",
  "Confirmed": "fa-circle-check", "Picked Up": "fa-hand", "In Transit": "fa-truck-fast",
  "Customs Clearance": "fa-file-circle-check", "Out for Delivery": "fa-motorcycle",
  "Delivered": "fa-house-circle-check", "Delivery Attempted": "fa-triangle-exclamation",
  "Exception": "fa-circle-exclamation", "On Hold": "fa-pause", "Returned": "fa-rotate-left"
};
const LIVE_STATUSES = ["Picked Up", "In Transit", "Out for Delivery"];
const Lagos = [6.5244, 3.3792];

const functions = getFunctions();
let currentId = "", currentShipment = null, signedInUser = null;
let map = null, riderMarker = null;
let mapFitted = false, lastLocTs = 0;

onAuthStateChanged(auth, user => {
  signedInUser = user;
  const refresh = $("#refreshUpsTracking");
  if (refresh) refresh.classList.toggle("hidden", !user || currentShipment?.carrier !== "UPS");
});

/* ---------- Recent order chips ---------- */
function renderRecent() {
  const ids = recentOrderIds();
  $("#recentWrap").classList.toggle("hidden", !ids.length);
  $("#recentChips").innerHTML = ids.map(id => `<button type="button" class="chip" data-id="${esc(id)}">${esc(id)}</button>`).join("");
  $$("#recentChips .chip").forEach(c => c.addEventListener("click", () => startTracking(c.dataset.id)));
}
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
renderRecent();

$("#refreshUpsTracking").addEventListener("click", async () => {
  if (!signedInUser || !currentShipment?.shipmentId || currentShipment.carrier !== "UPS") return;
  const button = $("#refreshUpsTracking"), original = button.innerHTML;
  button.disabled = true; button.innerHTML = `<span class="spinner"></span> Refreshing UPS…`;
  try {
    const refresh = httpsCallable(functions, "trackUpsShipment");
    await refresh({ shipmentId: currentShipment.shipmentId });
    const lookup = httpsCallable(functions, "lookupShipment");
    const result = await lookup({ trackingNumber: currentShipment.trackingNumber });
    currentShipment = result.data;
    renderShipment(currentShipment);
    toast("UPS tracking information refreshed.", "success");
  } catch (error) {
    toast(error.message || "UPS tracking refresh is unavailable.", "error");
  } finally { button.disabled = false; button.innerHTML = original; }
});

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

async function startTracking(id) {
  if (!firebaseReady || !db) {
    toast("Online tracking is not connected yet. Please WhatsApp us your Order ID and we'll update you immediately.", "error");
    showNotFound(id);
    return;
  }
  currentId = id; mapFitted = false; lastLocTs = 0;
  $("#orderIdInput").value = id;
  $("#loading").classList.remove("hidden");
  $("#notFound").classList.add("hidden");
  $("#result").classList.add("hidden");
  try {
    const lookup = httpsCallable(functions, "lookupShipment");
    const response = await lookup({ trackingNumber: id });
    $("#loading").classList.add("hidden");
    currentShipment = response.data;
    rememberOrderId(id); renderRecent();
    renderShipment(currentShipment);
  } catch (err) {
    console.error(err);
    $("#loading").classList.add("hidden");
    const message = err.code === "functions/resource-exhausted"
      ? "Too many tracking requests. Please wait a minute and try again."
      : err.message || "Tracking is temporarily unavailable. Please try again.";
    toast(message, "error");
    showNotFound(id, message);
  }
}

function showNotFound(id, message = "We couldn't find a shipment with that tracking number. Please check it and try again.") {
  $("#result").classList.add("hidden");
  $("#notFound").classList.remove("hidden");
  $("#notFoundMessage").textContent = message;
  $("#notFoundWa").href = waLink(`Hello DABOFFOODS & LOGISTICS SERVICES, I need help tracking a shipment. Tracking number: ${id || "(I don't have it)"}`);
  hideMapCards();
}

/* ---------- Render sanitized shipment result ---------- */
function renderShipment(o) {
  $("#notFound").classList.add("hidden");
  $("#result").classList.remove("hidden");
  $("#rOrderId").textContent = o.trackingNumber || o.orderId || currentId;

  const status = o.shipmentStatus || "Shipment Registered";
  $("#refreshUpsTracking").classList.toggle("hidden", !signedInUser || o.carrier !== "UPS");
  const cancelled = status === "Cancelled";
  const sb = $("#rStatusBadge");
  sb.textContent = status;
  sb.className = "badge " + (cancelled || status === "Exception" ? "badge-red" : status === "Delivered" ? "badge-green" : ["In Transit", "Out for Delivery"].includes(status) ? "badge-orange" : "badge-blue");
  const pb = $("#rPayBadge");
  pb.textContent = o.carrier || "Shipment tracking";
  pb.className = "badge badge-blue";

  const cb = $("#cancelledBanner");
  cb.classList.toggle("show", cancelled);
  if (cancelled) cb.innerHTML = `<b>This order was cancelled.</b> If this is a mistake or you paid already, please WhatsApp us right away and we'll sort it out.`;

  /* Timeline */
  const events = Array.isArray(o.events) ? [...o.events].sort((a, b) => new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0)) : [];
  if (!events.length) events.push({ status, description: o.latestUpdate || status, occurredAt: o.updatedAt || o.createdAt || null });
  $("#timeline").innerHTML = events.map((event, index) => {
    const current = index === events.length - 1;
    return `<li class="${current ? "current" : "done"}">
      <span class="t-dot"><i class="fa-solid ${STATUS_ICONS[event.status] || "fa-circle"}"></i></span>
      <div class="t-body"><b>${esc(event.status || "Shipment update")}${current ? ' <span class="badge badge-orange">Latest</span>' : ""}</b>
      <span>${esc(event.description || "")}${event.location ? ` · ${esc(event.location)}` : ""}</span>
      <span>${event.occurredAt ? fmtDateTime(event.occurredAt) : ""}</span></div></li>`;
  }).join("");

  /* Rider contact card */
  $("#riderCard").classList.add("hidden");

  const kv = [
    ["Carrier", o.carrier || "Not assigned"], ["Tracking number", o.trackingNumber || o.orderId || currentId],
    ["Shipment status", status], ["Origin", o.origin || "Not provided"], ["Destination", o.destination || "Not provided"],
    ["Shipment registered", o.createdAt ? fmtDateTime(o.createdAt) : "Not provided"],
    ["Estimated delivery", o.estimatedDelivery ? fmtDateTime(o.estimatedDelivery) : "Not available"],
    ["Latest update", o.latestUpdate || (events.at(-1)?.description || status)]
  ];
  $("#rDetails").innerHTML = kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");

  $("#rStops").innerHTML = "";

  $("#helpWa").href = waLink(`Hello DABOFFOODS & LOGISTICS SERVICES, I need help with shipment ${o.trackingNumber || o.orderId || currentId} (currently: ${status}).`);
  $("#shareBtn").onclick = async () => {
    const url = new URL(`track.html?id=${encodeURIComponent(o.trackingNumber || o.orderId || currentId)}`, location.href).href;
    const text = `Track my DABOFFOODS & LOGISTICS SERVICES shipment (${o.trackingNumber || o.orderId || currentId}) here: ${url}`;
    if (navigator.share) { try { await navigator.share({ title: "DABOFFOODS Shipment Tracking", text, url }); } catch {} }
    else copyText(url, "Tracking link copied — send it to your receiver!");
  };

  /* Map visibility rules */
  const location = o.liveLocation;
  const fresh = location?.active && location.lat != null && location.lng != null && Date.now() - location.ts < 5 * 60 * 1000;
  if (fresh && LIVE_STATUSES.includes(status)) {
    lastLocTs = location.ts || Date.now();
    $("#mapWaiting").classList.add("hidden");
    $("#mapCard").classList.remove("hidden");
    $("#mapRiderName").textContent = location.riderName || "Your rider";
    showOnMap(location, o);
  } else {
    $("#mapCard").classList.add("hidden");
    $("#mapWaiting").classList.toggle("hidden", !LIVE_STATUSES.includes(status));
  }
}

function hideMapCards() { $("#mapCard").classList.add("hidden"); $("#mapWaiting").classList.add("hidden"); }

function pinIcon(cls, icon) {
  return L.divIcon({ className: "", html: `<div class="fl-pin ${cls}"><i class="fa-solid ${icon}"></i></div>`,
    iconSize: [38, 38], iconAnchor: [19, 36] });
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

  const pts = [riderPos];
  if (!mapFitted) { map.fitBounds(L.latLngBounds(pts).pad(0.25)); mapFitted = true; }
  else map.panTo(riderPos, { animate: true });
}

/* "Last updated X seconds ago" */
setInterval(() => {
  if (!lastLocTs || $("#mapCard").classList.contains("hidden")) return;
  const s = Math.max(0, Math.round((Date.now() - lastLocTs) / 1000));
  $("#mapUpdated").innerHTML = `<span class="live-dot"></span> Last updated ${s < 5 ? "just now" : s < 60 ? s + "s ago" : Math.round(s / 60) + " min ago"}`;
}, 1000);

/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — track.js
   1) Carrier tracking: the customer is sent to the carrier's OFFICIAL
      tracking page (DHL, FedEx, Aramex, UPS). Nothing from those sites
      is copied into our database.
   2) Our own shipments (DAB-XXXXX or a registered carrier number):
      recorded status updates via /api/shipment/lookup + live rider map.
   riderLocations/{orderId} schema (written by rider.js):
   { riderId, riderName, lat, lng, speed, heading, accuracy,
     active:true, ts: <millis>, updatedAt: serverTimestamp }
============================================================ */
import { renderChrome, $, esc, toast, db, auth, firebaseReady,
  fmtDateTime, copyText, rememberOrderId, recentOrderIds } from "./app.js";
import { apiCall } from "./lib/client.js";

renderChrome("track.html");

/* ---------- External carriers (official tracking pages) ---------- */
const CARRIERS = {
  DHL:    { name: "DHL",    url: n => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}&submit=1` },
  FedEx:  { name: "FedEx",  url: n => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  Aramex: { name: "Aramex", url: n => `https://www.aramex.com/track/track-results-new?ShipmentNumber=${encodeURIComponent(n)}` },
  UPS:    { name: "UPS",    url: n => `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(n)}` }
};

const STATUS_ICONS = {
  "Order Placed": "fa-receipt", "Shipment Registered": "fa-box", "Awaiting Pickup": "fa-clock",
  "Confirmed": "fa-circle-check", "Picked Up": "fa-hand", "In Transit": "fa-truck-fast",
  "Customs Clearance": "fa-file-circle-check", "Out for Delivery": "fa-motorcycle",
  "Delivered": "fa-house-circle-check", "Delivery Attempted": "fa-triangle-exclamation",
  "Exception": "fa-circle-exclamation", "On Hold": "fa-pause", "Returned": "fa-rotate-left"
};
const LIVE_STATUSES = ["Picked Up", "In Transit", "Out for Delivery"];
const Lagos = [6.5244, 3.3792];

let currentId = "", currentShipment = null;
let map = null, riderMarker = null;
let mapFitted = false, lastLocTs = 0;

/* ---------- Recent tracking number chips ---------- */
function renderRecent() {
  const ids = recentOrderIds();
  $("#recentWrap").classList.toggle("hidden", !ids.length);
  $("#recentChips").innerHTML = ids.map(id => `<button type="button" class="chip" data-id="${esc(id)}">${esc(id)}</button>`).join("");
  $$("#recentChips .chip").forEach(c => c.addEventListener("click", () => {
    $("#carrierSelect").value = "";
    startTracking(c.dataset.id);
  }));
}
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
renderRecent();

/* ---------- Search ---------- */
$("#trackForm").addEventListener("submit", e => {
  e.preventDefault();
  const number = $("#orderIdInput").value.replace(/\s+/g, "").toUpperCase();
  const carrier = $("#carrierSelect").value;
  if (!number) return toast("Please enter your tracking number.", "error");
  if (!/^[A-Z0-9-]{5,40}$/.test(number)) return toast("Tracking numbers contain only letters, numbers and hyphens.", "error");
  if (carrier) { redirectToCarrier(carrier, number); return; }
  history.replaceState(null, "", "?id=" + encodeURIComponent(number));
  startTracking(number);
});

function redirectToCarrier(key, number) {
  const carrier = CARRIERS[key];
  if (!carrier) return;
  const url = carrier.url(number);
  $("#loading").classList.add("hidden");
  $("#notFound").classList.add("hidden");
  $("#result").classList.add("hidden");
  hideMapCards();
  $("#redirectText").textContent = `Taking you to ${carrier.name}'s official tracking page…`;
  $("#redirectLink").href = url;
  $("#redirectLink").textContent = `Open ${carrier.name} tracking`;
  $("#redirectCard").classList.remove("hidden");
  location.assign(url);
}

/* Auto-open shared links: track.html?id=tracking-number */
const paramId = new URLSearchParams(location.search).get("id");
if (paramId) { $("#orderIdInput").value = paramId.toUpperCase(); startTracking(paramId.toUpperCase()); }

async function startTracking(id) {
  if (!firebaseReady || !db) {
    toast("Online tracking is not connected yet. Please try again in a moment or contact support.", "error");
    showNotFound(id);
    return;
  }
  currentId = id; mapFitted = false; lastLocTs = 0;
  $("#orderIdInput").value = id;
  $("#loading").classList.remove("hidden");
  $("#notFound").classList.add("hidden");
  $("#redirectCard").classList.add("hidden");
  $("#result").classList.add("hidden");
  try {
    const response = await apiCall("/api/shipment/lookup", { trackingNumber: id }, auth);
    $("#loading").classList.add("hidden");
    currentShipment = response;
    rememberOrderId(id); renderRecent();
    renderShipment(currentShipment);
  } catch (err) {
    console.error(err);
    $("#loading").classList.add("hidden");
    const raw = err.message || "";
    if (/Too many tracking/i.test(raw)) {
      toast("Too many tracking requests. Please wait a minute and try again.", "error");
      showNotFound(id, "Too many tracking requests. Please wait a minute and try again.");
    } else if (/not found/i.test(raw)) {
      showNotFound(id, "We couldn't find this number in our system. If it is a DHL, FedEx, Aramex or UPS number, use a button below, or pick the carrier above and press Track.");
    } else {
      toast(raw || "Tracking is temporarily unavailable. Please try again.", "error");
      showNotFound(id, raw || "Tracking is temporarily unavailable. Please try again.");
    }
  }
}

function showNotFound(id, message = "We couldn't find a shipment with that tracking number. Please check it and try again.") {
  $("#result").classList.add("hidden");
  $("#redirectCard").classList.add("hidden");
  $("#notFound").classList.remove("hidden");
  $("#notFoundMessage").textContent = message;
  const canOfferCarriers = /^[A-Z0-9-]{5,40}$/.test(id || "") && !/^DAB-/.test(id || "");
  $("#carrierButtons").innerHTML = canOfferCarriers
    ? Object.values(CARRIERS).map(c => `<a class="btn btn-outline btn-sm" href="${esc(c.url(id))}" target="_blank" rel="noopener noreferrer">Track on ${esc(c.name)}</a>`).join("")
    : "";
  hideMapCards();
}

/* ---------- Render sanitized shipment result ---------- */
function renderShipment(o) {
  $("#notFound").classList.add("hidden");
  $("#redirectCard").classList.add("hidden");
  $("#result").classList.remove("hidden");
  $("#rOrderId").textContent = o.trackingNumber || o.orderId || currentId;

  const status = o.shipmentStatus || "Shipment Registered";
  const cancelled = status === "Cancelled";
  const sb = $("#rStatusBadge");
  sb.textContent = status;
  sb.className = "badge " + (cancelled || status === "Exception" ? "badge-red" : status === "Delivered" ? "badge-green" : ["In Transit", "Out for Delivery"].includes(status) ? "badge-orange" : "badge-blue");
  const pb = $("#rPayBadge");
  pb.textContent = o.carrier || "Shipment tracking";
  pb.className = "badge badge-blue";

  const cb = $("#cancelledBanner");
  cb.classList.toggle("show", cancelled);
  if (cancelled) cb.innerHTML = `<b>This order was cancelled.</b> If this is a mistake or you paid already, please contact support and we'll sort it out.`;

  /* Link to the carrier's official page (not an automatic sync) */
  const carrier = CARRIERS[o.carrier];
  const carrierLink = $("#carrierLink");
  if (carrier && o.trackingNumber) {
    carrierLink.href = carrier.url(o.trackingNumber);
    carrierLink.innerHTML = `<i class="fa-solid fa-arrow-up-right-from-square"></i> Track on ${esc(carrier.name)}'s website`;
    carrierLink.classList.remove("hidden");
    $("#carrierNote").textContent = `Status updates on this page are recorded by our team. For ${carrier.name}'s own latest scan information, use the button above to open ${carrier.name}'s official tracking page.`;
  } else {
    carrierLink.classList.add("hidden");
    $("#carrierNote").textContent = "Status updates on this page are recorded by our team.";
  }

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

  $("#shareBtn").onclick = async () => {
    const url = new URL(`track.html?id=${encodeURIComponent(o.trackingNumber || o.orderId || currentId)}`, location.href).href;
    const text = `Track my DABOFFOODS & LOGISTICS SERVICES shipment (${o.trackingNumber || o.orderId || currentId}) here: ${url}`;
    if (navigator.share) { try { await navigator.share({ title: "DABOFFOODS Shipment Tracking", text, url }); } catch {} }
    else copyText(url, "Tracking link copied — send it to your receiver!");
  };

  /* Map visibility rules */
  const live = o.liveLocation;
  const fresh = live?.active && live.lat != null && live.lng != null && Date.now() - live.ts < 5 * 60 * 1000;
  if (fresh && LIVE_STATUSES.includes(status)) {
    lastLocTs = live.ts || Date.now();
    $("#mapWaiting").classList.add("hidden");
    $("#mapCard").classList.remove("hidden");
    $("#mapRiderName").textContent = live.riderName || "Your rider";
    showOnMap(live, o);
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
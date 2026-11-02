/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — admin.js
   Admin gate, real-time orders/customers/riders/alerts/inbox,
   order management, printable waybill, live riders map, CSV.
============================================================ */
import { CONFIG, $, $$, esc, toast, confirmDialog, db, firebaseReady, fmtMoney,
  fmtDateTime, waLink, normalizeNgPhone, isValidNgPhone, isValidEmail,
  genOrderId, setFieldError } from "./app.js";
import { watchAuth, signInWithEmail, signOutUser, friendlyAuthError, setupPasswordToggles } from "./auth.js";
import { getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth as getAuthFor, createUserWithEmailAndPassword, signOut as signOutAuth }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot,
  arrayUnion, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

setupPasswordToggles();

const S = { orders: [], users: [], alerts: [], messages: [], apps: [], locs: [],
  current: null, customerUid: "", customerLabel: "", started: false, map: null, markers: {} };
const ALL_STATUSES = [...CONFIG.statuses, "Cancelled"];
const millis = ts => ts?.toMillis ? ts.toMillis() : ts?.seconds ? ts.seconds * 1000 : ts ? new Date(ts).getTime() || 0 : 0;
const dateKey = ts => millis(ts) ? new Date(millis(ts)).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }) : "";
const liveLink = id => location.protocol.startsWith("http") ? new URL(`track.html?id=${id}`, location.href).href : `${CONFIG.siteUrl}/track.html?id=${id}`;
const badgeCls = s => s === "Delivered" ? "badge-green" : s === "Cancelled" ? "badge-red" : ["In Transit", "Out for Delivery"].includes(s) ? "badge-orange" : "badge-blue";
const riders = () => S.users.filter(u => u.role === "rider");
const customers = () => S.users.filter(u => u.role === "customer");

/* ---------------- Login / gate ---------------- */
$("#adminLogin").addEventListener("submit", async e => {
  e.preventDefault();
  const box = $("#adminLoginError"); box.classList.remove("show");
  const email = $("#aEmail").value.trim(), pw = $("#aPassword").value;
  if (!isValidEmail(email)) { setFieldError($("#aEmail"), "Enter a valid admin email."); return; } setFieldError($("#aEmail"), "");
  if (!pw) { setFieldError($("#aPassword"), "Enter your password."); return; } setFieldError($("#aPassword"), "");
  const b = $("#adminLoginBtn"), o = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> Signing in…`;
  try { await signInWithEmail(email, pw, true); }
  catch (err) { box.textContent = friendlyAuthError(err); box.classList.add("show"); b.disabled = false; b.innerHTML = o; }
});
const logout = async () => { await signOutUser(); location.reload(); };
$("#adminLogout").addEventListener("click", logout);
$("#adminDeniedLogout").addEventListener("click", logout);

watchAuth((user, profile) => {
  $("#adminLoading").classList.add("hidden");
  if (!user) { $("#adminLogin").classList.remove("hidden"); return; }
  $("#adminLogin").classList.add("hidden");
  $("#adminLogout").classList.remove("hidden");
  if (!profile || profile.role !== "admin" || profile.disabled) { $("#adminDenied").classList.remove("hidden"); return; }
  $("#adminName").classList.remove("hidden");
  $("#adminName").textContent = profile.fullName || user.email;
  $("#adminApp").classList.remove("hidden");
  if (!S.started && db) { S.started = true; initAdmin(); }
});

/* ---------------- Init ---------------- */
function fillSelect(el, items, allLabel) {
  el.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : "") + items.map(i => `<option>${i}</option>`).join("");
}
function initAdmin() {
  fillSelect($("#fStatus"), ALL_STATUSES, "All statuses");
  fillSelect($("#fPayment"), CONFIG.paymentStatuses, "All payments");
  fillSelect($("#fService"), CONFIG.services, "All services");
  fillSelect($("#dStatus"), ALL_STATUSES); fillSelect($("#dPayStatus"), CONFIG.paymentStatuses);
  fillSelect($("#dService"), CONFIG.services);
  fillSelect($("#mPkgType"), CONFIG.packageTypes); fillSelect($("#mService"), CONFIG.services);
  fillSelect($("#mZone"), Object.keys(CONFIG.zones));
  $("#mDate").min = new Date().toISOString().split("T")[0];
  $("#alertConfigInfo").innerHTML = `<b>Automatic alerts:</b> Email <b>${CONFIG.features.emailAlerts ? "ON" : "OFF"}</b> · SMS <b>${CONFIG.features.smsAlerts ? "ON" : "OFF"}</b> (switches live in <code>app.js → CONFIG.features</code>).
    ${CONFIG.emailjs.enabled ? "<br><b>EmailJS fallback is ON</b> — status emails are sent from this dashboard. Turn it OFF once Cloud Functions is deployed to avoid duplicate emails." : "Status emails/SMS are sent by Cloud Functions (Part 6)."} Resend needs Cloud Functions deployed.`;

  onSnapshot(collection(db, "orders"), s => { S.orders = []; s.forEach(d => S.orders.push({ orderId: d.id, ...d.data() })); renderStats(); renderOrders(); renderCustomers(); renderRiders(); }, e => toast("Orders failed to load: " + e.message, "error"));
  onSnapshot(collection(db, "users"), s => { S.users = []; s.forEach(d => S.users.push({ uid: d.id, ...d.data() })); renderStats(); renderCustomers(); renderRiders(); });
  onSnapshot(collection(db, "alerts"), s => { S.alerts = []; s.forEach(d => S.alerts.push({ id: d.id, ...d.data() })); S.alerts.sort((a, b) => millis(b.createdAt || b.time || b.at) - millis(a.createdAt || a.time || a.at)); renderAlerts(); });
  onSnapshot(collection(db, "messages"), s => { S.messages = []; s.forEach(d => S.messages.push({ id: d.id, ...d.data() })); S.messages.sort((a, b) => millis(b.createdAt) - millis(a.createdAt)); renderInbox(); });
  onSnapshot(collection(db, "applications"), s => { S.apps = []; s.forEach(d => S.apps.push({ id: d.id, ...d.data() })); S.apps.sort((a, b) => millis(b.createdAt) - millis(a.createdAt)); renderApps(); });
  onSnapshot(collection(db, "riderLocations"), s => { S.locs = []; s.forEach(d => S.locs.push({ orderId: d.id, ...d.data() })); renderLive(); });
  loadTemplates(); loadPricing();
}

/* Tabs */
$$(".tab-btn").forEach(b => b.addEventListener("click", () => {
  $$(".tab-btn").forEach(x => x.classList.toggle("active", x === b));
  ["orders","customers","riders","live","alerts","inbox","pricing"].forEach(t => $("#panel-" + t).classList.toggle("hidden", t !== b.dataset.tab));
  if (b.dataset.tab === "live") setTimeout(initLiveMap, 60);
}));

/* ---------------- Stats ---------------- */
function renderStats() {
  const o = S.orders, today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  $("#stTotal").textContent = o.length;
  $("#stPending").textContent = o.filter(x => x.status === "Order Placed").length;
  $("#stTransit").textContent = o.filter(x => ["Picked Up", "In Transit", "Out for Delivery"].includes(x.status)).length;
  $("#stDelivered").textContent = o.filter(x => x.status === "Delivered").length;
  $("#stUnpaid").textContent = o.filter(x => x.paymentStatus === "Pending" && x.status !== "Cancelled").length;
  $("#stCod").textContent = o.filter(x => x.paymentStatus === "COD" || x.paymentOption === "Cash on delivery").length;
  $("#stToday").textContent = o.filter(x => dateKey(x.createdAt) === today).length;
  $("#stCustomers").textContent = customers().length;
}

/* ---------------- Orders table ---------------- */
["fSearch","fStatus","fPayment","fService","fDate","fSort"].forEach(id => $("#" + id).addEventListener("input", renderOrders));
function filteredOrders() {
  const q = $("#fSearch").value.trim().toLowerCase(), st = $("#fStatus").value, pay = $("#fPayment").value,
    svc = $("#fService").value, d = $("#fDate").value, sort = $("#fSort").value;
  let list = S.orders.filter(o =>
    (!S.customerUid || o.customerUid === S.customerUid) &&
    (!st || o.status === st) && (!pay || o.paymentStatus === pay) && (!svc || o.serviceType === svc) &&
    (!d || dateKey(o.createdAt) === d) &&
    (!q || [o.orderId, o.senderName, o.receiverName, o.senderPhone, o.receiverPhone, o.senderEmail, o.customerEmail].join(" ").toLowerCase().includes(q)));
  const price = o => o.finalPrice ?? o.estimatedPrice ?? 0;
  list.sort((a, b) => sort === "oldest" ? millis(a.createdAt) - millis(b.createdAt)
    : sort === "priceHigh" ? price(b) - price(a) : sort === "priceLow" ? price(a) - price(b)
    : millis(b.createdAt) - millis(a.createdAt));
  return list;
}
function renderOrders() {
  const list = filteredOrders();
  $("#ordersCount").textContent = `${list.length} order${list.length === 1 ? "" : "s"}`;
  const banner = $("#customerFilterBanner");
  if (S.customerUid) {
    banner.style.display = "block"; banner.classList.add("show");
    banner.innerHTML = `Showing orders for <b>${esc(S.customerLabel)}</b> <button type="button" class="btn btn-ghost btn-sm" id="clearCustFilter" style="margin-left:8px">Show all orders</button>`;
    $("#clearCustFilter").onclick = () => { S.customerUid = ""; renderOrders(); };
  } else { banner.style.display = "none"; }
  $("#ordersBody").innerHTML = list.length ? list.map(o => `<tr>
    <td><b>${esc(o.orderId)}</b><br><span class="small muted">${fmtDateTime(o.createdAt)}</span>${o.customerUid ? '<br><span class="badge badge-blue">Account</span>' : '<br><span class="badge badge-grey">Guest</span>'}</td>
    <td>${esc(o.senderName || "—")} <span class="muted small">${esc(o.senderPhone || "")}</span><br><span class="small muted">→ ${esc(o.receiverName || "—")} ${esc(o.receiverPhone || "")}</span></td>
    <td>${esc(o.serviceType || "—")}<br><span class="small muted">${esc(o.packageType || "")} ${esc(o.weightKg || 1)}kg</span></td>
    <td><span class="badge ${badgeCls(o.status)}">${esc(o.status || "—")}</span></td>
    <td><span class="badge ${o.paymentStatus === "Paid" ? "badge-green" : o.paymentStatus === "COD" ? "badge-orange" : "badge-amber"}">${esc(o.paymentStatus || "Pending")}</span><br><span class="small muted">${esc(o.paymentOption || "")}</span></td>
    <td><b>${fmtMoney(o.finalPrice ?? o.estimatedPrice ?? 0)}</b><br><span class="small muted">${o.finalPrice != null ? "final" : "estimate"}</span></td>
    <td>${esc(o.riderName || "—")}</td>
    <td><button type="button" class="btn btn-blue btn-sm" data-details="${esc(o.orderId)}">Details</button></td></tr>`).join("")
  : `<tr><td colspan="8" class="text-center muted" style="padding:26px">No orders match. Create one manually above or wait for website bookings.</td></tr>`;
  $$("[data-details]").forEach(b => b.onclick = () => openDetails(b.dataset.details));
}

/* ---------------- Order details ---------------- */
function openDetails(id) {
  const o = S.orders.find(x => x.orderId === id); if (!o) return;
  S.current = o;
  $("#dTitle").textContent = "Order " + o.orderId;
  $("#dMeta").textContent = `Booked ${fmtDateTime(o.createdAt)} · Source: ${o.source || "website"} · Estimate: ${fmtMoney(o.estimatedPrice || 0)} · Pickup: ${o.pickupDate || "—"} ${o.pickupTime || ""}`;
  const set = (i, v) => $("#" + i).value = v ?? "";
  set("dSenderName", o.senderName); set("dSenderPhone", o.senderPhone); set("dSenderEmail", o.senderEmail || o.customerEmail);
  set("dReceiverName", o.receiverName); set("dReceiverPhone", o.receiverPhone); set("dReceiverEmail", o.receiverEmail);
  set("dPickup", o.pickupAddress); set("dDropoff", o.dropoffAddress);
  set("dPkg", [o.packageType, o.packageDescription].filter(Boolean).join(" — "));
  set("dWeight", o.weightKg || 1); set("dService", o.serviceType || "Standard");
  set("dFinalPrice", o.finalPrice ?? ""); set("dStatus", o.status); set("dPayStatus", o.paymentStatus || "Pending");
  set("dNotes", o.internalNotes);
  $("#dRider").innerHTML = `<option value="">— No rider assigned —</option>` +
    riders().filter(r => !r.disabled).map(r => `<option value="${esc(r.uid)}" ${r.uid === o.riderId ? "selected" : ""}>${esc(r.fullName || r.name || r.email)}${r.vehicle ? " · " + esc(r.vehicle) : ""}${r.available ? " (Online)" : ""}</option>`).join("");
  const extras = (o.stops || []).slice(1);
  $("#dStops").innerHTML = extras.length ? `<b>Extra drop-offs:</b><br>` + extras.map((s, i) => `${i + 2}. ${esc(s.receiverName)} · ${esc(s.receiverPhone)} — ${esc(s.dropoffAddress)}`).join("<br>") : "";
  $("#dHistory").innerHTML = `<b>Status history:</b><br>` + (o.statusHistory || []).map(h => `• ${esc(h.status)} — ${fmtDateTime(h.at)}${h.note ? " (" + esc(h.note) + ")" : ""}`).join("<br>");
  syncDetailLinks(o);
  $("#detailModal").classList.add("open");
}
function detailOrderMerged() {
  const o = S.current, rUid = $("#dRider").value;
  const r = riders().find(x => x.uid === rUid);
  const [pkgType, ...desc] = $("#dPkg").value.split(" — ");
  return { ...o,
    senderName: $("#dSenderName").value.trim(), senderPhone: $("#dSenderPhone").value.trim(),
    senderEmail: $("#dSenderEmail").value.trim().toLowerCase(), customerEmail: $("#dSenderEmail").value.trim().toLowerCase(),
    customerPhone: normalizeNgPhone($("#dSenderPhone").value),
    receiverName: $("#dReceiverName").value.trim(), receiverPhone: $("#dReceiverPhone").value.trim(),
    receiverEmail: $("#dReceiverEmail").value.trim().toLowerCase(), receiverPhoneIntl: normalizeNgPhone($("#dReceiverPhone").value),
    pickupAddress: $("#dPickup").value.trim(), dropoffAddress: $("#dDropoff").value.trim(),
    packageType: (pkgType || o.packageType || "Parcel").trim(), packageDescription: desc.join(" — ").trim(),
    weightKg: Number($("#dWeight").value) || 1, serviceType: $("#dService").value,
    finalPrice: $("#dFinalPrice").value === "" ? null : Number($("#dFinalPrice").value),
    status: $("#dStatus").value, paymentStatus: $("#dPayStatus").value,
    riderId: rUid || null, riderName: r ? (r.fullName || r.name || "") : "", riderPhone: r ? (r.phone || "") : "",
    internalNotes: $("#dNotes").value.trim() };
}
function syncDetailLinks(o) {
  const link = liveLink(o.orderId);
  $("#dTrack").href = link;
  const riderLine = o.riderName ? `\nYour rider: ${o.riderName} (${o.riderPhone || ""})` : "";
  const priceLine = o.finalPrice != null ? `\nConfirmed price: ${fmtMoney(o.finalPrice)}` : "";
  const msg = `Hello ${o.senderName || "there"}, update on your DABOFFOODS & LOGISTICS SERVICES shipment ${o.orderId}:\n\nStatus: ${o.status}\nPayment: ${o.paymentStatus || "Pending"}${priceLine}${riderLine}\n\nTrack here: ${link}\n\nThank you for choosing DABOFFOODS & LOGISTICS SERVICES.`;
  $("#dWhatsApp").href = waLink(msg, normalizeNgPhone(o.senderPhone || "").replace("+", ""));
}
["dStatus","dPayStatus","dFinalPrice","dRider"].forEach(id => $("#" + id).addEventListener("change", () => { if (S.current) syncDetailLinks(detailOrderMerged()); }));
const closeDetails = () => $("#detailModal").classList.remove("open");
$("#dClose").addEventListener("click", closeDetails);
$("#detailModal").addEventListener("click", e => { if (e.target.id === "detailModal") closeDetails(); });

/* EmailJS fallback (ONLY if enabled in app.js CONFIG and Cloud Functions not deployed) */
let emailjsReady = false;
async function emailFallback(before, after) {
  if (!CONFIG.emailjs?.enabled || !window.emailjs || !after.customerEmail) return;
  if (before.status === after.status && before.paymentStatus === after.paymentStatus) return;
  try {
    if (!emailjsReady) { window.emailjs.init({ publicKey: CONFIG.emailjs.publicKey }); emailjsReady = true; }
    await window.emailjs.send(CONFIG.emailjs.serviceId, CONFIG.emailjs.templateId, {
      to_email: after.customerEmail, customer_name: after.senderName, order_id: after.orderId,
      status: after.status, payment_status: after.paymentStatus,
      rider_name: after.riderName || "", rider_phone: after.riderPhone || "",
      tracking_link: liveLink(after.orderId), business: CONFIG.businessName, phone: CONFIG.phoneDisplay });
    toast("Status email sent via EmailJS fallback.", "success");
  } catch (e) { console.warn(e); toast("EmailJS fallback failed — check its keys/templates.", "error"); }
}

$("#detailForm").addEventListener("submit", async e => {
  e.preventDefault(); if (!S.current) return;
  const before = S.current, after = detailOrderMerged();
  const updates = { ...after, updatedAt: serverTimestamp() };
  delete updates.orderId; delete updates.createdAt; delete updates.statusHistory;
  if (before.status !== after.status)
    updates.statusHistory = arrayUnion({ status: after.status, at: new Date().toISOString(), note: "Updated by admin" });
  // Keep the first stop in sync with the main receiver fields
  if (Array.isArray(after.stops) && after.stops.length)
    updates.stops = [{ receiverName: after.receiverName, receiverPhone: after.receiverPhone, dropoffAddress: after.dropoffAddress }, ...after.stops.slice(1)];
  const b = $("#dSave"), o = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await updateDoc(doc(db, "orders", before.orderId), updates);
    if (["Delivered", "Cancelled"].includes(after.status)) { try { await deleteDoc(doc(db, "riderLocations", before.orderId)); } catch {} }
    await emailFallback(before, after);
    toast(`Order ${before.orderId} saved.${before.status !== after.status ? " Customer alerts triggered." : ""}`, "success");
    closeDetails();
  } catch (err) { console.error(err); toast("Save failed: " + err.message, "error"); }
  finally { b.disabled = false; b.innerHTML = o; }
});
$("#dCancel").addEventListener("click", async () => {
  if (!S.current) return;
  if (!await confirmDialog("Cancel this order?", `Order ${S.current.orderId} will be marked Cancelled and the customer will be alerted.`, "Yes, cancel order")) return;
  try {
    await updateDoc(doc(db, "orders", S.current.orderId), { status: "Cancelled",
      statusHistory: arrayUnion({ status: "Cancelled", at: new Date().toISOString(), note: "Cancelled by admin" }), updatedAt: serverTimestamp() });
    try { await deleteDoc(doc(db, "riderLocations", S.current.orderId)); } catch {}
    toast("Order cancelled.", "success"); closeDetails();
  } catch (e) { toast("Could not cancel: " + e.message, "error"); }
});
$("#dDelete").addEventListener("click", async () => {
  if (!S.current) return;
  if (!await confirmDialog("DELETE this order permanently?", `Order ${S.current.orderId} and its tracking will be removed forever. This cannot be undone.`, "Yes, delete forever")) return;
  try {
    await deleteDoc(doc(db, "orders", S.current.orderId));
    try { await deleteDoc(doc(db, "riderLocations", S.current.orderId)); } catch {}
    toast("Order deleted.", "success"); closeDetails();
  } catch (e) { toast("Delete failed: " + e.message, "error"); }
});

/* Waybill print */
$("#dPrint").addEventListener("click", () => {
  if (!S.current) return;
  const o = detailOrderMerged(), link = liveLink(o.orderId);
  $("#waybillPrint").innerHTML = `
    <div style="display:flex;justify-content:space-between;border-bottom:3px solid #0B3D91;padding-bottom:10px">
      <div><h1 style="color:#0B3D91;font-size:26px">${esc(CONFIG.businessName)}</h1><p>${esc(CONFIG.tagline)}</p></div>
      <div style="text-align:right"><h2 style="color:#FF7A00">WAYBILL</h2><p><b>${esc(o.orderId)}</b></p><p>${fmtDateTime(o.createdAt)}</p></div></div>
    <p style="margin:12px 0"><b>Track this delivery:</b> ${link}</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><th style="text-align:left">SENDER</th><th style="text-align:left">RECEIVER</th></tr>
      <tr><td><b>${esc(o.senderName)}</b><br>${esc(o.senderPhone)}<br>${esc(o.pickupAddress)}</td>
          <td><b>${esc(o.receiverName)}</b><br>${esc(o.receiverPhone)}<br>${esc(o.dropoffAddress)}</td></tr>
      <tr><th style="text-align:left">PACKAGE</th><th style="text-align:left">SERVICE &amp; PAYMENT</th></tr>
      <tr><td>${esc(o.packageType)}${o.packageDescription ? " — " + esc(o.packageDescription) : ""}<br>Weight: ${esc(o.weightKg)}kg</td>
          <td>${esc(o.serviceType)} · ${esc(o.zone || "")}<br>Price: <b>${fmtMoney(o.finalPrice ?? o.estimatedPrice ?? 0)}</b> (${o.finalPrice != null ? "confirmed" : "estimate"})<br>Payment: ${esc(o.paymentStatus)} · ${esc(o.paymentOption || "")}<br>Status: ${esc(o.status)}${o.riderName ? "<br>Rider: " + esc(o.riderName) + " " + esc(o.riderPhone) : ""}</td></tr>
    </table>
    <p style="margin-top:16px;border-top:1px solid #999;padding-top:10px">${esc(CONFIG.businessName)} · ${esc(CONFIG.address)} · ${esc(CONFIG.phoneDisplay)}<br>
    Receiver signature: ___________________________ &nbsp;&nbsp; Date/Time: ___________________</p>`;
  setTimeout(() => window.print(), 120);
});

/* Manual order */
$("#toggleManualBtn").addEventListener("click", () => $("#manualForm").classList.toggle("hidden"));
$("#manualCancelBtn").addEventListener("click", () => $("#manualForm").classList.add("hidden"));
$("#manualForm").addEventListener("submit", async e => {
  e.preventDefault();
  const g = id => $("#" + id).value.trim();
  let ok = true;
  const req = (id, test, m) => { const el = $("#" + id); const p = test(el.value.trim()); setFieldError(el, p ? "" : m); if (!p) ok = false; };
  req("mSenderName", v => v.length >= 2, "Required"); req("mSenderPhone", isValidNgPhone, "Valid Nigerian phone required");
  req("mPickup", v => v.length >= 8, "Full address required"); req("mReceiverName", v => v.length >= 2, "Required");
  req("mReceiverPhone", isValidNgPhone, "Valid Nigerian phone required"); req("mDropoff", v => v.length >= 8, "Full address required");
  if (g("mSenderEmail") && !isValidEmail(g("mSenderEmail"))) { setFieldError($("#mSenderEmail"), "Invalid email (or clear it)"); ok = false; }
  if (!ok) return toast("Please fix the highlighted fields.", "error");
  const b = $("#manualSaveBtn"), original = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> Creating…`;
  try {
    let id = genOrderId();
    for (let i = 0; i < 5 && (await getDoc(doc(db, "orders", id))).exists(); i++) id = genOrderId();
    const est = null;
    const order = { orderId: id, customerUid: null, senderName: g("mSenderName"), senderPhone: g("mSenderPhone"),
      senderEmail: g("mSenderEmail").toLowerCase(), customerEmail: g("mSenderEmail").toLowerCase(), customerPhone: normalizeNgPhone(g("mSenderPhone")),
      pickupAddress: g("mPickup"), receiverName: g("mReceiverName"), receiverPhone: g("mReceiverPhone"),
      receiverPhoneIntl: normalizeNgPhone(g("mReceiverPhone")), receiverEmail: "", dropoffAddress: g("mDropoff"),
      stops: [{ receiverName: g("mReceiverName"), receiverPhone: g("mReceiverPhone"), dropoffAddress: g("mDropoff") }],
      packageType: $("#mPkgType").value, packageDescription: g("mPkgDesc"), weightKg: Number($("#mWeight").value) || 1,
      serviceType: $("#mService").value, zone: $("#mZone").value, pickupDate: $("#mDate").value, pickupTime: "",
      paymentOption: $("#mPayOpt").value, paymentStatus: "Pending", insurance: false, instructions: "",
      estimatedPrice: est, finalPrice: $("#mFinalPrice").value === "" ? null : Number($("#mFinalPrice").value),
      status: "Order Placed", statusHistory: [{ status: "Order Placed", at: new Date().toISOString(), note: "Created manually by admin" }],
      riderId: null, riderName: "", riderPhone: "", internalNotes: "",
      notificationPrefs: { email: true, sms: true, whatsapp: true }, source: "admin-manual" };
    await setDoc(doc(db, "orders", id), { ...order, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    toast(`Order ${id} created. Share the tracking link: ${liveLink(id)}`, "success");
    e.target.reset(); $("#manualForm").classList.add("hidden");
  } catch (err) { toast("Could not create order: " + err.message, "error"); }
  finally { b.disabled = false; b.innerHTML = original; }
});

/* ---------------- CSV export ---------------- */
function downloadCsv(name, rows) {
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blob = new Blob([rows.map(r => r.map(cell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$("#exportOrdersBtn").addEventListener("click", () => {
  const rows = [["Order ID","Date","Sender","Sender Phone","Sender Email","Pickup","Receiver","Receiver Phone","Drop-off","Package","Weight kg","Service","Zone","Status","Payment Status","Payment Option","Estimated","Final","Rider"]];
  filteredOrders().forEach(o => rows.push([o.orderId, fmtDateTime(o.createdAt), o.senderName, o.senderPhone, o.customerEmail, o.pickupAddress, o.receiverName, o.receiverPhone, o.dropoffAddress, `${o.packageType || ""} ${o.packageDescription || ""}`, o.weightKg, o.serviceType, o.zone, o.status, o.paymentStatus, o.paymentOption, o.estimatedPrice, o.finalPrice ?? "", o.riderName]));
  downloadCsv(`fl-orders-${new Date().toISOString().slice(0,10)}.csv`, rows);
});
$("#exportCustomersBtn").addEventListener("click", () => {
  const rows = [["Name","Email","Phone","Type","Business","Area","Orders","Joined","Disabled"]];
  customers().forEach(c => rows.push([c.fullName, c.email, c.phone, c.accountType, c.businessName, c.area, S.orders.filter(o => o.customerUid === c.uid).length, fmtDateTime(c.createdAt), c.disabled ? "Yes" : "No"]));
  downloadCsv(`fl-customers-${new Date().toISOString().slice(0,10)}.csv`, rows);
});

/* ---------------- Customers ---------------- */
$("#cSearch").addEventListener("input", renderCustomers);
function renderCustomers() {
  if (!$("#customersBody")) return;
  const q = $("#cSearch").value.trim().toLowerCase();
  const list = customers().filter(c => !q || [c.fullName, c.email, c.phone, c.businessName].join(" ").toLowerCase().includes(q))
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  $("#customersBody").innerHTML = list.length ? list.map(c => `<tr>
    <td><b>${esc(c.fullName || "—")}</b><br><span class="small muted">${esc(c.email || "")}</span>${c.businessName ? `<br><span class="badge badge-blue">${esc(c.businessName)}</span>` : ""}</td>
    <td>${esc(c.phone || "—")}</td><td>${esc(c.accountType || "Individual")}</td>
    <td><b>${S.orders.filter(o => o.customerUid === c.uid).length}</b></td><td>${fmtDateTime(c.createdAt)}</td>
    <td><span class="badge ${c.disabled ? "badge-red" : "badge-green"}">${c.disabled ? "Disabled" : "Active"}</span></td>
    <td><div class="btn-row"><button class="btn btn-ghost btn-sm" data-cust-orders="${esc(c.uid)}">View orders</button>
    <button class="btn ${c.disabled ? "btn-blue" : "btn-outline"} btn-sm" data-cust-toggle="${esc(c.uid)}">${c.disabled ? "Enable" : "Disable"}</button></div></td></tr>`).join("")
  : `<tr><td colspan="7" class="text-center muted" style="padding:24px">No registered customers yet.</td></tr>`;
  $$("[data-cust-orders]").forEach(b => b.onclick = () => {
    const c = customers().find(x => x.uid === b.dataset.custOrders);
    S.customerUid = c.uid; S.customerLabel = c.fullName || c.email;
    document.querySelector('[data-tab="orders"]').click(); renderOrders();
  });
  $$("[data-cust-toggle]").forEach(b => b.onclick = async () => {
    const c = customers().find(x => x.uid === b.dataset.custToggle);
    const action = c.disabled ? "enable" : "disable";
    if (!await confirmDialog(`${action === "disable" ? "Disable" : "Enable"} this customer?`,
      action === "disable" ? `${c.fullName || c.email} will no longer be able to sign in (enforced by this website). Their orders remain.` : `${c.fullName || c.email} will be able to sign in again.`,
      `Yes, ${action}`)) return;
    try { await updateDoc(doc(db, "users", c.uid), { disabled: !c.disabled, updatedAt: serverTimestamp() }); toast("Customer " + action + "d.", "success"); }
    catch (e) { toast("Failed: " + e.message, "error"); }
  });
}

/* ---------------- Riders ---------------- */
function secondaryAuth() {
  let app2; try { app2 = getApp("Secondary"); } catch { app2 = initializeApp(getApp().options, "Secondary"); }
  return getAuthFor(app2);
}
function resetRiderForm() {
  $("#riderForm").reset(); $("#rEditUid").value = ""; $("#rEmail").disabled = false;
  $("#rPwWrap").classList.remove("hidden"); $("#riderFormTitle").textContent = "Create rider account";
  $("#riderSaveBtn").innerHTML = `<i class="fa-solid fa-user-plus"></i> Create rider`; $("#riderCancelBtn").classList.add("hidden");
}
$("#riderCancelBtn").addEventListener("click", resetRiderForm);
$("#riderForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#rName").value.trim(), phone = $("#rPhone").value.trim(), email = $("#rEmail").value.trim().toLowerCase(),
    vehicle = $("#rVehicle").value.trim(), editUid = $("#rEditUid").value, pw = $("#rPassword").value;
  let ok = true;
  const req = (id, t, m) => { const el = $("#" + id); setFieldError(el, t ? "" : m); if (!t) ok = false; };
  req("rName", name.length >= 3, "Full name required"); req("rPhone", isValidNgPhone(phone), "Valid Nigerian phone required");
  req("rEmail", isValidEmail(email), "Valid login email required");
  if (!editUid) req("rPassword", pw.length >= 8, "Minimum 8 characters");
  if (!ok) return;
  const b = $("#riderSaveBtn"), original = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    if (editUid) {
      await Promise.all([
        updateDoc(doc(db, "users", editUid), { fullName: name, phone, phoneIntl: normalizeNgPhone(phone), vehicle, updatedAt: serverTimestamp() }),
        setDoc(doc(db, "riders", editUid), { name, phone, vehicle, updatedAt: serverTimestamp() }, { merge: true })]);
      toast("Rider updated.", "success");
    } else {
      const auth2 = secondaryAuth();
      const cred = await createUserWithEmailAndPassword(auth2, email, pw);
      const uid = cred.user.uid;
      await setDoc(doc(db, "users", uid), { uid, fullName: name, email, phone, phoneIntl: normalizeNgPhone(phone),
        accountType: "Individual", businessName: "", defaultAddress: "", area: "", source: "admin",
        notificationPrefs: { email: true, sms: true, whatsapp: true }, role: "rider", vehicle,
        available: false, disabled: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      await setDoc(doc(db, "riders", uid), { uid, name, email, phone, vehicle, status: "active",
        available: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      await signOutAuth(auth2); // admin stays signed in on the main app
      toast(`Rider account created for ${name}. Login: ${email} (share the password securely).`, "success");
    }
    resetRiderForm();
  } catch (err) { console.error(err); toast(friendlyAuthError(err), "error"); }
  finally { b.disabled = false; b.innerHTML = original; }
});
function renderRiders() {
  if (!$("#ridersBody")) return;
  const list = riders().sort((a, b) => String(a.fullName || "").localeCompare(String(b.fullName || "")));
  $("#ridersBody").innerHTML = list.length ? list.map(r => {
    const activeJobs = S.orders.filter(o => o.riderId === r.uid && !["Delivered", "Cancelled"].includes(o.status)).length;
    const live = S.locs.some(l => l.riderId === r.uid && l.active && Date.now() - (l.ts || 0) < 600000);
    return `<tr><td><b>${esc(r.fullName || "—")}</b>${r.disabled ? ' <span class="badge badge-red">Deactivated</span>' : ""}<br><span class="small muted">${esc(r.email || "")} · ${esc(r.phone || "")}</span></td>
    <td>${esc(r.vehicle || "—")}</td>
    <td>${live ? '<span class="badge badge-orange"><span class="live-dot"></span> On trip</span>' : r.available ? '<span class="badge badge-green">Online</span>' : '<span class="badge badge-grey">Offline</span>'}</td>
    <td><b>${activeJobs}</b></td>
    <td><div class="btn-row"><button class="btn btn-ghost btn-sm" data-rider-edit="${esc(r.uid)}">Edit</button>
    <button class="btn btn-outline btn-sm" data-rider-toggle="${esc(r.uid)}">${r.disabled ? "Activate" : "Deactivate"}</button>
    <button class="btn btn-danger btn-sm" data-rider-delete="${esc(r.uid)}">Delete</button></div></td></tr>`; }).join("")
  : `<tr><td colspan="5" class="text-center muted" style="padding:24px">No riders yet. Create the first rider account.</td></tr>`;
  $$("[data-rider-edit]").forEach(b => b.onclick = () => {
    const r = riders().find(x => x.uid === b.dataset.riderEdit); if (!r) return;
    $("#rEditUid").value = r.uid; $("#rName").value = r.fullName || ""; $("#rPhone").value = r.phone || "";
    $("#rEmail").value = r.email || ""; $("#rEmail").disabled = true; $("#rVehicle").value = r.vehicle || "";
    $("#rPwWrap").classList.add("hidden"); $("#riderFormTitle").textContent = "Edit rider";
    $("#riderSaveBtn").innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save rider changes`;
    $("#riderCancelBtn").classList.remove("hidden"); $("#riderForm").scrollIntoView({ behavior: "smooth" });
  });
  $$("[data-rider-toggle]").forEach(b => b.onclick = async () => {
    const r = riders().find(x => x.uid === b.dataset.riderToggle);
    try {
      await Promise.all([updateDoc(doc(db, "users", r.uid), { disabled: !r.disabled, updatedAt: serverTimestamp() }),
        setDoc(doc(db, "riders", r.uid), { status: !r.disabled ? "inactive" : "active", updatedAt: serverTimestamp() }, { merge: true })]);
      toast(!r.disabled ? "Rider deactivated — they can no longer sign in." : "Rider activated.", "success");
    } catch (e) { toast(e.message, "error"); }
  });
  $$("[data-rider-delete]").forEach(b => b.onclick = async () => {
    const r = riders().find(x => x.uid === b.dataset.riderDelete);
    if (!await confirmDialog("Delete rider profile?", `This deletes ${r.fullName || r.email}'s rider profile from the website database. For full security, also delete/disable their login in Firebase Console → Authentication. Active jobs keep the rider name snapshot.`, "Yes, delete profile")) return;
    try { await Promise.all([deleteDoc(doc(db, "users", r.uid)), deleteDoc(doc(db, "riders", r.uid))]); toast("Rider profile deleted. Remember to remove the Auth login in Firebase Console.", "success"); }
    catch (e) { toast(e.message, "error"); }
  });
}

/* ---------------- Live riders map ---------------- */
function initLiveMap() {
  if (S.map || !window.L) { S.map?.invalidateSize(); return; }
  S.map = L.map("adminMap").setView([6.5244, 3.3792], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(S.map);
  renderLive();
}
function renderLive() {
  const fresh = S.locs.filter(l => l.active && l.lat != null && Date.now() - (l.ts || 0) < 10 * 60 * 1000);
  $("#liveList").innerHTML = fresh.length ? fresh.map(l => {
    const secs = Math.max(0, Math.round((Date.now() - (l.ts || Date.now())) / 1000));
    return `<div class="order-row" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <b><i class="fa-solid fa-motorcycle" style="color:var(--orange)"></i> ${esc(l.riderName || "Rider")}</b>
      <span class="badge badge-orange">Order ${esc(l.orderId)}</span>
      <span class="small muted">Updated ${secs < 60 ? secs + "s" : Math.round(secs / 60) + "min"} ago${l.speedKmh != null ? " · " + l.speedKmh + " km/h" : ""}</span>
      <span style="margin-left:auto" class="btn-row"><a class="btn btn-ghost btn-sm" href="track.html?id=${esc(l.orderId)}" target="_blank">Open tracking</a>
      ${l.riderPhone ? `<a class="btn btn-blue btn-sm" href="tel:${esc(normalizeNgPhone(l.riderPhone))}">Call</a>` : ""}</span></div>`;
  }).join("") : `<p class="muted">No riders are sharing location right now.</p>`;

  if (!S.map) return;
  const seen = new Set();
  fresh.forEach(l => {
    seen.add(l.orderId);
    const html = `<b>${esc(l.riderName || "Rider")}</b><br>Order ${esc(l.orderId)}<br><a href="track.html?id=${esc(l.orderId)}" target="_blank">Open customer tracking</a>`;
    if (S.markers[l.orderId]) S.markers[l.orderId].setLatLng([l.lat, l.lng]).setPopupContent(html);
    else S.markers[l.orderId] = L.marker([l.lat, l.lng], { icon: L.divIcon({ className: "", html: `<div class="fl-pin"><i class="fa-solid fa-motorcycle"></i></div>`, iconSize: [36, 36], iconAnchor: [18, 34] }) }).addTo(S.map).bindPopup(html);
  });
  Object.keys(S.markers).forEach(id => { if (!seen.has(id)) { S.markers[id].remove(); delete S.markers[id]; } });
  if (fresh.length) S.map.fitBounds(L.latLngBounds(fresh.map(l => [l.lat, l.lng])).pad(0.2));
}

/* ---------------- Notifications ---------------- */
function renderAlerts() {
  const list = S.alerts.slice(0, 150);
  $("#alertsBody").innerHTML = list.length ? list.map(a => `<tr>
    <td>${fmtDateTime(a.createdAt || a.time || a.at)}</td><td><b>${esc(a.orderId || "—")}</b><br><span class="small muted">${esc(a.event || a.statusChange || "")}</span></td>
    <td><span class="badge badge-blue">${esc(String(a.channel || "—").toUpperCase())}</span></td><td>${esc(a.to || "—")}</td>
    <td><span class="badge ${a.status === "sent" ? "badge-green" : a.status === "failed" ? "badge-red" : "badge-amber"}">${esc(a.status || "pending")}</span></td>
    <td class="small muted">${esc(a.error || "")}</td>
    <td><button class="btn btn-ghost btn-sm" data-resend="${esc(a.id)}"><i class="fa-solid fa-rotate-right"></i> Resend</button></td></tr>`).join("")
  : `<tr><td colspan="7" class="text-center muted" style="padding:24px">No alerts yet. They appear here after Cloud Functions (Part 6) is deployed and orders move.</td></tr>`;
  $$("[data-resend]").forEach(b => b.onclick = async () => {
    b.disabled = true; const original = b.innerHTML; b.innerHTML = `<span class="spinner"></span>`;
    try {
      const fn = httpsCallable(getFunctions(), "resendAlert");
      await fn({ alertId: b.dataset.resend });
      toast("Alert resent.", "success");
    } catch (e) {
      toast("Resend needs Cloud Functions deployed (Part 6). " + (e.message || ""), "error");
    } finally { b.disabled = false; b.innerHTML = original; }
  });
}
async function loadTemplates() {
  const defaults = {
    emailSubject: "DABOFFOODS shipment update: {orderId} is {status}",
    sms: "DABOFFOODS: Shipment {orderId} is {status}. Track: {trackingLink}",
    whatsapp: "Hello {customerName}, your DABOFFOODS shipment {orderId} is now {status}. Track it here: {trackingLink}" };
  try {
    const s = await getDoc(doc(db, "settings", "alertTemplates"));
    const t = s.exists() ? { ...defaults, ...s.data() } : defaults;
    $("#tplSubject").value = t.emailSubject; $("#tplSms").value = t.sms; $("#tplWa").value = t.whatsapp;
  } catch { $("#tplSubject").value = defaults.emailSubject; $("#tplSms").value = defaults.sms; $("#tplWa").value = defaults.whatsapp; }
}
$("#templatesForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await setDoc(doc(db, "settings", "alertTemplates"), {
      emailSubject: $("#tplSubject").value.trim(), sms: $("#tplSms").value.trim(),
      whatsapp: $("#tplWa").value.trim(), updatedAt: serverTimestamp() }, { merge: true });
    toast("Alert templates saved.", "success");
  } catch (err) { toast("Save failed: " + err.message, "error"); }
});

/* ---------------- Inbox ---------------- */
function renderInbox() {
  $("#messagesList").innerHTML = S.messages.length ? S.messages.map(m => `<article class="order-row">
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between"><b>${esc(m.name || "—")}</b>
    <span class="badge ${m.read ? "badge-grey" : "badge-orange"}">${m.read ? "Read" : "New"}</span></div>
    <p class="small muted">${fmtDateTime(m.createdAt)} · ${esc(m.email || "")} · ${esc(m.phone || "")}${m.subject ? " · <b>" + esc(m.subject) + "</b>" : ""}</p>
    <p style="margin:10px 0">${esc(m.message || "")}</p>
    <div class="btn-row">${m.phone ? `<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="${waLink(`Hello ${m.name || ""}, thanks for contacting DABOFFOODS & LOGISTICS SERVICES.`, normalizeNgPhone(m.phone).replace("+", ""))}"><i class="fa-brands fa-whatsapp"></i> Reply WhatsApp</a>` : ""}
    ${m.email ? `<a class="btn btn-ghost btn-sm" href="mailto:${esc(m.email)}">Reply email</a>` : ""}
    <button class="btn btn-outline btn-sm" data-msg-read="${esc(m.id)}">${m.read ? "Mark unread" : "Mark read"}</button>
    <button class="btn btn-danger btn-sm" data-msg-del="${esc(m.id)}">Delete</button></div></article>`).join("")
  : `<p class="muted">No contact messages yet.</p>`;
  $$("[data-msg-read]").forEach(b => b.onclick = async () => { const m = S.messages.find(x => x.id === b.dataset.msgRead); await updateDoc(doc(db, "messages", m.id), { read: !m.read }); });
  $$("[data-msg-del]").forEach(b => b.onclick = async () => { if (await confirmDialog("Delete message?", "This contact message will be permanently deleted.", "Yes, delete")) await deleteDoc(doc(db, "messages", b.dataset.msgDel)); });
}
function renderApps() {
  $("#appsList").innerHTML = S.apps.length ? S.apps.map(a => `<article class="order-row">
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between"><b>${esc(a.name || "—")}</b>
    <span class="badge ${a.status === "reviewed" ? "badge-green" : "badge-orange"}">${esc(a.status || "new")}</span></div>
    <p class="small muted">${fmtDateTime(a.createdAt)} · ${esc(a.phone || "")} · ${esc(a.location || "")} · Vehicle: ${esc(a.vehicleType || "—")}</p>
    <p style="margin:10px 0" class="small"><b>Experience:</b> ${esc(a.experience || "—")}</p>
    <div class="btn-row">${a.phone ? `<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="${waLink(`Hello ${a.name || ""}, thanks for applying to ride with DABOFFOODS & LOGISTICS SERVICES.`, normalizeNgPhone(a.phone).replace("+", ""))}"><i class="fa-brands fa-whatsapp"></i> WhatsApp applicant</a>` : ""}
    <button class="btn btn-blue btn-sm" data-app-create="${esc(a.id)}">Create rider from this</button>
    <button class="btn btn-outline btn-sm" data-app-review="${esc(a.id)}">${a.status === "reviewed" ? "Mark new" : "Mark reviewed"}</button>
    <button class="btn btn-danger btn-sm" data-app-del="${esc(a.id)}">Delete</button></div></article>`).join("")
  : `<p class="muted">No rider applications yet.</p>`;
  $$("[data-app-review]").forEach(b => b.onclick = async () => { const a = S.apps.find(x => x.id === b.dataset.appReview); await updateDoc(doc(db, "applications", a.id), { status: a.status === "reviewed" ? "new" : "reviewed" }); });
  $$("[data-app-del]").forEach(b => b.onclick = async () => { if (await confirmDialog("Delete application?", "This rider application will be permanently deleted.", "Yes, delete")) await deleteDoc(doc(db, "applications", b.dataset.appDel)); });
  $$("[data-app-create]").forEach(b => b.onclick = () => {
    const a = S.apps.find(x => x.id === b.dataset.appCreate);
    document.querySelector('[data-tab="riders"]').click(); resetRiderForm();
    $("#rName").value = a.name || ""; $("#rPhone").value = a.phone || ""; $("#rVehicle").value = a.vehicleType || "";
    toast("Applicant details filled in. Add the rider's login email & password to finish.", "success");
  });
}

/* ---------------- Pricing editor ---------------- */
let pricingState = null;
async function loadPricing() {
  pricingState = JSON.parse(JSON.stringify({ pricing: CONFIG.pricing, zones: CONFIG.zones, rateTable: CONFIG.rateTable }));
  try {
    const s = await getDoc(doc(db, "pricing", "main"));
    if (s.exists()) pricingState = { ...pricingState, ...s.data() };
  } catch (e) { console.warn(e); }
  $("#pricingServices").innerHTML = Object.entries(pricingState.pricing).map(([svc, p]) => `
    <div class="card" style="padding:16px"><b style="color:var(--blue-dark)">${esc(svc)}</b>
      <div class="form-grid" style="margin-top:10px">
        <div class="field"><label>Base ₦</label><input type="number" min="0" data-psvc="${esc(svc)}" data-pkey="base" value="${p.base}"></div>
        <div class="field"><label>Per extra kg ₦</label><input type="number" min="0" data-psvc="${esc(svc)}" data-pkey="perKg" value="${p.perKg}"></div>
      </div></div>`).join("");
  $("#pricingZones").innerHTML = Object.entries(pricingState.zones).map(([z, v]) => `
    <div class="field"><label>${esc(z)}</label><input type="number" min="0" step="0.05" data-zone="${esc(z)}" value="${v}"></div>`).join("");
  renderRateRows();
}
function renderRateRows() {
  $("#rateBody").innerHTML = pricingState.rateTable.map((r, i) => `<tr>
    ${["service","w1","w5","w10"].map(f => `<td><input data-rate="${i}" data-rf="${f}" value="${esc(r[f] || "")}" style="min-height:42px;padding:8px"></td>`).join("")}
    <td><button type="button" class="btn btn-danger btn-sm" data-rate-del="${i}">Delete</button></td></tr>`).join("");
  $$("[data-rate-del]").forEach(b => b.onclick = () => { syncRate(); pricingState.rateTable.splice(Number(b.dataset.rateDel), 1); renderRateRows(); });
}
function syncRate() { $$("[data-rate]").forEach(i => { pricingState.rateTable[Number(i.dataset.rate)][i.dataset.rf] = i.value; }); }
$("#addRateBtn").addEventListener("click", () => { syncRate(); pricingState.rateTable.push({ service: "", w1: "", w5: "", w10: "" }); renderRateRows(); });
$("#pricingForm").addEventListener("submit", async e => {
  e.preventDefault(); syncRate();
  $$("[data-psvc]").forEach(i => pricingState.pricing[i.dataset.psvc][i.dataset.pkey] = Number(i.value) || 0);
  $$("[data-zone]").forEach(i => pricingState.zones[i.dataset.zone] = Number(i.value) || 1);
  pricingState.rateTable = pricingState.rateTable.filter(r => r.service.trim());
  try {
    await setDoc(doc(db, "pricing", "main"), { ...pricingState, updatedAt: serverTimestamp() });
    toast("Pricing saved to Firestore. The public Pricing page will use it.", "success"); renderRateRows();
  } catch (err) { toast("Pricing save failed: " + err.message, "error"); }
});
/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — auth.js
   Shared Firebase Authentication + user-profile helpers.
   Used by signup.html, login.html, account.html, rider.html
   and admin.html.
============================================================ */
import { auth, db, firebaseReady, normalizeNgPhone, $ } from "./app.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  updateProfile,
  updatePassword,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  EmailAuthProvider,
  deleteUser,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Friendly Firebase Auth errors ---------- */
export function friendlyAuthError(error) {
  const code = error?.code || "";
  const messages = {
    "auth/email-already-in-use":
      "An account with this email already exists. Please sign in instead, or use “Forgot password?” if you can't remember your password.",
    "auth/invalid-email":
      "Please enter a valid email address.",
    "auth/weak-password":
      "Your password is too weak. Please use at least 8 characters with letters and numbers.",
    "auth/user-not-found":
      "We couldn't find an account with this email. Please check the email or create a new account.",
    "auth/wrong-password":
      "The password you entered is incorrect. Please try again or reset your password.",
    "auth/invalid-credential":
      "The email or password is incorrect. Please check both and try again.",
    "auth/too-many-requests":
      "Too many unsuccessful attempts. Please wait a few minutes, then try again or reset your password.",
    "auth/network-request-failed":
      "Network problem. Please check your internet connection and try again.",
    "auth/popup-closed-by-user":
      "Google sign-in was closed before it finished. Please try again.",
    "auth/popup-blocked":
      "Your browser blocked the Google sign-in window. Please allow pop-ups for this website and try again.",
    "auth/account-exists-with-different-credential":
      "This email is already registered with a password. Please sign in with your email and password.",
    "auth/operation-not-allowed":
      "This sign-in method has not been enabled yet. Please contact DABOFFOODS & LOGISTICS SERVICES on WhatsApp.",
    "auth/user-disabled":
      "This account has been disabled. Please contact DABOFFOODS & LOGISTICS SERVICES on WhatsApp for help.",
    "auth/requires-recent-login":
      "For your security, please sign out and sign in again before making this change.",
    "app/account-disabled":
      "This account has been disabled. Please contact DABOFFOODS & LOGISTICS SERVICES on WhatsApp for help.",
    "app/firebase-not-ready":
      " Online accounts are not connected yet. Please book as a guest or chat with us on WhatsApp."
  };
  return messages[code] ||
    error?.message?.replace(/^Firebase:\s*/i, "") ||
    "Something went wrong. Please try again.";
}

function firebaseError() {
  const err = new Error("Firebase is not configured yet.");
  err.code = "app/firebase-not-ready";
  return err;
}

function assertFirebase() {
  if (!firebaseReady || !auth || !db) throw firebaseError();
}

/* ---------- Password helpers ---------- */
export function getPasswordStrength(password = "") {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (!password) return { score: 0, label: "", width: "0%", color: "#c0392b" };
  if (score <= 1) return { score, label: "Weak password", width: "22%", color: "#c0392b" };
  if (score === 2) return { score, label: "Fair — add numbers or symbols", width: "45%", color: "#e67e22" };
  if (score <= 4) return { score, label: "Good password", width: "72%", color: "#2f7ed8" };
  return { score, label: "Strong password", width: "100%", color: "#12805c" };
}

/* Buttons must use: <button class="pw-toggle" data-target="passwordInputId">Show</button> */
export function setupPasswordToggles() {
  document.querySelectorAll(".pw-toggle").forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.type = "button";
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      input.focus();
    });
  });
}

/* ---------- User profile helpers ---------- */
export async function getUserProfile(uid) {
  if (!db || !uid) return null;
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/*
  Creates a customer profile only if one does not already exist.
  This protects manually created admin/rider roles from being overwritten.
*/
export async function ensureUserProfile(user, extra = {}) {
  assertFirebase();

  const existing = await getUserProfile(user.uid);
  if (existing) return { profile: existing, isNew: false };

  const profile = {
    uid: user.uid,
    fullName: extra.fullName || user.displayName || "",
    email: (extra.email || user.email || "").toLowerCase(),
    phone: extra.phone || user.phoneNumber || "",
    phoneIntl: extra.phone ? normalizeNgPhone(extra.phone) : (user.phoneNumber || ""),
    accountType: extra.accountType || "Individual",
    businessName: extra.businessName || "",
    defaultAddress: extra.defaultAddress || "",
    area: extra.area || "",
    source: extra.source || "",
    notificationPrefs: extra.notificationPrefs || {
      email: true,
      sms: true,
      whatsapp: true
    },
    role: "customer",
    disabled: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(doc(db, "users", user.uid), profile);

  return {
    profile: { ...profile, createdAt: null },
    isNew: true
  };
}

async function rejectDisabledProfile(user, profile) {
  if (profile?.disabled) {
    await signOut(auth);
    const err = new Error("This account has been disabled.");
    err.code = "app/account-disabled";
    throw err;
  }
}

/* ---------- Create account with email/password ---------- */
export async function createAccountWithEmail(data) {
  assertFirebase();

  const cred = await createUserWithEmailAndPassword(
    auth,
    data.email.trim().toLowerCase(),
    data.password
  );

  const user = cred.user;

  try {
    await updateProfile(user, { displayName: data.fullName });
  } catch {}

  const profile = {
    uid: user.uid,
    fullName: data.fullName.trim(),
    email: data.email.trim().toLowerCase(),
    phone: data.phone.trim(),
    phoneIntl: normalizeNgPhone(data.phone),
    accountType: data.accountType || "Individual",
    businessName: data.accountType === "Business" ? data.businessName.trim() : "",
    defaultAddress: data.defaultAddress?.trim() || "",
    area: data.area?.trim() || "",
    source: data.source || "",
    notificationPrefs: data.notificationPrefs || {
      email: true,
      sms: true,
      whatsapp: true
    },
    role: "customer",
    disabled: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(doc(db, "users", user.uid), profile);

  let verificationSent = false;
  try {
    await sendEmailVerification(user);
    verificationSent = true;
  } catch (e) {
    console.warn("Verification email could not be sent:", e);
  }

  return { user, profile, verificationSent };
}

/* ---------- Sign in with email/password ---------- */
export async function signInWithEmail(email, password, remember = true) {
  assertFirebase();

  await setPersistence(
    auth,
    remember ? browserLocalPersistence : browserSessionPersistence
  );

  const cred = await signInWithEmailAndPassword(
    auth,
    email.trim().toLowerCase(),
    password
  );

  const profile = await getUserProfile(cred.user.uid);
  await rejectDisabledProfile(cred.user, profile);

  return { user: cred.user, profile };
}

/* ---------- Sign in / sign up with Google ---------- */
export async function signInWithGoogle(extra = {}) {
  assertFirebase();

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const cred = await signInWithPopup(auth, provider);
  const { profile, isNew } = await ensureUserProfile(cred.user, extra);

  await rejectDisabledProfile(cred.user, profile);

  return { user: cred.user, profile, isNew };
}

/* ---------- Other auth actions ---------- */
export async function sendResetPassword(email) {
  assertFirebase();
  await sendPasswordResetEmail(auth, email.trim().toLowerCase());
}

export async function resendVerification() {
  assertFirebase();
  if (!auth.currentUser) throw new Error("Please sign in first.");
  await sendEmailVerification(auth.currentUser);
}

export async function signOutUser() {
  if (auth) await signOut(auth);
}

export function hasPasswordProvider(user) {
  return !!user?.providerData?.some(p => p.providerId === "password");
}

async function reauthenticateCurrentUser(currentPassword = "") {
  assertFirebase();
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");

  if (hasPasswordProvider(user)) {
    if (!currentPassword) {
      const err = new Error("Please enter your current password.");
      err.code = "auth/wrong-password";
      throw err;
    }
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
  } else {
    await reauthenticateWithPopup(user, new GoogleAuthProvider());
  }

  return user;
}

export async function changeUserPassword(currentPassword, newPassword) {
  const user = await reauthenticateCurrentUser(currentPassword);
  await updatePassword(user, newPassword);
}

/*
  Deletes:
  1. users/{uid}/addresses subcollection
  2. users/{uid} profile
  3. Firebase Authentication account

  Past orders are intentionally not deleted automatically because the
  business may need delivery/payment records. Admin can remove old data
  manually if legally/operationally appropriate.
*/
export async function deleteUserAccount(currentPassword = "") {
  const user = await reauthenticateCurrentUser(currentPassword);

  const addressesSnap = await getDocs(collection(db, "users", user.uid, "addresses"));
  if (!addressesSnap.empty) {
    const batch = writeBatch(db);
    addressesSnap.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await deleteDoc(doc(db, "users", user.uid));
  await deleteUser(user);
}

/* ---------- Watch auth state + load profile ---------- */
export function watchAuth(callback) {
  if (!firebaseReady || !auth) {
    callback(null, null);
    return () => {};
  }

  return onAuthStateChanged(auth, async user => {
    if (!user) {
      callback(null, null);
      return;
    }

    let profile = null;
    try {
      profile = await getUserProfile(user.uid);
    } catch (e) {
      console.warn("Could not load user profile:", e);
    }

    callback(user, profile);
  });
}

/* ---------- Safe redirect helpers ---------- */
export function safeNextPath() {
  const next = new URLSearchParams(location.search).get("next") || "";
  // Only allow simple local .html pages, never external URLs.
  return /^[a-z0-9-]+\.html(\?[^"'<>]*)?$/i.test(next) ? next : "";
}

export function redirectAfterLogin(profile) {
  const next = safeNextPath();

  if (profile?.role === "admin") {
    location.href = "admin.html";
    return;
  }

  if (profile?.role === "rider") {
    location.href = "rider.html";
    return;
  }

  location.href = next || "account.html";
}
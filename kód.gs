function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function(b) {
    var v = (b < 0) ? b + 256 : b;
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
}
// ===== ADMIN LOGIN (EGY JELSZÓ) =====

// 1) Első beállítás: Apps Script -> Project Settings -> Script properties
// ADMIN_PASSWORD_HASH = <sha256 hash HEX>
// (Lentebb adok egy helper függvényt is a hash generálásra.)

var ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 6; // 6 óra
function verifyAdminPassword(pw) {
  pw = String(pw || "").trim();
  if (!pw) return { ok: false, message: "Hiányzó jelszó." };

  var props = PropertiesService.getScriptProperties();
  var storedHash = props.getProperty("ADMIN_PASSWORD_HASH");
  if (!storedHash) return { ok: false, message: "Nincs beállítva admin jelszó." };

  var inputHash = sha256Hex_(pw);

  if (inputHash !== storedHash) {
    return { ok: false, message: "Hibás jelszó." };
  }

  // ✅ token generálás + cache-be mentés (6 óra)
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put(
    "ADMIN_TOKEN_" + token,
    "1",
    ADMIN_TOKEN_TTL_SECONDS
  );

  return { ok: true, token: token };
}




function assertAdmin_(token) {
  token = String(token || "");
  if (!token) throw new Error("Nincs admin token.");

  var ok = CacheService
    .getScriptCache()
    .get("ADMIN_TOKEN_" + token);

  if (!ok) {
    throw new Error("Admin jogosultság lejárt vagy érvénytelen.");
  }
}

function getOrdersForAdmin(adminToken) {
  assertAdmin_(adminToken);   // ✅ itt már a paramétert ellenőrzi

  try {
    var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
    var sheet = ss.getSheetByName("GDPR_naplo");
    if (!sheet) return [];

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2) return [];

    var numCols = Math.min(10, lastCol); // A–J
    var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    var out = [];
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      out.push({
        rowNumber: i + 2,
        timestamp: r[0] ? String(r[0]) : "",
        orderId: String(r[1] || ""),
        name: String(r[2] || ""),
        email: String(r[3] || ""),
        itemsText: String(r[4] || ""),
        gdpr: String(r[5] || ""),
        status: String(r[6] || "FELDOLGOZATLAN"),
        statusTime: r[7] ? String(r[7]) : "",
        etaDate: r[8] ? String(r[8]) : "",
        etaUnknown: !!r[9]
      });
    }

    return out.reverse();
  } catch (e) {
    return []; // ✅ sose legyen null
  }
}


function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page).toLowerCase() : "";

  if (page === "adatkezeles") {
    return HtmlService.createHtmlOutputFromFile("adatkezeles")
      .setTitle("Adatkezelési tájékoztató");
  }

  if (page === "admin") {
    return HtmlService.createHtmlOutputFromFile("admin")
      .setTitle("Recept foglalások - patikai kezelőfelület");
  }

  var t = HtmlService.createTemplateFromFile("Index"); 
  t.orderIdFromServer = (e && e.parameter && e.parameter.orderId) ? String(e.parameter.orderId) : "";

  return t.evaluate()
    .setTitle("Patikai Vényfoglaló")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}
function getAppUrl_() {
  return ScriptApp.getService().getUrl();
}
/* ============================= */
/* ===== SPAM VÉDELEM RÉSZ ===== */
/* ============================= */
const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxJOa6YesvsRf7WX0ln_n2CcU2y-8XT_0yFE5C50_e8NLBslPmg2QF8Rp1qNCh1O__m/exec";
function isRateLimited(email) {
  var cache = CacheService.getScriptCache();
  var key = "booking_" + email.toLowerCase();
  var windowSeconds = 600;
  var maxAttempts = 4;

  var existing = cache.get(key);
  if (existing) {
    var count = parseInt(existing, 10);
    if (count >= maxAttempts) return true;
    cache.put(key, String(count + 1), windowSeconds);
    return false;
  }

  cache.put(key, "1", windowSeconds);
  return false;
}

// ===== KERESÉS: ékezet-eltávolítás + token match + cache (BIZTOSAN MŰKÖDŐ) =====

// Nagy lista cache-ét NEM CacheService-be tesszük (túl nagy), hanem memóriába.
// + A találati listát (8 elem) CacheService-be tesszük (kicsi, belefér).
var MED_INDEX_MEM = null;
var MED_INDEX_MEM_TS = 0;

function normalizeHu_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function getMedicinesIndex_() {
  // memória cache 20 percre
  var now = Date.now();
  if (MED_INDEX_MEM && (now - MED_INDEX_MEM_TS) < 20 * 60 * 1000) {
    return MED_INDEX_MEM;
  }

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    MED_INDEX_MEM = [];
    MED_INDEX_MEM_TS = now;
    return MED_INDEX_MEM;
  }

  // Csak A:D kell (A=név, D=kiadhatóság)
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();

  var seen = Object.create(null);
  var index = [];
  for (var i = 0; i < values.length; i++) {
    var name = values[i][0];
    var kiadhatosag = values[i][3];
    if (!name || !kiadhatosag) continue;

    var key = String(name);
    if (seen[key]) continue;
    seen[key] = true;

    index.push({
      name: key,
      norm: normalizeHu_(key)
    });
  }

  MED_INDEX_MEM = index;
  MED_INDEX_MEM_TS = now;
  return MED_INDEX_MEM;
}

function getUniqueMedicines(searchQuery) {
  var q = normalizeHu_(searchQuery);
  if (!q || q.length < 2) return [];

  // KIS cache: query → 8 elem (ez belefér CacheService-be)
  var cache = CacheService.getScriptCache();
  var cacheKey = "MED_Q_V1_" + q;
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  var tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  var index = getMedicinesIndex_();

  var scored = [];
  for (var i = 0; i < index.length; i++) {
    var item = index[i];
    var hay = item.norm;

    var ok = true;
    for (var t = 0; t < tokens.length; t++) {
      if (hay.indexOf(tokens[t]) === -1) { ok = false; break; }
    }
    if (!ok) continue;

    var score = 0;
    if (hay.indexOf(q) === 0) score += 100;
    if (hay.indexOf(tokens[0]) === 0) score += 40;
    score += Math.max(0, 30 - hay.length);

    scored.push({ name: item.name, score: score });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name, "hu");
  });

  var out = [];
  for (var k = 0; k < scored.length && out.length < 8; k++) {
    out.push(scored[k].name);
  }

  // 10 percre eltesszük a query találatot (kicsi!)
  cache.put(cacheKey, JSON.stringify(out), 10 * 60);

  return out;
}
function getDetails(medName) {
  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var variations = [];

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === medName) {
      variations.push({
        kiszereles: data[i][1],
        hatoanyag: data[i][2],
        kiadhatosag: data[i][3]
      });
    }
  }
  return variations;
}

/* ======================================= */
/* ===== FOGLALÁS FELDOLGOZÁS ===== */
/* ======================================= */

function processBooking(data) {
  if (data.honeypot && data.honeypot !== "") throw new Error("Spam.");
  if (!data.formTime || data.formTime < 3000) throw new Error("Túl gyors.");
  if (isRateLimited(data.userEmail)) throw new Error("Limit túllépve.");
  if (!data.userName || !data.userEmail || !data.medicines || data.medicines.length === 0) {
    throw new Error("Hiányzó adat.");
  }

  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(data.userEmail)) throw new Error("Érvénytelen email.");

  var orderId = generateOrderId_();

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");
  if (!sheet) throw new Error("GDPR_naplo munkalap nem található.");

  var listText = "";
  var listHtml = "";

  data.medicines.forEach(function (med, index) {
    listText += (index + 1) + ". " + med.name +
      "\nKiszerelés: " + med.pack +
      "\nMennyiség: " + med.quantity +
      "\nHatóanyag: " + med.hatoanyag +
      "\nKategória: " + med.status +
      (med.custom ? "\nEgyedi megnevezés: " + med.custom : "") +
      "\n\n";

    listHtml +=
      '<div style="margin-bottom:15px;">' +
      '<strong>' + (index + 1) + '. ' + med.name + '</strong><br>' +
      'Kiszerelés: ' + med.pack + '<br>' +
      'Mennyiség: ' + med.quantity + '<br>' +
      'Hatóanyag: ' + med.hatoanyag + '<br>' +
      'Kategória: ' + med.status + '<br>' +
      (med.custom ? ('Egyedi megnevezés: ' + med.custom) : '') +
      '</div>';
  });

  sheet.appendRow([
  new Date(),                 // A: Időbélyeg
  orderId,                    // B: Rendelésszám
  data.userName,              // C: Név
  data.userEmail,             // D: Email
  listText.trim(),            // E: Gyógyszer(ek)
  "IGEN",                     // F: GDPR elfogadva
  "FELDOLGOZATLAN",           // G: Státusz (alapértelmezett)
  new Date(),                 // H: Státusz időbélyeg (beérkezés ideje)
  "",                         // I: Várható érkezés dátum
  false                       // J: Várható dátum ismeretlen (TRUE/FALSE)
]);

  // Patikai értesítés (szöveges)
  MailApp.sendEmail(
    "recept.gyogyszertarmor@gmail.com",
    "ÚJ FOGLALÁS - " + orderId,
    "Rendelésszám: " + orderId + "\n\n" + listText +
    "Név: " + data.userName + "\n" +
    "Email: " + data.userEmail
  );

 // 🔗 törlés link (szép gombos)
var baseUrl = ScriptApp.getService().getUrl(); // mindig a tényleges webapp URL
var cancelUrl = baseUrl + "?orderId=" + encodeURIComponent(orderId);

var cancelLinkHtml =
  '<div style="margin:18px 0 8px; padding:14px; border:1px solid #fee2e2; background:#fff1f2; border-radius:12px; text-align:center;">' +
    '<a href="' + cancelUrl + '" ' +
       'style="display:inline-block; padding:10px 14px; border-radius:12px; background:#dc2626; color:#ffffff; text-decoration:none; font-weight:700;">' +
       'Foglalás törlése</a>' +
    '<div style="font-size:12px; color:#6b7280; margin-top:10px;">' +
      
    '</div>' +
  '</div>';

// Vásárlói email (HTML)
var htmlBodyCustomer =
  '<div style="font-family:Segoe UI, Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px;">' +

    '<h2 style="color:#28a745; text-align:center;">Receptfoglalását rögzítettük</h2>' +
    '<p style="text-align:center;"><strong>Rendelésszám:</strong><br>' + orderId + '</p>' +

    '<p>Tisztelt <strong>' + data.userName + '</strong>!</p>' +
    '<p>A foglalás egyelőre <strong>nem minősül megerősített rendelésnek</strong>. Hamarosan visszajelzünk az Ön email címére.</p>' +

    '<div style="background:#eafaf1; padding:15px; border-left:5px solid #28a745; border-radius:6px;">' +
      listHtml +
    '</div>' +

    // ✅ gyógyszerek alá, aláírás elé
    cancelLinkHtml +

    '<hr style="margin:20px 0;">' +
    '<p><strong>Szent György Gyógyszertár</strong><br>' +
      '8060 Mór, Köztársaság tér 1.<br>' +
      '📞 (06 22) 407 036</p>' +
      'H-P: 8:00 - 17:30  |  SZ: 8:00 - 12:00  |  V: Z' +
    '<p><a href="https://gyogyszertarmor.hu" target="_blank">www.gyogyszertarmor.hu</a></p>' +

  '</div>';


  MailApp.sendEmail({
    to: data.userEmail,
    subject: "Receptfoglalás rögzítve – " + orderId,
    htmlBody: htmlBodyCustomer
  });

  return { ok: true, orderId: orderId };
}

/* ===== ORDER ID ===== */

function generateOrderId_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
    const lastDate = props.getProperty("ORDER_SEQ_DATE");
    let seq = parseInt(props.getProperty("ORDER_SEQ_NUM") || "0", 10);
    if (lastDate !== today) seq = 0;
    seq++;
    props.setProperty("ORDER_SEQ_DATE", today);
    props.setProperty("ORDER_SEQ_NUM", String(seq));
    return `SGY-${today}-${String(seq).padStart(4, "0")}`;
  } finally {
    lock.releaseLock();
  }
}
function updateOrderStatusForAdmin(payload) {
  // payload: { rowNumber, newStatus, etaDate, etaUnknown }
  if (!payload) throw new Error("Hiányzó payload.");

  var rowNumber = parseInt(payload.rowNumber, 10);
  if (!rowNumber || rowNumber < 2) throw new Error("Hibás rowNumber.");

  var newStatus = String(payload.newStatus || "").trim().toUpperCase();
  if (!newStatus) throw new Error("Hiányzó státusz.");

  // Engedélyezett státuszok
  var ALLOWED = {
    "FELDOLGOZATLAN": true,
    "AZONNAL ÁTVEHETŐ": true,
    "NINCS KÉSZLETEN, DE RENDELHETŐ": true,
    "TERMÉKHIÁNY": true,
    "TELJESÍTVE": true,
    "TÖRÖLVE": true
  };
  if (!ALLOWED[newStatus]) throw new Error("Ismeretlen státusz: " + newStatus);

  var etaDate = (payload.etaDate || "").toString().trim();      // "YYYY-MM-DD"
  var etaUnknown = !!payload.etaUnknown;                        // true/false

  // Validáció extra mezőkre
  if (newStatus === "NINCS KÉSZLETEN, DE RENDELHETŐ") {
    if (!etaDate) throw new Error("Rendelhető státusznál kötelező a várható dátum.");
    etaUnknown = false;
  }
  if (newStatus === "TERMÉKHIÁNY") {
    // dátum vagy ismeretlen
    if (!etaDate && !etaUnknown) throw new Error("Termékhiánynál add meg a várható dátumot vagy jelöld ismeretlennek.");
  }
  // többi státusznál töröljük az ETA mezőket (hogy ne maradjon régi adat)
  if (newStatus !== "NINCS KÉSZLETEN, DE RENDELHETŐ" && newStatus !== "TERMÉKHIÁNY") {
    etaDate = "";
    etaUnknown = false;
  }

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");
  if (!sheet) throw new Error("GDPR_naplo munkalap nem található.");

  // Betöltjük a sort (A–J), hogy tudjunk emailt küldeni a vevőnek
  var row = sheet.getRange(rowNumber, 1, 1, 10).getValues()[0];

  var orderId = String(row[1] || "");
  var name = String(row[2] || "");
  var email = String(row[3] || "");
  var itemsText = String(row[4] || "");

  // Frissítés: G státusz, H időbélyeg, I dátum, J ismeretlen
  sheet.getRange(rowNumber, 7).setValue(newStatus);
  sheet.getRange(rowNumber, 8).setValue(new Date());
  sheet.getRange(rowNumber, 9).setValue(etaDate || "");
  sheet.getRange(rowNumber, 10).setValue(etaUnknown ? true : false);

  // Email logika: FELDOLGOZATLAN = nincs email
  if (email && newStatus !== "FELDOLGOZATLAN") {
    sendStatusEmail_(email, name, orderId, itemsText, newStatus, etaDate, etaUnknown);
  }

  return { ok: true };
}

function sendStatusEmail_(toEmail, customerName, orderId, itemsText, status, etaDate, etaUnknown) {
  var subj = "Receptfoglalás státusz frissítés – " + orderId;

  var statusLine = "";
  if (status === "AZONNAL ÁTVEHETŐ") {
    statusLine = "A foglalt készítmény(ek) átvehető(ek) a patikában.";
  } else if (status === "NINCS KÉSZLETEN, DE RENDELHETŐ") {
    statusLine = "A készítmény(ek) jelenleg nincs(nincsenek) készleten, de rendelhető(ek). Várható érkezés: <b>" + escapeHtml_(etaDate) + "</b>.";
  } else if (status === "TERMÉKHIÁNY") {
    statusLine = "Sajnos a termék(ek) jelenleg nem beszerezhető(ek). " +
      "Várható elérhetőség: <b>" + (etaUnknown ? "ismeretlen" : escapeHtml_(etaDate)) + "</b>.";
  } else if (status === "TELJESÍTVE") {
    statusLine = "A foglalás teljesítve lett.";
  } else if (status === "TÖRÖLVE") {
    statusLine = "A foglalás törölve lett.";
  } else {
    statusLine = "Státusz: " + escapeHtml_(status);
  }

  var disclaimer =
    "Vényköteles gyógyszer kizárólag érvényes orvosi vény ellenében váltható ki.";

  var html =
    '<div style="font-family:Segoe UI, Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px;">' +
      '<h2 style="margin:0 0 10px; color:#111827;">Státusz frissítés</h2>' +
      '<p>Tisztelt <strong>' + escapeHtml_(customerName || "") + '</strong>!</p>' +
      '<p><strong>Rendelésszám:</strong> ' + escapeHtml_(orderId) + '</p>' +
      '<p style="background:#f3f4f6; padding:12px; border-radius:10px; margin:14px 0;">' + statusLine + '</p>' +
      '<div style="white-space:pre-wrap; border:1px solid #e5e7eb; padding:12px; border-radius:10px;">' +
        '<strong>Foglalás tartalma:</strong>\n' + escapeHtml_(itemsText) +
      '</div>' +
      '<p style="margin-top:14px; color:#b45309; background:#fff7ed; border:1px solid #fed7aa; padding:10px 12px; border-radius:12px;">' +
        escapeHtml_(disclaimer) +
      '</p>' +
      '<hr style="margin:20px 0;">' +
      '<p><strong>Szent György Gyógyszertár</strong><br>8060 Mór, Köztársaság tér 1.<br>📞 (06 22) 407 036</p>' +
      'H-P: 8:00 - 17:30  |  SZ: 8:00 - 12:00  |  V: Z' +
      '<p><a href="https://gyogyszertarmor.hu" target="_blank">www.gyogyszertarmor.hu</a></p>' +
    '</div>';

  MailApp.sendEmail({
    to: toEmail,
    subject: subj,
    htmlBody: html
  });
}

function escapeHtml_(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===============================
// ===== ADMIN: STÁTUSZ MENTÉS ====
// ===============================

// Státuszok (egységesen)
var STATUS = {
  UNPROCESSED: "FELDOLGOZATLAN",
  READY: "AZONNAL ÁTVEHETŐ",
  ORDERABLE: "NINCS KÉSZLETEN, DE RENDELHETŐ",
  SHORTAGE: "TERMÉKHIÁNY",
  DONE: "TELJESÍTVE",
  CANCELED: "TÖRÖLVE"
};

// email HTML közös (gyógyszerek preformat + disclaimer + törlés link)
function buildStatusEmailHtml_(payload) {
  // payload: { name, orderId, itemsText, newStatusLabel, extraLineHtml, cancelUrl, footerNoteHtml }
  var safeName = payload.name || "";
  var safeItems = payload.itemsText || "";
  var safeStatus = payload.newStatusLabel || "";
  var safeOrderId = payload.orderId || "";

  var cancelLinkHtml =
    '<p style="text-align:center; margin:0 0 18px;">' +
      '<b>Foglalás törlése (rendelésszám alapján)</b><br>' +
      '<a href="' + payload.cancelUrl + '" style="color:#dc3545; font-weight:bold; text-decoration:none;">' +
        'Kattintson ide a foglalás törléséhez' +
      '</a>' +
    '</p>';

  var disclaimer =
    '<div style="background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; padding:10px 12px; border-radius:12px; font-size:13px; margin:14px 0;">' +
      'Vényköteles gyógyszer kizárólag érvényes orvosi vény ellenében váltható ki.' +
    '</div>';

  var extraLine = payload.extraLineHtml ? ('<p style="margin:10px 0; font-size:14px;">' + payload.extraLineHtml + '</p>') : '';
  var footerNote = payload.footerNoteHtml ? ('<p style="margin:10px 0 0; font-size:14px;">' + payload.footerNoteHtml + '</p>') : '';

  return ''
    + '<div style="font-family:Segoe UI, Arial, sans-serif; max-width:640px; margin:auto; padding:20px; border:1px solid #e5e7eb; border-radius:14px;">'
    + cancelLinkHtml
    + '<h2 style="margin:0 0 10px; color:#111827; text-align:center;">A rendelés státusza megváltozott</h2>'
    + '<p style="text-align:center; margin:0 0 12px; font-size:14px;">'
    +   '<b>Új státusz:</b> ' + safeStatus
    + '</p>'
    + '<p style="text-align:center; margin:0 0 12px; font-size:14px;">'
    +   '<b>Rendelésszám:</b><br>' + safeOrderId
    + '</p>'
    + '<p style="margin:0 0 10px; font-size:14px;">Tisztelt <b>' + safeName + '</b>!</p>'
    + extraLine
    + disclaimer
    + '<div style="background:#f9fafb; padding:14px; border-radius:12px; border:1px solid #e5e7eb;">'
    +   '<div style="font-weight:700; margin-bottom:8px;">Rendelt termékek</div>'
    +   '<div style="white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:13px; color:#111827;">'
    +     safeItems
    +   '</div>'
    + '</div>'
    + footerNote
    + '<hr style="margin:18px 0; border:none; border-top:1px solid #e5e7eb;">'
    + '<p style="margin:0; font-size:14px;"><b>Szent György Gyógyszertár</b><br>'
    + '8060 Mór, Köztársaság tér 1.<br>'
    + '📞 (06 22) 407 036</p>'
    + 'H-P: 8:00 - 17:30  |  SZ: 8:00 - 12:00  |  V: Z' +
    + '<p style="margin:10px 0 0;"><a href="https://gyogyszertarmor.hu" target="_blank">www.gyogyszertarmor.hu</a></p>'
    + '</div>';
}

function sendStatusEmail_(toEmail, subject, htmlBody) {
  MailApp.sendEmail({
    to: toEmail,
    subject: subject,
    htmlBody: htmlBody
  });
}

function parseDateToISO_(dateStr) {
  // dateStr: "YYYY-MM-DD"
  var s = String(dateStr || "").trim();
  if (!s) return "";
  // Apps Script Date konstruktor: new Date("2026-02-10") OK
  var d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d; // Date objektumként írjuk a sheetbe
}

/**
 * Admin státusz mentés + email küldés
 * data: {
 *   rowNumber: number,
 *   newStatus: string,
 *   etaDate: "YYYY-MM-DD" | "",
 *   etaUnknown: boolean,
 *   cancelReason: string (opcionális)
 * }
 */
function updateOrderStatus(data) {
  if (!data || !data.rowNumber) throw new Error("Hiányzó rowNumber.");
  var row = Number(data.rowNumber);
  if (!row || row < 2) throw new Error("Érvénytelen sor.");

  var newStatus = String(data.newStatus || "").trim();
  if (!newStatus) throw new Error("Hiányzó státusz.");

  var etaUnknown = (data.etaUnknown === true || String(data.etaUnknown).toUpperCase() === "TRUE");
  var etaDateStr = String(data.etaDate || "").trim();
  var cancelReason = String(data.cancelReason || "").trim();

  // Validáció
  if (newStatus === STATUS.ORDERABLE) {
    if (!etaDateStr) throw new Error("A 'RENDELHETŐ' státuszhoz kötelező a várható érkezés dátum.");
  }
  if (newStatus === STATUS.SHORTAGE) {
    if (!etaUnknown && !etaDateStr) throw new Error("A 'TERMÉKHIÁNY' státuszhoz dátum VAGY 'ismeretlen' szükséges.");
  }

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");
  if (!sheet) throw new Error("GDPR_naplo munkalap nem található.");

  // Olvassuk ki a rendelés adatait (A–J)
  var lastCol = sheet.getLastColumn();
  var numCols = Math.min(10, lastCol); // A–J
  var r = sheet.getRange(row, 1, 1, numCols).getValues()[0];

  var orderId = String(r[1] || "").trim(); // B
  var name = String(r[2] || "").trim();    // C
  var email = String(r[3] || "").trim();   // D
  var itemsText = String(r[4] || "").trim(); // E

  if (!orderId || !email) throw new Error("Hiányzó orderId/email a sorban.");

  // Sheet update: G státusz, H idő, I ETA dátum, J ETA unknown
  sheet.getRange(row, 7).setValue(newStatus);     // G
  sheet.getRange(row, 8).setValue(new Date());    // H

  var etaDateObj = parseDateToISO_(etaDateStr);

  if (newStatus === STATUS.ORDERABLE) {
    sheet.getRange(row, 9).setValue(etaDateObj);  // I kötelező
    sheet.getRange(row, 10).setValue(false);      // J
  } else if (newStatus === STATUS.SHORTAGE) {
    if (etaUnknown) {
      sheet.getRange(row, 9).setValue("");        // I
      sheet.getRange(row, 10).setValue(true);     // J
    } else {
      sheet.getRange(row, 9).setValue(etaDateObj);// I
      sheet.getRange(row, 10).setValue(false);    // J
    }
  } else {
    // többi státusz esetén ETA mezőket ürítjük (átlátható)
    sheet.getRange(row, 9).setValue("");
    sheet.getRange(row, 10).setValue(false);
  }

  // opcionális: törlés indok tárolása K oszlopban (11)
  if (newStatus === STATUS.CANCELED) {
    sheet.getRange(row, 11).setValue(cancelReason); // K (ha nincs, létrejön)
  }

  // Email összeállítás
  var baseUrl = ScriptApp.getService().getUrl();
  var cancelUrl = baseUrl + "?orderId=" + encodeURIComponent(orderId);

  var extra = "";
  var footer = "";

  if (newStatus === STATUS.READY) {
    extra = "A foglalásában szereplő termék(ek) <b>átvehető(ek) a patikában</b>.";
  } else if (newStatus === STATUS.ORDERABLE) {
    extra = "A termék(ek) jelenleg <b>nincs(enek) készleten</b>, de <b>rendelhető(ek)</b>.";
    extra += "<br><b>Várható érkezés:</b> " + etaDateStr;
  } else if (newStatus === STATUS.SHORTAGE) {
    extra = "Sajnos a termék jelenleg <b>nem beszerezhető</b> (termékhiány).";
    extra += "<br><b>Várható:</b> " + (etaUnknown ? "ismeretlen" : etaDateStr);
  } else if (newStatus === STATUS.DONE) {
    extra = "A rendelést <b>teljesítettük</b>.";
    footer = "Köszönjük szépen, hogy minket választott.";
  } else if (newStatus === STATUS.CANCELED) {
    extra = "A rendelést <b>töröltük</b>.";
    if (cancelReason) extra += "<br><b>Indoklás:</b> " + cancelReason;
  }

  var subject = "Rendelés státusza megváltozott – " + orderId;

  var html = buildStatusEmailHtml_({
    name: name,
    orderId: orderId,
    itemsText: itemsText,
    newStatusLabel: newStatus,
    extraLineHtml: extra,
    cancelUrl: cancelUrl,
    footerNoteHtml: footer
  });

  sendStatusEmail_(email, subject, html);

  return { ok: true };
}


/*******************************
 * ADMIN: státusz mentés + email
 *******************************/

function updateOrderStatusAdmin(payload) {
  assertAdmin_(payload && payload.adminToken);
  payload = payload || {};
  var orderId = String(payload.orderId || "").trim();
  var status = String(payload.status || "").trim(); // AZONNAL_ATVEHETO / RENDELHETO / TERMEKHIANY / TELJESITVE / TOROLVE
  if (!orderId || !status) return { ok: false, message: "Hiányzó orderId vagy status." };

  // Normalizálás (frontend kódjai -> emberi feliratok a táblába)
  var statusHu = mapStatusToHu_(status);

  // validáció: rendelhető -> ETA kötelező, termékhiány -> ETA vagy ismeretlen
  var etaDate = String(payload.etaDate || "").trim();        // "YYYY-MM-DD" vagy ""
  var etaUnknown = !!payload.etaUnknown;                     // true/false

  if (status === "RENDELHETO") {
    if (etaUnknown) return { ok: false, message: "RENDELHETŐ esetén nem lehet ismeretlen ETA." };
    if (!etaDate) return { ok: false, message: "RENDELHETŐ esetén kötelező ETA dátum." };
  }
  if (status === "TERMEKHIANY") {
    // lehet üres + ismeretlen false is, de email szempontból jobb, ha legalább az egyik:
    // nem erőltetjük, de ha mindkettő üres/false, akkor csak "ismeretlen" jelleggel kommunikál.
  }

  var note = String(payload.note || "").trim(); // opcionális megjegyzés (emailbe)
  var cancelReason = String(payload.cancelReason || "").trim();

  var substituteAvailable = !!payload.substituteAvailable;
  var substituteOrderable = !!payload.substituteOrderable;
  var substituteEtaDate = String(payload.substituteEtaDate || "").trim();

  if (substituteOrderable && !substituteEtaDate) {
    return { ok: false, message: "Helyettesítő rendelhető esetén kötelező a helyettesítő ETA dátum." };
  }

  // Sheet + sor megkeresés
  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");
  if (!sheet) return { ok: false, message: "GDPR_naplo munkalap nem található." };

  var row = findRowByOrderId_(sheet, orderId);
  if (!row) return { ok: false, message: "Nem található rendelés ezzel az orderId-val: " + orderId };

  // adatok a sorból emailhez
  var rowValues = sheet.getRange(row, 1, 1, Math.min(10, sheet.getLastColumn())).getValues()[0];
  var customerName = String(rowValues[2] || "Vásárló").trim();
  var customerEmail = String(rowValues[3] || "").trim();
  var itemsText = String(rowValues[4] || "").trim();
// ===== DUPLA EMAIL VÉDELEM: ha nincs tényleges változás, alapból NE küldjünk emailt =====
var currentStatus = String(rowValues[6] || "").trim().toUpperCase();     // G
var currentEtaDate = String(rowValues[8] || "").trim();                  // I
var currentEtaUnknown = (rowValues[9] === true || String(rowValues[9]).toUpperCase() === "TRUE"); // J

var nextStatus = String(statusHu || "").trim().toUpperCase();
var nextEtaDate = String(etaDate || "").trim();
var nextEtaUnknown = !!etaUnknown;

var isSame =
  currentStatus === nextStatus &&
  currentEtaDate === nextEtaDate &&
  currentEtaUnknown === nextEtaUnknown;

var forceSend = !!payload.forceSend;

if (isSame && !forceSend) {
  return {
    ok: false,
    code: "NO_CHANGE",
    message: "A státusz nem változik. Ha mégis szeretnél emailt küldeni, erősítsd meg.",
    current: { status: currentStatus, etaDate: currentEtaDate, etaUnknown: currentEtaUnknown }
  };
}

  if (!customerEmail) return { ok: false, message: "Hiányzik a vásárló email címe a sorból." };

  // Mentés: G=státusz, H=időbélyeg, I=ETA, J=ETA ismeretlen
  var now = new Date();

// csak akkor mentsünk, ha tényleg változott valami
if (!isSame) {
  sheet.getRange(row, 7).setValue(statusHu);                 // G
  sheet.getRange(row, 8).setValue(now);                      // H
  sheet.getRange(row, 9).setValue(etaDate);                  // I
  sheet.getRange(row, 10).setValue(etaUnknown ? true : false); // J
}

// törlés indok (K) maradhat ugyanúgy, ha nálad már van
if (status === "TOROLVE" && cancelReason) {
  sheet.getRange(row, 11).setValue(cancelReason);
}


  // Email küldés (minden státuszváltásnál, beleértve TÖRÖLVE)
  sendStatusEmailToCustomer_({
    to: customerEmail,
    name: customerName,
    orderId: orderId,
    itemsText: itemsText,
    statusCode: status,
    statusHu: statusHu,
    etaDate: etaDate,
    etaUnknown: etaUnknown,
    note: note,
    cancelReason: cancelReason,
    substituteAvailable: substituteAvailable,
    substituteOrderable: substituteOrderable,
    substituteEtaDate: substituteEtaDate,
    isCustomerSelfCancel: false
  });

  return { ok: true };
}

/*******************************
 * TÖRLÉS (vásárló oldalról) — összegyúrva emaillel
 *******************************/
function cancelBooking(data) {
  data = data || {};
  var orderId = String(data.orderId || "").trim();
  var email = String(data.email || "").trim().toLowerCase();

  if (!orderId || !email) return { ok: false, message: "Hiányzó adat." };

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");
  if (!sheet) return { ok: false, message: "GDPR_naplo munkalap nem található." };

  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    var rowOrderId = String(values[i][1] || "").trim();
    var rowEmail = String(values[i][3] || "").trim().toLowerCase();
    var rowStatus = String(values[i][6] || "").trim().toUpperCase(); // G
    var rowName = String(values[i][2] || "Vásárló").trim();
    var itemsText = String(values[i][4] || "").trim();

    if (rowOrderId === orderId && rowEmail === email) {
      if (rowStatus === "TÖRÖLVE") {
        return { ok: true, message: "A foglalás már törölve van." };
      }

      // státusz beállítás
      sheet.getRange(i + 1, 7).setValue("TÖRÖLVE"); // G
      sheet.getRange(i + 1, 8).setValue(new Date()); // H

      // email a vásárlónak: sikeres visszavonás
      sendStatusEmailToCustomer_({
        to: email,
        name: rowName,
        orderId: orderId,
        itemsText: itemsText,
        statusCode: "TOROLVE",
        statusHu: "TÖRÖLVE",
        etaDate: "",
        etaUnknown: false,
        note: "",
        cancelReason: "",
        substituteAvailable: false,
        substituteOrderable: false,
        substituteEtaDate: "",
        isCustomerSelfCancel: true
      });

      return { ok: true, message: "Foglalás törölve." };
    }
  }

  return { ok: false, message: "Nem található." };
}

/*******************************
 * EMAIL segédek
 *******************************/
function sendStatusEmailToCustomer_(ctx) {
  // ctx: {to,name,orderId,itemsText,statusCode,statusHu,etaDate,etaUnknown,note,cancelReason,substituteAvailable,substituteOrderable,substituteEtaDate,isCustomerSelfCancel}
  var to = ctx.to;
  var name = ctx.name || "Vásárló";
  var orderId = ctx.orderId;
  var itemsText = ctx.itemsText || "";
  var statusHu = ctx.statusHu || mapStatusToHu_(ctx.statusCode);
  var statusCode = ctx.statusCode || "";

  var cancelUrl = buildCancelUrl_(orderId);

  var subject = "Rendelés státusza megváltozott – " + orderId + " (" + statusHu + ")";

  // státusz-specifikus fő üzenet
  var mainMsg = "";
  if (statusCode === "AZONNAL_ATVEHETO") {
    mainMsg = "Örömmel jelezzük, hogy a foglalt termék(ek) <b>azonnal átvehető(ek)</b> a gyógyszertárban. A foglalás érvényes ezen email érkezése utáni munkanap végéig.";
  } else if (statusCode === "RENDELHETO") {
    mainMsg = "A foglalt termék jelenleg <b>nincs készleten, de rendelhető</b>. A foglalás érvényes a tényleges beérkezés utáni munkanap végéig. A várható érkezési időpont tájékoztató jellegű, nem garantált.";
  } else if (statusCode === "TERMEKHIANY") {
    mainMsg = "Sajnos a foglalt termék jelenleg <b>nem beszerezhető</b> (termékhiány). A várható érkezési időpont tájékoztató jellegű, nem garantált.";
  } else if (statusCode === "TELJESITVE") {
    mainMsg = "A foglalást <b>teljesítettük</b>. Köszönjük szépen, hogy minket választott!";
  } else if (statusCode === "TOROLVE") {
    mainMsg = ctx.isCustomerSelfCancel
      ? "Ön <b>sikeresen visszavonta</b> a foglalását."
      : "A foglalást <b>töröltük</b>.";
  } else {
    mainMsg = "A foglalás státusza frissült.";
  }

  // ETA blokk
  var etaLine = "";
  if (statusCode === "RENDELHETO" || statusCode === "TERMEKHIANY") {
    if (ctx.etaUnknown) {
      etaLine = "<p><b>Várható érkezés:</b> ismeretlen</p>";
    } else if (ctx.etaDate) {
      etaLine = "<p><b>Várható érkezés:</b> " + escapeHtml_(ctx.etaDate) + "</p>";
    }
  }

  // Helyettesítő blokk
  var subLines = "";
  if ((statusCode === "RENDELHETO" || statusCode === "TERMEKHIANY") && (ctx.substituteAvailable || ctx.substituteOrderable)) {
    subLines += "<div style='margin-top:10px; padding:12px; background:#f3f4f6; border-radius:10px;'>";
    subLines += "<b>Helyettesítő készítmény:</b><br>";
    if (ctx.substituteAvailable) subLines += "• elérhető a gyógyszertárban<br>";
    if (ctx.substituteOrderable) {
      subLines += "• rendelhető";
      if (ctx.substituteEtaDate) subLines += " (várható: " + escapeHtml_(ctx.substituteEtaDate) + ")";
      subLines += "<br>";
    }
    subLines += "</div>";
  }

  // Megjegyzés blokk
  var noteBlock = "";
  if (ctx.note) {
    noteBlock = "<div style='margin-top:10px; padding:12px; background:#fff7ed; border:1px solid #fed7aa; border-radius:10px;'>" +
      "<b>Megjegyzés:</b><br>" + escapeHtml_(ctx.note).replace(/\n/g, "<br>") +
    "</div>";
  }

  // Törlés indoklás blokk (admin törlésnél)
  var cancelReasonBlock = "";
  if (statusCode === "TOROLVE" && !ctx.isCustomerSelfCancel && ctx.cancelReason) {
    cancelReasonBlock = "<div style='margin-top:10px; padding:12px; background:#fef2f2; border:1px solid #fecaca; border-radius:10px;'>" +
      "<b>Törlés indoklása:</b><br>" + escapeHtml_(ctx.cancelReason).replace(/\n/g, "<br>") +
    "</div>";
  }

  // recept figyelmeztetés (kérted, hogy legyen mindig)
  var rxLine = "<p style='margin-top:12px; color:#374151;'><b>Fontos:</b> vényköteles gyógyszer kizárólag érvényes orvosi vény bemutatásával váltható ki.</p>";

  // törlési link (mindig)
  var cancelLinkHtml =
    "<p style='text-align:center; margin:18px 0;'>" +
      "<a href='" + cancelUrl + "' style='display:inline-block; padding:10px 14px; border-radius:10px; background:#dc2626; color:#fff; text-decoration:none; font-weight:600;'>" +
        "Foglalás törlése" +
      "</a>" +
    "</p>";

  var html =
    "<div style='font-family:Segoe UI, Arial, sans-serif; max-width:640px; margin:auto; padding:20px; border:1px solid #e5e7eb; border-radius:14px; background:#ffffff;'>" +
      "<h2 style='margin:0 0 10px; color:#111827;'>Rendelés státusza megváltozott</h2>" +
      "<p>Tisztelt <b>" + escapeHtml_(name) + "</b>!</p>" +
      "<p>" + mainMsg + "</p>" +
      "<p><b>Rendelésszám:</b> " + escapeHtml_(orderId) + "</p>" +
      "<p><b>Új státusz:</b> " + escapeHtml_(statusHu) + "</p>" +
      etaLine +
      "<div style='margin-top:12px; padding:12px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:12px;'>" +
        "<b>Foglalt termékek:</b><div style='white-space:pre-wrap; margin-top:8px;'>" + escapeHtml_(itemsText) + "</div>" +
      "</div>" +
      subLines +
      noteBlock +
      cancelReasonBlock +
      rxLine +
      cancelLinkHtml +
      "<hr style='border:none; border-top:1px solid #e5e7eb; margin:18px 0;'>" +
      "<p style='margin:0;'><b>Szent György Gyógyszertár</b><br>8060 Mór, Köztársaság tér 1.<br>📞 (06 22) 407 036</p>" +
      
      "<p style='margin:10px 0 0;'><a href='https://gyogyszertarmor.hu' target='_blank'>www.gyogyszertarmor.hu</a></p>" +
    "</div>";

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: html
  });
}

function buildCancelUrl_(orderId) {
  // ugyanaz a link logika, mint az automata emailnél
  // (itt fixen a WEBAPP_URL-t használjuk, hogy biztos az aktuális deploy legyen)
  var baseUrl = (typeof WEBAPP_URL !== "undefined" && WEBAPP_URL) ? WEBAPP_URL : ScriptApp.getService().getUrl();
  return baseUrl + "?orderId=" + encodeURIComponent(orderId);
}

function mapStatusToHu_(code) {
  var c = String(code || "").trim().toUpperCase();
  if (c === "AZONNAL_ATVEHETO") return "AZONNAL ÁTVEHETŐ";
  if (c === "RENDELHETO") return "NINCS KÉSZLETEN, DE RENDELHETŐ";
  if (c === "TERMEKHIANY") return "TERMÉKHIÁNY";
  if (c === "TELJESITVE") return "TELJESÍTVE";
  if (c === "TOROLVE") return "TÖRÖLVE";
  return "FELDOLGOZATLAN";
}

function escapeHtml_(s) {
  return String(s ?? "").replace(/[&<>"']/g, function(m) {
    return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[m];
  });
}

function findRowByOrderId_(sheet, orderId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  // B oszlop: OrderID
  var vals = sheet.getRange(2, 2, lastRow - 1, 1).getValues(); // [ [orderId], ... ]
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").trim() === orderId) return i + 2;
  }
  return 0;
}
/*******************************
 * ADMIN ÉRTESÍTÉSEK (Sheet alapú)
 *******************************/

function getAdminNotifications(adminToken) {
  assertAdmin_(adminToken);

  var orders = getOrdersForAdmin(adminToken) || [];
  // generálás + sheet-be mentés (duplikáció nélkül)
  generateNotificationsFromOrders_(orders);

  // visszaolvasás: aktív + archiv
  return readNotifications_();
}

function archiveAdminNotification(adminToken, notifId, archived) {
  assertAdmin_(adminToken);

  notifId = String(notifId || "").trim();
  if (!notifId) return { ok:false, message:"Hiányzó notifId." };

  var sh = ensureNotifsSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok:false, message:"Nincs értesítés." };

  var idCol = 1;        // A
  var archivedCol = 6;  // F
  var archivedAtCol = 7;// G

  var values = sh.getRange(2, 1, lastRow - 1, 7).getValues();
  for (var i=0; i<values.length; i++) {
    var rowId = String(values[i][0] || "");
    if (rowId === notifId) {
      sh.getRange(i+2, archivedCol).setValue(archived ? true : false);
      sh.getRange(i+2, archivedAtCol).setValue(archived ? new Date() : "");
      return { ok:true };
    }
  }
  return { ok:false, message:"Nem található notifId." };
}

function ensureNotifsSheet_() {
  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sh = ss.getSheetByName("ADMIN_ertesitesek");
  if (!sh) {
    sh = ss.insertSheet("ADMIN_ertesitesek");
    sh.appendRow(["id","createdAt","orderId","type","message","archived","archivedAt"]);
  }
  return sh;
}

function readNotifications_() {
  var sh = ensureNotifsSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { active:[], archived:[] };

  var values = sh.getRange(2,1,lastRow-1,7).getValues();
  var active = [];
  var archived = [];

  for (var i=0; i<values.length; i++) {
    var r = values[i];
    var obj = {
      id: String(r[0] || ""),
      createdAt: r[1] ? String(r[1]) : "",
      orderId: String(r[2] || ""),
      type: String(r[3] || ""),
      message: String(r[4] || ""),
      archived: (r[5] === true || String(r[5]).toUpperCase() === "TRUE"),
      archivedAt: r[6] ? String(r[6]) : ""
    };
    if (obj.archived) archived.push(obj);
    else active.push(obj);
  }

  // aktív: createdAt csökkenő (legfrissebb elöl)
  active.sort(function(a,b){
    return (Date.parse(b.createdAt)||0) - (Date.parse(a.createdAt)||0);
  });

  // archivált: archivedAt csökkenő (legfrissebb archivált elöl)
  archived.sort(function(a,b){
    return (Date.parse(b.archivedAt)||0) - (Date.parse(a.archivedAt)||0);
  });

  return { active:active, archived:archived };
}

function generateNotificationsFromOrders_(orders) {
  var sh = ensureNotifsSheet_();
  var now = new Date();

  // meglévő ID-k, hogy ne duplikáljunk
  var existing = Object.create(null);
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var ids = sh.getRange(2,1,lastRow-1,1).getValues();
    for (var i=0;i<ids.length;i++) {
      var id = String(ids[i][0] || "");
      if (id) existing[id] = true;
    }
  }

  // segéd: ma YYYY-MM-DD
  var todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");

  for (var k=0; k<orders.length; k++) {
    var o = orders[k] || {};
    var orderId = String(o.orderId || "").trim();
    if (!orderId) continue;

    var status = String(o.status || "").toUpperCase();
    var statusTimeStr = String(o.statusTime || "");
    var etaDate = String(o.etaDate || "").trim();              // "YYYY-MM-DD" (nálad így tárolod)
    var etaUnknown = !!o.etaUnknown;

    // opcionális: helyettesítő ETA (ha nálad van a payloadból és a sheetbe mented; ha nincs, akkor üresen marad)
    var subEta = String(o.substituteEtaDate || "").trim();     // ha később hozzáadod a getOrdersForAdmin-hoz

    // 1) ETA eljött: RENDELHETO / TERMEKHIANY
    if ((status.indexOf("RENDEL") !== -1 || status.indexOf("TERMÉK") !== -1 || status.indexOf("TERMEK") !== -1) && etaDate) {
      if (etaDate <= todayStr) {
        var id1 = makeNotifId_(orderId, "ETA_DUE", etaDate);
        if (!existing[id1]) {
          existing[id1] = true;
          sh.appendRow([
            id1,
            new Date(),
            orderId,
            "ETA_DUE",
            "ETA eljött (" + etaDate + "). Állapot: " + status + ".",
            false,
            ""
          ]);
        }
      }
    }

    // 2) Helyettesítő ETA eljött
    if (subEta) {
      if (subEta <= todayStr) {
        var id2 = makeNotifId_(orderId, "SUB_ETA_DUE", subEta);
        if (!existing[id2]) {
          existing[id2] = true;
          sh.appendRow([
            id2,
            new Date(),
            orderId,
            "SUB_ETA_DUE",
            "Helyettesítő készítmény ETA eljött (" + subEta + ").",
            false,
            ""
          ]);
        }
      }
    }

    // 3) AZONNAL ÁTVEHETŐ → következő munkanap 16:00 után jelzés, hogy aznap munkaidővégével “lejár”
    if (status.indexOf("AZONNAL") !== -1) {
      var statusTime = safeParseDate_(statusTimeStr);
      if (statusTime) {
        var expiryAt = nextBusinessDay16_(statusTime);
        if (now.getTime() >= expiryAt.getTime()) {
          var id3 = makeNotifId_(orderId, "AZONNAL_EXPIRES_TODAY", Utilities.formatDate(expiryAt, Session.getScriptTimeZone(), "yyyy-MM-dd"));
          if (!existing[id3]) {
            existing[id3] = true;
            sh.appendRow([
              id3,
              new Date(),
              orderId,
              "AZONNAL_EXPIRES_TODAY",
              "Azonnal átvehető státusz lejár ma munkaidő végével. Azonnal átvehetőre állítva: " + Utilities.formatDate(statusTime, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm"),
              false,
              ""
            ]);
          }
        }
      }
    }
  }
}

function makeNotifId_(orderId, type, extra) {
  return String(orderId) + "|" + String(type) + "|" + String(extra || "");
}

function safeParseDate_(s) {
  s = String(s || "").trim();
  if (!s) return null;
  var t = Date.parse(s);
  if (!isNaN(t)) return new Date(t);
  // fallback: ha Apps Script Date objectból stringify
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  } catch(e) {}
  return null;
}

function nextBusinessDay16_(fromDate) {
  // fromDate utáni következő munkanap 16:00 (HUN)
  var d = new Date(fromDate.getTime());
  d.setDate(d.getDate() + 1);

  // 0=vas,6=szo → ugrunk hétfőig
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }

  d.setHours(16, 0, 0, 0);
  return d;
}


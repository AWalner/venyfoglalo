function doGet(e) {

  if (e && e.parameter && e.parameter.page == "adatkezeles") {
    return HtmlService.createHtmlOutputFromFile('adatkezeles')
      .setTitle('Adatkezelési tájékoztató');
  }

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Patikai Vényfoglaló')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function getAppUrl_() {
  return ScriptApp.getService().getUrl();
}
/* ============================= */
/* ===== SPAM VÉDELEM RÉSZ ===== */
/* ============================= */

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

// ===== KERESÉS: ékezet-eltávolítás + token match + cache =====

function normalizeHu_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")                 // ékezetek szétbontása
    .replace(/[\u0300-\u036f]/g, "")  // ékezet jelek törlése
    .replace(/[^a-z0-9\s]/g, " ")     // írásjelek -> szóköz
    .replace(/\s+/g, " ")            // több szóköz összevonás
    .trim();
}

function getMedicinesIndex_() {
  // Cache 20 percre (nagy gyorsulás)
  var cache = CacheService.getScriptCache();
  var cached = cache.get("MED_INDEX_V1");
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // Csak az A (név) és D (kiadhatóság) oszlop kell
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();

  var seen = {};
  var index = [];
  for (var i = 0; i < values.length; i++) {
    var name = values[i][0];
    var kiadhatosag = values[i][3];
    if (!name || !kiadhatosag) continue;

    if (!seen[name]) {
      seen[name] = true;
      index.push({
        name: name,
        norm: normalizeHu_(name)
      });
    }
  }

  cache.put("MED_INDEX_V1", JSON.stringify(index), 20 * 60);
  return index;
}

/* ===== GYÓGYSZER KERESÉS (JAVÍTOTT) ===== */
function getUniqueMedicines(searchQuery) {
  var q = normalizeHu_(searchQuery);

  // 2 karakter alatt ne keressünk (gyorsaság)
  if (!q || q.length < 2) return [];

  var tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  var index = getMedicinesIndex_();

  // Token-alapú találat + "prefix" bónusz
  var scored = [];
  for (var i = 0; i < index.length; i++) {
    var item = index[i];
    var hay = item.norm;

    // minden tokennek szerepelnie kell
    var ok = true;
    for (var t = 0; t < tokens.length; t++) {
      if (hay.indexOf(tokens[t]) === -1) { ok = false; break; }
    }
    if (!ok) continue;

    // pontozás: prefix + rövidebb név előny
    var score = 0;
    if (hay.indexOf(q) === 0) score += 100;           // teljes lekérdezés prefix
    if (hay.indexOf(tokens[0]) === 0) score += 40;    // első token prefix
    score += Math.max(0, 30 - hay.length);            // rövidebb név előny

    scored.push({ name: item.name, score: score });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name, "hu");
  });

  // max 8 találat
  var out = [];
  for (var k = 0; k < scored.length && out.length < 8; k++) {
    out.push(scored[k].name);
  }
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
  if (!data.userName || !data.userEmail || !data.medicines || data.medicines.length === 0)
    throw new Error("Hiányzó adat.");

  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(data.userEmail)) throw new Error("Érvénytelen email.");

  var orderId = generateOrderId_();

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");

  var listText = "";
  var listHtml = "";

  data.medicines.forEach(function(med, index) {
    listText += (index + 1) + ". " + med.name +
      "\nKiszerelés: " + med.pack +
      "\nMennyiség: " + med.quantity +
      "\nHatóanyag: " + med.hatoanyag +
      "\nKategória: " + med.status +
      (med.custom ? "\nEgyedi megnevezés: " + med.custom : "") +
      "\n\n";

    listHtml += `
      <div style="margin-bottom:15px;">
        <strong>${index + 1}. ${med.name}</strong><br>
        Kiszerelés: ${med.pack}<br>
        Mennyiség: ${med.quantity}<br>
        Hatóanyag: ${med.hatoanyag}<br>
        Kategória: ${med.status}<br>
        ${med.custom ? "Egyedi megnevezés: " + med.custom : ""}
      </div>`;
  });

  sheet.appendRow([
    new Date(),
    orderId,
    data.userName,
    data.userEmail,
    listText.trim(),
    "IGEN",
    "",
    ""
  ]);

  MailApp.sendEmail(
    "recept.gyogyszertarmor@gmail.com",
    "ÚJ FOGLALÁS - " + orderId,
    "Rendelésszám: " + orderId + "\n\n" + listText +
    "Név: " + data.userName + "\nEmail: " + data.userEmail
  );

  var baseUrl = ScriptApp.getService().getUrl();
  var cancelUrl = baseUrl + "?orderId=" + encodeURIComponent(orderId);

  var cancelLinkHtml =
    '<p style="text-align:center; margin-bottom:20px;">' +
    '<b>Foglalás törlése (rendelésszám alapján)</b><br>' +
    '<a href="' + cancelUrl + '" style="color:#dc3545; font-weight:bold;">' +
    'Kattintson ide a foglalás törléséhez</a></p>';

  var htmlBodyCustomer = `
<div style="font-family:Segoe UI, Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px;">
${cancelLinkHtml}
<h2 style="color:#28a745; text-align:center;">Receptfoglalását rögzítettük</h2>

<p style="text-align:center;"><strong>Rendelésszám:</strong><br>${orderId}</p>

<p>Tisztelt <strong>${data.userName}</strong>!</p>

<p>A foglalás egyelőre nem minősül megerősített rendelésnek.</p>

<div style="background:#eafaf1; padding:15px; border-left:5px solid #28a745;">
${listHtml}
</div>

<hr>

<p><strong>Szent György Gyógyszertár</strong><br>
8060 Mór, Köztársaság tér 1.<br>
📞 (06 22) 407 036</p>

<p><a href="https://gyogyszertarmor.hu">www.gyogyszertarmor.hu</a></p>
</div>`;

  MailApp.sendEmail({
    to: data.userEmail,
    subject: "Receptfoglalás rögzítve – " + orderId,
    htmlBody: htmlBodyCustomer
  });

  return { ok: true, orderId: orderId };
}

/* ===== TÖRLÉS ===== */

function cancelBooking(data) {
  var orderId = (data.orderId || "").trim();
  var email = (data.email || "").trim().toLowerCase();

  if (!orderId || !email) return { ok: false, message: "Hiányzó adat." };

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");
  if (!sheet) return { ok: false, message: "GDPR_naplo munkalap nem található." };

  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    var rowOrderId = String(values[i][1] || "").trim();
    var rowEmail = String(values[i][3] || "").trim().toLowerCase();
    var rowStatus = String(values[i][6] || "").trim().toUpperCase(); // 7. oszlop

    if (rowOrderId === orderId && rowEmail === email) {
      if (rowStatus === "TÖRÖLVE") {
        return { ok: true, message: "A foglalás már törölve van." };
      }
      sheet.getRange(i + 1, 7).setValue("TÖRÖLVE");
      sheet.getRange(i + 1, 8).setValue(new Date());
      return { ok: true, message: "Foglalás törölve." };
    }
  }

  return { ok: false, message: "Nem található." };
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

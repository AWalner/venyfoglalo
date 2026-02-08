function doGet(e) {

  // Adatkezelési oldal
  if (e && e.parameter && e.parameter.page == "adatkezeles") {
    return HtmlService.createHtmlOutputFromFile('adatkezeles')
      .setTitle('Adatkezelési tájékoztató');
  }

  // Főoldal
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Patikai Vényfoglaló')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


/* ============================= */
/* ===== SPAM VÉDELEM RÉSZ ===== */
/* ============================= */

/* 10 perc / max 4 foglalás / email */

function isRateLimited(email) {

  var cache = CacheService.getScriptCache();
  var key = "booking_" + email.toLowerCase();
  var windowSeconds = 600; // 10 perc
  var maxAttempts = 4;

  var existing = cache.get(key);

  if (existing) {
    var count = parseInt(existing, 10);

    if (count >= maxAttempts) {
      return true;
    } else {
      cache.put(key, (count + 1).toString(), windowSeconds);
      return false;
    }
  }

  cache.put(key, "1", windowSeconds);
  return false;
}


/* ===== GYÓGYSZER KERESÉS ===== */

function getUniqueMedicines(searchQuery) {
  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheets()[0];
  var data = sheet.getRange("A2:D" + sheet.getLastRow()).getValues();

  searchQuery = searchQuery.toLowerCase();
  var results = [];
  var seen = {};

  for (var i = 0; i < data.length; i++) {
    var name = data[i][0];
    var kiadhatosag = data[i][3];

    if (name && kiadhatosag && name.toLowerCase().includes(searchQuery)) {
      if (!seen[name]) {
        results.push(name);
        seen[name] = true;
      }
    }
    if (results.length > 8) break;
  }

  return results;
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
/* ===== FOGLALÁS FELDOLGOZÁS (BŐVÍTETT) = */
/* ======================================= */

function processBooking(data) {

  /* ===== SZERVER OLDALI SPAM VÉDELEM ===== */

  if (data.honeypot && data.honeypot !== "") {
    throw new Error("Spam detected.");
  }

  if (!data.formTime || data.formTime < 3000) {
    throw new Error("Túl gyors beküldés.");
  }

  if (isRateLimited(data.userEmail)) {
    throw new Error("10 percen belül maximum 4 foglalás engedélyezett.");
  }

  if (!data.userName || !data.userEmail || !data.medicines || data.medicines.length === 0) {
    throw new Error("Hiányzó adatok.");
  }

  /* ===== EMAIL FORMÁTUM ELLENŐRZÉS ===== */

  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(data.userEmail)) {
    throw new Error("Érvénytelen email cím.");
  }

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var gdprSheet = ss.getSheetByName("GDPR_naplo");

  if (gdprSheet && data.medicines.length > 0) {

    var medListForLog = "";

    data.medicines.forEach(function(med, index) {

      medListForLog += (index + 1) + ". " + med.name +
                       " – " + med.pack +
                       " – " + med.quantity;

      if (med.custom && med.custom.trim() !== "") {
        medListForLog += " | Egyedi megnevezés: " + med.custom;
      }

      medListForLog += "\n";
    });

    gdprSheet.appendRow([
      new Date(),
      data.userName,
      data.userEmail,
      medListForLog.trim(),
      "IGEN"
    ]);
  }

  var listText = "";
  var listHtml = "";

  data.medicines.forEach(function(med, index) {

    listText += (index + 1) + ". " + med.name +
                "\nKiszerelés: " + med.pack +
                "\nMennyiség: " + med.quantity +
                "\nHatóanyag: " + med.hatoanyag +
                "\nKategória: " + med.status;

    if (med.custom && med.custom.trim() !== "") {
      listText += "\nEgyedi megnevezés: " + med.custom;
    }

    listText += "\n\n";

    listHtml += `
      <div style="margin-bottom:15px;">
        <strong>${index + 1}. ${med.name}</strong><br>
        Kiszerelés: ${med.pack}<br>
        Mennyiség: ${med.quantity}<br>
        Hatóanyag: ${med.hatoanyag}<br>
        Kategória: ${med.status}<br>
        ${med.custom && med.custom.trim() !== "" ? "<em>Egyedi megnevezés: " + med.custom + "</em><br>" : ""}
      </div>
    `;
  });

  MailApp.sendEmail(
    "recept.gyogyszertarmor@gmail.com",
    "ÚJ FOGLALÁS",
    listText +
    "Név: " + data.userName + "\n" +
    "Email: " + data.userEmail
  );

  var htmlBodyCustomer = `
<div style="font-family:Segoe UI, Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px;">
  
  <h2 style="color:#28a745; text-align:center;">
    Receptfoglalását rögzítettük
  </h2>

  <p>Tisztelt <strong>${data.userName}</strong>!</p>

  <p>
    Rendszerünkben rögzítettük az alábbi készítmény(ek) foglalását.<br>
    A foglalás egyelőre <strong>nem minősül megerősített rendelésnek</strong>.<br>
    Hamarosan visszajelzünk az Ön email címére.
  </p>

  <div style="margin:25px 0; padding:15px; background:#eafaf1; border-left:5px solid #28a745; border-radius:6px;">
    ${listHtml}
  </div>

  <div style="margin:20px 0; padding:15px; background:#fff3cd; border-left:5px solid #ffc107; border-radius:6px; font-size:14px;">
    Receptköteles gyógyszert kizárólag <strong>érvényes orvosi recept</strong> 
    ellenében áll módunkban kiadni.
  </div>

  <hr style="margin:25px 0;">

  <p style="font-size:14px;">
    <strong>Szent György Gyógyszertár</strong><br>
    8060 Mór, Köztársaság tér 1.<br>
    📞 (06 22) 407 036
  </p>

  <p style="font-size:14px;">
    🌐 
    <a href="https://gyogyszertarmor.hu" target="_blank"
       style="color:#28a745; font-weight:bold;">
       www.gyogyszertarmor.hu
    </a>
  </p>

</div>
`;

  MailApp.sendEmail({
    to: data.userEmail,
    subject: "Receptfoglalás rögzítve – Szent György Gyógyszertár",
    htmlBody: htmlBodyCustomer
  });
}


/* ===== AUTOMATIKUS 30 NAPOS TÖRLÉS ===== */

function autoDeleteOldBookings() {

  var ss = SpreadsheetApp.openById("1nFZqVz1ngIToHZGoO29ExH2sLTjsMy8nCBMETf4YHeU");
  var sheet = ss.getSheetByName("GDPR_naplo");

  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  var now = new Date();
  var limit = 30 * 24 * 60 * 60 * 1000;

  for (var i = data.length - 1; i > 0; i--) {
    var timestamp = data[i][0];
    if (timestamp instanceof Date) {
      if (now - timestamp > limit) {
        sheet.deleteRow(i + 1);
      }
    }
  }
}

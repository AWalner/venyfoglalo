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

  if (!customerEmail) return { ok: false, message: "Hiányzik a vásárló email címe a sorból." };

  // Mentés: G=státusz, H=időbélyeg, I=ETA, J=ETA ismeretlen
  var now = new Date();
  sheet.getRange(row, 7).setValue(statusHu);  // G
  sheet.getRange(row, 8).setValue(now);       // H
  sheet.getRange(row, 9).setValue(etaDate);   // I (szövegként is ok)
  sheet.getRange(row, 10).setValue(etaUnknown ? true : false); // J

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

/*
 * Punti in DXF - estensione per Trimble Connect
 *
 * Crea un file DXF a partire da un file di testo con una riga per punto:
 *     ID,E,N,Q,Code
 *
 * Tutta l'elaborazione avviene nel browser: il file non viene inviato a nessun server.
 * La pagina funziona anche aperta da sola, fuori da Trimble Connect.
 */
(function () {
  "use strict";

  // =====================================================================
  // 1. LETTURA DEL FILE DI TESTO
  // =====================================================================

  var SEPARATORI = [",", ";", "\t"];

  // Sceglie il separatore con cui, nelle prime righe, E e N risultano numeri.
  // A parita' vince la virgola.
  function trovaSeparatore(righe) {
    var migliore = ",";
    var massimo = 0;
    SEPARATORI.forEach(function (sep) {
      var conteggio = 0;
      righe.slice(0, 20).forEach(function (riga) {
        var campi = riga.split(sep);
        if (campi.length >= 3 &&
            !isNaN(leggiNumero(campi[1], sep !== ",")) &&
            !isNaN(leggiNumero(campi[2], sep !== ","))) conteggio++;
      });
      if (conteggio > massimo) {
        massimo = conteggio;
        migliore = sep;
      }
    });
    return migliore;
  }

  // Restituisce un numero, oppure NaN se il testo non e' un numero.
  function leggiNumero(testo, virgolaDecimale) {
    var t = String(testo == null ? "" : testo).trim();
    if (virgolaDecimale) t = t.replace(",", ".");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
    return Number(t);
  }

  /*
   * Legge il testo e restituisce:
   *   punti        elenco di { id, e, n, q, haQuota, codice, riga }
   *   errori       righe scartate: { riga, testo, motivo }
   *   intestazione true se la prima riga era un'intestazione (ignorata)
   *   senzaQuota   numero di punti senza quota (Q impostata a 0)
   *   separatore   separatore riconosciuto
   */
  function leggiPunti(testo) {
    var righe = String(testo || "").replace(/^﻿/, "").split(/\r\n|\n|\r/);

    var utili = [];
    righe.forEach(function (riga, i) {
      var t = riga.trim();
      if (t !== "" && t.charAt(0) !== "#") utili.push({ numero: i + 1, testo: t });
    });

    var separatore = trovaSeparatore(utili.map(function (r) { return r.testo; }));
    // Con ";" o tabulazione come separatore si accetta la virgola decimale.
    var virgolaDecimale = separatore !== ",";

    var risultato = {
      punti: [],
      errori: [],
      intestazione: false,
      senzaQuota: 0,
      separatore: separatore
    };

    utili.forEach(function (r, indice) {
      var grezzi = r.testo.split(separatore);
      var campi = grezzi.map(function (c) { return c.trim(); });

      if (campi.length < 3) {
        risultato.errori.push({ riga: r.numero, testo: r.testo, motivo: "servono almeno ID, E e N" });
        return;
      }

      var e = leggiNumero(campi[1], virgolaDecimale);
      var n = leggiNumero(campi[2], virgolaDecimale);

      if (isNaN(e) || isNaN(n)) {
        // Una prima riga con E e N entrambi testuali e' un'intestazione.
        if (indice === 0 && isNaN(e) && isNaN(n) && campi[1] !== "" && campi[2] !== "") {
          risultato.intestazione = true;
          return;
        }
        risultato.errori.push({ riga: r.numero, testo: r.testo, motivo: "E o N non numerici" });
        return;
      }

      var q = 0;
      var haQuota = !(campi[3] === undefined || campi[3] === "");
      if (!haQuota) {
        risultato.senzaQuota++;
      } else {
        q = leggiNumero(campi[3], virgolaDecimale);
        if (isNaN(q)) {
          risultato.errori.push({ riga: r.numero, testo: r.testo, motivo: "quota non numerica" });
          return;
        }
      }

      risultato.punti.push({
        id: campi[0],
        e: e,
        n: n,
        q: q,
        haQuota: haQuota,
        // Un codice che contiene il separatore viene ricomposto com'era scritto.
        codice: grezzi.slice(4).join(separatore).trim(),
        riga: r.numero
      });
    });

    return risultato;
  }

  // =====================================================================
  // 2. SCRITTURA DEL DXF (formato R12, letto da tutti i programmi CAD)
  // =====================================================================

  var LAYER_PREDEFINITO = "PUNTI";
  var LAYER_TESTO = { id: "TESTO_ID", quota: "TESTO_QUOTA", codice: "TESTO_CODICE" };
  var COLORI = [1, 2, 3, 4, 5, 6, 30, 90, 150, 210];

  function senzaAccenti(testo) {
    return String(testo == null ? "" : testo).normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Nome di layer valido in DXF R12: maiuscole, cifre, "_", "$", "-", massimo 31 caratteri.
  function nomeLayer(testo) {
    var s = senzaAccenti(testo).trim().toUpperCase().replace(/[^A-Z0-9_$-]/g, "_").slice(0, 31);
    return s || LAYER_PREDEFINITO;
  }

  // Testo su una sola riga e in soli caratteri ASCII.
  function testoDxf(testo) {
    return senzaAccenti(testo).replace(/[^\x20-\x7E]/g, "_");
  }

  function numero(n) {
    var s = n.toFixed(6).replace(/0+$/, "");
    if (s.charAt(s.length - 1) === ".") s += "0";
    return s === "-0.0" ? "0.0" : s;
  }

  /*
   * Crea il contenuto del file DXF.
   *
   * opzioni:
   *   layerPerCodice   true: un layer per ogni codice; false: tutti i punti sul layer PUNTI
   *   tridimensionale  true: Q diventa la quota Z; false: Z = 0
   *   etichettaId, etichettaQuota, etichettaCodice   testi da scrivere accanto al punto
   *   altezzaTesto     altezza dei testi, in unita' del disegno
   *   decimaliQuota    decimali dell'etichetta di quota
   */
  function creaDxf(punti, opzioni) {
    var o = {
      layerPerCodice: true,
      tridimensionale: true,
      etichettaId: true,
      etichettaQuota: true,
      etichettaCodice: true,
      altezzaTesto: 0.2,
      decimaliQuota: 2
    };
    Object.keys(opzioni || {}).forEach(function (k) { o[k] = opzioni[k]; });

    var h = o.altezzaTesto > 0 ? o.altezzaTesto : 0.2;
    var righe = [];
    function coppia(codice, valore) { righe.push(String(codice), String(valore)); }

    // ----- Layer e ingombro -----
    var layer = [{ nome: "0", colore: 7 }];
    var layerNoti = { "0": true };
    function aggiungiLayer(nome, colore) {
      if (layerNoti[nome]) return;
      layerNoti[nome] = true;
      layer.push({ nome: nome, colore: colore });
    }

    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    var layerDeiPunti = punti.map(function (p) {
      var nome = o.layerPerCodice ? nomeLayer(p.codice) : LAYER_PREDEFINITO;
      aggiungiLayer(nome, COLORI[(layer.length - 1) % COLORI.length]);
      var z = o.tridimensionale ? p.q : 0;
      [p.e, p.n, z].forEach(function (v, i) {
        if (v < min[i]) min[i] = v;
        if (v > max[i]) max[i] = v;
      });
      return nome;
    });
    if (!punti.length) { min = [0, 0, 0]; max = [0, 0, 0]; }

    if (o.etichettaId) aggiungiLayer(LAYER_TESTO.id, 7);
    if (o.etichettaQuota) aggiungiLayer(LAYER_TESTO.quota, 7);
    if (o.etichettaCodice) aggiungiLayer(LAYER_TESTO.codice, 7);

    // ----- Sezione HEADER -----
    coppia(0, "SECTION"); coppia(2, "HEADER");
    coppia(9, "$ACADVER"); coppia(1, "AC1009");
    coppia(9, "$EXTMIN"); coppia(10, numero(min[0])); coppia(20, numero(min[1])); coppia(30, numero(min[2]));
    coppia(9, "$EXTMAX"); coppia(10, numero(max[0])); coppia(20, numero(max[1])); coppia(30, numero(max[2]));
    // Punti disegnati come crocette, grandi quanto il testo, per essere visibili.
    coppia(9, "$PDMODE"); coppia(70, 3);
    coppia(9, "$PDSIZE"); coppia(40, numero(h));
    coppia(0, "ENDSEC");

    // ----- Sezione TABLES -----
    coppia(0, "SECTION"); coppia(2, "TABLES");

    coppia(0, "TABLE"); coppia(2, "LTYPE"); coppia(70, 1);
    coppia(0, "LTYPE"); coppia(2, "CONTINUOUS"); coppia(70, 0); coppia(3, "Solid line");
    coppia(72, 65); coppia(73, 0); coppia(40, "0.0");
    coppia(0, "ENDTAB");

    coppia(0, "TABLE"); coppia(2, "LAYER"); coppia(70, layer.length);
    layer.forEach(function (l) {
      coppia(0, "LAYER"); coppia(2, l.nome); coppia(70, 0); coppia(62, l.colore); coppia(6, "CONTINUOUS");
    });
    coppia(0, "ENDTAB");

    coppia(0, "TABLE"); coppia(2, "STYLE"); coppia(70, 1);
    coppia(0, "STYLE"); coppia(2, "STANDARD"); coppia(70, 0); coppia(40, "0.0"); coppia(41, "1.0");
    coppia(50, "0.0"); coppia(71, 0); coppia(42, numero(h)); coppia(3, "txt"); coppia(4, "");
    coppia(0, "ENDTAB");

    coppia(0, "ENDSEC");

    // ----- Sezione ENTITIES -----
    coppia(0, "SECTION"); coppia(2, "ENTITIES");

    function testo(nomeLayerTesto, x, y, z, contenuto) {
      coppia(0, "TEXT"); coppia(8, nomeLayerTesto);
      coppia(10, numero(x)); coppia(20, numero(y)); coppia(30, numero(z));
      coppia(40, numero(h)); coppia(1, testoDxf(contenuto));
    }

    punti.forEach(function (p, i) {
      var z = o.tridimensionale ? p.q : 0;

      coppia(0, "POINT"); coppia(8, layerDeiPunti[i]);
      coppia(10, numero(p.e)); coppia(20, numero(p.n)); coppia(30, numero(z));

      // Etichette impilate a destra del punto: ID in alto, poi quota, poi codice.
      var etichette = [];
      if (o.etichettaId && p.id !== "") etichette.push([LAYER_TESTO.id, p.id]);
      // Un punto senza quota nel file non riceve l'etichetta di quota.
      if (o.etichettaQuota && p.haQuota !== false) etichette.push([LAYER_TESTO.quota, p.q.toFixed(o.decimaliQuota)]);
      if (o.etichettaCodice && p.codice !== "") etichette.push([LAYER_TESTO.codice, p.codice]);
      etichette.forEach(function (et, k) {
        testo(et[0], p.e + h * 0.5, p.n + h * 0.4 - k * h * 1.4, z, et[1]);
      });
    });

    coppia(0, "ENDSEC");
    coppia(0, "EOF");

    return {
      contenuto: righe.join("\r\n") + "\r\n",
      layer: layer.length - 1 // senza il layer "0"
    };
  }

  // Funzioni disponibili anche ad altri script e alle prove.
  window.PuntiDxf = { leggiPunti: leggiPunti, creaDxf: creaDxf };

  // =====================================================================
  // 3. INTERFACCIA
  // =====================================================================

  function el(id) { return document.getElementById(id); }

  var dati = null;      // risultato di leggiPunti
  var nomeFile = "";    // nome del file scelto

  function mostraFile(file) {
    if (!file) return;
    nomeFile = file.name;
    el("esito").textContent = "";

    var lettore = new FileReader();
    lettore.onerror = function () {
      dati = null;
      el("crea").disabled = true;
      el("riepilogo").textContent = "Non riesco a leggere il file " + file.name + ".";
      el("riepilogo").className = "errore";
    };
    lettore.onload = function () {
      dati = leggiPunti(lettore.result);
      mostraRiepilogo();
    };
    lettore.readAsText(file);
  }

  function mostraRiepilogo() {
    var n = dati.punti.length;
    var parti = [nomeFile + ": " + n + (n === 1 ? " punto letto" : " punti letti")];
    if (dati.intestazione) parti.push("riga di intestazione ignorata");
    if (dati.senzaQuota) parti.push(dati.senzaQuota + " senza quota (Q = 0)");
    if (dati.errori.length) parti.push(dati.errori.length + (dati.errori.length === 1 ? " riga scartata" : " righe scartate"));

    el("riepilogo").textContent = parti.join(", ") + ".";
    el("riepilogo").className = n ? "" : "errore";
    el("crea").disabled = n === 0;

    // Righe scartate
    var elenco = el("elenco-scarti");
    elenco.textContent = "";
    dati.errori.slice(0, 50).forEach(function (err) {
      var li = document.createElement("li");
      li.textContent = "Riga " + err.riga + ": " + err.motivo + " (" + err.testo + ")";
      elenco.appendChild(li);
    });
    if (dati.errori.length > 50) {
      var altro = document.createElement("li");
      altro.textContent = "... e altre " + (dati.errori.length - 50) + " righe.";
      elenco.appendChild(altro);
    }
    el("scarti").hidden = dati.errori.length === 0;

    // Anteprima dei primi punti
    var corpo = el("anteprima-corpo");
    corpo.textContent = "";
    dati.punti.slice(0, 8).forEach(function (p) {
      var tr = document.createElement("tr");
      [p.id, numero(p.e), numero(p.n), p.haQuota ? numero(p.q) : "", p.codice].forEach(function (valore) {
        var td = document.createElement("td");
        td.textContent = valore;
        tr.appendChild(td);
      });
      corpo.appendChild(tr);
    });
    el("anteprima").hidden = n === 0;
    el("anteprima-nota").textContent = n > 8 ? "Primi 8 punti su " + n + "." : "";
  }

  function leggiOpzioni() {
    var altezza = parseFloat(String(el("altezza").value).replace(",", "."));
    var decimali = parseInt(el("decimali").value, 10);
    return {
      layerPerCodice: el("layer-codice").checked,
      tridimensionale: el("tre-d").checked,
      etichettaId: el("et-id").checked,
      etichettaQuota: el("et-quota").checked,
      etichettaCodice: el("et-codice").checked,
      altezzaTesto: altezza > 0 ? altezza : 0.2,
      decimaliQuota: decimali >= 0 && decimali <= 6 ? decimali : 2
    };
  }

  function scarica(nome, contenuto) {
    var blob = new Blob([contenuto], { type: "application/dxf" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function creaFile() {
    if (!dati || !dati.punti.length) return;
    var dxf = creaDxf(dati.punti, leggiOpzioni());
    var nome = nomeFile.replace(/\.[^.]*$/, "") + ".dxf";
    scarica(nome, dxf.contenuto);
    var n = dati.punti.length;
    el("esito").textContent = "Creato " + nome + ": " + n + (n === 1 ? " punto" : " punti") +
      " su " + dxf.layer + " layer.";
  }

  function avviaInterfaccia() {
    el("file").addEventListener("change", function (ev) { mostraFile(ev.target.files[0]); });
    el("crea").addEventListener("click", creaFile);

    // Trascinamento del file sulla zona di scelta
    var zona = el("zona");
    ["dragenter", "dragover"].forEach(function (tipo) {
      zona.addEventListener(tipo, function (ev) { ev.preventDefault(); zona.classList.add("sopra"); });
    });
    ["dragleave", "drop"].forEach(function (tipo) {
      zona.addEventListener(tipo, function (ev) { ev.preventDefault(); zona.classList.remove("sopra"); });
    });
    zona.addEventListener("drop", function (ev) {
      if (ev.dataTransfer && ev.dataTransfer.files.length) mostraFile(ev.dataTransfer.files[0]);
    });
  }

  // =====================================================================
  // 4. COLLEGAMENTO A TRIMBLE CONNECT
  // =====================================================================

  var WORKSPACE_API = "https://components.connect.trimble.com/trimble-connect-workspace-api/index.js";

  function caricaScript(url) {
    return new Promise(function (ok, errore) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = ok;
      s.onerror = function () { errore(new Error("Script non caricato: " + url)); };
      document.head.appendChild(s);
    });
  }

  function collegaTrimbleConnect() {
    // Pagina aperta da sola, fuori da Trimble Connect: niente da collegare.
    if (window.parent === window) return Promise.resolve();

    var stato = el("stato-connect");
    return caricaScript(WORKSPACE_API)
      .then(function () {
        return window.TrimbleConnectWorkspace.connect(window.parent, function () {}, 30000);
      })
      .then(function (API) {
        // Voce nel menu di navigazione del progetto
        return API.ui.setMenu({
          title: "Punti in DXF",
          icon: new URL("icon.svg", window.location.href).href,
          command: "punti_in_dxf"
        }).then(function () { return API.project.getCurrentProject(); });
      })
      .then(function (progetto) {
        stato.textContent = "Collegato a Trimble Connect" +
          (progetto && progetto.name ? ", progetto " + progetto.name + "." : ".");
        stato.hidden = false;
      })
      .catch(function (errore) {
        // La conversione non dipende dal collegamento.
        stato.textContent = "Collegamento a Trimble Connect non riuscito: la conversione funziona comunque.";
        stato.hidden = false;
        console.error(errore);
      });
  }

  avviaInterfaccia();
  collegaTrimbleConnect();
})();

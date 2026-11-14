/*
 * Punti in DXF - estensione per Trimble Connect
 *
 * Crea un file DXF a partire da un file di testo con una riga per punto:
 *     ID,E,N,Q,Code
 *
 * Il file si sceglie dal computer oppure, dentro Trimble Connect, tra i file del progetto.
 * Il DXF si scarica sul computer oppure, dentro Trimble Connect, si salva in una cartella del progetto.
 * L'elaborazione avviene nel browser: i dati non passano da altri server.
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

  // Messaggio sotto i pulsanti. Tipo: "" (riuscito), "attesa" oppure "errore".
  function esito(testo, tipo) {
    el("esito").textContent = testo || "";
    el("esito").className = tipo || "";
  }

  // I pulsanti del DXF sono attivi solo con almeno un punto letto.
  function abilitaAzioni() {
    var fermo = !(dati && dati.punti.length);
    el("crea").disabled = fermo;
    el("salva").disabled = fermo || invio;
  }

  // File scelto dal computer.
  function mostraFile(file) {
    if (!file) return;
    esito("");

    var lettore = new FileReader();
    lettore.onerror = function () {
      dati = null;
      abilitaAzioni();
      el("riepilogo").textContent = "Non riesco a leggere il file " + file.name + ".";
      el("riepilogo").className = "errore";
    };
    lettore.onload = function () { mostraTesto(file.name, lettore.result); };
    lettore.readAsText(file);
  }

  // Testo di un file, dal computer o dal progetto Trimble Connect.
  function mostraTesto(nome, testo) {
    nomeFile = nome;
    esito("");
    dati = leggiPunti(testo);
    mostraRiepilogo();
  }

  function mostraRiepilogo() {
    var n = dati.punti.length;
    var parti = [nomeFile + ": " + n + (n === 1 ? " punto letto" : " punti letti")];
    if (dati.intestazione) parti.push("riga di intestazione ignorata");
    if (dati.senzaQuota) parti.push(dati.senzaQuota + " senza quota (Q = 0)");
    if (dati.errori.length) parti.push(dati.errori.length + (dati.errori.length === 1 ? " riga scartata" : " righe scartate"));

    el("riepilogo").textContent = parti.join(", ") + ".";
    el("riepilogo").className = n ? "" : "errore";
    abilitaAzioni();

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

  // Nome del DXF: quello del file di partenza, con estensione .dxf.
  function nomeDxf() { return nomeFile.replace(/\.[^.]*$/, "") + ".dxf"; }

  function contaPunti(n) { return n + (n === 1 ? " punto" : " punti"); }

  function creaFile() {
    if (!dati || !dati.punti.length) return;
    var dxf = creaDxf(dati.punti, leggiOpzioni());
    var nome = nomeDxf();
    scarica(nome, dxf.contenuto);
    esito("Creato " + nome + ": " + contaPunti(dati.punti.length) + " su " + dxf.layer + " layer.");
  }

  function avviaInterfaccia() {
    el("file").addEventListener("change", function (ev) { mostraFile(ev.target.files[0]); });
    el("crea").addEventListener("click", creaFile);
    el("salva").addEventListener("click", salvaNelProgetto);

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

  // Stato del collegamento: usato solo quando la pagina gira dentro Trimble Connect.
  var connect = {
    api: null,       // Workspace API
    progetto: null,  // progetto corrente: { id, name, location }
    token: null,     // token dell'utente, dato da Connect dopo il suo consenso
    attesa: null,    // richiesta di token in corso
    avviso: null,    // funzione che mostra i messaggi sull'autorizzazione
    servizio: null   // API dei file del progetto: { base, rootId }
  };

  function caricaScript(url) {
    return new Promise(function (ok, errore) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = ok;
      s.onerror = function () { errore(new Error("Script non caricato: " + url)); };
      document.head.appendChild(s);
    });
  }

  function leggiProgetto(API) {
    // getProject e' il metodo attuale; getCurrentProject quello delle versioni precedenti.
    try {
      return API.project.getProject().catch(function () { return API.project.getCurrentProject(); });
    } catch (e) {
      return API.project.getCurrentProject();
    }
  }

  function collegaTrimbleConnect() {
    // Pagina aperta da sola, fuori da Trimble Connect: niente da collegare.
    if (window.parent === window) return Promise.resolve();

    var stato = el("stato-connect");
    return caricaScript(WORKSPACE_API)
      .then(function () {
        return window.TrimbleConnectWorkspace.connect(window.parent, function (evento, dati) {
          // Connect manda il token dopo il consenso dell'utente e a ogni rinnovo.
          if (evento === "extension.accessToken") riceviToken(dati && dati.data);
        }, 30000);
      })
      .then(function (API) {
        connect.api = API;
        // Voce nel menu di navigazione del progetto
        return API.ui.setMenu({
          title: "Punti in DXF",
          icon: new URL("icon.svg", window.location.href).href,
          command: "punti_in_dxf"
        }).then(function () { return leggiProgetto(API); });
      })
      .then(function (progetto) {
        connect.progetto = progetto || {};
        stato.textContent = "Collegato a Trimble Connect" +
          (connect.progetto.name ? ", progetto " + connect.progetto.name + "." : ".");
        stato.hidden = false;
        // Da qui si possono usare anche i file del progetto: scelta e salvataggio.
        if (connect.progetto.id) {
          el("da-progetto").hidden = false;
          el("salva").hidden = false;
          el("destinazione").hidden = false;
          mostraDestinazione();
        }
      })
      .catch(function (errore) {
        // La conversione non dipende dal collegamento.
        stato.textContent = "Collegamento a Trimble Connect non riuscito: la conversione funziona comunque.";
        stato.hidden = false;
        console.error(errore);
      });
  }

  // ----- Token dell'utente -----

  function riceviToken(valore) {
    if (!valore || valore === "pending") return;
    var attesa = connect.attesa;
    if (valore === "denied") {
      connect.token = null;
      if (attesa) { connect.attesa = null; attesa.rifiuta(new Error("CONSENSO_NEGATO")); }
      return;
    }
    connect.token = valore;
    if (attesa) {
      connect.attesa = null;
      avvisa("Collegamento ai file del progetto…");
      attesa.risolvi(valore);
    }
  }

  function avvisa(testo) { if (connect.avviso) connect.avviso(testo); }

  var MESSAGGIO_AUTORIZZAZIONE = "Trimble Connect deve autorizzare l'estensione ad accedere ai file del progetto. " +
    "Se si apre una finestra di accesso Trimble, completala. " +
    "Se non compare nulla, consenti i popup per web.connect.trimble.com e premi di nuovo il pulsante.";

  // Chiede a Connect il token dell'utente. La prima volta Connect apre una finestra
  // di Trimble ID per autorizzare l'estensione: il token arriva dopo la conferma,
  // come risposta alla richiesta oppure con l'evento "extension.accessToken".
  // Con nuovoTentativo la richiesta viene ripetuta anche se una e' gia' in attesa,
  // cosi' Connect puo' riaprire la finestra dopo un nuovo clic dell'utente.
  // avviso e' la funzione che mostra i messaggi sull'autorizzazione nel punto
  // della pagina da cui parte la richiesta.
  function chiediToken(nuovoTentativo, avviso) {
    if (avviso) connect.avviso = avviso;
    if (connect.token) return Promise.resolve(connect.token);

    var attesa = connect.attesa;
    var nuova = !attesa;
    if (nuova) {
      attesa = {};
      attesa.promessa = new Promise(function (ok, no) { attesa.risolvi = ok; attesa.rifiuta = no; });
      connect.attesa = attesa;
    }

    if (nuova || nuovoTentativo) {
      avvisa(MESSAGGIO_AUTORIZZAZIONE);
      connect.api.extension.requestPermission("accesstoken").then(riceviToken, function (errore) {
        if (connect.attesa === attesa) {
          connect.attesa = null;
          attesa.rifiuta(errore);
        }
      });
    }
    return attesa.promessa;
  }

  // =====================================================================
  // 5. FILE DEL PROGETTO (API di Trimble Connect)
  // =====================================================================

  // Elenco pubblico delle regioni di Trimble Connect, con gli indirizzi delle API.
  var REGIONI_URL = "https://us-east.api.trimble.com/connect/v2/regions";
  // Usato solo se l'elenco qui sopra non risponde.
  var REGIONI_NOTE = [
    { location: "northAmerica", "connect-api": "https://us-east.api.trimble.com/connect", "tc-api": "https://app.connect.trimble.com/tc/api/2.0/" },
    { location: "europe", "connect-api": "https://eu.api.trimble.com/connect", "tc-api": "https://app21.connect.trimble.com/tc/api/2.0/" },
    { location: "asia", "connect-api": "https://ap-sg.api.trimble.com/connect", "tc-api": "https://app31.connect.trimble.com/tc/api/2.0/" },
    { location: "australia", "connect-api": "https://ap-au.api.trimble.com/connect", "tc-api": "https://app32.connect.trimble.com/tc/api/2.0/" },
    { location: "unitedKingdom", "connect-api": "https://eu-gb.api.trimble.com/connect", "tc-api": "https://app22.connect.trimble.com/tc/api/2.0/" }
  ];

  var ESTENSIONI_TESTO = /\.(txt|csv|asc|pts|xyz|dat)$/i;
  var DIMENSIONE_MASSIMA = 50 * 1024 * 1024; // 50 MB: oltre non e' un elenco di punti

  function erroreApi(stato, url) {
    var e = new Error("HTTP " + stato);
    e.stato = stato;
    try { e.host = new URL(url).host; } catch (x) { e.host = ""; }
    return e;
  }

  // Chiamata alle API con il token dell'utente. Se il token e' scaduto (401)
  // ne chiede uno nuovo a Connect e riprova una volta.
  // opzioni: { metodo, json (corpo della richiesta), senzaRiprova }
  function chiamaApi(url, opzioni) {
    var o = opzioni || {};
    return chiediToken()
      .then(function (token) {
        var richiesta = { method: o.metodo || "GET", headers: { Authorization: "Bearer " + token } };
        if (o.json) {
          richiesta.headers["Content-Type"] = "application/json";
          richiesta.body = JSON.stringify(o.json);
        }
        return fetch(url, richiesta);
      })
      .then(function (risposta) {
        if (risposta.status === 401 && !o.senzaRiprova) {
          connect.token = null;
          return chiamaApi(url, { metodo: o.metodo, json: o.json, senzaRiprova: true });
        }
        if (!risposta.ok) throw erroreApi(risposta.status, url);
        return risposta.status === 204 ? null : risposta.json();
      });
  }

  function senzaBarraFinale(indirizzo) { return String(indirizzo).replace(/\/+$/, ""); }

  // Indirizzi delle API da provare, a partire dalla regione del progetto.
  // Per ogni regione: prima le API attuali (v2), poi quelle precedenti (2.0).
  function indirizziApi(regioni, regioneProgetto) {
    var cercata = String(regioneProgetto || "").toLowerCase();
    var prima = [];
    var dopo = [];
    regioni.forEach(function (r) {
      var lista = String(r.location || "").toLowerCase() === cercata ? prima : dopo;
      if (r["connect-api"]) lista.push(senzaBarraFinale(r["connect-api"]) + "/v2");
      if (r["tc-api"]) lista.push(senzaBarraFinale(r["tc-api"]));
    });
    return prima.concat(dopo);
  }

  // Trova l'indirizzo delle API che risponde per questo progetto e la sua cartella principale.
  function trovaServizio() {
    if (connect.servizio) return Promise.resolve(connect.servizio);

    return fetch(REGIONI_URL)
      .then(function (r) { return r.ok ? r.json() : REGIONI_NOTE; })
      .catch(function () { return REGIONI_NOTE; })
      .then(function (regioni) {
        if (!Array.isArray(regioni) || !regioni.length) regioni = REGIONI_NOTE;
        var indirizzi = indirizziApi(regioni, connect.progetto.location);
        var primoErrore = null;

        function prova(i) {
          if (i >= indirizzi.length) throw primoErrore || new Error("Nessun servizio disponibile");
          return chiamaApi(indirizzi[i] + "/projects/" + encodeURIComponent(connect.progetto.id), { senzaRiprova: true })
            .then(function (progetto) {
              if (!progetto || !progetto.rootId) throw new Error("Progetto senza cartella principale");
              connect.servizio = { base: indirizzi[i], rootId: progetto.rootId };
              // In fondo alla pagina: utile per capire quali API sta usando l'estensione.
              el("versione").textContent += " · API dei file: " + indirizzi[i].replace(/^https?:\/\//, "");
              return connect.servizio;
            })
            .catch(function (e) {
              if (e && e.message === "CONSENSO_NEGATO") throw e;
              if (!primoErrore) primoErrore = e;
              return prova(i + 1);
            });
        }
        return prova(0);
      });
  }

  // Contenuto di una cartella: cartelle e file, tutte le pagine.
  function elencoCartella(idCartella) {
    var base = connect.servizio.base;
    var url = base + "/folders/" + encodeURIComponent(idCartella) + "/items" +
      (/\/v2$/.test(base) ? "?pageSize=500" : "");
    var voci = [];

    function pagina(indirizzo, numero) {
      return chiamaApi(indirizzo).then(function (dati) {
        // API v2: { items: [...], links: { next: { href } } }. API 2.0: [...]
        voci = voci.concat(Array.isArray(dati) ? dati : (dati && dati.items) || []);
        var prossima = dati && dati.links && dati.links.next && dati.links.next.href;
        if (prossima && numero < 20) return pagina(new URL(prossima, indirizzo).href, numero + 1);
        return voci;
      });
    }
    return pagina(url, 1);
  }

  // Testo di un file del progetto.
  function scaricaTesto(idFile) {
    return chiamaApi(connect.servizio.base + "/files/fs/" + encodeURIComponent(idFile) + "/downloadurl")
      .then(function (d) {
        if (!d || !d.url) throw new Error("Indirizzo di download mancante");
        // Indirizzo temporaneo gia' autorizzato: va chiamato senza token.
        return fetch(d.url).catch(function () { throw new Error("DOWNLOAD_BLOCCATO"); });
      })
      .then(function (risposta) {
        if (!risposta.ok) throw erroreApi(risposta.status, risposta.url);
        return risposta.text();
      });
  }

  // ----- Salvataggio di un file nel progetto -----

  var CONTROLLI_CARICAMENTO = 20;  // quante volte chiedere a Connect se ha salvato il file
  var PAUSA_CARICAMENTO = 1500;    // millisecondi tra un controllo e l'altro

  function pausa(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  // Indirizzo a cui inviare il file. Tra i contenuti indicati da Connect,
  // quello senza formato e' il file vero e proprio.
  function indirizzoCaricamento(avvio) {
    var contenuti = (avvio && avvio.contents) || [];
    for (var i = 0; i < contenuti.length; i++) {
      if (!contenuti[i].format && contenuti[i].url) return contenuti[i].url;
    }
    return "";
  }

  // Salva un file in una cartella del progetto. Se nella cartella c'e' gia' un file
  // con lo stesso nome, Connect ne aggiunge una nuova versione.
  // Risultato: { completato, nuovaVersione } (vedi attendiCaricamento).
  function caricaFile(idCartella, nome, contenuto) {
    var avvia = connect.servizio.base + "/files/fs/upload?parentId=" + encodeURIComponent(idCartella) +
      "&parentType=FOLDER";

    return chiamaApi(avvia, { metodo: "POST", json: { name: nome } }).then(function (avvio) {
      var indirizzo = indirizzoCaricamento(avvio);
      if (!avvio || !avvio.uploadId || !indirizzo) throw new Error("Indirizzo di caricamento mancante");
      // Indirizzo temporaneo gia' autorizzato: va chiamato senza token e senza altre intestazioni.
      return fetch(indirizzo, { method: "PUT", body: new TextEncoder().encode(contenuto) })
        .catch(function () { throw new Error("CARICAMENTO_BLOCCATO"); })
        .then(function (risposta) {
          if (!risposta.ok) throw erroreApi(risposta.status, indirizzo);
          // Per un nome gia' presente Connect indica subito il file a cui aggiunge la versione.
          return attendiCaricamento(avvio.uploadId, !!avvio.fileId);
        });
    });
  }

  // Aspetta che Connect confermi il salvataggio del file inviato.
  // completato resta false se la conferma non arriva in tempo: il file e' stato
  // inviato, ma Connect lo sta ancora elaborando.
  function attendiCaricamento(idCaricamento, esisteva) {
    var url = connect.servizio.base + "/files/fs/upload?uploadId=" + encodeURIComponent(idCaricamento);
    var nonLetti = 0;

    function controlla(numero) {
      return chiamaApi(url)
        .catch(function () { nonLetti++; return null; })
        .then(function (d) {
          var stato = String((d && d.status) || "").toUpperCase();
          if (stato === "DONE") return { completato: true, nuovaVersione: esisteva || d.revision > 1 };
          if (stato === "ERROR" || stato === "EXPIRED") {
            var e = new Error("CARICAMENTO_FALLITO");
            e.motivo = d.errorReason || "";
            throw e;
          }
          if (numero >= CONTROLLI_CARICAMENTO || nonLetti >= 3) return { completato: false, nuovaVersione: esisteva };
          return pausa(PAUSA_CARICAMENTO).then(function () { return controlla(numero + 1); });
        });
    }
    return controlla(1);
  }

  // ----- Navigatore delle cartelle -----

  // scrittura: true se l'errore riguarda il salvataggio di un file.
  function messaggioErrore(e, scrittura) {
    if (e && e.message === "CONSENSO_NEGATO") {
      return "Permesso negato. Per riattivarlo apri le impostazioni dell'estensione in Trimble Connect e consenti l'accesso.";
    }
    if (e && e.message === "DOWNLOAD_BLOCCATO") return "Il browser ha bloccato lo scaricamento del file.";
    if (e && e.message === "CARICAMENTO_BLOCCATO") return "Il browser ha bloccato l'invio del file.";
    if (e && e.message === "CARICAMENTO_FALLITO") {
      return "Trimble Connect non ha accettato il file" + (e.motivo ? " (" + e.motivo + ")" : "") + ".";
    }
    var dove = e && e.host ? " (" + e.host + ")" : "";
    if (e && e.stato === 403) {
      return (scrittura ? "Non hai i permessi per salvare in questa cartella" : "Non hai i permessi per leggere questo contenuto") + dove + ".";
    }
    if (e && e.stato === 404) return (scrittura ? "Cartella non trovata" : "Contenuto non trovato") + dove + ".";
    if (e && e.stato) return "Trimble Connect ha risposto con l'errore " + e.stato + dove + ".";
    return "Non riesco a contattare Trimble Connect. Riprova tra poco.";
  }

  function dimensione(byte) {
    if (!(byte >= 0)) return "";
    if (byte < 1024) return byte + " B";
    if (byte < 1024 * 1024) return (byte / 1024).toFixed(0) + " kB";
    return (byte / 1024 / 1024).toFixed(1) + " MB";
  }

  function eCartella(voce) { return String(voce.type || "").toUpperCase() === "FOLDER"; }

  function perNome(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
  }

  function nomeProgetto() { return connect.progetto.name || "Progetto"; }

  function nomePercorso(percorso) {
    return percorso.map(function (cartella) { return cartella.nome; }).join(" / ");
  }

  /*
   * Crea un navigatore delle cartelle del progetto. La pagina ne ha due:
   * uno per scegliere il file di partenza, uno per la cartella in cui salvare il DXF.
   *
   * c:
   *   pannello, percorso, stato, elenco   elementi della pagina
   *   vuoto(voci)          messaggio quando non c'e' niente da elencare
   *   mostraFile(voce)     dice se un file va elencato; senza, si vedono solo le cartelle
   *   alFile(voce)         chiamata alla scelta di un file
   *   alPercorso(percorso) chiamata quando cambia la cartella corrente
   *
   * percorso: cartelle dalla principale a quella corrente, ognuna { id, nome }.
   */
  function creaNavigatore(c) {
    var n = { percorso: [], voci: [], richiesta: 0, apertura: null };

    n.stato = function (testo, errore) {
      c.stato.textContent = testo || "";
      c.stato.className = "nav-stato " + (errore ? "errore" : "nota");
    };

    function disegnaPercorso() {
      c.percorso.textContent = "";
      n.percorso.forEach(function (cartella, i) {
        if (i) c.percorso.appendChild(document.createTextNode(" / "));
        if (i === n.percorso.length - 1) {
          var corrente = document.createElement("strong");
          corrente.textContent = cartella.nome;
          c.percorso.appendChild(corrente);
        } else {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "collegamento";
          b.textContent = cartella.nome;
          b.addEventListener("click", function () {
            n.percorso = n.percorso.slice(0, i + 1);
            n.carica();
          });
          c.percorso.appendChild(b);
        }
      });
      if (c.alPercorso) c.alPercorso(n.percorso);
    }

    n.disegna = function () {
      var cartelle = n.voci.filter(eCartella).sort(perNome);
      var file = c.mostraFile
        ? n.voci.filter(function (v) { return !eCartella(v) && c.mostraFile(v); }).sort(perNome)
        : [];

      c.elenco.textContent = "";
      cartelle.concat(file).forEach(function (voce) {
        var cartella = eCartella(voce);
        var li = document.createElement("li");
        var b = document.createElement("button");
        b.type = "button";
        b.className = "voce " + (cartella ? "cartella" : "documento");
        var nome = document.createElement("span");
        nome.className = "voce-nome";
        nome.textContent = voce.name || "(senza nome)";
        b.appendChild(nome);
        if (!cartella) {
          var info = document.createElement("span");
          info.className = "voce-info";
          info.textContent = dimensione(voce.size);
          b.appendChild(info);
        }
        b.setAttribute("aria-label", (cartella ? "Cartella " : "File ") + (voce.name || ""));
        b.addEventListener("click", function () {
          if (cartella) {
            n.percorso.push({ id: voce.id, nome: voce.name || "" });
            n.carica();
          } else {
            c.alFile(voce);
          }
        });
        li.appendChild(b);
        c.elenco.appendChild(li);
      });

      n.stato(cartelle.length || file.length ? "" : c.vuoto(n.voci));
    };

    // Carica e mostra il contenuto della cartella corrente.
    n.carica = function () {
      var corrente = n.percorso[n.percorso.length - 1];
      var richiesta = ++n.richiesta; // le risposte di richieste superate vengono ignorate
      n.voci = [];
      c.elenco.textContent = "";
      disegnaPercorso();
      n.stato("Caricamento…");

      return elencoCartella(corrente.id)
        .then(function (voci) {
          if (richiesta !== n.richiesta) return;
          n.voci = voci;
          n.disegna();
        })
        .catch(function (e) {
          if (richiesta !== n.richiesta) return;
          console.error(e);
          n.stato(messaggioErrore(e), true);
        });
    };

    // Apre il navigatore. Con percorsoIniziale parte da quella cartella (dalla
    // principale se e' vuoto); senza, riprende dalla cartella in cui era rimasto.
    n.apri = function (percorsoIniziale) {
      c.pannello.hidden = false;
      if (percorsoIniziale !== undefined) {
        n.percorso = (percorsoIniziale || []).slice();
        n.voci = [];
        c.elenco.textContent = "";
        disegnaPercorso();
      }
      n.stato("Collegamento ai file del progetto…");

      // La richiesta del token parte subito, durante il clic: cosi' il browser
      // permette a Connect di aprire la finestra di autorizzazione.
      chiediToken(true, n.stato).catch(function () {});

      // Un'apertura gia' in corso prosegue da sola quando arriva il token.
      if (n.apertura) return n.apertura;

      n.apertura = trovaServizio()
        .then(function (servizio) {
          if (!n.percorso.length) n.percorso = [{ id: servizio.rootId, nome: nomeProgetto() }];
          return n.carica();
        })
        .catch(function (e) {
          console.error(e);
          n.stato(messaggioErrore(e), true);
        })
        .then(function () { n.apertura = null; });
      return n.apertura;
    };

    n.chiudi = function () {
      n.richiesta++;
      c.pannello.hidden = true;
    };

    return n;
  }

  // ----- Scelta del file di partenza dal progetto -----

  var origine = creaNavigatore({
    pannello: el("navigatore"),
    percorso: el("nav-percorso"),
    stato: el("nav-stato"),
    elenco: el("nav-elenco"),
    mostraFile: function (voce) { return el("nav-tutti").checked || ESTENSIONI_TESTO.test(voce.name || ""); },
    alFile: scegliFileProgetto,
    vuoto: function (voci) {
      return voci.length
        ? "Nessun file di testo in questa cartella. Spunta \"Mostra tutti i file\" per vedere gli altri."
        : "Questa cartella è vuota.";
    }
  });

  function scegliFileProgetto(voce) {
    if (voce.size > DIMENSIONE_MASSIMA) {
      origine.stato((voce.name || "Il file") + " è troppo grande (" + dimensione(voce.size) + ") per essere un elenco di punti.", true);
      return;
    }
    origine.stato("Lettura di " + (voce.name || "file") + "…");
    var cartella = origine.percorso.slice();
    scaricaTesto(voce.id)
      .then(function (testo) {
        el("file").value = "";
        mostraTesto(voce.name || "punti.txt", testo);
        origine.chiudi();
        // Salvo altra scelta, il DXF va nella cartella del file di partenza.
        if (!destinazione.scelta) {
          destinazione.percorso = cartella;
          mostraDestinazione();
        }
      })
      .catch(function (e) {
        console.error(e);
        origine.stato("Non riesco a leggere " + (voce.name || "il file") + ". " + messaggioErrore(e), true);
      });
  }

  // ----- Salvataggio del DXF nel progetto -----

  // Cartella in cui salvare il DXF. percorso: come nel navigatore; null indica la
  // cartella principale del progetto. scelta: true se l'ha indicata l'utente.
  var destinazione = { percorso: null, scelta: false };
  var salvataggio = null;  // salvataggio in corso
  var invio = false;       // true mentre il file viene inviato a Connect

  var arrivo = creaNavigatore({
    pannello: el("dest-navigatore"),
    percorso: el("dest-percorso"),
    stato: el("dest-stato"),
    elenco: el("dest-elenco"),
    vuoto: function () { return "Nessuna sottocartella."; },
    alPercorso: function (percorso) { el("dest-scegli").disabled = !percorso.length; }
  });

  function mostraDestinazione() {
    el("dest-nome").textContent = destinazione.percorso ? nomePercorso(destinazione.percorso) : nomeProgetto();
  }

  function usaCartella() {
    if (!arrivo.percorso.length) return;
    destinazione.percorso = arrivo.percorso.slice();
    destinazione.scelta = true;
    arrivo.chiudi();
    mostraDestinazione();
  }

  function statoSalvataggio(testo) { esito(testo, "attesa"); }

  function salvaNelProgetto() {
    if (!dati || !dati.punti.length) return Promise.resolve();
    statoSalvataggio("Collegamento ai file del progetto…");

    // Come per il navigatore, la richiesta del token parte durante il clic.
    chiediToken(true, statoSalvataggio).catch(function () {});

    // Un salvataggio gia' avviato prosegue da solo quando arriva il token.
    if (salvataggio) return salvataggio;

    var nome = "";
    salvataggio = trovaServizio()
      .then(function (servizio) {
        // Nell'attesa dell'autorizzazione il file scelto puo' essere cambiato.
        if (!dati || !dati.punti.length) { esito(""); return; }

        var dxf = creaDxf(dati.punti, leggiOpzioni());
        var punti = dati.punti.length;
        var percorso = destinazione.percorso || [{ id: servizio.rootId, nome: nomeProgetto() }];
        var dove = nomePercorso(percorso);
        nome = nomeDxf();

        invio = true;
        abilitaAzioni();
        statoSalvataggio("Salvataggio di " + nome + " in " + dove + "…");

        return caricaFile(percorso[percorso.length - 1].id, nome, dxf.contenuto).then(function (risultato) {
          var dettagli = ": " + contaPunti(punti) + " su " + dxf.layer + " layer.";
          if (!risultato.completato) {
            statoSalvataggio("Inviato " + nome + " in " + dove +
              ". Trimble Connect lo sta ancora elaborando: comparirà tra poco nella cartella.");
          } else if (risultato.nuovaVersione) {
            esito("Salvata una nuova versione di " + nome + " in " + dove + dettagli);
          } else {
            esito("Salvato " + nome + " in " + dove + dettagli);
          }
        });
      })
      .catch(function (e) {
        console.error(e);
        esito("Non riesco a salvare " + (nome || "il file") + ". " + messaggioErrore(e, true), "errore");
      })
      .then(function () {
        salvataggio = null;
        invio = false;
        abilitaAzioni();
      });
    return salvataggio;
  }

  function avviaProgetto() {
    el("apri-progetto").addEventListener("click", function () { origine.apri(); });
    el("nav-chiudi").addEventListener("click", origine.chiudi);
    el("nav-tutti").addEventListener("change", origine.disegna);
    el("dest-cambia").addEventListener("click", function () { arrivo.apri(destinazione.percorso); });
    el("dest-chiudi").addEventListener("click", arrivo.chiudi);
    el("dest-scegli").addEventListener("click", usaCartella);
  }

  avviaInterfaccia();
  avviaProgetto();
  collegaTrimbleConnect();
})();

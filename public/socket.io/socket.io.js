/* Client temps réel de la version Cloudflare.
 * Il remplace /socket.io/socket.io.js : mêmes appels que les pages utilisent (io(), on, off, once, emit avec accusé,
 * connected), mais en WebSocket simple vers /ws. Les pages n'ont rien à changer.
 * Messages : { e: événement, d: données, i: numéro d'accusé } du client vers le serveur,
 *            { e, d } pour un événement du serveur, { a: numéro d'accusé, d } pour une réponse. */
(function () {
  'use strict';
  var PING_MS = 25000;       // « ping » toutes les 25 s : le serveur répond « pong » sans se réveiller
  var SILENCE_MS = 60000;    // plus aucune nouvelle depuis 60 s : la connexion est morte, on la refait
  var BUFFER_MAX = 100;      // messages gardés pendant une coupure, renvoyés à la reconnexion

  function io() {
    var handlers = {}, acks = {}, buffer = [], seq = 0;
    var ws = null, essais = 0, relance = null, veille = null, dernierRecu = 0, dernierPing = 0, voulu = true;
    var socket = { connected: false, id: undefined };

    function adresse() {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }

    function appeler(fn, args) {
      try { fn.apply(null, args); } catch (e) { setTimeout(function () { throw e; }, 0); } // l'erreur reste visible, sans bloquer les autres
    }
    function declencher(ev) {
      var args = Array.prototype.slice.call(arguments, 1);
      var liste = (handlers[ev] || []).slice();
      for (var i = 0; i < liste.length; i++) appeler(liste[i], args);
    }

    socket.on = function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return socket; };
    socket.off = function (ev, fn) {
      if (!handlers[ev]) return socket;
      handlers[ev] = fn ? handlers[ev].filter(function (f) { return f !== fn && f.__fn !== fn; }) : [];
      return socket;
    };
    socket.once = function (ev, fn) {
      var f = function () { socket.off(ev, f); fn.apply(null, arguments); };
      f.__fn = fn;
      return socket.on(ev, f);
    };

    function ecrire(msg) {
      try { ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
    }
    socket.emit = function (ev) {
      var args = Array.prototype.slice.call(arguments, 1), msg = { e: ev };
      var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
      if (args.length) msg.d = args[0];
      if (cb) { msg.i = ++seq; acks[msg.i] = cb; }
      if (!(ws && socket.connected && ecrire(msg)) && buffer.length < BUFFER_MAX) buffer.push(msg);
      return socket;
    };

    function arreterVeille() { if (veille) { clearInterval(veille); veille = null; } }
    function demarrerVeille() {
      arreterVeille();
      veille = setInterval(function () {
        var t = Date.now();
        if (t - dernierRecu > SILENCE_MS) { perdre(); return; }
        if (t - dernierPing >= PING_MS) { dernierPing = t; try { ws.send('ping'); } catch (e) { /* onclose suivra */ } }
      }, 5000);
    }

    function planifier() {
      clearTimeout(relance);
      var delai = Math.min(5000, 1000 * Math.pow(1.5, essais)) * (0.5 + Math.random());
      essais++;
      relance = setTimeout(ouvrir, delai);
    }

    // La connexion est perdue (fermée par le réseau ou jugée morte) : on prévient les pages puis on réessaie.
    function perdre() {
      var w = ws, etait = socket.connected;
      ws = null; socket.connected = false;
      arreterVeille();
      if (w) { try { w.close(); } catch (e) { /* déjà fermée */ } }
      declencher(etait ? 'disconnect' : 'connect_error', etait ? 'transport close' : new Error('websocket error'));
      if (voulu) planifier();
    }

    function ouvrir() {
      if (!voulu || ws) return;
      clearTimeout(relance);
      var w;
      try { w = new WebSocket(adresse()); } catch (e) { planifier(); return; }
      ws = w;
      w.onopen = function () {
        if (ws !== w) return;
        essais = 0; dernierRecu = dernierPing = Date.now();
        socket.connected = true;
        demarrerVeille();
        declencher('connect'); // les pages se réidentifient ici (code chef, base regardée)
        var attente = buffer; buffer = [];
        for (var i = 0; i < attente.length; i++) { if (!ecrire(attente[i])) buffer.push(attente[i]); }
      };
      w.onmessage = function (ev) {
        if (ws !== w) return;
        dernierRecu = Date.now();
        if (typeof ev.data !== 'string' || ev.data === 'pong') return;
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m) return;
        if (m.a !== undefined) {
          var cb = acks[m.a];
          if (cb) { delete acks[m.a]; appeler(cb, [m.d]); }
        } else if (typeof m.e === 'string') {
          declencher(m.e, m.d);
        }
      };
      w.onclose = function () { if (ws === w) perdre(); };
      w.onerror = function () { if (ws === w) perdre(); }; // dans un navigateur, « close » suit toujours ; il sera alors ignoré
    }

    // Au retour sur la page (écran rallumé, réseau revenu), on vérifie tout de suite que la connexion vit.
    function reveil() {
      if (!voulu) return;
      if (!ws) { essais = 0; ouvrir(); return; }
      if (socket.connected && Date.now() - dernierRecu > 15000) {
        var avant = dernierRecu;
        try { ws.send('ping'); } catch (e) { perdre(); return; }
        setTimeout(function () { if (ws && dernierRecu === avant) perdre(); }, 4000);
      }
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) reveil(); });
    window.addEventListener('online', reveil);
    window.addEventListener('pageshow', reveil);

    socket.connect = function () { voulu = true; essais = 0; ouvrir(); return socket; };
    socket.close = socket.disconnect = function () {
      voulu = false; clearTimeout(relance); arreterVeille();
      var w = ws, etait = socket.connected;
      ws = null; socket.connected = false;
      if (w) { try { w.close(1000); } catch (e) { /* déjà fermée */ } }
      if (etait) declencher('disconnect', 'io client disconnect');
      return socket;
    };

    ouvrir();
    return socket;
  }

  window.io = io;
})();

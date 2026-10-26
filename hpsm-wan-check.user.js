// ==UserScript==
// @name         HP SM - Verificación IP WAN del Incidente
// @namespace    magic13
// @version      1.0.0
// @description  Botón en HP SM que lee la IP WAN del incidente activo y verifica si responde, sin salir del ticket. Resultado con botón 📋 Copiar para pegar en la bitácora.
// @match        *://sm.cnoc.telmexit.com/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * QUÉ HACE
 *   1. Lee la IP WAN del campo configurado en el incidente HP SM abierto.
 *   2. Intenta conectar a esa IP por HTTP (80), HTTPS (443) y HTTP alternativo (8080).
 *   3. Muestra panel flotante con el resultado: estado (responde / sin respuesta),
 *      tiempo de respuesta, puerto que respondió, código HTTP.
 *   4. Botón "📋 Copiar" al tope del panel — produce bloque formateado listo para
 *      pegar en la bitácora del incidente en SM.
 *
 * CONFIGURACIÓN
 *   Edita CAMPOS_IP_WAN con el/los nombres del campo HP SM donde está la IP WAN.
 *   Para encontrar el nombre: abre un incidente en HP SM → clic derecho sobre el
 *   campo de IP WAN → Inspeccionar → busca el atributo  name="..."
 *
 * POSICIÓN DEL BOTÓN
 *   Cambia POSICION_BOTON si te estorba.
 */

(function () {
  'use strict';

  // ── CONFIGURA AQUÍ ──────────────────────────────────────────────────
  // Nombres del campo HP SM que puede contener la IP WAN.
  // Agrega los que uses; el script prueba todos y toma el primero con valor.
  const CAMPOS_IP_WAN = [
    'instance/ip.wan',
    'instance/device.network.address',
    'instance/device.ip',
    'instance/affected.item',      // a veces el CI trae la IP
    'instance/description',        // fallback: el técnico la escribe ahí
  ];

  // Puertos a verificar, en orden.
  const PUERTOS = [
    { puerto: 80,   proto: 'http',  desc: 'HTTP'  },
    { puerto: 443,  proto: 'https', desc: 'HTTPS' },
    { puerto: 8080, proto: 'http',  desc: 'HTTP-alt' },
  ];

  const TIMEOUT_MS   = 8000;   // ms antes de declarar "sin respuesta"
  const POSICION_BTN = 'bottom:60px; right:12px;';
  // ────────────────────────────────────────────────────────────────────

  if (window.top !== window.self) return; // un solo botón en el frame principal

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // ── lectura de campos (recorre todos los iframes de HP SM) ──────────
  function buscarEnFrames(selector, raiz) {
    raiz = raiz || document;
    try {
      const el = raiz.querySelector(selector);
      if (el && norm(el.value)) return norm(el.value);
    } catch (e) {}
    for (const frame of raiz.querySelectorAll('iframe')) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue;
        const v = buscarEnFrames(selector, doc);
        if (v) return v;
      } catch (e) { /* iframe de otro origen */ }
    }
    return '';
  }

  function leerCampo(nombreCampo) {
    return buscarEnFrames(`[name="${nombreCampo}"]`);
  }

  function leerNumeroIncidente() {
    return buscarEnFrames('[name="instance/number"]')
        || buscarEnFrames('[name="number"]')
        || '—';
  }

  // Devuelve la primera IP WAN encontrada en los campos configurados.
  function leerIpWan() {
    for (const campo of CAMPOS_IP_WAN) {
      const valor = leerCampo(campo);
      if (ipValida(valor)) return { ip: limpiarIp(valor), campo };
    }
    return null;
  }

  const ipValida = (s) => /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(s);
  const limpiarIp = (s) => {
    const m = s.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    return m ? m[0] : s;
  };

  // ── verificación de conectividad ────────────────────────────────────
  // Intenta HTTP/HTTPS al IP y resuelve con el resultado del primer
  // puerto que conteste (o un objeto "sin respuesta" si todos fallan).
  function verificarIp(ip) {
    const intentos = PUERTOS.map(({ puerto, proto, desc }) =>
      new Promise((resolve) => {
        const url = `${proto}://${ip}:${puerto === 443 ? '' : puerto || ''}`.replace(':','');
        const urlFinal = `${proto}://${ip}${puerto !== (proto==='https'?443:80) ? ':'+puerto : ''}`;
        const t0 = Date.now();
        GM_xmlhttpRequest({
          method:  'HEAD',
          url:     urlFinal + '/',
          timeout: TIMEOUT_MS,
          headers: { 'Cache-Control': 'no-cache' },
          onload: (r) => resolve({
            respondio: true,
            puerto, proto, desc,
            ms: Date.now() - t0,
            codigo: r.status,
            headers: r.responseHeaders || '',
          }),
          onerror: () => resolve({
            respondio: true, // TCP rechazado = host vivo
            puerto, proto, desc,
            ms: Date.now() - t0,
            codigo: 'TCP-RST',
            headers: '',
          }),
          ontimeout: () => resolve({
            respondio: false,
            puerto, proto, desc,
            ms: TIMEOUT_MS,
            codigo: 'TIMEOUT',
            headers: '',
          }),
        });
      })
    );

    // Devuelve el primer intento que respondió (de verdad), o el primero
    // completo si todos dieron timeout.
    return new Promise((resolve) => {
      let pendientes = intentos.length;
      let primerRespuesta = null;

      intentos.forEach((p) =>
        p.then((r) => {
          pendientes--;
          if (r.respondio && !primerRespuesta) {
            primerRespuesta = r;
            resolve(r);
          } else if (pendientes === 0 && !primerRespuesta) {
            resolve(r); // todos timeout
          }
        })
      );
    });
  }

  // ── panel flotante ──────────────────────────────────────────────────
  function cerrarPanel() {
    const p = document.getElementById('wan-check-panel');
    if (p) p.remove();
  }

  function mostrarPanel(ip, incidente, contenido) {
    cerrarPanel();
    const panel = document.createElement('div');
    panel.id = 'wan-check-panel';
    panel.style.cssText =
      'position:fixed; bottom:105px; right:12px; z-index:2147483000; width:440px;' +
      'max-height:70vh; overflow-y:auto; background:#fff; color:#111827;' +
      'border:1px solid #cbd5e1; border-radius:12px; padding:0;' +
      'box-shadow:0 10px 32px rgba(2,6,23,.3); font:13px system-ui,"Segoe UI",Arial,sans-serif;';

    // Cabecera
    const cab = document.createElement('div');
    cab.style.cssText =
      'display:flex; justify-content:space-between; align-items:center;' +
      'padding:11px 14px; border-bottom:1px solid #e2e8f0;' +
      'background:#1e293b; border-radius:12px 12px 0 0;';
    const tit = document.createElement('div');
    tit.innerHTML =
      `<div style="font-weight:700;color:#f1f5f9;font-size:13px">📡 Verificación WAN · ${incidente}</div>` +
      `<div style="font-size:11px;color:#94a3b8;margin-top:2px">IP: ${ip}</div>`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Cerrar';
    x.style.cssText =
      'border:none; background:none; color:#94a3b8; font-size:17px;' +
      'cursor:pointer; line-height:1; padding:2px 6px; border-radius:4px;';
    x.onmouseenter = () => (x.style.color = '#ef4444');
    x.onmouseleave = () => (x.style.color = '#94a3b8');
    x.onclick = cerrarPanel;
    cab.append(tit, x);
    panel.appendChild(cab);

    // Cuerpo
    const body = document.createElement('div');
    body.style.cssText = 'padding:14px;';
    body.appendChild(contenido);
    panel.appendChild(body);

    document.body.appendChild(panel);
  }

  function mostrarCargando(ip, incidente) {
    cerrarPanel();
    const panel = document.createElement('div');
    panel.id = 'wan-check-panel';
    panel.style.cssText =
      'position:fixed; bottom:105px; right:12px; z-index:2147483000; width:440px;' +
      'background:#fff; border:1px solid #cbd5e1; border-radius:12px; padding:0;' +
      'box-shadow:0 10px 32px rgba(2,6,23,.3); font:13px system-ui,"Segoe UI",Arial,sans-serif;';
    panel.innerHTML =
      `<div style="background:#1e293b;border-radius:12px 12px 0 0;padding:11px 14px">` +
        `<div style="font-weight:700;color:#f1f5f9">📡 Verificando WAN · ${incidente}</div>` +
        `<div style="font-size:11px;color:#94a3b8;margin-top:2px">IP: ${ip}</div>` +
      `</div>` +
      `<div style="padding:24px;text-align:center;color:#64748b">` +
        `<div style="font-size:22px;margin-bottom:8px">⏳</div>` +
        `Verificando conectividad…<br><small style="opacity:.7">Timeout máximo: ${TIMEOUT_MS/1000} s por puerto</small>` +
      `</div>`;
    document.body.appendChild(panel);
  }

  function mostrarResultado(ip, incidente, resultado) {
    const cont = document.createElement('div');

    // ── Texto para copiar (bitácora SM)
    const txtCopia = generarTxtBitacora(ip, incidente, resultado);

    // ── Barra de acciones (siempre al tope, como Orygin)
    const barra = document.createElement('div');
    barra.style.cssText = 'display:flex; gap:8px; margin-bottom:13px; flex-wrap:wrap;';

    const btnCopiar = document.createElement('button');
    btnCopiar.textContent = '📋 Copiar';
    btnCopiar.title = 'Copiar resultado formateado para pegar en la bitácora del incidente';
    btnCopiar.style.cssText =
      'background:#0ea5e9; color:#fff; border:none; border-radius:8px;' +
      'padding:8px 16px; font-weight:700; font-size:12px; cursor:pointer;';
    btnCopiar.onclick = async () => {
      try {
        await navigator.clipboard.writeText(txtCopia);
        btnCopiar.textContent = '✅ Copiado';
        setTimeout(() => (btnCopiar.textContent = '📋 Copiar'), 1800);
      } catch {
        // fallback para iframes sin permiso de clipboard
        const ta = document.createElement('textarea');
        ta.value = txtCopia;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        btnCopiar.textContent = '✅ Copiado';
        setTimeout(() => (btnCopiar.textContent = '📋 Copiar'), 1800);
      }
    };

    const btnVerTxt = document.createElement('button');
    btnVerTxt.textContent = '🧾 Ver texto';
    btnVerTxt.style.cssText =
      'background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; border-radius:8px;' +
      'padding:8px 14px; font-size:12px; cursor:pointer;';
    let rawVisible = false;
    btnVerTxt.onclick = () => {
      rawVisible = !rawVisible;
      rawArea.style.display = rawVisible ? 'block' : 'none';
      btnVerTxt.textContent = rawVisible ? '🧾 Ocultar texto' : '🧾 Ver texto';
    };

    barra.append(btnCopiar, btnVerTxt);
    cont.appendChild(barra);

    // ── Caja de estado principal (verde/rojo)
    const apagada = !resultado.respondio;
    const caja = document.createElement('div');
    caja.style.cssText =
      `border-radius:10px; padding:12px 14px; margin-bottom:13px; border:2px solid ` +
      (apagada ? '#dc2626; background:#fef2f2;' : '#10b981; background:#ecfdf5;');
    caja.innerHTML =
      `<div style="font-size:11px;color:${apagada?'#991b1b':'#065f46'};margin-bottom:3px">Estado de conectividad IP WAN</div>` +
      `<div style="font-size:17px;font-weight:800;color:${apagada?'#dc2626':'#059669'}">` +
        (apagada ? '✗ SIN RESPUESTA — IP NO ALCANZABLE' : '✓ RESPONDIENDO — IP ACTIVA') +
      `</div>`;
    cont.appendChild(caja);

    // ── Tabla de datos
    const filas = [
      { k: 'IP WAN',           v: ip,                              hl: true  },
      { k: 'Estado',           v: apagada?'Sin respuesta':'Activa — respondiendo', hl: false },
      { k: 'Puerto/Protocolo', v: apagada?`Todos (${PUERTOS.map(p=>p.puerto).join(', ')})`:`${resultado.puerto} (${resultado.desc})`, hl: false },
      { k: 'Tiempo respuesta', v: apagada?'— (timeout)': resultado.ms+' ms',      hl: !apagada },
      { k: 'Código HTTP',      v: String(resultado.codigo),                         hl: false },
      { k: 'Incidente',        v: incidente,                        hl: false },
      { k: 'Verificado',       v: tsNow(),                          hl: false },
    ];

    const tabla = document.createElement('table');
    tabla.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    filas.forEach(({ k, v, hl }) => {
      const tr = document.createElement('tr');
      tr.style.cssText =
        'border-bottom:1px solid #f1f5f9;' + (hl ? 'background:#eff6ff;' : '');
      tr.innerHTML =
        `<td style="padding:5px 10px 5px 6px;white-space:nowrap;vertical-align:top;` +
          `color:${hl?'#1d4ed8;font-weight:700':'#64748b'}">${k}</td>` +
        `<td style="padding:5px 6px 5px 0;font-weight:${hl?800:600};` +
          `color:${hl?'#1e3a8a':'#111827'};word-break:break-word">${v}</td>`;
      tabla.appendChild(tr);
    });
    cont.appendChild(tabla);

    // ── Área de texto raw (oculta por defecto)
    const rawArea = document.createElement('pre');
    rawArea.textContent = txtCopia;
    rawArea.style.cssText =
      'display:none; margin-top:12px; background:#f8fafc; border:1px solid #e2e8f0;' +
      'border-radius:6px; padding:10px 12px; font:11px Consolas,monospace;' +
      'white-space:pre-wrap; color:#334155; max-height:200px; overflow-y:auto;' +
      'user-select:text;';
    cont.appendChild(rawArea);

    mostrarPanel(ip, incidente, cont);
  }

  function mostrarError(ip, incidente, msg) {
    const cont = document.createElement('div');
    cont.innerHTML =
      `<div style="background:#fff7ed;border:2px solid #fb923c;border-radius:9px;` +
      `padding:12px 14px;font-size:13px;color:#7c2d12;line-height:1.5">` +
      `<strong>No se pudo verificar</strong><br>${msg}</div>`;
    mostrarPanel(ip || '?', incidente, cont);
  }

  // ── formato de bitácora ─────────────────────────────────────────────
  function generarTxtBitacora(ip, incidente, resultado) {
    const ts    = tsNow();
    const ok    = resultado.respondio;
    const sep   = '═'.repeat(52);
    return [
      `╔${sep}╗`,
      `║  VERIFICACIÓN IP WAN — Service Manager Magic13       ║`,
      `╚${sep}╝`,
      ``,
      `INCIDENTE     : ${incidente}`,
      `FECHA/HORA    : ${ts}`,
      ``,
      `IP WAN        : ${ip}`,
      `ESTADO        : ${ok ? 'RESPONDIENDO ✓  —  IP ACTIVA' : 'SIN RESPUESTA ✗  —  IP NO ALCANZABLE'}`,
      ok ? `PUERTO        : ${resultado.puerto} (${resultado.desc})` : `PUERTOS PROBADOS: ${PUERTOS.map(p=>p.puerto+' ('+p.desc+')').join(' / ')}`,
      `TIEMPO RESP.  : ${ok ? resultado.ms + ' ms' : '— (timeout ' + TIMEOUT_MS/1000 + ' s)'}`,
      `CÓDIGO HTTP   : ${resultado.codigo}`,
      ``,
      `─`.repeat(54),
      ok
        ? `Verificación exitosa. El equipo en ${ip} respondió por el puerto ${resultado.puerto} en ${resultado.ms} ms.`
        : `Sin respuesta desde ${ip} en ningún puerto verificado (${PUERTOS.map(p=>p.puerto).join(', ')}). ` +
          `Se recomienda revisar enlace físico, firewall o estado del equipo en planta.`,
      ``,
      `[Generado por script Magic13 — HP SM WAN Check v1.0]`,
    ].join('\n');
  }

  // ── timestamp ──────────────────────────────────────────────────────
  function tsNow() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ── ejecución principal ─────────────────────────────────────────────
  async function ejecutar(btn) {
    const incidente = leerNumeroIncidente();

    // 1. Intentar leer IP WAN automáticamente
    let ipInfo = leerIpWan();
    let ip;

    if (ipInfo) {
      ip = ipInfo.ip;
    } else {
      // Fallback: pedir al técnico que escriba la IP
      const aviso = `No encontré la IP WAN en los campos configurados del incidente ${incidente}.\n\n` +
        `Puedes escribirla manualmente (solo la IP, ej: 190.10.20.30).\n` +
        `Edita CAMPOS_IP_WAN en el script para agregarla y que se lea automáticamente.`;
      const manual = window.prompt(aviso, '');
      ip = (manual || '').replace(/\s/g, '');
      if (!ip || !ipValida(ip)) return;
      ip = limpiarIp(ip);
    }

    // 2. Mostrar panel de carga y deshabilitar botón
    const textoOriginal = btn.textContent;
    btn.textContent = '⏳ Verificando…';
    btn.disabled    = true;
    mostrarCargando(ip, incidente);

    // 3. Verificar
    try {
      const resultado = await verificarIp(ip);
      mostrarResultado(ip, incidente, resultado);
    } catch (e) {
      mostrarError(ip, incidente, e.message || 'Error desconocido.');
    } finally {
      btn.textContent = textoOriginal;
      btn.disabled    = false;
    }
  }

  // ── botón ──────────────────────────────────────────────────────────
  function crearBoton() {
    if (document.getElementById('wan-check-btn')) return;
    const btn = document.createElement('button');
    btn.id        = 'wan-check-btn';
    btn.textContent = '📡 WAN Check';
    btn.title     = 'Verificar si la IP WAN del incidente activo responde';
    btn.style.cssText =
      `position:fixed; ${POSICION_BTN} z-index:2147482999;` +
      'background:linear-gradient(135deg,#7c3aed,#2563eb); color:#fff;' +
      'border:none; border-radius:9px; padding:10px 16px;' +
      'font:700 13px system-ui,"Segoe UI",Arial,sans-serif;' +
      'cursor:pointer; box-shadow:0 6px 20px rgba(37,99,235,.35);' +
      'transition:transform .15s,box-shadow .15s;';
    btn.onmouseenter = () => {
      btn.style.transform  = 'translateY(-2px)';
      btn.style.boxShadow  = '0 8px 26px rgba(37,99,235,.5)';
    };
    btn.onmouseleave = () => {
      btn.style.transform  = '';
      btn.style.boxShadow  = '0 6px 20px rgba(37,99,235,.35)';
    };
    btn.onclick = () => ejecutar(btn);
    document.body.appendChild(btn);
  }

  // HP SM navega con iframes sin recargar la página — revisar cada 2 s
  setInterval(crearBoton, 2000);
  crearBoton();

  GM_registerMenuCommand('WAN Check: verificar IP manualmente', () => {
    const ip = limpiarIp(window.prompt('IP WAN a verificar:', '') || '');
    if (!ip || !ipValida(ip)) return;
    const inc = leerNumeroIncidente();
    mostrarCargando(ip, inc);
    verificarIp(ip)
      .then((r) => mostrarResultado(ip, inc, r))
      .catch((e) => mostrarError(ip, inc, e.message));
  });

  console.log('[wan-check] listo · incidente:', leerNumeroIncidente() || '(ninguno)');
})();

// ==UserScript==
// @name         HP SM - Consulta Orygin (estado de ONT)
// @namespace    magic13
// @version      0.3.3
// @description  Botón en HP SM que consulta Orygin (prueba de banda ancha) con la referencia del incidente y muestra el estado del dispositivo y los datos GPON/ONT, sin salir del ticket. SOLO LECTURA.
// @match        *://sm.cnoc.telmexit.com/*
// @connect      orygin.intranet.rednacional.com
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * CAMBIO v0.3.3
 *   buscarEnFrames ahora recolecta TODOS los valores del campo en todos los
 *   iframes (con su profundidad) y devuelve el del iframe más profundo/específico.
 *   Esto resuelve el problema donde HP SM tiene múltiples iframes con el mismo
 *   nombre de campo (instance/service.uniqueid) y el script tomaba el valor
 *   equivocado (ej. 0425080004 en vez de 5591559624).
 *
 * QUÉ HACE
 *   1. Lee la referencia del incidente abierto (Service Unique Identifier,
 *      name="instance/service.uniqueid"), buscándola en todos los iframes
 *      y eligiendo el valor del contexto más específico (iframe más profundo).
 *   2. Repite la misma petición que hace el botón "Consultar" de
 *      RAD.html#PBA:  POST a EstadoDispositivoBA.php con telefono=<ref>&op=1
 *   3. Muestra el resultado: el estado de la ONT arriba y debajo los datos
 *      en tabla (equipo GPON, datos ONT, PON, puertos...).
 *
 * SOLO LECTURA: este script únicamente consulta. No envía nada que modifique
 * el servicio ni toca botones de HP SM.
 */

(function () {
  'use strict';

  const POSICION_BOTON = 'bottom:60px; right:12px;';

  const URL_ORYGIN = 'https://orygin.intranet.rednacional.com/php/PruebaBandaAncha/EstadoDispositivoBA.php?';

  const ETIQUETAS_RESALTADAS = [
    /^id\s*contrato$/i,
    /^perfil$/i,
    /potencia/i,
    /^n[uú]mero\s+de\s+serie$/i,
    /^datos\s+del\s+m[oó]dem$/i,
    /^vlan\s+hsi$/i,
    /^vlan\s+ont/i,
    /^tipo\s+de\s+puerto$/i,
    /^puerto\s+ethernet\s*\d*$/i,
  ];

  const ETIQUETAS_DESTACADAS = [
    /^ont$/i,
    /^estado\s+del\s+equipo$/i,
    /^estado$/i,
  ];

  if (window.top !== window.self) return;

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function limpiar(v) {
    if (v == null) return '';
    const sinTags = String(v).replace(/<\\?\/?[a-zA-Z][^>]*>/g, ' ');
    let texto = sinTags;
    try {
      texto = new DOMParser().parseFromString(sinTags, 'text/html').documentElement.textContent || sinTags;
    } catch (e) {}
    return norm(texto);
  }

  // ── LECTURA MULTI-FRAME CON PROFUNDIDAD ─────────────────────────────
  // Recolecta TODOS los valores del selector en todos los frames,
  // registrando la profundidad a la que se encontró cada uno.
  // Devuelve el valor del frame más profundo (más específico/anidado),
  // que en HP SM es el que corresponde al formulario del incidente activo.
  function recolectarValores(selector, raiz, profundidad, resultados) {
    raiz        = raiz        || document;
    profundidad = profundidad || 0;
    resultados  = resultados  || [];

    try {
      const el = raiz.querySelector(selector);
      if (el && norm(el.value)) {
        resultados.push({ valor: norm(el.value), profundidad });
      }
    } catch (e) {}

    for (const frame of raiz.querySelectorAll('iframe')) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue;
        recolectarValores(selector, doc, profundidad + 1, resultados);
      } catch (e) {}
    }
    return resultados;
  }

  // Devuelve el valor del frame más profundo; si hay empate de profundidad,
  // devuelve el que tenga más dígitos (más probable que sea el número de línea).
  function buscarMejorValor(selector) {
    const todos = recolectarValores(selector);
    if (!todos.length) return '';
    todos.sort((a, b) =>
      b.profundidad - a.profundidad ||
      soloDigitos(b.valor).length - soloDigitos(a.valor).length
    );
    return todos[0].valor;
  }

  // Mantiene la firma original para compatibilidad con el resto del código.
  function buscarEnFrames(selector, raiz) {
    if (raiz) {
      // Llamada con raíz explícita (legado): comportamiento original
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
        } catch (e) {}
      }
      return '';
    }
    // Sin raíz explícita: usa la búsqueda mejorada multi-frame
    return buscarMejorValor(selector);
  }

  const leerReferencia = () => buscarEnFrames('[name="instance/service.uniqueid"]');

  const soloDigitos = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');
  function referenciaValida(valor) {
    const d = soloDigitos(valor);
    return d.length >= 7 ? d : '';
  }
  const leerIncidente = () => buscarEnFrames('[name="instance/number"]');

  // ── CONSULTA ────────────────────────────────────────────────────────
  function consultarOrygin(referencia) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: URL_ORYGIN,
        headers: {
          'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://orygin.intranet.rednacional.com/RAD.html',
        },
        data: '&telefono=' + encodeURIComponent(referencia) + '&op=1',
        timeout: 45000,
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            reject(new Error('Orygin respondió ' + r.status));
            return;
          }
          resolve(r.responseText || '');
        },
        onerror:  () => reject(new Error('No se pudo conectar con Orygin (¿VPN/red interna activa?)')),
        ontimeout:() => reject(new Error('Orygin tardó demasiado en responder (la prueba es en tiempo real y puede tardar)')),
      });
    });
  }

  // ── INTERPRETACIÓN JSON ─────────────────────────────────────────────
  function recolectarPares(nodo, pares, vistos) {
    if (!nodo || typeof nodo !== 'object') return;
    if (vistos.has(nodo)) return;
    vistos.add(nodo);
    if (Array.isArray(nodo)) { nodo.forEach((n) => recolectarPares(n, pares, vistos)); return; }
    const et = limpiar(nodo.texto_etiqueta);
    if (et && 'valorField' in nodo) {
      const val = limpiar(nodo.valorField);
      if (val) pares.push({ etiqueta: et, valor: val });
    }
    Object.keys(nodo).forEach((k) => {
      if (k === 'texto_etiqueta' || k === 'valorField') return;
      recolectarPares(nodo[k], pares, vistos);
    });
  }

  function paresDeParams(nodo, pares, vistos) {
    if (!nodo || typeof nodo !== 'object') return;
    if (vistos.has(nodo)) return;
    vistos.add(nodo);
    if (Array.isArray(nodo)) { nodo.forEach((n) => paresDeParams(n, pares, vistos)); return; }
    if (nodo.params_ejecucion && typeof nodo.params_ejecucion === 'object') {
      Object.keys(nodo.params_ejecucion).forEach((k) => {
        const v = limpiar(nodo.params_ejecucion[k]);
        if (v) pares.push({ etiqueta: k, valor: v, tecnico: true });
      });
    }
    Object.keys(nodo).forEach((k) => paresDeParams(nodo[k], pares, vistos));
  }

  function mensajeDeRespuesta(data) {
    if (typeof data === 'string') return norm(data);
    if (!data || typeof data !== 'object') return '';
    const r = data.response;
    if (r && typeof r.data === 'string' && norm(r.data)) return norm(r.data);
    if (typeof data.data === 'string' && norm(data.data)) return norm(data.data);
    if (typeof data.mensaje === 'string' && norm(data.mensaje)) return norm(data.mensaje);
    return '';
  }

  function interpretar(respuesta) {
    let data = null;
    try {
      data = JSON.parse(respuesta);
    } catch (e) {
      const doc = new DOMParser().parseFromString(respuesta, 'text/html');
      const filas = [];
      doc.querySelectorAll('tr').forEach((tr) => {
        const celdas = [...tr.children].map((td) => norm(td.textContent)).filter(Boolean);
        if (celdas.length >= 2) filas.push({ etiqueta: celdas[0], valor: celdas.slice(1).join(' ') });
      });
      return { estado: '', pares: filas, mensaje: '', crudo: respuesta, esJson: false };
    }

    const pares = [];
    recolectarPares(data, pares, new WeakSet());
    paresDeParams(data, pares, new WeakSet());

    let estado = '', etiquetaEstado = '';
    for (const re of ETIQUETAS_DESTACADAS) {
      const hit = pares.find((p) => re.test(p.etiqueta) && p.valor);
      if (hit) { estado = hit.valor; etiquetaEstado = hit.etiqueta; break; }
    }

    return { estado, etiquetaEstado, pares, mensaje: mensajeDeRespuesta(data), crudo: JSON.stringify(data, null, 2), esJson: true };
  }

  // ── PANEL ───────────────────────────────────────────────────────────
  function cerrarPanel() {
    const p = document.getElementById('orygin-panel');
    if (p) p.remove();
  }

  function mostrarPanel(referencia, contenido) {
    cerrarPanel();
    const panel = document.createElement('div');
    panel.id = 'orygin-panel';
    panel.style.cssText =
      'position:fixed; bottom:100px; right:12px; z-index:2147483000; width:520px; max-height:72vh; overflow:auto;' +
      'background:#fff; color:#111827; border:1px solid #cbd5e1; border-radius:10px; padding:14px;' +
      'box-shadow:0 8px 28px rgba(2,6,23,.25); font:13px system-ui,Segoe UI,Arial,sans-serif;';

    const cab = document.createElement('div');
    cab.style.cssText =
      'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;' +
      'position:sticky; top:0; background:#fff; z-index:10; padding-bottom:8px;' +
      'border-bottom:1px solid #e2e8f0;';
    const tit = document.createElement('strong');
    tit.textContent = 'Orygin · ' + referencia;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'border:none; background:none; font-size:16px; cursor:pointer;';
    x.onclick = cerrarPanel;
    cab.append(tit, x);
    panel.appendChild(cab);
    panel.appendChild(contenido);
    document.body.appendChild(panel);
  }

  function esResaltado(etiqueta) {
    return ETIQUETAS_RESALTADAS.some((re) => re.test(etiqueta));
  }

  function tablaDePares(pares) {
    const t = document.createElement('table');
    t.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    pares.forEach((p) => {
      const destacado = esResaltado(p.etiqueta);
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #f1f5f9;' + (destacado ? ' background:#eff6ff;' : '');
      const td1 = document.createElement('td');
      td1.textContent = p.etiqueta;
      td1.style.cssText =
        'padding:4px 8px 4px 6px; white-space:nowrap; vertical-align:top; color:' +
        (destacado ? '#1d4ed8; font-weight:700;' : (p.tecnico ? '#94a3b8;' : '#64748b;'));
      const td2 = document.createElement('td');
      td2.textContent = p.valor;
      td2.style.cssText =
        'padding:4px 6px 4px 0; user-select:text; word-break:break-word; ' +
        (destacado ? 'color:#1e3a8a; font-weight:800; font-size:13px;' : 'font-weight:600;');
      tr.append(td1, td2);
      t.appendChild(tr);
    });
    return t;
  }

  function mostrarResultado(referencia, datos) {
    const cont = document.createElement('div');

    const textoPlano = () =>
      (datos.mensaje ? datos.mensaje + '\n\n' : '') +
      (datos.estado  ? (datos.etiquetaEstado || 'Estado') + ': ' + datos.estado + '\n\n' : '') +
      datos.pares.map((p) => p.etiqueta + ': ' + p.valor).join('\n');

    const barra = document.createElement('div');
    barra.style.cssText =
      'display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;' +
      'position:sticky; top:43px; background:#fff; z-index:9;' +
      'padding:8px 0 8px; border-bottom:1px solid #f1f5f9;';

    const copiar = document.createElement('button');
    copiar.textContent = '📋 Copiar';
    copiar.style.cssText = 'background:#0ea5e9; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-weight:700; cursor:pointer;';
    copiar.onclick = async () => {
      try {
        await navigator.clipboard.writeText(textoPlano());
        copiar.textContent = '✅ Copiado';
        setTimeout(() => (copiar.textContent = '📋 Copiar'), 1500);
      } catch (e) {
        copiar.textContent = '⚠️ No se pudo';
      }
    };

    const crudo = document.createElement('button');
    crudo.textContent = '🧾 Ver respuesta cruda';
    crudo.style.cssText = 'background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; border-radius:8px; padding:8px 14px; cursor:pointer;';
    crudo.onclick = () => {
      const ta = document.createElement('textarea');
      ta.readOnly = true; ta.value = datos.crudo;
      ta.style.cssText = 'width:100%; height:300px; margin-top:10px; box-sizing:border-box; font:11px Consolas,monospace; padding:8px; border:1px solid #e5e7eb; border-radius:6px;';
      cont.appendChild(ta); ta.focus(); ta.select(); crudo.disabled = true;
    };

    barra.append(copiar, crudo);
    cont.appendChild(barra);

    if (datos.estado) {
      const apagada = /APAGAD|LOS|SIN\s+SE[ÑN]AL|DESACTIV|FUERA/i.test(datos.estado);
      const caja = document.createElement('div');
      caja.style.cssText =
        'border-radius:8px; padding:10px 12px; margin-bottom:12px; border:2px solid ' +
        (apagada ? '#dc2626; background:#fef2f2;' : '#10b981; background:#ecfdf5;');
      const et = document.createElement('div');
      et.textContent = datos.etiquetaEstado || 'Estado';
      et.style.cssText = 'font-size:11px; margin-bottom:2px; color:' + (apagada ? '#991b1b' : '#065f46') + ';';
      const v = document.createElement('div');
      v.textContent = datos.estado;
      v.style.cssText = 'font-size:16px; font-weight:800; color:' + (apagada ? '#991b1b' : '#065f46') + ';';
      caja.append(et, v); cont.appendChild(caja);
    }

    if (datos.mensaje) {
      const m = document.createElement('div');
      m.style.cssText = 'background:#fff7ed; border:2px solid #fb923c; border-radius:8px; padding:10px 12px; margin-bottom:10px;';
      const et = document.createElement('div');
      et.textContent = 'Respuesta de Orygin';
      et.style.cssText = 'font-size:11px; color:#9a3412; margin-bottom:3px;';
      const tx = document.createElement('div');
      tx.textContent = datos.mensaje;
      tx.style.cssText = 'font-size:13px; font-weight:700; color:#7c2d12; line-height:1.4;';
      m.append(et, tx); cont.appendChild(m);
    }

    if (datos.pares.length) {
      cont.appendChild(tablaDePares(datos.pares));
    } else if (!datos.mensaje) {
      const aviso = document.createElement('div');
      aviso.textContent = 'La respuesta llegó pero no se reconocieron campos. Usa "Ver respuesta cruda" y mándamela para ajustar el lector.';
      aviso.style.cssText = 'background:#fffbeb; border:1px solid #f59e0b; border-radius:8px; padding:8px 10px; font-size:12px;';
      cont.appendChild(aviso);
    }

    mostrarPanel(referencia, cont);
  }

  function mostrarMensaje(referencia, texto) {
    const cont = document.createElement('div');
    cont.textContent = texto;
    cont.style.cssText = 'font-size:13px; line-height:1.5;';
    mostrarPanel(referencia || '—', cont);
  }

  // ── BOTÓN ────────────────────────────────────────────────────────────
  async function ejecutar(btn) {
    const bruta = leerReferencia();
    let referencia = referenciaValida(bruta);

    if (!referencia) {
      const aviso = bruta
        ? 'El campo de referencia trae "' + bruta + '", que no es un número de línea.\n\n'
        : 'No encontré la referencia en pantalla.\n\n';
      referencia = referenciaValida(window.prompt(aviso + 'Escribe la referencia (solo números):', soloDigitos(bruta)));
      if (!referencia) return;
    }

    const original = btn.textContent;
    btn.textContent = '⏳ Consultando…';
    btn.disabled = true;
    try {
      const resp = await consultarOrygin(referencia);
      mostrarResultado(referencia, interpretar(resp));
    } catch (e) {
      mostrarMensaje(referencia, 'No se pudo consultar: ' + e.message);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  }

  function crearBoton() {
    if (document.getElementById('orygin-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'orygin-btn';
    btn.textContent = '📡 Orygin';
    btn.title = 'Consultar el estado del dispositivo en Orygin con la referencia del incidente';
    btn.style.cssText =
      'position:fixed; ' + POSICION_BOTON + ' z-index:2147482999;' +
      'background:#7c3aed; color:#fff; border:none; border-radius:8px; padding:10px 14px;' +
      'font:700 13px system-ui,Segoe UI,Arial,sans-serif; cursor:pointer; box-shadow:0 6px 18px rgba(2,6,23,.2);';
    btn.onclick = () => ejecutar(btn);
    document.body.appendChild(btn);
  }

  setInterval(crearBoton, 2000);
  crearBoton();

  GM_registerMenuCommand('Orygin: consultar una referencia', () => {
    const ref = referenciaValida(window.prompt('Referencia a consultar en Orygin (solo números):', soloDigitos(leerReferencia())));
    if (!ref) return;
    consultarOrygin(ref)
      .then((resp) => mostrarResultado(ref, interpretar(resp)))
      .catch((e) => mostrarMensaje(ref, 'No se pudo consultar: ' + e.message));
  });

  console.log('[orygin v0.3.3] listo · incidente:', leerIncidente() || '(ninguno)', '· referencia:', leerReferencia() || '(no encontrada)');
})();

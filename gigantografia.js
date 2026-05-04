// =====================================================
// GIGANTOGRAFIA (VersaExpress RF-640) — modulo extraido de index.html el 2026-05-04
// Cotizador m2/aditivos/unidad + admin de materiales/rollos/config + descuento inventario.
// Depende de globales del script principal: db, currentUser, escapeHtml, fmtN,
// switchTab, addItemToProformaGiga, productosCache, etc.
// Se carga via <script src="gigantografia.js"> al final del body.
// =====================================================

// =====================================================
// GIGANTOGRAFIA (VersaExpress RF-640)
// =====================================================
const GIGA_ANCHO_MAX_CM = 160;
let gigaMaterialesCache = [];
let gigaRollosCache = [];
let gigaConfig = {
    tinta_ml_por_m2_100pct: 12.76, tinta_costo_ml: 0.065, cobertura_default_pct: 60,
    mantenimiento_anual: 700, cabezal_costo: 3000, cabezal_vida_anios: 3,
    m2_anuales_est: 1000, desperdicio_inicio_cm: 10, desperdicio_fin_cm: 5
};
let gigaAditivosSeleccionados = {}; // {id: {checked, meters?}}
let gigaLastResult = null;
window._gigaManualPrecio = false;
window._gigaRolloManual = false;

async function gigaLoadMateriales(opts = {}) {
    if (gigaMaterialesCache.length && !opts.force) return gigaMaterialesCache;
    const { data } = await db.from('materiales_gigantografia').select('*').order('orden').order('nombre');
    gigaMaterialesCache = data || [];
    return gigaMaterialesCache;
}

async function gigaLoadRollos(opts = {}) {
    if (gigaRollosCache.length && !opts.force) return gigaRollosCache;
    const { data } = await db.from('gigantografia_rollos').select('*').order('material_id').order('ancho_cm');
    gigaRollosCache = data || [];
    return gigaRollosCache;
}

async function gigaLoadConfig() {
    const { data } = await db.from('config').select('valor').eq('clave', 'giga_config').maybeSingle();
    if (data && data.valor) {
        try { gigaConfig = { ...gigaConfig, ...JSON.parse(data.valor) }; } catch (e) {}
    }
}

async function gigaInitTab() {
    await Promise.all([gigaLoadMateriales(), gigaLoadRollos(), gigaLoadConfig()]);
    gigaPopulateMaterialSelect();
    gigaRenderAditivos();
    gigaCalc();
}

function gigaPopulateMaterialSelect() {
    const sel = document.getElementById('gigaMaterial');
    if (!sel) return;
    const activos = gigaMaterialesCache.filter(m => m.activo && !['aditivo_m2','aditivo_ml'].includes(m.tipo));
    const grupos = {};
    activos.forEach(m => {
        const cat = m.categoria || 'Otros';
        (grupos[cat] = grupos[cat] || []).push(m);
    });
    let html = '<option value="">Elegir material...</option>';
    Object.keys(grupos).forEach(cat => {
        html += `<optgroup label="${cat}">`;
        grupos[cat].forEach(m => {
            const un = m.tipo === 'unidad' ? '/u' : '/m²';
            html += `<option value="${m.id}">${escapeHtml(m.nombre)} — $${(+m.precio_venta).toFixed(2)}${un}</option>`;
        });
        html += '</optgroup>';
    });
    sel.innerHTML = html;
}

function gigaRenderAditivos() {
    const cont = document.getElementById('gigaAditivosList');
    if (!cont) return;
    const matIdPrincipal = +document.getElementById('gigaMaterial').value;
    // Aditivos: aditivo_m2, aditivo_ml, Y planchas rigidas (m2 de categoria "Plancha rigida")
    // excluyendo el material principal para no duplicar
    const aditivos = gigaMaterialesCache.filter(m =>
        m.activo && m.id !== matIdPrincipal &&
        (['aditivo_m2','aditivo_ml'].includes(m.tipo) || (m.tipo === 'm2' && m.categoria === 'Plancha rigida'))
    );
    if (!aditivos.length) {
        cont.innerHTML = '<div style="font-size:0.8rem;color:var(--gray-400);">No hay aditivos configurados.</div>';
        return;
    }
    // Agrupar por categoria
    const grupos = {};
    aditivos.forEach(a => {
        const cat = a.categoria || 'Otros';
        (grupos[cat] = grupos[cat] || []).push(a);
    });
    let html = '';
    Object.keys(grupos).forEach(cat => {
        html += `<div style="font-size:0.72rem;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:0.5px;margin:0.5rem 0 0.25rem 0;">${cat}</div>`;
        grupos[cat].forEach(a => {
            const state = gigaAditivosSeleccionados[a.id] || {};
            const checked = state.checked ? 'checked' : '';
            const esML = a.tipo === 'aditivo_ml';
            const esPlancha = a.tipo === 'm2' && a.categoria === 'Plancha rigida';
            const metersDisplay = esML ? `
                <span style="font-size:0.78rem;color:#0e7490;font-weight:600;margin-left:0.5rem;">
                    <span data-giga-ml-display="${a.id}">${(+state.meters || 0).toFixed(2)}</span> m lineales (auto)
                </span>` : '';
            const unit = esML ? '/m lineal' : '/m²';
            const hint = esPlancha ? ' <span style="font-size:0.7rem;color:#0e7490;">(se pega encima)</span>' : '';
            html += `<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;margin-bottom:0.3rem;flex-wrap:wrap;">
                <input type="checkbox" data-giga-aditivo="${a.id}" ${checked} onchange="gigaOnAditivoToggle(${a.id}, this.checked)">
                ${a.nombre} <span style="color:var(--gray-500);font-size:0.78rem;">(+$${(+a.precio_venta).toFixed(2)}${unit})</span>${hint}
                ${metersDisplay}
            </label>`;
        });
    });
    cont.innerHTML = html;
}

function gigaOnAditivoToggle(id, checked) {
    gigaAditivosSeleccionados[id] = { ...(gigaAditivosSeleccionados[id] || {}), checked };
    gigaRenderAditivos();
    gigaCalc();
}

// Metros lineales de corte con estilete: suma de todas las lineas de la imposicion
// (perimetros de cada pieza menos bordes compartidos entre piezas contiguas)
function _gigaMetrosCorteImposicion(cols, cantidad, piezaWcm, piezaHcm) {
    if (!cols || !cantidad || !piezaWcm || !piezaHcm) return 0;
    const filasCompletas = Math.floor(cantidad / cols);
    const p = cantidad - filasCompletas * cols; // piezas en fila parcial
    const perimetros = cantidad * 2 * (piezaWcm + piezaHcm);
    let bordesH = (cols - 1) * filasCompletas * piezaHcm;
    if (p > 1) bordesH += (p - 1) * piezaHcm;
    let bordesV = 0;
    if (filasCompletas >= 2) bordesV += cols * (filasCompletas - 1) * piezaWcm;
    if (filasCompletas >= 1 && p > 0) bordesV += p * piezaWcm;
    return (perimetros - bordesH - bordesV) / 100; // cm -> m
}

function gigaOnMaterialChange() {
    const matId = +document.getElementById('gigaMaterial').value;
    const mat = gigaMaterialesCache.find(m => m.id === matId);
    const info = document.getElementById('gigaMaterialInfo');
    if (!mat) {
        info.textContent = '';
        document.getElementById('gigaPanelM2').style.display = '';
        document.getElementById('gigaPanelRollo').style.display = '';
        document.getElementById('gigaPanelUnidad').style.display = 'none';
        document.getElementById('gigaPanelAditivos').style.display = '';
        gigaRenderAditivos();
        gigaCalc(); return;
    }
    const esM2 = mat.tipo === 'm2';
    const esPlancha = mat.categoria === 'Plancha rigida';
    document.getElementById('gigaPanelM2').style.display = esM2 ? '' : 'none';
    document.getElementById('gigaPanelRollo').style.display = esM2 ? '' : 'none';
    document.getElementById('gigaPanelUnidad').style.display = esM2 ? 'none' : '';
    document.getElementById('gigaPanelAditivos').style.display = esM2 ? '' : 'none';
    let infoTxt = esM2
        ? `Precio lista $${(+mat.precio_venta).toFixed(2)}/m²`
        : `Precio $${(+mat.precio_venta).toFixed(2)}/unidad`;
    if (esPlancha) infoTxt += ' · plancha 120×240 cm (sin impresión directa)';
    info.textContent = infoTxt;
    window._gigaManualPrecio = false;
    window._gigaRolloManual = false;
    gigaRenderAditivos();
    gigaCalc();
}

// ===== Algoritmo imposicion: calcular rendimiento en un rollo dado =====
function _gigaPackRollo(anchoRolloCm, piezaWcm, piezaHcm, cantidad, permitirRotar) {
    // Probamos 2 orientaciones. Retornamos la que menos metros lineales usa.
    function intento(w, h) {
        const cols = Math.floor(anchoRolloCm / w);
        if (cols < 1) return null;
        const filas = Math.ceil(cantidad / cols);
        const largoCm = filas * h;
        return { cols, filas, largoCm, w, h, rotada: false };
    }
    const op1 = intento(piezaWcm, piezaHcm);
    const op2 = permitirRotar ? intento(piezaHcm, piezaWcm) : null;
    if (op2) op2.rotada = true;
    const opciones = [op1, op2].filter(Boolean);
    if (!opciones.length) return null;
    opciones.sort((a, b) => a.largoCm - b.largoCm);
    return opciones[0];
}

function gigaRollosDelMaterial(matId) {
    // Si el material hereda rollos de otro (combos), usar ese
    const mat = gigaMaterialesCache.find(m => m.id === matId);
    const effectiveId = (mat && mat.rollo_de_material_id) ? mat.rollo_de_material_id : matId;
    return gigaRollosCache.filter(r => r.material_id === effectiveId && r.activo);
}

// Retorna todos los rollos con su metrica: m facturados, m utiles, rendimiento
function gigaEvaluarRollos(mat, piezaWcm, piezaHcm, cantidad, permitirRotar) {
    if (!mat) return [];
    const rollos = gigaRollosDelMaterial(mat.id);
    // Planchas rigidas no tienen desperdicio lineal (no es rollo continuo)
    const esPlanchaRigida = mat.categoria === 'Plancha rigida';
    const desp = esPlanchaRigida ? 0 : ((gigaConfig.desperdicio_inicio_cm || 0) + (gigaConfig.desperdicio_fin_cm || 0));
    const m2_utiles = (piezaWcm * piezaHcm * cantidad) / 10000;

    return rollos.map(r => {
        const pack = _gigaPackRollo(+r.ancho_cm, piezaWcm, piezaHcm, cantidad, permitirRotar);
        if (!pack) return { rollo: r, ok: false, motivo: 'Pieza no entra en este ancho' };
        const largoNecesarioCm = pack.largoCm + desp;
        const largoNecesarioM = largoNecesarioCm / 100;
        const m2_facturados = (+r.ancho_cm / 100) * largoNecesarioM;
        const costoPorM2Rollo = +r.costo_rollo / ((+r.ancho_cm / 100) * +r.largo_total_m);
        // Plancha rigida: corte preciso, cobra solo m² útiles (sobrante se reutiliza)
        // Rollo: cobra m² facturados (sobrante lateral se descarta)
        const costoMaterial = esPlanchaRigida ? (m2_utiles * costoPorM2Rollo) : (m2_facturados * costoPorM2Rollo);
        const rendimiento = esPlanchaRigida ? 1 : m2_utiles / m2_facturados;
        const cabeLargo = largoNecesarioM <= +r.largo_total_m;
        const cabeInventario = !r.inventario_activo || (+r.m2_restantes >= m2_facturados);
        return {
            rollo: r, ok: true, pack, largoNecesarioCm, largoNecesarioM,
            m2_facturados: esPlanchaRigida ? m2_utiles : m2_facturados,
            m2_utiles, costoPorM2Rollo, costoMaterial, rendimiento, cabeLargo, cabeInventario,
            desperdicio_cm: desp, desperdicio_m2: (+r.ancho_cm/100) * (desp/100),
            esPlanchaRigida
        };
    }).filter(x => x.ok && x.cabeLargo).sort((a, b) => a.m2_facturados - b.m2_facturados);
}

function gigaPopulateRolloSelect(mat, piezaWcm, piezaHcm, cantidad, permitirRotar) {
    const sel = document.getElementById('gigaRolloSelect');
    const info = document.getElementById('gigaRolloInfo');
    if (!sel) return null;
    if (!mat || mat.tipo !== 'm2') { sel.innerHTML = ''; info.textContent = ''; return null; }
    const evals = gigaEvaluarRollos(mat, piezaWcm, piezaHcm, cantidad, permitirRotar);
    if (!evals.length) {
        sel.innerHTML = '<option>No hay rollos configurados</option>';
        info.textContent = 'Agrega rollos de este material en Admin → Giga Rollos';
        return null;
    }
    const prevVal = sel.value;
    sel.innerHTML = evals.map((e, i) => {
        const rend = (e.rendimiento * 100).toFixed(0);
        const inv = e.rollo.inventario_activo ? ` • ${(+e.rollo.m2_restantes).toFixed(1)} m² restantes` : ' • sin inventario';
        const best = i === 0 ? ' ⭐ mejor' : '';
        return `<option value="${e.rollo.id}">${+e.rollo.ancho_cm} cm — ${e.m2_facturados.toFixed(2)} m² facturado (${rend}% aprovechado)${inv}${best}</option>`;
    }).join('');
    if (window._gigaRolloManual && prevVal && evals.find(e => ''+e.rollo.id === prevVal)) {
        sel.value = prevVal;
    } else {
        sel.value = ''+evals[0].rollo.id;
    }
    const chosen = evals.find(e => ''+e.rollo.id === sel.value) || evals[0];
    info.innerHTML = `Layout: <strong>${chosen.pack.cols}</strong> columna${chosen.pack.cols>1?'s':''} × <strong>${chosen.pack.filas}</strong> fila${chosen.pack.filas>1?'s':''}${chosen.pack.rotada?' (piezas rotadas 90°)':''} → <strong>${(chosen.largoNecesarioM).toFixed(2)} m</strong> lineales necesarios (incluye ${chosen.desperdicio_cm} cm desperdicio)`;
    return chosen;
}

function gigaCalc() {
    const matId = +document.getElementById('gigaMaterial').value;
    const mat = gigaMaterialesCache.find(m => m.id === matId);
    if (!mat) { return gigaRenderResultados({ mat: null, esM2: true, cantidad: 0 }); }

    const esM2 = mat.tipo === 'm2';
    let payload = { mat, esM2 };

    if (esM2) {
        const anchoCm = parseFloat(document.getElementById('gigaAncho').value) || 0;
        const altoCm = parseFloat(document.getElementById('gigaAlto').value) || 0;
        const cantidad = parseInt(document.getElementById('gigaCantidad').value) || 0;
        const minM2 = parseFloat(document.getElementById('gigaMinM2').value) || 0;
        const permitirRotar = document.getElementById('gigaRolloRotar')?.checked ?? true;
        const cobertura = parseFloat(document.getElementById('gigaCobertura')?.value) || gigaConfig.cobertura_default_pct;
        const m2_real = (anchoCm * altoCm) / 10000;
        const area_por_pieza = Math.max(m2_real, minM2);
        const area_util_total = area_por_pieza * cantidad;

        // Alert ancho maximo
        const lmin = Math.min(anchoCm, altoCm);
        const alert = document.getElementById('gigaAnchoMaxAlert');
        if (lmin > GIGA_ANCHO_MAX_CM) {
            alert.style.display = '';
            alert.innerHTML = `⚠️ El lado menor (${lmin} cm) supera el ancho max RF-640 (${GIGA_ANCHO_MAX_CM} cm).`;
        } else { alert.style.display = 'none'; }

        // Rollo (recomendacion o seleccionado)
        const chosen = gigaPopulateRolloSelect(mat, anchoCm, altoCm, cantidad, permitirRotar);
        let costoMaterial = 0, m2_facturados = 0, costoDesp = 0, labelRollo = '-';
        if (chosen) {
            costoMaterial = chosen.costoMaterial;
            m2_facturados = chosen.m2_facturados;
            costoDesp = chosen.costoPorM2Rollo * chosen.desperdicio_m2;
            labelRollo = `Rollo ${+chosen.rollo.ancho_cm} cm · ${chosen.largoNecesarioM.toFixed(2)} m lineales × $${chosen.costoPorM2Rollo.toFixed(2)}/m²`;
            // Info recomendacion
            const alternas = gigaEvaluarRollos(mat, anchoCm, altoCm, cantidad, permitirRotar)
                .filter(e => ''+e.rollo.id !== ''+chosen.rollo.id).slice(0, 2);
            let recomHtml = `<strong>✅ Usando rollo ${+chosen.rollo.ancho_cm} cm.</strong>`;
            if (alternas.length) {
                recomHtml += ' Alternativas: ' + alternas.map(a =>
                    `${+a.rollo.ancho_cm} cm (${a.m2_facturados.toFixed(2)} m², ${(a.rendimiento*100).toFixed(0)}%)`
                ).join(', ');
            }
            document.getElementById('gigaRecomendacionInfo').style.display = '';
            document.getElementById('gigaRecomendacionInfo').innerHTML = recomHtml;
        } else {
            document.getElementById('gigaRecomendacionInfo').style.display = 'none';
        }

        // Plancha rigida como material principal: no se imprime sobre ella (sin tinta/mant)
        const matEsPlancha = mat.categoria === 'Plancha rigida';

        // Tinta (0 si es plancha rigida)
        const tintaMlPorM2 = matEsPlancha ? 0 : gigaConfig.tinta_ml_por_m2_100pct * (cobertura / 100);
        const costoTinta = matEsPlancha ? 0 : tintaMlPorM2 * gigaConfig.tinta_costo_ml * area_util_total;

        // Mantenimiento (0 si es plancha rigida)
        const costoFijoAnual = (+gigaConfig.mantenimiento_anual) + ((+gigaConfig.cabezal_costo) / Math.max(1,+gigaConfig.cabezal_vida_anios));
        const mantPorM2 = matEsPlancha ? 0 : costoFijoAnual / Math.max(1, +gigaConfig.m2_anuales_est);
        const costoMant = matEsPlancha ? 0 : mantPorM2 * area_util_total;

        // Metros lineales de cortes (auto-calculado del layout)
        const cols = chosen ? chosen.pack.cols : 0;
        const metrosCorteAuto = cols ? _gigaMetrosCorteImposicion(cols, cantidad, anchoCm, altoCm) : 0;

        // Aditivos (incluye aditivo_m2, aditivo_ml, y planchas rigidas como extra pegado encima)
        const costoAditivos = [], precioAditivos = [];
        Object.keys(gigaAditivosSeleccionados).forEach(id => {
            const st = gigaAditivosSeleccionados[id];
            if (!st.checked) return;
            const ad = gigaMaterialesCache.find(m => m.id === +id);
            if (!ad) return;
            if (ad.tipo === 'aditivo_ml') {
                gigaAditivosSeleccionados[id].meters = metrosCorteAuto;
                const disp = document.querySelector(`[data-giga-ml-display="${id}"]`);
                if (disp) disp.textContent = metrosCorteAuto.toFixed(2);
                const meters = metrosCorteAuto;
                costoAditivos.push({ nombre: `${ad.nombre} (${meters.toFixed(2)} m)`, costo: (+ad.costo_real) * meters });
                precioAditivos.push({ nombre: `${ad.nombre} (${meters.toFixed(2)} m)`, precio: (+ad.precio_venta) * meters });
            } else {
                // aditivo_m2 y planchas rigidas (m2) se cobran por m² del trabajo
                const etiqueta = ad.tipo === 'm2' && ad.categoria === 'Plancha rigida'
                    ? `${ad.nombre} (pegado encima)`
                    : ad.nombre;
                costoAditivos.push({ nombre: etiqueta, costo: (+ad.costo_real) * area_util_total });
                precioAditivos.push({ nombre: etiqueta, precio: (+ad.precio_venta) * area_util_total });
            }
        });

        // Precio lista: siempre usa el PVP del material × m² útiles
        const precioBase = (+mat.precio_venta) * area_util_total;

        payload = { ...payload, cantidad, ancho: anchoCm, alto: altoCm, area_por_pieza, area_util_total,
            m2_facturados, costoMaterial, costoDesp, costoTinta, costoMant, mantPorM2, tintaMlPorM2,
            costoAditivos, precioAditivos, precioBase, labelRollo, chosen, cobertura, permitirRotar };
    } else {
        const cantidad = parseInt(document.getElementById('gigaCantidadUni').value) || 0;
        payload = { ...payload, cantidad,
            costoMaterial: (+mat.costo_real) * cantidad,
            precioBase: (+mat.precio_venta) * cantidad,
            costoAditivos: [], precioAditivos: [],
            labelRollo: `${mat.nombre} (${cantidad} x $${(+mat.precio_venta).toFixed(2)})` };
    }

    payload.otrosCosto = parseFloat(document.getElementById('gigaOtrosCosto')?.value) || 0;
    gigaLastResult = payload;
    gigaRenderResultados(payload);
}

function gigaRenderResultados(r) {
    const esM2 = r.esM2;
    document.getElementById('gigaResArea').textContent = fmtN(r.area_por_pieza || 0, 2);
    document.getElementById('gigaResAreaTotal').textContent = fmtN(r.area_util_total || 0, 2);
    document.getElementById('gigaResAreaFacturada').textContent = fmtN(r.m2_facturados || 0, 2);
    document.getElementById('gigaCardFacturado').style.display = esM2 ? '' : 'none';

    // --- COSTO ---
    document.getElementById('gigaCostoMatLabel').textContent = r.labelRollo || 'Material';
    document.getElementById('gigaCostoMat').textContent = fmtN(r.costoMaterial || 0, 2);

    document.getElementById('gigaCostoDesp').textContent = fmtN(r.costoDesp || 0, 2);
    if (esM2 && r.costoDesp > 0) {
        document.getElementById('gigaCostoDespRow').style.display = '';
        document.getElementById('gigaCostoDespLabel').textContent = `(${(gigaConfig.desperdicio_inicio_cm+gigaConfig.desperdicio_fin_cm)} cm lineales)`;
    } else { document.getElementById('gigaCostoDespRow').style.display = 'none'; }

    if (esM2) {
        document.getElementById('gigaCostoTintaRow').style.display = '';
        document.getElementById('gigaCostoMantRow').style.display = '';
        document.getElementById('gigaCostoTintaLabel').textContent = `(${(r.tintaMlPorM2||0).toFixed(2)} ml/m² × ${(r.area_util_total||0).toFixed(2)} m²)`;
        document.getElementById('gigaCostoTinta').textContent = fmtN(r.costoTinta || 0, 2);
        document.getElementById('gigaCostoMantLabel').textContent = `($${(r.mantPorM2||0).toFixed(2)}/m² × ${(r.area_util_total||0).toFixed(2)} m²)`;
        document.getElementById('gigaCostoMant').textContent = fmtN(r.costoMant || 0, 2);
    } else {
        document.getElementById('gigaCostoTintaRow').style.display = 'none';
        document.getElementById('gigaCostoMantRow').style.display = 'none';
    }

    document.getElementById('gigaCostoAditivosList').innerHTML = (r.costoAditivos || []).map(a => `
        <div class="cost-row"><span class="cost-label">${a.nombre}</span>
        <span class="cost-value">$<span>${fmtN(a.costo, 2)}</span></span></div>`).join('');

    if ((r.otrosCosto || 0) > 0) {
        document.getElementById('gigaCostoOtrosRow').style.display = '';
        document.getElementById('gigaCostoOtros').textContent = fmtN(r.otrosCosto, 2);
    } else { document.getElementById('gigaCostoOtrosRow').style.display = 'none'; }

    const costoTotal = (r.costoMaterial||0) + (r.costoDesp||0) + (r.costoTinta||0) + (r.costoMant||0)
        + (r.costoAditivos||[]).reduce((s,a)=>s+a.costo,0) + (r.otrosCosto||0);
    document.getElementById('gigaCostoTotal').textContent = fmtN(costoTotal, 2);

    // --- PRECIO LISTA ---
    const labelPrecio = esM2 && r.mat
        ? `${r.mat.nombre} (${fmtN(r.area_util_total||0,2)} m² x $${(+r.mat.precio_venta).toFixed(2)})`
        : (r.mat ? `${r.mat.nombre} (${r.cantidad||0} x $${(+r.mat.precio_venta).toFixed(2)})` : 'Material');
    document.getElementById('gigaPrecioMatLabel').textContent = labelPrecio;
    document.getElementById('gigaPrecioMat').textContent = fmtN(r.precioBase || 0, 2);
    document.getElementById('gigaPrecioAditivosList').innerHTML = (r.precioAditivos || []).map(a => `
        <div class="cost-row"><span class="cost-label">${a.nombre}</span>
        <span class="cost-value">$<span>${fmtN(a.precio, 2)}</span></span></div>`).join('');

    let precioLista = (r.precioBase||0) + (r.precioAditivos||[]).reduce((s,a)=>s+a.precio,0);
    document.getElementById('gigaPrecioLista').textContent = fmtN(precioLista, 2);

    const precioManualUnit = parseFloat(document.getElementById('gigaPrecioUnitManual').value) || 0;
    if (!window._gigaManualPrecio) {
        const unitAuto = (r.cantidad || 0) > 0 ? precioLista / r.cantidad : 0;
        document.getElementById('gigaPrecioUnitManual').value = unitAuto.toFixed(2);
    } else if (precioManualUnit > 0) {
        precioLista = precioManualUnit * (r.cantidad || 0);
        document.getElementById('gigaPrecioLista').textContent = fmtN(precioLista, 2);
    }

    const precioUnit = (r.cantidad || 0) > 0 ? precioLista / r.cantidad : 0;
    document.getElementById('gigaResPrecioUnit').textContent = '$' + fmtN(precioUnit, 2);

    const descPct = parseFloat(document.getElementById('gigaDescuento').value) || 0;
    const descMonto = precioLista * (descPct / 100);
    if (descPct > 0) {
        document.getElementById('gigaDescuentoRow').style.display = '';
        document.getElementById('gigaDescuentoPct').textContent = descPct;
        document.getElementById('gigaDescuentoMonto').textContent = fmtN(descMonto, 2);
    } else { document.getElementById('gigaDescuentoRow').style.display = 'none'; }
    const precioSinIVA = precioLista - descMonto;
    document.getElementById('gigaPrecioFinalSinIVA').textContent = fmtN(precioSinIVA, 2);

    const ivaPct = parseFloat(document.getElementById('gigaIVA').value) || 0;
    const montoIVA = precioSinIVA * (ivaPct / 100);
    document.getElementById('gigaIVAPct').textContent = ivaPct;
    document.getElementById('gigaMontoIVA').textContent = fmtN(montoIVA, 2);
    const precioTotal = precioSinIVA + montoIVA;
    document.getElementById('gigaPrecioTotal').textContent = fmtN(precioTotal, 2);
    document.getElementById('gigaPrecioTotalBig').textContent = fmtN(precioTotal, 2);

    const utilidad = precioSinIVA - costoTotal;
    document.getElementById('gigaUtilidad').textContent = fmtN(utilidad, 2);
    document.getElementById('gigaUtilidadBig').textContent = fmtN(utilidad, 2);
    const margenVenta = precioSinIVA > 0 ? (utilidad / precioSinIVA) * 100 : 0;
    const markupCosto = costoTotal > 0 ? (utilidad / costoTotal) * 100 : 0;
    document.getElementById('gigaMargenVenta').textContent = fmtN(margenVenta, 1);
    document.getElementById('gigaMarkupCosto').textContent = fmtN(markupCosto, 1);
    document.getElementById('gigaAlertaPerdida').style.display = (utilidad < 0 && costoTotal > 0) ? '' : 'none';

    gigaDrawPreview(r);
}

function gigaDrawPreview(r) {
    const cv = document.getElementById('gigaPreview');
    const info = document.getElementById('gigaPreviewInfo');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    const cssW = cv.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;

    if (!r.esM2 || !r.chosen || !r.ancho || !r.alto) {
        info.textContent = r.esM2 ? 'Ingresa medidas y material para ver el layout' : 'Producto por unidad — sin vista previa';
        cv.width = cssW * dpr; cv.height = 180 * dpr; cv.style.height = '180px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, cssW, 180);
        return;
    }

    const rolloWcm = +r.chosen.rollo.ancho_cm;
    const largoCm = r.chosen.pack.largoCm;
    const totalLargoConDesp = largoCm + r.chosen.desperdicio_cm;
    const pack = r.chosen.pack;

    // Escala: el rollo se dibuja verticalmente (ancho horizontal, largo vertical)
    const padding = 30;
    const maxH = 320;
    const maxW = cssW - padding * 2;
    const scaleW = maxW / rolloWcm;
    const scaleH = maxH / totalLargoConDesp;
    const scale = Math.min(scaleW, scaleH);
    const canvasW = cssW;
    const canvasH = totalLargoConDesp * scale + padding * 2;

    cv.width = cssW * dpr; cv.height = canvasH * dpr; cv.style.height = canvasH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, canvasW, canvasH);

    const rolloX = (canvasW - rolloWcm * scale) / 2;
    const rolloY = padding;
    const rolloW = rolloWcm * scale;
    const rolloH = totalLargoConDesp * scale;

    // Dibujar rollo completo (fondo gris claro)
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(rolloX, rolloY, rolloW, rolloH);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.strokeRect(rolloX, rolloY, rolloW, rolloH);

    // Zona desperdicio inicio (arriba)
    const despInicio = gigaConfig.desperdicio_inicio_cm * scale;
    const despFin = gigaConfig.desperdicio_fin_cm * scale;
    ctx.fillStyle = '#fca5a5';
    ctx.fillRect(rolloX, rolloY, rolloW, despInicio);
    ctx.fillRect(rolloX, rolloY + rolloH - despFin, rolloW, despFin);

    // Piezas (comienzan despues del desperdicio inicio)
    const piezaW = pack.w * scale;
    const piezaH = pack.h * scale;
    const offsetY = rolloY + despInicio;
    ctx.fillStyle = '#bae6fd';
    ctx.strokeStyle = '#0891b2';
    ctx.lineWidth = 1.5;
    let piezasDibujadas = 0;
    for (let fila = 0; fila < pack.filas; fila++) {
        for (let col = 0; col < pack.cols; col++) {
            if (piezasDibujadas >= r.cantidad) break;
            const px = rolloX + col * piezaW;
            const py = offsetY + fila * piezaH;
            ctx.fillRect(px, py, piezaW, piezaH);
            ctx.strokeRect(px, py, piezaW, piezaH);
            piezasDibujadas++;
        }
    }
    // Sobrante lateral en gris (cols no aprovechadas)
    const usadoAncho = pack.cols * piezaW;
    if (usadoAncho < rolloW) {
        ctx.fillStyle = 'rgba(148,163,184,0.3)';
        ctx.fillRect(rolloX + usadoAncho, offsetY, rolloW - usadoAncho, pack.filas * piezaH);
    }

    // Labels
    ctx.fillStyle = '#0e7490';
    ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(rolloWcm + ' cm (ancho rollo)', rolloX + rolloW / 2, rolloY - 10);
    ctx.save();
    ctx.translate(rolloX - 10, rolloY + rolloH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(totalLargoConDesp.toFixed(1) + ' cm', 0, 0);
    ctx.restore();
    // Desp labels
    ctx.fillStyle = '#991b1b';
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.fillText(`⬆ ${gigaConfig.desperdicio_inicio_cm} cm desp.`, rolloX + rolloW / 2, rolloY + despInicio/2 + 3);
    ctx.fillText(`⬇ ${gigaConfig.desperdicio_fin_cm} cm desp.`, rolloX + rolloW / 2, rolloY + rolloH - despFin/2 + 3);

    info.innerHTML = `<strong>${r.cantidad}</strong> pieza${r.cantidad>1?'s':''} de ${pack.w}×${pack.h} cm en rollo de ${rolloWcm} cm → <strong>${(largoCm/100).toFixed(2)} m útiles</strong> + ${r.chosen.desperdicio_cm} cm desperdicio = <strong>${(totalLargoConDesp/100).toFixed(2)} m lineales</strong>. Rendimiento <strong>${((r.area_util_total/r.m2_facturados)*100).toFixed(0)}%</strong>.`;
}

// ===== Proforma integration =====
function _gigaBuildDescripcion() {
    const userText = document.getElementById('gigaDescripcion').value.trim();
    const matId = +document.getElementById('gigaMaterial').value;
    const mat = gigaMaterialesCache.find(m => m.id === matId);
    if (!mat) return userText || 'Gigantografia';
    const partes = [mat.nombre];
    if (mat.tipo === 'm2') {
        const a = +document.getElementById('gigaAncho').value || 0;
        const h = +document.getElementById('gigaAlto').value || 0;
        const c = +document.getElementById('gigaCantidad').value || 1;
        partes.push(`${a}x${h} cm`);
        if (c > 1) partes.push(`${c} piezas`);
        const ads = Object.keys(gigaAditivosSeleccionados)
            .filter(id => gigaAditivosSeleccionados[id].checked)
            .map(id => gigaMaterialesCache.find(m => m.id === +id)).filter(Boolean).map(a => a.nombre);
        if (ads.length) partes.push('con ' + ads.join(' + '));
    }
    return (userText || 'Gigantografia') + ' - ' + partes.join(' | ');
}

function _gigaCaptureSnapshot() {
    const r = gigaLastResult;
    const mat = r && r.mat;
    return {
        tipo: 'gigantografia',
        material: mat ? { id: mat.id, nombre: mat.nombre, tipo: mat.tipo, precio_venta: +mat.precio_venta, costo_real: +mat.costo_real } : null,
        medidas: r && r.esM2 ? { ancho: r.ancho, alto: r.alto } : null,
        cantidad: r ? r.cantidad : 0,
        area_por_pieza: r ? r.area_por_pieza : 0,
        area_util_total: r ? r.area_util_total : 0,
        m2_facturados: r ? r.m2_facturados : 0,
        rollo: r && r.chosen ? { id: r.chosen.rollo.id, ancho_cm: +r.chosen.rollo.ancho_cm,
            largo_m: r.chosen.largoNecesarioM, costo_por_m2: r.chosen.costoPorM2Rollo,
            pack: r.chosen.pack, desperdicio_cm: r.chosen.desperdicio_cm } : null,
        cobertura_pct: r ? r.cobertura : null,
        aditivos: Object.keys(gigaAditivosSeleccionados).filter(id => gigaAditivosSeleccionados[id].checked)
            .map(id => { const ad = gigaMaterialesCache.find(m => m.id === +id); const st = gigaAditivosSeleccionados[id];
                return ad ? { id: ad.id, nombre: ad.nombre, tipo: ad.tipo, precio_venta: +ad.precio_venta, costo_real: +ad.costo_real, meters: st.meters || null } : null;
            }).filter(Boolean),
        otros_costo: parseFloat(document.getElementById('gigaOtrosCosto').value) || 0,
        descuento: parseFloat(document.getElementById('gigaDescuento').value) || 0,
        iva: parseFloat(document.getElementById('gigaIVA').value) || 0,
        costo_total: parseFloat(document.getElementById('gigaCostoTotal').textContent.replace(',', '.')) || 0,
        precio_final: parseFloat(document.getElementById('gigaPrecioFinalSinIVA').textContent.replace(',', '.')) || 0,
        precio_unitario: parseFloat(document.getElementById('gigaPrecioUnitManual').value) || 0
    };
}

function _gigaCapturarDatosItem() {
    const matId = +document.getElementById('gigaMaterial').value;
    const mat = gigaMaterialesCache.find(m => m.id === matId);
    if (!mat) { alert('Elegi un material primero'); return null; }
    const esM2 = mat.tipo === 'm2';
    const cantidad = esM2
        ? (parseInt(document.getElementById('gigaCantidad').value) || 0)
        : (parseInt(document.getElementById('gigaCantidadUni').value) || 0);
    if (cantidad <= 0) { alert('Cantidad debe ser mayor a 0'); return null; }
    return {
        userText: document.getElementById('gigaDescripcion').value.trim(),
        descripcion: _gigaBuildDescripcion(),
        cantidad,
        precioUnit: parseFloat(document.getElementById('gigaPrecioUnitManual').value) || 0,
        itemIvaPct: parseFloat(document.getElementById('gigaIVA').value) || 0,
        snapshot: _gigaCaptureSnapshot()
    };
}

function addItemToProformaGiga() {
    if (!proformaActiva) return;
    const d = _gigaCapturarDatosItem();
    if (!d) return;
    proformaActiva.items.push({
        orden: proformaActiva.items.length + 1,
        descripcion: d.descripcion, cantidad: d.cantidad, precio_unitario: d.precioUnit,
        iva_pct: d.itemIvaPct, imagen_url: null,
        metodo_impresion: 'gigantografia',
        datos_cotizacion: d.snapshot
    });
    switchTab('proformas');
    renderProformaItems();
}

// ===== Admin Materiales Gigantografia =====
async function gigaAdminLoad() {
    await Promise.all([gigaLoadMateriales({ force: true }), gigaLoadRollos({ force: true })]);
    gigaAdminRender();
}

function gigaAdminRender() {
    const tbody = document.getElementById('gigaMaterialesBody');
    if (!tbody) return;
    // Materiales que tienen rollos propios (candidatos para herencia)
    const matsConRollos = gigaMaterialesCache.filter(m =>
        m.tipo === 'm2' && gigaRollosCache.some(r => r.material_id === m.id)
    );
    tbody.innerHTML = gigaMaterialesCache.map((m, i) => {
        const pv = +m.precio_venta, cr = +m.costo_real;
        const margen = pv > 0 && cr > 0 ? (((pv - cr) / pv) * 100).toFixed(1) : '-';
        const margenColor = margen === '-' ? 'var(--gray-400)' : (+margen < 15 ? '#dc2626' : (+margen < 30 ? '#d97706' : '#15803d'));
        const heredaSelect = m.tipo === 'm2' ? `
            <select style="width:140px" onchange="gigaAdminUpdate(${i},'rollo_de_material_id',this.value === '' ? null : +this.value)">
                <option value="">— propios —</option>
                ${matsConRollos.filter(x => x.id !== m.id).map(x =>
                    `<option value="${x.id}" ${m.rollo_de_material_id === x.id ? 'selected' : ''}>${escapeHtml(x.nombre)}</option>`
                ).join('')}
            </select>
        ` : '<span style="color:var(--gray-400);font-size:0.75rem;">—</span>';
        return `<tr style="${m.activo ? '' : 'opacity:0.5;'}">
            <td><input type="text" value="${(m.nombre || '').replace(/"/g, '&quot;')}" onchange="gigaAdminUpdate(${i},'nombre',this.value)"></td>
            <td><select style="width:120px" onchange="gigaAdminUpdate(${i},'tipo',this.value)">
                <option value="m2" ${m.tipo === 'm2' ? 'selected' : ''}>m²</option>
                <option value="aditivo_m2" ${m.tipo === 'aditivo_m2' ? 'selected' : ''}>Aditivo m²</option>
                <option value="aditivo_ml" ${m.tipo === 'aditivo_ml' ? 'selected' : ''}>Aditivo m lineal</option>
                <option value="unidad" ${m.tipo === 'unidad' ? 'selected' : ''}>Unidad</option>
            </select></td>
            <td><input type="text" value="${(m.categoria || '').replace(/"/g, '&quot;')}" style="width:110px" onchange="gigaAdminUpdate(${i},'categoria',this.value)"></td>
            <td><input type="number" value="${pv}" step="0.01" min="0" style="width:85px" onchange="gigaAdminUpdate(${i},'precio_venta',+this.value)"></td>
            <td><input type="number" value="${cr}" step="0.01" min="0" style="width:85px" onchange="gigaAdminUpdate(${i},'costo_real',+this.value)"></td>
            <td style="color:${margenColor};font-weight:600;">${margen === '-' ? '-' : margen + '%'}</td>
            <td>${heredaSelect}</td>
            <td style="text-align:center;"><input type="checkbox" ${m.activo ? 'checked' : ''} onchange="gigaAdminUpdate(${i},'activo',this.checked)"></td>
            <td><button class="btn btn-danger btn-sm" onclick="gigaAdminDelete(${i})">X</button></td>
        </tr>`;
    }).join('');
}

async function gigaAdminUpdate(i, field, val) {
    gigaMaterialesCache[i][field] = val;
    const m = gigaMaterialesCache[i];
    const { error } = await db.from('materiales_gigantografia').update({ [field]: val }).eq('id', m.id);
    if (error) { alert('Error: ' + error.message); return; }
    gigaAdminRender();
    gigaPopulateMaterialSelect();
    gigaRenderAditivos();
    gigaCalc();
}

async function gigaAdminDelete(i) {
    const m = gigaMaterialesCache[i];
    if (!confirm('Eliminar "' + m.nombre + '"?')) return;
    const { error } = await db.from('materiales_gigantografia').delete().eq('id', m.id);
    if (error) { alert('Error: ' + error.message); return; }
    gigaMaterialesCache.splice(i, 1);
    gigaAdminRender(); gigaPopulateMaterialSelect(); gigaRenderAditivos(); gigaCalc();
}

async function addMaterialGiga() {
    const maxOrden = gigaMaterialesCache.reduce((mx, m) => Math.max(mx, +m.orden || 0), 0);
    const { data, error } = await db.from('materiales_gigantografia')
        .insert({ nombre: 'Nuevo material', tipo: 'm2', precio_venta: 0, costo_real: 0, categoria: '', orden: maxOrden + 10 })
        .select().single();
    if (error) { alert('Error: ' + error.message); return; }
    gigaMaterialesCache.push(data);
    gigaAdminRender(); gigaPopulateMaterialSelect(); gigaRenderAditivos();
}

// ===== Admin Rollos =====
async function gigaRollosAdminLoad() {
    await Promise.all([gigaLoadMateriales({force:true}), gigaLoadRollos({force:true})]);
    gigaRollosAdminRender();
}

function gigaRollosAdminRender() {
    const tbody = document.getElementById('rollosBody');
    if (!tbody) return;
    const matsM2 = gigaMaterialesCache.filter(m => m.tipo === 'm2');
    tbody.innerHTML = gigaRollosCache.map((r, i) => {
        const costoPorM2 = (+r.costo_rollo) / ((+r.ancho_cm/100) * (+r.largo_total_m));
        const m2Ini = (+r.ancho_cm/100) * (+r.largo_total_m);
        return `<tr style="${r.activo ? '' : 'opacity:0.5;'}">
            <td><select style="width:170px" onchange="gigaRolloUpdate(${i},'material_id',+this.value)">
                ${matsM2.map(m => `<option value="${m.id}" ${r.material_id === m.id ? 'selected' : ''}>${escapeHtml(m.nombre)}</option>`).join('')}
            </select></td>
            <td><input type="number" step="1" min="1" value="${+r.ancho_cm}" style="width:70px" onchange="gigaRolloUpdate(${i},'ancho_cm',+this.value)"></td>
            <td><input type="number" step="0.5" min="0.1" value="${+r.largo_total_m}" style="width:70px" onchange="gigaRolloUpdate(${i},'largo_total_m',+this.value)"></td>
            <td><input type="number" step="0.01" min="0" value="${+r.costo_rollo}" style="width:90px" onchange="gigaRolloUpdate(${i},'costo_rollo',+this.value)"></td>
            <td style="font-weight:600;color:#0e7490;">$${costoPorM2.toFixed(2)}</td>
            <td>${m2Ini.toFixed(1)}</td>
            <td><input type="number" step="0.1" min="0" value="${(+r.m2_restantes).toFixed(1)}" style="width:80px" onchange="gigaRolloUpdate(${i},'m2_restantes',+this.value)"></td>
            <td style="text-align:center;"><input type="checkbox" ${r.inventario_activo ? 'checked' : ''} onchange="gigaRolloUpdate(${i},'inventario_activo',this.checked)"></td>
            <td style="text-align:center;"><input type="checkbox" ${r.activo ? 'checked' : ''} onchange="gigaRolloUpdate(${i},'activo',this.checked)"></td>
            <td><input type="text" value="${(r.factura||'').replace(/"/g,'&quot;')}" style="width:120px" onchange="gigaRolloUpdate(${i},'factura',this.value)" placeholder="# factura"></td>
            <td style="white-space:nowrap;">
                <button class="btn btn-secondary btn-sm" style="padding:0.2rem 0.4rem;font-size:0.7rem;" title="Historial" onclick="verConsumosRollo(${r.id})">📜</button>
                <button class="btn btn-danger btn-sm" onclick="gigaRolloDelete(${i})">X</button>
            </td>
        </tr>`;
    }).join('');
}

async function gigaRolloUpdate(i, field, val) {
    gigaRollosCache[i][field] = val;
    const r = gigaRollosCache[i];
    const { error } = await db.from('gigantografia_rollos').update({ [field]: val }).eq('id', r.id);
    if (error) { alert('Error: ' + error.message); return; }
    gigaRollosAdminRender();
}

async function gigaRolloDelete(i) {
    const r = gigaRollosCache[i];
    if (!confirm('Eliminar rollo ' + (+r.ancho_cm) + ' cm?')) return;
    const { error } = await db.from('gigantografia_rollos').delete().eq('id', r.id);
    if (error) { alert('Error: ' + error.message); return; }
    gigaRollosCache.splice(i, 1);
    gigaRollosAdminRender();
}

async function addRollo() {
    const matM2 = gigaMaterialesCache.find(m => m.tipo === 'm2');
    if (!matM2) { alert('Primero crea un material tipo m² en Giga Materiales'); return; }
    const { data, error } = await db.from('gigantografia_rollos')
        .insert({ material_id: matM2.id, ancho_cm: 100, largo_total_m: 50, costo_rollo: 0, inventario_activo: true, activo: true })
        .select().single();
    if (error) { alert('Error: ' + error.message); return; }
    gigaRollosCache.push(data);
    gigaRollosAdminRender();
}

// ===== Admin Config =====
async function gigaConfigLoad() {
    await gigaLoadConfig();
    document.getElementById('gcfgTintaMl').value = gigaConfig.tinta_ml_por_m2_100pct;
    document.getElementById('gcfgTintaCosto').value = gigaConfig.tinta_costo_ml;
    document.getElementById('gcfgCobertura').value = gigaConfig.cobertura_default_pct;
    document.getElementById('gcfgMantAnual').value = gigaConfig.mantenimiento_anual;
    document.getElementById('gcfgCabezalCosto').value = gigaConfig.cabezal_costo;
    document.getElementById('gcfgCabezalVida').value = gigaConfig.cabezal_vida_anios;
    document.getElementById('gcfgM2Anuales').value = gigaConfig.m2_anuales_est;
    document.getElementById('gcfgDespInicio').value = gigaConfig.desperdicio_inicio_cm;
    document.getElementById('gcfgDespFin').value = gigaConfig.desperdicio_fin_cm;
    gigaConfigUpdateResumen();
}

async function gigaConfigSave() {
    gigaConfig = {
        tinta_ml_por_m2_100pct: +document.getElementById('gcfgTintaMl').value || 0,
        tinta_costo_ml: +document.getElementById('gcfgTintaCosto').value || 0,
        cobertura_default_pct: +document.getElementById('gcfgCobertura').value || 60,
        mantenimiento_anual: +document.getElementById('gcfgMantAnual').value || 0,
        cabezal_costo: +document.getElementById('gcfgCabezalCosto').value || 0,
        cabezal_vida_anios: +document.getElementById('gcfgCabezalVida').value || 3,
        m2_anuales_est: +document.getElementById('gcfgM2Anuales').value || 1000,
        desperdicio_inicio_cm: +document.getElementById('gcfgDespInicio').value || 0,
        desperdicio_fin_cm: +document.getElementById('gcfgDespFin').value || 0
    };
    const { error } = await db.from('config').update({ valor: JSON.stringify(gigaConfig) }).eq('clave', 'giga_config');
    if (error) { alert('Error: ' + error.message); return; }
    gigaConfigUpdateResumen();
}

function gigaConfigUpdateResumen() {
    const tintaPorM2 = gigaConfig.tinta_ml_por_m2_100pct * (gigaConfig.cobertura_default_pct / 100) * gigaConfig.tinta_costo_ml;
    const costoFijoAnual = gigaConfig.mantenimiento_anual + (gigaConfig.cabezal_costo / Math.max(1, gigaConfig.cabezal_vida_anios));
    const mantPorM2 = costoFijoAnual / Math.max(1, gigaConfig.m2_anuales_est);
    document.getElementById('gigaConfigResumen').innerHTML = `
        <strong>Costos variables por m² útil (referencia):</strong><br>
        💧 Tinta (${gigaConfig.cobertura_default_pct}% cobertura) = $${tintaPorM2.toFixed(3)}/m²<br>
        🔧 Mantenimiento (amortizado) = $${mantPorM2.toFixed(3)}/m² — basado en $${costoFijoAnual.toFixed(0)}/año ÷ ${gigaConfig.m2_anuales_est} m²/año<br>
        <strong>Total fijo máquina: ~$${(tintaPorM2 + mantPorM2).toFixed(2)}/m²</strong><br>
        🗑 Desperdicio por trabajo: ${gigaConfig.desperdicio_inicio_cm + gigaConfig.desperdicio_fin_cm} cm lineales
    `;
}

// ===== Descuento de inventario al confirmar OP =====
async function gigaDescontarInventario(snapshot, trabajoId, ordenId, proformaItemId) {
    if (!snapshot || snapshot.tipo !== 'gigantografia' || !snapshot.rollo || !snapshot.rollo.id) return;
    const rollo = snapshot.rollo;
    const metrosUsados = +rollo.largo_m || 0;
    const anchoM = (+rollo.ancho_cm || 0) / 100;
    const m2Consumidos = metrosUsados * anchoM;
    const desperdicioM2 = ((+rollo.desperdicio_cm||0)/100) * anchoM;
    if (m2Consumidos <= 0) return;

    // Solo si el rollo tiene inventario_activo
    const { data: rolloDb } = await db.from('gigantografia_rollos').select('id, m2_restantes, inventario_activo').eq('id', rollo.id).maybeSingle();
    if (!rolloDb || !rolloDb.inventario_activo) return;

    const nuevoRestante = Math.max(0, (+rolloDb.m2_restantes) - m2Consumidos);
    await db.from('gigantografia_rollos').update({ m2_restantes: nuevoRestante }).eq('id', rollo.id);
    await db.from('gigantografia_consumos').insert({
        rollo_id: rollo.id, trabajo_id: trabajoId || null, orden_id: ordenId || null,
        proforma_item_id: proformaItemId || null,
        metros_lineales: metrosUsados, m2_consumidos: m2Consumidos, m2_desperdicio: desperdicioM2,
        created_by: currentUser?.id || null, created_by_name: currentUser?.nombre || null
    });
}

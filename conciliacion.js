// =====================================================
// CONCILIACION BANCARIA - con integracion Contifico API
// =====================================================
let concData = {
    facturas: [],
    depositos: [],
    bancoWeb: [],
    bancoCelular: [],
    matches: {},
    config: {},
    facturasById: {},  // lookup Map for O(1) access
    depositosById: {}, // lookup Map for O(1) access
    initialized: false
};
let concModalDepositoId = null;
let concModalSelected = new Set();

// Build ID lookup maps after loading data
function concBuildMaps() {
    concData.facturasById = {};
    concData.facturas.forEach(f => { concData.facturasById[f.id] = f; });
    concData.depositosById = {};
    concData.depositos.forEach(d => { concData.depositosById[d.id] = d; });
}

// =====================================================
// INIT
// =====================================================
async function concInit() {
    if (concData.initialized) { concRenderDepositos(); return; }
    try {
        const [facRes, depRes, matchRes, cfgRes] = await Promise.all([
            db.from('facturas').select('*').order('fecha', { ascending: false }),
            db.from('depositos').select('*').order('fecha', { ascending: false }),
            db.from('conciliacion_matches').select('*'),
            db.from('config').select('*')
        ]);
        concData.facturas = facRes.data || [];
        concData.depositos = depRes.data || [];
        concData.matches = {};
        (matchRes.data || []).forEach(m => {
            if (!concData.matches[m.deposito_id]) concData.matches[m.deposito_id] = [];
            concData.matches[m.deposito_id].push({ factura_id: m.factura_id, monto: +m.monto_aplicado });
        });
        concData.config = {};
        (cfgRes.data || []).forEach(c => { concData.config[c.clave] = c.valor; });
        concBuildMaps();
        concData.initialized = true;
        concUpdateResumen();
        concRenderDepositos();
    } catch (e) { console.error('concInit error:', e); }
}

// =====================================================
// CONTIFICO API: Sync all invoices
// =====================================================
async function concSyncContifico() {
    const status = document.getElementById('concContificoStatus');
    const apiKey = concData.config['contifico_api_key'];
    if (!apiKey) { status.innerHTML = '<span style="color:#dc2626;">API Key no configurada</span>'; return; }
    status.innerHTML = '<span style="color:var(--primary);">Sincronizando con Contifico...</span>';

    try {
        const resp = await fetch('https://ekrdnfecegwfavdgtgsa.supabase.co/functions/v1/contifico-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
            body: JSON.stringify({ endpoint: 'documento/', apiKey: apiKey })
        });
        if (!resp.ok) throw new Error('Proxy error: ' + resp.status);
        const docs = await resp.json();

        const facturas = docs.filter(d => d.tipo_documento === 'FAC' || d.tipo_documento === 'DNA').map(d => ({
            contifico_id: d.id,
            fecha: concParseDate(d.fecha_emision),
            tipo_documento: d.tipo_documento === 'FAC' ? 'Factura' : 'Doc no autorizado',
            numero_factura: d.documento,
            cliente: d.persona ? d.persona.razon_social : '',
            identificacion: d.persona ? (d.persona.ruc || d.persona.cedula || '') : '',
            total: parseFloat(d.total) || 0,
            saldo: parseFloat(d.saldo) || 0,
            retenciones: parseFloat(d.retenciones || 0),
            estado: d.estado === 'C' ? 'Cobrada' : d.estado === 'A' ? 'Anulada' : 'Pendiente',
            estado_pago: (d.estado === 'C' || parseFloat(d.saldo) === 0) ? 'pagada' : 'pendiente'
        }));

        // Batch upsert (50 at a time)
        let nuevas = 0;
        const batchSize = 50;
        for (let i = 0; i < facturas.length; i += batchSize) {
            const batch = facturas.slice(i, i + batchSize);
            await db.from('facturas').upsert(batch, { onConflict: 'numero_factura' });
            nuevas += batch.length;
            status.innerHTML = '<span style="color:var(--primary);">Sincronizando... ' + Math.min(i + batchSize, facturas.length) + '/' + facturas.length + '</span>';
        }

        // Reload and rebuild maps
        const facRes = await db.from('facturas').select('*').order('fecha', { ascending: false });
        concData.facturas = facRes.data || [];
        concBuildMaps();

        // Auto-conciliate using existing concAutoMatch (avoids code duplication)
        const autoConciliados = await concAutoMatchInternal();

        const totalPend = concData.facturas.filter(f => f.estado_pago === 'pendiente').length;
        const totalPag = facturas.filter(f => f.estado_pago === 'pagada').length;

        // Scan kanban: cruzar facturas con trabajos
        let scanMsg = '';
        if (typeof kanbanScanContifico === 'function') {
            try {
                const scan = await kanbanScanContifico();
                const total = scan.movidosACobro + scan.movidosAPostventa;
                if (total > 0) scanMsg = '<br>' + total + ' trabajos movidos (' + scan.movidosACobro + ' a Cobro, ' + scan.movidosAPostventa + ' a Postventa)';
            } catch (e) { console.error('kanbanScanContifico error:', e); }
        }

        status.innerHTML = '<span style="color:#059669;">' + facturas.length + ' facturas sincronizadas<br>' + totalPend + ' pendientes, ' + totalPag + ' pagadas' + (autoConciliados > 0 ? '<br>' + autoConciliados + ' depositos auto-conciliados' : '') + scanMsg + '</span>';

        concUpdateResumen();
        concRenderDepositos();
    } catch (e) {
        status.innerHTML = '<span style="color:#dc2626;">Error: ' + e.message + '</span>';
        console.error('Contifico sync error:', e);
    }
}

// =====================================================
// PARSE: Contifico .xls (manual fallback)
// =====================================================
async function concLoadContifico(file) {
    const status = document.getElementById('concContificoStatus');
    status.textContent = 'Leyendo...';
    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        let headerIdx = -1;
        for (let i = 0; i < Math.min(10, rows.length); i++) {
            const row = rows[i].map(c => String(c || '').trim());
            if (row.includes('Fecha') && row.includes('Total')) { headerIdx = i; break; }
        }
        if (headerIdx < 0) { status.textContent = 'Error: no se encontro encabezado'; return; }

        const headers = rows[headerIdx].map(c => String(c || '').trim());
        const iF = headers.indexOf('Fecha'), iTD = headers.indexOf('Tipo Documento'), iND = headers.indexOf('# Documento');
        const iP = headers.indexOf('Persona'), iId = headers.indexOf('Identificación');
        const iSI = headers.indexOf('Subtotal IVA mayor a 0%'), iS0 = headers.indexOf('Subtotal IVA 0%');
        const iIVA = headers.indexOf('IVA'), iT = headers.indexOf('Total'), iSa = headers.indexOf('Saldo');
        const iR = headers.indexOf('Retenciones'), iDe = headers.indexOf('Descripción');

        const facturas = [];
        for (let i = headerIdx + 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r || !r[iND]) continue;
            const saldo = parseFloat(r[iSa]) || 0;
            facturas.push({
                fecha: concParseDate(r[iF]),
                tipo_documento: String(r[iTD] || '').trim(),
                numero_factura: String(r[iND] || '').trim(),
                cliente: String(r[iP] || '').trim(),
                identificacion: String(r[iId] || '').trim(),
                subtotal_iva: parseFloat(r[iSI]) || 0, subtotal_0: parseFloat(r[iS0]) || 0,
                iva: parseFloat(r[iIVA]) || 0, total: parseFloat(r[iT]) || 0,
                saldo: saldo, retenciones: parseFloat(r[iR]) || 0,
                descripcion: String(r[iDe] || '').trim().substring(0, 200),
                estado_pago: saldo > 0 ? 'pendiente' : 'pagada'
            });
        }

        // Batch upsert (same pattern as sync)
        const batchSize = 50;
        for (let i = 0; i < facturas.length; i += batchSize) {
            await db.from('facturas').upsert(facturas.slice(i, i + batchSize), { onConflict: 'numero_factura', ignoreDuplicates: true });
        }

        const facRes = await db.from('facturas').select('*').order('fecha', { ascending: false });
        concData.facturas = facRes.data || [];
        concBuildMaps();
        status.innerHTML = '<span style="color:#059669;">' + facturas.length + ' facturas cargadas</span>';
        concUpdateResumen();
        concRenderDepositos();
    } catch (e) { status.textContent = 'Error: ' + e.message; console.error(e); }
}

// =====================================================
// PARSE: Banco Web .xlsx
// =====================================================
async function concLoadBancoWeb(file) {
    const status = document.getElementById('concWebStatus');
    status.textContent = 'Leyendo...';
    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
        const creditos = [];
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r || r.length < 7) continue;
            const credito = parseFloat(r[5]) || 0;
            if (credito <= 0) continue;
            creditos.push({ fecha: concParseDate(String(r[0] || '')), doc_numero: String(r[2] || '').trim(), descripcion_web: String(r[3] || '').trim(), monto: credito });
        }
        concData.bancoWeb = creditos;
        status.innerHTML = '<span style="color:#059669;">' + creditos.length + ' depositos</span>';
        if (concData.bancoCelular.length > 0) await concMergeAndSave();
        else status.innerHTML += '<br><span style="color:var(--gray-400);">Sube el estado celular para completar nombres</span>';
    } catch (e) { status.textContent = 'Error: ' + e.message; console.error(e); }
}

// =====================================================
// PARSE: Banco Celular .xlsx
// =====================================================
async function concLoadBancoCelular(file) {
    const status = document.getElementById('concCelStatus');
    status.textContent = 'Leyendo...';
    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const allRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 'A', defval: '' });
        const creditos = [];
        for (let i = 0; i < allRows.length; i++) {
            const row = allRows[i];
            if (String(row['K'] || '').trim() !== 'Crédito') continue;
            const concepto = String(row['E'] || '').trim();
            const monto = concParseMontoEC(String(row['O'] || ''));
            const fecha = String(row['D'] || '').trim();
            let doc_numero = (i + 1 < allRows.length) ? String(allRows[i + 1]['H'] || '').trim() : '';
            let nombre = '';
            const deMatch = concepto.match(/(?:TRANSF\.\s*(?:DIRECTA|INTERBANCARIA)\s*DE\s+)(.+)/i);
            if (deMatch) nombre = deMatch[1].trim();
            else if (concepto.includes('DEPÓSITO')) nombre = concepto;
            else nombre = concepto;
            if (monto > 0) creditos.push({ fecha: concParseDateCelular(fecha), fecha_hora: fecha, doc_numero, concepto_celular: concepto, nombre_depositante: nombre, monto });
        }
        concData.bancoCelular = creditos;
        status.innerHTML = '<span style="color:#059669;">' + creditos.length + ' depositos</span>';
        if (concData.bancoWeb.length > 0) await concMergeAndSave();
        else status.innerHTML += '<br><span style="color:var(--gray-400);">Sube el estado web para completar descripciones</span>';
    } catch (e) { status.textContent = 'Error: ' + e.message; console.error(e); }
}

// =====================================================
// MERGE both bank statements
// =====================================================
async function concMergeAndSave() {
    const webMap = {};
    concData.bancoWeb.forEach(w => { webMap[w.doc_numero] = w; });
    const merged = [];
    const usedWebDocs = new Set();
    concData.bancoCelular.forEach(c => {
        const web = webMap[c.doc_numero];
        merged.push({ fecha: c.fecha, fecha_hora: c.fecha_hora || '', monto: c.monto, doc_numero: c.doc_numero, concepto_celular: c.concepto_celular, descripcion_web: web ? web.descripcion_web : '', nombre_depositante: c.nombre_depositante, tipo_transaccion: concDetectTipoTx(web ? web.descripcion_web : c.concepto_celular) });
        if (c.doc_numero) usedWebDocs.add(c.doc_numero);
    });
    concData.bancoWeb.forEach(w => {
        if (!usedWebDocs.has(w.doc_numero)) {
            merged.push({ fecha: w.fecha, fecha_hora: '', monto: w.monto, doc_numero: w.doc_numero, concepto_celular: '', descripcion_web: w.descripcion_web, nombre_depositante: concExtractNombreWeb(w.descripcion_web), tipo_transaccion: concDetectTipoTx(w.descripcion_web) });
        }
    });
    // Batch upsert (50 at a time)
    const batchSize = 50;
    for (let i = 0; i < merged.length; i += batchSize) {
        await db.from('depositos').upsert(merged.slice(i, i + batchSize), { onConflict: 'doc_numero,monto,fecha', ignoreDuplicates: true });
    }
    const depRes = await db.from('depositos').select('*').order('fecha', { ascending: false });
    concData.depositos = depRes.data || [];
    concBuildMaps();
    document.getElementById('concWebStatus').innerHTML = '<span style="color:#059669;">Merged! ' + merged.length + ' depositos</span>';
    document.getElementById('concCelStatus').innerHTML = '<span style="color:#059669;">Merged! ' + merged.length + ' depositos</span>';
    concUpdateResumen();
    concRenderDepositos();
}

// =====================================================
// AUTO-MATCH (internal - returns count, no alert)
// =====================================================
async function concAutoMatchInternal() {
    const pendientes = concData.facturas.filter(f => f.estado_pago === 'pendiente');
    const sinConciliar = concData.depositos.filter(d => d.estado === 'sin_conciliar');
    if (pendientes.length === 0 || sinConciliar.length === 0) return 0;

    let matched = 0;
    const tolerance = 0.02;
    const usedFacturas = new Set();
    const newMatches = []; // collect for batch save
    const depUpdates = []; // collect deposit IDs to update

    for (const dep of sinConciliar) {
        const monto = +dep.monto;
        let found = false;
        // 1. Exact match single invoice
        for (const f of pendientes) {
            if (!usedFacturas.has(f.id) && Math.abs(f.saldo - monto) <= tolerance && concNombreCoincide(dep.nombre_depositante, f.cliente)) {
                concData.matches[dep.id] = [{ factura_id: f.id, monto: f.saldo }];
                newMatches.push({ deposito_id: dep.id, factura_id: f.id, monto_aplicado: f.saldo });
                depUpdates.push(dep.id);
                usedFacturas.add(f.id);
                dep.estado = 'conciliado';
                found = true; matched++; break;
            }
        }
        // 2. Combination of invoices from same client
        if (!found) {
            const clientFacs = pendientes.filter(f => !usedFacturas.has(f.id) && concNombreCoincide(dep.nombre_depositante, f.cliente));
            if (clientFacs.length >= 2 && clientFacs.length <= 8) {
                const combo = concFindCombination(clientFacs.map(f => f.saldo), monto, tolerance);
                if (combo) {
                    const mfs = combo.map(idx => clientFacs[idx]);
                    concData.matches[dep.id] = mfs.map(f => ({ factura_id: f.id, monto: f.saldo }));
                    mfs.forEach(f => {
                        newMatches.push({ deposito_id: dep.id, factura_id: f.id, monto_aplicado: f.saldo });
                        usedFacturas.add(f.id);
                    });
                    depUpdates.push(dep.id);
                    dep.estado = 'conciliado'; matched++;
                }
            }
        }
    }

    // Batch save matches and updates
    if (newMatches.length > 0) {
        const batchSize = 50;
        for (let i = 0; i < newMatches.length; i += batchSize) {
            await db.from('conciliacion_matches').upsert(newMatches.slice(i, i + batchSize), { onConflict: 'deposito_id,factura_id' });
        }
    }
    // Batch update deposit states
    await Promise.all(depUpdates.map(id => db.from('depositos').update({ estado: 'conciliado' }).eq('id', id)));
    // Batch update invoice states
    const matchedFacIds = [...usedFacturas];
    await Promise.all(matchedFacIds.map(id => {
        const f = concData.facturasById[id];
        if (f) f.estado_pago = 'pagada';
        return db.from('facturas').update({ estado_pago: 'pagada', fecha_pago: new Date().toISOString() }).eq('id', id);
    }));

    return matched;
}

// Public auto-match with alert
async function concAutoMatch() {
    if (concData.facturas.length === 0 || concData.depositos.length === 0) { alert('Necesitas facturas y depositos cargados'); return; }
    const matched = await concAutoMatchInternal();
    concUpdateResumen();
    concRenderDepositos();
    let scanMsg = '';
    if (typeof kanbanScanContifico === 'function') {
        try {
            const scan = await kanbanScanContifico();
            const total = scan.movidosACobro + scan.movidosAPostventa;
            if (total > 0) scanMsg = '\nKanban: ' + scan.movidosACobro + ' a Cobro, ' + scan.movidosAPostventa + ' a Postventa';
        } catch (e) { console.error('kanbanScanContifico error:', e); }
    }
    alert('Auto-conciliacion: ' + matched + ' depositos conciliados' + scanMsg);
}

function concFindCombination(amounts, target, tolerance, maxItems = 5) {
    for (let size = 1; size <= Math.min(maxItems, amounts.length); size++) {
        const result = concCombHelper(amounts, target, tolerance, 0, size, [], 0);
        if (result) return result;
    }
    return null;
}
function concCombHelper(amounts, target, tolerance, start, remaining, current, sum) {
    if (remaining === 0) return Math.abs(sum - target) <= tolerance ? [...current] : null;
    for (let i = start; i < amounts.length; i++) {
        if (sum + amounts[i] > target + tolerance) continue;
        current.push(i);
        const r = concCombHelper(amounts, target, tolerance, i + 1, remaining - 1, current, sum + amounts[i]);
        if (r) return r;
        current.pop();
    }
    return null;
}
function concNombreCoincide(depositante, cliente) {
    if (!depositante || !cliente) return false;
    const d = depositante.toUpperCase().replace(/[^A-Z0-9\s]/g, '').trim();
    const c = cliente.toUpperCase().replace(/[^A-Z0-9\s]/g, '').trim();
    if (!d || !c) return false;
    if (d.includes(c) || c.includes(d)) return true;
    const dW = d.split(/\s+/).filter(w => w.length > 2);
    const cW = c.split(/\s+/).filter(w => w.length > 2);
    let m = 0;
    for (const dw of dW) { for (const cw of cW) { if (dw === cw || dw.includes(cw) || cw.includes(dw)) { m++; break; } } }
    return m >= 2;
}

// =====================================================
// SAVE: Only specific matches (not all)
// =====================================================
async function concSaveSpecificMatches(depositoId, matchedFacturas, docNumero, fechaPago) {
    const dep = concData.depositosById[depositoId];
    // Save matches to DB
    const inserts = matchedFacturas.map(m => ({ deposito_id: depositoId, factura_id: m.factura_id, monto_aplicado: m.monto }));
    await db.from('conciliacion_matches').upsert(inserts, { onConflict: 'deposito_id,factura_id' });
    await db.from('depositos').update({ estado: 'conciliado' }).eq('id', depositoId);

    // Update invoices
    await Promise.all(matchedFacturas.map(m => {
        const f = concData.facturasById[m.factura_id];
        if (f) f.estado_pago = 'pagada';
        return db.from('facturas').update({ estado_pago: 'pagada', fecha_pago: new Date().toISOString() }).eq('id', m.factura_id);
    }));
}

// =====================================================
// UI: Render deposits
// =====================================================
function concRenderDepositos() {
    const tbody = document.getElementById('concDepositosBody');
    if (!tbody) return;
    const filtro = document.getElementById('concFiltroEstado').value;
    const buscar = (document.getElementById('concBuscar').value || '').toLowerCase();
    document.getElementById('concResumen').style.display = concData.depositos.length > 0 || concData.facturas.length > 0 ? 'block' : 'none';
    document.getElementById('concTablaSection').style.display = concData.depositos.length > 0 ? 'block' : 'none';

    let deps = concData.depositos;
    if (filtro !== 'todos') deps = deps.filter(d => d.estado === filtro);
    if (buscar) deps = deps.filter(d =>
        (d.nombre_depositante || '').toLowerCase().includes(buscar) ||
        (d.descripcion_web || '').toLowerCase().includes(buscar) ||
        String(d.monto).includes(buscar)
    );

    let html = '';
    for (const d of deps) {
        const matches = concData.matches[d.id] || [];
        const facturasHtml = matches.map(m => {
            const f = concData.facturasById[m.factura_id];
            return f ? '<span style="background:#dcfce7;color:#059669;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.72rem;">' + f.numero_factura + '</span>' : '';
        }).join(' ');
        const eC = d.estado === 'conciliado', eNA = d.estado === 'no_aplica';
        const estadoColor = eC ? '#059669' : eNA ? '#6b7280' : '#d97706';
        const estadoBg = eC ? '#dcfce7' : eNA ? '#f3f4f6' : '#fef3c7';
        const estadoLabel = eC ? 'Conciliado' : eNA ? 'No aplica' : 'Sin conciliar';
        html += '<tr style="border-bottom:1px solid var(--gray-100);">';
        html += '<td style="padding:0.4rem 0.5rem;white-space:nowrap;font-size:0.78rem;">' + (d.fecha || '') + '</td>';
        html += '<td style="padding:0.4rem 0.5rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;font-size:0.78rem;" title="' + (d.concepto_celular || '').replace(/"/g, '') + '">' + (d.nombre_depositante || '<em style=color:var(--gray-400)>sin nombre</em>') + '</td>';
        html += '<td style="padding:0.4rem 0.5rem;text-align:right;font-weight:600;font-size:0.85rem;">$' + fmtN(+d.monto, 2) + '</td>';
        html += '<td style="padding:0.4rem 0.5rem;font-size:0.78rem;color:var(--gray-600);">' + (d.doc_numero || '—') + '</td>';
        html += '<td style="padding:0.4rem 0.5rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;font-size:0.72rem;color:var(--gray-500);" title="' + (d.descripcion_web || '').replace(/"/g, '') + '">' + (d.descripcion_web || d.concepto_celular || '').substring(0, 40) + '</td>';
        html += '<td style="padding:0.4rem 0.5rem;text-align:center;"><span style="background:' + estadoBg + ';color:' + estadoColor + ';padding:0.15rem 0.4rem;border-radius:4px;font-size:0.72rem;font-weight:600;">' + estadoLabel + '</span></td>';
        html += '<td style="padding:0.4rem 0.5rem;font-size:0.72rem;">' + (facturasHtml || '—') + '</td>';
        html += '<td style="padding:0.4rem 0.5rem;text-align:center;">';
        if (d.estado === 'sin_conciliar') html += '<button onclick="concOpenModal(' + d.id + ')" style="background:var(--primary);color:white;border:none;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.72rem;cursor:pointer;">Conciliar</button>';
        else if (eC) html += '<button onclick="concUndoMatch(' + d.id + ')" style="background:var(--gray-200);color:var(--gray-600);border:none;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.72rem;cursor:pointer;">Deshacer</button>';
        else if (eNA) html += '<button onclick="concRevertNoAplica(' + d.id + ')" style="background:var(--gray-200);color:var(--gray-600);border:none;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.72rem;cursor:pointer;">Revertir</button>';
        html += '</td></tr>';
    }
    tbody.innerHTML = html || '<tr><td colspan="8" style="padding:2rem;text-align:center;color:var(--gray-400);">No hay depositos cargados</td></tr>';
}

function concUpdateResumen() {
    const totalFact = concData.facturas.filter(f => f.estado_pago === 'pendiente').length;
    // Single pass for deposit counts
    let conciliados = 0, sinConc = 0, noAplica = 0;
    concData.depositos.forEach(d => {
        if (d.estado === 'conciliado') conciliados++;
        else if (d.estado === 'sin_conciliar') sinConc++;
        else if (d.estado === 'no_aplica') noAplica++;
    });
    document.getElementById('concResFacturas').textContent = totalFact;
    document.getElementById('concResDepositos').textContent = concData.depositos.length;
    document.getElementById('concResConciliados').textContent = conciliados;
    document.getElementById('concResSinConciliar').textContent = sinConc;
    document.getElementById('concResAlertas').textContent = noAplica;
}

// =====================================================
// MODAL
// =====================================================
function concOpenModal(depositoId) {
    concModalDepositoId = depositoId;
    concModalSelected = new Set();
    const dep = concData.depositosById[depositoId];
    if (!dep) return;
    document.getElementById('concModalDepInfo').innerHTML = '<strong>' + (dep.nombre_depositante || 'Sin nombre') + '</strong> — $' + fmtN(+dep.monto, 2) + ' — ' + dep.fecha + '<br><span style="font-size:0.75rem;color:var(--gray-400);">Doc: ' + (dep.doc_numero || '-') + '</span>';
    const pendientes = concData.facturas.filter(f => f.estado_pago === 'pendiente');
    document.getElementById('concModalSugerencias').innerHTML = concBuildSuggestions(dep, pendientes);
    concRenderModalFacturas();
    concUpdateModalTotal();
    document.getElementById('concModal').style.display = 'block';
}
function concCloseModal() { document.getElementById('concModal').style.display = 'none'; concModalDepositoId = null; concModalSelected = new Set(); }

function concBuildSuggestions(dep, facturas) {
    const monto = +dep.monto, tolerance = 0.02, suggestions = [];
    for (const f of facturas) {
        if (Math.abs(f.saldo - monto) <= tolerance) suggestions.push({ label: 'Coincidencia exacta', facturas: [f], diff: Math.abs(f.saldo - monto) });
    }
    const clientFacs = facturas.filter(f => concNombreCoincide(dep.nombre_depositante, f.cliente));
    if (clientFacs.length >= 2) {
        const combo = concFindCombination(clientFacs.map(f => f.saldo), monto, tolerance, 5);
        if (combo) suggestions.push({ label: 'Combinacion (' + combo.length + ' facturas)', facturas: combo.map(i => clientFacs[i]), diff: Math.abs(combo.reduce((s, i) => s + clientFacs[i].saldo, 0) - monto) });
    }
    if (suggestions.length === 0) return '<div style="background:#fef3c7;padding:0.5rem;border-radius:6px;font-size:0.8rem;color:#92400e;">Sin sugerencias. Selecciona facturas manualmente.</div>';
    let html = '<div style="font-weight:600;font-size:0.8rem;color:var(--gray-600);margin-bottom:0.3rem;">Sugerencias</div>';
    suggestions.forEach(s => {
        const ids = s.facturas.map(f => f.id);
        html += '<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:0.4rem 0.6rem;margin-bottom:0.3rem;cursor:pointer;" onclick="concApplySuggestion([' + ids.join(',') + '])">';
        html += '<div style="font-size:0.78rem;font-weight:600;color:#059669;">' + s.label + '</div>';
        html += '<div style="font-size:0.72rem;color:#065f46;">' + s.facturas.map(f => f.numero_factura + ' — ' + f.cliente.substring(0, 25) + ' — $' + fmtN(f.saldo, 2)).join('<br>') + '</div></div>';
    });
    return html;
}
function concApplySuggestion(ids) { concModalSelected = new Set(ids); concRenderModalFacturas(); concUpdateModalTotal(); }

function concRenderModalFacturas() {
    const container = document.getElementById('concModalFacturas');
    const buscar = (document.getElementById('concModalBuscar').value || '').toLowerCase();
    let facturas = concData.facturas.filter(f => f.estado_pago === 'pendiente');
    if (buscar) facturas = facturas.filter(f => (f.cliente || '').toLowerCase().includes(buscar) || (f.numero_factura || '').toLowerCase().includes(buscar) || String(f.saldo).includes(buscar));
    let html = '';
    for (const f of facturas) {
        const ck = concModalSelected.has(f.id);
        html += '<div style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--gray-100);display:flex;align-items:center;gap:0.4rem;cursor:pointer;' + (ck ? 'background:#ecfdf5;' : '') + '" onclick="concToggleFactura(' + f.id + ')">';
        html += '<input type="checkbox" ' + (ck ? 'checked' : '') + ' style="pointer-events:none;">';
        html += '<div style="flex:1;min-width:0;"><div style="font-size:0.78rem;font-weight:600;">' + f.cliente + '</div>';
        html += '<div style="font-size:0.7rem;color:var(--gray-500);">' + f.numero_factura + '</div></div>';
        html += '<div style="font-weight:700;font-size:0.82rem;white-space:nowrap;">$' + fmtN(f.saldo, 2) + '</div></div>';
    }
    container.innerHTML = html || '<div style="padding:1rem;text-align:center;color:var(--gray-400);">No hay facturas pendientes</div>';
}
function concToggleFactura(id) { concModalSelected.has(id) ? concModalSelected.delete(id) : concModalSelected.add(id); concRenderModalFacturas(); concUpdateModalTotal(); }

function concUpdateModalTotal() {
    const dep = concData.depositosById[concModalDepositoId];
    if (!dep) return;
    let total = 0;
    concModalSelected.forEach(fId => { const f = concData.facturasById[fId]; if (f) total += f.saldo; });
    document.getElementById('concModalTotal').textContent = fmtN(total, 2);
    const diff = total - (+dep.monto);
    const diffEl = document.getElementById('concModalDiff');
    if (Math.abs(diff) <= 0.02 && concModalSelected.size > 0) {
        diffEl.innerHTML = '<span style="color:#059669;font-weight:600;">✓ Coincide</span>';
        document.getElementById('concModalConfirm').disabled = false;
    } else if (concModalSelected.size > 0) {
        diffEl.innerHTML = '<span style="color:#dc2626;">Dif: $' + fmtN(Math.abs(diff), 2) + ' (' + (diff > 0 ? 'excede' : 'falta') + ')</span>';
        document.getElementById('concModalConfirm').disabled = Math.abs(diff) > 5;
    } else { diffEl.textContent = ''; document.getElementById('concModalConfirm').disabled = true; }
}

async function concConfirmMatch() {
    if (!concModalDepositoId || concModalSelected.size === 0) return;
    const dep = concData.depositosById[concModalDepositoId];
    if (!dep) return;
    const matchedFacturas = [];
    concModalSelected.forEach(fId => { const f = concData.facturasById[fId]; if (f) matchedFacturas.push({ factura_id: f.id, monto: f.saldo }); });
    concData.matches[dep.id] = matchedFacturas;
    dep.estado = 'conciliado';
    await concSaveSpecificMatches(dep.id, matchedFacturas, dep.doc_numero, dep.fecha);
    concCloseModal();
    concUpdateResumen();
    concRenderDepositos();
}

async function concMarcarNoAplica() {
    if (!concModalDepositoId) return;
    const dep = concData.depositosById[concModalDepositoId];
    if (!dep) return;
    const nota = prompt('Nota (opcional):');
    dep.estado = 'no_aplica'; dep.nota = nota || '';
    await db.from('depositos').update({ estado: 'no_aplica', nota: nota || '' }).eq('id', dep.id);
    concCloseModal(); concUpdateResumen(); concRenderDepositos();
}

async function concRevertNoAplica(depositoId) {
    const dep = concData.depositosById[depositoId];
    if (!dep) return;
    dep.estado = 'sin_conciliar'; dep.nota = '';
    await db.from('depositos').update({ estado: 'sin_conciliar', nota: '' }).eq('id', dep.id);
    concUpdateResumen(); concRenderDepositos();
}

async function concUndoMatch(depositoId) {
    if (!confirm('Deshacer conciliacion?')) return;
    const dep = concData.depositosById[depositoId];
    if (!dep) return;
    const matches = concData.matches[depositoId] || [];
    // Concurrent restore of invoices
    await Promise.all(matches.map(m => {
        const f = concData.facturasById[m.factura_id];
        if (f) f.estado_pago = 'pendiente';
        return db.from('facturas').update({ estado_pago: 'pendiente', fecha_pago: null }).eq('id', m.factura_id);
    }));
    await Promise.all([
        db.from('conciliacion_matches').delete().eq('deposito_id', depositoId),
        db.from('depositos').update({ estado: 'sin_conciliar' }).eq('id', dep.id)
    ]);
    delete concData.matches[depositoId];
    dep.estado = 'sin_conciliar';
    concUpdateResumen(); concRenderDepositos();
}

// =====================================================
// EXPORT
// =====================================================
function concExportReport() {
    if (concData.depositos.length === 0) { alert('No hay datos'); return; }
    const wb = XLSX.utils.book_new();
    const conciliados = concData.depositos.filter(d => d.estado === 'conciliado').map(d => {
        const ms = concData.matches[d.id] || [];
        return { 'Fecha': d.fecha, 'Depositante': d.nombre_depositante, 'Monto': +d.monto, 'Doc Banco': d.doc_numero,
            'Facturas': ms.map(m => { const f = concData.facturasById[m.factura_id]; return f ? f.numero_factura : ''; }).join(', '),
            'Cliente': ms.map(m => { const f = concData.facturasById[m.factura_id]; return f ? f.cliente : ''; }).filter((v, i, a) => a.indexOf(v) === i).join(', ')
        };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conciliados), 'Conciliados');
    const sinConc = concData.depositos.filter(d => d.estado === 'sin_conciliar').map(d => ({ 'Fecha': d.fecha, 'Depositante': d.nombre_depositante, 'Monto': +d.monto, 'Doc Banco': d.doc_numero, 'Descripcion': d.descripcion_web || d.concepto_celular }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sinConc), 'Sin conciliar');
    const pend = concData.facturas.filter(f => f.estado_pago === 'pendiente').map(f => ({ 'Fecha': f.fecha, 'Factura': f.numero_factura, 'Cliente': f.cliente, 'Total': f.total, 'Saldo': f.saldo }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pend), 'Facturas pendientes');
    XLSX.writeFile(wb, 'Conciliacion_' + new Date().toISOString().slice(0, 10) + '.xlsx');
}

// =====================================================
// HELPERS (removed redundant wrappers)
// =====================================================
function concParseDate(val) { if (!val) return null; const m = String(val).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { let y = parseInt(m[3]); if (y < 100) y += 2000; return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); } return String(val); }
function concParseDateCelular(val) { if (!val) return null; const m = String(val).match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'); return concParseDate(val); }
function concFormatDateContifico(isoDate) { if (!isoDate) return ''; const m = String(isoDate).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : isoDate; }
function concParseMontoEC(raw) { let s = String(raw).replace('$', '').trim(); if (s.startsWith('-')) return 0; s = s.replace(/\./g, '').replace(',', '.'); return parseFloat(s) || 0; }
function concDetectTipoTx(desc) { if (!desc) return 'otro'; const d = desc.toUpperCase(); if (d.includes('INTERBANCARIA')) return 'interbancaria'; if (d.includes('TRANSFERENCIA') || d.includes('TRANSF.')) return 'transferencia'; if (d.includes('DEPOSITO') || d.includes('DEPÓSITO')) return 'deposito'; if (d.includes('CHEQUE')) return 'cheque'; return 'otro'; }
function concExtractNombreWeb(desc) { if (!desc) return ''; const m = desc.match(/^\d+[A-Z]+-(.+?)-(PAG|COM|TRN)/i); if (m) return m[1].replace(/-/g, ' ').trim(); if (desc.includes('INTERBANCARIO')) return '(Interbancaria)'; if (desc.includes('TRANSFERENCIA INTERNET')) return '(Transferencia)'; return desc.substring(0, 40); }

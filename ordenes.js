// =====================================================
// MODULO ORDENES DE PRODUCCION
// Extraido de index.html — usa globales: db, proformaActiva,
// guardarProforma, linkOrdenATrabajo, gigaDescontarInventario,
// escapeHtml, staffCache, loadStaff, currentUser, appData,
// cotDrawPreview, switchTab, cerrarEditor.
// =====================================================

// Workflows por metodo de impresion
const WORKFLOW_OFFSET = [
    'Diseno', 'Envio al cliente', 'Aprobacion', 'Prueba de color',
    'Preprensa (placas)', 'Impresion', 'Terminados', 'Empaquetado',
    'Facturacion', 'Entrega', 'Pago', 'Postventa'
];
const WORKFLOW_DIGITAL = [
    'Diseno', 'Envio al cliente', 'Aprobacion', 'Prueba de color',
    'Impresion', 'Terminados', 'Empaquetado',
    'Facturacion', 'Entrega', 'Pago', 'Postventa'
];

async function crearOrdenProduccion(silent) {
    if (!proformaActiva) return;
    if (proformaActiva.estado !== 'aprobada') {
        if (!silent) alert('La proforma debe estar aprobada para crear una orden.');
        return;
    }
    if (proformaActiva.items.length === 0) {
        if (!silent) alert('La proforma no tiene items.');
        return;
    }
    await guardarProforma();

    const { data: existente } = await db.from('ordenes_produccion')
        .select('id, numero').eq('proforma_id', proformaActiva.id).maybeSingle();
    if (existente) {
        if (silent) {
            await linkOrdenATrabajo(existente.id, proformaActiva.id);
            return;
        }
        if (!confirm('Ya existe la orden #' + existente.numero + ' para esta proforma. Crear otra de todas formas?')) return;
    }

    const { data: maxRow } = await db.from('ordenes_produccion')
        .select('numero').order('numero', { ascending: false }).limit(1).maybeSingle();
    const nextNum = (maxRow?.numero || 0) + 1;

    const { data: orden, error: ordenErr } = await db.from('ordenes_produccion').insert({
        numero: nextNum,
        proforma_id: proformaActiva.id,
        cliente_id: proformaActiva.cliente_id || null,
        estado: 'nueva',
        notas: null
    }).select().single();

    if (ordenErr) {
        alert('Error creando la orden: ' + ordenErr.message);
        return;
    }

    const tareasToInsert = [];
    const { data: itemsFrescos } = await db.from('proforma_items')
        .select('id, orden, descripcion, metodo_impresion')
        .eq('proforma_id', proformaActiva.id)
        .order('orden');

    (itemsFrescos || []).forEach(item => {
        const workflow = item.metodo_impresion === 'offset' ? WORKFLOW_OFFSET : WORKFLOW_DIGITAL;
        workflow.forEach((paso, idx) => {
            tareasToInsert.push({
                orden_id: orden.id,
                proforma_item_id: item.id,
                paso: paso,
                orden_seq: idx,
                estado: 'pendiente'
            });
        });
    });

    if (tareasToInsert.length > 0) {
        const { error: tareasErr } = await db.from('orden_tareas').insert(tareasToInsert);
        if (tareasErr) {
            alert('Orden creada pero fallo al crear tareas: ' + tareasErr.message);
            return;
        }
    }

    const freshByOrden = {};
    (itemsFrescos || []).forEach(it => { freshByOrden[it.orden] = it; });

    try {
        const itemsGiga = (proformaActiva.items || []).filter(it => it.metodo_impresion === 'gigantografia' && it.datos_cotizacion);
        for (const it of itemsGiga) {
            const fresh = freshByOrden[it.orden];
            await gigaDescontarInventario(it.datos_cotizacion, null, orden.id, fresh ? fresh.id : null);
        }
    } catch (e) { console.error('Error descontando inventario giga:', e); }

    try {
        const itemsPromo = (proformaActiva.items || []).filter(it => it.metodo_impresion === 'promocional' && it.datos_cotizacion);
        for (const it of itemsPromo) {
            const fresh = freshByOrden[it.orden];
            const snap = it.datos_cotizacion;
            const prodId = snap?.producto?.id;
            const cantidad = +it.cantidad || 0;
            if (prodId && cantidad > 0) {
                await db.rpc('promocionales_descontar_stock', {
                    p_producto_id: prodId, p_cantidad: cantidad,
                    p_orden_id: orden.id, p_trabajo_id: null,
                    p_proforma_item_id: fresh ? fresh.id : null
                });
            }
        }
    } catch (e) { console.error('Error descontando stock promocionales:', e); }

    try { await linkOrdenATrabajo(orden.id, proformaActiva.id); } catch (e) { console.error(e); }

    if (silent) return;
    alert('Orden de Produccion #' + nextNum + ' creada con ' + tareasToInsert.length + ' tareas. Abriendo tab Ordenes de Produccion...');
    cerrarEditor();
    switchTab('ordenes');
    setTimeout(() => abrirOrden(orden.id), 500);
}

// =====================================================
// TAB: ORDENES DE PRODUCCION
// =====================================================
let ordenActiva = null;
let ordenesCache = [];

const PASO_ESTADO_COLORS = {
    pendiente:  { bg: '#f3f4f6', color: '#4b5563', border: '#d1d5db' },
    en_proceso: { bg: '#fef3c7', color: '#92400e', border: '#fbbf24' },
    bloqueado:  { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' },
    completado: { bg: '#d1fae5', color: '#065f46', border: '#6ee7b7' },
    saltado:    { bg: '#e5e7eb', color: '#6b7280', border: '#9ca3af' }
};
const ORDEN_ESTADO_COLORS = {
    nueva:       { bg: '#dbeafe', color: '#1e40af' },
    en_proceso:  { bg: '#fef3c7', color: '#92400e' },
    finalizada:  { bg: '#d1fae5', color: '#065f46' },
    entregada:   { bg: '#ccfbf1', color: '#115e59' },
    cancelada:   { bg: '#fee2e2', color: '#991b1b' }
};

const PASO_ESTADO_ICON = {
    pendiente: '⚪', en_proceso: '🟡', bloqueado: '🔴', completado: '✅', saltado: '⏭️'
};

let ordenesProgresoCache = {};
let ordenesAsignadosCache = {};
let ordenesMiStaffId = null;
let ordenesVistaActual = 'lista';

function ordenesVista(v) {
    ordenesVistaActual = v;
    document.getElementById('ordenesBtnLista').classList.toggle('active', v === 'lista');
    document.getElementById('ordenesBtnReportes').classList.toggle('active', v === 'reportes');
    document.getElementById('ordenesLista').style.display = v === 'lista' ? 'block' : 'none';
    document.getElementById('ordenEditor').style.display = 'none';
    document.getElementById('ordenesReportes').style.display = v === 'reportes' ? 'block' : 'none';
    if (v === 'reportes') {
        const desde = document.getElementById('ordRepDesde');
        const hasta = document.getElementById('ordRepHasta');
        if (!desde.value || !hasta.value) ordRepRango('mes');
        else cargarReportesTiempo();
    }
}

function ordRepRango(tipo) {
    const hoy = new Date();
    let d, h;
    if (tipo === 'semana') {
        d = new Date(hoy); d.setDate(hoy.getDate() - hoy.getDay());
        h = new Date(d); h.setDate(d.getDate() + 6);
    } else if (tipo === 'mes') {
        d = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
        h = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    } else if (tipo === 'mesPasado') {
        d = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
        h = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
    } else if (tipo === '90d') {
        h = new Date(hoy);
        d = new Date(hoy); d.setDate(hoy.getDate() - 90);
    }
    const fmt = dt => dt.toISOString().slice(0,10);
    document.getElementById('ordRepDesde').value = fmt(d);
    document.getElementById('ordRepHasta').value = fmt(h);
    cargarReportesTiempo();
}

function _ordRepFmtDur(horas) {
    if (!horas || isNaN(horas) || horas < 0) return '—';
    if (horas < 1) return Math.round(horas * 60) + ' min';
    if (horas < 24) return horas.toFixed(1) + ' h';
    const dias = Math.floor(horas / 24);
    const restoH = Math.round(horas - dias * 24);
    return dias + 'd' + (restoH > 0 ? ' ' + restoH + 'h' : '');
}

function _ordRepStats(durs) {
    if (!durs.length) return null;
    const sorted = [...durs].sort((a, b) => a - b);
    const sum = durs.reduce((a, b) => a + b, 0);
    const avg = sum / durs.length;
    const median = sorted.length % 2
        ? sorted[(sorted.length - 1) >> 1]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const max = sorted[sorted.length - 1];
    return { count: durs.length, sum, avg, median, max };
}

async function cargarReportesTiempo() {
    const desdeStr = document.getElementById('ordRepDesde').value;
    const hastaStr = document.getElementById('ordRepHasta').value;
    if (!desdeStr || !hastaStr) return;
    const desde = new Date(desdeStr); desde.setHours(0,0,0,0);
    const hasta = new Date(hastaStr); hasta.setHours(23,59,59,999);

    if (staffCache.length === 0) await loadStaff();
    const staffById = {}; staffCache.forEach(s => { staffById[s.id] = s.nombre; });

    const { data: completadas } = await db.from('orden_tareas')
        .select('paso, asignado_a, fecha_inicio, fecha_fin, estado')
        .eq('estado', 'completado')
        .gte('fecha_fin', desde.toISOString())
        .lte('fecha_fin', hasta.toISOString());

    const tareasValidas = (completadas || []).filter(t => t.fecha_inicio && t.fecha_fin);

    // Stats por etapa
    const porEtapa = {};
    tareasValidas.forEach(t => {
        const horas = (new Date(t.fecha_fin) - new Date(t.fecha_inicio)) / 3600000;
        if (horas < 0) return;
        if (!porEtapa[t.paso]) porEtapa[t.paso] = [];
        porEtapa[t.paso].push(horas);
    });
    const ordenWorkflow = [...new Set([...WORKFLOW_OFFSET, ...WORKFLOW_DIGITAL])];
    const filasEtapas = ordenWorkflow.filter(p => porEtapa[p]).map(p => {
        const s = _ordRepStats(porEtapa[p]);
        return { paso: p, ...s };
    }).concat(
        Object.keys(porEtapa).filter(p => !ordenWorkflow.includes(p)).map(p => ({ paso: p, ..._ordRepStats(porEtapa[p]) }))
    );
    const tbE = document.getElementById('ordRepEtapasBody');
    const emE = document.getElementById('ordRepEtapasEmpty');
    if (!filasEtapas.length) {
        tbE.innerHTML = ''; emE.style.display = 'block';
    } else {
        emE.style.display = 'none';
        tbE.innerHTML = filasEtapas.map(f => `<tr>
            <td><strong>${escapeHtml(f.paso)}</strong></td>
            <td style="text-align:right;">${f.count}</td>
            <td style="text-align:right;font-weight:600;">${_ordRepFmtDur(f.avg)}</td>
            <td style="text-align:right;">${_ordRepFmtDur(f.median)}</td>
            <td style="text-align:right;color:var(--gray-500);">${_ordRepFmtDur(f.max)}</td>
        </tr>`).join('');
    }

    // Stats por persona
    const porStaff = {};
    tareasValidas.filter(t => t.asignado_a).forEach(t => {
        const horas = (new Date(t.fecha_fin) - new Date(t.fecha_inicio)) / 3600000;
        if (horas < 0) return;
        if (!porStaff[t.asignado_a]) porStaff[t.asignado_a] = { durs: [], pasos: {} };
        porStaff[t.asignado_a].durs.push(horas);
        porStaff[t.asignado_a].pasos[t.paso] = (porStaff[t.asignado_a].pasos[t.paso] || 0) + 1;
    });
    const filasPersonas = Object.entries(porStaff).map(([id, d]) => {
        const s = _ordRepStats(d.durs);
        const topPasos = Object.entries(d.pasos).sort((a,b) => b[1] - a[1]).slice(0, 3)
            .map(([p, c]) => `${p} (${c})`).join(', ');
        return { id, nombre: staffById[id] || ('Staff #' + id), ...s, topPasos };
    }).sort((a, b) => b.count - a.count);
    const tbP = document.getElementById('ordRepPersonasBody');
    const emP = document.getElementById('ordRepPersonasEmpty');
    if (!filasPersonas.length) {
        tbP.innerHTML = ''; emP.style.display = 'block';
    } else {
        emP.style.display = 'none';
        tbP.innerHTML = filasPersonas.map(f => `<tr>
            <td><strong>${escapeHtml(f.nombre)}</strong></td>
            <td style="text-align:right;font-weight:600;">${f.count}</td>
            <td style="text-align:right;">${_ordRepFmtDur(f.avg)}</td>
            <td style="text-align:right;color:var(--gray-500);">${_ordRepFmtDur(f.sum)}</td>
            <td style="font-size:0.8rem;color:var(--gray-600);">${escapeHtml(f.topPasos)}</td>
        </tr>`).join('');
    }

    // Cuellos de botella (snapshot, no usa rango)
    const { data: cuellos } = await db.from('orden_tareas')
        .select('paso, estado, fecha_inicio, ordenes_produccion!inner(estado)')
        .in('estado', ['pendiente','en_proceso','bloqueado'])
        .not('ordenes_produccion.estado', 'in', '(finalizada,entregada,cancelada)');

    const porEtapaCuello = {};
    (cuellos || []).forEach(t => {
        if (!porEtapaCuello[t.paso]) porEtapaCuello[t.paso] = { pendiente: 0, en_proceso: 0, bloqueado: 0, masVieja: null };
        porEtapaCuello[t.paso][t.estado] = (porEtapaCuello[t.paso][t.estado] || 0) + 1;
        if (t.fecha_inicio) {
            const f = new Date(t.fecha_inicio);
            if (!porEtapaCuello[t.paso].masVieja || f < porEtapaCuello[t.paso].masVieja) {
                porEtapaCuello[t.paso].masVieja = f;
            }
        }
    });
    const filasCuellos = ordenWorkflow.filter(p => porEtapaCuello[p]).map(p => ({ paso: p, ...porEtapaCuello[p] }))
        .concat(Object.keys(porEtapaCuello).filter(p => !ordenWorkflow.includes(p)).map(p => ({ paso: p, ...porEtapaCuello[p] })));
    const tbC = document.getElementById('ordRepCuellosBody');
    const emC = document.getElementById('ordRepCuellosEmpty');
    if (!filasCuellos.length) {
        tbC.innerHTML = ''; emC.style.display = 'block';
    } else {
        emC.style.display = 'none';
        const ahora = new Date();
        tbC.innerHTML = filasCuellos.map(f => {
            const total = f.pendiente + f.en_proceso + f.bloqueado;
            let viejaTxt = '—';
            if (f.masVieja) {
                const dias = Math.round((ahora - f.masVieja) / (1000*60*60*24));
                viejaTxt = dias === 0 ? 'hoy' : dias === 1 ? 'ayer' : 'hace ' + dias + ' dias';
            }
            return `<tr>
                <td><strong>${escapeHtml(f.paso)}</strong></td>
                <td style="text-align:right;color:var(--gray-500);">${f.pendiente}</td>
                <td style="text-align:right;color:#92400e;font-weight:600;">${f.en_proceso}</td>
                <td style="text-align:right;color:#991b1b;font-weight:600;">${f.bloqueado}</td>
                <td style="text-align:right;font-weight:700;">${total}</td>
                <td style="font-size:0.82rem;color:var(--gray-500);">${viejaTxt}</td>
            </tr>`;
        }).join('');
    }

    document.getElementById('ordRepMeta').textContent = `${tareasValidas.length} tareas completadas analizadas`;
}

async function cargarOrdenes() {
    document.getElementById('ordenEditor').style.display = 'none';
    document.getElementById('ordenesReportes').style.display = 'none';
    document.getElementById('ordenesLista').style.display = 'block';
    ordenesVistaActual = 'lista';
    document.getElementById('ordenesBtnLista')?.classList.add('active');
    document.getElementById('ordenesBtnReportes')?.classList.remove('active');

    const filtroEstado = document.getElementById('ordenesFiltroEstado')?.value || '';
    let q = db.from('ordenes_produccion').select('*, clientes(nombre, empresa), proformas(numero)');
    if (filtroEstado === 'activas') {
        q = q.not('estado', 'in', '(finalizada,entregada,cancelada)');
    } else if (filtroEstado) {
        q = q.eq('estado', filtroEstado);
    }
    const { data } = await q.order('id', { ascending: false });
    ordenesCache = data || [];

    if (staffCache.length === 0) await loadStaff();
    const selAsign = document.getElementById('ordenesFiltroAsignado');
    if (selAsign && selAsign.options.length <= 2) {
        staffCache.filter(s => s.activo).forEach(s => {
            const o = document.createElement('option');
            o.value = s.id; o.textContent = s.nombre;
            selAsign.appendChild(o);
        });
    }

    if (!ordenesMiStaffId && currentUser?.email) {
        const m = staffCache.find(s => s.email === currentUser.email);
        ordenesMiStaffId = m?.id || null;
    }

    ordenesProgresoCache = {};
    ordenesAsignadosCache = {};
    if (ordenesCache.length > 0) {
        const ordenIds = ordenesCache.map(o => o.id);
        const { data: tareas } = await db.from('orden_tareas')
            .select('orden_id, estado, asignado_a')
            .in('orden_id', ordenIds);
        (tareas || []).forEach(t => {
            if (!ordenesProgresoCache[t.orden_id]) ordenesProgresoCache[t.orden_id] = { total: 0, done: 0 };
            ordenesProgresoCache[t.orden_id].total++;
            if (t.estado === 'completado' || t.estado === 'saltado') ordenesProgresoCache[t.orden_id].done++;
            if (t.asignado_a) {
                if (!ordenesAsignadosCache[t.orden_id]) ordenesAsignadosCache[t.orden_id] = new Set();
                ordenesAsignadosCache[t.orden_id].add(t.asignado_a);
            }
        });
    }

    renderOrdenesFiltradas();
}

function renderOrdenesFiltradas() {
    const body = document.getElementById('ordenesBody');
    const empty = document.getElementById('ordenesEmpty');
    if (!body) return;

    const qTexto = (document.getElementById('ordenesFiltroCliente')?.value || '').trim().toLowerCase();
    const filtroEntrega = document.getElementById('ordenesFiltroEntrega')?.value || '';
    const filtroAsign = document.getElementById('ordenesFiltroAsignado')?.value || '';
    const orden = document.getElementById('ordenesOrden')?.value || 'recientes';

    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const inicioSemana = new Date(hoy); inicioSemana.setDate(hoy.getDate() - hoy.getDay());
    const finSemana = new Date(inicioSemana); finSemana.setDate(inicioSemana.getDate() + 6); finSemana.setHours(23,59,59,999);
    const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);

    let lista = ordenesCache.filter(o => {
        if (qTexto) {
            const cli = ((o.clientes?.nombre || '') + ' ' + (o.clientes?.empresa || '')).toLowerCase();
            const num = String(o.numero || '');
            const profNum = String(o.proformas?.numero || '');
            if (!cli.includes(qTexto) && !num.includes(qTexto) && !profNum.includes(qTexto)) return false;
        }
        if (filtroEntrega) {
            const fe = o.fecha_entrega ? new Date(o.fecha_entrega) : null;
            if (filtroEntrega === 'sin_fecha' && fe) return false;
            if (filtroEntrega !== 'sin_fecha' && !fe) return false;
            if (fe) {
                fe.setHours(0,0,0,0);
                const finalizada = ['entregada','cancelada','finalizada'].includes(o.estado);
                if (filtroEntrega === 'atrasadas' && (fe >= hoy || finalizada)) return false;
                if (filtroEntrega === 'hoy' && fe.getTime() !== hoy.getTime()) return false;
                if (filtroEntrega === 'semana' && (fe < inicioSemana || fe > finSemana)) return false;
                if (filtroEntrega === 'mes' && (fe < hoy || fe > finMes)) return false;
            }
        }
        if (filtroAsign) {
            const asignados = ordenesAsignadosCache[o.id];
            if (filtroAsign === 'mis') {
                if (!ordenesMiStaffId || !asignados || !asignados.has(ordenesMiStaffId)) return false;
            } else {
                const id = +filtroAsign;
                if (!asignados || !asignados.has(id)) return false;
            }
        }
        return true;
    });

    if (orden === 'entrega') {
        lista.sort((a, b) => {
            const fa = a.fecha_entrega ? new Date(a.fecha_entrega).getTime() : Infinity;
            const fb = b.fecha_entrega ? new Date(b.fecha_entrega).getTime() : Infinity;
            return fa - fb;
        });
    } else if (orden === 'num') {
        lista.sort((a, b) => (a.numero || 0) - (b.numero || 0));
    }

    if (!lista.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        empty.textContent = ordenesCache.length ? 'No hay ordenes que coincidan con los filtros.' : 'No hay ordenes. Aprueba una proforma y crea la orden desde ahi.';
        return;
    }
    empty.style.display = 'none';

    const staffById = {};
    staffCache.forEach(s => { staffById[s.id] = s.nombre; });

    body.innerHTML = lista.map(o => {
        const p = ordenesProgresoCache[o.id] || { total: 0, done: 0 };
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        const estCol = ORDEN_ESTADO_COLORS[o.estado] || ORDEN_ESTADO_COLORS.nueva;
        const cliente = o.clientes ? (escapeHtml(o.clientes.nombre || '') + (o.clientes.empresa ? ' <span style="color:var(--gray-400);font-size:0.8rem;">(' + escapeHtml(o.clientes.empresa) + ')</span>' : '')) : '-';

        let entregaCell = '-';
        if (o.fecha_entrega) {
            const fe = new Date(o.fecha_entrega); fe.setHours(0,0,0,0);
            const diff = Math.round((fe - hoy) / (1000*60*60*24));
            const finalizada = ['entregada','cancelada','finalizada'].includes(o.estado);
            let tag = '', color = 'var(--gray-600)';
            if (!finalizada) {
                if (diff < 0) { tag = '🚨 atrasada ' + Math.abs(diff) + 'd'; color = '#991b1b'; }
                else if (diff === 0) { tag = '⏰ hoy'; color = '#92400e'; }
                else if (diff <= 3) { tag = '⚠️ ' + diff + 'd'; color = '#92400e'; }
            }
            entregaCell = fe.toLocaleDateString('es-EC') + (tag ? '<div style="font-size:0.7rem;font-weight:600;color:' + color + ';margin-top:0.1rem;">' + tag + '</div>' : '');
        }

        const asignSet = ordenesAsignadosCache[o.id];
        let asignCell = '<span style="color:var(--gray-400);">—</span>';
        if (asignSet && asignSet.size > 0) {
            const nombres = [...asignSet].map(id => staffById[id]).filter(Boolean);
            if (nombres.length > 0) {
                const visibles = nombres.slice(0, 2).map(n => n.split(' ')[0]).join(', ');
                asignCell = escapeHtml(visibles) + (nombres.length > 2 ? ' <span style="color:var(--gray-400);">+' + (nombres.length - 2) + '</span>' : '');
            }
        }

        return `<tr onclick="abrirOrden(${o.id})" style="cursor:pointer;">
            <td><strong>${o.numero || '-'}</strong></td>
            <td>${cliente}</td>
            <td>${o.proformas?.numero ? '#' + o.proformas.numero : '-'}</td>
            <td>${o.created_at ? new Date(o.created_at).toLocaleDateString('es-EC') : '-'}</td>
            <td>${entregaCell}</td>
            <td><span style="background:${estCol.bg};color:${estCol.color};padding:0.2rem 0.5rem;border-radius:10px;font-size:0.78rem;font-weight:600;">${(o.estado || '').replace('_', ' ')}</span></td>
            <td style="font-size:0.82rem;">${asignCell}</td>
            <td>
                <div style="background:#e5e7eb;border-radius:10px;height:8px;overflow:hidden;">
                    <div style="background:${pct === 100 ? '#059669' : '#2563eb'};height:100%;width:${pct}%;"></div>
                </div>
                <div style="font-size:0.72rem;color:var(--gray-500);margin-top:0.15rem;">${p.done}/${p.total}</div>
            </td>
        </tr>`;
    }).join('');
}

async function abrirOrden(id) {
    const { data: orden } = await db.from('ordenes_produccion')
        .select('*, clientes(nombre, empresa, telefono), proformas(numero, created_by_name)')
        .eq('id', id).single();
    if (!orden) { alert('Orden no encontrada'); return; }

    const { data: tareas } = await db.from('orden_tareas')
        .select('*, staff(nombre)')
        .eq('orden_id', id)
        .order('proforma_item_id')
        .order('orden_seq');

    const itemIds = [...new Set((tareas || []).map(t => t.proforma_item_id).filter(Boolean))];
    const { data: items } = itemIds.length > 0
        ? await db.from('proforma_items').select('*').in('id', itemIds)
        : { data: [] };

    ordenActiva = { ...orden, tareas: tareas || [], items: items || [] };

    if (staffCache.length === 0) await loadStaff();

    document.getElementById('ordenesLista').style.display = 'none';
    document.getElementById('ordenEditor').style.display = 'block';

    document.getElementById('ordenEditorNum').textContent = orden.numero || orden.id;
    document.getElementById('ordenEditorEstado').value = orden.estado || 'nueva';
    document.getElementById('ordenEditorFechaEntrega').value = orden.fecha_entrega || '';

    const cli = orden.clientes;
    document.getElementById('ordenResumenCliente').innerHTML = cli
        ? '<strong>' + (cli.nombre || '') + '</strong>' + (cli.empresa ? ' — ' + cli.empresa : '') + (cli.telefono ? ' — ' + cli.telefono : '')
        : '<span style="color:var(--gray-400);">Sin cliente</span>';
    document.getElementById('ordenResumenProforma').textContent = orden.proformas?.numero
        ? 'Desde proforma #' + orden.proformas.numero + (orden.proformas.created_by_name ? ' — Creada por ' + orden.proformas.created_by_name : '')
        : '';

    renderOrdenMateriales();
    renderOrdenTareas();
}

function renderOrdenMateriales() {
    const cont = document.getElementById('ordenMateriales');
    if (!ordenActiva) { cont.innerHTML = ''; return; }
    const agregado = {};
    (ordenActiva.items || []).forEach(it => {
        const snap = it.datos_cotizacion || {};
        const matIdxRaw = snap.material ?? snap.materialSel;
        const matIdx = matIdxRaw != null && matIdxRaw !== '' ? +matIdxRaw : null;
        const mat = matIdx != null ? appData.materiales[matIdx] : null;
        const matLabel = mat ? (mat.nombre + ' ' + (mat.gramaje || 0) + ' g') : (snap.material_nombre || 'Material sin especificar');
        const pliegos = snap.pliegosNec || snap.pliegos || 0;
        const key = matLabel;
        if (!agregado[key]) agregado[key] = { cant: 0, metodo: new Set(), items: [] };
        agregado[key].cant += +pliegos || 0;
        agregado[key].metodo.add(it.metodo_impresion || '-');
        agregado[key].items.push((it.descripcion || '').split(' - ')[0]);
    });
    const filas = Object.entries(agregado);
    if (filas.length === 0) {
        cont.innerHTML = '<span style="color:var(--gray-400);">Sin datos de materiales en los items</span>';
        return;
    }
    cont.innerHTML = '<ul style="margin:0;padding-left:1.2rem;">' + filas.map(([mat, info]) =>
        '<li><strong>' + mat + '</strong>' + (info.cant > 0 ? ' — ' + info.cant + ' pliegos' : '') +
        ' <span style="color:var(--gray-400);">(' + [...info.metodo].join(', ') + ')</span></li>'
    ).join('') + '</ul>';
}

function _ordenFmtFecha(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderOrdenTareas() {
    const cont = document.getElementById('ordenTareas');
    if (!ordenActiva) { cont.innerHTML = ''; return; }

    const items = ordenActiva.items || [];
    if (!items.length) { cont.innerHTML = '<span style="color:var(--gray-400);">Sin items de produccion</span>'; return; }

    const tareas = ordenActiva.tareas || [];
    const tareasPorItem = {};
    tareas.forEach(t => {
        const k = t.proforma_item_id || 'sin_item';
        if (!tareasPorItem[k]) tareasPorItem[k] = [];
        tareasPorItem[k].push(t);
    });
    Object.values(tareasPorItem).forEach(arr => arr.sort((a, b) => (a.orden_seq || 0) - (b.orden_seq || 0)));

    const staffActivos = staffCache.filter(s => s.activo);
    const staffOpts = (sel) => '<option value="">— sin asignar —</option>' +
        staffActivos.map(s => `<option value="${s.id}"${+sel === +s.id ? ' selected' : ''}>${escapeHtml(s.nombre || '')}</option>`).join('');

    let html = '';
    items.forEach((item, idx) => {
        const s = item.datos_cotizacion || {};
        const itemTitulo = (item.descripcion || '').split(' - ')[0] || 'Item';
        const itemMetodo = (item.metodo_impresion || '').toUpperCase();
        const itemLabel = itemTitulo + ' — ' + (item.cantidad || 0) + ' uds — ' + itemMetodo;
        const itemTareas = tareasPorItem[item.id] || [];
        const totalT = itemTareas.length;
        const doneT = itemTareas.filter(t => t.estado === 'completado' || t.estado === 'saltado').length;
        const pctT = totalT > 0 ? Math.round((doneT / totalT) * 100) : 0;

        html += '<div style="margin-bottom:1.5rem;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">';
        html += '<div style="font-weight:700;color:#111827;padding:0.5rem 0.75rem;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-size:0.9rem;display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">';
        html += '<span>' + (idx + 1) + '. ' + escapeHtml(itemLabel) + '</span>';
        html += '<span style="margin-left:auto;font-size:0.75rem;color:var(--gray-500);font-weight:500;">' + doneT + '/' + totalT + ' pasos</span>';
        html += '<div style="width:90px;background:#e5e7eb;border-radius:8px;height:6px;overflow:hidden;"><div style="background:' + (pctT === 100 ? '#059669' : '#2563eb') + ';height:100%;width:' + pctT + '%;"></div></div>';
        html += '</div>';
        html += '<div style="padding:0.75rem;font-size:0.85rem;">';

        if (itemTareas.length > 0) {
            html += '<div style="font-weight:700;font-size:0.78rem;color:var(--gray-600);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:0.4rem;">Flujo de produccion</div>';
            html += '<div style="display:flex;flex-direction:column;gap:0.3rem;">';
            itemTareas.forEach(t => {
                const col = PASO_ESTADO_COLORS[t.estado] || PASO_ESTADO_COLORS.pendiente;
                const ico = PASO_ESTADO_ICON[t.estado] || '⚪';
                const isDone = t.estado === 'completado' || t.estado === 'saltado';
                html += '<div style="display:grid;grid-template-columns:24px minmax(120px,1.5fr) 1fr 130px 120px;gap:0.4rem;align-items:center;padding:0.35rem 0.5rem;background:' + col.bg + ';border-left:3px solid ' + col.border + ';border-radius:6px;font-size:0.83rem;' + (isDone ? 'opacity:0.75;' : '') + '">';
                html += '<span style="font-size:1rem;text-align:center;">' + ico + '</span>';
                html += '<span style="font-weight:600;color:' + col.color + ';' + (isDone ? 'text-decoration:line-through;' : '') + '">' + escapeHtml(t.paso || '') + '</span>';
                html += '<select onchange="updateOrdenTarea(' + t.id + ', \'asignado_a\', this.value ? +this.value : null)" style="padding:0.2rem 0.3rem;font-size:0.78rem;border:1px solid var(--gray-300);border-radius:4px;background:white;min-width:0;">' +
                    staffOpts(t.asignado_a) + '</select>';
                html += '<input type="date" value="' + (t.fecha_estimada || '') + '" onchange="updateOrdenTarea(' + t.id + ', \'fecha_estimada\', this.value || null)" style="padding:0.2rem 0.3rem;font-size:0.78rem;border:1px solid var(--gray-300);border-radius:4px;background:white;min-width:0;">';
                html += '<select onchange="updateOrdenTarea(' + t.id + ', \'estado\', this.value)" style="padding:0.2rem 0.3rem;font-size:0.78rem;font-weight:600;border:1px solid ' + col.border + ';border-radius:4px;background:white;color:' + col.color + ';">';
                ['pendiente','en_proceso','bloqueado','completado','saltado'].forEach(e => {
                    html += '<option value="' + e + '"' + (t.estado === e ? ' selected' : '') + '>' + e.replace('_',' ') + '</option>';
                });
                html += '</select>';
                html += '</div>';
                if (t.fecha_inicio || t.fecha_fin || t.notas) {
                    html += '<div style="padding:0.1rem 0.5rem 0.3rem 32px;font-size:0.72rem;color:var(--gray-500);display:flex;gap:0.8rem;flex-wrap:wrap;">';
                    if (t.fecha_inicio) html += '<span>▶ ' + _ordenFmtFecha(t.fecha_inicio) + '</span>';
                    if (t.fecha_fin) html += '<span>■ ' + _ordenFmtFecha(t.fecha_fin) + '</span>';
                    if (t.notas) html += '<span>📝 ' + escapeHtml(t.notas) + '</span>';
                    html += '</div>';
                }
            });
            html += '</div>';
        } else {
            html += '<div style="color:var(--gray-400);padding:0.5rem;">Sin tareas para este item</div>';
        }

        html += '<details style="margin-top:0.75rem;border-top:1px dashed var(--gray-200);padding-top:0.5rem;">';
        html += '<summary style="cursor:pointer;font-weight:700;font-size:0.78rem;color:var(--gray-600);text-transform:uppercase;letter-spacing:0.4px;padding:0.25rem 0;user-select:none;">Detalles tecnicos / imposicion</summary>';
        html += '<div style="margin-top:0.5rem;">';

        const pW = s.producto?.w || '-', pH = s.producto?.h || '-';
        const sangrado = s.sangrado || '0';
        const lados = s.lados || '1';
        const matNom = s.material_nombre || 'Sin material';
        const matGr = s.material_gramaje ? (' ' + s.material_gramaje + 'g') : '';
        const plW = s.pliego?.w || '-', plH = s.pliego?.h || '-';
        const hW = s.hoja?.w || '-', hH = s.hoja?.h || '-';

        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:0.5rem;font-size:0.83rem;">';
        html += '<tr style="background:#f9fafb;"><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;width:140px;">Pieza</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + pW + ' x ' + pH + ' cm (sangrado ' + sangrado + ')</td>';
        html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;width:140px;">Lados</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + lados + '</td></tr>';
        html += '<tr><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Material</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + matNom + matGr + '</td>';
        html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Pliego</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + plW + ' x ' + plH + ' cm</td></tr>';
        html += '<tr style="background:#f9fafb;"><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Hoja maquina</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + hW + ' x ' + hH + ' cm</td>';
        html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Piezas/hoja</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + (s.piezasPorHoja || '-') + '</td></tr>';
        html += '<tr><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Hojas netas</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + (s.hojasNetas || '-') + '</td>';
        html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Merma</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + (s.mermaTotal != null ? s.mermaTotal + ' hojas' : '-') + '</td></tr>';
        html += '<tr style="background:#f9fafb;"><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Total hojas</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:700;">' + (s.hojasTotales || '-') + '</td>';
        html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Pliegos</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:700;">' + (s.pliegosNec || '-') + '</td></tr>';
        if (s.tipo === 'offset' && s.colores) {
            html += '<tr><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Colores</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + s.colores + '</td>';
            html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Fmt/pliego</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + (s.fmtPorPliego || '-') + '</td></tr>';
        }
        if (s.tipo === 'digital' && s.maquina) {
            html += '<tr><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Maquina</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + s.maquina + '</td>';
            html += '<td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;font-weight:600;">Formato</td><td style="padding:0.3rem 0.5rem;border:1px solid #e5e7eb;">' + (s.formato || '-') + '</td></tr>';
        }
        html += '</table>';

        const td = s.terminadosDetalle || {};
        const tieneTerminados = td.plastificado || td.barnizUV || td.uvSelectivo || td.guillotina || td.ensanduchado || td.troquelado || td.troquelPlotter;
        if (tieneTerminados) {
            html += '<div style="margin-top:0.5rem;"><strong>TERMINADOS</strong></div>';
            html += '<div style="margin-top:0.3rem;font-size:0.82rem;">';
            if (td.plastificado) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>Plastificado</strong> — ' + td.plastificado + '</div>';
            if (td.barnizUV) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>Barniz UV</strong> — ' + td.barnizUV + '</div>';
            if (td.uvSelectivo) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>UV Selectivo</strong> — ' + td.uvSelectivo + '</div>';
            if (td.guillotina) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>Corte guillotina</strong> — ' + td.guillotina + '</div>';
            if (td.ensanduchado) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>Ensanduchado</strong> (doble cartulina)</div>';
            if (td.troquelado) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>Troquelado</strong> — ' + td.troquelado + '</div>';
            if (td.troquelPlotter) html += '<div style="padding:0.2rem 0;border-bottom:1px solid #f3f4f6;">✔ <strong>Troquel plotter</strong> — ' + td.troquelPlotter + '</div>';
            html += '</div>';
        } else {
            const termList = (s.terminados && s.terminados.length > 0) ? s.terminados.join(', ') : 'Ninguno';
            html += '<div style="margin-top:0.3rem;"><strong>Terminados:</strong> ' + termList + '</div>';
        }

        html += '<div style="margin-top:0.75rem;font-weight:600;font-size:0.82rem;color:var(--gray-500);text-transform:uppercase;">Vista Previa de Imposicion</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.35rem;">';
        html += '<div><div style="font-size:0.7rem;font-weight:600;color:var(--gray-500);text-transform:uppercase;margin-bottom:0.25rem;">Piezas en hoja maquina</div>';
        html += '<canvas id="opPreviewHoja_' + idx + '" style="width:100%;border:1px solid var(--gray-200);border-radius:6px;background:var(--gray-50);"></canvas></div>';
        html += '<div><div style="font-size:0.7rem;font-weight:600;color:var(--gray-500);text-transform:uppercase;margin-bottom:0.25rem;">Hojas en pliego de material</div>';
        html += '<canvas id="opPreviewPliego_' + idx + '" style="width:100%;border:1px solid var(--gray-200);border-radius:6px;background:var(--gray-50);"></canvas></div>';
        html += '</div>';

        html += '</div></details>';
        html += '</div></div>';
    });

    cont.innerHTML = html;

    items.forEach((item, idx) => {
        const det = cont.querySelectorAll('details')[idx];
        if (!det) return;
        const s = item.datos_cotizacion || {};
        const draw = () => {
            const hojaW = +(s.hoja?.w || 0), hojaH = +(s.hoja?.h || 0);
            const sangrado = +(s.sangrado || 0);
            const piezaW = +(s.producto?.w || 0) + sangrado * 2;
            const piezaH = +(s.producto?.h || 0) + sangrado * 2;
            const pliegoW = +(s.pliego?.w || 0), pliegoH = +(s.pliego?.h || 0);
            const margenMaq = +(s.margenMaq || 0.5);
            const lados = +(s.lados || 1);
            const esMismaPlaca = lados === 2 && s.placasTR === 'misma';
            if (hojaW > 0 && hojaH > 0 && piezaW > 0 && piezaH > 0) {
                cotDrawPreview('opPreviewHoja_' + idx, hojaW, hojaH, piezaW, piezaH, margenMaq, esMismaPlaca ? 'tiroretiro' : false, 1);
            }
            if (pliegoW > 0 && pliegoH > 0 && hojaW > 0 && hojaH > 0) {
                cotDrawPreview('opPreviewPliego_' + idx, pliegoW, pliegoH, hojaW, hojaH, 0, false);
            }
        };
        det.addEventListener('toggle', () => { if (det.open) draw(); }, { once: false });
    });
}

async function updateOrdenTarea(tareaId, field, value) {
    if (!ordenActiva) return;
    const tarea = ordenActiva.tareas.find(t => t.id === tareaId);
    if (!tarea) return;
    const updates = { [field]: value };
    if (field === 'estado') {
        if (value === 'en_proceso' && !tarea.fecha_inicio) updates.fecha_inicio = new Date().toISOString();
        if (value === 'completado' && !tarea.fecha_fin) updates.fecha_fin = new Date().toISOString();
    }
    await db.from('orden_tareas').update(updates).eq('id', tareaId);
    Object.assign(tarea, updates);
    renderOrdenTareas();
    if (field === 'estado' && ordenActiva) {
        const { data: ordenFresh } = await db.from('ordenes_produccion')
            .select('estado').eq('id', ordenActiva.id).maybeSingle();
        if (ordenFresh && ordenFresh.estado !== ordenActiva.estado) {
            ordenActiva.estado = ordenFresh.estado;
            const sel = document.getElementById('ordenEditorEstado');
            if (sel) sel.value = ordenFresh.estado;
        }
    }
}

async function cambiarEstadoOrden() {
    if (!ordenActiva) return;
    const estado = document.getElementById('ordenEditorEstado').value;
    ordenActiva.estado = estado;
    await db.from('ordenes_produccion').update({ estado }).eq('id', ordenActiva.id);
}

async function guardarOrdenCampo(field, value) {
    if (!ordenActiva) return;
    ordenActiva[field] = value;
    await db.from('ordenes_produccion').update({ [field]: value }).eq('id', ordenActiva.id);
}

function cerrarOrdenEditor() {
    ordenActiva = null;
    document.getElementById('ordenEditor').style.display = 'none';
    document.getElementById('ordenesLista').style.display = 'block';
    cargarOrdenes();
}

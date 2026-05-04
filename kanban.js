// =====================================================
// KANBAN DE TRABAJOS — modulo extraido de index.html el 2026-05-04
// Depende de globales del script principal: db, staffCache, currentUser,
// loadStaff, escapeHtml, kanbanEscape, switchTab, abrirProforma, abrirOrden.
// Se carga via <script src="kanban.js"> al final del body.
// =====================================================

// =====================================================
// KANBAN DE TRABAJOS
// =====================================================
const KANBAN_ESTADOS = [
    { id:'prospecto',              label:'PROSPECTOS DE VENTA',   color:'#64748b', bg:'#e2e8f0' },
    { id:'proforma_enviada',       label:'PROFORMA ENVIADA',      color:'#be185d', bg:'#fce7f3' },
    { id:'diseno',                 label:'DISENO',                color:'#ca8a04', bg:'#fef9c3' },
    { id:'prueba_color',           label:'PRUEBA DE COLOR',       color:'#0f766e', bg:'#ccfbf1' },
    { id:'produccion',             label:'PRODUCCION',            color:'#be123c', bg:'#ffe4e6' },
    { id:'pendiente_por_facturar', label:'PENDIENTE POR FACTURAR',color:'#7e22ce', bg:'#f3e8ff' },
    { id:'facturacion',            label:'FACTURACION',           color:'#991b1b', bg:'#fee2e2' },
    { id:'entrega',                label:'ENTREGA',               color:'#0369a1', bg:'#e0f2fe' },
    { id:'cobro',                  label:'COBRO',                 color:'#4d7c0f', bg:'#ecfccb' },
    { id:'postventa',              label:'POSTVENTA',             color:'#1d4ed8', bg:'#dbeafe' },
    { id:'completado',             label:'COMPLETADO',            color:'#15803d', bg:'#dcfce7' }
];
const KANBAN_PERDIDO = { id:'perdido', label:'PERDIDO', color:'#4b5563', bg:'#f3f4f6' };

let trabajosCache = [];
let trabajosCacheTs = 0;
const TRABAJOS_CACHE_MS = 30000;
let activeTrabajo = null;

function kanbanMyStaffId() {
    if (!currentUser) return null;
    const s = staffCache.find(x => (x.email||'').toLowerCase() === (currentUser.email||'').toLowerCase());
    return s ? s.id : null;
}

function renderKanbanSkeleton() {
    const board = document.getElementById('kanbanBoard');
    if (!board) return;
    board.innerHTML = KANBAN_ESTADOS.map(e =>
        `<div class="kanban-col" data-estado="${e.id}">
            <div class="kanban-col-header" style="background:${e.bg};color:${e.color};">
                <span class="kanban-col-dot" style="background:${e.color};"></span>
                <span class="kanban-col-title">${e.label}</span>
                <span class="kanban-col-count">…</span>
            </div>
            <div class="kanban-col-body" data-estado="${e.id}"></div>
        </div>`
    ).join('') +
    `<div class="kanban-col collapsed" data-estado="perdido">
        <div class="kanban-col-header" style="background:${KANBAN_PERDIDO.bg};color:${KANBAN_PERDIDO.color};cursor:pointer;">
            <span class="kanban-col-dot" style="background:${KANBAN_PERDIDO.color};"></span>
            <span class="kanban-col-title">${KANBAN_PERDIDO.label}</span>
            <span class="kanban-col-count">…</span>
        </div>
        <div class="kanban-col-body" data-estado="perdido" style="display:none;"></div>
    </div>`;
}

function invalidarCacheTrabajos() { trabajosCacheTs = 0; }

async function cargarTrabajos(opts) {
    opts = opts || {};
    const ahora = Date.now();
    const cacheFresco = trabajosCache.length && (ahora - trabajosCacheTs) < TRABAJOS_CACHE_MS;

    // Mostrar inmediatamente lo que tenemos (cache o skeleton)
    if (trabajosCache.length) {
        kanbanRenderFilterStaff();
        renderKanban();
    } else {
        renderKanbanSkeleton();
    }

    if (cacheFresco && !opts.force) return;

    // Cargar staff en paralelo
    const staffPromise = staffCache.length ? Promise.resolve() : loadStaff();
    const { data, error } = await db.from('trabajos')
        .select('*, clientes(id, nombre, empresa), proformas(id, numero, estado), ordenes_produccion(id, numero), trabajo_archivos(count)')
        .order('updated_at', { ascending: false })
        .limit(200);
    await staffPromise;

    if (error) { console.error(error); alert('Error cargando trabajos: ' + error.message); return; }
    trabajosCache = data || [];
    trabajosCacheTs = Date.now();
    kanbanRenderFilterStaff();
    renderKanban();

    // Pre-cargar clientes en background (para modal instantaneo)
    if (!kanbanClientesCache) { kanbanLoadClientes().catch(()=>{}); }
}

function kanbanRenderFilterStaff() {
    const sel = document.getElementById('kanbanFilterStaff');
    if (!sel) return;
    const curr = sel.value;
    sel.innerHTML = '<option value="">Todos los encargados</option>' +
        staffCache.filter(s => s.activo).map(s => `<option value="${s.id}">${kanbanEscape(s.nombre)}</option>`).join('');
    sel.value = curr;
}

function kanbanFiltrar() {
    const q = (document.getElementById('kanbanSearch')?.value || '').toLowerCase().trim();
    const enc = document.getElementById('kanbanFilterStaff')?.value || '';
    const mis = document.getElementById('kanbanFilterMis')?.checked || false;
    const myId = kanbanMyStaffId();

    return trabajosCache.filter(t => {
        if (q) {
            const hay = [
                String(t.numero||''),
                t.titulo||'',
                t.clientes?.nombre||'',
                t.clientes?.empresa||'',
                String(t.proformas?.numero||''),
                String(t.ordenes_produccion?.numero||'')
            ].join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
        }
        const encs = Array.isArray(t.encargados) ? t.encargados.map(String) : [];
        if (enc && !encs.includes(String(enc))) return false;
        if (mis) {
            if (!myId) return false;
            if (!encs.includes(String(myId))) return false;
        }
        return true;
    });
}

function renderKanban() {
    const board = document.getElementById('kanbanBoard');
    if (!board) return;
    const filtered = kanbanFiltrar();

    const byEstado = {};
    KANBAN_ESTADOS.forEach(e => byEstado[e.id] = []);
    byEstado[KANBAN_PERDIDO.id] = [];
    filtered.forEach(t => {
        if (byEstado[t.estado]) byEstado[t.estado].push(t);
        else byEstado['prospecto'].push(t);
    });

    board.innerHTML = KANBAN_ESTADOS.map(e => renderKanbanCol(e, byEstado[e.id], false)).join('') +
        renderKanbanCol(KANBAN_PERDIDO, byEstado[KANBAN_PERDIDO.id], true);

    attachKanbanDnD();
}

function renderKanbanCol(estado, trabajos, isPerdido) {
    const collapsed = isPerdido && (localStorage.getItem('kanbanPerdidoOpen') !== 'true');
    const addBtn = isPerdido ? '' : `<button class="kanban-col-add" type="button" onclick="event.stopPropagation();nuevoTrabajo('${estado.id}')" title="Nuevo">+</button>`;
    const headerClick = isPerdido ? 'onclick="togglePerdido()"' : '';
    const bodyStyle = collapsed ? 'display:none;' : '';
    return `<div class="kanban-col ${collapsed?'collapsed':''}" data-estado="${estado.id}">
        <div class="kanban-col-header" style="background:${estado.bg};color:${estado.color};${isPerdido?'cursor:pointer;':''}" ${headerClick}>
            <span class="kanban-col-dot" style="background:${estado.color};"></span>
            <span class="kanban-col-title">${estado.label}</span>
            <span class="kanban-col-count">${trabajos.length}</span>
            ${addBtn}
        </div>
        <div class="kanban-col-body" data-estado="${estado.id}" style="${bodyStyle}">
            ${trabajos.map(renderKanbanCard).join('')}
        </div>
    </div>`;
}

function togglePerdido() {
    const curr = localStorage.getItem('kanbanPerdidoOpen') === 'true';
    localStorage.setItem('kanbanPerdidoOpen', (!curr).toString());
    renderKanban();
}

function renderKanbanCard(t) {
    const encs = Array.isArray(t.encargados) ? t.encargados : [];
    const staffMap = {};
    staffCache.forEach(s => staffMap[String(s.id)] = s);
    const encsShown = encs.slice(0, 3).map(id => {
        const s = staffMap[String(id)];
        const nombre = s?.nombre || '?';
        const ini = nombre.split(' ').map(w => w[0]||'').join('').slice(0,2).toUpperCase();
        return `<span class="kanban-avatar" title="${kanbanEscape(nombre)}">${kanbanEscape(ini)}</span>`;
    }).join('');
    const more = encs.length > 3 ? `<span class="kanban-avatar" style="background:var(--gray-400);">+${encs.length-3}</span>` : '';
    const prio = t.prioridad || 'normal';
    const cliente = t.clientes?.empresa || t.clientes?.nombre || '(sin cliente)';
    const fecha = t.fecha_estimada ? new Date(t.fecha_estimada+'T00:00:00').toLocaleDateString('es-EC',{day:'numeric',month:'short'}) : '';
    const links = [];
    if (t.proforma_id) links.push(`<span class="kanban-link kanban-link-btn" onclick="event.stopPropagation();abrirProformaDesdeKanban(${t.proforma_id})" title="Abrir proforma">P#${t.proformas?.numero||t.proforma_id}</span>`);
    if (t.orden_id) links.push(`<span class="kanban-link kanban-link-btn" onclick="event.stopPropagation();abrirOrdenDesdeKanban(${t.orden_id})" title="Abrir orden">O#${t.ordenes_produccion?.numero||t.orden_id}</span>`);
    const nArchivos = t.trabajo_archivos?.[0]?.count || 0;
    if (nArchivos > 0) links.push(`<span class="kanban-card-files-badge" title="${nArchivos} archivo(s)">📎 ${nArchivos}</span>`);

    const btnProforma = (t.estado === 'prospecto' && !t.proforma_id)
        ? `<button class="kanban-card-btn" type="button" onclick="event.stopPropagation();crearProformaDesdeProspecto(${t.id})">+ Crear Proforma</button>`
        : '';

    return `<div class="kanban-card prio-${prio}" draggable="true" data-id="${t.id}" onclick="editarTrabajo(${t.id})">
        <div class="kanban-card-num">#${t.numero||t.id}</div>
        <div class="kanban-card-title">${kanbanEscape(t.titulo||'(sin titulo)')}</div>
        <div class="kanban-card-cliente">${kanbanEscape(cliente)}</div>
        <div class="kanban-card-footer">
            <div class="kanban-card-links">${links.join('')}</div>
            <div class="kanban-card-fecha">${fecha}</div>
        </div>
        ${encs.length ? `<div class="kanban-card-avatars">${encsShown}${more}</div>` : ''}
        ${btnProforma}
    </div>`;
}

function attachKanbanDnD() {
    document.querySelectorAll('.kanban-card').forEach(el => {
        el.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', el.dataset.id);
            e.dataTransfer.effectAllowed = 'move';
            el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });
    document.querySelectorAll('.kanban-col-body').forEach(el => {
        el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; el.classList.add('drop-hover'); });
        el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
        el.addEventListener('drop', async e => {
            e.preventDefault();
            el.classList.remove('drop-hover');
            const id = Number(e.dataTransfer.getData('text/plain'));
            const nuevoEstado = el.dataset.estado;
            if (!id || !nuevoEstado) return;
            await moverTrabajoEstado(id, nuevoEstado);
        });
    });
}

async function moverTrabajoEstado(id, nuevoEstado) {
    const t = trabajosCache.find(x => x.id === id);
    if (!t || t.estado === nuevoEstado) return;
    const hist = Array.isArray(t.historial) ? t.historial.slice() : [];
    hist.push({
        estado: nuevoEstado,
        from: t.estado,
        at: new Date().toISOString(),
        by: currentUser?.id || null,
        by_name: currentUser?.nombre || null
    });
    const { error } = await db.from('trabajos')
        .update({ estado: nuevoEstado, historial: hist })
        .eq('id', id);
    if (error) { alert('Error moviendo trabajo: ' + error.message); return; }
    t.estado = nuevoEstado;
    t.historial = hist;
    t.updated_at = new Date().toISOString();
    renderKanban();
}

let kanbanClientesCache = null;
async function kanbanLoadClientes() {
    if (kanbanClientesCache) return kanbanClientesCache;
    const { data } = await db.from('clientes').select('id, nombre, empresa').order('nombre').limit(2000);
    kanbanClientesCache = data || [];
    return kanbanClientesCache;
}

async function nuevoTrabajo(estadoInicial) {
    activeTrabajo = null;
    await abrirModalTrabajo({ estado: estadoInicial || 'prospecto', prioridad: 'normal', encargados: [] });
}

async function editarTrabajo(id) {
    const t = trabajosCache.find(x => x.id === id);
    if (!t) return;
    activeTrabajo = t;
    await abrirModalTrabajo(t);
}

async function abrirModalTrabajo(t) {
    if (!staffCache.length) await loadStaff();
    const clientes = await kanbanLoadClientes();

    document.getElementById('tmTitle').textContent = activeTrabajo ? `Trabajo #${activeTrabajo.numero||activeTrabajo.id}` : 'Nuevo Trabajo';
    document.getElementById('tmTitulo').value = t.titulo || '';
    document.getElementById('tmDescripcion').value = t.descripcion || '';
    document.getElementById('tmEstado').value = t.estado || 'prospecto';
    document.getElementById('tmPrioridad').value = t.prioridad || 'normal';
    document.getElementById('tmFechaEstimada').value = t.fecha_estimada || '';
    document.getElementById('tmNotas').value = t.notas || '';
    document.getElementById('tmMotivoPerdido').value = t.motivo_perdido || '';

    // Cliente select
    const selCli = document.getElementById('tmCliente');
    selCli.innerHTML = '<option value="">(sin cliente)</option>' +
        clientes.map(c => `<option value="${c.id}" ${String(c.id)===String(t.cliente_id)?'selected':''}>${kanbanEscape(c.nombre||'')}${c.empresa?' — '+kanbanEscape(c.empresa):''}</option>`).join('');

    // Encargados checkboxes
    const sel = (Array.isArray(t.encargados)?t.encargados:[]).map(String);
    const cont = document.getElementById('tmEncargados');
    const activos = staffCache.filter(s => s.activo);
    if (!activos.length) {
        cont.innerHTML = '<div style="color:var(--gray-400);font-size:0.8rem;padding:0.5rem;">No hay personal activo. Agregalo en Administracion → Equipo.</div>';
    } else {
        cont.innerHTML = activos.map(s => `
            <label class="kanban-enc-check">
                <input type="checkbox" value="${s.id}" ${sel.includes(String(s.id))?'checked':''}>
                <span>${kanbanEscape(s.nombre)}${s.rol?' · '+kanbanEscape(s.rol):''}</span>
            </label>
        `).join('');
    }

    // Motivo perdido: mostrar solo si estado = perdido
    const motivoGroup = document.getElementById('tmMotivoPerdidoGroup');
    motivoGroup.style.display = (t.estado === 'perdido') ? '' : 'none';
    document.getElementById('tmEstado').onchange = function() {
        motivoGroup.style.display = (this.value === 'perdido') ? '' : 'none';
    };

    // Links a proforma/orden
    const linksGroup = document.getElementById('tmLinksGroup');
    const linksDiv = document.getElementById('tmLinks');
    if (activeTrabajo && (activeTrabajo.proforma_id || activeTrabajo.orden_id)) {
        linksGroup.style.display = '';
        const parts = [];
        if (activeTrabajo.proforma_id) {
            parts.push(`<button type="button" class="btn" style="border:1px solid var(--gray-300);font-size:0.8rem;" onclick="abrirProformaDesdeKanban(${activeTrabajo.proforma_id})">Ver Proforma #${activeTrabajo.proformas?.numero||activeTrabajo.proforma_id}</button>`);
        }
        if (activeTrabajo.orden_id) {
            parts.push(`<button type="button" class="btn" style="border:1px solid var(--gray-300);font-size:0.8rem;" onclick="abrirOrdenDesdeKanban(${activeTrabajo.orden_id})">Ver Orden #${activeTrabajo.ordenes_produccion?.numero||activeTrabajo.orden_id}</button>`);
        }
        linksDiv.innerHTML = parts.join('');
    } else {
        linksGroup.style.display = 'none';
    }

    // Delete solo en edicion
    document.getElementById('tmDeleteBtn').style.display = activeTrabajo ? '' : 'none';

    // Archivos: solo disponibles en modo edicion (requiere trabajo.id)
    const archivosGroup = document.getElementById('tmArchivosGroup');
    if (activeTrabajo) {
        archivosGroup.style.display = '';
        document.getElementById('tmFilesList').innerHTML = '<div style="font-size:0.75rem;color:var(--gray-400);padding:0.5rem;">Cargando archivos...</div>';
        setupTrabajoFilesHandlers(activeTrabajo.id);
        cargarArchivosTrabajo(activeTrabajo.id);
    } else {
        archivosGroup.style.display = 'none';
    }

    document.getElementById('trabajoModal').classList.add('active');
    setTimeout(() => document.getElementById('tmTitulo').focus(), 50);
}

// --- Archivos del trabajo ---
function _formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return Math.round(n/1024) + ' KB';
    return (n/1024/1024).toFixed(1) + ' MB';
}

function _iconForMime(tipo, nombre) {
    const t = (tipo||'').toLowerCase();
    const ext = (nombre||'').split('.').pop().toLowerCase();
    if (t.startsWith('image/')) return null; // preview image
    if (t === 'application/pdf' || ext === 'pdf') return '📄';
    if (['ai','psd','eps','indd','cdr','svg'].includes(ext)) return '🎨';
    if (['doc','docx','txt','rtf','odt'].includes(ext)) return '📝';
    if (['xls','xlsx','csv','ods'].includes(ext)) return '📊';
    if (['zip','rar','7z'].includes(ext)) return '🗜️';
    return '📎';
}

async function cargarArchivosTrabajo(trabajoId) {
    const { data, error } = await db.from('trabajo_archivos')
        .select('*').eq('trabajo_id', trabajoId).order('created_at', { ascending: false });
    if (error) {
        document.getElementById('tmFilesList').innerHTML = '<div style="color:var(--danger);font-size:0.75rem;">Error: '+error.message+'</div>';
        return;
    }
    renderArchivosTrabajo(data || []);
}

let _tmArchivosById = {};
async function renderArchivosTrabajo(archivos) {
    const cont = document.getElementById('tmFilesList');
    _tmArchivosById = {};
    if (!archivos.length) {
        cont.innerHTML = '<div style="font-size:0.75rem;color:var(--gray-400);padding:0.25rem;grid-column:1/-1;">No hay archivos todavia.</div>';
        return;
    }
    archivos.forEach(a => _tmArchivosById[a.id] = a);

    // Bucket trabajo-archivos es privado: generar signed URLs (validez 1h) en batch
    let signedByPath = {};
    if (archivos.length) {
        const paths = archivos.map(a => a.path);
        const { data: signedList } = await db.storage.from('trabajo-archivos').createSignedUrls(paths, 3600);
        (signedList || []).forEach(s => { if (s.path) signedByPath[s.path] = s.signedUrl; });
    }

    cont.innerHTML = archivos.map(a => {
        const url = signedByPath[a.path] || '';
        const ico = _iconForMime(a.tipo, a.nombre);
        const preview = ico
            ? `<div class="tm-file-preview" data-action="view"><span class="ico">${ico}</span></div>`
            : `<div class="tm-file-preview" data-action="view"><img src="${kanbanEscape(url)}" loading="lazy" alt=""></div>`;
        return `<div class="tm-file" data-id="${a.id}">
            ${preview}
            <div class="tm-file-meta">
                <div class="tm-file-name" title="${kanbanEscape(a.nombre)}">${kanbanEscape(a.nombre)}</div>
                <div>${_formatBytes(a.tamano)}${a.created_by_name ? ' · '+kanbanEscape(a.created_by_name) : ''}</div>
            </div>
            <div class="tm-file-actions">
                <button type="button" class="tm-file-act" data-action="download" title="Descargar">↓</button>
                <button type="button" class="tm-file-act danger" data-action="delete" title="Eliminar">×</button>
            </div>
        </div>`;
    }).join('');

    // Un unico listener delegado
    cont.onclick = async (ev) => {
        const actEl = ev.target.closest('[data-action]');
        if (!actEl) return;
        const fileEl = actEl.closest('.tm-file');
        if (!fileEl) return;
        const id = Number(fileEl.dataset.id);
        const a = _tmArchivosById[id];
        if (!a) return;
        ev.stopPropagation();
        const action = actEl.dataset.action;
        if (action === 'download') {
            await descargarArchivoTrabajo(a.path, a.nombre);
        } else if (action === 'delete') {
            await eliminarArchivoTrabajo(a.id, a.path);
        } else if (action === 'view') {
            // Signed URL fresco (por si el listado original tiene >1h)
            const { data: u } = await db.storage.from('trabajo-archivos').createSignedUrl(a.path, 3600);
            if (u?.signedUrl) window.open(u.signedUrl, '_blank');
            else alert('No se pudo generar la URL del archivo');
        }
    };
}

let _tmFilesHandlersAttached = false;
function setupTrabajoFilesHandlers(trabajoId) {
    const drop = document.getElementById('tmFilesDrop');
    const input = document.getElementById('tmFilesInput');
    // Limpiar handlers previos clonando el nodo
    const newDrop = drop.cloneNode(true);
    drop.parentNode.replaceChild(newDrop, drop);
    const newInput = input.cloneNode(true);
    input.parentNode.replaceChild(newInput, input);
    // Reattach click en drop para abrir input
    newDrop.onclick = () => newInput.click();
    newInput.onchange = (e) => {
        const files = Array.from(e.target.files||[]);
        if (files.length) subirArchivosTrabajo(trabajoId, files);
        newInput.value = '';
    };
    newDrop.addEventListener('dragover', e => { e.preventDefault(); newDrop.classList.add('drag-over'); });
    newDrop.addEventListener('dragleave', () => newDrop.classList.remove('drag-over'));
    newDrop.addEventListener('drop', e => {
        e.preventDefault();
        newDrop.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files||[]);
        if (files.length) subirArchivosTrabajo(trabajoId, files);
    });
}

async function subirArchivosTrabajo(trabajoId, files) {
    const cont = document.getElementById('tmFilesList');
    // Agregar placeholders
    for (const f of files) {
        const ph = document.createElement('div');
        ph.className = 'tm-file tm-file-uploading';
        ph.innerHTML = `<div class="tm-file-preview"><span class="ico">⏳</span></div>
            <div class="tm-file-meta"><div class="tm-file-name">${kanbanEscape(f.name)}</div><div>${_formatBytes(f.size)} · subiendo...</div></div>`;
        cont.appendChild(ph);
    }
    let inserted = 0;
    for (const file of files) {
        try {
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const path = `trabajo-${trabajoId}/${Date.now()}-${Math.random().toString(36).slice(2,8)}-${safeName}`;
            const { error: upErr } = await db.storage.from('trabajo-archivos')
                .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
            if (upErr) { console.error(upErr); alert('Error subiendo '+file.name+': '+upErr.message); continue; }
            const { error: dbErr } = await db.from('trabajo_archivos').insert({
                trabajo_id: trabajoId, path, nombre: file.name, tipo: file.type || null, tamano: file.size,
                created_by: currentUser?.id || null, created_by_name: currentUser?.nombre || null
            });
            if (dbErr) { console.error(dbErr); alert('Error registrando '+file.name+': '+dbErr.message); continue; }
            inserted++;
        } catch (e) { console.error(e); alert('Error: '+e.message); }
    }
    await cargarArchivosTrabajo(trabajoId);
    if (inserted > 0) {
        // Actualizar count en cache sin recargar todo
        const t = trabajosCache.find(x => x.id === trabajoId);
        if (t) {
            if (!t.trabajo_archivos) t.trabajo_archivos = [{count: 0}];
            t.trabajo_archivos[0].count = (t.trabajo_archivos[0]?.count || 0) + inserted;
            renderKanban();
        }
    }
}

async function descargarArchivoTrabajo(path, nombre) {
    try {
        const { data, error } = await db.storage.from('trabajo-archivos').download(path);
        if (error) throw error;
        const url = URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre || 'archivo';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        alert('Error descargando: ' + (e.message || e));
    }
}

async function eliminarArchivoTrabajo(archivoId, path) {
    if (!confirm('Eliminar este archivo?')) return;
    await db.storage.from('trabajo-archivos').remove([path]);
    const { error } = await db.from('trabajo_archivos').delete().eq('id', archivoId);
    if (error) { alert('Error: '+error.message); return; }
    if (activeTrabajo) {
        await cargarArchivosTrabajo(activeTrabajo.id);
        const t = trabajosCache.find(x => x.id === activeTrabajo.id);
        if (t && t.trabajo_archivos?.[0]) {
            t.trabajo_archivos[0].count = Math.max(0, (t.trabajo_archivos[0].count || 1) - 1);
            renderKanban();
        }
    }
}

function cerrarModalTrabajo() {
    document.getElementById('trabajoModal').classList.remove('active');
    activeTrabajo = null;
}

async function guardarTrabajo() {
    const titulo = document.getElementById('tmTitulo').value.trim();
    if (!titulo) { alert('Ingresa un titulo'); return; }

    const encargados = Array.from(document.querySelectorAll('#tmEncargados input:checked')).map(x => Number(x.value));
    const cliente_id = document.getElementById('tmCliente').value || null;
    const descripcion = document.getElementById('tmDescripcion').value.trim() || null;
    const estado = document.getElementById('tmEstado').value;
    const prioridad = document.getElementById('tmPrioridad').value;
    const fecha_estimada = document.getElementById('tmFechaEstimada').value || null;
    const notas = document.getElementById('tmNotas').value.trim() || null;
    const motivo_perdido = estado === 'perdido' ? (document.getElementById('tmMotivoPerdido').value.trim() || null) : null;

    const payload = {
        titulo, descripcion,
        cliente_id: cliente_id ? Number(cliente_id) : null,
        estado, prioridad, fecha_estimada, notas, motivo_perdido,
        encargados
    };

    if (activeTrabajo) {
        if (estado !== activeTrabajo.estado) {
            const hist = Array.isArray(activeTrabajo.historial) ? activeTrabajo.historial.slice() : [];
            hist.push({ estado, from: activeTrabajo.estado, at: new Date().toISOString(), by: currentUser?.id||null, by_name: currentUser?.nombre||null });
            payload.historial = hist;
        }
        const { error } = await db.from('trabajos').update(payload).eq('id', activeTrabajo.id);
        if (error) { alert('Error: ' + error.message); return; }
    } else {
        payload.historial = [{ estado, from: null, at: new Date().toISOString(), by: currentUser?.id||null, by_name: currentUser?.nombre||null }];
        payload.created_by = currentUser?.id || null;
        payload.created_by_name = currentUser?.nombre || null;
        const { error } = await db.from('trabajos').insert(payload);
        if (error) { alert('Error: ' + error.message); return; }
    }

    cerrarModalTrabajo();
    invalidarCacheTrabajos();
    await cargarTrabajos({ force: true });
}

async function eliminarTrabajo() {
    if (!activeTrabajo) return;
    if (!confirm('Eliminar este trabajo? (no elimina la proforma ni la orden vinculada)')) return;
    const { error } = await db.from('trabajos').delete().eq('id', activeTrabajo.id);
    if (error) { alert('Error: ' + error.message); return; }
    cerrarModalTrabajo();
    invalidarCacheTrabajos();
    await cargarTrabajos({ force: true });
}

// ---- Helpers fase 2: hooks con proformas ----

// Agrega una entrada al historial del trabajo (en memoria, devuelve nuevo array)
function _pushHistorial(histPrev, from, to) {
    const hist = Array.isArray(histPrev) ? histPrev.slice() : [];
    hist.push({
        estado: to, from: from || null,
        at: new Date().toISOString(),
        by: currentUser?.id || null,
        by_name: currentUser?.nombre || null
    });
    return hist;
}

// Garantiza que exista un trabajo vinculado a la proforma, con el estado deseado.
// Crea uno nuevo si no existe, o actualiza el estado si ya existe.
async function asegurarTrabajoParaProforma(proformaId, estadoDeseado, opts) {
    opts = opts || {};
    // Buscar trabajo existente
    const { data: existente } = await db.from('trabajos')
        .select('id, estado, historial, titulo, cliente_id')
        .eq('proforma_id', proformaId)
        .maybeSingle();

    if (existente) {
        if (existente.estado !== estadoDeseado) {
            const hist = _pushHistorial(existente.historial, existente.estado, estadoDeseado);
            const upd = { estado: estadoDeseado, historial: hist };
            if (opts.motivo_perdido !== undefined) upd.motivo_perdido = opts.motivo_perdido;
            await db.from('trabajos').update(upd).eq('id', existente.id);
        }
        return existente.id;
    }

    // Crear trabajo nuevo
    const { data: prof } = await db.from('proformas')
        .select('numero, cliente_id, clientes(nombre, empresa)')
        .eq('id', proformaId)
        .maybeSingle();
    if (!prof) return null;

    const { count } = await db.from('proforma_items')
        .select('*', { count: 'exact', head: true })
        .eq('proforma_id', proformaId);

    const titulo = opts.titulo
        || `Proforma #${prof.numero}${prof.clientes?.empresa ? ' - '+prof.clientes.empresa : (prof.clientes?.nombre ? ' - '+prof.clientes.nombre : '')}`;

    const payload = {
        titulo,
        cliente_id: prof.cliente_id || null,
        proforma_id: proformaId,
        estado: estadoDeseado,
        prioridad: 'normal',
        encargados: [],
        historial: _pushHistorial([], null, estadoDeseado),
        created_by: currentUser?.id || null,
        created_by_name: currentUser?.nombre || null
    };
    if (opts.motivo_perdido) payload.motivo_perdido = opts.motivo_perdido;

    const { data: nuevo } = await db.from('trabajos').insert(payload).select().single();
    return nuevo ? nuevo.id : null;
}

// Linkea una orden de produccion al trabajo correspondiente
async function linkOrdenATrabajo(ordenId, proformaId) {
    const { data: existente } = await db.from('trabajos')
        .select('id, orden_id')
        .eq('proforma_id', proformaId)
        .maybeSingle();
    if (existente && existente.orden_id !== ordenId) {
        await db.from('trabajos').update({ orden_id: ordenId }).eq('id', existente.id);
    }
}

// Abrir proforma/orden desde el kanban (activa primero el tab correcto)
async function abrirProformaDesdeKanban(proformaId) {
    cerrarModalTrabajo();
    switchTab('proformas');
    setTimeout(() => abrirProforma(proformaId), 50);
}
async function abrirOrdenDesdeKanban(ordenId) {
    cerrarModalTrabajo();
    switchTab('ordenes');
    setTimeout(() => abrirOrden(ordenId), 50);
}

// Normaliza un nombre para matching simple
function _kanbanNormNombre(s) {
    return (s || '').toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function _kanbanNombreCoincide(a, b) {
    const na = _kanbanNormNombre(a);
    const nb = _kanbanNormNombre(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // Una contiene la otra (para razon social vs nombre comercial)
    const tokensA = na.split(' ').filter(t => t.length > 2);
    const tokensB = nb.split(' ').filter(t => t.length > 2);
    if (!tokensA.length || !tokensB.length) return false;
    // Al menos 2 tokens en comun (o 1 si son nombres cortos)
    const comunes = tokensA.filter(t => tokensB.includes(t));
    const umbral = Math.min(2, Math.min(tokensA.length, tokensB.length));
    return comunes.length >= umbral;
}

// Calcula total esperado de una proforma (sub + IVA)
async function _kanbanTotalProforma(proformaId) {
    if (!proformaId) return 0;
    const [itemsRes, profRes] = await Promise.all([
        db.from('proforma_items').select('cantidad, precio_unitario').eq('proforma_id', proformaId),
        db.from('proformas').select('iva_porcentaje').eq('id', proformaId).maybeSingle()
    ]);
    const sub = (itemsRes.data || []).reduce((s, i) => s + ((+i.cantidad || 0) * (+i.precio_unitario || 0)), 0);
    const ivaPct = (profRes.data?.iva_porcentaje ?? 15);
    return sub + (sub * ivaPct / 100);
}

// Scan: cruza trabajos con facturas Contifico para mover estados
// OPTIMIZADO: pre-carga facturas + items en batch (antes era N+1: 2-4 queries x trabajo)
async function kanbanScanContifico() {
    let movidosACobro = 0, movidosAPostventa = 0;

    // 1. Trabajos sin factura, en estados elegibles: buscar match Contifico
    const estadosFac = ['produccion','pendiente_por_facturar','facturacion','entrega','diseno','prueba_color','proforma_enviada'];
    const { data: trabajos } = await db.from('trabajos')
        .select('id, estado, cliente_id, proforma_id, historial, clientes(nombre, empresa, rfc)')
        .is('factura_id', null)
        .in('estado', estadosFac);

    const lista = (trabajos || []).filter(t => t.cliente_id && (t.clientes?.empresa || t.clientes?.nombre || t.clientes?.rfc));
    if (!lista.length) {
        // pasar al paso 2 directamente
    } else {
        const desde = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString().slice(0, 10);

        // BATCH 1: traer TODAS las facturas activas del rango (no anuladas, ultimos 120 dias)
        // Antes: 1-2 queries POR trabajo. Ahora: 1 sola query total.
        const { data: facsAll } = await db.from('facturas')
            .select('id, total, saldo, estado_pago, cliente, identificacion, fecha, estado')
            .gte('fecha', desde)
            .neq('estado', 'Anulada');

        // Indexar facturas por identificacion (RFC) para lookup O(1)
        const facsPorRfc = {};
        (facsAll || []).forEach(f => {
            const k = (f.identificacion || '').trim();
            if (!k) return;
            if (!facsPorRfc[k]) facsPorRfc[k] = [];
            facsPorRfc[k].push(f);
        });

        // BATCH 2: pre-cargar items + iva_porcentaje de todas las proformas relevantes
        const proformaIds = [...new Set(lista.map(t => t.proforma_id).filter(Boolean))];
        const totalesProforma = {};
        if (proformaIds.length) {
            const [itemsRes, profRes] = await Promise.all([
                db.from('proforma_items').select('proforma_id, cantidad, precio_unitario').in('proforma_id', proformaIds),
                db.from('proformas').select('id, iva_porcentaje').in('id', proformaIds)
            ]);
            const subPorProf = {};
            (itemsRes.data || []).forEach(i => {
                subPorProf[i.proforma_id] = (subPorProf[i.proforma_id] || 0) + ((+i.cantidad || 0) * (+i.precio_unitario || 0));
            });
            (profRes.data || []).forEach(p => {
                const sub = subPorProf[p.id] || 0;
                totalesProforma[p.id] = sub + (sub * ((p.iva_porcentaje ?? 15) / 100));
            });
        }

        // Procesar in-memory: ya no hay queries dentro del loop
        for (const t of lista) {
            const nombre = t.clientes?.empresa || t.clientes?.nombre || '';
            const rfc = (t.clientes?.rfc || '').trim();

            // Buscar facturas candidatas: por RFC primero (preciso), luego por nombre aproximado
            let facs = [];
            if (rfc && facsPorRfc[rfc]) {
                facs = facsPorRfc[rfc];
            }
            if (!facs.length && nombre) {
                const nlow = nombre.toLowerCase();
                facs = (facsAll || []).filter(f =>
                    (f.cliente || '').toLowerCase().includes(nlow.slice(0, Math.min(30, nlow.length)))
                    && _kanbanNombreCoincide(nombre, f.cliente)
                );
            }
            if (!facs.length) continue;

            // Match por total esperado si hay proforma
            let candidatas = facs;
            if (t.proforma_id && totalesProforma[t.proforma_id] > 0) {
                const total = totalesProforma[t.proforma_id];
                const tol = Math.max(1.0, total * 0.005); // 0.5% o $1, lo que sea mayor
                candidatas = facs.filter(f => Math.abs(+f.total - total) <= tol);
            }
            // Si multiples, saltar (necesita revision manual)
            if (candidatas.length !== 1) continue;

            const fac = candidatas[0];
            const nuevoEstado = (fac.estado_pago === 'pagada') ? 'postventa' : 'cobro';
            const hist = _pushHistorial(t.historial, t.estado, nuevoEstado);
            const { error } = await db.from('trabajos').update({
                factura_id: fac.id, estado: nuevoEstado, historial: hist
            }).eq('id', t.id);
            if (!error) {
                if (nuevoEstado === 'cobro') movidosACobro++;
                else movidosAPostventa++;
            }
        }
    }

    // 2. Trabajos en cobro con factura ya pagada -> postventa
    const { data: enCobro } = await db.from('trabajos')
        .select('id, historial, factura_id, facturas(estado_pago)')
        .eq('estado', 'cobro')
        .not('factura_id', 'is', null);
    for (const t of (enCobro || [])) {
        if (t.facturas?.estado_pago === 'pagada') {
            const hist = _pushHistorial(t.historial, 'cobro', 'postventa');
            const { error } = await db.from('trabajos').update({ estado: 'postventa', historial: hist }).eq('id', t.id);
            if (!error) movidosAPostventa++;
        }
    }

    // Si hay cambios y el tab trabajos esta activo, recargar
    if ((movidosACobro + movidosAPostventa) > 0) {
        invalidarCacheTrabajos();
        if (document.getElementById('tab-trabajos')?.classList.contains('active')) {
            await cargarTrabajos({ force: true });
        }
    }
    return { movidosACobro, movidosAPostventa };
}

// Crea proforma desde una tarjeta de prospecto: arrastra el cliente y vincula el trabajo
async function crearProformaDesdeProspecto(trabajoId) {
    const t = trabajosCache.find(x => x.id === trabajoId);
    if (!t) { alert('Trabajo no encontrado'); return; }

    // Siguiente numero de proforma
    const { data: maxRow } = await db.from('proformas')
        .select('numero').order('numero', { ascending: false }).limit(1);
    const nextNum = (maxRow && maxRow.length > 0) ? maxRow[0].numero + 1 : 6001;

    // Crear proforma con cliente precargado
    const insertPayload = {
        numero: nextNum,
        estado: 'borrador',
        cliente_id: t.cliente_id || null,
        created_by: currentUser?.id || null,
        created_by_name: currentUser?.nombre || null
    };
    const { data: prof, error } = await db.from('proformas')
        .insert(insertPayload).select().single();
    if (error) { alert('Error creando proforma: ' + error.message); return; }

    // Vincular el trabajo (sigue en 'prospecto' hasta que la proforma se envie)
    await db.from('trabajos')
        .update({ proforma_id: prof.id })
        .eq('id', trabajoId);

    invalidarCacheTrabajos();
    // Abrir el editor de proforma
    await abrirProforma(prof.id);
    switchTab('proformas');
}

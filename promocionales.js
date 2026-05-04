// =====================================================
// PROMOCIONALES — modulo extraido de index.html el 2026-05-04
// Cotizador + admin de productos/proveedores/tecnicas + import Excel + JSZip imagenes.
// Depende de globales del script principal: db, currentUser, escapeHtml, fmtN,
// switchTab, addItemToProforma helpers, JSZip, XLSX (libs CDN).
// Se carga via <script src="promocionales.js"> al final del body.
// =====================================================

// =====================================================
// PROMOCIONALES
// =====================================================
let promoProductosCache = [];
let promoProveedoresCache = [];
let promoTecnicasCache = [];
let promoProductoActivo = null;
const PROMO_PAGE_SIZE = 60;
let promoPagina = 1;
window._promoManualImp = false;

async function promoInitTab() {
    if (!promoProductosCache.length) {
        const [{data: prods}, {data: provs}, {data: tecs}] = await Promise.all([
            db.from('promocionales_productos').select('*').eq('activo', true).order('nombre'),
            db.from('promocionales_proveedores').select('*').eq('activo', true).order('nombre'),
            db.from('promocionales_tecnicas').select('*').eq('activo', true).order('orden')
        ]);
        promoProductosCache = prods || [];
        promoProveedoresCache = provs || [];
        promoTecnicasCache = tecs || [];
    }
    const selProv = document.getElementById('promoFiltroProveedor');
    if (selProv) {
        selProv.innerHTML = '<option value="">Todos los proveedores</option>' +
            promoProveedoresCache.map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
    }
    const selTec = document.getElementById('promoFiltroTecnica');
    if (selTec) {
        selTec.innerHTML = '<option value="">Todas las técnicas</option>' +
            promoTecnicasCache.map(t => `<option value="${t.codigo}">${escapeHtml(t.nombre)}</option>`).join('');
    }
    promoPagina = 1;
    promoRender();
}

function _promoFiltrar() {
    const q = (document.getElementById('promoSearch')?.value || '').trim().toLowerCase();
    const provId = document.getElementById('promoFiltroProveedor')?.value;
    const tec = document.getElementById('promoFiltroTecnica')?.value;
    const soloStock = document.getElementById('promoFiltroStock')?.checked;
    return promoProductosCache.filter(p => {
        if (provId && +provId !== p.proveedor_id) return false;
        if (tec && !(p.tecnicas_codigos || []).includes(tec)) return false;
        if (soloStock && (+p.stock || 0) <= 0) return false;
        if (q) {
            const hay = (p.codigo_proveedor + ' ' + p.nombre + ' ' + (p.descripcion||'')).toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
}

function promoRender() {
    const grid = document.getElementById('promoGrid');
    const cont = document.getElementById('promoContador');
    const pag = document.getElementById('promoPaginacion');
    if (!grid) return;
    const filtrados = _promoFiltrar();
    cont.textContent = `${filtrados.length} productos`;
    const totalPaginas = Math.max(1, Math.ceil(filtrados.length / PROMO_PAGE_SIZE));
    if (promoPagina > totalPaginas) promoPagina = 1;
    const inicio = (promoPagina - 1) * PROMO_PAGE_SIZE;
    const pagProds = filtrados.slice(inicio, inicio + PROMO_PAGE_SIZE);
    grid.innerHTML = pagProds.map(p => {
        const precioSugerido = (+p.costo + 0.40) * 1.35;
        const stockClass = (+p.stock || 0) > 0 ? '' : 'sin';
        const stockTxt = (+p.stock || 0) > 0 ? `Stock: ${p.stock}` : 'Sin stock';
        const chips = (p.tecnicas_codigos || []).map(t => {
            const tec = promoTecnicasCache.find(x => x.codigo === t);
            return `<span class="promo-chip">${tec ? tec.nombre.split(' ')[0] : t}</span>`;
        }).join('');
        const img = p.imagen_url
            ? `<img src="${p.imagen_url}" loading="lazy" decoding="async" alt="${(p.nombre||'').replace(/"/g,'&quot;')}">` : '📦';
        return `<div class="promo-card" onclick="promoAbrirModal(${p.id})">
            <div class="promo-card-img">${img}</div>
            <div class="promo-card-nombre">${(p.nombre||'').replace(/</g,'&lt;')}</div>
            <div class="promo-card-cod">${p.codigo_proveedor}</div>
            <div class="promo-card-tec">${chips}</div>
            <div class="promo-card-foot">
                <span class="promo-card-precio">~$${precioSugerido.toFixed(2)}</span>
                <span class="promo-card-stock ${stockClass}">${stockTxt}</span>
            </div>
        </div>`;
    }).join('') || '<div style="padding:2rem;text-align:center;color:var(--gray-400);">No hay productos que coincidan con los filtros</div>';
    if (totalPaginas > 1) {
        pag.innerHTML = `
            <button class="btn btn-secondary btn-sm" ${promoPagina === 1 ? 'disabled' : ''} onclick="promoPag(-1)">← Anterior</button>
            <span style="margin:0 1rem;color:var(--gray-500);font-size:0.85rem;">Página ${promoPagina} de ${totalPaginas}</span>
            <button class="btn btn-secondary btn-sm" ${promoPagina === totalPaginas ? 'disabled' : ''} onclick="promoPag(1)">Siguiente →</button>
        `;
    } else {
        pag.innerHTML = '';
    }
}

function promoPag(delta) {
    promoPagina += delta;
    promoRender();
    window.scrollTo({top:0, behavior:'smooth'});
}

function promoAbrirModal(id) {
    const p = promoProductosCache.find(x => x.id === id);
    if (!p) return;
    promoProductoActivo = p;
    window._promoManualImp = false;
    const prov = promoProveedoresCache.find(x => x.id === p.proveedor_id);
    document.getElementById('promoModalTitulo').textContent = p.nombre;
    document.getElementById('promoModalCodigo').textContent = p.codigo_proveedor;
    document.getElementById('promoModalProveedor').textContent = prov ? prov.nombre : '—';
    document.getElementById('promoModalStock').textContent = (+p.stock || 0) + ' unidades';
    document.getElementById('promoModalCategoria').textContent = p.categoria || '—';
    document.getElementById('promoModalDesc').textContent = p.descripcion || '';
    const imgEl = document.getElementById('promoModalImg');
    imgEl.innerHTML = p.imagen_url ? `<img src="${p.imagen_url}" loading="lazy" decoding="async" alt="" style="max-width:100%;max-height:100%;">` : '📦';
    const selTec = document.getElementById('promoTecnica');
    const availables = promoTecnicasCache.filter(t => (p.tecnicas_codigos || []).includes(t.codigo));
    if (!availables.length) {
        selTec.innerHTML = '<option value="">Sin técnica</option>';
        document.getElementById('promoSinImp').checked = true;
    } else {
        selTec.innerHTML = availables.map(t => `<option value="${t.codigo}">${escapeHtml(t.nombre)} ($${(+t.precio_default).toFixed(2)})</option>`).join('');
        document.getElementById('promoSinImp').checked = false;
    }
    document.getElementById('promoCantidad').value = 50;
    document.getElementById('promoMarkup').value = 35;
    document.getElementById('promoDescuento').value = 0;
    const primeraTec = availables[0];
    if (primeraTec) document.getElementById('promoPrecioImpresion').value = (+primeraTec.precio_default).toFixed(2);
    promoCalcular();
    // Update add-to-proforma button visibility
    const addBtn = document.querySelector('#promoModal .btn-add-proforma');
    if (addBtn) addBtn.style.display = proformaActiva ? 'block' : 'none';
    document.getElementById('promoModal').style.display = 'flex';
}

function promoCerrarModal() {
    document.getElementById('promoModal').style.display = 'none';
    promoProductoActivo = null;
}

function promoCalcular() {
    const p = promoProductoActivo;
    if (!p) return;
    const cantidad = Math.max(0, parseInt(document.getElementById('promoCantidad').value) || 0);
    const sinImp = document.getElementById('promoSinImp').checked;
    const tecCodigo = document.getElementById('promoTecnica').value;
    const tec = promoTecnicasCache.find(t => t.codigo === tecCodigo);

    // Auto-cargar precio impresion de la tecnica (salvo que el usuario haya editado manual)
    if (!window._promoManualImp && tec) {
        document.getElementById('promoPrecioImpresion').value = (+tec.precio_default).toFixed(2);
    }
    const precioImpUnit = sinImp ? 0 : (parseFloat(document.getElementById('promoPrecioImpresion').value) || 0);
    const costoProdUnit = +p.costo;
    const costoProd = costoProdUnit * cantidad;
    const costoImp = precioImpUnit * cantidad;
    const costoTotal = costoProd + costoImp;

    const margenPct = parseFloat(document.getElementById('promoMarkup').value) || 0;
    // Margen sobre venta: precio = costo / (1 - margen/100)
    const subtotalSinIVA = margenPct < 100 ? costoTotal / (1 - margenPct / 100) : costoTotal;
    const utilidad = subtotalSinIVA - costoTotal;

    const descPct = parseFloat(document.getElementById('promoDescuento').value) || 0;
    const descMonto = subtotalSinIVA * (descPct / 100);
    const subtotalDesc = subtotalSinIVA - descMonto;

    const ivaPct = parseFloat(document.getElementById('promoIVA').value) || 0;
    const montoIVA = subtotalDesc * (ivaPct / 100);
    const totalConIVA = subtotalDesc + montoIVA;
    const precioUnit = cantidad > 0 ? subtotalDesc / cantidad : 0;
    const utilidadFinal = subtotalDesc - costoTotal;
    const margenVenta = subtotalDesc > 0 ? utilidadFinal / subtotalDesc * 100 : 0;

    // Render
    document.getElementById('promoCantDisp').textContent = cantidad;
    document.getElementById('promoCostoProdUnit').textContent = costoProdUnit.toFixed(2);
    document.getElementById('promoCostoProd').textContent = fmtN(costoProd, 2);
    document.getElementById('promoCostoImpRow').style.display = (sinImp || costoImp === 0) ? 'none' : '';
    document.getElementById('promoCostoImpLabel').textContent = tec && !sinImp
        ? `Impresión ${tec.nombre} (${cantidad} × $${precioImpUnit.toFixed(2)})` : 'Impresión';
    document.getElementById('promoCostoImp').textContent = fmtN(costoImp, 2);
    document.getElementById('promoCostoTotal').textContent = fmtN(costoTotal, 2);
    document.getElementById('promoUtilidad').textContent = fmtN(utilidad, 2);
    document.getElementById('promoMarkupDisp').textContent = margenPct;
    document.getElementById('promoSubtotalSinIVA').textContent = fmtN(subtotalSinIVA, 2);
    if (descPct > 0) {
        document.getElementById('promoDescRow').style.display = '';
        document.getElementById('promoDescPct').textContent = descPct;
        document.getElementById('promoDescMonto').textContent = fmtN(descMonto, 2);
    } else {
        document.getElementById('promoDescRow').style.display = 'none';
    }
    document.getElementById('promoIvaPct').textContent = ivaPct;
    document.getElementById('promoMontoIVA').textContent = fmtN(montoIVA, 2);
    document.getElementById('promoTotal').textContent = fmtN(totalConIVA, 2);
    document.getElementById('promoPrecioUnit').textContent = fmtN(precioUnit, 2);
    document.getElementById('promoMargenVenta').textContent = fmtN(margenVenta, 1);

    // Alerta de stock
    const stockDisp = (+p.stock || 0);
    const alertEl = document.getElementById('promoStockAlert');
    if (cantidad > stockDisp) {
        alertEl.style.display = '';
        alertEl.innerHTML = `⚠️ Cantidad (${cantidad}) excede stock actual (${stockDisp}). Confirmar con proveedor.`;
    } else {
        alertEl.style.display = 'none';
    }
    document.getElementById('promoTecnicaInfo').textContent = tec ? (tec.descripcion || '') : '';
}

function _promoBuildDescripcion() {
    const p = promoProductoActivo;
    if (!p) return 'Promocional';
    const partes = [p.nombre, `código ${p.codigo_proveedor}`];
    const sinImp = document.getElementById('promoSinImp').checked;
    if (!sinImp) {
        const tecCodigo = document.getElementById('promoTecnica').value;
        const tec = promoTecnicasCache.find(t => t.codigo === tecCodigo);
        if (tec) partes.push(`Impresión ${tec.nombre}`);
    } else {
        partes.push('Sin impresión');
    }
    return partes.join(' | ');
}

function _promoCaptureSnapshot() {
    const p = promoProductoActivo;
    const sinImp = document.getElementById('promoSinImp').checked;
    const tecCodigo = document.getElementById('promoTecnica').value;
    const tec = promoTecnicasCache.find(t => t.codigo === tecCodigo);
    return {
        tipo: 'promocional',
        producto: p ? { id: p.id, codigo: p.codigo_proveedor, nombre: p.nombre, proveedor_id: p.proveedor_id, costo: +p.costo } : null,
        cantidad: parseInt(document.getElementById('promoCantidad').value) || 0,
        tecnica: sinImp ? null : (tec ? { codigo: tec.codigo, nombre: tec.nombre, precio_default: +tec.precio_default } : null),
        precio_impresion_unit: sinImp ? 0 : parseFloat(document.getElementById('promoPrecioImpresion').value) || 0,
        sin_impresion: sinImp,
        margen_venta_pct: parseFloat(document.getElementById('promoMarkup').value) || 0,
        descuento_pct: parseFloat(document.getElementById('promoDescuento').value) || 0,
        iva_pct: parseFloat(document.getElementById('promoIVA').value) || 0,
        costo_total: parseFloat(document.getElementById('promoCostoTotal').textContent.replace(',', '.')) || 0,
        precio_unit: parseFloat(document.getElementById('promoPrecioUnit').textContent.replace(',', '.')) || 0,
        subtotal_sin_iva: parseFloat(document.getElementById('promoSubtotalSinIVA').textContent.replace(',', '.')) || 0,
        total_con_iva: parseFloat(document.getElementById('promoTotal').textContent.replace(',', '.')) || 0
    };
}

function _promoCapturarDatosItem() {
    if (!promoProductoActivo) { alert('Elegí un producto primero'); return null; }
    const cantidad = parseInt(document.getElementById('promoCantidad').value) || 0;
    if (cantidad <= 0) { alert('Cantidad debe ser mayor a 0'); return null; }
    return {
        userText: '',
        descripcion: _promoBuildDescripcion(),
        cantidad,
        precioUnit: parseFloat(document.getElementById('promoPrecioUnit').textContent.replace(',', '.')) || 0,
        itemIvaPct: parseFloat(document.getElementById('promoIVA').value) || 0,
        snapshot: _promoCaptureSnapshot()
    };
}

function addItemToProformaPromo() {
    if (!proformaActiva) return;
    const d = _promoCapturarDatosItem();
    if (!d) return;
    proformaActiva.items.push({
        orden: proformaActiva.items.length + 1,
        descripcion: d.descripcion, cantidad: d.cantidad, precio_unitario: d.precioUnit,
        iva_pct: d.itemIvaPct, imagen_url: promoProductoActivo?.imagen_url || null,
        metodo_impresion: 'promocional',
        datos_cotizacion: d.snapshot
    });
    promoCerrarModal();
    switchTab('proformas');
    renderProformaItems();
}

// ===== Admin promocionales =====
async function promoProveedoresAdminLoad() {
    const [{data: provs}, {data: counts}] = await Promise.all([
        db.from('promocionales_proveedores').select('*').order('nombre'),
        db.from('promocionales_productos').select('proveedor_id')
    ]);
    const cnt = {};
    (counts || []).forEach(c => { cnt[c.proveedor_id] = (cnt[c.proveedor_id] || 0) + 1; });
    promoProveedoresCache = provs || [];
    const tbody = document.getElementById('promoProveedoresBody');
    tbody.innerHTML = (provs || []).map((p, i) => `<tr style="${p.activo ? '' : 'opacity:0.5;'}">
        <td><input type="text" value="${(p.nombre||'').replace(/"/g,'&quot;')}" onchange="promoProvUpdate(${i},'nombre',this.value)"></td>
        <td><input type="text" value="${(p.contacto||'').replace(/"/g,'&quot;')}" onchange="promoProvUpdate(${i},'contacto',this.value)"></td>
        <td><input type="email" value="${(p.email||'').replace(/"/g,'&quot;')}" onchange="promoProvUpdate(${i},'email',this.value)"></td>
        <td><input type="text" value="${(p.telefono||'').replace(/"/g,'&quot;')}" onchange="promoProvUpdate(${i},'telefono',this.value)"></td>
        <td style="text-align:center;font-weight:600;color:#0891b2;">${cnt[p.id] || 0}</td>
        <td style="text-align:center;"><input type="checkbox" ${p.activo ? 'checked' : ''} onchange="promoProvUpdate(${i},'activo',this.checked)"></td>
        <td><button class="btn btn-danger btn-sm" onclick="promoProvDelete(${i})">X</button></td>
    </tr>`).join('');
}

async function promoProvUpdate(i, field, val) {
    promoProveedoresCache[i][field] = val;
    const p = promoProveedoresCache[i];
    const { error } = await db.from('promocionales_proveedores').update({ [field]: val }).eq('id', p.id);
    if (error) alert('Error: ' + error.message);
}

async function promoProvDelete(i) {
    const p = promoProveedoresCache[i];
    if (!confirm('Eliminar proveedor "' + p.nombre + '"? Esto eliminará también todos sus productos.')) return;
    const { error } = await db.from('promocionales_proveedores').delete().eq('id', p.id);
    if (error) { alert('Error: ' + error.message); return; }
    promoProveedoresCache.splice(i, 1);
    promoProveedoresAdminLoad();
}

async function addPromoProveedor() {
    const nombre = prompt('Nombre del proveedor:');
    if (!nombre) return;
    const { error } = await db.from('promocionales_proveedores').insert({ nombre, activo: true });
    if (error) { alert('Error: ' + error.message); return; }
    promoProveedoresAdminLoad();
}

async function promoTecnicasAdminLoad() {
    const { data } = await db.from('promocionales_tecnicas').select('*').order('orden');
    promoTecnicasCache = data || [];
    const tbody = document.getElementById('promoTecnicasBody');
    tbody.innerHTML = (data || []).map((t, i) => `<tr style="${t.activo ? '' : 'opacity:0.5;'}">
        <td style="font-family:monospace;font-size:0.8rem;">${t.codigo}</td>
        <td><input type="text" value="${(t.nombre||'').replace(/"/g,'&quot;')}" onchange="promoTecUpdate(${i},'nombre',this.value)"></td>
        <td><input type="number" step="0.01" min="0" value="${+t.precio_default}" style="width:90px" onchange="promoTecUpdate(${i},'precio_default',+this.value)"></td>
        <td><input type="text" value="${(t.descripcion||'').replace(/"/g,'&quot;')}" onchange="promoTecUpdate(${i},'descripcion',this.value)"></td>
        <td><input type="number" value="${+t.orden}" style="width:65px" onchange="promoTecUpdate(${i},'orden',+this.value)"></td>
        <td style="text-align:center;"><input type="checkbox" ${t.activo ? 'checked' : ''} onchange="promoTecUpdate(${i},'activo',this.checked)"></td>
        <td><button class="btn btn-danger btn-sm" onclick="promoTecDelete(${i})">X</button></td>
    </tr>`).join('');
}

async function promoTecUpdate(i, field, val) {
    promoTecnicasCache[i][field] = val;
    const t = promoTecnicasCache[i];
    const { error } = await db.from('promocionales_tecnicas').update({ [field]: val }).eq('id', t.id);
    if (error) alert('Error: ' + error.message);
}

async function promoTecDelete(i) {
    const t = promoTecnicasCache[i];
    if (!confirm('Eliminar técnica "' + t.nombre + '"?')) return;
    const { error } = await db.from('promocionales_tecnicas').delete().eq('id', t.id);
    if (error) { alert('Error: ' + error.message); return; }
    promoTecnicasCache.splice(i, 1);
    promoTecnicasAdminLoad();
}

async function addPromoTecnica() {
    const codigo = prompt('Código (ej. "transfer"):');
    if (!codigo) return;
    const nombre = prompt('Nombre:');
    if (!nombre) return;
    const maxOrden = promoTecnicasCache.reduce((mx, t) => Math.max(mx, +t.orden || 0), 0);
    const { error } = await db.from('promocionales_tecnicas')
        .insert({ codigo: codigo.toLowerCase(), nombre, precio_default: 0.40, activo: true, orden: maxOrden + 10 });
    if (error) { alert('Error: ' + error.message); return; }
    promoTecnicasAdminLoad();
}

// ===== Admin Promo Productos =====
let promoAdminProductosCache = [];
let promoAdminPagina = 1;
const PROMO_ADMIN_PAGE = 50;

async function promoProductosAdminLoad() {
    // Cargar proveedores y productos
    const [{data: prods}, {data: provs}, {data: tecs}] = await Promise.all([
        db.from('promocionales_productos').select('*').order('nombre'),
        db.from('promocionales_proveedores').select('*').order('nombre'),
        db.from('promocionales_tecnicas').select('*').eq('activo', true).order('orden')
    ]);
    promoAdminProductosCache = prods || [];
    promoProveedoresCache = provs || [];
    promoTecnicasCache = tecs || [];
    const selProv = document.getElementById('promoAdminFiltroProv');
    if (selProv) {
        selProv.innerHTML = '<option value="">Todos los proveedores</option>' +
            (provs || []).map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
    }
    promoAdminPagina = 1;
    promoAdminRender();
}

function _promoAdminFiltrar() {
    const q = (document.getElementById('promoAdminSearch')?.value || '').trim().toLowerCase();
    const provId = document.getElementById('promoAdminFiltroProv')?.value;
    const soloActivos = document.getElementById('promoAdminSoloActivos')?.checked;
    return promoAdminProductosCache.filter(p => {
        if (provId && +provId !== p.proveedor_id) return false;
        if (soloActivos && !p.activo) return false;
        if (q) {
            const hay = (p.codigo_proveedor + ' ' + p.nombre).toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
}

function promoAdminRender() {
    const tbody = document.getElementById('promoAdminProductosBody');
    const cont = document.getElementById('promoAdminContador');
    const pag = document.getElementById('promoAdminPag');
    if (!tbody) return;
    const filtrados = _promoAdminFiltrar();
    cont.textContent = `${filtrados.length} productos`;
    const totalPag = Math.max(1, Math.ceil(filtrados.length / PROMO_ADMIN_PAGE));
    if (promoAdminPagina > totalPag) promoAdminPagina = 1;
    const inicio = (promoAdminPagina - 1) * PROMO_ADMIN_PAGE;
    const pagProds = filtrados.slice(inicio, inicio + PROMO_ADMIN_PAGE);
    const provMap = {};
    promoProveedoresCache.forEach(p => { provMap[p.id] = p.nombre; });
    tbody.innerHTML = pagProds.map(p => {
        const idx = promoAdminProductosCache.findIndex(x => x.id === p.id);
        const tecStr = (p.tecnicas_codigos || []).join(', ') || '—';
        const fotoCell = p.imagen_url
            ? `<img src="${p.imagen_url}" loading="lazy" decoding="async" alt="" style="width:48px;height:48px;object-fit:contain;background:#f1f5f9;border-radius:4px;cursor:pointer;" onclick="promoProdAbrirFoto(${idx})" title="Click para cambiar">`
            : `<button class="btn btn-secondary btn-sm" style="padding:0.2rem 0.4rem;font-size:0.7rem;" onclick="promoProdAbrirFoto(${idx})">📷 Subir</button>`;
        return `<tr style="${p.activo ? '' : 'opacity:0.5;'}">
            <td>${fotoCell}</td>
            <td style="font-family:monospace;font-size:0.75rem;">${escapeHtml(p.codigo_proveedor)}</td>
            <td><input type="text" value="${escapeHtml(p.nombre || '')}" style="min-width:180px" onchange="promoProdUpdate(${idx},'nombre',this.value)"></td>
            <td style="font-size:0.8rem;">${escapeHtml(provMap[p.proveedor_id] || '—')}</td>
            <td style="font-size:0.75rem;color:var(--gray-500);">${escapeHtml(p.categoria || '—')}</td>
            <td><input type="number" step="0.01" min="0" value="${+p.costo}" style="width:75px" onchange="promoProdUpdate(${idx},'costo',+this.value)"></td>
            <td><input type="number" step="1" value="${+p.stock}" style="width:70px" onchange="promoProdUpdate(${idx},'stock',+this.value)"></td>
            <td style="font-size:0.72rem;color:#0369a1;">${tecStr}</td>
            <td style="text-align:center;"><input type="checkbox" ${p.activo ? 'checked' : ''} onchange="promoProdUpdate(${idx},'activo',this.checked)"></td>
            <td style="white-space:nowrap;">
                <button class="btn btn-secondary btn-sm" style="padding:0.2rem 0.4rem;font-size:0.7rem;" title="Historial" onclick="verConsumosProducto(${p.id})">📜</button>
                <button class="btn btn-danger btn-sm" onclick="promoProdDelete(${idx})">X</button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--gray-400);">Sin resultados</td></tr>';

    if (totalPag > 1) {
        pag.innerHTML = `
            <button class="btn btn-secondary btn-sm" ${promoAdminPagina === 1 ? 'disabled' : ''} onclick="promoAdminPag(-1)">← Anterior</button>
            <span style="margin:0 0.75rem;color:var(--gray-500);font-size:0.8rem;">Pág ${promoAdminPagina}/${totalPag}</span>
            <button class="btn btn-secondary btn-sm" ${promoAdminPagina === totalPag ? 'disabled' : ''} onclick="promoAdminPag(1)">Siguiente →</button>`;
    } else pag.innerHTML = '';
}

function promoAdminPag(delta) { promoAdminPagina += delta; promoAdminRender(); }

async function promoProdUpdate(i, field, val) {
    promoAdminProductosCache[i][field] = val;
    const p = promoAdminProductosCache[i];
    const { error } = await db.from('promocionales_productos').update({ [field]: val }).eq('id', p.id);
    if (error) alert('Error: ' + error.message);
}

async function promoProdDelete(i) {
    const p = promoAdminProductosCache[i];
    if (!confirm(`Eliminar "${p.codigo_proveedor} — ${p.nombre}"?`)) return;
    const { error } = await db.from('promocionales_productos').delete().eq('id', p.id);
    if (error) { alert('Error: ' + error.message); return; }
    promoAdminProductosCache.splice(i, 1);
    promoAdminRender();
}

function promoProdAbrirFoto(i) {
    const p = promoAdminProductosCache[i];
    if (!p) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const prov = promoProveedoresCache.find(x => x.id === p.proveedor_id);
        const subfolder = (prov?.nombre || 'proveedor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const safeCod = p.codigo_proveedor.replace(/[\/\s]/g, '_');
        const dest = `${subfolder}/${safeCod}.${ext}`;
        const { error: upErr } = await db.storage.from('promocional-imagenes')
            .upload(dest, file, { contentType: file.type || 'image/jpeg', upsert: true });
        if (upErr) { alert('Error subiendo imagen: ' + upErr.message); return; }
        const { data: pub } = db.storage.from('promocional-imagenes').getPublicUrl(dest);
        const url = pub.publicUrl + '?t=' + Date.now(); // cache bust
        const { error } = await db.from('promocionales_productos').update({ imagen_url: url }).eq('id', p.id);
        if (error) { alert('Error: ' + error.message); return; }
        promoAdminProductosCache[i].imagen_url = url;
        promoAdminRender();
    };
    input.click();
}

// ===== Import Excel de promocionales =====
let _promoImportBuffer = null; // { proveedor_id, productos: [...] }

function promoImportAbrir() {
    const sel = document.getElementById('promoImportProveedor');
    sel.innerHTML = '<option value="">Elegir proveedor...</option>' +
        promoProveedoresCache.filter(p => p.activo)
            .map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
    document.getElementById('promoImportArchivo').value = '';
    document.getElementById('promoImportMapeo').style.display = 'none';
    document.getElementById('promoImportPreview').style.display = 'none';
    document.getElementById('promoImportProgreso').style.display = 'none';
    document.getElementById('promoImportError').style.display = 'none';
    document.getElementById('promoImportBtnConfirm').disabled = true;
    _promoImportBuffer = null;
    document.getElementById('promoImportModal').style.display = 'flex';
}

function promoImportCerrar() {
    document.getElementById('promoImportModal').style.display = 'none';
    _promoImportBuffer = null;
}

function _rmAccents(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function _promoNormTecnicas(texto) {
    if (!texto) return [];
    const t = _rmAccents(String(texto).toUpperCase());
    const codigos = new Set();
    if (/\bUV\b/.test(t)) codigos.add('uv');
    if (/SERI[GFR]+AFIA|SERIGARFIA|SERIFRAFIA/.test(t)) codigos.add('serigrafia');
    if (/LASER/.test(t)) codigos.add('laser');
    if (/S[UB]+LIMA/.test(t)) codigos.add('sublimacion');
    if (/TRANSFER/.test(t)) codigos.add('transfer');
    return [...codigos].sort();
}

function _detectColumnas(headers) {
    const map = { codigo: null, nombre: null, descripcion: null, impresion: null, stock: null, pvp: null, categoria: null };
    headers.forEach((h, i) => {
        const norm = _rmAccents(String(h || '').toUpperCase().trim());
        if (/\bCODIGO\b|\bCOD\b|\bSKU\b/.test(norm) && map.codigo === null) map.codigo = i;
        else if (/\bNOMBRE\b/.test(norm) && map.nombre === null) map.nombre = i;
        else if (/\bDESCRIPCION\b|\bDETALLE\b/.test(norm) && map.descripcion === null) map.descripcion = i;
        else if (/IMPRESION|TECNICA|PERSONALIZACION/.test(norm) && map.impresion === null) map.impresion = i;
        else if (/\bSTOCK\b|EXISTENCIA|INVENTARIO|CANTIDAD/.test(norm) && map.stock === null) map.stock = i;
        else if (/\bPVP\b|\bPRECIO\b|\bCOSTO\b/.test(norm) && !/IVA/.test(norm) && map.pvp === null) map.pvp = i;
        else if (/CATEGORIA|\bCAT\b|\bC\b|CLASE|FAMILIA/.test(norm) && map.categoria === null) map.categoria = i;
    });
    return map;
}

async function promoImportParsearArchivo() {
    const file = document.getElementById('promoImportArchivo').files[0];
    if (!file) return;
    const errorEl = document.getElementById('promoImportError');
    errorEl.style.display = 'none';
    try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

        // Detectar fila de headers (buscar la que contenga al menos 3 palabras claves)
        let headerRow = -1;
        for (let i = 0; i < Math.min(10, rows.length); i++) {
            const joined = _rmAccents(String(rows[i].join(' ') || '').toUpperCase());
            const matches = ['CODIGO', 'NOMBRE', 'PRECIO', 'PVP', 'DESCRIPCION', 'STOCK', 'IMPRESION'].filter(k => joined.includes(k));
            if (matches.length >= 2) { headerRow = i; break; }
        }
        if (headerRow === -1) { throw new Error('No se detectaron columnas conocidas (CODIGO, NOMBRE, PVP, etc)'); }

        const headers = rows[headerRow];
        const mapa = _detectColumnas(headers);
        if (mapa.codigo === null || mapa.nombre === null || mapa.pvp === null) {
            throw new Error('Faltan columnas críticas. Se detectaron: ' + JSON.stringify(mapa));
        }

        const productos = [];
        const rowToCodigo = {};
        for (let i = headerRow + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[mapa.codigo] || !row[mapa.nombre]) continue;
            const pvp = parseFloat(row[mapa.pvp]);
            if (isNaN(pvp)) continue;
            const codigo = String(row[mapa.codigo]).trim().substring(0, 100);
            rowToCodigo[i] = codigo;
            productos.push({
                codigo_proveedor: codigo,
                nombre: String(row[mapa.nombre]).trim().substring(0, 200),
                descripcion: mapa.descripcion !== null ? String(row[mapa.descripcion] || '').replace(/[\r\n]+/g, ' ').substring(0, 800) : null,
                categoria: mapa.categoria !== null ? String(row[mapa.categoria] || '').substring(0, 30) : null,
                costo: pvp,
                stock: mapa.stock !== null ? (parseInt(row[mapa.stock]) || 0) : 0,
                impresion_texto_original: mapa.impresion !== null ? String(row[mapa.impresion] || '').substring(0, 200) : null,
                tecnicas_codigos: mapa.impresion !== null ? _promoNormTecnicas(row[mapa.impresion]) : []
            });
        }
        if (!productos.length) throw new Error('No se encontraron filas válidas con código+nombre+PVP');

        _promoImportBuffer = { productos, rowToCodigo };

        // Render mapeo
        document.getElementById('promoImportMapeo').style.display = '';
        const detalle = Object.entries(mapa).map(([k, v]) =>
            `<div><strong>${k}:</strong> ${v !== null ? `col ${v+1} (${headers[v]})` : '<span style="color:var(--gray-400);">no detectada</span>'}</div>`
        ).join('');
        document.getElementById('promoImportMapeoDetalle').innerHTML = detalle;

        // Preview primeras 5 filas
        document.getElementById('promoImportPreview').style.display = '';
        document.getElementById('promoImportPreviewBody').innerHTML = productos.slice(0, 5).map(p => `<tr>
            <td style="font-family:monospace;">${escapeHtml(p.codigo_proveedor)}</td>
            <td>${escapeHtml(p.nombre)}</td>
            <td>$${p.costo.toFixed(2)}</td>
            <td>${p.stock}</td>
            <td style="font-size:0.7rem;color:#0369a1;">${escapeHtml(p.tecnicas_codigos.join(', ') || '—')}</td>
        </tr>`).join('');

        const tecStats = { uv:0, serigrafia:0, laser:0, sublimacion:0, transfer:0, sin:0 };
        productos.forEach(p => {
            if (!p.tecnicas_codigos.length) tecStats.sin++;
            p.tecnicas_codigos.forEach(t => { if (tecStats[t] !== undefined) tecStats[t]++; });
        });
        const statsStr = Object.entries(tecStats).filter(([,v]) => v > 0).map(([k,v]) => `${k}: ${v}`).join(' · ');
        document.getElementById('promoImportStats').innerHTML = `<strong>${productos.length}</strong> productos listos para importar. Técnicas detectadas: ${statsStr}`;

        // Habilitar botón solo si también hay proveedor
        _promoImportUpdateBtn();
    } catch (e) {
        errorEl.style.display = '';
        errorEl.textContent = '⚠️ ' + e.message;
        document.getElementById('promoImportBtnConfirm').disabled = true;
    }
}

function _promoImportUpdateBtn() {
    const proveedorOk = !!document.getElementById('promoImportProveedor').value;
    const datosOk = _promoImportBuffer && _promoImportBuffer.productos.length > 0;
    document.getElementById('promoImportBtnConfirm').disabled = !(proveedorOk && datosOk);
}

// Extraer imagenes embebidas del xlsx y subirlas a Storage. Devuelve {codigo: url}
async function _promoExtraerImagenes(file, rowToCodigo, proveedorId) {
    if (typeof JSZip === 'undefined') return {};
    try {
        const zip = await JSZip.loadAsync(file);
        const drawingEntry = zip.file('xl/drawings/drawing1.xml');
        const relsEntry = zip.file('xl/drawings/_rels/drawing1.xml.rels');
        if (!drawingEntry || !relsEntry) return {};
        const drawing = await drawingEntry.async('string');
        const rels = await relsEntry.async('string');

        // Parsear rels: rId -> path
        const relMap = {};
        const relRe = /<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g;
        let m;
        while ((m = relRe.exec(rels)) !== null) {
            relMap[m[1]] = m[2].replace('../', 'xl/');
        }

        // Parsear anchors (twoCell y oneCell)
        const anchors = [];
        const anchorRe = /<xdr:(twoCellAnchor|oneCellAnchor)>[\s\S]*?<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<a:blip[^>]+r:embed="([^"]+)"/g;
        while ((m = anchorRe.exec(drawing)) !== null) {
            const row = parseInt(m[2]);
            const rid = m[3];
            const path = relMap[rid];
            if (path && rowToCodigo[row]) {
                anchors.push({ row, codigo: rowToCodigo[row], path });
            }
        }

        if (!anchors.length) return {};

        // Deduplicar por codigo (primera imagen gana)
        const seen = new Set();
        const queue = [];
        for (const a of anchors) {
            if (seen.has(a.codigo)) continue;
            seen.add(a.codigo);
            queue.push(a);
        }

        const prog = document.getElementById('promoImportProgreso');
        prog.innerHTML = `🖼️ Subiendo imágenes... 0 / ${queue.length}`;

        const mapping = {};
        const subfolder = (promoProveedoresCache.find(p => p.id === proveedorId)?.nombre || 'proveedor')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Subida concurrente con limite
        const CONC = 8;
        let done = 0;
        async function upload(item) {
            try {
                const entry = zip.file(item.path);
                if (!entry) return null;
                const blob = await entry.async('blob');
                const ext = item.path.split('.').pop().toLowerCase();
                const contentType = (ext === 'png') ? 'image/png' : 'image/jpeg';
                const safeCod = item.codigo.replace(/[\/\s]/g, '_');
                const dest = `${subfolder}/${safeCod}.${ext}`;
                const { error } = await db.storage.from('promocional-imagenes')
                    .upload(dest, blob, { contentType, upsert: true });
                if (!error) {
                    const { data: pub } = db.storage.from('promocional-imagenes').getPublicUrl(dest);
                    mapping[item.codigo] = pub.publicUrl;
                }
            } catch (e) { /* silencioso, seguimos con la siguiente */ }
            done++;
            if (done % 20 === 0 || done === queue.length) {
                prog.innerHTML = `🖼️ Subiendo imágenes... ${done} / ${queue.length}`;
            }
        }

        const workers = Array.from({ length: CONC }, async () => {
            while (queue.length) {
                const item = queue.shift();
                if (item) await upload(item);
            }
        });
        await Promise.all(workers);

        return mapping;
    } catch (e) {
        console.warn('Error extrayendo imagenes:', e);
        return {};
    }
}

async function promoImportEjecutar() {
    const proveedorId = +document.getElementById('promoImportProveedor').value;
    if (!proveedorId || !_promoImportBuffer) return;
    const btn = document.getElementById('promoImportBtnConfirm');
    btn.disabled = true;
    btn.textContent = 'Importando...';
    const prog = document.getElementById('promoImportProgreso');
    prog.style.display = '';
    const errEl = document.getElementById('promoImportError');
    errEl.style.display = 'none';

    const productos = _promoImportBuffer.productos.map(p => ({ ...p, proveedor_id: proveedorId }));
    const BATCH = 200;
    let insertados = 0;
    try {
        // 1. Upsert productos
        for (let i = 0; i < productos.length; i += BATCH) {
            const batch = productos.slice(i, i + BATCH);
            const { error } = await db.rpc('promocionales_bulk_insert', { data: batch });
            if (error) throw error;
            insertados += batch.length;
            prog.innerHTML = `⏳ Procesando productos... ${insertados} / ${productos.length}`;
        }

        // 2. Extraer y subir imagenes
        const file = document.getElementById('promoImportArchivo').files[0];
        const rowToCodigo = _promoImportBuffer.rowToCodigo || {};
        let imgsMsg = '';
        if (file && Object.keys(rowToCodigo).length) {
            const urls = await _promoExtraerImagenes(file, rowToCodigo, proveedorId);
            const cantUrls = Object.keys(urls).length;
            if (cantUrls > 0) {
                prog.innerHTML = `🔗 Vinculando ${cantUrls} imágenes a productos...`;
                await db.rpc('promocionales_update_imagenes', { proveedor_id_in: proveedorId, urls });
                imgsMsg = ` + ${cantUrls} imágenes vinculadas`;
            }
        }

        prog.innerHTML = `✅ Importación completa. ${insertados} productos${imgsMsg}.`;
        btn.textContent = 'Listo';
        setTimeout(() => {
            promoImportCerrar();
            btn.textContent = 'Importar';
            btn.disabled = false;
            promoProductosCache = [];
            promoProductosAdminLoad();
        }, 2500);
    } catch (e) {
        errEl.style.display = '';
        errEl.textContent = '⚠️ Error: ' + (e.message || e);
        btn.disabled = false;
        btn.textContent = 'Importar';
    }
}

// Enganchar cambio de proveedor al estado del botón
document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'promoImportProveedor') _promoImportUpdateBtn();
});

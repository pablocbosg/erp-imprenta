// =====================================================
// MODULO PROFORMAS
// Extraido de index.html — usa globales: db, currentUser, escapeHtml,
// switchTab, crearOrdenProduccion, abrirOrden, productosCache,
// kanbanCargar, appData, parametros, etc.
// =====================================================

    let proformaActiva = null; // {id, numero, cliente_id, items:[...]}
    let proformasCache = [];

    async function cargarProformas() {
        const { data, error } = await db.from('proformas')
            .select('*, clientes(nombre, empresa)')
            .order('numero', { ascending: false })
            .limit(50);
        if (error) { console.error(error); return; }
        proformasCache = data || [];
        // Batch: traer items de todas las proformas en UNA sola query (antes era N+1: 1 por proforma)
        const ids = proformasCache.map(p => p.id);
        if (ids.length) {
            const { data: items } = await db.from('proforma_items')
                .select('proforma_id, cantidad, precio_unitario')
                .in('proforma_id', ids);
            const map = {};
            (items || []).forEach(it => {
                if (!map[it.proforma_id]) map[it.proforma_id] = { count: 0, sub: 0 };
                map[it.proforma_id].count++;
                map[it.proforma_id].sub += (+it.cantidad || 0) * (+it.precio_unitario || 0);
            });
            proformasCache.forEach(p => {
                const m = map[p.id] || { count: 0, sub: 0 };
                p._itemsCount = m.count;
                p._total = round2(m.sub) + calcIVA(m.sub, +p.iva_porcentaje || 15);
            });
        }
        renderProformasList(proformasCache);
    }

    function buscarProformas() {
        const q = document.getElementById('proformaBuscar').value.toLowerCase().trim();
        if (!q) { renderProformasList(proformasCache); return; }
        const filtered = proformasCache.filter(p =>
            String(p.numero).includes(q) ||
            (p.clientes?.nombre || '').toLowerCase().includes(q) ||
            (p.clientes?.empresa || '').toLowerCase().includes(q)
        );
        renderProformasList(filtered);
    }

    function renderProformasList(proformas) {
        const body = document.getElementById('proformasListBody');
        const empty = document.getElementById('proformasEmpty');
        if (!proformas.length) { body.innerHTML = ''; empty.style.display = 'block'; return; }
        empty.style.display = 'none';
        body.innerHTML = proformas.map(p => {
            const estadoClass = 'estado-' + (p.estado || 'borrador');
            const itemsTxt = (p._itemsCount != null) ? p._itemsCount : '-';
            const totalTxt = (p._total != null) ? '$' + fmtN(p._total, 2) : '-';
            const empresaHtml = p.clientes?.empresa
                ? `<span style="color:var(--gray-400);font-size:0.8rem;">(${escapeHtml(p.clientes.empresa)})</span>`
                : '';
            return `<tr onclick="abrirProforma(${p.id})">
                <td><strong>${p.numero}</strong></td>
                <td>${escapeHtml(p.clientes?.nombre || '-')} ${empresaHtml}</td>
                <td>${new Date(p.fecha).toLocaleDateString('es-EC')}</td>
                <td>${itemsTxt}</td>
                <td>${totalTxt}</td>
                <td><span class="estado-badge ${estadoClass}">${escapeHtml(p.estado || 'borrador')}</span></td>
                <td style="font-size:0.8rem;color:var(--gray-500);">${escapeHtml(p.created_by_name || '-')}</td>
            </tr>`;
        }).join('');
    }

    async function nuevaProforma() {
        // Get next number
        const { data: maxRow } = await db.from('proformas').select('numero').order('numero', { ascending: false }).limit(1);
        const nextNum = (maxRow && maxRow.length > 0) ? maxRow[0].numero + 1 : 6001;

        const { data, error } = await db.from('proformas').insert({
            numero: nextNum,
            estado: 'borrador',
            created_by: currentUser?.id || null,
            created_by_name: currentUser?.nombre || null
        }).select().single();

        if (error) { alert('Error: ' + error.message); return; }

        await abrirProforma(data.id);
    }

    async function abrirProforma(id) {
        const { data: prof, error } = await db.from('proformas')
            .select('*, clientes(id, nombre, empresa, rfc, email, telefono, direccion)')
            .eq('id', id).single();
        if (error) { alert('Error: ' + error.message); return; }

        const [{ data: items }, { data: ordenInfo }] = await Promise.all([
            db.from('proforma_items').select('*').eq('proforma_id', id).order('orden'),
            db.from('ordenes_produccion').select('id, numero, estado').eq('proforma_id', id).maybeSingle()
        ]);

        proformaActiva = { ...prof, items: items || [], orden_vinculada: ordenInfo || null };

        // Switch to editor view
        document.getElementById('proformasLista').style.display = 'none';
        document.getElementById('proformaEditor').classList.add('active');

        // Fill header
        document.getElementById('editorProformaNum').textContent = prof.numero;
        document.getElementById('editorCreadoPor').textContent = prof.created_by_name ? 'por ' + prof.created_by_name : '';
        document.getElementById('printProformaNum').textContent = prof.numero;
        document.getElementById('printProformaFecha').textContent = new Date(prof.fecha).toLocaleDateString('es-EC', { year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('editorEstado').value = prof.estado || 'borrador';
        actualizarBotonCrearOrden();
        document.getElementById('profIVA').value = prof.iva_porcentaje || 15;
        document.getElementById('profTiempoEntrega').value = prof.tiempo_entrega || '';
        document.getElementById('profFormaPago').value = prof.forma_pago || '';

        // Fill client
        if (prof.clientes) {
            mostrarClienteProforma(prof.clientes);
        } else {
            document.getElementById('editorClienteSearch').style.display = 'block';
            document.getElementById('profClienteInfo').style.display = 'none';
        }

        // Fill items
        renderProformaItems();
        updateAddToProformaBtn();
        aplicarBloqueoProforma();
    }

    function mostrarClienteProforma(c) {
        document.getElementById('editorClienteSearch').style.display = 'none';
        document.getElementById('profClienteInfo').style.display = 'block';
        document.getElementById('profClienteNombre').textContent = c.nombre || '-';
        document.getElementById('profClienteEmpresa').textContent = c.empresa || '-';
        document.getElementById('profClienteRUC').textContent = c.rfc || '-';
        document.getElementById('profClienteEmail').textContent = c.email || '-';
        document.getElementById('profClienteTelefono').textContent = c.telefono || '-';
        document.getElementById('profClienteDireccion').textContent = c.direccion || '-';
        if (proformaActiva) {
            proformaActiva.cliente_id = c.id;
            proformaActiva.cliente_nombre = c.nombre || '';
            proformaActiva.cliente_email = c.email || '';
            proformaActiva.cliente_telefono = c.telefono || '';
        }
    }

    function cambiarClienteProforma() {
        document.getElementById('editorClienteSearch').style.display = 'block';
        document.getElementById('profClienteInfo').style.display = 'none';
        document.getElementById('profCliente').value = '';
        document.getElementById('profCliente').focus();
    }

    // Client search for proforma editor (reuse logic)
    let profClientTimer = null;
    async function searchClientsProforma(query) {
        const q = query.trim();
        if (q.length < 1) { document.getElementById('profClientDropdown').classList.remove('open'); return; }
        clearTimeout(profClientTimer);
        profClientTimer = setTimeout(async () => {
            const { data } = await db.from('clientes')
                .select('*')
                .or(`nombre.ilike.%${q}%,empresa.ilike.%${q}%,rfc.ilike.%${q}%`)
                .order('nombre').limit(8);
            const dropdown = document.getElementById('profClientDropdown');
            let html = '';
            (data || []).forEach(c => {
                const detail = [c.empresa, c.rfc, c.telefono].filter(Boolean).join(' | ');
                html += `<div class="client-option" onmousedown="seleccionarClienteProforma(${c.id})">
                    <div class="client-name">${escapeHtml(c.nombre)}</div>
                    ${detail ? `<div class="client-detail">${escapeHtml(detail)}</div>` : ''}
                </div>`;
            });
            html += `<div class="client-option new-client" onmousedown="openNewClientModal()">+ Crear nuevo cliente</div>`;
            dropdown.innerHTML = html;
            dropdown.classList.add('open');
        }, 200);
    }

    async function seleccionarClienteProforma(clienteId) {
        const { data } = await db.from('clientes').select('*').eq('id', clienteId).single();
        if (data) mostrarClienteProforma(data);
        document.getElementById('profClientDropdown').classList.remove('open');
    }

    function renderProformaItems() {
        const items = proformaActiva?.items || [];
        const body = document.getElementById('proformaItemsBody');
        const empty = document.getElementById('proformaItemsEmpty');
        if (!items.length) { body.innerHTML = ''; empty.style.display = 'block'; recalcTotalesProforma(); return; }
        empty.style.display = 'none';
        body.innerHTML = items.map((item, i) => {
            const importe = (item.cantidad || 0) * (item.precio_unitario || 0);
            return `<tr>
                <td style="text-align:center;color:var(--gray-400);">${i + 1}</td>
                <td><input type="text" placeholder="COD" value="${escapeHtml(item.codigo || '')}" onchange="updateProformaItem(${i},'codigo',this.value)" style="width:80px;font-size:0.8rem;"></td>
                <td><textarea onchange="updateProformaItem(${i},'descripcion',this.value)">${escapeHtml(item.descripcion || '')}</textarea></td>
                <td><input type="number" min="0" value="${item.cantidad || 0}" onchange="updateProformaItem(${i},'cantidad',parseFloat(this.value)||0)"></td>
                <td><input type="number" min="0" step="0.001" value="${(item.precio_unitario || 0).toFixed(3)}" onchange="updateProformaItem(${i},'precio_unitario',parseFloat(this.value)||0)"></td>
                <td style="text-align:right;font-weight:600;">$${fmtN(importe, 2)}</td>
                <!-- metodo_impresion se asigna automaticamente -->
                <td>${item.imagen_url
                    ? `<img src="${item.imagen_url}" class="item-img" loading="lazy" decoding="async" onclick="cambiarImagenItem(${i})" title="Click para cambiar">`
                    : `<div class="item-img-placeholder" onclick="cambiarImagenItem(${i})" title="Subir imagen">+</div>`
                }</td>
                <td class="no-print"><button class="btn btn-danger btn-sm" onclick="eliminarItemProforma(${i})" title="Eliminar">×</button></td>
            </tr>`;
        }).join('');
        recalcTotalesProforma();
    }

    function updateProformaItem(index, field, value) {
        if (!proformaActiva) return;
        proformaActiva.items[index][field] = value;
        if (field === 'cantidad' || field === 'precio_unitario') {
            renderProformaItems();
        }
    }

    function recalcTotalesProforma() {
        const items = proformaActiva?.items || [];
        let subtotal0 = 0, subtotal15 = 0;

        items.forEach(it => {
            const importe = (it.cantidad || 0) * (it.precio_unitario || 0);
            const itemIva = it.iva_pct !== undefined ? it.iva_pct : 15;
            if (itemIva === 0) subtotal0 += importe;
            else subtotal15 += importe;
        });

        const subtotal = round2(subtotal0 + subtotal15);
        const ivaMonto = calcIVA(subtotal15, 15);
        const total = subtotal + ivaMonto;

        document.getElementById('profSubtotal0Row').style.display = subtotal0 > 0 ? 'flex' : 'none';
        document.getElementById('profSubtotal15Row').style.display = subtotal15 > 0 ? 'flex' : 'none';

        document.getElementById('profSubtotal0').textContent = fmtN(subtotal0, 2);
        document.getElementById('profSubtotal15').textContent = fmtN(subtotal15, 2);
        document.getElementById('profSubtotal').textContent = fmtN(subtotal, 2);
        document.getElementById('profIVALabel').textContent = '15';
        document.getElementById('profIVAMonto').textContent = fmtN(ivaMonto, 2);
        document.getElementById('profTotal').textContent = fmtN(total, 2);
    }

    function _proformaBloqueada() {
        return proformaActiva && proformaActiva.orden_vinculada && !proformaActiva._unlock_override;
    }

    function agregarItemDesdeEditor() {
        if (!proformaActiva) return;
        if (_proformaBloqueada()) { alert('Proforma bloqueada por orden #' + proformaActiva.orden_vinculada.numero); return; }
        proformaActiva.items.push({
            orden: proformaActiva.items.length + 1,
            codigo: '',
            descripcion: '',
            cantidad: 1,
            precio_unitario: 0,
            imagen_url: null,
            datos_cotizacion: null
        });
        renderProformaItems();
    }

    function eliminarItemProforma(index) {
        if (!proformaActiva) return;
        if (_proformaBloqueada()) { alert('Proforma bloqueada por orden #' + proformaActiva.orden_vinculada.numero); return; }
        proformaActiva.items.splice(index, 1);
        proformaActiva.items.forEach((it, i) => it.orden = i + 1);
        renderProformaItems();
    }

    // Image upload for items
    function cambiarImagenItem(index) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const ext = file.name.split('.').pop();
            const fileName = `proforma_${proformaActiva.numero}_item${index}_${Date.now()}.${ext}`;
            const { data, error } = await db.storage.from('imagenes-referencia').upload(fileName, file, { upsert: true });
            if (error) { alert('Error subiendo imagen: ' + error.message); return; }
            const { data: urlData } = db.storage.from('imagenes-referencia').getPublicUrl(fileName);
            proformaActiva.items[index].imagen_url = urlData.publicUrl;
            renderProformaItems();
        };
        input.click();
    }

    // Navigate to cotizador to add item
    function irACotizadorParaItem() {
        if (!proformaActiva) return;
        // Switch to cotizador tab
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById('tab-cotizador').classList.add('active');
        document.querySelectorAll('.tab-btn').forEach(b => { if (b.textContent.toLowerCase().includes('cotizador')) b.classList.add('active'); });
        updateAddToProformaBtn();
        cotCalc();
    }

    function updateAddToProformaBtn() {
        const hasActive = !!proformaActiva;
        document.querySelectorAll('.btn-add-proforma').forEach(btn => {
            if (hasActive) btn.classList.add('visible');
            else btn.classList.remove('visible');
        });
        // Mostrar/ocultar boton "Crear Proforma" (inverso al de agregar)
        ['btnCrearProformaOff', 'btnCrearProformaDig'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = hasActive ? 'none' : 'block';
        });
        if (hasActive) {
            document.querySelectorAll('.proforma-activa-num').forEach(el => {
                el.textContent = proformaActiva.numero;
            });
        }
    }

    function _captureSnapshot(metodo) {
        if (metodo === 'offset') {
            const matIdx = document.getElementById('cotMaterial')?.value;
            const matObj = matIdx !== '' ? appData.materiales[+matIdx] : null;
            return {
                tipo: 'offset',
                producto: { w: document.getElementById('cotProdW').value, h: document.getElementById('cotProdH').value },
                sangrado: document.getElementById('cotSangrado').value,
                lados: document.getElementById('cotLados').value,
                margenMaq: document.getElementById('cotMargenMaquina').value,
                placasTR: document.getElementById('cotPlacasTR')?.value || 'diferente',
                material: matIdx, material_nombre: matObj ? matObj.nombre : '', material_gramaje: matObj ? matObj.gramaje : '',
                pliego: { w: document.getElementById('cotPliegoW').value, h: document.getElementById('cotPliegoH').value, precio: document.getElementById('cotPrecioPliego').value },
                hoja: { w: document.getElementById('cotHojaW').value, h: document.getElementById('cotHojaH').value },
                colores: document.getElementById('cotColores').value,
                margen: document.getElementById('cotMargen').value, iva: document.getElementById('cotIVA').value,
                fmtPorPliego: +(document.getElementById('cotResFmtPliego')?.textContent || 0),
                piezasPorHoja: +(document.getElementById('cotResPiezasHoja')?.textContent || 0),
                hojasNetas: +(document.getElementById('cotResHojasNetas')?.textContent || 0),
                mermaTotal: +(document.getElementById('cotResMermaInfo')?.textContent || 0),
                hojasTotales: +(document.getElementById('cotResHojasTotales')?.textContent || 0),
                pliegosNec: +(document.getElementById('cotResPliegosNec')?.textContent || 0),
                terminados: _describirTerminadosCot(),
                terminadosDetalle: {
                    plastificado: document.getElementById('cotPlastificadoInfo')?.style.display !== 'none' ? document.getElementById('cotPlastificadoInfo')?.textContent : null,
                    barnizUV: document.getElementById('cotBarnizUVInfo')?.style.display !== 'none' ? document.getElementById('cotBarnizUVInfo')?.textContent : null,
                    uvSelectivo: document.getElementById('cotUVSelectivoInfo')?.style.display !== 'none' ? document.getElementById('cotUVSelectivoInfo')?.textContent : null,
                    guillotina: document.getElementById('cotGuillotinaInfo')?.style.display !== 'none' ? document.getElementById('cotGuillotinaInfo')?.textContent : null,
                    ensanduchado: document.getElementById('cotEnsanduchado')?.checked || false,
                    troquelado: document.getElementById('cotTroqueladoInfo')?.style.display !== 'none' ? document.getElementById('cotTroqueladoInfo')?.textContent : null
                },
                costoMaterial: document.getElementById('cotCostoMaterialVal')?.textContent,
                costoPlacas: document.getElementById('cotCostoPlacasVal')?.textContent,
                costoImpresion: document.getElementById('cotCostoImpresionVal')?.textContent,
                costoTotal: document.getElementById('cotSubtotalCosto')?.textContent,
                precioFinal: document.getElementById('cotPrecioFinal')?.textContent
            };
        } else {
            const digMatIdx = document.getElementById('digMaterial')?.value;
            const digMatObj = digMatIdx !== '' ? appData.materiales[+digMatIdx] : null;
            return {
                tipo: 'digital',
                producto: { w: document.getElementById('digProdW').value, h: document.getElementById('digProdH').value },
                sangrado: document.getElementById('digSangrado').value,
                lados: document.getElementById('digLados').value,
                maquina: document.getElementById('digMaquina').value,
                formato: document.getElementById('digFormato').value,
                material: digMatIdx, material_nombre: digMatObj ? digMatObj.nombre : '', material_gramaje: digMatObj ? digMatObj.gramaje : '',
                pliego: { w: document.getElementById('digPliegoW')?.value, h: document.getElementById('digPliegoH')?.value, precio: document.getElementById('digPrecioPliego')?.value },
                hoja: { w: document.getElementById('digHojaW')?.value, h: document.getElementById('digHojaH')?.value },
                cantidad: parseFloat(document.getElementById('digCantidad').value) || 0,
                margen: document.getElementById('digMargen').value, iva: document.getElementById('digIVA').value,
                fmtPorPliego: +(document.getElementById('digResFmtPliego')?.textContent || 0),
                piezasPorHoja: +(document.getElementById('digResPiezasHoja')?.textContent || 0),
                hojasNetas: +(document.getElementById('digResHojasNetas')?.textContent || 0),
                mermaTotal: +(document.getElementById('digResHojasTotales')?.textContent || 0) - +(document.getElementById('digResHojasNetas')?.textContent || 0),
                hojasTotales: +(document.getElementById('digResHojasTotales')?.textContent || 0),
                pliegosNec: +(document.getElementById('digResPliegosNec')?.textContent || 0),
                terminados: _describirTerminadosDig(),
                terminadosDetalle: {
                    plastificado: document.getElementById('digPlastificadoInfo')?.style.display !== 'none' ? document.getElementById('digPlastificadoInfo')?.textContent : null,
                    barnizUV: document.getElementById('digBarnizUVInfo')?.style.display !== 'none' ? document.getElementById('digBarnizUVInfo')?.textContent : null,
                    uvSelectivo: document.getElementById('digUVSelectivoInfo')?.style.display !== 'none' ? document.getElementById('digUVSelectivoInfo')?.textContent : null,
                    guillotina: document.getElementById('digGuillotinaInfo')?.style.display !== 'none' ? document.getElementById('digGuillotinaInfo')?.textContent : null,
                    troquelPlotter: document.getElementById('digTroquelPlotterInfo')?.style.display !== 'none' ? document.getElementById('digTroquelPlotterInfo')?.textContent : null
                },
                costoTotal: document.getElementById('digSubtotalCosto')?.textContent,
                precioFinal: document.getElementById('digPrecioFinal')?.textContent
            };
        }
    }

    async function crearProformaDesdeCalc(metodo) {
        // Capturar datos ANTES de cualquier await (sincrono, instantaneo)
        let userText, descripcion, cantidad, precioUnit, itemIvaPct, snapshot;
        if (metodo === 'gigantografia') {
            const d = _gigaCapturarDatosItem();
            if (!d) return;
            userText = d.userText; descripcion = d.descripcion; cantidad = d.cantidad;
            precioUnit = d.precioUnit; itemIvaPct = d.itemIvaPct; snapshot = d.snapshot;
        } else if (metodo === 'promocional') {
            const d = _promoCapturarDatosItem();
            if (!d) return;
            userText = d.userText; descripcion = d.descripcion; cantidad = d.cantidad;
            precioUnit = d.precioUnit; itemIvaPct = d.itemIvaPct; snapshot = d.snapshot;
        } else {
            const pref = metodo === 'offset' ? 'cot' : 'dig';
            userText = document.getElementById(pref + 'Descripcion').value.trim();
            descripcion = buildDescripcionProforma(userText, pref);
            cantidad = parseFloat(document.getElementById(pref + 'Cantidad').value) || 0;
            precioUnit = parseFloat((document.getElementById(pref + 'PrecioUnit')?.textContent || '0').replace(',', '.')) || 0;
            itemIvaPct = parseFloat(document.getElementById(pref + 'IVA').value) || 0;
            snapshot = _captureSnapshot(metodo);
        }

        // 1 query: crear proforma + obtener numero en paralelo
        const [{ data: maxRow }, _] = await Promise.all([
            db.from('proformas').select('numero').order('numero', { ascending: false }).limit(1),
        ]);
        const nextNum = (maxRow && maxRow.length > 0) ? maxRow[0].numero + 1 : 6001;

        // 2 query: insertar proforma
        const { data: prof, error } = await db.from('proformas').insert({
            numero: nextNum, estado: 'borrador', created_by: currentUser?.id || null
        }).select().single();
        if (error) { alert('Error: ' + error.message); return; }

        // 3 query: insertar item
        await db.from('proforma_items').insert({
            proforma_id: prof.id, orden: 1, descripcion, cantidad,
            precio_unitario: precioUnit, metodo_impresion: metodo, datos_cotizacion: snapshot
        });

        // Abrir proforma sin re-leer de DB (ya tenemos los datos)
        proformaActiva = {
            ...prof, items: [{ orden: 1, descripcion, cantidad, precio_unitario: precioUnit,
                iva_pct: itemIvaPct, metodo_impresion: metodo, datos_cotizacion: snapshot, imagen_url: null }]
        };
        switchTab('proformas');
        document.getElementById('proformasLista').style.display = 'none';
        document.getElementById('proformaEditor').classList.add('active');
        document.getElementById('editorProformaNum').textContent = prof.numero;
        document.getElementById('editorCreadoPor').textContent = currentUser?.nombre ? 'por ' + currentUser.nombre : '';
        document.getElementById('printProformaNum').textContent = prof.numero;
        document.getElementById('printProformaFecha').textContent = new Date(prof.fecha).toLocaleDateString('es-EC', { year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('editorEstado').value = 'borrador';
        actualizarBotonCrearOrden();
        document.getElementById('profIVA').value = 15;
        document.getElementById('profTiempoEntrega').value = '';
        document.getElementById('profFormaPago').value = '';
        document.getElementById('profClienteNombre').textContent = '';
        document.getElementById('profClienteEmpresa').textContent = '';
        document.getElementById('profClienteRUC').textContent = '';
        document.getElementById('profClienteEmail').textContent = '';
        document.getElementById('profClienteTelefono').textContent = '';
        document.getElementById('profClienteDireccion').textContent = '';
        updateAddToProformaBtn();
        renderProformaItems();
    }

    function addItemToProforma() {
        if (!proformaActiva) return;
        const userText = document.getElementById('cotDescripcion').value.trim();
        const descripcion = buildDescripcionProforma(userText, 'cot');
        const cantidad = parseFloat(document.getElementById('cotCantidad').value) || 0;
        const precioUnit = parseFloat((document.getElementById('cotPrecioUnit')?.textContent || '0').replace(',', '.')) || 0;
        const itemIvaPct = parseFloat(document.getElementById('cotIVA').value) || 0;

        proformaActiva.items.push({
            orden: proformaActiva.items.length + 1,
            descripcion, cantidad, precio_unitario: precioUnit,
            iva_pct: itemIvaPct, imagen_url: null,
            metodo_impresion: 'offset',
            datos_cotizacion: _captureSnapshot('offset')
        });

        switchTab('proformas');
        renderProformaItems();
    }

    // =====================================================
    // Autoexpansion de descripcion para proforma
    // =====================================================
    function _detectarFormatoA(w, h) {
        const formatos = [
            { n: 'A3', w: 29.7, h: 42 },
            { n: 'A4', w: 21, h: 29.7 },
            { n: 'A5', w: 14.8, h: 21 },
            { n: 'A6', w: 10.5, h: 14.8 },
            { n: 'A7', w: 7.4, h: 10.5 },
            { n: 'Oficio', w: 21.6, h: 33 },
            { n: 'Carta', w: 21.6, h: 27.9 },
        ];
        const tol = 0.4;
        for (const f of formatos) {
            if ((Math.abs(w - f.w) <= tol && Math.abs(h - f.h) <= tol) ||
                (Math.abs(w - f.h) <= tol && Math.abs(h - f.w) <= tol)) {
                return f.n;
            }
        }
        return null;
    }
    function _describirColores(colores, lados) {
        const c = +colores || 1;
        const l = +lados || 1;
        if (c === 4) {
            return l === 2 ? 'Full color 4/4 (tiro y retiro)' : 'Full color 4/0 (1 lado)';
        }
        if (c === 1) {
            return l === 2 ? '1 tinta (tiro y retiro)' : '1 tinta (1 lado)';
        }
        return c + ' tintas ' + (l === 2 ? c + '/' + c + ' (tiro y retiro)' : c + '/0 (1 lado)');
    }
    function _obtenerMaterial(idx) {
        if (idx === '' || idx == null) return null;
        const m = appData.materiales && appData.materiales[+idx];
        if (!m) return null;
        return m.nombre + (m.gramaje ? ' ' + m.gramaje + ' g' : '');
    }
    function _describirTerminadosCot() {
        const partes = [];
        if (document.getElementById('cotPlastificado')?.checked) {
            const tipo = document.getElementById('cotPlastificadoTipo').value === 'mate' ? 'mate' : 'brillante';
            const caras = +document.getElementById('cotPlastificadoCaras').value || 1;
            partes.push('Plastificado ' + tipo + ' ' + caras + ' cara' + (caras > 1 ? 's' : ''));
        }
        if (document.getElementById('cotBarnizUV')?.checked) {
            const caras = +document.getElementById('cotBarnizUVCaras').value || 1;
            partes.push('Barniz UV brillante ' + caras + ' cara' + (caras > 1 ? 's' : ''));
        }
        if (document.getElementById('cotUVSelectivo')?.checked) {
            const caras = +document.getElementById('cotUVSelectivoCaras').value || 1;
            partes.push('UV selectivo ' + caras + ' lado' + (caras > 1 ? 's' : ''));
        }
        if (document.getElementById('cotEnsanduchado')?.checked) partes.push('Ensanduchado (doble cartulina)');
        if (document.getElementById('cotTroquelado')?.checked) partes.push('Troquelado');
        if (document.getElementById('cotGuillotina')?.checked) partes.push('Corte en guillotina');
        return partes;
    }
    function _describirTerminadosDig() {
        const partes = [];
        if (document.getElementById('digPlastificado')?.checked) {
            const tipo = document.getElementById('digPlastificadoTipo').value === 'mate' ? 'mate' : 'brillante';
            const caras = +document.getElementById('digPlastificadoCaras').value || 1;
            partes.push('Plastificado ' + tipo + ' ' + caras + ' cara' + (caras > 1 ? 's' : ''));
        }
        if (document.getElementById('digBarnizUV')?.checked) {
            const caras = +document.getElementById('digBarnizUVCaras').value || 1;
            partes.push('Barniz UV brillante ' + caras + ' cara' + (caras > 1 ? 's' : ''));
        }
        if (document.getElementById('digUVSelectivo')?.checked) {
            const caras = +document.getElementById('digUVSelectivoCaras').value || 1;
            partes.push('UV selectivo ' + caras + ' lado' + (caras > 1 ? 's' : ''));
        }
        if (document.getElementById('digTroquelPlotter')?.checked) partes.push('Troquelado en plotter');
        if (document.getElementById('digGuillotina')?.checked) partes.push('Corte en guillotina');
        return partes;
    }
    function buildDescripcionProforma(userText, src) {
        const pref = src === 'dig' ? 'dig' : 'cot';
        const w = parseFloat(document.getElementById(pref + 'ProdW').value) || 0;
        const h = parseFloat(document.getElementById(pref + 'ProdH').value) || 0;
        const lados = document.getElementById(pref + 'Lados').value;
        const matIdx = document.getElementById(pref === 'dig' ? 'digMaterial' : 'cotMaterial').value;
        const matNombre = _obtenerMaterial(matIdx);

        // Formato
        const formatoA = _detectarFormatoA(w, h);
        const dimStr = fmtN(Math.min(w, h), 1) + 'x' + fmtN(Math.max(w, h), 1) + ' cm';
        const formato = formatoA ? (formatoA + ' ' + dimStr) : dimStr;

        // Colores / impresion
        let coloresStr;
        if (src === 'dig') {
            const maq = document.getElementById('digMaquina').value;
            if (maq === 'd95') {
                coloresStr = lados === '2' ? 'Blanco y negro (tiro y retiro)' : 'Blanco y negro (1 lado)';
            } else {
                coloresStr = lados === '2' ? 'Full color 4/4 (tiro y retiro)' : 'Full color 4/0 (1 lado)';
            }
        } else {
            const colores = document.getElementById('cotColores').value;
            coloresStr = _describirColores(colores, lados);
        }

        // Terminados
        const terminados = src === 'dig' ? _describirTerminadosDig() : _describirTerminadosCot();

        // Construir descripcion
        const partes = [formato, 'Impreso ' + coloresStr];
        if (matNombre) partes.push(matNombre);
        terminados.forEach(t => partes.push(t));

        const base = (userText || '').trim() || 'Producto';
        return base + ' - ' + partes.join(' | ');
    }

    function addItemToProformaDig() {
        if (!proformaActiva) return;
        const userText = document.getElementById('digDescripcion').value.trim();
        const descripcion = buildDescripcionProforma(userText, 'dig');
        const cantidad = parseFloat(document.getElementById('digCantidad').value) || 0;
        const precioUnit = parseFloat((document.getElementById('digPrecioUnit')?.textContent || '0').replace(',', '.')) || 0;
        const itemIvaPct = parseFloat(document.getElementById('digIVA').value) || 0;

        proformaActiva.items.push({
            orden: proformaActiva.items.length + 1,
            descripcion, cantidad, precio_unitario: precioUnit,
            iva_pct: itemIvaPct, imagen_url: null,
            metodo_impresion: 'digital',
            datos_cotizacion: _captureSnapshot('digital')
        });

        switchTab('proformas');
        renderProformaItems();
    }

    // =====================================================
    // CONTIFICO SYNC (productos + clientes + proveedores)
    // =====================================================
    const CONTIFICO_PROXY_URL = 'https://ekrdnfecegwfavdgtgsa.supabase.co/functions/v1/contifico-proxy';

    async function _contificoApiKey() {
        const { data } = await db.from('config').select('valor').eq('clave', 'contifico_api_key').maybeSingle();
        return data ? data.valor : null;
    }

    async function _contificoFetch(endpoint) {
        const apiKey = await _contificoApiKey();
        if (!apiKey) throw new Error('API Key de Contifico no configurada (tabla config)');
        const resp = await fetch(CONTIFICO_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
            body: JSON.stringify({ endpoint, apiKey })
        });
        if (!resp.ok) throw new Error('Proxy error ' + resp.status + ': ' + await resp.text());
        return await resp.json();
    }

    async function contificoAdminLoad() {
        // Mostrar estado actual
        await contificoActualizarInfo();
        await contificoCargarHistorial();
    }

    async function contificoActualizarInfo() {
        const [prodCont, cli, prov] = await Promise.all([
            db.from('productos_contifico').select('id, sync_at', {count:'exact'}).order('sync_at', {ascending:false}).limit(1),
            db.from('clientes').select('id, sync_contifico_at', {count:'exact'}).eq('es_cliente', true).order('sync_contifico_at', {ascending:false, nullsFirst:false}).limit(1),
            db.from('clientes').select('id, sync_contifico_at', {count:'exact'}).eq('es_proveedor', true).order('sync_contifico_at', {ascending:false, nullsFirst:false}).limit(1)
        ]);
        const fmtFecha = d => d ? new Date(d).toLocaleString('es-EC') : 'nunca';
        document.getElementById('contSyncProductosInfo').innerHTML = `${prodCont.count || 0} productos · Última sync: ${fmtFecha(prodCont.data?.[0]?.sync_at)}`;
        document.getElementById('contSyncClientesInfo').innerHTML = `${cli.count || 0} clientes · Última sync: ${fmtFecha(cli.data?.[0]?.sync_contifico_at)}`;
        document.getElementById('contSyncProveedoresInfo').innerHTML = `${prov.count || 0} proveedores · Última sync: ${fmtFecha(prov.data?.[0]?.sync_contifico_at)}`;
    }

    async function contificoCargarHistorial() {
        const { data } = await db.from('contifico_sync_log').select('*').order('inicio', {ascending:false}).limit(12);
        const items = data || [];
        if (!items.length) {
            document.getElementById('contSyncHistorial').innerHTML = '<div style="padding:1rem;color:var(--gray-400);text-align:center;font-size:0.85rem;">Sin sincronizaciones todavía</div>';
            return;
        }
        document.getElementById('contSyncHistorial').innerHTML = `<table class="data-table" style="font-size:0.8rem;">
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Nuevos</th><th>Actualizados</th><th>Estado</th></tr></thead>
            <tbody>${items.map(l => `<tr>
                <td>${new Date(l.inicio).toLocaleString('es-EC')}</td>
                <td style="text-transform:capitalize;">${l.tipo}</td>
                <td style="color:#15803d;font-weight:600;">${l.registros_nuevos || 0}</td>
                <td style="color:#0891b2;">${l.registros_actualizados || 0}</td>
                <td>${l.error_mensaje ? '<span style="color:#dc2626;">❌ '+l.error_mensaje.substring(0,60)+'</span>' : '<span style="color:#15803d;">✅</span>'}</td>
            </tr>`).join('')}</tbody></table>`;
    }

    async function contificoSync(tipo) {
        const estadoEl = document.getElementById('contSyncEstado');
        const setStatus = (txt, color='#0891b2') => {
            estadoEl.innerHTML = `<div style="padding:0.6rem 0.85rem;background:#ecfeff;border:1px solid #67e8f9;border-radius:6px;font-size:0.85rem;color:${color};">${txt}</div>`;
        };
        const setError = (txt) => {
            estadoEl.innerHTML = `<div style="padding:0.6rem 0.85rem;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;font-size:0.85rem;color:#991b1b;">⚠️ ${txt}</div>`;
        };
        try {
            if (tipo === 'productos') {
                setStatus('🔄 Descargando productos desde Contifico...');
                const prods = await _contificoFetch('producto/');
                console.log('Contifico producto/ respuesta:', prods);
                const arr = Array.isArray(prods) ? prods
                    : (prods?.data || prods?.results || prods?.productos || prods?.object_list || []);
                if (!arr.length) {
                    setStatus('⚠️ Contifico devolvió listado vacío. Usando fallback por facturas...', '#b45309');
                    const result = await contificoSyncProductosViaDocumentos(setStatus);
                    await db.rpc('contifico_log_sync', { p_tipo: 'productos', p_nuevos: result.nuevos, p_actualizados: result.actualizados });
                    setStatus(`✅ Fallback OK: ${result.nuevos} nuevos, ${result.actualizados} actualizados (${result.totalIds} únicos de ${result.totalDocs} facturas). Si faltan productos, contactá a Contifico para habilitar GET /producto/.`, '#15803d');
                } else {
                    setStatus(`⏳ Procesando ${arr.length} productos...`);
                    let nuevos = 0, actualizados = 0;
                    for (let i = 0; i < arr.length; i += 200) {
                        const { data, error } = await db.rpc('contifico_upsert_productos', { productos: arr.slice(i, i+200) });
                        if (error) throw error;
                        nuevos += data?.nuevos || 0;
                        actualizados += data?.actualizados || 0;
                        setStatus(`⏳ ${Math.min(i+200, arr.length)} / ${arr.length} productos...`);
                    }
                    await db.rpc('contifico_log_sync', { p_tipo: 'productos', p_nuevos: nuevos, p_actualizados: actualizados });
                    setStatus(`✅ Productos sincronizados: ${nuevos} nuevos, ${actualizados} actualizados`, '#15803d');
                }
            } else if (tipo === 'clientes' || tipo === 'proveedores') {
                setStatus(`🔄 Descargando ${tipo} desde Contifico...`);
                const filtro = tipo === 'clientes' ? 'persona/?tipo=N,J&es_cliente=true' : 'persona/?tipo=N,J&es_proveedor=true';
                // Contifico API v1 acepta filtros en query string.
                const personas = await _contificoFetch(filtro);
                const arr = Array.isArray(personas) ? personas : (personas.results || []);
                setStatus(`⏳ Procesando ${arr.length} ${tipo}...`);
                let nuevos = 0, actualizados = 0;
                for (let i = 0; i < arr.length; i += 200) {
                    const { data, error } = await db.rpc('contifico_upsert_personas', { personas: arr.slice(i, i+200) });
                    if (error) throw error;
                    nuevos += data?.nuevos || 0;
                    actualizados += data?.actualizados || 0;
                    setStatus(`⏳ ${Math.min(i+200, arr.length)} / ${arr.length} ${tipo}...`);
                }
                await db.rpc('contifico_log_sync', { p_tipo: tipo, p_nuevos: nuevos, p_actualizados: actualizados });
                setStatus(`✅ ${tipo}: ${nuevos} nuevos, ${actualizados} actualizados`, '#15803d');
            } else {
                setError('Tipo desconocido: ' + tipo);
                return;
            }
            await contificoActualizarInfo();
            await contificoCargarHistorial();
        } catch (e) {
            setError(e.message || e);
            await db.rpc('contifico_log_sync', { p_tipo: tipo, p_nuevos: 0, p_actualizados: 0, p_error: (e.message || String(e)).substring(0, 300) });
            contificoCargarHistorial();
        }
    }

    async function contificoSyncTodo() {
        if (!confirm('Se sincronizarán productos, clientes y proveedores de Contifico. Puede tardar 1-2 minutos. ¿Continuar?')) return;
        await contificoSync('productos');
        await contificoSync('clientes');
        await contificoSync('proveedores');
    }

    // Fallback: si GET /producto/ devuelve [], extraemos product_ids de facturas
    // recientes y hacemos GET /producto/{id}/ individual (el endpoint individual sí funciona).
    async function contificoSyncProductosViaDocumentos(setStatus) {
        const hoy = new Date();
        const desde = new Date(hoy.getTime() - 730 * 24 * 60 * 60 * 1000); // 2 años
        const fmt = d => String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
        const rangos = [
            { fi: fmt(desde), ff: fmt(hoy), tipo: 'FAC' },
            { fi: fmt(desde), ff: fmt(hoy), tipo: 'PRF' }
        ];
        const idsSet = new Map();
        let totalDocs = 0;
        for (const r of rangos) {
            setStatus(`🔄 Listando documentos ${r.tipo} (${r.fi} → ${r.ff})...`, '#b45309');
            const docs = await _contificoFetch(`documento/?tipo=${r.tipo}&fecha_inicial=${r.fi}&fecha_final=${r.ff}`);
            const arr = Array.isArray(docs) ? docs : (docs?.results || []);
            totalDocs += arr.length;
            for (const d of arr) {
                for (const det of (d.detalles || [])) {
                    if (det.producto_id && !idsSet.has(det.producto_id)) {
                        idsSet.set(det.producto_id, det.producto_nombre || '');
                    }
                }
            }
        }
        const ids = Array.from(idsSet.keys());
        if (!ids.length) {
            throw new Error('No se encontraron productos en los últimos 2 años de facturas/proformas');
        }
        setStatus(`⏳ Descargando ${ids.length} productos únicos (vía GET individual)...`, '#b45309');

        // GETs individuales en paralelo, de 8 en 8
        const productosCompletos = [];
        const CONCURRENCIA = 8;
        let procesados = 0;
        for (let i = 0; i < ids.length; i += CONCURRENCIA) {
            const chunk = ids.slice(i, i + CONCURRENCIA);
            const resultados = await Promise.all(chunk.map(async id => {
                try {
                    const p = await _contificoFetch(`producto/${id}/`);
                    return p && p.id ? p : null;
                } catch (e) { return null; }
            }));
            for (const p of resultados) if (p) productosCompletos.push(p);
            procesados += chunk.length;
            setStatus(`⏳ ${procesados} / ${ids.length} productos descargados...`, '#b45309');
        }

        let nuevos = 0, actualizados = 0;
        for (let i = 0; i < productosCompletos.length; i += 200) {
            const { data, error } = await db.rpc('contifico_upsert_productos', { productos: productosCompletos.slice(i, i+200) });
            if (error) throw error;
            nuevos += data?.nuevos || 0;
            actualizados += data?.actualizados || 0;
            setStatus(`⏳ Upsert ${Math.min(i+200, productosCompletos.length)} / ${productosCompletos.length}...`, '#b45309');
        }
        return { nuevos, actualizados, totalIds: ids.length, totalDocs };
    }

    // =====================================================
    // HISTORIAL DE CONSUMOS
    // =====================================================
    function cerrarConsumosModal() { document.getElementById('consumosModal').style.display = 'none'; }

    async function verConsumosRollo(rolloId) {
        const { data: rollo } = await db.from('gigantografia_rollos')
            .select('*, materiales_gigantografia(nombre)').eq('id', rolloId).maybeSingle();
        const { data: consumos } = await db.from('gigantografia_consumos')
            .select('*, ordenes_produccion(numero)')
            .eq('rollo_id', rolloId).order('created_at', { ascending: false }).limit(100);
        document.getElementById('consumosModalTitulo').textContent =
            `Historial · ${rollo?.materiales_gigantografia?.nombre || '—'} ${+rollo?.ancho_cm || ''} cm`;
        const total = (consumos || []).reduce((s, c) => s + (+c.m2_consumidos || 0), 0);
        let html = `<div style="background:#f8fafc;padding:0.75rem;border-radius:6px;margin-bottom:0.75rem;font-size:0.85rem;">
            <strong>Stock:</strong> ${(+rollo?.m2_restantes || 0).toFixed(1)} m² restantes de ${(+rollo?.m2_iniciales || 0).toFixed(1)} m² iniciales ·
            <strong>Total consumido histórico:</strong> ${total.toFixed(1)} m²
        </div>`;
        if (!consumos?.length) {
            html += '<div style="padding:1rem;text-align:center;color:var(--gray-400);">Sin consumos registrados todavía</div>';
        } else {
            html += `<table class="data-table"><thead><tr><th>Fecha</th><th>Orden</th><th>m lineales</th><th>m² consumidos</th><th>m² desperdicio</th></tr></thead><tbody>`;
            html += consumos.map(c => `<tr>
                <td style="font-size:0.8rem;">${new Date(c.created_at).toLocaleString('es-EC')}</td>
                <td>${c.ordenes_produccion?.numero ? '#'+c.ordenes_produccion.numero : '—'}</td>
                <td>${(+c.metros_lineales || 0).toFixed(2)}</td>
                <td style="font-weight:600;">${(+c.m2_consumidos || 0).toFixed(2)}</td>
                <td style="color:#b45309;">${(+c.m2_desperdicio || 0).toFixed(2)}</td>
            </tr>`).join('');
            html += '</tbody></table>';
        }
        document.getElementById('consumosModalBody').innerHTML = html;
        document.getElementById('consumosModal').style.display = 'flex';
    }

    async function verConsumosProducto(productoId) {
        const { data: prod } = await db.from('promocionales_productos').select('*').eq('id', productoId).maybeSingle();
        const { data: consumos } = await db.from('promocionales_consumos')
            .select('*, ordenes_produccion(numero)')
            .eq('producto_id', productoId).order('created_at', { ascending: false }).limit(100);
        document.getElementById('consumosModalTitulo').textContent =
            `Historial · ${prod?.nombre || ''} (${prod?.codigo_proveedor || ''})`;
        const total = (consumos || []).reduce((s, c) => s + (+c.cantidad || 0), 0);
        let html = `<div style="background:#f8fafc;padding:0.75rem;border-radius:6px;margin-bottom:0.75rem;font-size:0.85rem;">
            <strong>Stock actual:</strong> ${+prod?.stock || 0} unidades ·
            <strong>Total consumido histórico:</strong> ${total} unidades
        </div>`;
        if (!consumos?.length) {
            html += '<div style="padding:1rem;text-align:center;color:var(--gray-400);">Sin consumos registrados todavía</div>';
        } else {
            html += `<table class="data-table"><thead><tr><th>Fecha</th><th>Orden</th><th>Cantidad</th><th>Stock antes</th><th>Stock después</th></tr></thead><tbody>`;
            html += consumos.map(c => `<tr>
                <td style="font-size:0.8rem;">${new Date(c.created_at).toLocaleString('es-EC')}</td>
                <td>${c.ordenes_produccion?.numero ? '#'+c.ordenes_produccion.numero : '—'}</td>
                <td style="font-weight:600;">${c.cantidad}</td>
                <td>${c.stock_antes ?? '—'}</td>
                <td>${c.stock_despues ?? '—'}</td>
            </tr>`).join('');
            html += '</tbody></table>';
        }
        document.getElementById('consumosModalBody').innerHTML = html;
        document.getElementById('consumosModal').style.display = 'flex';
    }

    // RELOJ extraido a reloj.js — script cargado al final del body
    // =====================================================
    // DASHBOARD (tab Inicio)
    // =====================================================
    async function dashLoad() {
        const now = new Date();
        const saludo = now.getHours() < 12 ? 'Buen día' : now.getHours() < 19 ? 'Buenas tardes' : 'Buenas noches';
        const nombre = currentUser?.nombre || currentUser?.email?.split('@')[0] || '';
        document.getElementById('dashSaludo').textContent = `${saludo}${nombre ? ', ' + nombre : ''}`;
        document.getElementById('dashFechaHoy').textContent = now.toLocaleDateString('es-EC', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

        await Promise.all([
            dashCargarStats(),
            dashCargarMisTareas(),
            dashCargarAlertas(),
            dashCargarProformasPendientes(),
            dashCargarOrdenesActivas(),
            dashCargarReportes()
        ]);
    }

    async function dashCargarStats() {
        const now = new Date();
        const ini = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const iniMesPrev = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString();
        const finMesPrev = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        // Ventas del mes (sum de totales de proformas aprobadas)
        const [{data: profMes}, {data: profPrev}, {data: ordenesAct}, {data: trabsAct}] = await Promise.all([
            db.from('proformas').select('id, numero, estado, fecha, iva_porcentaje, proforma_items(cantidad, precio_unitario)').gte('fecha', ini).eq('estado', 'aprobada'),
            db.from('proformas').select('id, proforma_items(cantidad, precio_unitario)').gte('fecha', iniMesPrev).lt('fecha', finMesPrev).eq('estado', 'aprobada'),
            db.from('ordenes_produccion').select('id', {count:'exact', head:true}).not('estado', 'in', '(finalizada,entregada,cancelada)'),
            db.from('trabajos').select('id', {count:'exact', head:true}).not('estado', 'in', '(completado,perdido)')
        ]);

        const sumarTotal = (profs) => (profs || []).reduce((s, p) => {
            const items = p.proforma_items || [];
            const subtotal = items.reduce((a, it) => a + (+it.cantidad || 0) * (+it.precio_unitario || 0), 0);
            return s + subtotal; // sin IVA para mayor estabilidad comparativa
        }, 0);

        const ventasMes = sumarTotal(profMes);
        const ventasPrev = sumarTotal(profPrev);
        document.getElementById('dashStatVentasMes').textContent = '$' + fmtN(ventasMes, 2);
        const cantMes = (profMes || []).length;
        document.getElementById('dashStatVentasMesSub').textContent = `${cantMes} proformas aprobadas`;

        // Proformas del mes (todas)
        const { count: profMesCount } = await db.from('proformas').select('id', {count:'exact', head:true}).gte('fecha', ini);
        document.getElementById('dashStatProformasMes').textContent = profMesCount || 0;
        if (ventasPrev > 0) {
            const delta = ((ventasMes - ventasPrev) / ventasPrev * 100);
            const sign = delta >= 0 ? '▲' : '▼';
            const color = delta >= 0 ? '#15803d' : '#dc2626';
            document.getElementById('dashStatProformasMesSub').innerHTML = `<span style="color:${color};">${sign} ${Math.abs(delta).toFixed(1)}%</span> vs mes pasado`;
        } else {
            document.getElementById('dashStatProformasMesSub').textContent = '';
        }

        document.getElementById('dashStatOrdenesActivas').textContent = ordenesAct || 0;
        document.getElementById('dashStatTrabajosActivos').textContent = trabsAct || 0;
    }

    async function dashCargarMisTareas() {
        const cont = document.getElementById('dashMisTareasLista');
        const badge = document.getElementById('dashMisTareasContador');
        if (!currentUser?.email) {
            cont.innerHTML = '<div class="dash-empty">Iniciá sesión para ver tus tareas</div>';
            badge.textContent = '';
            return;
        }
        // Buscar staff_id por email
        const { data: staffMatch } = await db.from('staff').select('id, nombre').eq('email', currentUser.email).maybeSingle();
        const staffId = staffMatch?.id;

        // Tareas asignadas a este staff (orden_tareas.asignado_a) - pendiente / en_proceso
        // Trabajos donde encargados jsonb contiene este staff.id - no completado/perdido
        const [tareas, trabajos] = await Promise.all([
            staffId
                ? db.from('orden_tareas').select('id, paso, estado, orden_id, proforma_item_id, ordenes_produccion(numero)').eq('asignado_a', staffId).in('estado', ['pendiente','en_proceso','bloqueado']).order('orden_seq').limit(30)
                : Promise.resolve({data: []}),
            staffId
                ? db.from('trabajos').select('id, numero, titulo, estado, prioridad').contains('encargados', [staffId]).not('estado', 'in', '(completado,perdido)').order('prioridad', {ascending: false}).limit(20)
                : Promise.resolve({data: []})
        ]);

        const tareasData = tareas.data || [];
        const trabsData = trabajos.data || [];
        const total = tareasData.length + trabsData.length;
        badge.textContent = total > 0 ? `(${total})` : '';
        if (!total) {
            cont.innerHTML = `<div class="dash-empty">${staffId ? 'Sin tareas asignadas 🎉' : 'Tu email no está en el equipo. Agregalo en Admin → Equipo.'}</div>`;
            return;
        }
        let html = '';
        trabsData.forEach(t => {
            const prio = (t.prioridad === 'alta') ? '🔴' : (t.prioridad === 'media') ? '🟡' : '⚪';
            html += `<div class="dash-item" onclick="switchTab('trabajos')">
                <span style="font-size:1.1rem;">${prio}</span>
                <div style="flex:1;min-width:0;">
                    <div class="dash-item-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(t.titulo||'').replace(/</g,'&lt;') || `Trabajo #${t.numero}`}</div>
                    <div class="dash-item-sub">Trabajo #${t.numero} · ${t.estado}</div>
                </div>
            </div>`;
        });
        tareasData.forEach(t => {
            const color = t.estado === 'en_proceso' ? '#fbbf24' : t.estado === 'bloqueado' ? '#fca5a5' : '#d1d5db';
            const bg = t.estado === 'en_proceso' ? '#fef3c7' : t.estado === 'bloqueado' ? '#fee2e2' : '#f3f4f6';
            html += `<div class="dash-item" onclick="switchTab('ordenes');setTimeout(()=>abrirOrden(${t.orden_id}),400)">
                <span style="flex:0 0 auto;width:8px;height:40px;background:${color};border-radius:3px;"></span>
                <div style="flex:1;min-width:0;">
                    <div class="dash-item-title">${t.paso}</div>
                    <div class="dash-item-sub">Orden #${t.ordenes_produccion?.numero || '?'}</div>
                </div>
                <span class="dash-item-badge" style="background:${bg};color:${t.estado === 'en_proceso' ? '#92400e' : t.estado === 'bloqueado' ? '#991b1b' : '#4b5563'};">${t.estado}</span>
            </div>`;
        });
        cont.innerHTML = html;
    }

    async function dashCargarAlertas() {
        const cont = document.getElementById('dashAlertasStock');
        const [rollos, promos] = await Promise.all([
            db.from('gigantografia_rollos')
                .select('id, ancho_cm, m2_restantes, m2_iniciales, activo, inventario_activo, materiales_gigantografia(nombre)')
                .eq('activo', true).eq('inventario_activo', true),
            db.from('promocionales_productos')
                .select('id, codigo_proveedor, nombre, stock, proveedor_id, promocionales_proveedores(nombre)')
                .eq('activo', true).lt('stock', 10).gt('stock', 0).order('stock').limit(10)
        ]);
        const rollosBajos = (rollos.data || [])
            .filter(r => (+r.m2_restantes) / (+r.m2_iniciales || 1) < 0.15 && +r.m2_restantes < 10)
            .sort((a,b) => +a.m2_restantes - +b.m2_restantes)
            .slice(0, 8);
        const promosBajos = promos.data || [];
        const sinStock = await db.from('promocionales_productos').select('id', {count:'exact', head:true}).eq('activo', true).eq('stock', 0);

        let html = '';
        if (rollosBajos.length) {
            html += '<div style="font-size:0.72rem;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:0.35rem;">🧻 Rollos bajos</div>';
            rollosBajos.forEach(r => {
                html += `<div class="dash-item" onclick="switchTab('admin');setTimeout(()=>switchAdminTab('rollos'),100)">
                    <span style="width:8px;height:32px;background:#ef4444;border-radius:3px;"></span>
                    <div style="flex:1;min-width:0;">
                        <div class="dash-item-title">${r.materiales_gigantografia?.nombre || '—'} · ${+r.ancho_cm} cm</div>
                        <div class="dash-item-sub">${(+r.m2_restantes).toFixed(1)} m² restantes</div>
                    </div>
                </div>`;
            });
        }
        if (promosBajos.length) {
            html += '<div style="font-size:0.72rem;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin:0.6rem 0 0.35rem;">🎁 Promocionales bajos (< 10 u)</div>';
            promosBajos.forEach(p => {
                html += `<div class="dash-item" onclick="switchTab('admin');setTimeout(()=>switchAdminTab('promoproductos'),100)">
                    <span style="width:8px;height:32px;background:#f59e0b;border-radius:3px;"></span>
                    <div style="flex:1;min-width:0;">
                        <div class="dash-item-title">${(p.nombre||'').replace(/</g,'&lt;')}</div>
                        <div class="dash-item-sub">${p.codigo_proveedor} · ${p.promocionales_proveedores?.nombre || '—'}</div>
                    </div>
                    <span class="dash-item-badge" style="background:#fee2e2;color:#991b1b;">${p.stock} u</span>
                </div>`;
            });
        }
        if (sinStock.count) {
            html += `<div class="dash-item" onclick="switchTab('admin');setTimeout(()=>switchAdminTab('promoproductos'),100)" style="background:#fef2f2;border-color:#fca5a5;">
                <span style="font-size:1.1rem;">🚫</span>
                <div style="flex:1;">
                    <div class="dash-item-title">${sinStock.count} productos sin stock</div>
                    <div class="dash-item-sub">Desactivar o reponer</div>
                </div>
            </div>`;
        }
        cont.innerHTML = html || '<div class="dash-empty">Todo en orden 👌</div>';
    }

    async function dashCargarProformasPendientes() {
        const cont = document.getElementById('dashProfPendLista');
        const badge = document.getElementById('dashProfPendContador');
        const { data } = await db.from('proformas')
            .select('id, numero, estado, fecha, clientes(nombre)')
            .in('estado', ['borrador','enviada'])
            .order('fecha', {ascending: false}).limit(10);
        const items = data || [];
        badge.textContent = items.length > 0 ? `(${items.length})` : '';
        if (!items.length) { cont.innerHTML = '<div class="dash-empty">Sin proformas pendientes</div>'; return; }
        cont.innerHTML = items.map(p => {
            const bg = p.estado === 'enviada' ? '#fef3c7' : '#e0e7ff';
            const fg = p.estado === 'enviada' ? '#92400e' : '#3730a3';
            return `<div class="dash-item" onclick="switchTab('proformas');setTimeout(()=>abrirProforma(${p.id}),400)">
                <div style="flex:1;min-width:0;">
                    <div class="dash-item-title">Proforma #${p.numero}</div>
                    <div class="dash-item-sub">${(p.clientes?.nombre||'Sin cliente').replace(/</g,'&lt;')} · ${new Date(p.fecha).toLocaleDateString('es-EC')}</div>
                </div>
                <span class="dash-item-badge" style="background:${bg};color:${fg};">${p.estado}</span>
            </div>`;
        }).join('');
    }

    async function dashCargarOrdenesActivas() {
        const cont = document.getElementById('dashOrdenesLista');
        const { data } = await db.from('ordenes_produccion')
            .select('id, numero, estado, fecha_creacion, clientes(nombre), proforma_id, orden_tareas(estado)')
            .not('estado', 'in', '(finalizada,entregada,cancelada)')
            .order('fecha_creacion', {ascending: false}).limit(10);
        const items = data || [];
        if (!items.length) { cont.innerHTML = '<div class="dash-empty">Sin órdenes activas</div>'; return; }
        cont.innerHTML = items.map(o => {
            const tareas = o.orden_tareas || [];
            const total = tareas.length;
            const comp = tareas.filter(t => t.estado === 'completado' || t.estado === 'saltado').length;
            const pct = total > 0 ? Math.round(comp / total * 100) : 0;
            return `<div class="dash-item" onclick="switchTab('ordenes');setTimeout(()=>abrirOrden(${o.id}),400)">
                <div style="flex:1;min-width:0;">
                    <div class="dash-item-title">Orden #${o.numero} · ${(o.clientes?.nombre||'—').replace(/</g,'&lt;')}</div>
                    <div class="dash-bar" style="margin-top:0.2rem;">
                        <div class="dash-bar-fill-bg" style="flex:1;"><div class="dash-bar-fill" style="width:${pct}%;"></div></div>
                        <span class="dash-bar-val" style="font-size:0.7rem;">${comp}/${total}</span>
                    </div>
                </div>
                <span class="dash-item-badge" style="background:#dbeafe;color:#1e40af;">${o.estado}</span>
            </div>`;
        }).join('');
    }

    async function dashCargarReportes() {
        const meses = +document.getElementById('dashReportePeriodo').value || 6;
        const now = new Date();
        const desde = new Date(now.getFullYear(), now.getMonth() - meses + 1, 1);
        const { data: profs } = await db.from('proformas')
            .select('id, numero, fecha, estado, clientes(nombre), proforma_items(cantidad, precio_unitario, metodo_impresion)')
            .gte('fecha', desde.toISOString())
            .eq('estado', 'aprobada');
        const arr = profs || [];

        // Ventas por mes
        const porMes = {};
        for (let i = 0; i < meses; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - (meses-1-i), 1);
            const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
            porMes[key] = { total: 0, cant: 0, label: d.toLocaleDateString('es-EC', {month:'short'}) };
        }
        let totalPeriodo = 0;
        arr.forEach(p => {
            const d = new Date(p.fecha);
            const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
            if (!porMes[key]) return;
            const sub = (p.proforma_items||[]).reduce((s, it) => s + (+it.cantidad||0)*(+it.precio_unitario||0), 0);
            porMes[key].total += sub;
            porMes[key].cant += 1;
            totalPeriodo += sub;
        });

        dashDibujarVentasChart(porMes);
        document.getElementById('dashVentasTotal').textContent = `Total ${meses} meses: $${fmtN(totalPeriodo, 2)} · ${arr.length} proformas aprobadas`;

        // Por metodo
        const metodos = {};
        arr.forEach(p => {
            (p.proforma_items||[]).forEach(it => {
                const m = it.metodo_impresion || 'otro';
                const v = (+it.cantidad||0)*(+it.precio_unitario||0);
                metodos[m] = (metodos[m] || 0) + v;
            });
        });
        const mEntries = Object.entries(metodos).sort((a,b) => b[1]-a[1]);
        const mMax = Math.max(1, ...mEntries.map(e => e[1]));
        const metodoColors = {offset:'#7c3aed', digital:'#0369a1', gigantografia:'#0891b2', promocional:'#059669', otro:'#6b7280'};
        const metodoLabels = {offset:'Offset', digital:'Digital', gigantografia:'Gigantografía', promocional:'Promocionales', otro:'Otros'};
        document.getElementById('dashPorMetodo').innerHTML = mEntries.map(([k, v]) => `
            <div class="dash-bar">
                <span class="dash-bar-label">${metodoLabels[k] || k}</span>
                <div class="dash-bar-fill-bg"><div class="dash-bar-fill" style="width:${(v/mMax*100).toFixed(1)}%;background:${metodoColors[k] || '#6b7280'};"></div></div>
                <span class="dash-bar-val">$${fmtN(v, 0)}</span>
            </div>
        `).join('') || '<div class="dash-empty" style="padding:0.75rem;">Sin datos</div>';

        // Top clientes
        const clients = {};
        arr.forEach(p => {
            const nombre = p.clientes?.nombre || '— sin cliente —';
            const sub = (p.proforma_items||[]).reduce((s, it) => s + (+it.cantidad||0)*(+it.precio_unitario||0), 0);
            clients[nombre] = (clients[nombre] || 0) + sub;
        });
        const topClients = Object.entries(clients).sort((a,b) => b[1]-a[1]).slice(0, 10);
        const cMax = Math.max(1, ...topClients.map(e => e[1]));
        document.getElementById('dashTopClientes').innerHTML = topClients.map(([k, v]) => `
            <div class="dash-bar">
                <span class="dash-bar-label" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${k.replace(/</g,'&lt;')}</span>
                <div class="dash-bar-fill-bg"><div class="dash-bar-fill" style="width:${(v/cMax*100).toFixed(1)}%;"></div></div>
                <span class="dash-bar-val">$${fmtN(v, 0)}</span>
            </div>
        `).join('') || '<div class="dash-empty" style="padding:0.75rem;">Sin datos</div>';
    }

    function dashDibujarVentasChart(porMes) {
        const cv = document.getElementById('dashVentasChart');
        if (!cv) return;
        const ctx = cv.getContext('2d');
        const cssW = cv.clientWidth || 600;
        const cssH = 220;
        const dpr = window.devicePixelRatio || 1;
        cv.width = cssW * dpr; cv.height = cssH * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const keys = Object.keys(porMes);
        if (!keys.length) return;
        const max = Math.max(1, ...keys.map(k => porMes[k].total));
        const pad = { l: 50, r: 10, t: 20, b: 30 };
        const w = cssW - pad.l - pad.r;
        const h = cssH - pad.t - pad.b;
        const bw = w / keys.length;
        // ejes
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.t + h * (i / 4);
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(cssW - pad.r, y); ctx.stroke();
            ctx.fillStyle = '#9ca3af';
            ctx.font = '10px -apple-system, system-ui, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText('$' + fmtN(max * (1 - i/4), 0), pad.l - 4, y + 3);
        }
        // barras
        keys.forEach((k, i) => {
            const v = porMes[k].total;
            const bh = (v / max) * h;
            const x = pad.l + i * bw + bw * 0.15;
            const y = pad.t + h - bh;
            const bwFill = bw * 0.7;
            ctx.fillStyle = '#0891b2';
            ctx.fillRect(x, y, bwFill, bh);
            if (v > 0) {
                ctx.fillStyle = '#0e7490';
                ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('$' + fmtN(v, 0), x + bwFill/2, y - 4);
            }
            ctx.fillStyle = '#6b7280';
            ctx.font = '10px -apple-system, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(porMes[k].label, x + bwFill/2, cssH - pad.b + 14);
        });
    }

    // GIGANTOGRAFIA extraido a gigantografia.js — script cargado al final del body

    // PROMOCIONALES extraido a promocionales.js — script cargado al final del body

    // =====================================================
    // COMPARADOR OFFSET vs DIGITAL
    // =====================================================
    function _cmpReadNum(id) {
        return parseFloat((document.getElementById(id)?.textContent || '0').replace(',', '.')) || 0;
    }
    function _cmpSnapshotDig() {
        return {
            digDescripcion: document.getElementById('digDescripcion').value,
            digCantidad: document.getElementById('digCantidad').value,
            digProdW: document.getElementById('digProdW').value,
            digProdH: document.getElementById('digProdH').value,
            digSangrado: document.getElementById('digSangrado').value,
            digLados: document.getElementById('digLados').value,
            digMaterial: document.getElementById('digMaterial').value,
        };
    }
    function _cmpSnapshotCot() {
        return {
            cotDescripcion: document.getElementById('cotDescripcion').value,
            cotCantidad: document.getElementById('cotCantidad').value,
            cotProdW: document.getElementById('cotProdW').value,
            cotProdH: document.getElementById('cotProdH').value,
            cotSangrado: document.getElementById('cotSangrado').value,
            cotLados: document.getElementById('cotLados').value,
            cotMaterial: document.getElementById('cotMaterial')?.value,
        };
    }
    function _cmpRestore(snap) {
        Object.keys(snap).forEach(k => {
            const el = document.getElementById(k);
            if (el != null) el.value = snap[k];
        });
    }
    function abrirComparador(from) {
        // Leer datos comunes desde el tab "from"
        let common;
        if (from === 'offset') {
            common = {
                descripcion: document.getElementById('cotDescripcion').value,
                cantidad: document.getElementById('cotCantidad').value,
                w: document.getElementById('cotProdW').value,
                h: document.getElementById('cotProdH').value,
                sangrado: document.getElementById('cotSangrado').value,
                lados: document.getElementById('cotLados').value,
                materialSel: document.getElementById('cotMaterial')?.value,
            };
        } else {
            common = {
                descripcion: document.getElementById('digDescripcion').value,
                cantidad: document.getElementById('digCantidad').value,
                w: document.getElementById('digProdW').value,
                h: document.getElementById('digProdH').value,
                sangrado: document.getElementById('digSangrado').value,
                lados: document.getElementById('digLados').value,
                materialSel: document.getElementById('digMaterial').value,
            };
        }

        // Asegurar que ambos tabs estan calculados con estos datos comunes
        // 1) OFFSET
        const snapCot = _cmpSnapshotCot();
        document.getElementById('cotDescripcion').value = common.descripcion;
        document.getElementById('cotCantidad').value = common.cantidad;
        document.getElementById('cotProdW').value = common.w;
        document.getElementById('cotProdH').value = common.h;
        document.getElementById('cotSangrado').value = common.sangrado;
        document.getElementById('cotLados').value = common.lados;
        if (common.materialSel != null && common.materialSel !== '') {
            const cotMatSel = document.getElementById('cotMaterial');
            if (cotMatSel) {
                cotMatSel.value = common.materialSel;
                if (typeof cotOnMaterialChange === 'function') cotOnMaterialChange();
            }
        }
        cotCalc();
        const offsetResult = {
            costo: _cmpReadNum('cotSubtotalCosto'),
            margen: document.getElementById('cotMargenPct').textContent,
            utilidad: _cmpReadNum('cotUtilidadNeta'),
            unit: _cmpReadNum('cotPrecioUnit'),
            total: _cmpReadNum('cotPrecioFinal')
        };

        // 2) DIGITAL
        const snapDig = _cmpSnapshotDig();
        document.getElementById('digDescripcion').value = common.descripcion;
        document.getElementById('digCantidad').value = common.cantidad;
        document.getElementById('digProdW').value = common.w;
        document.getElementById('digProdH').value = common.h;
        document.getElementById('digSangrado').value = common.sangrado;
        document.getElementById('digLados').value = common.lados;
        if (common.materialSel != null && common.materialSel !== '') {
            const digMatSel = document.getElementById('digMaterial');
            if (digMatSel) {
                digMatSel.value = common.materialSel;
                if (typeof digOnMaterialChange === 'function') digOnMaterialChange();
            }
        }
        window._digMargenManual = false;
        digCalc();
        const digPiezasHoja = +(document.getElementById('digResPiezasHoja')?.textContent || '0');
        const digitalResult = {
            costo: _cmpReadNum('digSubtotalCosto'),
            margen: document.getElementById('digMargenPct').textContent,
            utilidad: _cmpReadNum('digUtilidadNeta'),
            unit: _cmpReadNum('digPrecioUnit'),
            total: _cmpReadNum('digPrecioFinal'),
            noCabe: digPiezasHoja === 0
        };

        // Si el comparador vino desde offset, restaurar digital a su estado previo
        // Si vino desde digital, restaurar offset a su estado previo
        if (from === 'offset') {
            _cmpRestore(snapDig);
            if (typeof digOnMaterialChange === 'function') digOnMaterialChange();
            digCalc();
        } else {
            _cmpRestore(snapCot);
            if (typeof cotOnMaterialChange === 'function') cotOnMaterialChange();
            cotCalc();
        }

        // Pintar modal
        document.getElementById('comparadorResumen').textContent =
            (common.descripcion || 'Producto') + ' | ' + common.cantidad + ' uds | ' +
            common.w + 'x' + common.h + ' cm | ' + (common.lados === '2' ? 'T/R' : '1 lado');
        document.getElementById('cmpOffsetCosto').textContent = '$' + fmtN(offsetResult.costo, 2);
        document.getElementById('cmpOffsetMargen').textContent = offsetResult.margen;
        document.getElementById('cmpOffsetUtilidad').textContent = '$' + fmtN(offsetResult.utilidad, 2);
        document.getElementById('cmpOffsetUnit').textContent = '$' + fmtN(offsetResult.unit, 3);
        document.getElementById('cmpOffsetTotal').textContent = '$' + fmtN(offsetResult.total, 2);
        document.getElementById('cmpDigitalCosto').textContent = '$' + fmtN(digitalResult.costo, 2);
        document.getElementById('cmpDigitalMargen').textContent = digitalResult.margen;
        document.getElementById('cmpDigitalUtilidad').textContent = '$' + fmtN(digitalResult.utilidad, 2);
        document.getElementById('cmpDigitalUnit').textContent = '$' + fmtN(digitalResult.unit, 3);
        document.getElementById('cmpDigitalTotal').textContent = '$' + fmtN(digitalResult.total, 2);

        // Si digital no cabe, sobrescribir los valores del display con "-"
        if (digitalResult.noCabe) {
            document.getElementById('cmpDigitalCosto').textContent = '-';
            document.getElementById('cmpDigitalUtilidad').textContent = '-';
            document.getElementById('cmpDigitalUnit').textContent = '-';
            document.getElementById('cmpDigitalTotal').innerHTML = '<span style="font-size:0.9rem;color:#991b1b;">No cabe en hoja digital</span>';
        }

        // Resaltar el ganador (menor precio)
        const offCard = document.getElementById('cmpOffsetCard');
        const digCard = document.getElementById('cmpDigitalCard');
        const reco = document.getElementById('comparadorRecomendacion');
        offCard.style.border = '2px solid #e5e7eb';
        digCard.style.border = '2px solid #e5e7eb';
        if (digitalResult.noCabe && offsetResult.total > 0) {
            offCard.style.border = '2px solid #7c3aed';
            reco.style.background = '#fef3c7';
            reco.style.color = '#92400e';
            reco.innerHTML = '<strong>La pieza no cabe en hoja digital. Solo se puede hacer en offset.</strong>';
        } else if (offsetResult.total > 0 && digitalResult.total > 0 && !digitalResult.noCabe) {
            const diff = Math.abs(offsetResult.total - digitalResult.total);
            const pct = (diff / Math.max(offsetResult.total, digitalResult.total)) * 100;
            if (offsetResult.total < digitalResult.total) {
                offCard.style.border = '2px solid #7c3aed';
                reco.style.background = '#f5f3ff';
                reco.style.color = '#6d28d9';
                reco.innerHTML = '<strong>Offset es $' + fmtN(diff, 2) + ' mas barato (' + pct.toFixed(1).replace('.', ',') + '%)</strong>';
            } else if (digitalResult.total < offsetResult.total) {
                digCard.style.border = '2px solid #0369a1';
                reco.style.background = '#f0f9ff';
                reco.style.color = '#075985';
                reco.innerHTML = '<strong>Digital es $' + fmtN(diff, 2) + ' mas barato (' + pct.toFixed(1).replace('.', ',') + '%)</strong>';
            } else {
                reco.style.background = '#f9fafb';
                reco.style.color = '#6b7280';
                reco.textContent = 'Ambos cuestan lo mismo';
            }
        } else {
            reco.style.background = '#fef3c7';
            reco.style.color = '#92400e';
            reco.textContent = 'Falta informacion en uno de los dos cotizadores';
        }

        const hasProf = !!proformaActiva;
        const digBtn = document.getElementById('cmpDigitalBtn');
        const offBtn = document.getElementById('cmpOffsetBtn');
        digBtn.disabled = digitalResult.noCabe;
        digBtn.style.opacity = digitalResult.noCabe ? '0.5' : '1';
        if (hasProf) {
            offBtn.textContent = 'Usar Offset en proforma #' + proformaActiva.numero;
            digBtn.textContent = digitalResult.noCabe ? 'No cabe en digital' : 'Usar Digital en proforma #' + proformaActiva.numero;
        } else {
            offBtn.textContent = 'Usar Offset — Crear Proforma';
            digBtn.textContent = digitalResult.noCabe ? 'No cabe en digital' : 'Usar Digital — Crear Proforma';
        }

        document.getElementById('comparadorModal').style.display = 'flex';
    }
    function cerrarComparador() {
        document.getElementById('comparadorModal').style.display = 'none';
    }
    async function usarComparadorResult(tipo) {
        if (!proformaActiva) {
            await crearProformaDesdeCalc(tipo);
        } else {
            if (tipo === 'offset') addItemToProforma();
            else addItemToProformaDig();
        }
        cerrarComparador();
    }

    async function guardarProforma() {
        if (!proformaActiva) return;
        // Bloqueo: no permitir guardar si hay orden vinculada y no se hizo override
        if (proformaActiva.orden_vinculada && !proformaActiva._unlock_override) {
            alert('Esta proforma tiene la orden #' + proformaActiva.orden_vinculada.numero + ' vinculada. Desbloqueá primero para guardar cambios.');
            return;
        }

        // Update proforma record
        const { error: profErr } = await db.from('proformas').update({
            cliente_id: proformaActiva.cliente_id || null,
            estado: document.getElementById('editorEstado').value,
            iva_porcentaje: parseFloat(document.getElementById('profIVA').value) || 15,
            tiempo_entrega: document.getElementById('profTiempoEntrega').value.trim(),
            forma_pago: document.getElementById('profFormaPago').value.trim()
        }).eq('id', proformaActiva.id);

        if (profErr) { alert('Error guardando proforma: ' + profErr.message); return; }

        // Delete existing items and re-insert
        await db.from('proforma_items').delete().eq('proforma_id', proformaActiva.id);

        if (proformaActiva.items.length > 0) {
            const itemsToInsert = proformaActiva.items.map((it, i) => ({
                proforma_id: proformaActiva.id,
                orden: i + 1,
                codigo: it.codigo || null,
                descripcion: it.descripcion,
                cantidad: it.cantidad,
                precio_unitario: it.precio_unitario,
                imagen_url: it.imagen_url || null,
                metodo_impresion: it.metodo_impresion || null,
                datos_cotizacion: it.datos_cotizacion || null
            }));

            const { error: itemsErr } = await db.from('proforma_items').insert(itemsToInsert);
            if (itemsErr) { alert('Error guardando items: ' + itemsErr.message); return; }
        }

        // Reload items from DB to get IDs
        const { data: freshItems } = await db.from('proforma_items')
            .select('*').eq('proforma_id', proformaActiva.id).order('orden');
        proformaActiva.items = freshItems || [];

        alert('Proforma #' + proformaActiva.numero + ' guardada correctamente');
    }

    async function duplicarProforma() {
        if (!proformaActiva) return;
        if (!confirm('Se creara una copia de la proforma #' + proformaActiva.numero + ' como borrador. Continuar?')) return;

        // Guardar cambios pendientes primero
        await guardarProforma();

        // Siguiente numero
        const { data: maxRow } = await db.from('proformas').select('numero').order('numero', { ascending: false }).limit(1);
        const nextNum = (maxRow && maxRow.length > 0) ? maxRow[0].numero + 1 : 6001;

        // Crear nueva proforma copiando datos
        const { data: nueva, error: profErr } = await db.from('proformas').insert({
            numero: nextNum,
            cliente_id: proformaActiva.cliente_id || null,
            estado: 'borrador',
            iva_porcentaje: proformaActiva.iva_porcentaje || 15,
            tiempo_entrega: proformaActiva.tiempo_entrega || null,
            forma_pago: proformaActiva.forma_pago || null,
            created_by: currentUser?.id || null,
            created_by_name: currentUser?.nombre || null
        }).select().single();

        if (profErr) { alert('Error duplicando: ' + profErr.message); return; }

        // Copiar items
        if (proformaActiva.items.length > 0) {
            const itemsCopia = proformaActiva.items.map((it, i) => ({
                proforma_id: nueva.id,
                orden: i + 1,
                codigo: it.codigo || null,
                descripcion: it.descripcion,
                cantidad: it.cantidad,
                precio_unitario: it.precio_unitario,
                imagen_url: it.imagen_url || null,
                metodo_impresion: it.metodo_impresion || null,
                datos_cotizacion: it.datos_cotizacion || null
            }));
            const { error: itemsErr } = await db.from('proforma_items').insert(itemsCopia);
            if (itemsErr) { alert('Proforma creada pero fallo al copiar items: ' + itemsErr.message); return; }
        }

        alert('Proforma duplicada como #' + nextNum + ' (borrador). Puedes eliminar los items que el cliente no quiera.');
        await abrirProforma(nueva.id);
    }

    async function cambiarEstadoProforma() {
        if (!proformaActiva) return;
        const estado = document.getElementById('editorEstado').value;
        const estadoAnterior = proformaActiva.estado;
        proformaActiva.estado = estado;
        await db.from('proformas').update({ estado }).eq('id', proformaActiva.id);
        actualizarBotonCrearOrden();

        // ---- Hooks kanban de trabajos ----
        try {
            if (estado === 'enviada') {
                await asegurarTrabajoParaProforma(proformaActiva.id, 'proforma_enviada');
                invalidarCacheTrabajos();
            } else if (estado === 'aprobada') {
                await asegurarTrabajoParaProforma(proformaActiva.id, 'diseno');
                // Auto-crear orden si no existe
                const { data: ord } = await db.from('ordenes_produccion')
                    .select('id').eq('proforma_id', proformaActiva.id).maybeSingle();
                if (!ord && proformaActiva.items && proformaActiva.items.length > 0) {
                    await crearOrdenProduccion(true);
                }
                invalidarCacheTrabajos();
            } else if (estado === 'rechazada') {
                await asegurarTrabajoParaProforma(proformaActiva.id, 'perdido');
                invalidarCacheTrabajos();
            }
        } catch (e) {
            console.error('Error en hooks kanban:', e);
        }
    }

    function actualizarBotonCrearOrden() {
        const btn = document.getElementById('btnCrearOrden');
        if (!btn) return;
        const bloqueada = proformaActiva && proformaActiva.orden_vinculada && !proformaActiva._unlock_override;
        btn.style.display = (proformaActiva && proformaActiva.estado === 'aprobada' && !bloqueada) ? 'inline-block' : 'none';
    }

    function aplicarBloqueoProforma() {
        const editor = document.getElementById('proformaEditor');
        const banner = document.getElementById('proformaLockBanner');
        const det = document.getElementById('proformaLockDetalle');
        if (!editor || !banner) return;
        const orden = proformaActiva && proformaActiva.orden_vinculada;
        const bloquear = !!orden && !proformaActiva._unlock_override;
        editor.classList.toggle('proforma-locked', bloquear);
        banner.style.display = bloquear ? 'flex' : 'none';
        if (bloquear && orden) {
            det.innerHTML = ` Orden de producción #${orden.numero} en estado <strong>${orden.estado}</strong>. Los cambios pueden desincronizar la producción.`;
        }
        // Si la proforma esta desbloqueada pero tiene orden vinculada, mostrar aviso sutil
        if (orden && proformaActiva._unlock_override && det) {
            banner.style.display = 'flex';
            banner.style.background = '#fee2e2';
            banner.style.borderColor = '#fca5a5';
            banner.style.color = '#991b1b';
            det.innerHTML = ` Edición desbloqueada manualmente. Orden #${orden.numero} activa — guardá con cuidado.`;
            document.getElementById('proformaUnlockBtn').textContent = 'Rebloquear';
            document.getElementById('proformaUnlockBtn').onclick = () => { proformaActiva._unlock_override = false; aplicarBloqueoProforma(); };
        } else {
            banner.style.background = '#fef3c7';
            banner.style.borderColor = '#fbbf24';
            banner.style.color = '#92400e';
            document.getElementById('proformaUnlockBtn').textContent = 'Desbloquear igual';
            document.getElementById('proformaUnlockBtn').onclick = desbloquearProforma;
        }
    }

    function desbloquearProforma() {
        if (!proformaActiva || !proformaActiva.orden_vinculada) return;
        const n = proformaActiva.orden_vinculada.numero;
        if (!confirm(`¿Desbloquear la proforma? La orden #${n} ya está en producción. Cambios pueden desincronizarla.`)) return;
        proformaActiva._unlock_override = true;
        aplicarBloqueoProforma();
        actualizarBotonCrearOrden();
    }

    function cerrarEditor() {
        document.getElementById('proformaEditor').classList.remove('active');
        document.getElementById('proformasLista').style.display = 'block';
        proformaActiva = null;
        updateAddToProformaBtn();
        cargarProformas();
    }

    function imprimirProforma() {
        window.print();
    }

    function descargarProformaPDF() {
        if (!proformaActiva) return;

        const { jsPDF } = window.jspdf || {};
        if (!jsPDF) { alert('Error: libreria jsPDF no cargada'); return; }

        const doc = new jsPDF('p', 'mm', 'a4');
        const W = 210, H = 297, M = 15;
        const pw = W - 2 * M;
        let y = M;

        const items = proformaActiva.items || [];
        let _sub0 = 0, _sub15 = 0, _totalDesc = 0;
        items.forEach(it => {
            const importe = (it.cantidad || 0) * (it.precio_unitario || 0);
            if ((it.iva_pct !== undefined ? it.iva_pct : 15) === 0) _sub0 += importe; else _sub15 += importe;
        });
        const subtotal = round2(_sub0 + _sub15);
        const iva = calcIVA(_sub15, 15);
        const total = subtotal + iva;
        const fecha = new Date().toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const tiempoEntrega = document.getElementById('profTiempoEntrega')?.value || '';
        const formaPago = document.getElementById('profFormaPago')?.value || '';
        const cNombre = document.getElementById('profClienteNombre')?.textContent || '-';
        const cEmpresa = document.getElementById('profClienteEmpresa')?.textContent || '-';
        const cRUC = document.getElementById('profClienteRUC')?.textContent || '-';
        const cEmail = document.getElementById('profClienteEmail')?.textContent || '-';
        const cTelefono = document.getElementById('profClienteTelefono')?.textContent || '-';
        const cDireccion = document.getElementById('profClienteDireccion')?.textContent || '-';

        // Colores
        const cPrimary = [0, 119, 139]; // teal similar a factura
        const cGray = [100, 100, 100];
        const cDark = [33, 33, 33];
        const cBorder = [200, 200, 200];
        const cHeaderBg = [230, 245, 248];

        // Helper: dibujar celda con borde
        function cell(x, yy, w, h, opts) {
            doc.setDrawColor(...cBorder);
            doc.setLineWidth(0.3);
            if (opts?.fill) { doc.setFillColor(...opts.fill); doc.rect(x, yy, w, h, 'FD'); }
            else { doc.rect(x, yy, w, h); }
        }

        // ===============================
        // HEADER: Logo izq + Proforma der
        // ===============================
        try {
            const logoImg = document.getElementById('printLogo');
            if (logoImg && logoImg.src) doc.addImage(logoImg.src, 'PNG', M, y, 55, 20);
        } catch(e) {}

        // Recuadro derecho con PROFORMA y numero
        const rX = M + pw * 0.55, rW = pw * 0.45;
        cell(rX, y, rW, 10);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(...cDark);
        doc.text('PROFORMA', rX + 5, y + 7);
        doc.text('No. ' + proformaActiva.numero, rX + rW - 5, y + 7, { align: 'right' });

        cell(rX, y + 10, rW, 8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...cGray);
        doc.text('Fecha de Emision:', rX + 5, y + 15.5);
        doc.setTextColor(...cDark);
        doc.text(fecha, rX + rW - 5, y + 15.5, { align: 'right' });

        y += 25;

        // ===============================
        // EMISOR: datos de Ingenia
        // ===============================
        const emisorH = 28;
        cell(M, y, pw * 0.5, emisorH);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...cDark);
        doc.text('Emisor: COBOS GRANDA PABLO ANDRES', M + 3, y + 5);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text('RUC: 1715437990001', M + 3, y + 10);
        doc.text('Direccion: Montes N29-130 y Andagoya', M + 3, y + 15);
        doc.text('Correo: contabilidad@ingenia.ec', M + 3, y + 20);
        doc.text('Telefono: 022902163', M + 3, y + 25);

        y += emisorH + 5;

        // ===============================
        // CLIENTE: estilo factura (label: valor)
        // ===============================
        const halfW = pw / 2;
        const rowH = 8;

        // Fila 1: Razon Social | RUC
        cell(M, y, halfW, rowH);
        cell(M + halfW, y, halfW, rowH);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...cGray);
        doc.text('Razon Social:', M + 3, y + 5.5);
        doc.text('RUC/CI:', M + halfW + 3, y + 5.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...cDark);
        doc.text(cNombre || cEmpresa, M + 32, y + 5.5);
        doc.text(cRUC, M + halfW + 20, y + 5.5);
        y += rowH;

        // Fila 2: Direccion | Telefono
        cell(M, y, halfW, rowH);
        cell(M + halfW, y, halfW, rowH);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...cGray);
        doc.text('Direccion:', M + 3, y + 5.5);
        doc.text('Telefono:', M + halfW + 3, y + 5.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...cDark);
        const dirLines = doc.splitTextToSize(cDireccion, halfW - 30);
        doc.text(dirLines[0] || '', M + 26, y + 5.5);
        doc.text(cTelefono, M + halfW + 24, y + 5.5);
        y += rowH;

        // Fila 3: Fecha Emision | Correo
        cell(M, y, halfW, rowH);
        cell(M + halfW, y, halfW, rowH);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...cGray);
        doc.text('Fecha Emision:', M + 3, y + 5.5);
        doc.text('Correo:', M + halfW + 3, y + 5.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...cDark);
        doc.text(fecha, M + 34, y + 5.5);
        doc.text(cEmail, M + halfW + 20, y + 5.5);
        y += rowH + 6;

        // ===============================
        // TABLA DE ITEMS con bordes
        // ===============================
        const colW = [22, 18, 0, 22, 25, 24]; // Codigo | Cant | Desc | P.Unit | Total | Ref
        colW[2] = pw - colW.reduce((a, b) => a + b, 0);
        const headers = ['Codigo', 'Cantidad', 'Descripcion', 'Precio\nUnitario', 'Total', 'Ref.'];
        const thH = 10;

        // Header con fondo
        let cx = M;
        headers.forEach((h, i) => {
            cell(cx, y, colW[i], thH, { fill: cHeaderBg });
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);
            doc.setTextColor(...cDark);
            const lines = h.split('\n');
            if (lines.length > 1) {
                doc.text(lines[0], cx + colW[i] / 2, y + 4, { align: 'center' });
                doc.text(lines[1], cx + colW[i] / 2, y + 8, { align: 'center' });
            } else {
                doc.text(h, cx + colW[i] / 2, y + 6.5, { align: 'center' });
            }
            cx += colW[i];
        });
        y += thH;

        // Rows
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...cDark);

        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const imp = (it.cantidad || 0) * (it.precio_unitario || 0);
            const hasImg = it.imagen_url && it.imagen_url.length > 5;
            const descLines = doc.splitTextToSize(it.descripcion || '', colW[2] - 4);
            const textH = descLines.length * 4 + 4;
            const rH = Math.max(hasImg ? 24 : 8, textH);

            if (y + rH > H - 40) { doc.addPage(); y = M; }

            const vals = [
                it.codigo || '',
                String(it.cantidad || 0),
                '', // descripcion se maneja aparte
                fmtN(it.precio_unitario || 0, 3),
                '$' + fmtN(imp, 2),
                '' // imagen se maneja aparte
            ];

            cx = M;
            vals.forEach((v, j) => {
                cell(cx, y, colW[j], rH);
                if (j === 2) {
                    doc.text(descLines, cx + 2, y + 4);
                } else if (j === 5) {
                    // Columna de imagen de referencia
                    if (hasImg) {
                        try { doc.addImage(it.imagen_url, 'JPEG', cx + 2, y + 1.5, 20, rH - 3); } catch(e) {}
                    }
                } else {
                    const tx = j >= 3 ? cx + colW[j] - 3 : cx + 3;
                    const alignOpt = j >= 3 ? { align: 'right' } : {};
                    if (j === 4) doc.setFont('helvetica', 'bold');
                    doc.text(v, tx, y + rH / 2 + 1.5, alignOpt);
                    if (j === 4) doc.setFont('helvetica', 'normal');
                }
                cx += colW[j];
            });

            y += rH;
        }

        y += 8;

        // ===============================
        // TOTALES
        // ===============================
        if (y > H - 55) { doc.addPage(); y = M; }

        const totX = M + pw * 0.55;
        const totW2 = pw * 0.45;
        const totLabelW = totW2 * 0.55;
        const totValW = totW2 * 0.45;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...cDark);

        // Subtotal IVA 0% (solo si hay)
        if (_sub0 > 0) {
            cell(totX, y, totLabelW, 8); cell(totX + totLabelW, y, totValW, 8);
            doc.text('Subtotal IVA 0%', totX + 3, y + 5.5);
            doc.text('$' + fmtN(_sub0, 2), totX + totW2 - 3, y + 5.5, { align: 'right' });
            y += 8;
        }
        // Subtotal IVA 15% (solo si hay)
        if (_sub15 > 0) {
            cell(totX, y, totLabelW, 8); cell(totX + totLabelW, y, totValW, 8);
            doc.text('Subtotal IVA 15%', totX + 3, y + 5.5);
            doc.text('$' + fmtN(_sub15, 2), totX + totW2 - 3, y + 5.5, { align: 'right' });
            y += 8;
        }
        // Subtotal
        cell(totX, y, totLabelW, 8); cell(totX + totLabelW, y, totValW, 8);
        doc.text('Subtotal', totX + 3, y + 5.5);
        doc.text('$' + fmtN(subtotal, 2), totX + totW2 - 3, y + 5.5, { align: 'right' });
        y += 8;

        // IVA 15%
        cell(totX, y, totLabelW, 8); cell(totX + totLabelW, y, totValW, 8);
        doc.text('IVA 15%', totX + 3, y + 5.5);
        doc.text('$' + fmtN(iva, 2), totX + totW2 - 3, y + 5.5, { align: 'right' });
        y += 8;

        // TOTAL
        cell(totX, y, totLabelW, 10, { fill: cHeaderBg });
        cell(totX + totLabelW, y, totValW, 10, { fill: cHeaderBg });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(...cPrimary);
        doc.text('TOTAL', totX + 3, y + 7);
        doc.setTextColor(22, 163, 74);
        doc.text('$' + fmtN(total, 2), totX + totW2 - 3, y + 7, { align: 'right' });

        y += 18;

        // ===============================
        // CONDICIONES
        // ===============================
        if (y > H - 30) { doc.addPage(); y = M; }

        // Tiempo de entrega
        cell(M, y, halfW, 8);
        cell(M + halfW, y, halfW, 8);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(...cGray);
        doc.text('Tiempo de Entrega:', M + 3, y + 5.5);
        doc.text('Forma de Pago:', M + halfW + 3, y + 5.5);
        y += 8;

        const teLines = doc.splitTextToSize(tiempoEntrega, halfW - 6);
        const fpLines = doc.splitTextToSize(formaPago, halfW - 6);
        const condH = Math.max(teLines.length, fpLines.length) * 4 + 4;

        cell(M, y, halfW, condH);
        cell(M + halfW, y, halfW, condH);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...cDark);
        doc.text(teLines, M + 3, y + 4);
        doc.text(fpLines, M + halfW + 3, y + 4);

        // === GUARDAR ===
        doc.save(`Proforma_${proformaActiva.numero}.pdf`);
    }

    // Generar PDF como Blob (sin descargar) para subir a storage
    function generarProformaPDFBlob() {
        if (!proformaActiva) return null;
        // Reutilizamos la misma logica de descargarProformaPDF pero retornamos blob
        const { jsPDF } = window.jspdf || {};
        if (!jsPDF) return null;

        const doc = new jsPDF('p', 'mm', 'a4');
        const W = 210, H = 297, M = 15;
        const pw = W - 2 * M;
        let y = M;

        const items = proformaActiva.items || [];
        let _sub0 = 0, _sub15 = 0, _totalDesc = 0;
        items.forEach(it => {
            const importe = (it.cantidad || 0) * (it.precio_unitario || 0);
            if ((it.iva_pct !== undefined ? it.iva_pct : 15) === 0) _sub0 += importe; else _sub15 += importe;
        });
        const subtotal = round2(_sub0 + _sub15);
        const iva = calcIVA(_sub15, 15);
        const total = subtotal + iva;
        const fecha = new Date().toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const tiempoEntrega = document.getElementById('profTiempoEntrega')?.value || '';
        const formaPago = document.getElementById('profFormaPago')?.value || '';
        const cNombre = document.getElementById('profClienteNombre')?.textContent || '-';
        const cEmpresa = document.getElementById('profClienteEmpresa')?.textContent || '-';
        const cRUC = document.getElementById('profClienteRUC')?.textContent || '-';
        const cEmail = document.getElementById('profClienteEmail')?.textContent || '-';
        const cTelefono = document.getElementById('profClienteTelefono')?.textContent || '-';
        const cDireccion = document.getElementById('profClienteDireccion')?.textContent || '-';

        const cPrimary = [0, 119, 139], cGray = [100, 100, 100], cDark = [33, 33, 33], cBorder = [200, 200, 200], cHeaderBg = [230, 245, 248];
        function cell(x, yy, w, h, opts) {
            doc.setDrawColor(...cBorder); doc.setLineWidth(0.3);
            if (opts?.fill) { doc.setFillColor(...opts.fill); doc.rect(x, yy, w, h, 'FD'); } else { doc.rect(x, yy, w, h); }
        }

        try { const logoImg = document.getElementById('printLogo'); if (logoImg?.src) doc.addImage(logoImg.src, 'PNG', M, y, 55, 20); } catch(e) {}

        const rX = M + pw * 0.55, rW = pw * 0.45;
        cell(rX, y, rW, 10);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...cDark);
        doc.text('PROFORMA', rX + 5, y + 7); doc.text('No. ' + proformaActiva.numero, rX + rW - 5, y + 7, { align: 'right' });
        cell(rX, y + 10, rW, 8);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...cGray);
        doc.text('Fecha de Emision:', rX + 5, y + 15.5); doc.setTextColor(...cDark);
        doc.text(fecha, rX + rW - 5, y + 15.5, { align: 'right' });
        y += 25;

        cell(M, y, pw * 0.5, 28);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...cDark);
        doc.text('Emisor: COBOS GRANDA PABLO ANDRES', M + 3, y + 5);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        doc.text('RUC: 1715437990001', M + 3, y + 10);
        doc.text('Direccion: Montes N29-130 y Andagoya', M + 3, y + 15);
        doc.text('Correo: contabilidad@ingenia.ec', M + 3, y + 20);
        doc.text('Telefono: 022902163', M + 3, y + 25);
        y += 33;

        const halfW = pw / 2, rowH = 8;
        cell(M, y, halfW, rowH); cell(M + halfW, y, halfW, rowH);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...cGray);
        doc.text('Razon Social:', M + 3, y + 5.5); doc.text('RUC/CI:', M + halfW + 3, y + 5.5);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...cDark);
        doc.text(cNombre || cEmpresa, M + 32, y + 5.5); doc.text(cRUC, M + halfW + 20, y + 5.5);
        y += rowH;
        cell(M, y, halfW, rowH); cell(M + halfW, y, halfW, rowH);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...cGray);
        doc.text('Direccion:', M + 3, y + 5.5); doc.text('Telefono:', M + halfW + 3, y + 5.5);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...cDark);
        const dirL = doc.splitTextToSize(cDireccion, halfW - 30);
        doc.text(dirL[0] || '', M + 26, y + 5.5); doc.text(cTelefono, M + halfW + 24, y + 5.5);
        y += rowH;
        cell(M, y, halfW, rowH); cell(M + halfW, y, halfW, rowH);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...cGray);
        doc.text('Fecha Emision:', M + 3, y + 5.5); doc.text('Correo:', M + halfW + 3, y + 5.5);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...cDark);
        doc.text(fecha, M + 34, y + 5.5); doc.text(cEmail, M + halfW + 20, y + 5.5);
        y += rowH + 6;

        const colW = [22, 18, 0, 22, 25, 25, 24]; colW[2] = pw - colW.reduce((a, b) => a + b, 0);
        const headers = ['Codigo', 'Cantidad', 'Descripcion', 'Precio\nUnitario', 'Descuento', 'Total', 'Ref.'];
        let cx = M;
        headers.forEach((h, i) => {
            cell(cx, y, colW[i], 10, { fill: cHeaderBg });
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...cDark);
            const lines = h.split('\n');
            if (lines.length > 1) { doc.text(lines[0], cx + colW[i]/2, y + 4, {align:'center'}); doc.text(lines[1], cx + colW[i]/2, y + 8, {align:'center'}); }
            else { doc.text(h, cx + colW[i]/2, y + 6.5, {align:'center'}); }
            cx += colW[i];
        });
        y += 10;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...cDark);
        for (let ii = 0; ii < items.length; ii++) {
            const it = items[ii];
            const imp = (it.cantidad||0)*(it.precio_unitario||0);
            const hasImg = it.imagen_url && it.imagen_url.length > 5;
            const dL = doc.splitTextToSize(it.descripcion||'', colW[2]-4);
            const textH = dL.length*4+4;
            const rH = Math.max(hasImg ? 24 : 8, textH);
            if (y+rH > H-40) { doc.addPage(); y = M; }
            const vals = [it.codigo||'', String(it.cantidad||0), '', fmtN(it.precio_unitario||0, 3), '$'+fmtN(imp, 2), ''];
            cx = M;
            vals.forEach((v, j) => {
                cell(cx, y, colW[j], rH);
                if (j===2) { doc.text(dL, cx+2, y+4); }
                else if (j===5) { if (hasImg) { try { doc.addImage(it.imagen_url, 'JPEG', cx+2, y+1.5, 20, rH-3); } catch(e) {} } }
                else { const tx = j>=3 ? cx+colW[j]-3 : cx+3; const ao = j>=3?{align:'right'}:{};
                    if(j===4) doc.setFont('helvetica','bold'); doc.text(v, tx, y+rH/2+1.5, ao); if(j===4) doc.setFont('helvetica','normal'); }
                cx += colW[j];
            });
            y += rH;
        }
        y += 8;
        if (y > H-55) { doc.addPage(); y = M; }
        const totX = M+pw*0.55, totW2 = pw*0.45, totLW = totW2*0.55, totVW = totW2*0.45;
        doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...cDark);
        if (_sub0 > 0) { cell(totX,y,totLW,8); cell(totX+totLW,y,totVW,8); doc.text('Subtotal IVA 0%',totX+3,y+5.5); doc.text('$'+fmtN(_sub0, 2),totX+totW2-3,y+5.5,{align:'right'}); y+=8; }
        if (_sub15 > 0) { cell(totX,y,totLW,8); cell(totX+totLW,y,totVW,8); doc.text('Subtotal IVA 15%',totX+3,y+5.5); doc.text('$'+fmtN(_sub15, 2),totX+totW2-3,y+5.5,{align:'right'}); y+=8; }
        cell(totX,y,totLW,8); cell(totX+totLW,y,totVW,8);
        doc.text('Subtotal',totX+3,y+5.5); doc.text('$'+fmtN(subtotal, 2),totX+totW2-3,y+5.5,{align:'right'}); y+=8;
        cell(totX,y,totLW,8); cell(totX+totLW,y,totVW,8);
        doc.text('IVA 15%',totX+3,y+5.5); doc.text('$'+fmtN(iva, 2),totX+totW2-3,y+5.5,{align:'right'}); y+=8;
        cell(totX,y,totLW,10,{fill:cHeaderBg}); cell(totX+totLW,y,totVW,10,{fill:cHeaderBg});
        doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...cPrimary);
        doc.text('TOTAL', totX+3, y+7); doc.setTextColor(22,163,74);
        doc.text('$'+fmtN(total, 2), totX+totW2-3, y+7, {align:'right'}); y+=18;

        if (y > H-30) { doc.addPage(); y = M; }
        cell(M,y,halfW,8); cell(M+halfW,y,halfW,8);
        doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...cGray);
        doc.text('Tiempo de Entrega:', M+3, y+5.5); doc.text('Forma de Pago:', M+halfW+3, y+5.5); y+=8;
        const teL = doc.splitTextToSize(tiempoEntrega, halfW-6), fpL = doc.splitTextToSize(formaPago, halfW-6);
        const condH = Math.max(teL.length, fpL.length)*4+4;
        cell(M,y,halfW,condH); cell(M+halfW,y,halfW,condH);
        doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...cDark);
        doc.text(teL, M+3, y+4); doc.text(fpL, M+halfW+3, y+4);

        return doc.output('blob');
    }

    // Subir PDF a Supabase Storage y retornar URL publica
    async function subirProformaPDF() {
        const blob = generarProformaPDFBlob();
        if (!blob) { alert('Error al generar el PDF'); return null; }

        const fileName = `proformas/Proforma_${proformaActiva.numero}_${Date.now()}.pdf`;

        const { data, error } = await db.storage
            .from('imagenes-referencia')
            .upload(fileName, blob, { contentType: 'application/pdf', upsert: true });

        if (error) {
            console.error('Error subiendo PDF:', error);
            alert('Error al subir el PDF: ' + error.message);
            return null;
        }

        const { data: urlData } = db.storage.from('imagenes-referencia').getPublicUrl(fileName);
        return urlData.publicUrl;
    }

    // Extraer numero celular valido para WhatsApp
    function formatearTelefonoWA(tel) {
        if (!tel) return '';
        // Si hay varios numeros separados por / o - o , tomar el celular (empieza con 09)
        const parts = tel.split(/[\/,;]+/).map(p => p.trim());
        let celular = '';
        for (const p of parts) {
            const digits = p.replace(/\D/g, '');
            // Celular Ecuador: empieza con 09 y tiene 10 digitos
            if (digits.match(/^09\d{8}$/)) { celular = digits; break; }
            // Ya con codigo pais
            if (digits.match(/^5939\d{8}$/)) { celular = digits; break; }
        }
        // Si no encontro celular, intentar con el primer numero que parezca valido
        if (!celular) {
            const digits = parts[0]?.replace(/\D/g, '') || '';
            if (digits.length >= 9) celular = digits;
        }
        if (!celular) return '';
        // Quitar 0 inicial y agregar 593
        if (!celular.startsWith('593')) {
            celular = celular.startsWith('0') ? celular.substring(1) : celular;
            celular = '593' + celular;
        }
        return celular;
    }

    async function enviarProformaWhatsApp() {
        if (!proformaActiva) return;

        // Mostrar que estamos generando
        const btn = event?.target;
        const originalText = btn?.textContent;
        if (btn) btn.textContent = '⏳...';

        const pdfUrl = await subirProformaPDF();

        if (btn) btn.textContent = originalText;
        if (!pdfUrl) return;

        const items = proformaActiva.items || [];
        let _s0 = 0, _s15 = 0;
        items.forEach(it => { const imp = (it.cantidad||0)*(it.precio_unitario||0);
            if ((it.iva_pct !== undefined ? it.iva_pct : 15) === 0) _s0 += imp; else _s15 += imp; });
        const total = round2(_s0 + _s15) + calcIVA(_s15, 15);

        let msg = `*PROFORMA #${proformaActiva.numero}*\n`;
        msg += `INGENIA - Experiencia Creativa\n\n`;
        if (proformaActiva.cliente_nombre) msg += `Cliente: ${proformaActiva.cliente_nombre}\n`;
        msg += `Fecha: ${new Date().toLocaleDateString('es-EC')}\n`;
        msg += `*TOTAL: $${fmtN(total, 2)}*\n\n`;
        msg += `📄 *Descarga tu proforma aqui:*\n${pdfUrl}\n\n`;
        msg += `Quedamos atentos a tus comentarios.`;

        const waPhone = formatearTelefonoWA(proformaActiva.cliente_telefono);
        const url = waPhone
            ? `https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`
            : `https://wa.me/?text=${encodeURIComponent(msg)}`;
        window.open(url, '_blank');
    }

    async function enviarProformaEmail() {
        if (!proformaActiva) return;

        const btn = event?.target;
        const originalText = btn?.textContent;
        if (btn) btn.textContent = '⏳...';

        const pdfUrl = await subirProformaPDF();

        if (btn) btn.textContent = originalText;
        if (!pdfUrl) return;

        const items = proformaActiva.items || [];
        let _s0 = 0, _s15 = 0;
        items.forEach(it => { const imp = (it.cantidad||0)*(it.precio_unitario||0);
            if ((it.iva_pct !== undefined ? it.iva_pct : 15) === 0) _s0 += imp; else _s15 += imp; });
        const total = round2(_s0 + _s15) + calcIVA(_s15, 15);

        const subject = `Proforma #${proformaActiva.numero} - INGENIA`;
        let body = `Estimado/a ${proformaActiva.cliente_nombre || 'cliente'},\n\n`;
        body += `Le enviamos la Proforma #${proformaActiva.numero} por un total de $${fmtN(total, 2)}.\n\n`;
        body += `Puede descargar su proforma en PDF aqui:\n${pdfUrl}\n\n`;
        body += `Tiempo de entrega: ${document.getElementById('profTiempoEntrega').value}\n`;
        body += `Forma de pago: ${document.getElementById('profFormaPago').value}\n\n`;
        body += `Quedamos atentos.\nINGENIA - Experiencia Creativa`;

        const email = proformaActiva.cliente_email || '';
        window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    }

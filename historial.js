// =====================================================
// MODULO HISTORIAL DE PRODUCTOS POR CLIENTE (sub-tab de Clientes)
// Busca en analisis_items_facturas: el detalle linea a linea de las
// facturas importadas (producto, detalle, cantidad, precio unitario).
// Usa globales: db, escapeHtml.
// =====================================================

    const HIST_MAX_ROWS = 2000;   // tope de lineas que se traen por busqueda
    const HIST_MAX_RENDER = 500;  // tope de filas que se pintan en la tabla

    let histClientesCache = null;  // nombres de cliente distintos que aparecen en los items
    let histRows = [];             // ultimo resultado (lineas de factura)
    let histGrupos = [];           // ultimo resultado agrupado por producto
    let histFacturasMap = {};      // numero_factura -> { estado, estado_pago, saldo }
    let histVista = 'resumen';     // 'resumen' | 'detalle'
    let histGrupoFiltro = null;    // clave de producto seleccionada desde el resumen
    let histAproximado = false;    // el resultado vino de la pasada tolerante a erratas

    // =====================================================
    // Normalizacion y matching tolerante
    // =====================================================

    // minusculas, sin acentos (Fenix == Fénix), sin puntuacion
    function histNorm(s) {
        return (s === null || s === undefined ? '' : String(s))
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // distancia de edicion acotada: true si se pueden pasar de a a b con <= max cambios
    function histCerca(a, b, max) {
        if (a === b) return true;
        if (Math.abs(a.length - b.length) > max) return false;
        let prev = [];
        for (let j = 0; j <= b.length; j++) prev[j] = j;
        for (let i = 1; i <= a.length; i++) {
            const fila = [i];
            let mejor = i;
            for (let j = 1; j <= b.length; j++) {
                const coste = a[i - 1] === b[j - 1] ? 0 : 1;
                fila[j] = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + coste);
                if (fila[j] < mejor) mejor = fila[j];
            }
            if (mejor > max) return false;  // corte temprano
            prev = fila;
        }
        return prev[b.length] <= max;
    }

    // raiz del token para la busqueda en servidor: "benu" -> "ben" (asi alcanza a "bennu")
    function histTokenRaiz(tok) {
        return tok.slice(0, Math.max(3, Math.floor(tok.length * 0.75)));
    }

    // todos los tokens deben aparecer en el texto; en modo aproximado se admite 1-2 erratas
    function histTokenMatch(tokens, texto, aproximado) {
        const t = histNorm(texto);
        if (!aproximado) return tokens.every(tok => t.indexOf(tok) !== -1);
        const palabras = t.split(' ');
        return tokens.every(tok => {
            if (t.indexOf(tok) !== -1) return true;
            const max = tok.length >= 7 ? 2 : 1;
            return palabras.some(p => histCerca(tok, p, max));
        });
    }

    // PostgREST usa la coma como separador en .or(): la quitamos del valor
    function histSanitizeOr(s) {
        return s.replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // =====================================================
    // Acceso a datos (paginado, por si el proyecto tiene tope de filas)
    // =====================================================

    async function histFetchAll(buildQuery, max) {
        const PAGE = 1000;
        let out = [], desde = 0;
        while (desde < max) {
            const hasta = Math.min(desde + PAGE, max) - 1;
            const { data, error } = await buildQuery().range(desde, hasta);
            if (error) throw error;
            const lote = data || [];
            out = out.concat(lote);
            if (lote.length < (hasta - desde + 1)) break;
            desde += PAGE;
        }
        return out;
    }

    async function histCargarClientes() {
        if (histClientesCache) return;
        try {
            const filas = await histFetchAll(
                () => db.from('analisis_items_facturas').select('cliente').order('cliente'),
                20000
            );
            const set = new Set();
            filas.forEach(r => { if (r.cliente && r.cliente.trim()) set.add(r.cliente.trim()); });
            histClientesCache = Array.from(set).sort((a, b) => a.localeCompare(b));
        } catch (e) {
            console.error('historial: no se pudo cargar la lista de clientes', e);
            histClientesCache = [];
        }
        const list = document.getElementById('histClientesList');
        if (list) list.innerHTML = histClientesCache.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
    }

    // estado de cobro de cada documento (vive en facturas, no en los items)
    async function histCargarFacturas(docs) {
        histFacturasMap = {};
        const lista = Array.from(new Set(docs.filter(Boolean)));
        for (let i = 0; i < lista.length; i += 200) {
            const chunk = lista.slice(i, i + 200);
            const { data, error } = await db.from('facturas')
                .select('numero_factura,estado,estado_pago,saldo,total')
                .in('numero_factura', chunk);
            if (error) { console.error('historial: facturas', error); return; }
            (data || []).forEach(f => { histFacturasMap[f.numero_factura] = f; });
        }
    }

    // Resuelve lo que escribio el usuario contra los nombres reales de la tabla.
    // Hace falta porque el ilike de Postgres NO ignora acentos: buscar "fénix"
    // no encontraria "FENIX HOTEL S.C". Devuelve [] si no hay ningun candidato.
    function histResolverClientes(texto) {
        const t = histNorm(texto);
        if (!t) return null;
        const toks = t.split(' ').filter(Boolean);
        let m = (histClientesCache || []).filter(n => histTokenMatch(toks, n, false));
        if (!m.length) m = (histClientesCache || []).filter(n => histTokenMatch(toks, n, true));
        return m;
    }

    // =====================================================
    // Busqueda
    // =====================================================

    async function histBuscar() {
        const cliente = document.getElementById('histCliente').value.trim();
        const q = document.getElementById('histProducto').value.trim();
        const desde = document.getElementById('histDesde').value;
        const hasta = document.getElementById('histHasta').value;
        const status = document.getElementById('histStatus');

        if (!cliente && !q) {
            histRows = []; histGrupos = []; histGrupoFiltro = null;
            status.innerHTML = '<span style="color:var(--gray-500);">Escribe un cliente o un producto para buscar.</span>';
            histRender();
            return;
        }

        status.innerHTML = '<span style="color:var(--primary);">Buscando...</span>';
        histGrupoFiltro = null;
        histAproximado = false;

        let nombres = null;
        if (cliente) {
            await histCargarClientes();
            nombres = histResolverClientes(cliente);
            if (nombres && !nombres.length) {
                histRows = []; histGrupos = []; histFacturasMap = {};
                status.innerHTML = '<span style="color:var(--gray-500);">Ningun cliente facturado coincide con "'
                    + escapeHtml(cliente) + '".</span>';
                histRender();
                return;
            }
        }

        const base = () => {
            let sel = db.from('analisis_items_facturas').select('*');
            // .in() con los nombres exactos: tolera acentos, mayusculas y erratas.
            // Si el texto abarca demasiados clientes caemos al ilike normal.
            if (nombres && nombres.length && nombres.length <= 100) sel = sel.in('cliente', nombres);
            else if (cliente) sel = sel.ilike('cliente', '%' + cliente + '%');
            if (desde) sel = sel.gte('fecha_emision', desde);
            if (hasta) sel = sel.lte('fecha_emision', hasta);
            return sel.order('fecha_emision', { ascending: false });
        };

        let rows;
        try {
            if (cliente) {
                // Con cliente traemos todas sus lineas y filtramos el producto en memoria:
                // asi la pasada aproximada puede rescatar erratas (benu -> Bennu).
                rows = await histFetchAll(base, HIST_MAX_ROWS);
            } else {
                const qs = histSanitizeOr(q);
                rows = await histFetchAll(
                    () => base().or(`producto.ilike.%${qs}%,detalle.ilike.%${qs}%`),
                    HIST_MAX_ROWS
                );
                if (!rows.length) {
                    // reintento por la raiz del token mas largo, para tolerar erratas
                    const tok = histNorm(qs).split(' ').filter(Boolean).sort((a, b) => b.length - a.length)[0];
                    if (tok && tok.length >= 4) {
                        const raiz = histTokenRaiz(tok);
                        rows = await histFetchAll(
                            () => base().or(`producto.ilike.%${raiz}%,detalle.ilike.%${raiz}%`),
                            HIST_MAX_ROWS
                        );
                    }
                }
            }
        } catch (e) {
            console.error(e);
            status.innerHTML = '<span style="color:var(--danger);">Error consultando: ' + escapeHtml(e.message || e) + '</span>';
            return;
        }

        if (q) {
            const tokens = histNorm(q).split(' ').filter(Boolean);
            if (tokens.length) {
                const texto = r => (r.producto || '') + ' ' + (r.detalle || '');
                let filtradas = rows.filter(r => histTokenMatch(tokens, texto(r), false));
                if (!filtradas.length) {
                    filtradas = rows.filter(r => histTokenMatch(tokens, texto(r), true));
                    histAproximado = filtradas.length > 0;
                }
                rows = filtradas;
            }
        }

        histRows = rows;
        histGrupos = histAgrupar(rows);
        await histCargarFacturas(rows.map(r => r.documento));

        if (!rows.length) {
            status.innerHTML = '<span style="color:var(--gray-500);">Sin resultados.'
                + (q ? ' Prueba con menos palabras o revisa el nombre del cliente.' : '') + '</span>';
        } else {
            const docs = new Set(rows.map(r => r.documento).filter(Boolean));
            const quien = nombres && nombres.length
                ? (nombres.length <= 3 ? nombres.join(', ') : nombres.length + ' clientes')
                : null;
            status.innerHTML = '<span style="color:var(--gray-600);">' + rows.length + ' linea' + (rows.length === 1 ? '' : 's')
                + ' en ' + docs.size + ' factura' + (docs.size === 1 ? '' : 's')
                + (quien ? ' · ' + escapeHtml(quien) : '') + '</span>'
                + (histAproximado ? ' <span style="color:var(--warning);font-weight:600;">· sin coincidencias exactas, se muestran resultados aproximados</span>' : '')
                + (rows.length >= HIST_MAX_ROWS ? ' <span style="color:var(--warning);">· tope de ' + HIST_MAX_ROWS + ' lineas, acota las fechas</span>' : '');
        }
        histRender();
    }

    function histLimpiar() {
        ['histCliente', 'histProducto', 'histDesde', 'histHasta'].forEach(id => { document.getElementById(id).value = ''; });
        histRows = []; histGrupos = []; histGrupoFiltro = null; histAproximado = false; histFacturasMap = {};
        document.getElementById('histStatus').innerHTML = '';
        histRender();
    }

    function histSetVista(v) {
        histVista = v;
        if (v === 'resumen') histGrupoFiltro = null;
        histRender();
    }

    // entrada desde el boton "Historial" del directorio de clientes
    function histDesdeCliente(nombre) {
        cliSwitchSub('historial');
        document.getElementById('histCliente').value = nombre || '';
        document.getElementById('histProducto').value = '';
        histBuscar();
    }

    // =====================================================
    // Agrupacion por producto
    // =====================================================

    function histAgrupar(rows) {
        const map = {};
        rows.forEach(r => {
            const key = histNorm(r.producto || '') || '(sin producto)';
            if (!map[key]) {
                map[key] = {
                    key: key,
                    producto: r.producto || '(sin producto)',
                    categoria: r.categoria || '',
                    lineas: 0, docs: new Set(), unidades: 0, importe: 0,
                    ultima: null, ultimoPrecio: null, min: null, max: null
                };
            }
            const g = map[key];
            g.lineas++;
            if (r.documento) g.docs.add(r.documento);
            g.unidades += Number(r.cantidad) || 0;
            g.importe += Number(r.total_item) || 0;
            const pu = Number(r.precio_unit);
            if (!isNaN(pu) && pu > 0) {
                g.min = g.min === null ? pu : Math.min(g.min, pu);
                g.max = g.max === null ? pu : Math.max(g.max, pu);
            }
            const f = r.fecha_emision || '';
            if (!g.ultima || f > g.ultima) { g.ultima = f; g.ultimoPrecio = isNaN(pu) ? null : pu; }
        });
        return Object.keys(map).map(k => map[k]).sort((a, b) => (b.ultima || '').localeCompare(a.ultima || ''));
    }

    // =====================================================
    // Render
    // =====================================================

    function histMoney(n) {
        const v = Number(n);
        return isNaN(v) ? '—' : v.toFixed(2);
    }

    function histNum(n) {
        const v = Number(n);
        if (isNaN(v)) return '—';
        return v % 1 === 0 ? String(v) : v.toFixed(2);
    }

    function histEstado(doc) {
        const f = histFacturasMap[doc];
        if (!f) return '<span style="color:var(--gray-400);">—</span>';
        const chip = (bg, color, txt) => '<span style="background:' + bg + ';color:' + color
            + ';padding:0.1rem 0.4rem;border-radius:4px;font-size:0.68rem;font-weight:600;white-space:nowrap;">' + txt + '</span>';
        if ((f.estado || '').toLowerCase() === 'anulada') return chip('var(--gray-100)', 'var(--gray-500)', 'Anulada');
        if (Number(f.saldo) > 0 || f.estado_pago === 'pendiente') return chip('var(--warning-light)', '#92400e', 'Pendiente ' + histMoney(f.saldo));
        return chip('var(--success-light)', '#166534', 'Cobrada');
    }

    function histRender() {
        const cont = document.getElementById('histResultados');
        const stats = document.getElementById('histStats');
        const tabs = document.getElementById('histVistaTabs');
        if (!cont) return;

        if (!histRows.length) {
            cont.innerHTML = '';
            stats.innerHTML = '';
            tabs.style.display = 'none';
            return;
        }
        tabs.style.display = 'flex';
        document.getElementById('histTabResumen').classList.toggle('active', histVista === 'resumen');
        document.getElementById('histTabDetalle').classList.toggle('active', histVista === 'detalle');

        // --- tarjetas resumen ---
        const docs = new Set(histRows.map(r => r.documento).filter(Boolean));
        const importe = histRows.reduce((s, r) => s + (Number(r.total_item) || 0), 0);
        const fechas = histRows.map(r => r.fecha_emision).filter(Boolean).sort();
        const stat = (k, v) => '<div class="hist-stat"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
        stats.innerHTML = stat('Productos', histGrupos.length)
            + stat('Facturas', docs.size)
            + stat('Lineas', histRows.length)
            + stat('Facturado', '$' + histMoney(importe))
            + (fechas.length ? stat('Periodo', fechas[0] + ' a ' + fechas[fechas.length - 1]) : '');

        cont.innerHTML = histVista === 'resumen' ? histRenderResumen() : histRenderDetalle();
    }

    function histRenderResumen() {
        const filas = histGrupos.map((g, i) => {
            const rango = (g.min === null) ? '—'
                : (g.min === g.max ? histMoney(g.min) : histMoney(g.min) + ' – ' + histMoney(g.max));
            return '<tr>'
                + '<td><strong>' + escapeHtml(g.producto) + '</strong>'
                + (g.categoria ? '<div style="font-size:0.7rem;color:var(--gray-400);">' + escapeHtml(g.categoria) + '</div>' : '') + '</td>'
                + '<td style="text-align:right;">' + g.docs.size + '</td>'
                + '<td style="text-align:right;">' + histNum(g.unidades) + '</td>'
                + '<td style="text-align:right;"><strong>' + histMoney(g.ultimoPrecio) + '</strong></td>'
                + '<td style="text-align:right;color:var(--gray-500);">' + rango + '</td>'
                + '<td style="text-align:right;">' + histMoney(g.importe) + '</td>'
                + '<td style="white-space:nowrap;">' + escapeHtml(g.ultima || '—') + '</td>'
                + '<td><button class="btn btn-sm" style="border:1px solid var(--gray-300);" onclick="histVerLineas(' + i + ')">Ver lineas</button></td>'
                + '</tr>';
        }).join('');

        return '<div class="panel" style="overflow-x:auto;">'
            + '<table class="data-table" style="min-width:820px;"><thead><tr>'
            + '<th>Producto</th><th style="text-align:right;">Facturas</th><th style="text-align:right;">Unidades</th>'
            + '<th style="text-align:right;">Ultimo precio</th><th style="text-align:right;">Rango precio</th>'
            + '<th style="text-align:right;">Facturado</th><th>Ultima vez</th><th style="width:100px;"></th>'
            + '</tr></thead><tbody>' + filas + '</tbody></table></div>';
    }

    function histRenderDetalle() {
        let rows = histRows;
        let chip = '';
        if (histGrupoFiltro) {
            rows = rows.filter(r => (histNorm(r.producto || '') || '(sin producto)') === histGrupoFiltro);
            const g = histGrupos.find(x => x.key === histGrupoFiltro);
            chip = '<div style="margin-bottom:0.6rem;font-size:0.8rem;">Producto: '
                + '<span style="background:var(--primary-light);color:var(--primary-dark);padding:0.2rem 0.5rem;border-radius:6px;font-weight:600;">'
                + escapeHtml(g ? g.producto : histGrupoFiltro)
                + ' <a href="#" onclick="histQuitarFiltro();return false;" style="color:var(--primary-dark);text-decoration:none;">×</a></span></div>';
        }

        const recortado = rows.length > HIST_MAX_RENDER;
        const filas = rows.slice(0, HIST_MAX_RENDER).map(r => {
            const dscto = Number(r.descuento_pct) || 0;
            return '<tr>'
                + '<td style="white-space:nowrap;">' + escapeHtml(r.fecha_emision || '—') + '</td>'
                + '<td style="white-space:nowrap;font-size:0.75rem;">' + escapeHtml(r.documento || '—') + '</td>'
                + '<td>' + escapeHtml(r.cliente || '—') + '</td>'
                + '<td><strong>' + escapeHtml(r.producto || '—') + '</strong>'
                + (r.detalle ? '<div style="font-size:0.73rem;color:var(--gray-500);">' + escapeHtml(r.detalle) + '</div>' : '') + '</td>'
                + '<td style="text-align:right;">' + histNum(r.cantidad) + '</td>'
                + '<td style="text-align:right;"><strong>' + histMoney(r.precio_unit) + '</strong></td>'
                + '<td style="text-align:right;color:var(--gray-500);">' + (dscto ? dscto + '%' : '—') + '</td>'
                + '<td style="text-align:right;">' + histMoney(r.total_item) + '</td>'
                + '<td>' + histEstado(r.documento) + '</td>'
                + '</tr>';
        }).join('');

        return chip + '<div class="panel" style="overflow-x:auto;">'
            + '<table class="data-table" style="min-width:980px;"><thead><tr>'
            + '<th>Fecha</th><th>Documento</th><th>Cliente</th><th>Producto / detalle</th>'
            + '<th style="text-align:right;">Cant.</th><th style="text-align:right;">P. unit</th>'
            + '<th style="text-align:right;">Dscto</th><th style="text-align:right;">Total</th><th>Estado</th>'
            + '</tr></thead><tbody>' + filas + '</tbody></table>'
            + (recortado ? '<div style="padding:0.6rem 1rem;font-size:0.78rem;color:var(--warning);">Mostrando las primeras '
                + HIST_MAX_RENDER + ' de ' + rows.length + ' lineas. Exporta el CSV para verlas todas.</div>' : '')
            + '</div>';
    }

    function histVerLineas(i) {
        const g = histGrupos[i];
        if (!g) return;
        histGrupoFiltro = g.key;
        histVista = 'detalle';
        histRender();
    }

    function histQuitarFiltro() {
        histGrupoFiltro = null;
        histRender();
    }

    // =====================================================
    // Export CSV
    // =====================================================

    function histExportCSV() {
        if (!histRows.length) { alert('No hay resultados para exportar'); return; }
        const esc = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
        const lineas = [['Fecha', 'Documento', 'Cliente', 'Producto', 'Detalle', 'Cantidad', 'Precio unit',
            'Descuento %', 'Total', 'Categoria', 'Estado factura', 'Saldo factura'].map(esc).join(';')];
        histRows.forEach(r => {
            const f = histFacturasMap[r.documento] || {};
            lineas.push([r.fecha_emision, r.documento, r.cliente, r.producto, r.detalle, r.cantidad,
                r.precio_unit, r.descuento_pct, r.total_item, r.categoria, f.estado, f.saldo].map(esc).join(';'));
        });
        const blob = new Blob(['\ufeff' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'historial-productos-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    // =====================================================
    // Sub-tabs de Clientes
    // =====================================================

    function cliSwitchSub(sub) {
        document.querySelectorAll('.cli-sub').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.cli-subtab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById('cli-sub-' + sub).classList.add('active');
        document.getElementById('cliSubBtn' + sub.charAt(0).toUpperCase() + sub.slice(1)).classList.add('active');
        const btnNuevo = document.getElementById('cliBtnNuevo');
        if (btnNuevo) btnNuevo.style.display = sub === 'directorio' ? '' : 'none';
        if (sub === 'historial') histCargarClientes();
    }

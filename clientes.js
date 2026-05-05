// =====================================================
// MODULO CLIENTES (tab)
// Extraido de index.html — usa globales: db, escapeHtml, clientsCache.
// =====================================================

    let clientesTabCache = [];
    let editingClienteId = null;

    async function cargarClientesTab() {
        const { data, error } = await db.from('clientes').select('*').order('nombre');
        if (error) { console.error(error); return; }
        clientesTabCache = data || [];
        renderClientesTab(clientesTabCache);
    }

    function buscarClientesTab() {
        const q = document.getElementById('clientesBuscar').value.toLowerCase().trim();
        if (!q) { renderClientesTab(clientesTabCache); return; }
        const filtered = clientesTabCache.filter(c =>
            (c.nombre || '').toLowerCase().includes(q) ||
            (c.empresa || '').toLowerCase().includes(q) ||
            (c.rfc || '').toLowerCase().includes(q)
        );
        renderClientesTab(filtered);
    }

    function renderClientesTab(clientes) {
        const body = document.getElementById('clientesTabBody');
        const empty = document.getElementById('clientesEmpty');
        if (!clientes.length) { body.innerHTML = ''; empty.style.display = 'block'; return; }
        empty.style.display = 'none';

        body.innerHTML = clientes.map(c => {
            if (editingClienteId === c.id) {
                return `<tr class="editing">
                    <td><input type="text" id="editNombre${c.id}" value="${escapeHtml(c.nombre || '')}"></td>
                    <td><input type="text" id="editEmpresa${c.id}" value="${escapeHtml(c.empresa || '')}"></td>
                    <td><input type="text" id="editRFC${c.id}" value="${escapeHtml(c.rfc || '')}"></td>
                    <td><input type="email" id="editEmail${c.id}" value="${escapeHtml(c.email || '')}"></td>
                    <td><input type="text" id="editTelefono${c.id}" value="${escapeHtml(c.telefono || '')}"></td>
                    <td><input type="text" id="editDireccion${c.id}" value="${escapeHtml(c.direccion || '')}"></td>
                    <td>
                        <button class="btn btn-success btn-sm" onclick="guardarClienteEdit(${c.id})">Guardar</button>
                        <button class="btn btn-sm" style="border:1px solid var(--gray-300);margin-top:0.25rem;" onclick="cancelarClienteEdit()">Cancelar</button>
                    </td>
                </tr>`;
            }
            return `<tr>
                <td><strong>${escapeHtml(c.nombre || '-')}</strong></td>
                <td>${escapeHtml(c.empresa || '-')}</td>
                <td>${escapeHtml(c.rfc || '-')}</td>
                <td>${escapeHtml(c.email || '-')}</td>
                <td>${escapeHtml(c.telefono || '-')}</td>
                <td>${escapeHtml(c.direccion || '-')}</td>
                <td>
                    <button class="btn btn-sm" style="border:1px solid var(--gray-300);" onclick="editarCliente(${c.id})">Editar</button>
                </td>
            </tr>`;
        }).join('');
    }

    function editarCliente(id) {
        editingClienteId = id;
        renderClientesTab(document.getElementById('clientesBuscar').value.trim()
            ? clientesTabCache.filter(c =>
                (c.nombre || '').toLowerCase().includes(document.getElementById('clientesBuscar').value.toLowerCase()) ||
                (c.empresa || '').toLowerCase().includes(document.getElementById('clientesBuscar').value.toLowerCase()) ||
                (c.rfc || '').toLowerCase().includes(document.getElementById('clientesBuscar').value.toLowerCase())
            )
            : clientesTabCache
        );
    }

    function cancelarClienteEdit() {
        editingClienteId = null;
        buscarClientesTab();
    }

    async function guardarClienteEdit(id) {
        const updates = {
            nombre: document.getElementById('editNombre' + id).value.trim(),
            empresa: document.getElementById('editEmpresa' + id).value.trim() || null,
            rfc: document.getElementById('editRFC' + id).value.trim() || null,
            email: document.getElementById('editEmail' + id).value.trim() || null,
            telefono: document.getElementById('editTelefono' + id).value.trim() || null,
            direccion: document.getElementById('editDireccion' + id).value.trim() || null
        };

        if (!updates.nombre) { alert('El nombre es requerido'); return; }

        const { error } = await db.from('clientes').update(updates).eq('id', id);
        if (error) { alert('Error: ' + error.message); return; }

        editingClienteId = null;
        clientsCache = []; // Reset autocomplete cache
        await cargarClientesTab();
    }

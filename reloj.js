// =====================================================
// RELOJ (timbradas + horas extras Ecuador)
// =====================================================
// Modulo extraido de index.html el 2026-05-04.
// Depende de globales del script principal: db, staffCache, loadStaff, currentUser, escapeHtml.
// Se carga via <script src="reloj.js"> despues del script principal.

let _relojClockInterval = null;
let _relojRefreshInterval = null;
let _relojStaffActual = null;

function relojFmtHora(d) {
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
}
function relojFmtFechaLarga(d) {
    return d.toLocaleDateString('es-EC', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}
function relojFmtHorasMin(horas) {
    const h = Math.floor(horas);
    const m = Math.round((horas - h) * 60);
    return `${h}h ${String(m).padStart(2,'0')}m`;
}

async function relojInit() {
    if (!staffCache.length) await loadStaff();
    const sel = document.getElementById('relojStaffSelect');
    const adminSel = document.getElementById('relojAdminStaff');
    const activos = staffCache.filter(s => s.activo);
    sel.innerHTML = activos.map(s => `<option value="${s.id}">${escapeHtml(s.nombre)}</option>`).join('');
    adminSel.innerHTML = '<option value="">Todos</option>' + activos.map(s => `<option value="${s.id}">${escapeHtml(s.nombre)}</option>`).join('');

    // Buscar el staff vinculado al usuario logueado
    const meStaff = activos.find(s => (s.email||'').toLowerCase() === (currentUser?.email||'').toLowerCase());
    const esAdmin = !!meStaff?.es_admin;

    // Mostrar/ocultar boton de vista admin segun permisos
    document.getElementById('relojBtnVistaAdmin').style.display = esAdmin ? '' : 'none';

    // Reloj que tickea cada segundo (siempre)
    if (_relojClockInterval) clearInterval(_relojClockInterval);
    _relojClockInterval = setInterval(relojTick, 1000);
    relojTick();

    if (!meStaff) {
        // Usuario sin staff vinculado: bloquear todo
        document.getElementById('relojSinStaffMsg').style.display = 'block';
        document.getElementById('relojBtnTimbrar').style.display = 'none';
        document.getElementById('relojSaludo').textContent = '';
        document.getElementById('relojEstado').style.display = 'none';
        document.getElementById('relojResumenHoy').style.display = 'none';
        document.getElementById('relojTimbradasHoy').style.display = 'none';
        return;
    }

    sel.value = meStaff.id;
    document.getElementById('relojSinStaffMsg').style.display = 'none';
    document.getElementById('relojBtnTimbrar').style.display = '';
    document.getElementById('relojEstado').style.display = '';
    document.getElementById('relojResumenHoy').style.display = '';
    document.getElementById('relojTimbradasHoy').style.display = '';

    // Default rango admin: este mes
    if (esAdmin) relojAdminRangoMes();

    await relojCargarEstado();
}

function relojTick() {
    const ahora = new Date();
    const hEl = document.getElementById('relojHora');
    const fEl = document.getElementById('relojFecha');
    if (hEl) hEl.textContent = relojFmtHora(ahora);
    if (fEl) fEl.textContent = relojFmtFechaLarga(ahora);

    // Si hay timbrada de entrada abierta, ir sumando segundos en vivo
    if (_relojStaffActual && _relojStaffActual.ultimo_tipo === 'entrada' && _relojStaffActual.ultimo_ts) {
        const ultEntrada = new Date(_relojStaffActual.ultimo_ts);
        const horasBase = +(_relojStaffActual.horas_acumuladas_cerradas || 0);
        const extra = (ahora - ultEntrada) / 3600000;
        const total = horasBase + extra;
        const elH = document.getElementById('relojHorasHoy');
        if (elH) elH.textContent = relojFmtHorasMin(total);
    }
}

function relojSwitchVista(v) {
    // Bloquear vista admin para no-admins
    if (v === 'admin') {
        const meStaff = staffCache.find(s => (s.email||'').toLowerCase() === (currentUser?.email||'').toLowerCase());
        if (!meStaff?.es_admin) { alert('Solo administradores pueden ver este resumen.'); return; }
    }
    document.getElementById('relojVistaTrabajador').style.display = v === 'trabajador' ? '' : 'none';
    document.getElementById('relojVistaAdmin').style.display = v === 'admin' ? '' : 'none';
    document.getElementById('relojBtnVistaTrabajador').classList.toggle('active', v === 'trabajador');
    document.getElementById('relojBtnVistaAdmin').classList.toggle('active', v === 'admin');
    if (v === 'admin') {
        relojAdminCargarEstadoHoy();
        relojAdminCargar();
    }
}

async function relojCargarEstado() {
    const sel = document.getElementById('relojStaffSelect');
    const staffId = +sel.value;
    if (!staffId) return;
    const staffData = staffCache.find(s => s.id === staffId);
    document.getElementById('relojSaludo').textContent = `Hola, ${staffData?.nombre || ''}`;

    const { data, error } = await db.rpc('fichajes_estado_actual', { p_staff_id: staffId });
    if (error) { console.error('estado actual', error); return; }

    // Guardar para el tick — ademas calcular horas cerradas (sin contar el tramo abierto en curso)
    const eventos = data.eventos || [];
    let horasCerradas = 0;
    for (let i = 0; i < eventos.length - 1; i++) {
        if (eventos[i].tipo === 'entrada' && eventos[i+1].tipo === 'salida') {
            horasCerradas += (new Date(eventos[i+1].ts) - new Date(eventos[i].ts)) / 3600000;
        }
    }
    _relojStaffActual = {
        ultimo_tipo: data.ultimo_tipo,
        ultimo_ts: data.ultimo_ts,
        horas_acumuladas_cerradas: horasCerradas,
        staff_id: staffId
    };

    // UI estado
    const elEstado = document.getElementById('relojEstado');
    const btn = document.getElementById('relojBtnTimbrar');
    if (data.ultimo_tipo === 'entrada') {
        const desde = new Date(data.ultimo_ts);
        elEstado.innerHTML = `🟢 <strong>Trabajando</strong> · entrada ${relojFmtHora(desde)}`;
        elEstado.style.background = '#dcfce7';
        elEstado.style.color = '#166534';
        btn.textContent = '⏹ TIMBRAR SALIDA';
        btn.style.background = '#dc2626';
        btn.style.boxShadow = '0 4px 12px rgba(220,38,38,0.25)';
    } else if (data.ultimo_tipo === 'salida') {
        const ult = new Date(data.ultimo_ts);
        elEstado.innerHTML = `⏸ Última salida: ${relojFmtHora(ult)}`;
        elEstado.style.background = '#fef3c7';
        elEstado.style.color = '#92400e';
        btn.textContent = '⏵ TIMBRAR ENTRADA';
        btn.style.background = '#16a34a';
        btn.style.boxShadow = '0 4px 12px rgba(22,163,74,0.25)';
    } else {
        elEstado.innerHTML = '⚪ Sin timbradas hoy';
        elEstado.style.background = 'var(--gray-100)';
        elEstado.style.color = 'var(--gray-600)';
        btn.textContent = '⏵ TIMBRAR ENTRADA';
        btn.style.background = '#16a34a';
        btn.style.boxShadow = '0 4px 12px rgba(22,163,74,0.25)';
    }

    // Horas trabajadas hoy (las cerradas, el tick suma las abiertas en vivo)
    document.getElementById('relojHorasHoy').textContent = relojFmtHorasMin(+data.horas_hoy || 0);

    // Lista de timbradas
    const tEl = document.getElementById('relojTimbradasHoy');
    if (!eventos.length) {
        tEl.innerHTML = '<div style="color:var(--gray-400);text-align:center;padding:0.5rem;">Sin timbradas hoy</div>';
    } else {
        tEl.innerHTML = '<div style="font-weight:600;color:var(--gray-500);font-size:0.75rem;text-transform:uppercase;margin-bottom:0.4rem;">Timbradas de hoy</div>' +
            eventos.map(e => {
                const t = new Date(e.ts);
                const icon = e.tipo === 'entrada' ? '🟢' : '🔴';
                const lbl = e.tipo === 'entrada' ? 'Entrada' : 'Salida';
                return `<div style="display:flex;justify-content:space-between;padding:0.35rem 0.5rem;border-bottom:1px solid var(--gray-100);">
                    <span>${icon} ${lbl}</span>
                    <span style="font-variant-numeric:tabular-nums;color:var(--gray-600);">${relojFmtHora(t)}</span>
                </div>`;
            }).join('');
    }
}

async function relojTimbrar() {
    const sel = document.getElementById('relojStaffSelect');
    const staffId = +sel.value;
    if (!staffId) { alert('Selecciona un trabajador'); return; }
    const btn = document.getElementById('relojBtnTimbrar');
    const labelOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ ...';
    try {
        const { data, error } = await db.rpc('fichajes_timbrar', { p_staff_id: staffId, p_nota: null });
        if (error) throw error;
        // Pequeño feedback visual
        btn.textContent = data.tipo === 'entrada' ? '✅ Entrada registrada' : '✅ Salida registrada';
        setTimeout(() => relojCargarEstado(), 600);
    } catch (e) {
        alert('Error al timbrar: ' + (e?.message || e));
        btn.textContent = labelOriginal;
    } finally {
        setTimeout(() => { btn.disabled = false; }, 800);
    }
}

// ============== Vista admin ==============

function _relojFmtFechaInput(d) {
    return d.toISOString().slice(0,10);
}

function relojAdminRangoSemana() {
    const hoy = new Date();
    const dow = hoy.getDay(); // 0=dom
    const diff = (dow === 0 ? 6 : dow - 1); // ir al lunes
    const lunes = new Date(hoy); lunes.setDate(hoy.getDate() - diff);
    document.getElementById('relojAdminDesde').value = _relojFmtFechaInput(lunes);
    document.getElementById('relojAdminHasta').value = _relojFmtFechaInput(hoy);
    relojAdminCargar();
}
function relojAdminRangoMes() {
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    document.getElementById('relojAdminDesde').value = _relojFmtFechaInput(desde);
    document.getElementById('relojAdminHasta').value = _relojFmtFechaInput(hoy);
    relojAdminCargar();
}
function relojAdminRangoMesPasado() {
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const hasta = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
    document.getElementById('relojAdminDesde').value = _relojFmtFechaInput(desde);
    document.getElementById('relojAdminHasta').value = _relojFmtFechaInput(hasta);
    relojAdminCargar();
}

async function relojAdminCargar() {
    const desde = document.getElementById('relojAdminDesde').value;
    const hasta = document.getElementById('relojAdminHasta').value;
    const staffId = document.getElementById('relojAdminStaff').value;
    if (!desde || !hasta) return;
    const cont = document.getElementById('relojAdminResultados');
    cont.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--gray-400);">Cargando…</div>';

    const staffList = staffId ? staffCache.filter(s => s.id === +staffId) : staffCache.filter(s => s.activo);

    const resultados = await Promise.all(staffList.map(async s => {
        const { data, error } = await db.rpc('fichajes_calcular_horas', {
            p_staff_id: s.id, p_fecha_inicio: desde, p_fecha_fin: hasta
        });
        if (error) console.error(s.nombre, error);
        return { staff: s, dias: data || [] };
    }));

    let html = '';
    for (const r of resultados) {
        const totT = r.dias.reduce((a,d) => a + (+d.horas_trabajadas||0), 0);
        const totN = r.dias.reduce((a,d) => a + (+d.horas_normales||0), 0);
        const totS = r.dias.reduce((a,d) => a + (+d.horas_suplementarias||0), 0);
        const totE = r.dias.reduce((a,d) => a + (+d.horas_extraordinarias||0), 0);
        const recargoSup = totS * 0.5;
        const recargoExt = totE * 1.0;

        html += `<div class="panel" style="margin-bottom:1rem;">
            <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;">
                <span>${escapeHtml(r.staff.nombre)} <small style="color:var(--gray-500);font-weight:400;">${escapeHtml(r.staff.rol||'')}</small></span>
                <span style="font-size:0.85rem;color:var(--gray-500);">${r.dias.length} días con timbradas</span>
            </div>
            <div class="panel-body" style="padding:0.75rem;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.5rem;margin-bottom:1rem;">
                    ${_relojCard('Total trabajado', relojFmtHorasMin(totT), '#1e293b', '#f1f5f9')}
                    ${_relojCard('Normales (8h L-V)', relojFmtHorasMin(totN), '#0f766e', '#ccfbf1')}
                    ${_relojCard('Suplementarias +50%', relojFmtHorasMin(totS) + ' (=' + relojFmtHorasMin(totS+recargoSup) + ' pago)', '#9a3412', '#ffedd5')}
                    ${_relojCard('Extraordinarias +100%', relojFmtHorasMin(totE) + ' (=' + relojFmtHorasMin(totE+recargoExt) + ' pago)', '#991b1b', '#fee2e2')}
                </div>
                ${r.dias.length === 0 ? '<div style="text-align:center;padding:1rem;color:var(--gray-400);">Sin timbradas en este rango</div>' :
                    `<div style="overflow-x:auto;"><table class="data-table" style="width:100%;font-size:0.85rem;">
                    <thead><tr>
                        <th>Fecha</th><th>Día</th><th>Entrada</th><th>Salida</th>
                        <th style="text-align:right;">Trabajadas</th>
                        <th style="text-align:right;">Normales</th>
                        <th style="text-align:right;">Suplem. (+50%)</th>
                        <th style="text-align:right;">Extra (+100%)</th>
                        <th></th>
                    </tr></thead><tbody>
                    ${r.dias.map(d => {
                        const dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
                        const finsem = d.dia_semana === 0 || d.dia_semana === 6;
                        const ent = d.primera_entrada ? new Date(d.primera_entrada) : null;
                        const sal = d.ultima_salida ? new Date(d.ultima_salida) : null;
                        return `<tr style="${finsem?'background:#fef3c7;':''}">
                            <td>${d.fecha}</td>
                            <td><strong>${dias[d.dia_semana]}</strong></td>
                            <td style="font-variant-numeric:tabular-nums;">${ent ? relojFmtHora(ent) : '—'}</td>
                            <td style="font-variant-numeric:tabular-nums;">${sal ? relojFmtHora(sal) : '—'} ${d.abierto?'<span title="Sin cerrar" style="color:#dc2626;">●</span>':''}</td>
                            <td style="text-align:right;font-weight:600;">${relojFmtHorasMin(+d.horas_trabajadas)}</td>
                            <td style="text-align:right;color:#0f766e;">${(+d.horas_normales) > 0 ? relojFmtHorasMin(+d.horas_normales) : '—'}</td>
                            <td style="text-align:right;color:#9a3412;">${(+d.horas_suplementarias) > 0 ? relojFmtHorasMin(+d.horas_suplementarias) : '—'}</td>
                            <td style="text-align:right;color:#991b1b;">${(+d.horas_extraordinarias) > 0 ? relojFmtHorasMin(+d.horas_extraordinarias) : '—'}</td>
                            <td><button class="btn btn-sm" onclick='relojVerDetalleDia(${r.staff.id}, ${JSON.stringify(d.eventos)})' style="padding:0.15rem 0.4rem;font-size:0.7rem;border:1px solid var(--gray-300);">👁</button></td>
                        </tr>`;
                    }).join('')}
                    </tbody></table></div>`}
            </div>
        </div>`;
    }
    cont.innerHTML = html || '<div style="padding:2rem;text-align:center;color:var(--gray-400);">No hay trabajadores activos</div>';
}

function _relojCard(label, value, color, bg) {
    return `<div style="background:${bg};padding:0.6rem;border-radius:6px;">
        <div style="font-size:0.7rem;color:${color};text-transform:uppercase;font-weight:600;">${label}</div>
        <div style="font-size:1.1rem;font-weight:700;color:${color};font-variant-numeric:tabular-nums;">${value}</div>
    </div>`;
}

async function relojAdminCargarEstadoHoy() {
    const cont = document.getElementById('relojEstadoHoyCont');
    const { data, error } = await db.rpc('fichajes_estado_hoy_todos');
    if (error) { cont.innerHTML = '<div style="color:#dc2626;">Error: ' + escapeHtml(error.message) + '</div>'; return; }
    const hoy = new Date().toLocaleDateString('es-EC', { weekday:'long', day:'numeric', month:'long' });
    document.getElementById('relojEstadoHoyFecha').textContent = '· ' + hoy;

    const trabajando = data.filter(p => p.ultimo_tipo === 'entrada');
    const yaSalieron = data.filter(p => p.ultimo_tipo === 'salida');
    const sinTimbrar = data.filter(p => !p.ultimo_tipo);

    const tarjeta = (p) => {
        const ent = p.primera_entrada ? new Date(p.primera_entrada) : null;
        const sal = p.ultima_salida ? new Date(p.ultima_salida) : null;
        const ult = p.ultimo_ts ? new Date(p.ultimo_ts) : null;
        let bg, border, badge;
        if (p.ultimo_tipo === 'entrada') {
            bg = '#dcfce7'; border = '#16a34a'; badge = `🟢 Trabajando · desde ${relojFmtHora(ult)}`;
        } else if (p.ultimo_tipo === 'salida') {
            bg = '#fef3c7'; border = '#d97706'; badge = `🟡 Salió · ${relojFmtHora(ult)}`;
        } else {
            bg = '#f3f4f6'; border = '#9ca3af'; badge = '⚪ Sin timbradas hoy';
        }
        return `<div style="background:${bg};border-left:4px solid ${border};padding:0.7rem 0.9rem;border-radius:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                <strong style="font-size:0.95rem;">${escapeHtml(p.nombre)}</strong>
                ${p.es_admin ? '<span style="font-size:0.65rem;background:#ddd6fe;color:#5b21b6;padding:0.1rem 0.4rem;border-radius:3px;font-weight:600;">ADMIN</span>' : ''}
            </div>
            <div style="font-size:0.85rem;color:var(--gray-600);margin-top:0.2rem;">${badge}</div>
            <div style="font-size:0.75rem;color:var(--gray-500);margin-top:0.3rem;display:flex;gap:0.75rem;flex-wrap:wrap;">
                ${ent ? `<span>📥 Entró: <strong>${relojFmtHora(ent)}</strong></span>` : ''}
                ${sal ? `<span>📤 Salió: <strong>${relojFmtHora(sal)}</strong></span>` : ''}
                <span>⏱ <strong>${relojFmtHorasMin(+p.horas_hoy)}</strong></span>
                ${p.total_eventos > 0 ? `<span style="color:var(--gray-400);">(${p.total_eventos} timbradas)</span>` : ''}
            </div>
        </div>`;
    };

    let html = '';
    if (trabajando.length) {
        html += `<div style="font-size:0.75rem;font-weight:700;color:#15803d;text-transform:uppercase;margin-bottom:0.4rem;">🟢 Trabajando ahora (${trabajando.length})</div>`;
        html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0.5rem;margin-bottom:1rem;">${trabajando.map(tarjeta).join('')}</div>`;
    }
    if (yaSalieron.length) {
        html += `<div style="font-size:0.75rem;font-weight:700;color:#92400e;text-transform:uppercase;margin-bottom:0.4rem;">🟡 Ya salieron (${yaSalieron.length})</div>`;
        html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0.5rem;margin-bottom:1rem;">${yaSalieron.map(tarjeta).join('')}</div>`;
    }
    if (sinTimbrar.length) {
        html += `<div style="font-size:0.75rem;font-weight:700;color:var(--gray-500);text-transform:uppercase;margin-bottom:0.4rem;">⚪ Sin timbradas hoy (${sinTimbrar.length})</div>`;
        html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0.5rem;">${sinTimbrar.map(tarjeta).join('')}</div>`;
    }
    cont.innerHTML = html || '<div style="color:var(--gray-400);text-align:center;padding:1rem;">Sin trabajadores activos</div>';
}

function relojVerDetalleDia(staffId, eventos) {
    const evs = (eventos || []).map(e => {
        const t = new Date(e.ts);
        const icon = e.tipo === 'entrada' ? '🟢' : '🔴';
        return `${icon} ${e.tipo.toUpperCase()} — ${relojFmtHora(t)}${e.editado?' (editado)':''}`;
    }).join('\n');
    alert('Eventos del día:\n\n' + (evs || 'sin eventos'));
}

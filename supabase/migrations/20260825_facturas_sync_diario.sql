-- =====================================================================
-- Sincronizacion diaria de facturas con Contifico (2:00 AM Ecuador)
-- Aplicado en el proyecto Supabase ekrdnfecegwfavdgtgsa el 2026-08-25.
-- =====================================================================
--
-- Contexto: el cron ya existente (contifico-sync-diario, 11:00 UTC) solo
-- refrescaba contifico_documentos. Las dos tablas que consume el ERP se
-- habian quedado atras: facturas al 2026-04-17 y analisis_items_facturas
-- al 2026-07-03, contra 2026-08-21 en el origen.
--
-- Este script anade la proyeccion que faltaba y mueve el job a las 2 AM.

-- ---------------------------------------------------------------------
-- 1) Proyeccion local contifico_documentos -> facturas + items
-- ---------------------------------------------------------------------
create or replace function public.facturas_sync_desde_contifico()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_fact_nuevas int := 0;
  v_fact_actualizadas int := 0;
  v_items_nuevos int := 0;
begin
  -- Cabeceras. Contifico manda en importes y estado; la conciliacion local manda
  -- en el cobro: una factura ya marcada 'pagada' aqui nunca se degrada a
  -- 'pendiente', para no deshacer una conciliacion hecha a mano.
  with origen as (
    select distinct on (cd.documento) cd.*
    from contifico_documentos cd
    where cd.registro = 'CLI'
      and cd.tipo_documento in ('FAC','DNA')
      and cd.documento is not null
      and cd.fecha_emision is not null
    order by cd.documento, cd.synced_at desc nulls last
  ),
  ins as (
    insert into facturas as f (
      contifico_id, fecha, tipo_documento, numero_factura, autorizacion, cliente,
      identificacion, subtotal_iva, subtotal_0, iva, total, saldo, retenciones,
      estado, descripcion, estado_pago
    )
    select o.contifico_id, o.fecha_emision,
           case o.tipo_documento when 'FAC' then 'Factura' else 'Doc no autorizado' end,
           o.documento, o.autorizacion, o.persona_nombre, o.persona_identificacion,
           coalesce(o.subtotal_iva,0), coalesce(o.subtotal_0,0), coalesce(o.iva,0),
           coalesce(o.total,0), coalesce(o.saldo,0), coalesce(o.retenciones,0),
           case o.estado when 'C' then 'Cobrada' when 'A' then 'Anulada' else 'Pendiente' end,
           nullif(o.descripcion,''),
           case when o.estado = 'C' or coalesce(o.saldo,0) = 0 then 'pagada' else 'pendiente' end
    from origen o
    on conflict (numero_factura) do update set
      contifico_id   = excluded.contifico_id,
      fecha          = excluded.fecha,
      tipo_documento = excluded.tipo_documento,
      autorizacion   = excluded.autorizacion,
      cliente        = excluded.cliente,
      identificacion = excluded.identificacion,
      subtotal_iva   = excluded.subtotal_iva,
      subtotal_0     = excluded.subtotal_0,
      iva            = excluded.iva,
      total          = excluded.total,
      saldo          = excluded.saldo,
      retenciones    = excluded.retenciones,
      estado         = excluded.estado,
      descripcion    = coalesce(excluded.descripcion, f.descripcion),
      estado_pago    = case when excluded.estado_pago = 'pagada' then 'pagada' else f.estado_pago end
    returning (xmax = 0) as es_nueva
  )
  select count(*) filter (where es_nueva), count(*) filter (where not es_nueva)
    into v_fact_nuevas, v_fact_actualizadas
  from ins;

  -- Lineas de detalle, SOLO para documentos que aun no estan en la tabla.
  -- Las filas existentes no se tocan: llevan una clasificacion manual
  -- (categoria, modulo_erp, cotizable) que se perderia al regenerarlas.
  with pendientes as (
    select distinct on (cd.documento) cd.*
    from contifico_documentos cd
    where cd.registro = 'CLI'
      and cd.tipo_documento in ('FAC','DNA')
      and cd.documento is not null
      and cd.detalles is not null
      and jsonb_typeof(cd.detalles) = 'array'
      and not exists (select 1 from analisis_items_facturas a where a.documento = cd.documento)
    order by cd.documento, cd.synced_at desc nulls last
  ),
  ins_items as (
    insert into analisis_items_facturas (
      documento, tipo_documento, fecha_emision, cliente, producto, detalle,
      cantidad, precio_unit, descuento_pct, total_item, categoria, cotizable
    )
    select p.documento, p.tipo_documento, p.fecha_emision, p.persona_nombre,
           d->>'producto_nombre',
           coalesce(nullif(d->>'nombre_manual',''), nullif(d->>'descripcion',''), d->>'producto_nombre'),
           nullif(d->>'cantidad','')::numeric,
           nullif(d->>'precio','')::numeric,
           coalesce(nullif(d->>'porcentaje_descuento','')::numeric, 0),
           coalesce(nullif(d->>'base_gravable','')::numeric, 0)
             + coalesce(nullif(d->>'base_cero','')::numeric, 0)
             + coalesce(nullif(d->>'base_no_gravable','')::numeric, 0),
           'sin_clasificar',
           'REVISAR: sin clasificar'
    from pendientes p, lateral jsonb_array_elements(p.detalles) d
    returning 1
  )
  select count(*) into v_items_nuevos from ins_items;

  return jsonb_build_object(
    'facturas_nuevas', v_fact_nuevas,
    'facturas_actualizadas', v_fact_actualizadas,
    'items_nuevos', v_items_nuevos
  );
end;
$fn$;

revoke all on function public.facturas_sync_desde_contifico() from public, anon;
grant execute on function public.facturas_sync_desde_contifico() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2) Orquestador nocturno
-- ---------------------------------------------------------------------
-- La llamada a la API es la parte fragil (Contifico ignora el filtro de fechas y
-- devuelve el historico completo, asi que la edge function aborta por timeout en
-- ~la mitad de las corridas). Va envuelta: si falla, la proyeccion local corre
-- igual con los datos que ya haya en contifico_documentos.
create or replace function public.contifico_sync_diario()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_api jsonb;
  v_api_error text;
  v_local jsonb;
begin
  begin
    v_api := contifico_sync_incremental();
  exception when others then
    v_api_error := sqlerrm;
  end;

  v_local := facturas_sync_desde_contifico();

  insert into contifico_sync_log (
    tipo, inicio, fin, registros_nuevos, registros_actualizados, registros_error, error_mensaje
  ) values (
    'facturas_diario', now(), now(),
    coalesce((v_local->>'facturas_nuevas')::int, 0) + coalesce((v_local->>'items_nuevos')::int, 0),
    coalesce((v_local->>'facturas_actualizadas')::int, 0),
    case when v_api_error is null then 0 else 1 end,
    v_api_error
  );

  return jsonb_build_object('api', v_api, 'api_error', v_api_error, 'local', v_local);
end;
$fn$;

revoke all on function public.contifico_sync_diario() from public, anon;
grant execute on function public.contifico_sync_diario() to service_role;

-- ---------------------------------------------------------------------
-- 3) Cron: 2:00 AM Ecuador (UTC-5, sin horario de verano) = 07:00 UTC
-- ---------------------------------------------------------------------
select cron.unschedule('contifico-sync-diario');
select cron.schedule('contifico-sync-diario', '0 7 * * *',
  $$ set statement_timeout = '170s'; select contifico_sync_diario(); $$);

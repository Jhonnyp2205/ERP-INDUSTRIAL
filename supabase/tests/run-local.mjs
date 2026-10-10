// Pruebas locales de la base de datos con PGlite (PostgreSQL en WebAssembly).
// Ejecuta: npm run test:db
// Simula Supabase Auth/Storage con supabase_stub.sql y verifica reglas de seguridad,
// FEFO, aprobaciones, traslados, recuentos y valoración.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migDir = join(here, '..', 'migrations');
const db = new PGlite();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg); } };

await db.exec(readFileSync(join(here, 'supabase_stub.sql'), 'utf8'));
for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(migDir, f), 'utf8')); console.log('migración OK:', f); }
  catch (e) { console.error('ERROR en', f, e.message); process.exit(1); }
}

// Usuarios
const U = {};
for (const [k, role] of Object.entries({ admin1: 'admin', admin2: 'admin', sup1: 'supervisor', sup2: 'supervisor', op1: 'operador', op2: 'operador', cal1: 'calidad', mant1: 'mantenimiento', cons1: 'consulta' })) {
  const r = await db.query(`insert into auth.users(email, raw_app_meta_data) values ($1, $2) returning id`, [`${k}@test.bo`, { role }]);
  U[k] = r.rows[0].id;
}
// Intento de autoelevación vía user_metadata en el alta -> debe quedar 'consulta'
const hack = await db.query(`insert into auth.users(email, raw_user_meta_data) values ('hack@test.bo', '{"role":"admin"}') returning id`);
const hackRole = await db.query(`select role from public.profiles where id = $1`, [hack.rows[0].id]);

async function as(user, sql, params = []) {
  return db.transaction(async (tx) => {
    if (user) {
      await tx.exec(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [U[user]]);
    } else {
      await tx.exec(`set local role anon`);
      await tx.query(`select set_config('request.jwt.claim.sub', '', true)`);
    }
    return tx.query(sql, params);
  });
}
async function rejects(user, sql, params, pattern, msg) {
  try { await as(user, sql, params); ok(false, msg + ' (no falló)'); }
  catch (e) { ok(!pattern || new RegExp(pattern, 'i').test(e.message), msg + ' → ' + e.message.slice(0, 110)); }
}
const one = async (user, sql, params) => (await as(user, sql, params)).rows[0];
const q = async (sql, params) => (await db.query(sql, params)).rows;

console.log('\n== Perfiles y elevación de privilegios ==');
ok(hackRole.rows[0].role === 'consulta', 'user_metadata no puede asignar rol admin en el alta');
const upd = await as('op1', `update public.profiles set role='admin' where id = $1 returning id`, [U.op1]);
ok(upd.rows.length === 0, 'operador no puede cambiar su propio rol (RLS)');
await rejects('admin1', `update public.profiles set role='operador' where id = $1`, [U.admin1], 'quitarse', 'admin no puede quitarse su propio rol');
await as('op1', `select public.update_my_name('Operador Uno')`);
ok((await q(`select full_name from profiles where id=$1`, [U.op1]))[0].full_name === 'Operador Uno', 'usuario cambia su propio nombre vía RPC');
await rejects(null, `select * from public.materials`, [], 'permission', 'anon no accede a tablas');

console.log('\n== Catálogos ==');
const W1 = (await one('admin1', `insert into warehouses(code,name) values('W1','Central') returning id`)).id;
const W2 = (await one('admin1', `insert into warehouses(code,name) values('W2','Norte') returning id`)).id;
await q(`insert into user_warehouse_access(user_id, warehouse_id) values ($1,$3),($2,$3),($4,$3),($4,$5),($6,$5),($7,$3),($8,$3),($9,$3)`,
  [U.sup1, U.op1, W1, U.sup2, W2, U.op2, U.cal1, U.mant1, U.cons1]);
await rejects('sup1', `insert into warehouses(code,name) values('W3','x')`, [], 'row-level', 'supervisor no crea almacenes');
const L1 = (await one('sup1', `insert into locations(warehouse_id, code, name, barcode) values ($1,'A-01','Rack A1','LOC-A01') returning id`, [W1])).id;
const L2 = (await one('sup2', `insert into locations(warehouse_id, code, name) values ($1,'B-01','Rack B1') returning id`, [W2])).id;
await rejects('sup1', `insert into locations(warehouse_id, code, name) values ($1,'X','x')`, [W2], 'row-level', 'supervisor no crea ubicaciones en almacén sin acceso');
const UND = (await one('sup1', `insert into units_of_measure(code,name) values('UND','Unidad') returning id`)).id;
const CJ = (await one('sup1', `insert into units_of_measure(code,name) values('CJ','Caja') returning id`)).id;
const M1 = (await one('sup1', `insert into materials(sku,name,base_unit_id,expiry_alert_days) values('M1','Reactivo',$1,15) returning id`, [UND])).id;
const M2 = (await one('sup1', `insert into materials(sku,name,base_unit_id,allow_fraction,lot_controlled,expiry_controlled,min_stock) values('M2','Aceite',$1,true,false,false,100) returning id`, [UND])).id;
await as('sup1', `insert into material_units(material_id,unit_id,factor,is_purchase) values ($1,$2,12,true)`, [M1, CJ]);
await rejects('op1', `insert into materials(sku,name,base_unit_id) values('X','x',$1)`, [UND], 'row-level', 'operador no crea materiales');
await rejects('sup1', `update material_units set factor = 2 where material_id=$1 and unit_id=$2`, [M1, UND], 'factor 1', 'unidad base debe tener factor 1');
await rejects('sup1', `select public.to_base_qty($1,$2,1.5)`, [M1, UND], 'fracciones', 'material sin fracciones rechaza 1.5 UND');
ok(Number((await one('sup1', `select public.to_base_qty($1,$2,2) v`, [M1, CJ])).v) === 24, '2 CJ = 24 UND');

console.log('\n== Entradas ==');
const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
await rejects('op1', `select public.save_inventory_document($1)`, [{ doc_type: 'entrada', warehouse_id: W1, lines: [{ material_id: M1, unit_id: CJ, qty: 2, lot_code: 'L1', exp_date: d(60), unit_cost: 120 }] }], 'costos', 'operador no registra costos');
const E1 = (await one('op1', `select public.save_inventory_document($1) id`, [{ doc_type: 'entrada', warehouse_id: W1, idempotency_key: '11111111-1111-1111-1111-111111111111',
  lines: [{ material_id: M1, unit_id: CJ, qty: 2, lot_code: 'L1', exp_date: d(60), location_id: L1 }, { material_id: M1, unit_id: UND, qty: 10, lot_code: 'L2', exp_date: d(10), location_id: L1 }] }])).id;
const E1b = (await one('op1', `select public.save_inventory_document($1) id`, [{ doc_type: 'entrada', warehouse_id: W1, idempotency_key: '11111111-1111-1111-1111-111111111111', lines: [{ material_id: M2, qty: 1 }] }])).id;
ok(E1 === E1b, 'clave de idempotencia evita documento duplicado');
await as('op1', `select public.submit_inventory_document($1)`, [E1]);
await rejects('op1', `select public.confirm_inventory_document($1)`, [E1], 'admin o supervisor', 'operador no confirma entradas');
await rejects('sup1', `select public.confirm_inventory_document($1)`, [E1], 'costo', 'entrada sin costo no se confirma');
await as('sup1', `select public.save_inventory_document($1)`, [{ id: E1, doc_type: 'entrada', warehouse_id: W1,
  lines: [{ material_id: M1, unit_id: CJ, qty: 2, lot_code: 'L1', exp_date: d(60), location_id: L1, unit_cost: 120 }, { material_id: M1, unit_id: UND, qty: 10, lot_code: 'L2', exp_date: d(10), location_id: L1, unit_cost: 12 }] }]);
await as('sup1', `select public.confirm_inventory_document($1)`, [E1]);
await rejects('sup1', `select public.confirm_inventory_document($1)`, [E1], 'estado', 'doble confirmación rechazada');
let mc = await q(`select qty::float, value::float from material_costs where material_id=$1`, [M1]);
ok(mc[0].qty === 34 && mc[0].value === 360, `valorización tras entrada: 34 und, Bs 360 (obtenido ${mc[0].qty}, ${mc[0].value})`);
const E2 = (await one('sup1', `select public.save_inventory_document($1) id`, [{ doc_type: 'entrada', warehouse_id: W1, lines: [{ material_id: M2, qty: 50.5, unit_cost: 8 }] }])).id;
await as('sup1', `select public.confirm_inventory_document($1)`, [E2]);
const lots = Object.fromEntries((await q(`select lot_code, id from lots`)).map((r) => [r.lot_code, r.id]));

console.log('\n== Salidas con aprobación y FEFO ==');
const S1 = (await one('op1', `select public.save_inventory_document($1) id`, [{ doc_type: 'salida', warehouse_id: W1, reason: 'Producción', lines: [{ material_id: M1, qty: 15 }] }])).id;
await as('op1', `select public.submit_inventory_document($1)`, [S1]);
await rejects('op1', `select public.approve_inventory_document($1)`, [S1], 'permiso', 'operador no aprueba');
await rejects('op1', `select public.confirm_inventory_document($1)`, [S1], 'aprobado', 'no se confirma sin aprobación');
await rejects('op2', `select public.approve_inventory_document($1)`, [S1], 'no encontrado', 'usuario sin acceso al almacén no ve el documento');
await as('sup1', `select public.approve_inventory_document($1)`, [S1]);
const res = await q(`select l.lot_code, r.qty::float from stock_reservations r join lots l on l.id=r.lot_id where r.document_id=$1 order by l.exp_date`, [S1]);
ok(res.length === 2 && res[0].lot_code === 'L2' && res[0].qty === 10 && res[1].qty === 5, 'FEFO reserva primero el lote que vence antes (L2:10, L1:5)');
await rejects('op1', `update stock_balances set qty_on_hand = 999`, [], 'permission|row-level', 'cliente no modifica saldos directamente');
await rejects('op1', `insert into inventory_movements(movement_type,material_id,warehouse_id,qty) values('entrada',$1,$2,100)`, [M1, W1], 'permission|row-level', 'cliente no inserta movimientos');
await rejects('op1', `update inventory_documents set status='confirmado' where id=$1`, [S1], 'permission|row-level', 'cliente no cambia el estado de un documento');
await as('op1', `select public.confirm_inventory_document($1)`, [S1]);
const bal = await q(`select l.lot_code, sb.qty_on_hand::float, sb.qty_reserved::float from stock_balances sb join lots l on l.id=sb.lot_id where sb.material_id=$1 order by l.lot_code`, [M1]);
ok(bal[0].qty_on_hand === 19 && bal[1].qty_on_hand === 0 && bal.every((b) => b.qty_reserved === 0), 'saldos tras salida: L1=19, L2=0, sin reservas');
mc = await q(`select qty::float, round(value,2)::float as value from material_costs where material_id=$1`, [M1]);
ok(mc[0].qty === 19 && mc[0].value === 201.18, `promedio ponderado: quedan 19 und por Bs 201.18 (obtenido ${mc[0].value})`);
await rejects('admin1', `update inventory_movements set qty = 1`, [], 'permission|inmutable|row-level', 'movimientos inmutables');
await q(`set role postgres`).catch(() => {});
try { await db.query(`update inventory_movements set qty = 1`); ok(false, 'trigger de inmutabilidad'); } catch (e) { ok(/inmutables/.test(e.message), 'movimientos inmutables incluso para el dueño de la BD'); }

console.log('\n== Cuatro ojos ==');
const S2 = (await one('sup1', `select public.save_inventory_document($1) id`, [{ doc_type: 'salida', warehouse_id: W1, lines: [{ material_id: M2, qty: 0.5 }] }])).id;
await as('sup1', `select public.submit_inventory_document($1)`, [S2]);
await rejects('sup1', `select public.approve_inventory_document($1)`, [S2], 'creado por usted', 'supervisor no aprueba su propio documento');
await as('sup2', `select public.approve_inventory_document($1)`, [S2]);
await as('sup1', `select public.confirm_inventory_document($1)`, [S2]);

console.log('\n== Lotes bloqueados, cuarentena y vencidos ==');
await rejects('op1', `select public.set_lot_status($1,'bloqueado','x prueba')`, [lots.L1], 'no autorizado', 'operador no cambia estado de lotes');
await as('cal1', `select public.set_lot_status($1,'bloqueado','Desviación de calidad')`, [lots.L1]);
const S3 = (await one('op1', `select public.save_inventory_document($1) id`, [{ doc_type: 'salida', warehouse_id: W1, lines: [{ material_id: M1, qty: 5 }] }])).id;
await as('op1', `select public.submit_inventory_document($1)`, [S3]);
await rejects('sup1', `select public.approve_inventory_document($1)`, [S3], 'insuficientes', 'lote bloqueado no se usa en salidas');
await as('cal1', `select public.set_lot_status($1,'disponible','Liberado por calidad')`, [lots.L1]);
await q(`insert into lots(material_id, lot_code, exp_date, mfg_date) values ($1,'LV',$2,$3)`, [M1, d(-1), d(-100)]);
await rejects('cal1', `select public.set_lot_status((select id from lots where lot_code='LV'),'disponible','intento')`, [], 'vencido', 'lote vencido no se habilita');
await as('sup1', `select public.cancel_inventory_document($1,'prueba')`, [S3]);

console.log('\n== Traslados ==');
const T1 = (await one('op1', `select public.save_transfer($1) id`, [{ origin_warehouse_id: W1, dest_warehouse_id: W2, lines: [{ material_id: M1, qty: 10 }] }])).id;
await as('op1', `select public.transfer_action($1,'submit')`, [T1]);
await as('sup1', `select public.transfer_action($1,'approve')`, [T1]);
await as('op1', `select public.transfer_action($1,'prepare')`, [T1]);
await rejects('op1', `select public.transfer_action($1,'dispatch')`, [T1], 'supervisor', 'operador no autoriza despacho');
await as('sup1', `select public.transfer_action($1,'dispatch')`, [T1]);
let transit = await as('op2', `select sum(qty_in_transit)::float s from v_stock_in_transit where transfer_id=$1`, [T1]);
ok(transit.rows[0].s === 10, 'stock en tránsito = 10 visible para el destino');
ok((await q(`select sum(qty_on_hand)::float s from stock_balances where material_id=$1 and warehouse_id=$2`, [M1, W1]))[0].s === 9, 'origen descontado a 9');
ok((await q(`select qty::float from material_costs where material_id=$1`, [M1]))[0].qty === 19, 'valorización incluye tránsito (19)');
const item = (await q(`select id from warehouse_transfer_items where transfer_id=$1`, [T1]))[0].id;
await rejects('op2', `select public.transfer_action($1,'receive',$2)`, [T1, { items: [{ item_id: item, qty_received: 11 }] }], 'supera', 'no se recibe más de lo despachado');
await as('op2', `select public.transfer_action($1,'receive',$2)`, [T1, { items: [{ item_id: item, qty_received: 7, qty_damaged: 1, dest_location_id: L2 }] }]);
ok((await q(`select status from warehouse_transfers where id=$1`, [T1]))[0].status === 'recibido_parcial', 'recepción parcial');
await as('op2', `select public.transfer_action($1,'declare_differences',$2)`, [T1, { reason: 'Faltan 2 unidades' }]);
await rejects('op2', `select public.transfer_action($1,'approve_differences')`, [T1], 'permiso', 'operador no aprueba diferencias');
await as('sup2', `select public.transfer_action($1,'approve_differences')`, [T1]);
ok((await q(`select status from warehouse_transfers where id=$1`, [T1]))[0].status === 'cerrado', 'traslado cerrado tras aprobar diferencias');
ok((await q(`select qty::float from material_costs where material_id=$1`, [M1]))[0].qty === 16, 'baja por daño+faltante descuenta 3 de la valorización (16)');
ok((await q(`select sum(qty_on_hand)::float s from stock_balances where material_id=$1`, [M1]))[0].s === 16, 'existencias totales = valorización (16)');
const T2 = (await one('sup1', `select public.save_transfer($1) id`, [{ origin_warehouse_id: W1, dest_warehouse_id: W2, lines: [{ material_id: M2, qty: 1 }] }])).id;
await as('sup1', `select public.transfer_action($1,'submit')`, [T2]);
await rejects('sup1', `select public.transfer_action($1,'approve')`, [T2], 'creado por usted', 'supervisor no aprueba su propio traslado');

console.log('\n== Ajustes y recuentos ==');
await rejects('op1', `select public.save_inventory_document($1)`, [{ doc_type: 'ajuste', warehouse_id: W1, lines: [{ material_id: M2, qty: 1, direction: -1 }] }], 'reason|check', 'ajuste sin motivo rechazado');
const C1 = (await one('op1', `select public.create_stock_count($1, null, 'Mensual') id`, [W1])).id;
const cl = await as('op1', `select material_id, location_id, lot_id, system_qty::float from stock_count_lines where count_id=$1`, [C1]);
for (const l of cl.rows) {
  const counted = l.material_id === M2 ? l.system_qty - 2 : l.system_qty;
  await as('op1', `select public.save_count_line($1,$2,$3,$4,$5,null)`, [C1, l.material_id, l.location_id, l.lot_id, counted]);
}
await rejects('op1', `select public.close_stock_count($1)`, [C1], 'no autorizado', 'operador no cierra recuentos');
const ADJ = (await one('sup1', `select public.close_stock_count($1) id`, [C1])).id;
ok(!!ADJ, 'el cierre genera un ajuste pendiente de aprobación');
await rejects('sup1', `select public.approve_inventory_document($1)`, [ADJ], 'creado por usted', 'quien cerró el recuento no aprueba su ajuste');
await as('sup2', `select public.approve_inventory_document($1)`, [ADJ]);
await as('op1', `select public.confirm_inventory_document($1)`, [ADJ]);
ok((await q(`select sum(qty_on_hand)::float s from stock_balances where material_id=$1`, [M2]))[0].s === 48, 'ajuste por recuento aplicado (M2 = 48)');

console.log('\n== Visibilidad de costos y almacenes ==');
ok((await as('op1', `select count(*)::int c from movement_costs`)).rows[0].c === 0, 'operador no ve costos de movimientos');
ok((await as('op1', `select count(*)::int c from v_movements where unit_cost is not null`)).rows[0].c === 0, 'vista de kardex sin costos para operador');
ok((await as('sup1', `select count(*)::int c from v_movements where unit_cost is not null`)).rows[0].c > 0, 'supervisor ve costos');
ok((await as('op2', `select count(*)::int c from stock_balances where warehouse_id=$1`, [W1])).rows[0].c === 0, 'operador de W2 no ve saldos de W1');
ok((await as('cons1', `select count(*)::int c from v_stock`)).rows[0].c > 0, 'usuario de consulta ve existencias de su almacén');

console.log('\n== Cambio de método de valoración ==');
await rejects('sup1', `select public.request_valuation_change('fifo', current_date, 'Cambio solicitado por auditoría')`, [], 'administradores', 'supervisor no solicita cambio de método');
const VR = (await one('admin1', `select public.request_valuation_change('fifo', current_date, 'Cambio solicitado por auditoría externa') id`)).id;
await rejects('admin1', `select public.decide_valuation_change($1, true, 'ok')`, [VR], 'otro administrador', 'el solicitante no aprueba su propio cambio');
const before = (await q(`select sum(value)::float v from material_costs`))[0].v;
await as('admin2', `select public.decide_valuation_change($1, true, 'Aprobado')`, [VR]);
ok((await q(`select method from valuation_methods order by id desc limit 1`))[0].method === 'fifo', 'método activo FIFO');
ok((await q(`select sum(value)::float v from material_costs`))[0].v === before, 'el cambio no altera el valor total (reconciliación)');
ok((await q(`select count(*)::int c from valuation_change_snapshots where request_id=$1`, [VR]))[0].c >= 2, 'foto de reconciliación guardada');
ok((await q(`select count(*)::int c from movement_costs where method='promedio'`))[0].c > 0, 'costos históricos conservan el método promedio');
const E3 = (await one('sup1', `select public.save_inventory_document($1) id`, [{ doc_type: 'entrada', warehouse_id: W1, lines: [{ material_id: M2, qty: 10, unit_cost: 20 }] }])).id;
await as('sup1', `select public.confirm_inventory_document($1)`, [E3]);
const S4 = (await one('op1', `select public.save_inventory_document($1) id`, [{ doc_type: 'salida', warehouse_id: W1, lines: [{ material_id: M2, qty: 48 }] }])).id;
await as('op1', `select public.submit_inventory_document($1)`, [S4]);
await as('sup1', `select public.approve_inventory_document($1)`, [S4]);
await as('op1', `select public.confirm_inventory_document($1)`, [S4]);
const c4 = await q(`select mc.unit_cost::float, mc.method from movement_costs mc join inventory_movements m on m.id=mc.movement_id where m.document_id=$1`, [S4]);
ok(c4[0].method === 'fifo' && c4[0].unit_cost === 8, `FIFO consume primero la capa antigua a Bs 8 (obtenido ${c4[0].unit_cost})`);
ok((await q(`select value::float from material_costs where material_id=$1`, [M2]))[0].value === 200, 'quedan 10 und a Bs 20 = Bs 200');

console.log('\n== Documentos privados ==');
const A1 = (await one('mant1', `insert into assets(code,name,warehouse_id) values('EQ-1','Compresor',$1) returning id`, [W1])).id;
const path = `asset/${A1}/abc-manual.pdf`;
await as('mant1', `insert into storage.objects(bucket_id,name,owner,owner_id) values('erp-documents',$1,$2::uuid,$2::text)`, [path, U.mant1]);
await rejects('op1', `insert into storage.objects(bucket_id,name,owner_id) values('erp-documents',$1,$2)`, [`asset/${A1}/x.pdf`, U.op1], 'row-level', 'operador no sube archivos');
const DOC = (await one('mant1', `select public.register_document($1) id`, [{ entity_type: 'asset', entity_id: A1, storage_path: path, file_name: 'manual.pdf', title: 'Manual', is_controlled: true }])).id;
ok((await as('op1', `select count(*)::int c from storage.objects where name=$1`, [path])).rows[0].c === 1, 'usuario con acceso al almacén del activo puede leer');
ok((await as('op2', `select count(*)::int c from storage.objects where name=$1`, [path])).rows[0].c === 0, 'usuario sin acceso no puede leer el archivo');
await rejects('op2', `select public.register_document($1)`, [{ entity_type: 'asset', entity_id: A1, storage_path: path, file_name: 'x' }], 'rol|acceso', 'operador no registra documentos');
await rejects('mant1', `select public.retire_document($1,'obsoleto')`, [DOC], 'controlado', 'documento controlado solo lo retira un admin');
await as('admin1', `select public.retire_document($1,'Obsoleto')`, [DOC]);
ok((await as('mant1', `select count(*)::int c from documents where id=$1`, [DOC])).rows[0].c === 0, 'documento retirado oculto para no admin');
ok((await as('admin1', `select count(*)::int c from documents where id=$1`, [DOC])).rows[0].c === 1, 'el archivo y su registro se conservan (trazabilidad)');

console.log('\n== Mantenimiento ==');
const WO = (await one('op1', `insert into work_orders(asset_id, wo_type, title) values ($1,'correctivo','Fuga de aire') returning id`, [A1])).id;
const SW = (await one('mant1', `select public.save_inventory_document($1) id`, [{ doc_type: 'salida', warehouse_id: W1, work_order_id: WO, lines: [{ material_id: M2, qty: 2 }] }])).id;
await as('mant1', `select public.submit_inventory_document($1)`, [SW]);
await as('sup1', `select public.approve_inventory_document($1)`, [SW]);
await as('mant1', `select public.confirm_inventory_document($1)`, [SW]);
ok((await as('mant1', `select total_cost::float from v_work_order_costs where id=$1`, [WO])).rows[0].total_cost === 40, 'costo de materiales cargado a la OT (2 × Bs 20)');
await as('mant1', `select public.complete_work_order($1,'Se cambió sello',2,100,0)`, [WO]);
await q(`insert into maintenance_plans(asset_id,name,frequency_days,next_due) values ($1,'Revisión mensual',30,current_date)`, [A1]);

console.log('\n== Ambiente, limpieza e incidencias ==');
await as('cal1', `insert into environmental_limits(warehouse_id,parameter,min_value,max_value) values ($1,'temperatura',2,8)`, [W1]);
await as('op1', `insert into temperature_logs(warehouse_id, parameter, value) values ($1,'temperatura',11)`, [W1]);
const tl = (await q(`select out_of_range, incident_id from temperature_logs`))[0];
ok(tl.out_of_range && tl.incident_id, 'medición fuera de rango abre incidencia automáticamente');
ok((await as('cal1', `select count(*)::int c from notifications where kind='alerta'`)).rows[0].c === 1, 'calidad recibe alerta interna');
await rejects('op1', `update temperature_logs set value = 5`, [], 'permission|row-level|modifican', 'mediciones no editables');
await as('cal1', `insert into cleaning_plans(warehouse_id,name,frequency_days,checklist) values ($1,'Limpieza cámara fría',7,'{Pisos,Estantes}')`, [W1]);
const alerts = (await one('op1', `select public.generate_alerts(true) r`)).r;
ok(alerts.ot_preventivas === 1 && alerts.tareas_limpieza === 1, 'alertas: OT preventiva y tarea de limpieza generadas ' + JSON.stringify(alerts));
const task = (await q(`select id from cleaning_tasks`))[0].id;
await rejects('op1', `select public.complete_cleaning_task($1,$2,null)`, [task, [{ item: 'Pisos', ok: true }]], 'todos', 'checklist incompleta rechazada');
await as('op1', `select public.complete_cleaning_task($1,$2,'Mancha persistente')`, [task, [{ item: 'Pisos', ok: true }, { item: 'Estantes', ok: false }]]);
ok((await q(`select count(*)::int c from incidents where source_type='limpieza'`))[0].c === 1, 'incumplimiento de limpieza genera incidencia');
const INC = tl.incident_id;
await as('cal1', `insert into corrective_actions(incident_id, description, responsible_id) values ($1,'Revisar compresor',$2)`, [INC, U.mant1]);
await rejects('cal1', `select public.close_incident($1,'ok',null)`, [INC], 'acciones', 'incidencia no se cierra con acciones abiertas');
await as('mant1', `update corrective_actions set status='completada', completed_at=now() where incident_id=$1`, [INC]);
await as('cal1', `select public.close_incident($1,'Temperatura normalizada','Puerta mal cerrada')`, [INC]);

console.log('\n== Períodos y auditoría ==');
await rejects('admin1', `select public.close_period(current_date)`, [], 'terminados', 'no se cierra el mes en curso');
await as('admin1', `select public.close_period((current_date - interval '1 month')::date)`);
ok((await as('op1', `select count(*)::int c from audit_logs`)).rows[0].c === 0, 'solo admin lee auditoría');
ok((await as('admin1', `select count(*)::int c from audit_logs where table_name='inventory_documents'`)).rows[0].c > 0, 'cambios de documentos auditados');
const sum = (await one('sup1', `select public.dashboard_summary() s`)).s;
ok(typeof sum.inventory_value === 'number' || sum.inventory_value !== undefined, 'panel principal responde ' + JSON.stringify(sum));
ok((await one('op1', `select public.dashboard_summary() s`)).s.inventory_value === null, 'panel sin valor de inventario para operador');

console.log(`\nResultado: ${pass} correctas, ${fail} fallidas`);
process.exit(fail ? 1 : 0);

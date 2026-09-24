// ============================================================
// ORDERBOT — server.js v6
// Franjas horarias + Fecha por texto + Catálogo en lista
// ============================================================
import express  from 'express';
import crypto   from 'crypto';
import cron     from 'node-cron';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const {
  WEBHOOK_VERIFY_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  BOT_BASE_URL,
  PORT = 3000,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// HORARIOS REALES LA MADRUGADA
// L-V: 07:00-20:30 | Sáb: 07:30-14:30 | Dom: cerrado
// ============================================================

function franjasPorFecha(fecha) {
  const dow = new Date(fecha + 'T12:00:00').getDay();
  if (dow === 0) return [];
  if (dow === 6) return [
    { id: 'f1', title: '🌅 07:30 - 10:00' },
    { id: 'f2', title: '🌞 10:00 - 14:30' },
  ];
  return [
    { id: 'f1', title: '🌅 07:00 - 10:00' },
    { id: 'f2', title: '🌞 10:00 - 13:00' },
    { id: 'f3', title: '🌤 13:00 - 16:00' },
    { id: 'f4', title: '🌆 16:00 - 20:30' },
  ];
}

function franjaTexto(franjaId, fecha) {
  const dow = new Date(fecha + 'T12:00:00').getDay();
  const mapa = dow === 6
    ? { f1:'07:30-10:00', f2:'10:00-14:30' }
    : { f1:'07:00-10:00', f2:'10:00-13:00', f3:'13:00-16:00', f4:'16:00-20:30' };
  return mapa[franjaId] || franjaId;
}

function validarFechaEscrita(texto) {
  const match = texto.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dia, mes, anio] = match;
  const fecha = new Date(`${anio}-${mes}-${dia}`);
  if (isNaN(fecha.getTime())) return null;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  if (fecha < hoy) return null;
  if (fecha.getDay() === 0) return null;
  return `${anio}-${mes}-${dia}`;
}

function formatFecha(iso) {
  return new Date(iso + 'T12:00:00')
    .toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' });
}

// ============================================================
// CACHE DE TENANT
// ============================================================
const tenantCache = new Map();

async function getTenant(phoneId) {
  if (tenantCache.has(phoneId)) return tenantCache.get(phoneId);
  const { data: tenant } = await supabase.from('tenants').select('*')
    .eq('whatsapp_phone_id', phoneId).eq('activo', true).single();
  if (!tenant) return null;
  const [{ data: productos }, { data: locales }] = await Promise.all([
    supabase.from('productos').select('*').eq('tenant_id', tenant.id).eq('disponible', true).order('orden'),
    supabase.from('locales').select('*').eq('tenant_id', tenant.id).eq('activo', true).order('orden'),
  ]);
  tenant.productos = productos || [];
  tenant.locales   = locales   || [];
  tenantCache.set(phoneId, tenant);
  return tenant;
}

async function getTenantById(id) {
  const { data } = await supabase.from('tenants').select('*').eq('id', id).single();
  return data;
}

// ============================================================
// SESIONES
// pasos: inicio → catalogo → eligiendo_cantidad → carrito →
//        nombre → local → fecha → franja → observaciones →
//        metodo_pago → confirmacion
// ============================================================
const sesiones = new Map();

function crearSesion(telefono, nombre) {
  return {
    paso: 'inicio', nombre, telefono, carrito: [],
    localId: null, localNombre: null,
    fecha: null, franja: null, franjaTextoVal: null,
    observaciones: null, metodo_pago: null,
    productoElegidoId: null,
  };
}

// ============================================================
// WEBHOOK
// ============================================================
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const changes = req.body?.entry?.[0]?.changes?.[0]?.value;
  if (!changes?.messages?.length) return;
  const phoneId     = changes.metadata?.phone_number_id;
  const msg         = changes.messages[0];
  const from        = msg.from;
  const contactName = changes.contacts?.[0]?.profile?.name || 'Cliente';
  const tenant      = await getTenant(phoneId);
  if (!tenant) return console.error('Tenant no encontrado:', phoneId);
  await procesarMensaje(from, contactName, msg, tenant);
});

// ============================================================
// PROCESADOR PRINCIPAL
// ============================================================
async function procesarMensaje(telefono, contactName, msg, tenant) {
  let s = sesiones.get(telefono) || crearSesion(telefono, contactName);

  const texto = msg.type === 'text' ? msg.text?.body?.trim() : '';
  const btnId = msg.type === 'interactive'
    ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id) : '';
  const entrada = btnId || texto || '';

  if (/^(hola|buenas|buenos|empezar|inicio|menu|start|reiniciar)/i.test(entrada) && s.paso !== 'inicio') {
    s = crearSesion(telefono, contactName);
  }

  console.log(`[${telefono}] paso=${s.paso} | "${entrada.slice(0,40)}"`);

  switch (s.paso) {

    case 'inicio':
      await enviarTexto(telefono, tenant,
        `${tenant.mensaje_bienvenida}\n\nHola, *${s.nombre}* 👋\n\nEnseguida te mostramos nuestros productos.`);
      s.paso = 'catalogo';
      await mostrarCatalogo(telefono, tenant, s);
      break;

    // ── CATÁLOGO EN LISTA ─────────────────────────────────
    case 'catalogo':
      await mostrarCatalogo(telefono, tenant, s);
      break;

    case 'eligiendo_producto': {
      // El cliente eligió un producto del listado
      const prod = tenant.productos.find(p => p.id === entrada);
      if (!prod) { await mostrarCatalogo(telefono, tenant, s); break; }
      s.productoElegidoId = prod.id;
      s.paso = 'eligiendo_cantidad';
      await enviarTexto(telefono, tenant,
        `Has elegido *${prod.nombre}* (${prod.precio.toFixed(2)}€)\n\n¿Cuántas unidades? Escribe un número del 1 al 20.`);
      break;
    }

    case 'eligiendo_cantidad': {
      const n = parseInt(entrada);
      if (isNaN(n) || n < 1 || n > 20) {
        await enviarTexto(telefono, tenant, '⚠️ Escribe un número entre 1 y 20.');
        break;
      }
      const prod = tenant.productos.find(p => p.id === s.productoElegidoId);
      if (!prod) { s.paso = 'catalogo'; await mostrarCatalogo(telefono, tenant, s); break; }
      const idx = s.carrito.findIndex(l => l.id === prod.id);
      if (idx >= 0) s.carrito[idx].cantidad += n;
      else s.carrito.push({ id: prod.id, nombre: prod.nombre, precio: prod.precio, cantidad: n });

      await enviarOpciones(telefono, tenant,
        `✅ Añadido: ${n}× *${prod.nombre}*`,
        [{ id: 'mas_productos', title: '➕ Añadir más' },
         { id: 'ver_carrito',  title: '🛒 Ver carrito' },
         { id: 'continuar',    title: '✅ Continuar' }]);
      s.paso = 'tras_cantidad';
      break;
    }

    case 'tras_cantidad':
      if (entrada === 'mas_productos') {
        s.paso = 'eligiendo_producto';
        await mostrarCatalogo(telefono, tenant, s);
      } else if (entrada === 'ver_carrito') {
        await mostrarCarrito(telefono, tenant, s);
        s.paso = 'carrito';
      } else if (entrada === 'continuar') {
        s.paso = 'nombre';
        await pedirNombre(telefono, tenant);
      }
      break;

    case 'carrito':
      if (entrada === 'seguir') { s.paso = 'eligiendo_producto'; await mostrarCatalogo(telefono, tenant, s); }
      else if (entrada === 'continuar') { s.paso = 'nombre'; await pedirNombre(telefono, tenant); }
      break;

    // ── DATOS ─────────────────────────────────────────────
    case 'nombre':
      if (!entrada || entrada.length < 2) { await pedirNombre(telefono, tenant); break; }
      s.nombre = entrada; s.paso = 'local'; await pedirLocal(telefono, tenant);
      break;

    case 'local': {
      const local = tenant.locales.find(l => l.id === entrada);
      if (!local) { await pedirLocal(telefono, tenant); break; }
      s.localId = local.id; s.localNombre = local.nombre;
      s.paso = 'fecha'; await pedirFecha(telefono, tenant);
      break;
    }

    // ── FECHA POR TEXTO ───────────────────────────────────
    case 'fecha': {
      const iso = validarFechaEscrita(entrada);
      if (!iso) {
        await enviarTexto(telefono, tenant,
          `⚠️ Fecha no válida. Recuerda:\n• Formato: *DD/MM/YYYY*\n• Ejemplo: *24/12/2026*\n• No aceptamos domingos ni fechas pasadas\n\nInténtalo de nuevo:`);
        break;
      }
      s.fecha = iso;
      s.paso = 'franja';
      await pedirFranja(telefono, tenant, iso);
      break;
    }

    // ── FRANJA HORARIA ────────────────────────────────────
    case 'franja': {
      const franjas = franjasPorFecha(s.fecha);
      const franja = franjas.find(f => f.id === entrada);
      if (!franja) { await pedirFranja(telefono, tenant, s.fecha); break; }
      s.franja = franja.id;
      s.franjaTextoVal = franjaTexto(franja.id, s.fecha);
      s.paso = 'observaciones';
      await enviarOpciones(telefono, tenant,
        '📝 ¿Alguna observación o alergia que debamos tener en cuenta?\n_(Escríbela o salta el paso)_',
        [{ id:'sin_obs', title:'⏭ Sin observaciones' }]);
      break;
    }

    case 'observaciones':
      s.observaciones = entrada === 'sin_obs' ? null : entrada;
      s.paso = 'metodo_pago';
      await pedirMetodoPago(telefono, tenant, s);
      break;

    case 'metodo_pago':
      if (entrada === 'pago_local') {
        s.metodo_pago = 'local'; s.paso = 'confirmacion';
        await mostrarResumen(telefono, tenant, s);
      } else if (entrada === 'pago_online') {
        s.metodo_pago = 'online'; s.paso = 'confirmacion';
        await mostrarResumen(telefono, tenant, s);
      } else { await pedirMetodoPago(telefono, tenant, s); }
      break;

    case 'confirmacion':
      if (entrada === 'confirmar')  await guardarPedido(telefono, tenant, s);
      else if (entrada === 'cancelar') {
        sesiones.delete(telefono);
        await enviarTexto(telefono, tenant, '❌ Pedido cancelado. Escribe *hola* para volver a empezar.');
      } else { await mostrarResumen(telefono, tenant, s); }
      break;

    default:
      s = crearSesion(telefono, contactName);
      sesiones.set(telefono, s);
      await procesarMensaje(telefono, contactName, msg, tenant);
      return;
  }

  sesiones.set(telefono, s);
}

// ============================================================
// MENSAJES DEL BOT
// ============================================================

// Catálogo completo en un solo listado
async function mostrarCatalogo(telefono, tenant, s) {
  if (!tenant.productos.length) {
    await enviarTexto(telefono, tenant, '😔 No hay productos disponibles en este momento.');
    return;
  }

  const carritoResumen = s.carrito.length > 0
    ? `\n\n🛒 En tu carrito: ${s.carrito.map(l => `${l.cantidad}× ${l.nombre}`).join(', ')}`
    : '';

  const rows = tenant.productos.map(p => ({
    id: p.id,
    title: p.nombre.slice(0, 24),
    description: `${p.precio.toFixed(2)}€ · ${(p.descripcion || '').slice(0, 50)}`,
  }));

  await enviarLista(telefono, tenant,
    `🎁 *Nuestros productos*\nSelecciona el que quieres añadir al pedido:${carritoResumen}`,
    'Ver catálogo',
    [{ title: 'Productos disponibles', rows }]
  );
  s.paso = 'eligiendo_producto';
}

async function mostrarCarrito(telefono, tenant, s) {
  if (!s.carrito.length) { await enviarTexto(telefono, tenant, '🛒 Tu carrito está vacío.'); return; }
  const lineas = s.carrito.map(l => `• ${l.cantidad}× ${l.nombre} — ${(l.cantidad*l.precio).toFixed(2)}€`).join('\n');
  const total  = s.carrito.reduce((a, l) => a + l.cantidad * l.precio, 0);
  await enviarOpciones(telefono, tenant,
    `🛒 *Tu carrito:*\n\n${lineas}\n\n💰 *Total: ${total.toFixed(2)}€*`,
    [{ id:'seguir',    title:'➕ Añadir más' },
     { id:'continuar', title:'✅ Continuar con el pedido' }]);
}

async function pedirNombre(telefono, tenant) {
  await enviarTexto(telefono, tenant, '👤 ¿Cuál es tu *nombre completo* para el pedido?');
}

async function pedirLocal(telefono, tenant) {
  const botones = tenant.locales.map(l => ({
    id: l.id,
    title: l.nombre.replace('Madrugada Beniaján','Beniaján').replace('Madrugada Vistabella','Vistabella')
  }));
  await enviarOpciones(telefono, tenant, '🏪 ¿En qué local quieres recoger tu pedido?', botones);
}

async function pedirFecha(telefono, tenant) {
  await enviarTexto(telefono, tenant,
    `📅 ¿Qué día quieres recoger?\n\nEscribe la fecha con este formato:\n*DD/MM/YYYY*\n\nEjemplo: *24/12/2026*\n\n_(Abrimos de lunes a sábado, cerramos domingos)_`);
}

async function pedirFranja(telefono, tenant, fecha) {
  const franjas = franjasPorFecha(fecha);
  if (!franjas.length) {
    await enviarTexto(telefono, tenant, '⚠️ Ese día estamos cerrados. Escribe otra fecha:');
    return;
  }
  const fechaTxt = formatFecha(fecha);
  await enviarOpciones(telefono, tenant,
    `🕐 ¿En qué franja horaria recoges el *${fechaTxt}*?`,
    franjas);
}

async function pedirMetodoPago(telefono, tenant, s) {
  const total = s.carrito.reduce((a, l) => a + l.cantidad * l.precio, 0);
  const botones = [{ id:'pago_local', title:'🏪 Pagar en el local' }];
  if (tenant.pago_online_activo)
    botones.push({ id:'pago_online', title:'💳 Tarjeta / Bizum' });
  await enviarOpciones(telefono, tenant,
    `💰 *Total: ${total.toFixed(2)}€*\n\n¿Cómo quieres pagar?\n\n` +
    `🏪 *En el local* — pagas cuando recoges\n` +
    (tenant.pago_online_activo ? `💳 *Online* — tarjeta o Bizum ahora mismo` : `_(Pago online próximamente)_`),
    botones);
}

async function mostrarResumen(telefono, tenant, s) {
  const lineas = s.carrito.map(l => `  • ${l.cantidad}× ${l.nombre} — ${(l.cantidad*l.precio).toFixed(2)}€`).join('\n');
  const total  = s.carrito.reduce((a, l) => a + l.cantidad * l.precio, 0);
  const pagoTxt = s.metodo_pago === 'online' ? '💳 Online (tarjeta/Bizum)' : '🏪 En el local al recoger';
  await enviarOpciones(telefono, tenant,
    `📋 *Resumen de tu pedido*\n\n` +
    `👤 ${s.nombre}\n📞 ${s.telefono}\n\n` +
    `🛒 *Productos:*\n${lineas}\n\n` +
    `💰 *Total: ${total.toFixed(2)}€*\n\n` +
    `📍 Local: ${s.localNombre}\n` +
    `📅 Recogida: ${formatFecha(s.fecha)}\n` +
    `🕐 Franja: ${s.franjaTextoVal}h\n` +
    `💳 Pago: ${pagoTxt}\n` +
    (s.observaciones ? `📝 Obs: ${s.observaciones}\n` : '') +
    `\n¿Confirmamos?`,
    [{ id:'confirmar', title:'✅ Confirmar pedido' }, { id:'cancelar', title:'❌ Cancelar' }]);
}

// ============================================================
// GUARDAR PEDIDO
// ============================================================
async function guardarPedido(telefono, tenant, s) {
  try {
    const { data: num } = await supabase.rpc('siguiente_numero_pedido', { p_tenant_id: tenant.id });
    const total = s.carrito.reduce((a, l) => a + l.cantidad * l.precio, 0);
    const redsysOrder = `${tenant.id.slice(0,4).toUpperCase()}${String(num).padStart(8,'0')}`;

    const { data: pedido, error } = await supabase.from('pedidos').insert({
      tenant_id:           tenant.id,
      local_id:            s.localId,
      local_nombre:        s.localNombre,
      numero_pedido:       num,
      cliente_nombre:      s.nombre,
      cliente_telefono:    telefono,
      fecha_recogida:      s.fecha,
      hora_recogida:       s.franjaTextoVal + ':00',  // guardamos la franja como texto
      observaciones:       s.observaciones,
      estado:              'confirmado',
      origen:              'whatsapp',
      pago_metodo:         s.metodo_pago,
      pagado:              false,
      pago_redsys_order:   s.metodo_pago === 'online' ? redsysOrder : null,
      total,
      whatsapp_session_id: telefono,
    }).select().single();

    if (error) throw error;

    await supabase.from('pedido_lineas').insert(
      s.carrito.map(l => ({
        pedido_id: pedido.id, producto_id: l.id,
        producto_nombre: l.nombre, producto_precio: l.precio, cantidad: l.cantidad,
      }))
    );

    const numStr = String(num).padStart(4, '0');

    if (s.metodo_pago === 'online') {
      await enviarTexto(telefono, tenant,
        `🎉 *¡Pedido #${numStr} registrado!*\n\n` +
        `Para completarlo, realiza el pago de *${total.toFixed(2)}€*:\n\n` +
        `💳 ${BOT_BASE_URL}/pagar/${pedido.id}\n\n` +
        `_El pedido quedará confirmado al recibir el pago._`);
    } else {
      await enviarTexto(telefono, tenant,
        `🎉 *¡Pedido #${numStr} confirmado!*\n\n` +
        `Te esperamos el *${formatFecha(s.fecha)}*\n` +
        `🕐 Franja: *${s.franjaTextoVal}h*\n` +
        `📍 en *${s.localNombre}*\n\n` +
        `¡Gracias y hasta pronto! 🥐`);
    }

    // Notificación a la tienda
    await whatsappSend(tenant, {
      to: tenant.telefono_negocio, type: 'text', text: { body:
        `🔔 *NUEVO PEDIDO #${numStr}* (WhatsApp)\n\n` +
        `👤 ${s.nombre} · 📞 ${telefono}\n\n` +
        s.carrito.map(l => `• ${l.cantidad}× ${l.nombre}`).join('\n') +
        `\n💰 Total: ${total.toFixed(2)}€\n` +
        `💳 Pago: ${s.metodo_pago === 'online' ? 'Online (pendiente)' : 'En el local'}\n\n` +
        `📍 ${s.localNombre}\n📅 ${formatFecha(s.fecha)} · ${s.franjaTextoVal}h\n` +
        (s.observaciones ? `📝 ${s.observaciones}` : ''),
      },
    });

    sesiones.delete(telefono);
    console.log(`✅ Pedido #${numStr} | ${s.metodo_pago} | ${s.nombre} | ${total.toFixed(2)}€`);

  } catch (err) {
    console.error('❌ Error guardando pedido:', err);
    await enviarTexto(telefono, tenant, '⚠️ Error al guardar tu pedido. Por favor, llámanos directamente.');
  }
}

// ============================================================
// RECORDATORIOS — cron cada día a las 18:00
// ============================================================
cron.schedule('0 18 * * *', async () => {
  console.log('⏰ Cron recordatorios:', new Date().toISOString());
  await enviarRecordatorios();
}, { timezone: 'Europe/Madrid' });

async function enviarRecordatorios() {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const mananaStr = manana.toISOString().split('T')[0];

    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('*, tenants(*)')
      .eq('fecha_recogida', mananaStr)
      .eq('estado', 'confirmado')
      .eq('recordatorio_enviado', false);

    if (!pedidos?.length) return console.log('Sin recordatorios hoy.');

    for (const pedido of pedidos) {
      const tenant = pedido.tenants;
      if (!tenant?.recordatorios_activos) continue;

      const numStr   = String(pedido.numero_pedido).padStart(4, '0');
      const fechaTxt = formatFecha(pedido.fecha_recogida);
      const horaTxt  = pedido.hora_recogida?.slice(0, 5) || '';

      await whatsappSend(tenant, {
        to: pedido.cliente_telefono, type: 'text', text: { body:
          `🔔 *Recordatorio de recogida*\n\n` +
          `Hola, *${pedido.cliente_nombre}* 👋\n\n` +
          `Mañana tienes que recoger tu pedido *#${numStr}*:\n\n` +
          `📅 ${fechaTxt}\n🕐 ${horaTxt}\n📍 ${pedido.local_nombre}\n\n` +
          (pedido.pago_metodo === 'online' && !pedido.pagado
            ? `⚠️ Aún no está pagado: ${BOT_BASE_URL}/pagar/${pedido.id}\n\n` : '') +
          `¡Te esperamos! 🥐`,
        },
      });

      await supabase.from('pedidos').update({
        recordatorio_enviado: true,
        recordatorio_fecha: new Date().toISOString(),
      }).eq('id', pedido.id);

      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error('Error en cron recordatorios:', err);
  }
}

app.post('/admin/recordatorios/forzar', async (req, res) => {
  await enviarRecordatorios();
  res.json({ ok: true });
});

// ============================================================
// REDSYS
// ============================================================
app.get('/pagar/:pedidoId', async (req, res) => {
  const { data: pedido } = await supabase
    .from('pedidos').select('*, tenants(*)').eq('id', req.params.pedidoId).single();
  if (!pedido || pedido.pagado)
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>${pedido?.pagado ? '✅ Ya está pagado' : '❌ No encontrado'}</h2></body></html>`);
  const tenant = pedido.tenants;
  if (tenant.redsys_modo === 'simulacion' || !tenant.redsys_merchant_key)
    return res.send(paginaSimulacion(pedido, tenant));
  const params = construirParamsRedsys(pedido, tenant);
  res.send(`<html><body onload="document.forms[0].submit()">
    <form action="${urlRedsys(tenant.redsys_modo)}" method="POST">
      <input type="hidden" name="Ds_SignatureVersion" value="HMAC_SHA256_V1"/>
      <input type="hidden" name="Ds_MerchantParameters" value="${params.merchantParams}"/>
      <input type="hidden" name="Ds_Signature" value="${params.signature}"/>
    </form></body></html>`);
});

app.post('/redsys/ok', express.urlencoded({ extended: true }), async (req, res) => {
  res.send('OK');
  try {
    const params   = JSON.parse(Buffer.from(req.body.Ds_MerchantParameters, 'base64').toString());
    const response = parseInt(params.Ds_Response || '9999');
    const authCode = params.Ds_AuthorisationCode || '';
    if (response > 99) { await notificarPagoFallido(params.Ds_Order); return; }
    const { data: pedido } = await supabase.from('pedidos').select('*, tenants(*)').eq('pago_redsys_order', params.Ds_Order).single();
    if (!pedido) return;
    await supabase.from('pedidos').update({ pagado: true, pago_fecha: new Date().toISOString(), pago_redsys_auth: authCode, pago_redsys_response: String(params.Ds_Response) }).eq('id', pedido.id);
    const tenant = pedido.tenants;
    const numStr = String(pedido.numero_pedido).padStart(4,'0');
    await whatsappSend(tenant, { to: pedido.cliente_telefono, type:'text', text:{ body:`✅ *¡Pago recibido! Pedido #${numStr}*\n\n📍 ${pedido.local_nombre}\n📅 ${formatFecha(pedido.fecha_recogida)}\n\n¡Gracias! 🥐` } });
    await whatsappSend(tenant, { to: tenant.telefono_negocio, type:'text', text:{ body:`💳 *PAGO RECIBIDO — Pedido #${numStr}*\n${pedido.cliente_nombre} · ${pedido.total?.toFixed(2)}€` } });
  } catch (err) { console.error('Error webhook Redsys:', err); }
});

app.get('/redsys/ko', (req, res) => res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>❌ Pago no completado</h2><p>Puedes pagar en el local al recoger.</p></body></html>'));

app.post('/redsys/simular/:pedidoId/:resultado', async (req, res) => {
  res.sendStatus(200);
  const { pedidoId, resultado } = req.params;
  if (resultado !== 'ok') { await notificarPagoFallido(pedidoId); return; }
  const { data: pedido } = await supabase.from('pedidos').select('*, tenants(*)').eq('id', pedidoId).single();
  if (!pedido) return;
  await supabase.from('pedidos').update({ pagado: true, pago_fecha: new Date().toISOString(), pago_redsys_auth: 'SIM'+Math.random().toString(36).slice(2,8).toUpperCase(), pago_redsys_response: '0000' }).eq('id', pedidoId);
  const numStr = String(pedido.numero_pedido).padStart(4,'0');
  await whatsappSend(pedido.tenants, { to: pedido.cliente_telefono, type:'text', text:{ body:`✅ *¡Pago recibido! Pedido #${numStr}*\n\n📍 ${pedido.local_nombre}\n📅 ${formatFecha(pedido.fecha_recogida)}\n\n¡Gracias! 🥐` } });
});

function urlRedsys(modo) {
  return modo === 'produccion' ? 'https://sis.redsys.es/sis/realizarPago' : 'https://sis-t.redsys.es:25443/sis/realizarPago';
}
function construirParamsRedsys(pedido, tenant) {
  const params = { DS_MERCHANT_AMOUNT: String(Math.round(pedido.total*100)), DS_MERCHANT_ORDER: pedido.pago_redsys_order, DS_MERCHANT_MERCHANTCODE: tenant.redsys_merchant_code, DS_MERCHANT_CURRENCY: '978', DS_MERCHANT_TRANSACTIONTYPE: '0', DS_MERCHANT_TERMINAL: tenant.redsys_merchant_terminal, DS_MERCHANT_MERCHANTURL: `${BOT_BASE_URL}/redsys/ok`, DS_MERCHANT_URLOK: `${BOT_BASE_URL}/redsys/ok-web`, DS_MERCHANT_URLKO: `${BOT_BASE_URL}/redsys/ko`, DS_MERCHANT_CONSUMERLANGUAGE: '001', DS_MERCHANT_PRODUCTDESCRIPTION: `Pedido #${pedido.numero_pedido}` };
  const merchantParams = Buffer.from(JSON.stringify(params)).toString('base64');
  const key3DES = Buffer.from(tenant.redsys_merchant_key, 'base64');
  const orderIV = Buffer.from(pedido.pago_redsys_order.padEnd(8,'\0').slice(0,8));
  const cipher  = crypto.createCipheriv('des-ede3-cbc', key3DES, orderIV);
  const derived = Buffer.concat([cipher.update(Buffer.from(pedido.pago_redsys_order)), cipher.final()]);
  return { merchantParams, signature: crypto.createHmac('sha256', derived).update(merchantParams).digest('base64') };
}
async function notificarPagoFallido(orderOrId) {
  const { data: pedido } = await supabase.from('pedidos').select('*, tenants(*)').or(`pago_redsys_order.eq.${orderOrId},id.eq.${orderOrId}`).single();
  if (!pedido) return;
  await whatsappSend(pedido.tenants, { to: pedido.cliente_telefono, type:'text', text:{ body:`⚠️ No pudimos procesar el pago del pedido #${String(pedido.numero_pedido).padStart(4,'0')}.\n\nInténtalo: ${BOT_BASE_URL}/pagar/${pedido.id}\n\nO páganoslo en el local. 🥐` } });
}
function paginaSimulacion(pedido, tenant) {
  const numStr = String(pedido.numero_pedido).padStart(4,'0');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Pago #${numStr}</title><style>body{font-family:system-ui,sans-serif;background:#f4f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:#fff;border-radius:16px;padding:36px;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.1)}.tag{background:#dbeafe;color:#1d4ed8;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}.total{font-size:22px;font-weight:800;text-align:right;margin:16px 0}.btn{width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px}.btn-blue{background:#2563eb;color:#fff}.btn-gray{background:#f0f0f0;color:#555}</style></head><body><div class="box"><div class="tag">MODO SIMULACIÓN</div><h2>Pago pedido #${numStr}</h2><p>${tenant.nombre}</p><div class="row"><span>${pedido.cliente_nombre}</span><span>${pedido.cliente_telefono}</span></div><div class="row"><span>📍 ${pedido.local_nombre}</span><span>${pedido.fecha_recogida}</span></div><div class="total">${pedido.total?.toFixed(2)}€</div><button class="btn btn-blue" onclick="sim('ok')">💳 Simular pago aprobado</button><button class="btn btn-gray" onclick="sim('ko')">❌ Simular rechazado</button></div><script>async function sim(r){event.target.disabled=true;event.target.textContent='Procesando...';await fetch('/redsys/simular/${pedido.id}/'+r,{method:'POST'});document.querySelector('.box').innerHTML=r==='ok'?'<div style="text-align:center;padding:20px"><div style="font-size:60px">✅</div><h2>¡Pago aprobado!</h2></div>':'<div style="text-align:center;padding:20px"><div style="font-size:60px">❌</div><h2>Pago rechazado</h2></div>';}</script></body></html>`;
}

// ============================================================
// META CLOUD API
// ============================================================
async function whatsappSend(tenant, payload) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${tenant.whatsapp_phone_id}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tenant.whatsapp_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!res.ok) console.error('WA API error:', await res.text());
}
async function enviarTexto(tel, tenant, texto) {
  await whatsappSend(tenant, { to:tel, type:'text', text:{ body:texto, preview_url:false } });
}
async function enviarImagen(tel, tenant, url, caption) {
  await whatsappSend(tenant, { to:tel, type:'image', image:{ link:url, caption } });
}
async function enviarOpciones(tel, tenant, texto, botones) {
  if (botones.length <= 3) {
    await whatsappSend(tenant, { to:tel, type:'interactive', interactive:{
      type:'button', body:{ text:texto.slice(0,1024) },
      action:{ buttons: botones.map(b => ({ type:'reply', reply:{ id:b.id, title:b.title.slice(0,20) } })) },
    }});
  } else {
    await enviarLista(tel, tenant, texto, 'Ver opciones',
      [{ title:'Opciones', rows: botones.map(b => ({ id:b.id, title:b.title.slice(0,24) })) }]);
  }
}
async function enviarLista(tel, tenant, texto, botonTexto, secciones) {
  await whatsappSend(tenant, { to:tel, type:'interactive', interactive:{
    type:'list', body:{ text:texto.slice(0,1024) },
    action:{ button:botonTexto, sections:secciones },
  }});
}
// ============================================================
// ENDPOINT: Crear cliente desde panel master
// ============================================================
app.post('/admin/crear-cliente', async (req, res) => {
  const { nombre, telefono, phone_id, token, email, pass, bienvenida } = req.body;
  const authHeader = req.headers['authorization'];

  // Verificar token master simple
  if (authHeader !== `Bearer ${process.env.MASTER_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    // 1. Crear tenant
    const { data: tenant, error: tErr } = await supabase.from('tenants').insert({
      nombre, telefono_negocio: telefono,
      whatsapp_phone_id: phone_id || 'PENDIENTE',
      whatsapp_token: token || 'PENDIENTE',
      mensaje_bienvenida: bienvenida || `¡Bienvenido/a a *${nombre}*!`,
      pago_online_activo: false, recordatorios_activos: false,
    }).select().single();
    if (tErr) throw tErr;

    // 2. Crear usuario en Supabase Auth
    const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: pass, email_confirm: true }),
    });
    const authData = await authRes.json();
    if (!authRes.ok) throw new Error(authData.message || 'Error creando usuario');

    // 3. Vincular usuario con tenant
    const { error: linkErr } = await supabase.from('tenant_users').insert({
      user_id: authData.id, tenant_id: tenant.id, role: 'admin',
    });
    if (linkErr) throw linkErr;

    res.json({ ok: true, tenant_id: tenant.id, user_id: authData.id });

  } catch (err) {
    console.error('Error crear-cliente:', err);
    res.status(500).json({ error: err.message });
  }
});
// ============================================================
app.listen(PORT, () => console.log(`🚀 OrderBot v6 corriendo en :${PORT}`));

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
  // Link web como alternativa (solo primera vez)
  if (s.carrito.length === 0) {
    await enviarTexto(telefono, tenant,
      `\u{1F4A1} _\u00bfPrefieres hacer el pedido desde la web? M\u00e1s r\u00e1pido si tienes varios productos:_\n\u{1F449} ${BOT_BASE_URL}/pedido/${tenantSlug(tenant.nombre)}`);
  }
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
app.listen(PORT, () => console.log(`🚀 OrderBot v6 corriendo en :${PORT}`));

// ============================================================
// WEB DE PEDIDO — /pedido/:slug
// ============================================================

// Añadir slug a tenants (usamos el nombre en minúsculas sin espacios)
function tenantSlug(nombre) {
  return nombre.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Endpoint: sirve la web de pedido
app.get('/pedido/:slug', async (req, res) => {
  const slug = req.params.slug;

  // Buscar tenant por slug (nombre normalizado)
  const { data: tenants } = await supabase.from('tenants').select('*, locales(*), productos(*)').eq('activo', true);
  const tenant = tenants?.find(t => tenantSlug(t.nombre) === slug);

  if (!tenant) return res.status(404).send('<h2>Negocio no encontrado</h2>');

  // Preparar datos
  const productos = (tenant.productos || []).filter(p => p.disponible).sort((a,b) => a.orden - b.orden);
  const locales   = (tenant.locales   || []).filter(l => l.activo).sort((a,b) => a.orden - b.orden);

  const html = generarWebPedido(tenant, productos, locales);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Endpoint: recibir pedido desde la web
app.post('/pedido/:slug/confirmar', async (req, res) => {
  const slug = req.params.slug;
  const { nombre, telefono, local, fecha, hora, observaciones, carrito } = req.body;

  const { data: tenants } = await supabase.from('tenants').select('*').eq('activo', true);
  const tenant = tenants?.find(t => tenantSlug(t.nombre) === slug);
  if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

  const { data: locales } = await supabase.from('locales').select('*').eq('tenant_id', tenant.id);
  const localObj = locales?.find(l => l.id === local);

  try {
    const { data: num } = await supabase.rpc('siguiente_numero_pedido', { p_tenant_id: tenant.id });
    const total = carrito.reduce((s, l) => s + l.precio * l.cantidad, 0);

    const { data: pedido, error } = await supabase.from('pedidos').insert({
      tenant_id:        tenant.id,
      local_id:         local,
      local_nombre:     localObj?.nombre || local,
      numero_pedido:    num,
      cliente_nombre:   nombre,
      cliente_telefono: telefono,
      fecha_recogida:   fecha,
      hora_recogida:    hora + ':00',
      observaciones:    observaciones || null,
      estado:           'confirmado',
      origen:           'web',
      pago_metodo:      'local',
      pagado:           false,
      total,
      whatsapp_session_id: telefono,
    }).select().single();

    if (error) throw error;

    await supabase.from('pedido_lineas').insert(
      carrito.map(l => ({
        pedido_id: pedido.id,
        producto_id: l.id,
        producto_nombre: l.nombre,
        producto_precio: l.precio,
        cantidad: l.cantidad,
      }))
    );

    const numStr = String(num).padStart(4, '0');

    // Notificación WhatsApp al cliente
    const lineasTxt = carrito.map(l => `• ${l.cantidad}× ${l.nombre}`).join('\n');
    await whatsappSend(tenant, {
      to: telefono, type: 'text', text: { body:
        `🎉 *¡Pedido #${numStr} confirmado!*\n\n` +
        `${lineasTxt}\n💰 Total: ${total.toFixed(2)}€\n\n` +
        `📍 ${localObj?.nombre || local}\n` +
        `📅 ${new Date(fecha+'T12:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'})} a las ${hora}h\n\n` +
        `¡Gracias y hasta pronto! 🥐`,
      },
    });

    // Notificación a la tienda
    await whatsappSend(tenant, {
      to: tenant.telefono_negocio, type: 'text', text: { body:
        `🔔 *NUEVO PEDIDO #${numStr}* (Web)\n\n` +
        `👤 ${nombre} · 📞 ${telefono}\n\n${lineasTxt}\n` +
        `💰 ${total.toFixed(2)}€\n📍 ${localObj?.nombre || local}\n` +
        `📅 ${fecha} ${hora}h`,
      },
    });

    const fechaLegible = new Date(fecha+'T12:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}); const lineasResumen = carrito.map(l => ({ nombre: l.nombre, cantidad: l.cantidad, subtotal: l.precio * l.cantidad })); res.json({    ok: true, numStr,    telefono_negocio: tenant.telefono_negocio,    tenant_nombre: tenant.nombre,   local_nombre: localObj?.nombre || local,   fecha_legible: fechaLegible,   hora,   total,   lineas: lineasResumen, });
  } catch(err) {
    console.error('Error pedido web:', err);
    res.status(500).json({ error: err.message });
  }
});

function generarWebPedido(tenant, productos, locales) {
  const hoy = new Date().toISOString().split('T')[0];
  const productosJson = JSON.stringify(productos.map(p => ({
    id: p.id, nombre: p.nombre, descripcion: p.descripcion,
    precio: p.precio, imagen_url: p.imagen_url,
  })));
  const localesJson = JSON.stringify(locales.map(l => ({ id: l.id, nombre: l.nombre })));
  const slug = tenantSlug(tenant.nombre);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Pedido — ${tenant.nombre}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:system-ui,sans-serif;background:#f4f4f6;min-height:100vh;padding-bottom:100px;}
.header{background:#0f172a;color:#fff;padding:16px 20px;position:sticky;top:0;z-index:100;}
.header-inner{display:flex;align-items:center;gap:10px;max-width:480px;margin:0 auto;}
.logo{font-size:20px;font-weight:800;letter-spacing:-1px;}
.logo span{font-weight:300;}
.tenant-name{font-size:12px;color:rgba(255,255,255,.5);margin-top:2px;}
.content{max-width:480px;margin:0 auto;padding:16px;}
.section{background:#fff;border-radius:12px;margin-bottom:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);}
.section-title{padding:14px 16px;font-size:13px;font-weight:700;color:#555;border-bottom:1px solid #f0f0f0;text-transform:uppercase;letter-spacing:.04em;}
.prod-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #f5f5f5;}
.prod-row:last-child{border:none;}
.prod-img{width:52px;height:52px;border-radius:8px;object-fit:cover;background:#f0f0f0;flex-shrink:0;}
.prod-img-ph{width:52px;height:52px;border-radius:8px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}
.prod-info{flex:1;min-width:0;}
.prod-nombre{font-size:14px;font-weight:700;color:#111;}
.prod-desc{font-size:11px;color:#999;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.prod-precio{font-size:14px;font-weight:800;color:#1FB86A;margin-top:3px;}
.stepper{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.stepper button{width:30px;height:30px;border-radius:50%;border:none;background:#f0f0f0;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700;color:#333;}
.stepper button.active{background:#1FB86A;color:#fff;}
.stepper span{font-size:15px;font-weight:700;width:20px;text-align:center;}
.field{padding:12px 16px;border-bottom:1px solid #f5f5f5;}
.field:last-child{border:none;}
.field label{display:block;font-size:11px;font-weight:700;color:#999;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;}
.field input,.field select,.field textarea{width:100%;border:none;outline:none;font-size:15px;font-family:inherit;color:#111;background:transparent;}
.field textarea{resize:none;height:56px;}
.carrito-bar{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e5e7eb;padding:12px 16px;padding-bottom:max(12px,env(safe-area-inset-bottom));}
.carrito-inner{max-width:480px;margin:0 auto;display:flex;align-items:center;gap:12px;}
.carrito-info{flex:1;}
.carrito-total{font-size:18px;font-weight:800;color:#111;}
.carrito-items{font-size:12px;color:#999;}
.btn-confirmar{padding:14px 24px;background:#1FB86A;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;white-space:nowrap;}
.btn-confirmar:disabled{background:#ccc;cursor:not-allowed;}
.screen{display:none;} .screen.active{display:block;}
.success{text-align:center;padding:60px 20px;}
.success-icon{font-size:64px;margin-bottom:16px;}
.success h2{font-size:22px;font-weight:800;color:#111;margin-bottom:8px;}
.success p{color:#666;font-size:14px;line-height:1.6;}
.success .num{font-size:28px;font-weight:800;color:#1FB86A;margin:12px 0;}
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div>
      <div class="logo"><span>Pedi</span>d<svg width="20" height="20" viewBox="0 0 120 120" style="display:inline-block;vertical-align:-0.07em;margin:0 1px"><circle cx="60" cy="56" r="52" fill="#1FB86A"/><path d="M22 88 L14 116 L48 104 Z" fill="#1FB86A"/><g transform="translate(4,-1)" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><path d="M28 60 L40 72 L66 42"/><path d="M53 67 L58 72 L84 42"/></g></svg>ne</div>
      <div class="tenant-name">${tenant.nombre}</div>
    </div>
  </div>
</div>

<div id="screen-pedido" class="screen active">
  <div class="content">

    <!-- Productos -->
    <div class="section">
      <div class="section-title">🛒 Selecciona tus productos</div>
      <div id="productos-lista"></div>
    </div>

    <!-- Datos -->
    <div class="section">
      <div class="section-title">👤 Tus datos</div>
      <div class="field">
        <label>Nombre completo *</label>
        <input id="nombre" type="text" placeholder="Tu nombre" autocomplete="name"/>
      </div>
      <div class="field">
        <label>Teléfono WhatsApp * <span style="font-weight:400;text-transform:none">(recibirás confirmación)</span></label>
        <input id="telefono" type="tel" placeholder="34612345678" autocomplete="tel"/>
      </div>
    </div>

    <!-- Recogida -->
    <div class="section">
      <div class="section-title">📅 Recogida</div>
      ${locales.length > 1 ? `
      <div class="field">
        <label>Local *</label>
        <select id="local">${locales.map(l => `<option value="${l.id}">${l.nombre}</option>`).join('')}</select>
      </div>` : `<input type="hidden" id="local" value="${locales[0]?.id || ''}"/>`}
      <div class="field">
        <label>Fecha *</label>
        <input id="fecha" type="date" min="${hoy}"/>
      </div>
      <div class="field">
        <label>Hora *</label>
        <input id="hora" type="time" min="07:00" max="20:30" step="1800"/>
      </div>
      <div class="field">
        <label>Observaciones <span style="font-weight:400;text-transform:none">(opcional)</span></label>
        <textarea id="obs" placeholder="Alergias, instrucciones especiales..."></textarea>
      </div>
    </div>

  </div>

  <!-- Barra inferior -->
  <div class="carrito-bar">
    <div class="carrito-inner">
      <div class="carrito-info">
        <div class="carrito-total" id="total-display">0,00€</div>
        <div class="carrito-items" id="items-display">Sin productos</div>
      </div>
      <button class="btn-confirmar" id="btn-confirmar" disabled onclick="confirmarPedido()">
        Confirmar →
      </button>
    </div>
  </div>
</div>

<div id="screen-success" class="screen">
  <div class="content">
    <div class="success">
      <div class="success-icon">🎉</div>
      <h2>¡Pedido confirmado!</h2>
      <div class="num" id="success-num">#0000</div>
      <p>Te hemos enviado la confirmación por WhatsApp.<br/>¡Te esperamos en <strong>${tenant.nombre}</strong>!</p>
    </div>
  </div>
</div>

<script>
const PRODUCTOS = ${productosJson};
const SLUG = '${slug}';
let cantidades = {};

// Render productos
const lista = document.getElementById('productos-lista');
PRODUCTOS.forEach(p => {
  cantidades[p.id] = 0;
  const div = document.createElement('div');
  div.className = 'prod-row';
  div.id = 'prod-'+p.id;
  div.innerHTML = \`
    \${p.imagen_url
      ? \`<img class="prod-img" src="\${p.imagen_url}" alt="\${p.nombre}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="prod-img-ph" style="display:none">📦</div>\`
      : \`<div class="prod-img-ph">📦</div>\`}
    <div class="prod-info">
      <div class="prod-nombre">\${p.nombre}</div>
      \${p.descripcion ? \`<div class="prod-desc">\${p.descripcion}</div>\` : ''}
      <div class="prod-precio">\${p.precio.toFixed(2).replace('.',',')}€</div>
    </div>
    <div class="stepper">
      <button onclick="cambiar('\${p.id}',-1)">−</button>
      <span id="qty-\${p.id}">0</span>
      <button class="active" onclick="cambiar('\${p.id}',1)">+</button>
    </div>
  \`;
  lista.appendChild(div);
});

function cambiar(id, delta) {
  cantidades[id] = Math.max(0, (cantidades[id]||0) + delta);
  document.getElementById('qty-'+id).textContent = cantidades[id];
  actualizarTotal();
}

function actualizarTotal() {
  let total = 0, items = 0;
  PRODUCTOS.forEach(p => {
    total += p.precio * (cantidades[p.id]||0);
    items += cantidades[p.id]||0;
  });
  document.getElementById('total-display').textContent = total.toFixed(2).replace('.',',')+'€';
  document.getElementById('items-display').textContent = items===0 ? 'Sin productos' : items+' producto'+(items===1?'':'s');
  document.getElementById('btn-confirmar').disabled = items === 0;
}

async function confirmarPedido() {
  const nombre   = document.getElementById('nombre').value.trim();
  const telefono = document.getElementById('telefono').value.trim().replace(/\\D/g,'');
  const local    = document.getElementById('local').value;
  const fecha    = document.getElementById('fecha').value;
  const hora     = document.getElementById('hora').value;
  const obs      = document.getElementById('obs').value.trim();

  if (!nombre)         { alert('Introduce tu nombre'); return; }
  // Añadir prefijo 34 automáticamente si no lo tienen let telFinal = telefono.replace(/\D/g,''); if (telFinal.startsWith('6') || telFinal.startsWith('7') || telFinal.startsWith('9')) {   telFinal = '34' + telFinal; } if (telFinal.length < 11) { alert('Introduce un teléfono válido'); return; }
  if (!fecha)          { alert('Selecciona la fecha de recogida'); return; }
  if (!hora)           { alert('Selecciona la hora de recogida'); return; }

  const carrito = PRODUCTOS
    .filter(p => cantidades[p.id] > 0)
    .map(p => ({ id: p.id, nombre: p.nombre, precio: p.precio, cantidad: cantidades[p.id] }));

  if (!carrito.length) { alert('Añade al menos un producto'); return; }

  const btn = document.getElementById('btn-confirmar');
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  try {
    const res = await fetch('/pedido/'+SLUG+'/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, telefono, local, fecha, hora, observaciones: obs, carrito }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    document.getElementById('success-num').textContent = '#'+data.numStr;
    // Redirigir a WhatsApp con el resumen completo
    const telNegocio = data.telefono_negocio || '';
    const lineasTxt = (data.lineas||[]).map(l => '• '+l.cantidad+'× '+l.nombre+' — '+parseFloat(l.subtotal).toFixed(2)+'€').join('\n');
    const msg = encodeURIComponent(
      '✅ Pedido #' + data.numStr + ' confirmado en ' + data.tenant_nombre + '\n\n' +
      lineasTxt + '\n\n' +
      '💰 Total: ' + parseFloat(data.total).toFixed(2) + '€\n' +
      '📍 ' + data.local_nombre + '\n' +
      '📅 ' + data.fecha_legible + ' a las ' + data.hora + 'h\n\n' +
      '¡Hasta pronto! 🥐'
    );
    setTimeout(() => {
      window.location.href = 'https://wa.me/' + telNegocio + '?text=' + msg;
    }, 1500);
    document.getElementById('screen-pedido').classList.remove('active');
    document.getElementById('screen-success').classList.add('active');
    window.scrollTo(0,0);
  } catch(err) {
    alert('Error: '+err.message);
    btn.disabled = false;
    btn.textContent = 'Confirmar →';
  }
}
</script>
</body>
</html>`;
}

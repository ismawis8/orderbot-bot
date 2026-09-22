// ============================================================
// ORDERBOT — server.js v5 COMPLETO
// WhatsApp bot + Redsys + Recordatorios automáticos (cron)
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
  BOT_BASE_URL,   // ej: https://tu-bot.railway.app
  PORT = 3000,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// HORARIOS  L-V 08:00-21:00 | Sáb 08:00-13:00 | Dom cerrado
// ============================================================
function generarSlots(fecha) {
  const dow = new Date(fecha + 'T12:00:00').getDay();
  if (dow === 0) return [];
  const [hFin, mFin] = dow === 6 ? [13, 0] : [21, 0];
  const slots = [];
  let h = 8, m = 0;
  while (h < hFin || (h === hFin && m < mFin)) {
    slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    m += 30; if (m >= 60) { m = 0; h++; }
  }
  return slots;
}

function diasDisponibles() {
  const dias = [], hoy = new Date();
  hoy.setHours(0,0,0,0);
  for (let i = 0; dias.length < 10; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() + i);
    if (d.getDay() !== 0) dias.push(d.toISOString().split('T')[0]);
  }
  return dias;
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
// ============================================================
const sesiones = new Map();

function crearSesion(telefono, nombre) {
  return {
    paso: 'inicio', nombre, telefono, carrito: [], productoIdx: 0,
    localId: null, localNombre: null, fecha: null, hora: null,
    observaciones: null, metodo_pago: null,
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
      s.productoIdx = 0;
      s.paso = 'viendo_producto';
      await mostrarProducto(telefono, tenant, s);
      break;

    case 'viendo_producto':
      if (entrada === 'añadir') {
        s.paso = 'cantidad';
        await enviarTexto(telefono, tenant,
          `¿Cuántas unidades de *${tenant.productos[s.productoIdx].nombre}*? (1-20)`);
      } else if (entrada === 'siguiente') {
        s.productoIdx++;
        if (s.productoIdx >= tenant.productos.length) {
          if (!s.carrito.length) { s.productoIdx = 0; await mostrarProducto(telefono, tenant, s); }
          else { s.paso = 'nombre'; await pedirNombre(telefono, tenant); }
        } else { await mostrarProducto(telefono, tenant, s); }
      } else if (entrada === 'ver_carrito') {
        await mostrarCarrito(telefono, tenant, s); s.paso = 'carrito';
      } else { await mostrarProducto(telefono, tenant, s); }
      break;

    case 'cantidad': {
      const n = parseInt(entrada);
      if (isNaN(n) || n < 1 || n > 20) { await enviarTexto(telefono, tenant, '⚠️ Escribe un número entre 1 y 20.'); break; }
      const prod = tenant.productos[s.productoIdx];
      const idx  = s.carrito.findIndex(l => l.id === prod.id);
      if (idx >= 0) s.carrito[idx].cantidad += n;
      else s.carrito.push({ id: prod.id, nombre: prod.nombre, precio: prod.precio, cantidad: n });
      s.productoIdx++;
      if (s.productoIdx >= tenant.productos.length) {
        await enviarTexto(telefono, tenant, `✅ Añadido: ${n}× *${prod.nombre}*\n\nHas visto todos los productos.`);
        s.paso = 'nombre'; await pedirNombre(telefono, tenant);
      } else {
        await enviarOpciones(telefono, tenant, `✅ Añadido: ${n}× *${prod.nombre}*`,
          [{ id:'siguiente', title:'⏭ Siguiente producto' }, { id:'ver_carrito', title:'🛒 Ver carrito' }]);
        s.paso = 'viendo_producto';
      }
      break;
    }

    case 'carrito':
      if (entrada === 'seguir') { s.paso = 'viendo_producto'; await mostrarProducto(telefono, tenant, s); }
      else if (entrada === 'continuar') { s.paso = 'nombre'; await pedirNombre(telefono, tenant); }
      break;

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

    case 'fecha': {
      if (!diasDisponibles().includes(entrada)) { await pedirFecha(telefono, tenant); break; }
      s.fecha = entrada; s.paso = 'hora'; await pedirHora(telefono, tenant, s.fecha);
      break;
    }

    case 'hora': {
      if (!generarSlots(s.fecha).includes(entrada)) { await pedirHora(telefono, tenant, s.fecha); break; }
      s.hora = entrada; s.paso = 'observaciones';
      await enviarOpciones(telefono, tenant,
        '📝 ¿Alguna observación o alergia?\n_(Escríbela o salta el paso)_',
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
async function mostrarProducto(telefono, tenant, s) {
  const prod = tenant.productos[s.productoIdx];
  if (!prod) return;
  const n = s.productoIdx + 1, total = tenant.productos.length;
  const enCarrito = s.carrito.find(l => l.id === prod.id);
  const extra = enCarrito ? `\n_Ya tienes ${enCarrito.cantidad} en el carrito_` : '';
  if (prod.imagen_url)
    await enviarImagen(telefono, tenant, prod.imagen_url,
      `*${prod.nombre}* (${n}/${total})\n${prod.descripcion}\n💰 *${prod.precio.toFixed(2)}€*${extra}`);
  const botones = [{ id:'añadir', title:'➕ Añadir al pedido' }];
  if (n < total) botones.push({ id:'siguiente', title:'⏭ Siguiente' });
  if (s.carrito.length > 0) botones.push({ id:'ver_carrito', title:'🛒 Ver carrito' });
  await enviarOpciones(telefono, tenant, `*${prod.nombre}* — ${prod.precio.toFixed(2)}€${extra}`, botones);
}

async function mostrarCarrito(telefono, tenant, s) {
  if (!s.carrito.length) { await enviarTexto(telefono, tenant, '🛒 Tu carrito está vacío.'); return; }
  const lineas = s.carrito.map(l => `• ${l.cantidad}× ${l.nombre} — ${(l.cantidad*l.precio).toFixed(2)}€`).join('\n');
  const total  = s.carrito.reduce((a, l) => a + l.cantidad * l.precio, 0);
  await enviarOpciones(telefono, tenant,
    `🛒 *Tu carrito:*\n\n${lineas}\n\n💰 *Total: ${total.toFixed(2)}€*`,
    [{ id:'seguir', title:'➕ Seguir comprando' }, { id:'continuar', title:'✅ Continuar' }]);
}

async function pedirNombre(telefono, tenant) {
  await enviarTexto(telefono, tenant, '👤 ¿Cuál es tu *nombre completo* para el pedido?');
}

async function pedirLocal(telefono, tenant) {
  const botones = tenant.locales.map(l => ({ id: l.id, title: `📍 ${l.nombre}` }));
  await enviarOpciones(telefono, tenant, '🏪 ¿En qué local quieres recoger tu pedido?', botones);
}

async function pedirFecha(telefono, tenant) {
  const rows = diasDisponibles().map(d => ({
    id: d,
    title: formatFecha(d).charAt(0).toUpperCase() + formatFecha(d).slice(1),
    description: d,
  }));
  await enviarLista(telefono, tenant, '📅 ¿Qué día quieres recoger?', 'Ver días',
    [{ title: 'Días disponibles', rows }]);
}

async function pedirHora(telefono, tenant, fecha) {
  const slots = generarSlots(fecha);
  if (!slots.length) { await enviarTexto(telefono, tenant, '⚠️ Ese día estamos cerrados. Elige otro día.'); return; }
  await enviarLista(telefono, tenant,
    `🕐 ¿A qué hora recoges el *${formatFecha(fecha)}*?\n_(L-V: 08:00-21:00 | Sáb: 08:00-13:00)_`,
    'Ver horas', [{ title: 'Horas disponibles', rows: slots.slice(0,10).map(h => ({ id:h, title:h })) }]);
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
    `📅 Recogida: ${formatFecha(s.fecha)} a las *${s.hora}h*\n` +
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
      hora_recogida:       s.hora + ':00',
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
        `Te esperamos el *${formatFecha(s.fecha)} a las ${s.hora}h*\n` +
        `📍 en *${s.localNombre}*\n` +
        `💰 Pagarás *${total.toFixed(2)}€* en el local.\n\n` +
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
        `📍 ${s.localNombre}\n📅 ${formatFecha(s.fecha)} — ${s.hora}h\n` +
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
// RECORDATORIOS AUTOMÁTICOS — cron cada día a las 18:00
// ============================================================
cron.schedule('0 18 * * *', async () => {
  console.log('⏰ Cron recordatorios iniciado:', new Date().toISOString());
  await enviarRecordatorios();
}, { timezone: 'Europe/Madrid' });

async function enviarRecordatorios() {
  try {
    // Calcular fecha de mañana
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const mananaStr = manana.toISOString().split('T')[0];

    // Buscar pedidos de mañana con recordatorios activos y no enviados
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('*, tenants(*)')
      .eq('fecha_recogida', mananaStr)
      .eq('estado', 'confirmado')
      .eq('recordatorio_enviado', false)
      .eq('tenants.recordatorios_activos', true);

    if (error) { console.error('Error buscando pedidos para recordatorio:', error); return; }
    if (!pedidos?.length) { console.log('No hay recordatorios que enviar hoy.'); return; }

    console.log(`📬 Enviando ${pedidos.length} recordatorios...`);

    for (const pedido of pedidos) {
      const tenant = pedido.tenants;
      if (!tenant?.recordatorios_activos) continue;

      const numStr   = String(pedido.numero_pedido).padStart(4, '0');
      const fechaTxt = formatFecha(pedido.fecha_recogida);
      const horaTxt  = pedido.hora_recogida.slice(0, 5);

      const mensaje =
        `🔔 *Recordatorio de recogida*\n\n` +
        `Hola, *${pedido.cliente_nombre}* 👋\n\n` +
        `Te recordamos que *mañana* tienes pendiente recoger tu pedido:\n\n` +
        `📦 *Pedido #${numStr}*\n` +
        `📅 ${fechaTxt} a las *${horaTxt}h*\n` +
        `📍 ${pedido.local_nombre}\n\n` +
        (pedido.pago_metodo === 'online' && !pedido.pagado
          ? `⚠️ *Tu pedido aún no está pagado.* Puedes hacerlo aquí:\n💳 ${BOT_BASE_URL}/pagar/${pedido.id}\n\n`
          : '') +
        `¡Te esperamos! 🥐`;

      try {
        await whatsappSend(tenant, {
          to: pedido.cliente_telefono, type: 'text', text: { body: mensaje },
        });

        // Marcar como enviado
        await supabase.from('pedidos').update({
          recordatorio_enviado: true,
          recordatorio_fecha:   new Date().toISOString(),
        }).eq('id', pedido.id);

        console.log(`✅ Recordatorio enviado — Pedido #${numStr} → ${pedido.cliente_telefono}`);

      } catch (err) {
        console.error(`❌ Error enviando recordatorio pedido #${numStr}:`, err);
      }

      // Pausa entre mensajes para no saturar la API
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('⏰ Cron recordatorios finalizado.');

  } catch (err) {
    console.error('❌ Error en cron de recordatorios:', err);
  }
}

// Endpoint manual para forzar el envío de recordatorios (útil para pruebas)
app.post('/admin/recordatorios/forzar', async (req, res) => {
  console.log('🔧 Recordatorios forzados manualmente');
  await enviarRecordatorios();
  res.json({ ok: true, mensaje: 'Recordatorios procesados' });
});

// ============================================================
// PASARELA REDSYS
// ============================================================
app.get('/pagar/:pedidoId', async (req, res) => {
  const { data: pedido } = await supabase
    .from('pedidos').select('*, tenants(*)').eq('id', req.params.pedidoId).single();
  if (!pedido || pedido.pagado)
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>${pedido?.pagado ? '✅ Este pedido ya está pagado' : '❌ Pedido no encontrado'}</h2>
    </body></html>`);

  const tenant = pedido.tenants;
  if (tenant.redsys_modo === 'simulacion' || !tenant.redsys_merchant_key)
    return res.send(paginaSimulacion(pedido, tenant));

  const params = construirParamsRedsys(pedido, tenant);
  res.send(`<!DOCTYPE html><html><head><title>Pago seguro</title></head>
  <body onload="document.forms[0].submit()">
    <form action="${urlRedsys(tenant.redsys_modo)}" method="POST">
      <input type="hidden" name="Ds_SignatureVersion" value="HMAC_SHA256_V1"/>
      <input type="hidden" name="Ds_MerchantParameters" value="${params.merchantParams}"/>
      <input type="hidden" name="Ds_Signature" value="${params.signature}"/>
    </form>
    <p style="font-family:sans-serif;text-align:center;margin-top:80px">Redirigiendo al pago seguro...</p>
  </body></html>`);
});

app.post('/redsys/ok', express.urlencoded({ extended: true }), async (req, res) => {
  res.send('OK');
  try {
    const params   = JSON.parse(Buffer.from(req.body.Ds_MerchantParameters, 'base64').toString());
    const order    = params.Ds_Order;
    const response = parseInt(params.Ds_Response || '9999');
    const authCode = params.Ds_AuthorisationCode || '';
    if (response > 99) { await notificarPagoFallido(order); return; }

    const { data: pedido } = await supabase
      .from('pedidos').select('*, tenants(*)').eq('pago_redsys_order', order).single();
    if (!pedido) return;

    await supabase.from('pedidos').update({
      pagado: true, pago_fecha: new Date().toISOString(),
      pago_redsys_auth: authCode, pago_redsys_response: String(params.Ds_Response),
    }).eq('id', pedido.id);

    const tenant  = pedido.tenants;
    const numStr  = String(pedido.numero_pedido).padStart(4, '0');
    await whatsappSend(tenant, {
      to: pedido.cliente_telefono, type: 'text', text: { body:
        `✅ *¡Pago recibido! Pedido #${numStr}*\n\n` +
        `📍 ${pedido.local_nombre}\n` +
        `📅 ${formatFecha(pedido.fecha_recogida)} a las *${pedido.hora_recogida.slice(0,5)}h*\n\n` +
        `¡Gracias! 🥐`,
      },
    });
    await whatsappSend(tenant, {
      to: tenant.telefono_negocio, type: 'text', text: { body:
        `💳 *PAGO RECIBIDO — Pedido #${numStr}*\n${pedido.cliente_nombre} · ${pedido.total?.toFixed(2)}€\nAuth: ${authCode}`,
      },
    });
  } catch (err) { console.error('Error en webhook Redsys:', err); }
});

app.get('/redsys/ko', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>❌ Pago no completado</h2>
    <p>Puedes intentarlo de nuevo o pagar en el local cuando recojas.</p>
  </body></html>`);
});

app.post('/redsys/simular/:pedidoId/:resultado', async (req, res) => {
  res.sendStatus(200);
  const { pedidoId, resultado } = req.params;
  if (resultado !== 'ok') { await notificarPagoFallido(pedidoId); return; }
  const { data: pedido } = await supabase
    .from('pedidos').select('*, tenants(*)').eq('id', pedidoId).single();
  if (!pedido) return;
  await supabase.from('pedidos').update({
    pagado: true, pago_fecha: new Date().toISOString(),
    pago_redsys_auth: 'SIM' + Math.random().toString(36).slice(2,8).toUpperCase(),
    pago_redsys_response: '0000',
  }).eq('id', pedidoId);
  const tenant = pedido.tenants;
  const numStr = String(pedido.numero_pedido).padStart(4, '0');
  await whatsappSend(tenant, {
    to: pedido.cliente_telefono, type: 'text', text: { body:
      `✅ *¡Pago recibido! Pedido #${numStr}*\n\n📍 ${pedido.local_nombre}\n📅 ${formatFecha(pedido.fecha_recogida)} a las *${pedido.hora_recogida.slice(0,5)}h*\n\n¡Gracias! 🥐`,
    },
  });
});

function urlRedsys(modo) {
  return modo === 'produccion'
    ? 'https://sis.redsys.es/sis/realizarPago'
    : 'https://sis-t.redsys.es:25443/sis/realizarPago';
}

function construirParamsRedsys(pedido, tenant) {
  const importe = Math.round(pedido.total * 100);
  const params  = {
    DS_MERCHANT_AMOUNT: String(importe), DS_MERCHANT_ORDER: pedido.pago_redsys_order,
    DS_MERCHANT_MERCHANTCODE: tenant.redsys_merchant_code, DS_MERCHANT_CURRENCY: '978',
    DS_MERCHANT_TRANSACTIONTYPE: '0', DS_MERCHANT_TERMINAL: tenant.redsys_merchant_terminal,
    DS_MERCHANT_MERCHANTURL: `${BOT_BASE_URL}/redsys/ok`,
    DS_MERCHANT_URLOK: `${BOT_BASE_URL}/redsys/ok-web`, DS_MERCHANT_URLKO: `${BOT_BASE_URL}/redsys/ko`,
    DS_MERCHANT_CONSUMERLANGUAGE: '001',
    DS_MERCHANT_PRODUCTDESCRIPTION: `Pedido #${pedido.numero_pedido} ${tenant.nombre}`,
  };
  const merchantParams = Buffer.from(JSON.stringify(params)).toString('base64');
  const key3DES  = Buffer.from(tenant.redsys_merchant_key, 'base64');
  const orderIV  = Buffer.from(pedido.pago_redsys_order.padEnd(8,'\0').slice(0,8));
  const cipher   = crypto.createCipheriv('des-ede3-cbc', key3DES, orderIV);
  const derived  = Buffer.concat([cipher.update(Buffer.from(pedido.pago_redsys_order)), cipher.final()]);
  const signature = crypto.createHmac('sha256', derived).update(merchantParams).digest('base64');
  return { merchantParams, signature };
}

async function notificarPagoFallido(orderOrId) {
  const { data: pedido } = await supabase
    .from('pedidos').select('*, tenants(*)')
    .or(`pago_redsys_order.eq.${orderOrId},id.eq.${orderOrId}`)
    .single();
  if (!pedido) return;
  await whatsappSend(pedido.tenants, {
    to: pedido.cliente_telefono, type: 'text', text: { body:
      `⚠️ *No pudimos procesar el pago del pedido #${String(pedido.numero_pedido).padStart(4,'0')}.*\n\n` +
      `Inténtalo de nuevo: ${BOT_BASE_URL}/pagar/${pedido.id}\n\n` +
      `O páganoslo en el local cuando vengas a recoger. 🥐`,
    },
  });
}

function paginaSimulacion(pedido, tenant) {
  const numStr = String(pedido.numero_pedido).padStart(4, '0');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pago — Pedido #${numStr}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:36px;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.1)}
h2{margin:0 0 4px;font-size:20px}.sub{color:#888;font-size:13px;margin-bottom:24px}
.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
.total{font-size:22px;font-weight:800;text-align:right;margin:16px 0}
.tag{display:inline-block;background:#dbeafe;color:#1d4ed8;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:20px}
.btn{width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px}
.btn-blue{background:#2563eb;color:#fff}.btn-gray{background:#f0f0f0;color:#555}
.nota{font-size:11px;color:#aaa;text-align:center;margin-top:12px}</style></head>
<body><div class="box">
<div class="tag">MODO SIMULACIÓN</div>
<h2>Pago pedido #${numStr}</h2>
<div class="sub">${tenant.nombre}</div>
<div class="row"><span>${pedido.cliente_nombre}</span><span>${pedido.cliente_telefono}</span></div>
<div class="row"><span>📍 ${pedido.local_nombre}</span><span>${pedido.fecha_recogida} ${(pedido.hora_recogida||'').slice(0,5)}h</span></div>
<div class="total">${pedido.total?.toFixed(2)}€</div>
<button class="btn btn-blue" onclick="sim('ok')">💳 Simular pago aprobado</button>
<button class="btn btn-gray" onclick="sim('ko')">❌ Simular pago rechazado</button>
<div class="nota">En producción aquí aparece el formulario seguro de Redsys (tarjeta y Bizum)</div>
</div>
<script>
async function sim(r){
  event.target.disabled=true; event.target.textContent='Procesando...';
  await fetch('/redsys/simular/${pedido.id}/'+r,{method:'POST'});
  document.querySelector('.box').innerHTML=r==='ok'
    ?'<div style="text-align:center;padding:20px"><div style="font-size:60px">✅</div><h2>¡Pago aprobado!</h2><p style="color:#888">Recibirás confirmación por WhatsApp.</p></div>'
    :'<div style="text-align:center;padding:20px"><div style="font-size:60px">❌</div><h2>Pago rechazado</h2><p style="color:#888">Puedes pagar en el local al recoger.</p></div>';
}
</script></body></html>`;
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
      [{ title:'Opciones', rows: botones.map(b => ({ id:b.id, title:b.title })) }]);
  }
}
async function enviarLista(tel, tenant, texto, botonTexto, secciones) {
  await whatsappSend(tenant, { to:tel, type:'interactive', interactive:{
    type:'list', body:{ text:texto.slice(0,1024) },
    action:{ button:botonTexto, sections:secciones },
  }});
}

// ============================================================
app.listen(PORT, () => console.log(`🚀 OrderBot v5 corriendo en :${PORT}`));

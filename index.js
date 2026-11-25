require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

let currentQR = null;
let isConnected = false;
let waSock = null;

// Memoria con caducidad: guarda mensajes y cuándo ocurrieron
// { [remoteJid]: { lastUpdated: timestamp, messages: [ { role, text, time } ] } }
const chatHistory = {};

// Tiempo de vida de la memoria: 24 Horas
// Si un cliente vuelve a hablar después de 24 horas (o 3 meses), el bot empieza de cero como cliente nuevo
const MEMORY_EXPIRATION_MS = 24 * 60 * 60 * 1000;

// Pausa por intervención manual de Adrián: 3 horas
const pausedChats = {};

// Configuración de Gemini API
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LW13eL7Kn5plAXhfRBYvmm8xk2751rZ43gC3crYjvwxg";
const MODEL_NAME = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// Mensaje cuando piden adelanto de QR
const PEDIDO_ADELANTO_QR = `¡Hola! Vimos que realizaste una reserva en Calde Barber Studio. Por favor para confirmar tu asistencia pedimos un adelanto por QR del 50% de los servicios que requieres 😊🙏🏻`;

// Mensaje cuando el cliente manda el comprobante
const COMPROBANTE_MESSAGE = `¡Tu cita ha quedado confirmada! ✅

Te dejamos unos detalles para que todo salga perfecto:

⏰ Contamos con 10 min de tolerancia. Después de ese tiempo, el anticipo no es reembolsable.

📅 Si necesitas cancelar o reprogramar, avísanos con al menos 3 horas de anticipación para conservar tu anticipo.

⚠️ Por comodidad de todos, no se permiten mascotas.

📍 Ubicación:
https://maps.app.goo.gl/gViUPi5AikRpw2Df7?g_st=ic
Condominio Ferrara Piso 1 Oficina 15`;

const SYSTEM_INSTRUCTION = `
Eres el asistente virtual oficial de "Calde Studio" (estudio de barbería masculina).
Cuentas con la capacidad de leer el contexto reciente de la conversación para responder con criterio, coherencia y sentido común.

REGLAS DE CONTEXTO E INTELIGENCIA:
1. ANÁLISIS DEL HISTORIAL RECIENTE:
   - Revisa de qué se viene hablando hoy en el chat.
   - Si el cliente ya acordó una hora, si ya reservó, si ya se habló del adelanto o si Adrián (el dueño) ya intervino acordando un precio (ejemplo: 75 Bs de adelanto): NO LO MANDES A RESERVAR OTRA VEZ A FRESHA. Eso es un error grave.
   - Si están hablando de pagar el adelanto o de confirmar, ayúdalo con el pago por QR o dile amablemente que envíe su comprobante para confirmar su cita.
2. SALUDO INICIAL AISLADO (SILENCIO):
   - Si el cliente SOLO envía un saludo inicial básico ("Hola", "Buenas noches") y no hay conversación activa reciente, responde ÚNICAMENTE: "SILENCIO" (para que el mensaje de bienvenida automático de WhatsApp actúe).
3. TONO Y ESTILO:
   - Masculino, educado, empático y directo al grano.
   - Usa signos de admiración al saludar (¡Hola!, ¡Buenas tardes!).
   - Di "¡Claro que sí!" cuando sea coherente.
   - Puedes usar de vez en cuando un "😊" cordial.
4. SERVICIOS Y PRECIOS:
   - Corte: 90 Bs (no incluye asesoría).
   - Corte y Asesoría: 120 Bs.
   - Barba: +30 Bs adicionales (no se hace solo barba, únicamente sumado a Corte o Corte y Asesoría).
   - Cejas: +15 Bs.
   - Nombres simples y sin rodeos: "Corte", "Corte y Asesoría", "Barba", "Cejas".
5. DISPONIBILIDAD:
   - Si es un cliente preguntando por horarios libres desde cero, guíalo a Fresha:
     https://www.fresha.com/book-now/calde-barber-studio-gma54904/all-offer?share=true&pId=2669802
   - Si ya acordaron un horario específico en los mensajes de hoy, respeta ese acuerdo y no le insistas con el link.
6. NO PROCESOS QUÍMICOS:
   - No hacemos semiondulados ni permanentes.
7. POLÍTICA DE EDAD:
   - No menores de 12 años (solo mencionarlo si preguntan por niños).
8. SITUACIONES FUERA DE LO COMÚN:
   - Si el cliente pide algo especial o hay dudas con el adelanto que no sabes responder: "Estás hablando con el asistente virtual de Calde Studio. Notificaré a Adrián para que te responda personalmente lo antes posible 😊."
`;

async function askGeminiWithHistory(remoteJid, userText) {
  const now = Date.now();

  // Si la última conversación ocurrió hace más de 24 horas, LIMPIAR historial (empezar desde cero)
  if (chatHistory[remoteJid]) {
    if (now - chatHistory[remoteJid].lastUpdated > MEMORY_EXPIRATION_MS) {
      console.log(`[Conversación antigua de ${remoteJid} expirada (+24h). Reiniciando contexto limpio]`);
      chatHistory[remoteJid] = { lastUpdated: now, messages: [] };
    }
  } else {
    chatHistory[remoteJid] = { lastUpdated: now, messages: [] };
  }

  // Actualizar marca de tiempo y agregar mensaje
  chatHistory[remoteJid].lastUpdated = now;
  chatHistory[remoteJid].messages.push({ role: 'user', text: userText });

  // Mantener solo los últimos 8 mensajes relevantes del día
  if (chatHistory[remoteJid].messages.length > 8) {
    chatHistory[remoteJid].messages = chatHistory[remoteJid].messages.slice(-8);
  }

  const contents = chatHistory[remoteJid].messages.map(msg => ({
    role: msg.role === 'model' ? 'model' : 'user',
    parts: [{ text: msg.text }]
  }));

  try {
    const payload = {
      system_instruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }]
      },
      contents: contents,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500
      }
    };

    const response = await axios.post(GEMINI_ENDPOINT, payload, { timeout: 15000 });
    if (response.data && response.data.candidates && response.data.candidates[0].content.parts[0].text) {
      const reply = response.data.candidates[0].content.parts[0].text.trim();
      chatHistory[remoteJid].messages.push({ role: 'model', text: reply });
      return reply;
    }
  } catch (error) {
    console.error('Error al llamar a Gemini:', error.message);
  }
  return "Puedes revisar horarios y reservar directamente en Fresha: https://www.fresha.com/book-now/calde-barber-studio-gma54904/all-offer?share=true&pId=2669802";
}

function isMediaOrVideoLink(text) {
  const lower = text.toLowerCase();
  return lower.includes('tiktok.com') ||
         lower.includes('vt.tiktok.com') ||
         lower.includes('instagram.com/reel') ||
         lower.includes('youtube.com/shorts') ||
         lower.includes('youtu.be');
}

async function sendQRPaymentToPhone(phoneNumber) {
  if (!waSock || !isConnected) return false;
  let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
  if (cleanNumber.length === 8) cleanNumber = '591' + cleanNumber;
  const jid = `${cleanNumber}@s.whatsapp.net`;
  
  try {
    const qrImagePath = path.join(__dirname, 'qr_banco.jpg');
    if (fs.existsSync(qrImagePath)) {
      const imageBuffer = fs.readFileSync(qrImagePath);
      await waSock.sendMessage(jid, { image: imageBuffer, caption: PEDIDO_ADELANTO_QR });
    } else {
      await waSock.sendMessage(jid, { text: PEDIDO_ADELANTO_QR });
    }
    return true;
  } catch (err) {
    console.error(`Error enviando QR a ${jid}:`, err.message);
    return false;
  }
}

async function startWhatsApp() {
  const authDir = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Calde Studio', 'Desktop', '1.0.0'],
    syncFullHistory: false
  });

  waSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log('Nuevo QR generado.');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      waSock = null;
      console.log('Conexión cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('¡WhatsApp conectado exitosamente en Calde Studio!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Ignorar grupos, canales, broadcasts
      if (remoteJid.endsWith('@g.us') || remoteJid.includes('broadcast') || remoteJid.includes('@newsletter')) {
        continue;
      }

      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption || '';

      // 1. SI ADRIÁN RESPONDE MANUALMENTE
      if (msg.key.fromMe) {
        if (text) {
          if (!chatHistory[remoteJid]) chatHistory[remoteJid] = { lastUpdated: Date.now(), messages: [] };
          chatHistory[remoteJid].messages.push({ role: 'user', text: `[Adrián (dueño)]: ${text}` });
          chatHistory[remoteJid].lastUpdated = Date.now();
        }
        pausedChats[remoteJid] = Date.now() + (3 * 60 * 60 * 1000); // 3 horas de pausa
        console.log(`[Intervención manual de Adrián en ${remoteJid}] -> Bot en silencio 3 horas.`);
        continue;
      }

      // 2. VERIFICAR PAUSA MANUAL
      if (pausedChats[remoteJid] && Date.now() < pausedChats[remoteJid]) {
        console.log(`[Chat ${remoteJid} pausado: Adrián está atendiendo]`);
        if (text) {
          if (!chatHistory[remoteJid]) chatHistory[remoteJid] = { lastUpdated: Date.now(), messages: [] };
          chatHistory[remoteJid].messages.push({ role: 'user', text: text });
          chatHistory[remoteJid].lastUpdated = Date.now();
        }
        continue;
      }

      // 3. Ignorar videos y TikTok
      if (msg.message?.videoMessage || isMediaOrVideoLink(text)) {
        console.log(`[Video/Link ignorado de ${remoteJid}]`);
        continue;
      }

      // 4. Si envían comprobante (imagen)
      if (msg.message?.imageMessage) {
        console.log(`[Comprobante QR recibido de ${remoteJid}]`);
        await sock.sendMessage(remoteJid, { text: COMPROBANTE_MESSAGE });
        if (!chatHistory[remoteJid]) chatHistory[remoteJid] = { lastUpdated: Date.now(), messages: [] };
        chatHistory[remoteJid].messages.push({ role: 'user', text: '[Envió comprobante de pago]' });
        chatHistory[remoteJid].messages.push({ role: 'model', text: COMPROBANTE_MESSAGE });
        chatHistory[remoteJid].lastUpdated = Date.now();
        continue;
      }

      if (!text || text.trim() === '') continue;

      // Si en texto avisa de comprobante
      const lowerText = text.toLowerCase();
      if ((lowerText.includes('comprobante') || lowerText.includes('ya transferi') || lowerText.includes('te paso el qr') || lowerText.includes('ya hice la reserva')) && !lowerText.includes('?')) {
        await sock.sendMessage(remoteJid, { text: COMPROBANTE_MESSAGE });
        continue;
      }

      console.log(`[Mensaje entrante de ${remoteJid}]: ${text}`);

      try {
        const reply = await askGeminiWithHistory(remoteJid, text);
        if (reply && reply.toUpperCase() !== 'SILENCIO') {
          await sock.sendMessage(remoteJid, { text: reply });
          console.log(`[Respuesta enviada a ${remoteJid}]: ${reply}`);
        } else {
          console.log(`[Silencio aplicado para ${remoteJid}]`);
        }
      } catch (err) {
        console.error('Error enviando respuesta:', err.message);
      }
    }
  });
}

// Webhook para Fresha
app.post('/webhook/fresha', async (req, res) => {
  try {
    const data = req.body;
    let phone = data?.client?.mobile_number || data?.client?.phone || data?.customer?.phone || data?.appointment?.client?.mobile_number || data?.phone;
    if (phone) {
      await sendQRPaymentToPhone(phone);
      return res.status(200).json({ success: true });
    }
    return res.status(200).json({ success: false });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Panel Web
app.get('/', (req, res) => {
  if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Calde Studio - Bot Activo</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #1e293b; padding: 30px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 400px; width: 90%; }
          .status { display: inline-block; background: #10b981; color: white; padding: 6px 16px; border-radius: 20px; font-weight: bold; margin-bottom: 15px; }
          h1 { margin: 10px 0; font-size: 24px; }
          p { color: #94a3b8; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="status">● BOT CON MEMORIA INTELIGENTE</div>
          <h1>Calde Studio</h1>
          <p>Memoria activa durante 24 horas y respetando tus intervenciones manuales.</p>
        </div>
      </body>
      </html>
    `);
  } else if (currentQR) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Vincular WhatsApp - Calde Studio</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #1e293b; padding: 30px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 400px; width: 90%; }
          img { border-radius: 12px; margin: 20px 0; background: white; padding: 10px; }
          h1 { margin: 10px 0; font-size: 22px; }
          p { color: #94a3b8; font-size: 14px; line-height: 1.5; }
        </style>
        <meta http-equiv="refresh" content="10">
      </head>
      <body>
        <div class="card">
          <h1>Vincular WhatsApp</h1>
          <p>Abre WhatsApp en tu iPhone:<br><b>Ajustes > Dispositivos vinculados > Vincular un dispositivo</b> y escanea:</p>
          <img src="${currentQR}" width="260" height="260" alt="Código QR WhatsApp" />
          <p style="font-size: 12px; color: #64748b;">La página se actualiza automáticamente cada 10 segundos.</p>
        </div>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="refresh" content="3">
        <title>Iniciando...</title>
        <style>body { background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; }</style>
      </head>
      <body>
        <h3>Iniciando servidor... Espera unos segundos.</h3>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
  startWhatsApp();
});

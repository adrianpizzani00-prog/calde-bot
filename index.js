require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let isConnected = false;

// Configuración de Gemini API
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LW13eL7Kn5plAXhfRBYvmm8xk2751rZ43gC3crYjvwxg";
const MODEL_NAME = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

const COMPROBANTE_MESSAGE = `¡Tu cita ha quedado confirmada! ✅

Te dejamos unos detalles para que todo salga perfecto:

⏰ Contamos con 10 min de tolerancia. Después de ese tiempo, el anticipo no es reembolsable.

📅 Si necesitas cancelar o reprogramar, avísanos con al menos 3 horas de anticipación para conservar tu anticipo.

⚠️ Por comodidad de todos, no se permiten mascotas.

📍 Ubicación:
https://maps.app.goo.gl/gViUPi5AikRpw2Df7?g_st=ic
Condominio Ferrara Piso 1 Oficina 15`;

const SYSTEM_INSTRUCTION = `
Eres el asistente virtual de "Calde Studio" (estudio de barbería masculina).
Tu objetivo es responder de forma educada, amable, masculina, fluida y profesional a las dudas de los clientes por WhatsApp, guiándolos a reservar en Fresha o resolviendo sus inquietudes.

REGLAS DE INTERACCIÓN Y ESTILO:
1. SALUDOS Y TONO:
   - Al saludar, usa signos de admiración (ejemplo: ¡Buenas noches!, ¡Hola!).
   - Cuando sea natural y coherente al responder positivamente, di "¡Claro que sí!".
   - Puedes usar de vez en cuando un "😊" cuando sea oportuno y cordial, pero mantén el tono profesional y masculino.
2. SALUDO INICIAL AISLADO (SILENCIO):
   - El negocio ya cuenta con un mensaje automático de WhatsApp Business que envía información general.
   - Si el cliente SOLO envía un saludo básico (ej: "Hola", "Buenas noches", "Buen día", "¿Hay alguien?") sin hacer ninguna pregunta adicional, RESPONDE ÚNICAMENTE CON LA PALABRA: "SILENCIO". De esta manera no duplicamos mensajes con la bienvenida automática.
3. SERVICIOS Y PRECIOS:
   - Corte: 90 Bs (no incluye asesoría).
   - Corte y Asesoría: 120 Bs.
   - Barba: +30 Bs adicionales (no se hace solo barba, únicamente se suma a Corte o Corte y Asesoría).
   - Cejas: +15 Bs.
   - Nombres simples y sin rodeos: "Corte", "Corte y Asesoría", "Barba", "Cejas".
4. DISPONIBILIDAD / "¿TIENES ESPACIO HOY / MAÑANA / CUÁNDO HAY?":
   - Explica con amabilidad que toda la disponibilidad en tiempo real y la selección de turnos se gestiona directamente en el enlace de Fresha:
     https://www.fresha.com/book-now/calde-barber-studio-gma54904/all-offer?share=true&pId=2669802
5. PROCESOS QUÍMICOS / SEMIONDULADOS / PERMANENTES:
   - En Calde Studio no realizamos semiondulados, permanentes ni procesos químicos. Solo corte, asesoría y diseño de imagen.
6. POLÍTICA DE EDAD (MENORES DE 12 AÑOS):
   - NO la repitas en cada mensaje. Solo menciónala si el cliente pregunta explícitamente por niños o cortes infantiles.
7. CASOS EXCEPCIONALES / DERIVACIÓN A HUMANO:
   - Si el cliente está llamando, pide hablar con una persona real, tiene un reclamo, una situación compleja o una duda fuera de tus conocimientos, responde identificándote como asistente:
     "Estás hablando con el asistente virtual de Calde Studio. Notificaré a Adrián para que te responda personalmente lo antes posible 😊."
`;

async function askGemini(userText) {
  try {
    const payload = {
      system_instruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }]
      },
      contents: [
        {
          parts: [{ text: userText }]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500
      }
    };
    const response = await axios.post(GEMINI_ENDPOINT, payload, { timeout: 15000 });
    if (response.data && response.data.candidates && response.data.candidates[0].content.parts[0].text) {
      return response.data.candidates[0].content.parts[0].text.trim();
    }
  } catch (error) {
    console.error('Error al llamar a Gemini:', error.message);
  }
  return "Puedes revisar horarios y reservar directamente en Fresha: https://www.fresha.com/book-now/calde-barber-studio-gma54904/all-offer?share=true&pId=2669802";
}

// Función para detectar si el mensaje debe ser ignorado (TikTok, Reels, videos)
function isMediaOrVideoLink(text) {
  const lower = text.toLowerCase();
  return lower.includes('tiktok.com') ||
         lower.includes('vt.tiktok.com') ||
         lower.includes('instagram.com/reel') ||
         lower.includes('youtube.com/shorts') ||
         lower.includes('youtu.be');
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
      if (msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // 1. Ignorar grupos, canales, broadcasts
      if (remoteJid.endsWith('@g.us') || remoteJid.includes('broadcast') || remoteJid.includes('@newsletter')) {
        continue;
      }

      // 2. Si envían un VIDEO directamente (archivo de video): IGNORAR
      if (msg.message?.videoMessage) {
        console.log(`[Video recibido de ${remoteJid}] -> Ignorado`);
        continue;
      }

      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption || '';

      // 3. Si mandan un enlace de TikTok, Reels o Shorts: IGNORAR
      if (isMediaOrVideoLink(text)) {
        console.log(`[Link de video recibido de ${remoteJid}]: ${text} -> Ignorado`);
        continue;
      }

      // 4. Si envían una IMAGEN (comprobante de pago QR)
      if (msg.message?.imageMessage) {
        console.log(`[Comprobante QR recibido de ${remoteJid}]`);
        await sock.sendMessage(remoteJid, { text: COMPROBANTE_MESSAGE });
        continue;
      }

      if (!text || text.trim() === '') continue;

      // Si en texto dice que ya pagó o pasa el qr
      const lowerText = text.toLowerCase();
      if ((lowerText.includes('comprobante') || lowerText.includes('ya transferi') || lowerText.includes('te paso el qr') || lowerText.includes('ya hice la reserva')) && !lowerText.includes('?')) {
        await sock.sendMessage(remoteJid, { text: COMPROBANTE_MESSAGE });
        continue;
      }

      console.log(`[Mensaje de cliente ${remoteJid}]: ${text}`);

      try {
        const reply = await askGemini(text);
        // Si la IA decide silencio para no chocar con el mensaje de bienvenida
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
          <div class="status">● BOT CONECTADO</div>
          <h1>Calde Studio</h1>
          <p>El asistente inteligente está respondiendo automáticamente en tu WhatsApp 24/7.</p>
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
        <h3>Iniciando servidor de WhatsApp... Espera unos segundos.</h3>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
  startWhatsApp();
});

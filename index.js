require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL_NAME = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_INSTRUCTION = `
Eres el asistente virtual de "Calde Studio" (estudio de barbería masculina).
Tu objetivo es responder de forma amable, profesional, concisa, masculina y directa a las dudas de los clientes por WhatsApp, guiándolos siempre a reservar en Fresha o confirmando sus pagos por QR.

Reglas de negocio estrictas:
1. SERVICIOS Y PRECIOS:
   - Corte: 90 Bs (no incluye asesoría).
   - Corte y Asesoría: 120 Bs.
   - Barba: +30 Bs adicionales (no se hace solo barba, únicamente se suma al servicio de Corte o Corte y Asesoría).
   - Cejas: +15 Bs.
   * IMPORTANTE: No agregues descripciones largas a los servicios. Usa exactamente sus nombres simples: "Corte", "Corte y Asesoría", "Barba", "Cejas".
2. DISPONIBILIDAD / "¿TIENES ESPACIO HOY?":
   - Toda la disponibilidad en tiempo real, cancelaciones y selección de turnos se gestiona directamente en Fresha:
     https://www.fresha.com/book-now/calde-barber-studio-gma54904/all-offer?share=true&pId=2669802
   - Invítalos a ingresar al enlace para revisar los espacios disponibles para hoy o fechas posteriores.
3. PROCESOS QUÍMICOS / SEMIONDULADOS / PERMANENTES:
   - En Calde Studio no realizamos semiondulados, permanentes ni procesos químicos. Solo nos enfocamos en corte, asesoría y diseño de imagen.
4. CONFIRMACIÓN CON QR / PAGOS:
   - Si el cliente menciona que ya reservó en Fresha y pagó por QR o quiere enviar el comprobante, indícale de manera sobria y profesional que envíe el comprobante por este medio para dejarlo registrado para su cita.
5. UBICACIÓN Y POLÍTICAS:
   - Ubicación: Condominio "FERRARA", Piso 1, Of. 15.
   - Google Maps: https://maps.app.goo.gl/Q5XWKyTJqAeU3ETP6
   - Política de edad: No se atiende a menores de 12 años.
6. TONO Y ESTILO:
   - Tono sobrio, educado, masculino y directo al punto.
   - CERO EMOJIS. No utilices emojis de ningún tipo (ni tijeras, ni barbería, ni manos).
   - Mensajes breves (2 a 3 líneas máximo).
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

async function startWhatsApp() {
  const authDir = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Calde Studio Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log('Nuevo QR generado. Abre el panel web para escanear.');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      console.log('Conexión cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('¡WhatsApp conectado exitosamente en Calde Studio!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar mensajes enviados por nosotros mismos
      if (msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;

      // 1. REGLA DE ORO: Ignorar grupos de WhatsApp completamente
      if (remoteJid.endsWith('@g.us')) continue;
      // Ignorar canales o broadcasts
      if (remoteJid.includes('broadcast') || remoteJid.includes('@newsletter')) continue;

      // 2. Extraer texto del mensaje
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption || '';

      // Si es solo una imagen sin texto (por ejemplo el comprobante QR)
      if (msg.message?.imageMessage && !text) {
        await sock.sendMessage(remoteJid, {
          text: "Comprobante recibido. Queda registrado para tu cita. Te esperamos en el estudio."
        });
        continue;
      }

      if (!text || text.trim() === '') continue;

      console.log(`[Mensaje entrante de ${remoteJid}]: ${text}`);

      // 3. Responder con la IA de Calde Studio
      const reply = await askGemini(text);
      if (reply) {
        await sock.sendMessage(remoteJid, { text: reply });
        console.log(`[Respuesta enviada a ${remoteJid}]: ${reply}`);
      }
    }
  });
}

// Panel Web para ver estado y escanear QR fácilmente desde el celular o PC
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

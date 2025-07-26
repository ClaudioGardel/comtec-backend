// backend_comtec/index.js

const express = require('express');
const multer = require('multer');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// FIREBASE ADMIN SDK
const firebaseCredentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(firebaseCredentials),
});
const firestore = admin.firestore();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// GOOGLE DRIVE AUTH
const driveCredentials = JSON.parse(process.env.DRIVE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: driveCredentials,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// 🔁 Crear carpeta si no existe
async function getOrCreateFolder(parentId, folderName) {
  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents`,
    fields: 'files(id, name)',
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const newFolder = await drive.files.create({
    resource: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return newFolder.data.id;
}

// ⬆️ Subir archivos (buffer o stream)
async function uploadFileToDrive(fileData, name, mimetype, folderId) {
  const media =
    typeof fileData.pipe === 'function'
      ? { mimeType: mimetype, body: fileData } // stream (PDF)
      : { mimeType: mimetype, body: Buffer.from(fileData) }; // buffer (fotos)

  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
    },
    media,
  });

  return res.data.id;
}

app.post('/enviar-reporte', upload.array('fotos'), async (req, res) => {
  try {
    const {
      supervisor,
      actividad,
      fecha,
      tareas,
      dificultades,
      tecnicos,
      asistencia,
      proyecto,
    } = req.body;

    const fechaFormato = fecha.split('T')[0];

    // 📁 Crear carpetas en Drive
    const rootFolderId = await getOrCreateFolder('root', 'COMTEC');
    const fechaFolderId = await getOrCreateFolder(rootFolderId, fechaFormato);

    // 📸 Subir fotos
    const fotoIds = [];
    for (const file of req.files) {
      const fotoId = await uploadFileToDrive(
        file.buffer,
        `${Date.now()}_${file.originalname}`,
        file.mimetype,
        fechaFolderId
      );
      fotoIds.push(fotoId);
    }

    // 🧾 Generar PDF temporal
    const pdfPath = path.join(__dirname, `reporte_${Date.now()}.pdf`);
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(pdfPath));

    doc.fontSize(18).text('Reporte Diario - COMTEC', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Supervisor: ${supervisor}`);
    doc.text(`Fecha: ${fechaFormato}`);
    doc.text(`Actividad: ${actividad}`);
    doc.text(`Proyecto: ${proyecto}`);
    doc.text(`Técnicos: ${JSON.parse(tecnicos).join(', ')}`);
    doc.text(`Asistencia: ${JSON.parse(asistencia).join(', ')}`);
    doc.moveDown();
    doc.text('Detalle de tareas:');
    doc.text(tareas);
    doc.moveDown();
    doc.text('Dificultades encontradas:');
    doc.text(dificultades);
    doc.end();

    await new Promise((resolve) => doc.on('finish', resolve));

    // ☁️ Subir PDF a Drive
    const pdfStream = fs.createReadStream(pdfPath);
    await uploadFileToDrive(pdfStream, `Reporte_${fechaFormato}.pdf`, 'application/pdf', fechaFolderId);

    // 🧼 Eliminar archivo temporal
    fs.unlinkSync(pdfPath);

    // 🔥 Guardar en Firestore
    await firestore.collection('reportes').add({
      supervisor,
      actividad,
      fecha,
      tareas,
      dificultades,
      tecnicos: JSON.parse(tecnicos),
      asistencia: JSON.parse(asistencia),
      proyecto,
      fotos: fotoIds,
    });

    res.json({ ok: true, mensaje: 'Reporte recibido y guardado correctamente' });
  } catch (error) {
    console.error('❌ Error al procesar reporte:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend COMTEC activo en puerto ${PORT}`));

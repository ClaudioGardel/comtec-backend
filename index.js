// index.js
require('dotenv').config(); // para entorno local con .env
const express = require('express');
const multer = require('multer');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' }); // 📂 Carpeta local temporal

// 🔐 Cargar claves desde variables de entorno (escapadas con \\n)
const firebaseRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const driveRaw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;

const firebaseConfig = JSON.parse(firebaseRaw.replace(/\\n/g, '\n'));
const driveConfig = JSON.parse(driveRaw.replace(/\\n/g, '\n'));

// 🚀 Inicializar Firebase
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

// 🔧 Google Drive
const auth = new google.auth.GoogleAuth({
  credentials: driveConfig,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// 📦 Ruta para subir datos + fotos + PDF
app.post('/enviar-reporte', upload.array('fotos'), async (req, res) => {
  try {
    const {
      supervisor,
      actividad,
      fecha,
      tareas,
      dificultades,
      proyecto,
      tecnicos,
      asistencia
    } = req.body;

    const parsedFecha = fecha?.split('T')[0] || new Date().toISOString().split('T')[0];

    // 🗂 Crear carpeta en Drive por fecha
    const folderMetadata = {
      name: parsedFecha,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GDRIVE_ROOT_FOLDER_ID],
    };

    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id',
    });
    const folderId = folder.data.id;

    // 📤 Subir imágenes
    const uploadedUrls = [];
    for (const file of req.files) {
      const fileMetadata = {
        name: file.originalname,
        parents: [folderId],
      };
      const media = {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      };

      const uploadedFile = await drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id',
      });

      await drive.permissions.create({
        fileId: uploadedFile.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      uploadedUrls.push(`https://drive.google.com/uc?id=${uploadedFile.data.id}`);
      fs.unlinkSync(file.path);
    }

    // 📄 Generar PDF
    const doc = new PDFDocument();
    const pdfPath = `uploads/reporte-${Date.now()}.pdf`;
    const writeStream = fs.createWriteStream(pdfPath);
    doc.pipe(writeStream);

    doc.fontSize(16).text('📋 Reporte de Supervisión', { align: 'center' }).moveDown();
    doc.fontSize(12);
    doc.text(`📅 Fecha: ${parsedFecha}`);
    doc.text(`👷 Supervisor: ${supervisor}`);
    doc.text(`📍 Proyecto: ${proyecto}`);
    doc.text(`📝 Actividad: ${actividad}`).moveDown();
    doc.text(`👥 Técnicos: ${(JSON.parse(tecnicos) || []).join(', ')}`);
    doc.text(`✅ Asistencia: ${(JSON.parse(asistencia) || []).join(', ')}`).moveDown();
    doc.text(`🔧 Tareas:\n${tareas}`).moveDown();
    doc.text(`❗ Dificultades:\n${dificultades}`);
    doc.end();

    await new Promise(resolve => writeStream.on('finish', resolve));

    // 📤 Subir PDF
    const pdfUpload = await drive.files.create({
      resource: {
        name: `Reporte-${parsedFecha}.pdf`,
        parents: [folderId],
      },
      media: {
        mimeType: 'application/pdf',
        body: fs.createReadStream(pdfPath),
      },
      fields: 'id',
    });

    await drive.permissions.create({
      fileId: pdfUpload.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    const pdfUrl = `https://drive.google.com/uc?id=${pdfUpload.data.id}`;
    fs.unlinkSync(pdfPath);

    // 🔥 Guardar en Firestore
    const db = admin.firestore();
    await db.collection('reportes').add({
      supervisor,
      actividad,
      fecha: parsedFecha,
      tareas,
      dificultades,
      proyecto,
      tecnicos: JSON.parse(tecnicos),
      asistencia: JSON.parse(asistencia),
      fotos: uploadedUrls,
      pdf: pdfUrl,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      message: '✅ Reporte subido con éxito',
      fotos: uploadedUrls,
      pdf: pdfUrl,
    });

  } catch (error) {
    console.error('❌ Error en /enviar-reporte:', error);
    res.status(500).json({ message: 'Error al procesar el reporte', error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});

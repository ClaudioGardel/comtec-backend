const express = require('express');
const multer = require('multer');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const PDFDocument = require('pdfkit');
require('dotenv').config();


const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });


/** 🔐 Cargar claves desde variables de entorno */
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON.replace(/\\n/g, '\n'));
const driveConfig = JSON.parse(process.env.GDRIVE_SERVICE_ACCOUNT_JSON.replace(/\\n/g, '\n'));

/** 🚀 Inicializar Firebase */
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

/** 🔧 Configurar Google Drive */
const auth = new google.auth.GoogleAuth({
  credentials: driveConfig,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

/** 📦 Ruta para recibir datos y fotos y generar PDF */
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

    // 🗂 Crear carpeta en Drive
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
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });

      const fileUrl = `https://drive.google.com/uc?id=${uploadedFile.data.id}`;
      uploadedUrls.push(fileUrl);

      fs.unlinkSync(file.path); // borrar local
    }

    // 📄 Generar PDF
    const doc = new PDFDocument();
    const pdfPath = `uploads/reporte-${Date.now()}.pdf`;
    const writeStream = fs.createWriteStream(pdfPath);
    doc.pipe(writeStream);

    doc.fontSize(16).text('Reporte de Supervisión', { align: 'center' }).moveDown();
    doc.fontSize(12).text(`📅 Fecha: ${parsedFecha}`);
    doc.text(`👷 Supervisor: ${supervisor}`);
    doc.text(`📍 Proyecto: ${proyecto}`);
    doc.text(`📝 Actividad: ${actividad}`).moveDown();
    doc.text(`👥 Técnicos: ${(JSON.parse(tecnicos) || []).join(', ')}`);
    doc.text(`✅ Asistencia: ${(JSON.parse(asistencia) || []).join(', ')}`).moveDown();
    doc.text(`🔧 Tareas Realizadas:\n${tareas}`).moveDown();
    doc.text(`❗ Dificultades:\n${dificultades}`);

    doc.end();

    await new Promise(resolve => writeStream.on('finish', resolve));

    // 📤 Subir PDF al mismo folder
    const pdfMetadata = {
      name: `Reporte-${parsedFecha}.pdf`,
      parents: [folderId],
    };

    const pdfMedia = {
      mimeType: 'application/pdf',
      body: fs.createReadStream(pdfPath),
    };

    const uploadedPdf = await drive.files.create({
      resource: pdfMetadata,
      media: pdfMedia,
      fields: 'id',
    });

    await drive.permissions.create({
      fileId: uploadedPdf.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    const pdfUrl = `https://drive.google.com/uc?id=${uploadedPdf.data.id}`;

    fs.unlinkSync(pdfPath); // borrar local

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
      message: '✅ Reporte completo subido correctamente',
      fotos: uploadedUrls,
      pdf: pdfUrl,
    });

  } catch (error) {
    console.error('❌ Error al procesar el reporte:', error);
    res.status(500).json({ message: 'Error al procesar el reporte', error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});

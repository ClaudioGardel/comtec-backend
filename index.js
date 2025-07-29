const express = require('express');
const multer = require('multer');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/enviar-reporte' });

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

/** 📦 Ruta para recibir archivos y datos del reporte */
app.post('/upload', upload.array('fotos'), async (req, res) => {
  try {
    const { datos } = req.body;
    const parsedDatos = JSON.parse(datos);
    const fecha = parsedDatos.fecha || new Date().toISOString().split('T')[0];

    // 🔁 Crear carpeta con la fecha
    const folderMetadata = {
      name: fecha,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GDRIVE_ROOT_FOLDER_ID],
    };

    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id',
    });

    const folderId = folder.data.id;

    // 📤 Subir fotos a Drive
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

      fs.unlinkSync(file.path);
    }

    // 📝 Guardar en Firestore
    const db = admin.firestore();
    await db.collection('reportes').add({
      ...parsedDatos,
      fotos: uploadedUrls,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ message: 'Reporte y archivos subidos correctamente', urls: uploadedUrls });
  } catch (error) {
    console.error('❌ Error al subir reporte:', error);
    res.status(500).json({ message: 'Error al subir reporte', error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});

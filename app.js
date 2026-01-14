require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const multer = require('multer');
const graphqlHttp = require('express-graphql');

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

const graphqlSchema = require('./graphql/schema');
const graphqlResolver = require('./graphql/resolvers');

const auth = require('./middleware/auth');
const { clearImage } = require('./util/file');

const app = express();
const Mongo_URI = (process.env.MONGO_URI || '').trim();
const port = process.env.PORT || 8080;

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'images'),
  filename: (req, file, cb) => cb(null, new Date().toISOString().replace(/:/g, '-') + '-' + file.originalname)
});

const fileFilter = (req, file, cb) => {
  if (['image/png', 'image/jpg', 'image/jpeg'].includes(file.mimetype)) cb(null, true);
  else cb(null, false);
};

app.use(bodyParser.json());
app.use(multer({ storage: fileStorage, fileFilter }).single('image'));
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use((req, res, next) => {
  // SAFETY: Fallback if env var is missing to prevent crash
  const allowedOrigin = process.env.FRONTEND_URL || '*';

  res.setHeader(
    'Access-Control-Allow-Origin',
    allowedOrigin
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'OPTIONS, GET, POST, PUT, PATCH, DELETE'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});




app.put('/post-image', auth, (req, res, next) => {
  if (!req.isAuth) return res.status(401).json({ message: 'Not authenticated!' });
  if (!req.file) return res.status(200).json({ message: 'No file provided!' });
  if (req.body.oldPath) clearImage(req.body.oldPath);
  const filePath = req.file.path.replace(/\\/g, '/');
  const relativePath = filePath.includes('images')
    ? filePath.substring(filePath.indexOf('images'))
    : 'images/' + req.file.filename;
  res.status(201).json({ message: 'File stored.', filePath: relativePath });
});

app.use(
  '/graphql',
  auth,
  graphqlHttp((req) => ({
    schema: graphqlSchema,
    rootValue: graphqlResolver,
    graphiql: process.env.NODE_ENV !== 'production',
    context: { isAuth: req.isAuth, userId: req.userId },
    formatError(err) {
      if (!err.originalError) return err;
      const data = err.originalError.data;
      const message = err.message || 'An error occurred.';
      const code = err.originalError.code || 500;
      return { message, status: code, data };
    }
  }))
);

app.use((error, req, res, next) => {
  console.error('Express Error Middleware Caught:', error);
  const status = error.statusCode || 500;
  const message = error.message;
  const data = error.data;
  res.status(status).json({ message, data });
});

if (!Mongo_URI) {
  console.error('FATAL ERROR: MONGO_URI is not defined in environment variables.');
} else {
  // Mask password for safe logging
  const maskedUri = Mongo_URI.replace(/:([^@]+)@/, ':****@');
  console.log('Connecting to MongoDB:', maskedUri);
}

mongoose
  .connect(Mongo_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  })
  .then(() => {
    console.log('Successfully connected to MongoDB.');
    app.listen(port, () => {
      console.log(`Server is running! Port: ${port}`);
    });
  })
  .catch(err => {
    console.error('SERVER CRASH: MongoDB connection failed!');
    console.error('Error details:', err.message);
    if (err.message.includes('authentication failed')) {
      console.error('TIP: Check your database username, password (encoding), and IP whitelist (0.0.0.0/0).');
    }
    process.exit(1);
  });

require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const multer = require('multer');
const graphqlHttp = require('express-graphql');
 

const graphqlSchema = require('./graphql/schema');
const graphqlResolver = require('./graphql/resolvers');
const auth = require('./middleware/auth');
const { clearImage } = require('./util/file');

const app = express();

const Mongo_URI = process.env.MONGO_URI;

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'images'),
  filename: (req, file, cb) => cb(null, new Date().toISOString().replace(/:/g, '-') + '-' + file.originalname)
});

const fileFilter = (req, file, cb) => {
  if (['image/png','image/jpg','image/jpeg'].includes(file.mimetype)) cb(null, true);
  else cb(null, false);
};

app.use(bodyParser.json());
app.use(multer({ storage: fileStorage, fileFilter }).single('image'));
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, PATCH, DELETE'); 
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); 
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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
    graphiql: true,
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
  console.error(error);
  const status = error.statusCode || 500;
  const message = error.message;
  const data = error.data;
  res.status(status).json({ message, data });
});

mongoose
  .connect(Mongo_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(process.env.PORT, () => console.log('Server running on port 8080'));
  })
  .catch(err => console.error(err));

 const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const authHeader = req.get('Authorization');
  if (!authHeader) {
    req.isAuth = false;
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    req.isAuth = false;
    return next();
  }

  try {
    const decodedToken = jwt.verify(token, 'somesupersecretsecret');
    req.userId = decodedToken.userId;
    req.isAuth = true;
  } catch (err) {
    req.isAuth = false;
  }

  next();
};

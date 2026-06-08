const express = require('express');
const router = express.Router();
const { usersStore } = require('../storage');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');

router.get('/', (req, res) => {
  const users = usersStore.readAll().map(u => ({
    id: u.id,
    name: u.name,
    role: u.role
  }));
  res.json({
    success: true,
    data: users
  });
});

router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  }
  res.json({
    success: true,
    data: {
      id: req.user.id,
      name: req.user.name,
      role: req.user.role
    }
  });
});

module.exports = router;

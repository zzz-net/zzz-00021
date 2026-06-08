const { usersStore } = require('../storage');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { PERMISSIONS } = require('../constants/status');

function authMiddleware(req, res, next) {
  const userId = req.headers['x-user-id'];
  
  if (!userId) {
    return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  }

  const user = usersStore.findById(userId);
  if (!user) {
    return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, '用户不存在'));
  }

  req.user = user;
  next();
}

function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
    }

    const allowedRoles = PERMISSIONS[permissionKey];
    if (!allowedRoles || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json(createErrorResponse(ERROR_CODES.PERMISSION_DENIED, {
        required: permissionKey,
        userRole: req.user.role,
        allowedRoles
      }));
    }

    next();
  };
}

module.exports = {
  authMiddleware,
  requirePermission
};

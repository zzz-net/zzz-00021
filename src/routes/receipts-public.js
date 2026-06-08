const express = require('express');
const router = express.Router();
const { receiptService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');

router.get('/by-code/:code', (req, res) => {
  const code = req.params.code;
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json(createErrorResponse(ERROR_CODES.RECEIPT_INVALID_CODE, {
      reason: '签收码不能为空'
    }));
  }

  const result = receiptService.getReceiptPackageByCode(code.trim());

  if (!result.success) {
    return res.status(400).json(
      createErrorResponse(result.error, result.details)
    );
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/sign', (req, res) => {
  const body = req.body || {};
  const code = body.code;
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json(createErrorResponse(ERROR_CODES.RECEIPT_INVALID_CODE, {
      reason: '签收码不能为空'
    }));
  }

  let user = req.user;
  if (!user) {
    user = { id: 'anonymous', name: '匿名签收人' };
  }

  const signerInfo = {};
  if (body.signerName && typeof body.signerName === 'string') {
    signerInfo.signerName = body.signerName.trim();
  }

  const result = receiptService.signReceiptPackage(user, code.trim(), signerInfo);

  if (!result.success) {
    const statusMap = {
      [ERROR_CODES.RECEIPT_INVALID_CODE]: 400,
      [ERROR_CODES.RECEIPT_ALREADY_SIGNED]: 409,
      [ERROR_CODES.RECEIPT_REVOKED]: 410,
      [ERROR_CODES.RECEIPT_EXPIRED]: 410,
      [ERROR_CODES.RECEIPT_SIGN_FAILED]: 500
    };
    return res.status(statusMap[result.error] || 400).json(
      createErrorResponse(result.error, result.details)
    );
  }

  res.json({
    success: true,
    data: result.data
  });
});

module.exports = router;

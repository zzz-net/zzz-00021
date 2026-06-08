const { v4: uuidv4 } = require('uuid');
const { shiftHandoversStore, incidentsStore, usersStore } = require('../storage');
const {
  SHIFT_HANDOVER_STATUS,
  AUDIT_ACTION
} = require('../constants/status');
const { ERROR_CODES } = require('../constants/errors');
const { logAction } = require('./auditService');

function createShiftHandover(user, data) {
  const now = new Date().toISOString();
  const {
    takeoverUserId,
    shiftStart,
    shiftEnd,
    incidentIds = [],
    remark = ''
  } = data;

  const takeoverUser = usersStore.findById(takeoverUserId);
  if (!takeoverUser) {
    return {
      success: false,
      error: ERROR_CODES.VALIDATION_ERROR,
      details: '接班人不存在'
    };
  }

  if (incidentIds && incidentIds.length > 0) {
    for (const id of incidentIds) {
      const inc = incidentsStore.findById(id);
      if (!inc) {
        return {
          success: false,
          error: ERROR_CODES.SHIFT_HANDOVER_INVALID_INCIDENT,
          details: { incidentId: id }
        };
      }
    }
  }

  const handover = {
    id: uuidv4(),
    handoverUserId: user.id,
    handoverUserName: user.name,
    takeoverUserId,
    takeoverUserName: takeoverUser.name,
    shiftStart,
    shiftEnd,
    incidentIds: incidentIds || [],
    remark,
    status: SHIFT_HANDOVER_STATUS.PENDING,
    confirmedAt: null,
    confirmedByUserId: null,
    confirmedByUserName: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedByUserName: null,
    revokeReason: null,
    createdAt: now,
    updatedAt: now
  };

  const ok = shiftHandoversStore.append(handover);
  if (!ok) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CREATE_FAILED, null, {
      reason: 'database_append_failed'
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_CREATE_FAILED
    };
  }

  logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CREATED, null, {
    handoverId: handover.id,
    from: null,
    to: SHIFT_HANDOVER_STATUS.PENDING,
    takeoverUserId,
    shiftStart,
    shiftEnd,
    incidentCount: (incidentIds || []).length
  });

  return { success: true, data: handover };
}

function getShiftHandoverList(user, filters = {}) {
  let list = shiftHandoversStore.readAll();

  if (filters.status) {
    list = list.filter(h => h.status === filters.status);
  }
  if (filters.handoverUserId) {
    list = list.filter(h => h.handoverUserId === filters.handoverUserId);
  }
  if (filters.takeoverUserId) {
    list = list.filter(h => h.takeoverUserId === filters.takeoverUserId);
  }

  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list;
}

function getShiftHandoverDetail(user, id) {
  const handover = shiftHandoversStore.findById(id);
  if (!handover) {
    return { success: false, error: ERROR_CODES.SHIFT_HANDOVER_NOT_FOUND };
  }

  let incidentDetails = [];
  if (handover.incidentIds && handover.incidentIds.length > 0) {
    incidentDetails = handover.incidentIds
      .map(incId => incidentsStore.findById(incId))
      .filter(Boolean)
      .map(inc => ({
        id: inc.id,
        title: inc.title,
        status: inc.status,
        level: inc.level,
        location: inc.location,
        evidenceCount: inc.evidenceCount
      }));
  }

  logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_VIEWED, null, {
    handoverId: id
  });

  return {
    success: true,
    data: {
      ...handover,
      incidents: incidentDetails
    }
  };
}

function confirmShiftHandover(user, id) {
  const handover = shiftHandoversStore.findById(id);
  if (!handover) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CONFIRM_FAILED, null, {
      reason: 'not_found',
      handoverId: id
    });
    return { success: false, error: ERROR_CODES.SHIFT_HANDOVER_NOT_FOUND };
  }

  if (handover.status === SHIFT_HANDOVER_STATUS.CONFIRMED) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CONFIRM_FAILED, null, {
      reason: 'already_confirmed',
      handoverId: id
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_ALREADY_CONFIRMED,
      details: {
        currentStatus: handover.status,
        hint: '该交接班已完成确认，不可重复确认'
      }
    };
  }

  if (handover.status === SHIFT_HANDOVER_STATUS.REVOKED) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CONFIRM_FAILED, null, {
      reason: 'already_revoked',
      handoverId: id
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_ALREADY_REVOKED,
      details: {
        currentStatus: handover.status,
        hint: '该交接班已被撤回，无法确认'
      }
    };
  }

  if (handover.takeoverUserId !== user.id) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CONFIRM_FAILED, null, {
      reason: 'not_takeover_user',
      handoverId: id,
      expectedTakeoverUserId: handover.takeoverUserId
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_CONFLICT,
      details: {
        currentStatus: handover.status,
        expectedTakeoverUserId: handover.takeoverUserId,
        actualUserId: user.id,
        hint: '仅指定的接班人可以确认此交接班'
      }
    };
  }

  const now = new Date().toISOString();
  const previousStatus = handover.status;
  const updated = shiftHandoversStore.updateById(id, (h) => ({
    ...h,
    status: SHIFT_HANDOVER_STATUS.CONFIRMED,
    confirmedAt: now,
    confirmedByUserId: user.id,
    confirmedByUserName: user.name,
    updatedAt: now
  }));

  logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_CONFIRMED, null, {
    handoverId: id,
    from: previousStatus,
    to: SHIFT_HANDOVER_STATUS.CONFIRMED
  });

  return { success: true, data: updated };
}

function revokeShiftHandover(user, id, reason = null) {
  const handover = shiftHandoversStore.findById(id);
  if (!handover) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_REVOKE_FAILED, null, {
      reason: 'not_found',
      handoverId: id
    });
    return { success: false, error: ERROR_CODES.SHIFT_HANDOVER_NOT_FOUND };
  }

  if (handover.status === SHIFT_HANDOVER_STATUS.CONFIRMED) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_REVOKE_FAILED, null, {
      reason: 'already_confirmed',
      handoverId: id
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_ALREADY_CONFIRMED,
      details: {
        currentStatus: handover.status,
        hint: '该交接班已被确认，无法撤回'
      }
    };
  }

  if (handover.status === SHIFT_HANDOVER_STATUS.REVOKED) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_REVOKE_FAILED, null, {
      reason: 'already_revoked',
      handoverId: id
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_ALREADY_REVOKED,
      details: {
        currentStatus: handover.status,
        hint: '该交接班已被撤回，不可重复撤回'
      }
    };
  }

  if (handover.handoverUserId !== user.id) {
    logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_REVOKE_FAILED, null, {
      reason: 'not_creator',
      handoverId: id,
      expectedCreatorId: handover.handoverUserId
    });
    return {
      success: false,
      error: ERROR_CODES.SHIFT_HANDOVER_NOT_CREATOR,
      details: {
        currentStatus: handover.status,
        handoverUserId: handover.handoverUserId,
        operatorUserId: user.id,
        hint: '仅交班人本人可以撤回交接班'
      }
    };
  }

  const now = new Date().toISOString();
  const previousStatus = handover.status;
  const updated = shiftHandoversStore.updateById(id, (h) => ({
    ...h,
    status: SHIFT_HANDOVER_STATUS.REVOKED,
    revokedAt: now,
    revokedByUserId: user.id,
    revokedByUserName: user.name,
    revokeReason: reason,
    updatedAt: now
  }));

  logAction(user.id, user.name, AUDIT_ACTION.SHIFT_HANDOVER_REVOKED, null, {
    handoverId: id,
    from: previousStatus,
    to: SHIFT_HANDOVER_STATUS.REVOKED,
    reason: reason || null
  });

  return { success: true, data: updated };
}

module.exports = {
  createShiftHandover,
  getShiftHandoverList,
  getShiftHandoverDetail,
  confirmShiftHandover,
  revokeShiftHandover
};

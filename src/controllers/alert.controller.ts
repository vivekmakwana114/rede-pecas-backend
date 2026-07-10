import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { getAlerts, markAlertRead } from '../models/alert.model.js';

/**
 * Returns the admin notification feed (payment-proof-received, in-person-payment-
 * requested) — replaces the old WhatsApp pushes to the admin's own phone.
 */
export const getAlertsHandler = catchAsync(async (req: Request, res: Response) => {
  const alerts = await getAlerts();

  res.status(200).json({
    success: true,
    message: 'Alerts retrieved.',
    code: 200,
    data: alerts,
    meta: { timestamp: new Date().toISOString() },
  });
});

export const markAlertReadHandler = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  await markAlertRead(Number(id));

  res.status(200).json({
    success: true,
    message: `Alert ${id} marked read.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

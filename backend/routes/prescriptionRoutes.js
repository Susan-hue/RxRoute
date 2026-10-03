import { Router } from 'express';
import * as prescriptions from '../controllers/prescriptionController.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// Declared before `/:idOrCode` so "expire-stale" is not read as a reference.
router.post('/expire-stale', asyncHandler(prescriptions.expireStale));

router.get('/', asyncHandler(prescriptions.index));
router.post('/', asyncHandler(prescriptions.ingest));

router.get('/:idOrCode', asyncHandler(prescriptions.show));
router.get('/:idOrCode/broadcasts', asyncHandler(prescriptions.broadcasts));
router.post('/:idOrCode/claim', asyncHandler(prescriptions.claim));
router.post('/:idOrCode/rebroadcast', asyncHandler(prescriptions.rebroadcast));

export default router;

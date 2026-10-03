import { Router } from 'express';
import { receivePhoto, createPrescription, showPrescription } from '../controllers/publicController.js';
import { publicCors, uploadRateLimit } from '../middleware/publicApi.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.use(publicCors);

router.post('/prescriptions', uploadRateLimit(), receivePhoto, asyncHandler(createPrescription));
router.get('/prescriptions/:id', asyncHandler(showPrescription));

export default router;

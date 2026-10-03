import { Router } from 'express';
import webhookRoutes from './webhookRoutes.js';
import pharmacyRoutes from './pharmacyRoutes.js';
import prescriptionRoutes from './prescriptionRoutes.js';
import publicRoutes from './publicRoutes.js';
import { health, deepHealth, stats, activity } from '../controllers/statsController.js';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// --- Health (unauthenticated: load balancers and uptime checks need these) ---
router.get('/health', health);
router.get('/health/deep', asyncHandler(deepHealth));

// --- Twilio webhooks (authenticated by X-Twilio-Signature, not the API key) ---
router.use('/webhook', webhookRoutes);

// --- Public web app API (rate limited; mounted before the API key guard) ----
router.use('/api/public', publicRoutes);

// --- REST API (shared-secret protected) -------------------------------------
router.use('/api', apiKeyAuth);
router.use('/api/pharmacies', pharmacyRoutes);
router.use('/api/prescriptions', prescriptionRoutes);
router.get('/api/stats', asyncHandler(stats));
router.get('/api/activity', asyncHandler(activity));

// --- Route index -------------------------------------------------------------
router.get('/', (req, res) => {
  res.json({
    service: 'RxRoute',
    description: 'WhatsApp-native prescription routing and pharmacy locator',
    endpoints: {
      health: ['GET /health', 'GET /health/deep'],
      webhooks: ['POST /webhook/whatsapp', 'POST /webhook/whatsapp/status'],
      pharmacies: [
        'GET /api/pharmacies',
        'GET /api/pharmacies/nearby?lat=&lng=&radius=&limit=',
        'GET /api/pharmacies/:id',
        'POST /api/pharmacies',
        'POST /api/pharmacies/bulk',
        'PATCH /api/pharmacies/:id',
        'DELETE /api/pharmacies/:id?hard=true',
      ],
      prescriptions: [
        'GET /api/prescriptions?status=&patient_phone=&limit=&offset=',
        'GET /api/prescriptions/:idOrCode',
        'GET /api/prescriptions/:idOrCode/broadcasts',
        'POST /api/prescriptions',
        'POST /api/prescriptions/:idOrCode/claim',
        'POST /api/prescriptions/:idOrCode/rebroadcast',
        'POST /api/prescriptions/expire-stale',
      ],
      dashboard: ['GET /api/stats', 'GET /api/activity'],
      public: ['POST /api/public/prescriptions (multipart)', 'GET /api/public/prescriptions/:id'],
    },
  });
});

export default router;

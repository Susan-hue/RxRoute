import { Router } from 'express';
import { handleIncomingWhatsapp, handleStatusCallback } from '../controllers/whatsappController.js';
import { validateTwilioSignature } from '../middleware/twilioSignature.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

/**
 * Twilio posts application/x-www-form-urlencoded. The urlencoded body parser is
 * mounted globally in app.js, before these routes, because signature validation
 * needs the parsed body.
 */
router.post('/whatsapp', validateTwilioSignature, asyncHandler(handleIncomingWhatsapp));

/** Optional delivery receipts — point Twilio's statusCallback here. */
router.post('/whatsapp/status', validateTwilioSignature, asyncHandler(handleStatusCallback));

/**
 * Twilio validates the webhook URL with a GET when you save it in the console.
 */
router.get('/whatsapp', (req, res) => {
  res.type('text/plain').send('RxRoute WhatsApp webhook is live. Twilio should POST here.');
});

export default router;

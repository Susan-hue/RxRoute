import { Router } from 'express';
import * as pharmacies from '../controllers/pharmacyController.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// `/nearby` is declared before `/:id` so it is not captured as an id.
router.get('/nearby', asyncHandler(pharmacies.nearby));

router.get('/', asyncHandler(pharmacies.index));
router.post('/', asyncHandler(pharmacies.create));
router.post('/bulk', asyncHandler(pharmacies.bulkCreate));

router.get('/:id', asyncHandler(pharmacies.show));
router.patch('/:id', asyncHandler(pharmacies.update));
router.delete('/:id', asyncHandler(pharmacies.destroy));

export default router;

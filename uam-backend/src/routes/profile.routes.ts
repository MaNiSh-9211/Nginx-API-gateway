import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth.middleware';
import { updateBio } from '../controllers/profile.controller';

const router = Router();

// All profile routes require authentication
router.put('/bio', authenticate, requireVerifiedEmail, updateBio);

export default router;


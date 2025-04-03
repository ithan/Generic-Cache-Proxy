import express from 'express';
import { adminController } from '../controllers/admin.controller';

const router = express.Router();

// Admin routes
router.get('/metrics', adminController.getMetrics.bind(adminController));
// Ensure express.json() middleware is applied to this route specifically
router.post('/invalidate', express.json(), adminController.invalidateCache.bind(adminController));
router.get('/keys', adminController.listCacheKeys.bind(adminController));
router.post('/key', express.json(), adminController.getByKey.bind(adminController));
router.get('/health', adminController.healthCheck.bind(adminController));

export const adminRoutes = router;
